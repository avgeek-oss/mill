DROP TABLE auth_audit;
DELETE FROM activity WHERE task_id IS NULL;
UPDATE activity SET board_id=tasks.board_id FROM tasks
  WHERE activity.task_id=tasks.id AND activity.board_id IS DISTINCT FROM tasks.board_id;
ALTER TABLE activity ALTER COLUMN task_id SET NOT NULL,
  ALTER COLUMN board_id SET NOT NULL,
  DROP CONSTRAINT activity_task_id_fkey,
  ADD CONSTRAINT activity_task_board_fkey FOREIGN KEY (task_id,board_id)
    REFERENCES tasks(id,board_id) ON DELETE CASCADE;
