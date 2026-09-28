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

CREATE TABLE authenticators (
  user_id uuid PRIMARY KEY REFERENCES users(id),
  encrypted_secret text NOT NULL,
  verified boolean NOT NULL DEFAULT false,
  last_used_step bigint NOT NULL DEFAULT -1,
  created_at timestamptz NOT NULL DEFAULT now()
);
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
CREATE TABLE auth_audit (
  id uuid PRIMARY KEY,
  user_id uuid REFERENCES users(id),
  actor_name text NOT NULL,
  action text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
