ALTER TABLE columns DROP CONSTRAINT columns_board_id_fkey,
  ADD FOREIGN KEY (board_id) REFERENCES boards(id) ON DELETE CASCADE;
ALTER TABLE tasks DROP CONSTRAINT tasks_board_id_fkey,
  DROP CONSTRAINT tasks_column_id_board_id_fkey,
  DROP CONSTRAINT tasks_parent_id_board_id_fkey,
  ADD FOREIGN KEY (board_id) REFERENCES boards(id) ON DELETE CASCADE,
  ADD FOREIGN KEY (column_id,board_id) REFERENCES columns(id,board_id),
  ADD FOREIGN KEY (parent_id,board_id) REFERENCES tasks(id,board_id) ON DELETE CASCADE;
ALTER TABLE comments DROP CONSTRAINT comments_task_id_fkey,
  ADD FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE;
ALTER TABLE activity DROP CONSTRAINT activity_task_id_fkey,
  DROP CONSTRAINT activity_board_id_fkey,
  ADD FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  ADD FOREIGN KEY (board_id) REFERENCES boards(id) ON DELETE CASCADE;
ALTER TABLE notifications DROP CONSTRAINT notifications_task_id_fkey,
  ADD FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE;

ALTER TABLE api_idempotency ADD COLUMN board_ids uuid[] NOT NULL DEFAULT '{}',
  ADD COLUMN task_ids uuid[] NOT NULL DEFAULT '{}',
  ADD COLUMN invalidation_reason text CHECK (invalidation_reason IN ('deleted','upgrade'));
-- Keep legacy retry keys without retaining encrypted work content.
UPDATE api_idempotency SET response=NULL,status=410,invalidation_reason='upgrade'
  WHERE status IS NOT NULL;
CREATE INDEX api_idempotency_boards ON api_idempotency USING gin(board_ids);
CREATE INDEX api_idempotency_tasks ON api_idempotency USING gin(task_ids);

CREATE FUNCTION clean_deleted_board() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE oauth_requests SET board_ids=array_remove(board_ids,OLD.id)
    WHERE OLD.id=ANY(board_ids);
  DELETE FROM oauth_requests WHERE board_ids='{}'::uuid[];
  UPDATE credentials SET board_ids=array_remove(board_ids,OLD.id),
    revoked_at=CASE WHEN cardinality(array_remove(board_ids,OLD.id))=0
      THEN COALESCE(revoked_at,now()) ELSE revoked_at END
    WHERE OLD.id=ANY(board_ids);
  UPDATE api_idempotency SET response=NULL,status=410,invalidation_reason='deleted',
    board_ids='{}',task_ids='{}'
    WHERE status IS NOT NULL AND board_ids @> ARRAY[OLD.id];
  RETURN OLD;
END;
$$;
CREATE TRIGGER clean_deleted_board AFTER DELETE ON boards
  FOR EACH ROW EXECUTE FUNCTION clean_deleted_board();
CREATE FUNCTION clean_deleted_task() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE api_idempotency SET response=NULL,status=410,invalidation_reason='deleted',
    board_ids='{}',task_ids='{}'
    WHERE status IS NOT NULL AND task_ids @> ARRAY[OLD.id];
  RETURN OLD;
END;
$$;
CREATE TRIGGER clean_deleted_task AFTER DELETE ON tasks
  FOR EACH ROW EXECUTE FUNCTION clean_deleted_task();

-- Archived records become ordinary records. Previously deleted work is purged,
-- including descendants of a deleted parent and content owned by deleted boards.
DELETE FROM boards WHERE deleted_at IS NOT NULL;
DELETE FROM tasks WHERE deleted_at IS NOT NULL;
WITH ordered AS (SELECT id,row_number() OVER (ORDER BY position,id)-1 AS position FROM boards)
UPDATE boards SET position=ordered.position,version=version+1,updated_at=now()
FROM ordered WHERE boards.id=ordered.id AND boards.position<>ordered.position;
WITH ordered AS (SELECT id,row_number() OVER (PARTITION BY column_id ORDER BY position,id)-1 AS position FROM tasks)
UPDATE tasks SET position=ordered.position,version=version+1,updated_at=now()
FROM ordered WHERE tasks.id=ordered.id AND tasks.position<>ordered.position;
ALTER TABLE boards DROP COLUMN archived, DROP COLUMN deleted_at;
ALTER TABLE tasks DROP COLUMN archived, DROP COLUMN deleted_at;
