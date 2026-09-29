ALTER TABLE agents ADD COLUMN all_members boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT agents_team_all_members CHECK (scope='team' OR NOT all_members);

-- API keys become human credentials. Existing scoped keys are revoked before unbinding.
ALTER TABLE credentials DROP CONSTRAINT credentials_agent_required,
  DROP CONSTRAINT credentials_scopes_check;
UPDATE credentials SET revoked_at=COALESCE(revoked_at,now()),agent_id=NULL,board_ids=NULL,scopes='{}',oauth_client_id=NULL,resource=NULL
  WHERE token_type='api-key';
ALTER TABLE credentials ADD CONSTRAINT credentials_access_shape CHECK (
  (token_type='api-key' AND agent_id IS NULL AND board_ids IS NULL AND scopes='{}' AND oauth_client_id IS NULL AND resource IS NULL)
  OR (token_type='oauth' AND scopes <@ ARRAY['read','write']::text[] AND 'read'=ANY(scopes) AND (revoked_at IS NOT NULL OR agent_id IS NOT NULL))
);

UPDATE api_idempotency SET response=NULL,status=410,invalidation_reason='upgrade',board_ids='{}',task_ids='{}',agent_ids='{}'
  WHERE status IS NOT NULL AND invalidation_reason IS NULL;

CREATE OR REPLACE FUNCTION check_agent_access(selected_agent uuid,selected_user uuid) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE agent_scope text; creator uuid; everyone boolean;
BEGIN
  PERFORM id FROM users WHERE id=selected_user AND disabled_at IS NULL FOR SHARE;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT scope,creator_id,all_members INTO agent_scope,creator,everyone FROM agents WHERE id=selected_agent FOR SHARE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF agent_scope='personal' THEN RETURN creator=selected_user; END IF;
  IF everyone THEN RETURN true; END IF;
  PERFORM user_id FROM agent_members WHERE agent_id=selected_agent AND user_id=selected_user FOR SHARE;
  RETURN FOUND;
END;
$$;
CREATE OR REPLACE FUNCTION enforce_credential_agent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.revoked_at IS NULL THEN
    PERFORM id FROM users WHERE id=NEW.user_id AND disabled_at IS NULL FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Credentials require an active owner' USING ERRCODE='23514'; END IF;
    IF NEW.token_type='oauth' AND (NEW.agent_id IS NULL OR NOT check_agent_access(NEW.agent_id,NEW.user_id)) THEN
      RAISE EXCEPTION 'OAuth credentials require an accessible Agent' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

ALTER TABLE api_idempotency DROP CONSTRAINT api_idempotency_invalidation_reason_check,
  ADD CONSTRAINT api_idempotency_invalidation_reason_check CHECK (invalidation_reason IN ('deleted','upgrade','access'));

