-- Mill external access. Adapted from Towbar's Apache-2.0 OAuth security model.
CREATE TABLE credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  token_hash text NOT NULL UNIQUE,
  token_prefix text NOT NULL,
  scopes text[] NOT NULL CHECK (scopes <@ ARRAY['read','write']::text[] AND 'read' = ANY(scopes)),
  board_ids uuid[],
  token_type text NOT NULL DEFAULT 'api-key' CHECK (token_type IN ('api-key','oauth')),
  oauth_client_id text,
  resource text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  last_used_at timestamptz,
  revoked_at timestamptz
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
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX oauth_request_expiry ON oauth_requests(expires_at);
