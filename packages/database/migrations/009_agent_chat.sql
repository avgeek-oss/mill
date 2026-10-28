CREATE TABLE agent_conversations (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL,
  title text NOT NULL,
  version integer NOT NULL DEFAULT 0,
  pending jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_conversations_owner_updated_idx ON agent_conversations(owner_id, updated_at DESC);
CREATE TABLE agent_messages (
  conversation_id uuid NOT NULL REFERENCES agent_conversations(id) ON DELETE CASCADE,
  seq integer NOT NULL,
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  content jsonb NOT NULL,
  model text,
  usage jsonb,
  meta jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, seq)
);
