CREATE TABLE api_idempotency (
 actor_key text NOT NULL,
 key text NOT NULL,
 request_hash text NOT NULL,
 response jsonb,
 status integer,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(actor_key,key)
);
CREATE TABLE request_limits (
 key text PRIMARY KEY,
 count integer NOT NULL,
 reset_at timestamptz NOT NULL
);
