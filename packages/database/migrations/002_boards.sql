CREATE TABLE boards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspace(id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  prefix text NOT NULL UNIQUE CHECK (prefix ~ '^[A-Z][A-Z0-9]{1,9}$'),
  description text NOT NULL DEFAULT '',
  position integer NOT NULL CHECK (position >= 0),
  version integer NOT NULL DEFAULT 1,
  next_number integer NOT NULL DEFAULT 1,
  archived boolean NOT NULL DEFAULT false,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE columns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  board_id uuid NOT NULL REFERENCES boards(id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  color text NOT NULL DEFAULT 'gray',
  position integer NOT NULL CHECK (position >= 0),
  version integer NOT NULL DEFAULT 1,
  UNIQUE(id, board_id)
);
CREATE TABLE tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  board_id uuid NOT NULL REFERENCES boards(id),
  column_id uuid NOT NULL,
  identifier text NOT NULL UNIQUE,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 300),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 100000),
  assignee_id uuid REFERENCES users(id),
  priority text NOT NULL DEFAULT 'none' CHECK (priority IN ('none','low','medium','high','urgent')),
  labels text[] NOT NULL DEFAULT '{}',
  due_date date,
  checklist jsonb NOT NULL DEFAULT '[]',
  parent_id uuid,
  position integer NOT NULL CHECK (position >= 0),
  version integer NOT NULL DEFAULT 1,
  archived boolean NOT NULL DEFAULT false,
  deleted_at timestamptz,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(id, board_id),
  FOREIGN KEY(column_id, board_id) REFERENCES columns(id, board_id),
  FOREIGN KEY(parent_id, board_id) REFERENCES tasks(id, board_id),
  CHECK(parent_id IS NULL OR parent_id <> id)
);
CREATE INDEX tasks_board_order ON tasks(board_id, column_id, position, id);
CREATE INDEX tasks_board_updated ON tasks(board_id, updated_at, id);
CREATE INDEX tasks_search ON tasks USING gin(to_tsvector('simple', title || ' ' || description));
CREATE TABLE comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES tasks(id),
  author_id uuid NOT NULL REFERENCES users(id),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 10000),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX comments_task ON comments(task_id, created_at, id);
CREATE TABLE activity (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid REFERENCES tasks(id),
  board_id uuid REFERENCES boards(id),
  actor_id uuid NOT NULL REFERENCES users(id),
  actor_name text NOT NULL,
  actor_kind text NOT NULL CHECK(actor_kind IN ('human','agent')),
  action text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX activity_task ON activity(task_id, created_at, id);
CREATE INDEX activity_board ON activity(board_id, created_at, id);
CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  task_id uuid NOT NULL REFERENCES tasks(id),
  kind text NOT NULL CHECK(kind IN ('assignment','mention')),
  actor_name text NOT NULL,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user ON notifications(user_id, created_at DESC);
