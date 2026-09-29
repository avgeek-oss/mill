CREATE FUNCTION legacy_task_status(name text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE lower(regexp_replace(btrim(name),'\s+',' ','g'))
    WHEN 'backlog' THEN 'backlog'
    WHEN 'todo' THEN 'todo'
    WHEN 'to do' THEN 'todo'
    WHEN 'in progress' THEN 'in_progress'
    WHEN 'in_progress' THEN 'in_progress'
    WHEN 'in review' THEN 'in_review'
    WHEN 'in_review' THEN 'in_review'
    WHEN 'done' THEN 'done'
    WHEN 'won''t do' THEN 'wont_do'
    WHEN 'won’t do' THEN 'wont_do'
    WHEN 'wont do' THEN 'wont_do'
    WHEN 'wont_do' THEN 'wont_do'
    WHEN 'cancelled' THEN 'wont_do'
    WHEN 'canceled' THEN 'wont_do'
    ELSE 'todo'
  END;
$$;

ALTER TABLE tasks ADD COLUMN status text;
UPDATE tasks SET status=legacy_task_status(columns.name) FROM columns
  WHERE columns.id=tasks.column_id;
ALTER TABLE tasks ALTER COLUMN status SET NOT NULL,
  ALTER COLUMN status SET DEFAULT 'todo',
  ADD CONSTRAINT tasks_status_check CHECK (status IN ('backlog','todo','in_progress','in_review','done','wont_do'));

-- Existing task activity stays intact. Former subtasks become independent tasks.
ALTER TABLE tasks DROP COLUMN column_id, DROP COLUMN labels,
  DROP COLUMN parent_id, DROP COLUMN position;
ALTER TABLE boards DROP COLUMN position;
DROP TABLE columns;
DROP FUNCTION legacy_task_status(text);
CREATE INDEX tasks_board_created ON tasks(board_id,created_at DESC,id DESC);
CREATE INDEX tasks_board_status_created ON tasks(board_id,status,created_at DESC,id DESC);
CREATE INDEX boards_name ON boards(lower(name),name,id);

UPDATE users SET notification_preferences=notification_preferences-'email';
ALTER TABLE users ALTER COLUMN notification_preferences SET DEFAULT '{"assignments":true,"mentions":true}';

-- Old responses contain the removed task structure. Retain retry identities
-- without replaying obsolete responses or allowing a mutation to run again.
UPDATE api_idempotency SET response=NULL,status=410,invalidation_reason='upgrade',board_ids='{}',task_ids='{}'
  WHERE status IS NOT NULL AND invalidation_reason IS NULL;
