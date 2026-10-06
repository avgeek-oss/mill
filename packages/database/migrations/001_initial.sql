CREATE TABLE workspace (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX workspace_singleton ON workspace ((true));

CREATE TABLE users (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspace(id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  email text NOT NULL UNIQUE CHECK (email = lower(email)),
  password_hash text NOT NULL,
  security_epoch integer NOT NULL DEFAULT 0,
  role text NOT NULL CHECK (role IN ('admin', 'member', 'viewer')),
  time_zone text NOT NULL DEFAULT 'UTC',
  date_format text NOT NULL DEFAULT 'day-short-month-year' CHECK (date_format IN ('day-short-month-year','day-month-year','month-day-year','year-month-day')),
  time_format text NOT NULL DEFAULT '24-hour' CHECK (time_format IN ('24-hour','12-hour')),
  notification_preferences jsonb NOT NULL DEFAULT '{"assignments":true,"mentions":true}',
  disabled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  token_hash text NOT NULL UNIQUE,
  security_epoch integer NOT NULL,
  user_agent text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  authenticated_at timestamptz NOT NULL DEFAULT now(),
  passkey_authenticated_at timestamptz,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE auth_challenges (
  token_hash text PRIMARY KEY,
  user_id uuid REFERENCES users(id),
  purpose text NOT NULL CHECK (purpose IN ('login', 'reauth', 'registration', 'passkey')),
  challenge text,
  security_epoch integer,
  session_id uuid REFERENCES sessions(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE passkeys (
  id text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  name text NOT NULL,
  public_key bytea NOT NULL,
  counter bigint NOT NULL,
  transports jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX passkeys_user ON passkeys(user_id);

CREATE TABLE recovery_codes (
  user_id uuid NOT NULL REFERENCES users(id),
  code_hash text NOT NULL,
  PRIMARY KEY (user_id, code_hash)
);
CREATE TABLE invitations (
  id uuid PRIMARY KEY,
  email text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin', 'member', 'viewer')),
  token_hash text NOT NULL UNIQUE,
  invited_by uuid NOT NULL REFERENCES users(id),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE account_recovery (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  reset_mfa boolean NOT NULL DEFAULT false,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE auth_rate_limits (
  key text PRIMARY KEY,
  attempts integer NOT NULL,
  window_start timestamptz NOT NULL
);

CREATE TABLE boards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspace(id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  prefix text NOT NULL UNIQUE CHECK (prefix ~ '^[A-Z][A-Z0-9]{1,9}$'),
  description text NOT NULL DEFAULT '',
  version integer NOT NULL DEFAULT 1,
  next_number integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX boards_name ON boards(lower(name),name,id);

CREATE TABLE tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  board_id uuid NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  type text NOT NULL DEFAULT 'task' CHECK (type IN ('task','bug')),
  status text NOT NULL DEFAULT 'todo' CHECK (status IN ('backlog','todo','in_progress','in_review','done','wont_do')),
  identifier text NOT NULL UNIQUE,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 300),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 100000),
  assignee_id uuid REFERENCES users(id),
  priority text NOT NULL DEFAULT 'none' CHECK (priority IN ('none','low','medium','high','urgent')),
  start_date date,
  due_date date,
  version integer NOT NULL DEFAULT 1,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  status_changed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(id,board_id)
);
CREATE INDEX tasks_board_updated ON tasks(board_id,updated_at,id);
CREATE INDEX tasks_search ON tasks USING gin(to_tsvector('simple',title || ' ' || description));
CREATE INDEX tasks_board_created ON tasks(board_id,created_at DESC,id DESC);
CREATE INDEX tasks_board_status_created ON tasks(board_id,status,created_at DESC,id DESC);
CREATE TABLE comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author_id uuid NOT NULL REFERENCES users(id),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 10000),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX comments_task ON comments(task_id,created_at,id);
CREATE TABLE activity (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL,
  board_id uuid NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  actor_id uuid NOT NULL REFERENCES users(id),
  actor_name text NOT NULL,
  actor_kind text NOT NULL CHECK(actor_kind IN ('human','oauth')),
  action text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT activity_task_board_fkey FOREIGN KEY(task_id,board_id) REFERENCES tasks(id,board_id) ON DELETE CASCADE
);
CREATE INDEX activity_task ON activity(task_id,created_at,id);
CREATE INDEX activity_board ON activity(board_id,created_at,id);
CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK(kind IN ('assignment','mention')),
  actor_name text NOT NULL,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user ON notifications(user_id,created_at DESC);
-- Mill external access. Adapted from Towbar's Apache-2.0 OAuth security model.
CREATE TABLE credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  token_hash text NOT NULL UNIQUE,
  token_prefix text NOT NULL,
  scopes text[] NOT NULL,
  board_ids uuid[],
  token_type text NOT NULL DEFAULT 'api-key' CHECK (token_type IN ('api-key','oauth')),
  oauth_client_id text,
  resource text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  last_used_at timestamptz,
  revoked_at timestamptz,
  CONSTRAINT credentials_access_shape CHECK (
    (token_type='api-key' AND board_ids IS NULL AND scopes='{}' AND oauth_client_id IS NULL AND resource IS NULL)
    OR (token_type='oauth' AND scopes <@ ARRAY['read','write']::text[] AND 'read'=ANY(scopes))
  )
);
CREATE INDEX credentials_owner ON credentials(user_id, created_at DESC);

CREATE TABLE oauth_clients (
  id text PRIMARY KEY,
  name text NOT NULL,
  redirect_uris text[] NOT NULL,
  auth_method text NOT NULL CHECK (auth_method IN ('none','client_secret_basic','client_secret_post')),
  secret_hash text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE oauth_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id text NOT NULL,
  client_name text NOT NULL,
  client_trust text NOT NULL,
  redirect_uri text NOT NULL,
  resource text NOT NULL,
  scope text NOT NULL,
  state text,
  challenge text NOT NULL,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  board_ids uuid[],
  code_hash text UNIQUE,
  credential_id uuid REFERENCES credentials(id) ON DELETE SET NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT oauth_owner_required CHECK (code_hash IS NULL OR consumed_at IS NOT NULL OR user_id IS NOT NULL)
);
CREATE INDEX oauth_request_expiry ON oauth_requests(expires_at);

CREATE TABLE api_idempotency (
 actor_key text NOT NULL,
 key text NOT NULL,
 request_hash text NOT NULL,
 response jsonb,
 status integer,
 board_ids uuid[] NOT NULL DEFAULT '{}',
 task_ids uuid[] NOT NULL DEFAULT '{}',
 invalidation_reason text CHECK (invalidation_reason IN ('deleted','upgrade','access')),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(actor_key,key)
);
CREATE TABLE request_limits (
 key text PRIMARY KEY,
 count integer NOT NULL,
 reset_at timestamptz NOT NULL
);

CREATE INDEX api_idempotency_boards ON api_idempotency USING gin(board_ids);
CREATE INDEX api_idempotency_tasks ON api_idempotency USING gin(task_ids);

CREATE FUNCTION lock_workspace_authority() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM id FROM workspace FOR UPDATE;
  RETURN NULL;
END;
$$;
CREATE TRIGGER boards_authority BEFORE INSERT OR UPDATE OR DELETE ON boards FOR EACH STATEMENT EXECUTE FUNCTION lock_workspace_authority();
CREATE TRIGGER tasks_authority BEFORE INSERT OR UPDATE OR DELETE ON tasks FOR EACH STATEMENT EXECUTE FUNCTION lock_workspace_authority();
CREATE TRIGGER credentials_authority BEFORE INSERT OR UPDATE OR DELETE ON credentials FOR EACH STATEMENT EXECUTE FUNCTION lock_workspace_authority();
CREATE TRIGGER oauth_authority BEFORE INSERT OR UPDATE OR DELETE ON oauth_requests FOR EACH STATEMENT EXECUTE FUNCTION lock_workspace_authority();
CREATE TRIGGER users_authority BEFORE INSERT OR UPDATE OR DELETE ON users FOR EACH STATEMENT EXECUTE FUNCTION lock_workspace_authority();

CREATE FUNCTION enforce_task_assignee() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.assignee_id IS NOT NULL THEN
    PERFORM id FROM users WHERE id=NEW.assignee_id AND disabled_at IS NULL FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Task assignees must be active people' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER tasks_assignee_access BEFORE INSERT OR UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION enforce_task_assignee();
CREATE FUNCTION enforce_credential_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.revoked_at IS NULL THEN
    PERFORM id FROM users WHERE id=NEW.user_id AND disabled_at IS NULL FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Credentials require an active owner' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER credential_owner_access BEFORE INSERT OR UPDATE ON credentials FOR EACH ROW EXECUTE FUNCTION enforce_credential_owner();
CREATE FUNCTION enforce_oauth_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.consumed_at IS NULL AND NEW.code_hash IS NOT NULL THEN
    PERFORM id FROM users WHERE id=NEW.user_id AND disabled_at IS NULL FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Approved OAuth grants require an active owner' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER oauth_owner_access BEFORE INSERT OR UPDATE ON oauth_requests FOR EACH ROW EXECUTE FUNCTION enforce_oauth_owner();

CREATE FUNCTION clean_disabled_user() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.disabled_at IS NULL AND NEW.disabled_at IS NOT NULL THEN
    UPDATE api_idempotency SET response=NULL,status=410,invalidation_reason='access',board_ids='{}',task_ids='{}'
      WHERE status IS NOT NULL AND invalidation_reason IS NULL
        AND task_ids && ARRAY(SELECT id FROM tasks WHERE assignee_id=NEW.id);
    UPDATE tasks SET assignee_id=NULL,version=version+1,updated_at=now() WHERE assignee_id=NEW.id;
    UPDATE credentials SET revoked_at=COALESCE(revoked_at,now()) WHERE user_id=NEW.id;
    UPDATE oauth_requests SET consumed_at=COALESCE(consumed_at,now()),expires_at=LEAST(expires_at,now()) WHERE user_id=NEW.id;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER disabled_user AFTER UPDATE OF disabled_at ON users FOR EACH ROW EXECUTE FUNCTION clean_disabled_user();

CREATE FUNCTION clean_deleted_board() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE oauth_requests SET board_ids=array_remove(board_ids,OLD.id) WHERE OLD.id=ANY(board_ids);
  DELETE FROM oauth_requests WHERE board_ids='{}'::uuid[];
  UPDATE credentials SET board_ids=array_remove(board_ids,OLD.id),
    revoked_at=CASE WHEN cardinality(array_remove(board_ids,OLD.id))=0 THEN COALESCE(revoked_at,now()) ELSE revoked_at END
    WHERE OLD.id=ANY(board_ids);
  UPDATE api_idempotency SET response=NULL,status=410,invalidation_reason='deleted',board_ids='{}',task_ids='{}'
    WHERE status IS NOT NULL AND board_ids @> ARRAY[OLD.id];
  RETURN OLD;
END;
$$;
CREATE TRIGGER clean_deleted_board AFTER DELETE ON boards FOR EACH ROW EXECUTE FUNCTION clean_deleted_board();
CREATE FUNCTION clean_deleted_task() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE api_idempotency SET response=NULL,status=410,invalidation_reason='deleted',board_ids='{}',task_ids='{}'
    WHERE status IS NOT NULL AND task_ids @> ARRAY[OLD.id];
  RETURN OLD;
END;
$$;
CREATE TRIGGER clean_deleted_task AFTER DELETE ON tasks FOR EACH ROW EXECUTE FUNCTION clean_deleted_task();
CREATE FUNCTION track_task_status_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN NEW.status_changed_at := now(); END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER tasks_status_change BEFORE UPDATE OF status ON tasks FOR EACH ROW EXECUTE FUNCTION track_task_status_change();

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
