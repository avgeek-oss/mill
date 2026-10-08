-- Existing keys keep a ceiling no higher than their owner's role at conversion.
ALTER TABLE credentials ADD COLUMN created_by uuid REFERENCES users(id) ON DELETE RESTRICT;
ALTER TABLE credentials ADD COLUMN access_level text CHECK (access_level IN ('read','edit'));
ALTER TABLE credentials ADD COLUMN include_admin boolean;
UPDATE credentials SET created_by=user_id,
  access_level=CASE WHEN users.role='viewer' THEN 'read' ELSE 'edit' END,
  include_admin=(users.role='admin' AND credentials.token_type='api-key')
  FROM users WHERE credentials.user_id=users.id;
ALTER TABLE credentials ALTER COLUMN created_by SET NOT NULL;
ALTER TABLE credentials ALTER COLUMN access_level SET NOT NULL;
ALTER TABLE credentials ALTER COLUMN include_admin SET NOT NULL;
ALTER TABLE credentials ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE credentials ALTER COLUMN expires_at DROP NOT NULL;
ALTER TABLE credentials DROP CONSTRAINT credentials_access_shape;
ALTER TABLE credentials ADD CONSTRAINT credentials_access_shape CHECK (
  (token_type='api-key' AND board_ids IS NULL AND scopes='{}' AND oauth_client_id IS NULL AND resource IS NULL
    AND (user_id IS NOT NULL OR created_by IS NOT NULL)
    AND (include_admin=false OR access_level='edit'))
  OR (token_type='oauth' AND user_id IS NOT NULL AND expires_at IS NOT NULL
    AND include_admin=false AND scopes <@ ARRAY['read','write']::text[] AND 'read'=ANY(scopes))
);
CREATE INDEX credentials_team ON credentials(created_at DESC,id DESC) WHERE user_id IS NULL AND token_type='api-key';
CREATE FUNCTION narrow_personal_credentials() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.role='viewer' AND OLD.role<>'viewer' THEN
    UPDATE credentials SET access_level='read',include_admin=false WHERE user_id=NEW.id AND token_type='api-key' AND revoked_at IS NULL;
  ELSIF NEW.role='member' AND OLD.role='admin' THEN
    UPDATE credentials SET include_admin=false WHERE user_id=NEW.id AND token_type='api-key' AND revoked_at IS NULL;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER narrow_personal_credentials AFTER UPDATE OF role ON users FOR EACH ROW EXECUTE FUNCTION narrow_personal_credentials();
ALTER TABLE activity DROP CONSTRAINT activity_actor_kind_check;
ALTER TABLE activity ADD CONSTRAINT activity_actor_kind_check CHECK (actor_kind IN ('human','oauth','team'));
ALTER TABLE comments ADD COLUMN author_kind text NOT NULL DEFAULT 'human' CHECK (author_kind IN ('human','oauth','team'));
ALTER TABLE comments ADD COLUMN author_name text;
ALTER TABLE comments ADD CONSTRAINT comments_team_author_name CHECK (author_kind<>'team' OR author_name IS NOT NULL);
CREATE OR REPLACE FUNCTION enforce_credential_owner() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner_role text;
BEGIN
  IF NEW.created_by IS NULL THEN NEW.created_by := NEW.user_id; END IF;
  IF NEW.access_level IS NULL OR NEW.include_admin IS NULL THEN
    SELECT role INTO owner_role FROM users WHERE id=NEW.user_id;
    IF NEW.access_level IS NULL THEN
      NEW.access_level := CASE WHEN owner_role='viewer' THEN 'read' ELSE 'edit' END;
    END IF;
    IF NEW.include_admin IS NULL THEN
      NEW.include_admin := NEW.token_type='api-key' AND owner_role='admin';
    END IF;
  END IF;
  IF NEW.revoked_at IS NULL AND NEW.user_id IS NOT NULL THEN
    PERFORM id FROM users WHERE id=NEW.user_id AND disabled_at IS NULL FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Credentials require an active owner' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END;
$$;

DO $$
DECLARE installation_schema text := current_schema(); installed_function record;
BEGIN
  FOR installed_function IN
    SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname=installation_schema AND p.prokind='f'
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path TO pg_catalog, %I, pg_temp',installed_function.signature,installation_schema);
  END LOOP;
END;
$$;