CREATE FUNCTION invalidate_agent_retries(selected_agent uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE api_idempotency SET response=NULL,status=410,invalidation_reason='access',board_ids='{}',task_ids='{}',agent_ids='{}'
    WHERE status IS NOT NULL AND invalidation_reason IS NULL AND agent_ids @> ARRAY[selected_agent];
END;
$$;
CREATE FUNCTION clean_agent_access(selected_agent uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE tasks SET agent_id=NULL,version=version+1,updated_at=now()
    WHERE agent_id=selected_agent AND NOT check_agent_access(selected_agent,assignee_id);
  UPDATE credentials SET revoked_at=COALESCE(revoked_at,now())
    WHERE token_type='oauth' AND agent_id=selected_agent AND revoked_at IS NULL AND NOT check_agent_access(selected_agent,user_id);
  UPDATE oauth_requests SET consumed_at=COALESCE(consumed_at,now()),expires_at=LEAST(expires_at,now())
    WHERE agent_id=selected_agent AND NOT check_agent_access(selected_agent,user_id);
END;
$$;
CREATE OR REPLACE FUNCTION clean_removed_agent_member() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM clean_agent_access(OLD.agent_id);
  PERFORM invalidate_agent_retries(OLD.agent_id);
  RETURN OLD;
END;
$$;
CREATE FUNCTION pin_agent_creator() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.scope='team' THEN
    INSERT INTO agent_members(agent_id,user_id) SELECT NEW.id,NEW.creator_id
      WHERE EXISTS(SELECT 1 FROM users WHERE id=NEW.creator_id AND disabled_at IS NULL)
      ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER agent_creator_grant AFTER INSERT ON agents FOR EACH ROW EXECUTE FUNCTION pin_agent_creator();
CREATE FUNCTION repin_reactivated_agent_creator() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.disabled_at IS NOT NULL AND NEW.disabled_at IS NULL THEN
    INSERT INTO agent_members(agent_id,user_id)
      SELECT id,NEW.id FROM agents WHERE scope='team' AND creator_id=NEW.id
      ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER reactivated_agent_creator AFTER UPDATE OF disabled_at ON users
  FOR EACH ROW EXECUTE FUNCTION repin_reactivated_agent_creator();
CREATE FUNCTION protect_agent_creator_grant() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM agents a JOIN users u ON u.id=a.creator_id
      WHERE a.id=OLD.agent_id AND a.creator_id=OLD.user_id AND u.disabled_at IS NULL) THEN
    RAISE EXCEPTION 'The team Agent creator retains individual access' USING ERRCODE='23514';
  END IF;
  RETURN OLD;
END;
$$;
CREATE TRIGGER agent_creator_grant_pinned BEFORE DELETE ON agent_members FOR EACH ROW EXECUTE FUNCTION protect_agent_creator_grant();
CREATE FUNCTION changed_agent_access() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
    IF NEW.scope<>OLD.scope OR NEW.creator_id<>OLD.creator_id THEN
      RAISE EXCEPTION 'Agent ownership and scope are immutable' USING ERRCODE='23514';
    END IF;
    IF NEW.all_members<>OLD.all_members THEN
      PERFORM clean_agent_access(NEW.id);
      PERFORM invalidate_agent_retries(NEW.id);
    END IF;
  ELSE
    PERFORM invalidate_agent_retries(NEW.agent_id);
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER agent_access_policy AFTER UPDATE OF all_members,scope,creator_id ON agents FOR EACH ROW EXECUTE FUNCTION changed_agent_access();
CREATE TRIGGER agent_grant_added AFTER INSERT ON agent_members FOR EACH ROW EXECUTE FUNCTION changed_agent_access();

INSERT INTO agent_members(agent_id,user_id)
  SELECT a.id,a.creator_id FROM agents a JOIN users u ON u.id=a.creator_id
  WHERE a.scope='team' AND u.disabled_at IS NULL ON CONFLICT DO NOTHING;

DO $$
DECLARE installation_schema text := current_schema(); function_name text;
BEGIN
  FOREACH function_name IN ARRAY ARRAY['enforce_credential_agent','clean_removed_agent_member','pin_agent_creator','repin_reactivated_agent_creator','protect_agent_creator_grant','changed_agent_access'] LOOP
    EXECUTE format('ALTER FUNCTION %I.%I() SET search_path TO pg_catalog, %I, pg_temp',installation_schema,function_name,installation_schema);
  END LOOP;
  EXECUTE format('ALTER FUNCTION %I.check_agent_access(uuid,uuid) SET search_path TO pg_catalog, %I, pg_temp',installation_schema,installation_schema);
  EXECUTE format('ALTER FUNCTION %I.clean_agent_access(uuid) SET search_path TO pg_catalog, %I, pg_temp',installation_schema,installation_schema);
  EXECUTE format('ALTER FUNCTION %I.invalidate_agent_retries(uuid) SET search_path TO pg_catalog, %I, pg_temp',installation_schema,installation_schema);
END;
$$;
