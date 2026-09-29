CREATE TABLE agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  scope text NOT NULL CHECK (scope IN ('personal','team')),
  creator_id uuid NOT NULL REFERENCES users(id),
  version integer NOT NULL DEFAULT 1 CHECK (version>0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agents_name ON agents(lower(name),name,id);
CREATE TABLE agent_members (
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY(agent_id,user_id)
);
CREATE INDEX agent_members_user ON agent_members(user_id,agent_id);
ALTER TABLE tasks ADD COLUMN agent_id uuid REFERENCES agents(id) ON DELETE SET NULL,
  ADD CONSTRAINT tasks_agent_assignee CHECK (agent_id IS NULL OR assignee_id IS NOT NULL);
CREATE INDEX tasks_agent ON tasks(agent_id) WHERE agent_id IS NOT NULL;
ALTER TABLE credentials ADD COLUMN agent_id uuid REFERENCES agents(id) ON DELETE SET NULL;
-- Legacy credentials remain revoked records; no Agent is invented for them.
UPDATE credentials SET revoked_at=COALESCE(revoked_at,now()) WHERE agent_id IS NULL;
ALTER TABLE credentials ADD CONSTRAINT credentials_agent_required CHECK (revoked_at IS NOT NULL OR agent_id IS NOT NULL);
ALTER TABLE oauth_requests ADD COLUMN agent_id uuid REFERENCES agents(id) ON DELETE SET NULL;
UPDATE oauth_requests SET consumed_at=COALESCE(consumed_at,now()),expires_at=LEAST(expires_at,now());
ALTER TABLE oauth_requests ADD CONSTRAINT oauth_agent_required CHECK (code_hash IS NULL OR consumed_at IS NOT NULL OR agent_id IS NOT NULL);
ALTER TABLE api_idempotency ADD COLUMN agent_ids uuid[] NOT NULL DEFAULT '{}';
CREATE INDEX api_idempotency_agents ON api_idempotency USING gin(agent_ids);
UPDATE api_idempotency SET response=NULL,status=410,invalidation_reason='upgrade',board_ids='{}',task_ids='{}',agent_ids='{}'
  WHERE status IS NOT NULL AND invalidation_reason IS NULL;

CREATE FUNCTION lock_agent_authority() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM id FROM workspace FOR UPDATE;
  RETURN NULL;
END;
$$;
CREATE TRIGGER agents_authority BEFORE INSERT OR UPDATE OR DELETE ON agents
  FOR EACH STATEMENT EXECUTE FUNCTION lock_agent_authority();
CREATE TRIGGER agent_members_authority BEFORE INSERT OR UPDATE OR DELETE ON agent_members
  FOR EACH STATEMENT EXECUTE FUNCTION lock_agent_authority();
CREATE TRIGGER tasks_agent_authority BEFORE INSERT OR UPDATE OR DELETE ON tasks
  FOR EACH STATEMENT EXECUTE FUNCTION lock_agent_authority();
CREATE TRIGGER credentials_agent_authority BEFORE INSERT OR UPDATE OR DELETE ON credentials
  FOR EACH STATEMENT EXECUTE FUNCTION lock_agent_authority();
CREATE TRIGGER oauth_agent_authority BEFORE INSERT OR UPDATE OR DELETE ON oauth_requests
  FOR EACH STATEMENT EXECUTE FUNCTION lock_agent_authority();
CREATE TRIGGER users_agent_authority BEFORE UPDATE OF role,disabled_at OR DELETE ON users
  FOR EACH STATEMENT EXECUTE FUNCTION lock_agent_authority();

CREATE FUNCTION check_agent_access(selected_agent uuid,selected_user uuid) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE agent_scope text; creator uuid;
BEGIN
  PERFORM id FROM users WHERE id=selected_user AND disabled_at IS NULL FOR SHARE;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT scope,creator_id INTO agent_scope,creator FROM agents WHERE id=selected_agent FOR SHARE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF agent_scope='personal' THEN RETURN creator=selected_user; END IF;
  PERFORM user_id FROM agent_members WHERE agent_id=selected_agent AND user_id=selected_user FOR SHARE;
  RETURN FOUND;
END;
$$;
CREATE FUNCTION enforce_task_agent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.agent_id IS NOT NULL AND (NEW.assignee_id IS NULL OR NOT check_agent_access(NEW.agent_id,NEW.assignee_id)) THEN
    RAISE EXCEPTION 'Task agents require an active eligible human assignee' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER tasks_agent_access BEFORE INSERT OR UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION enforce_task_agent();
CREATE FUNCTION enforce_agent_member() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND (NEW.agent_id<>OLD.agent_id OR NEW.user_id<>OLD.user_id) THEN
    RAISE EXCEPTION 'Agent grants are immutable; remove and create a grant' USING ERRCODE='23514';
  END IF;
  PERFORM id FROM agents WHERE id=NEW.agent_id AND scope='team' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Only team agents accept member grants' USING ERRCODE='23514'; END IF;
  PERFORM id FROM users WHERE id=NEW.user_id AND disabled_at IS NULL FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Agent grants require active members' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER agent_member_access BEFORE INSERT OR UPDATE ON agent_members
  FOR EACH ROW EXECUTE FUNCTION enforce_agent_member();
CREATE FUNCTION enforce_credential_agent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.revoked_at IS NULL AND (NEW.agent_id IS NULL OR NOT check_agent_access(NEW.agent_id,NEW.user_id)) THEN
    RAISE EXCEPTION 'Credentials require an accessible Agent' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER credential_agent_access BEFORE INSERT OR UPDATE ON credentials
  FOR EACH ROW EXECUTE FUNCTION enforce_credential_agent();
CREATE FUNCTION enforce_oauth_agent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.consumed_at IS NULL AND NEW.agent_id IS NOT NULL AND (NEW.user_id IS NULL OR NOT check_agent_access(NEW.agent_id,NEW.user_id)) THEN
    RAISE EXCEPTION 'OAuth grants require an accessible Agent' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER oauth_agent_access BEFORE INSERT OR UPDATE ON oauth_requests
  FOR EACH ROW EXECUTE FUNCTION enforce_oauth_agent();

CREATE FUNCTION clean_removed_agent_member() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE tasks SET agent_id=NULL,version=version+1,updated_at=now() WHERE agent_id=OLD.agent_id AND assignee_id=OLD.user_id;
  UPDATE credentials SET revoked_at=COALESCE(revoked_at,now()) WHERE agent_id=OLD.agent_id AND user_id=OLD.user_id;
  UPDATE oauth_requests SET consumed_at=COALESCE(consumed_at,now()),expires_at=LEAST(expires_at,now()) WHERE agent_id=OLD.agent_id AND user_id=OLD.user_id;
  RETURN OLD;
END;
$$;
CREATE TRIGGER removed_agent_member AFTER DELETE ON agent_members
  FOR EACH ROW EXECUTE FUNCTION clean_removed_agent_member();
CREATE FUNCTION clean_deleted_agent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE tasks SET agent_id=NULL,version=version+1,updated_at=now() WHERE agent_id=OLD.id;
  UPDATE credentials SET revoked_at=COALESCE(revoked_at,now()) WHERE agent_id=OLD.id;
  UPDATE oauth_requests SET consumed_at=COALESCE(consumed_at,now()),expires_at=LEAST(expires_at,now()) WHERE agent_id=OLD.id;
  UPDATE api_idempotency SET response=NULL,status=410,invalidation_reason='deleted',board_ids='{}',task_ids='{}',agent_ids='{}'
    WHERE status IS NOT NULL AND agent_ids @> ARRAY[OLD.id];
  RETURN OLD;
END;
$$;
CREATE TRIGGER deleted_agent BEFORE DELETE ON agents
  FOR EACH ROW EXECUTE FUNCTION clean_deleted_agent();
CREATE FUNCTION clean_disabled_agent_user() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.disabled_at IS NULL AND NEW.disabled_at IS NOT NULL THEN
    DELETE FROM agent_members WHERE user_id=NEW.id;
    UPDATE tasks SET agent_id=NULL,version=version+1,updated_at=now() WHERE assignee_id=NEW.id AND agent_id IS NOT NULL;
    UPDATE credentials SET revoked_at=COALESCE(revoked_at,now()) WHERE user_id=NEW.id;
    UPDATE oauth_requests SET consumed_at=COALESCE(consumed_at,now()),expires_at=LEAST(expires_at,now()) WHERE user_id=NEW.id;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER disabled_agent_user AFTER UPDATE OF disabled_at ON users
  FOR EACH ROW EXECUTE FUNCTION clean_disabled_agent_user();

DO $$
DECLARE installation_schema text := current_schema(); function_name text;
BEGIN
  FOREACH function_name IN ARRAY ARRAY['lock_agent_authority','enforce_task_agent','enforce_agent_member','enforce_credential_agent','enforce_oauth_agent','clean_removed_agent_member','clean_deleted_agent','clean_disabled_agent_user'] LOOP
    EXECUTE format('ALTER FUNCTION %I.%I() SET search_path TO pg_catalog, %I, pg_temp',installation_schema,function_name,installation_schema);
  END LOOP;
  EXECUTE format('ALTER FUNCTION %I.check_agent_access(uuid,uuid) SET search_path TO pg_catalog, %I, pg_temp',installation_schema,installation_schema);
END;
$$;
