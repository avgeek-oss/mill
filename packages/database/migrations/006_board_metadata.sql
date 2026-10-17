ALTER TABLE boards ADD COLUMN created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE boards ADD COLUMN created_by_name text;
ALTER TABLE boards ADD COLUMN created_by_kind text CHECK (created_by_kind IN ('human','team'));
ALTER TABLE boards ADD COLUMN last_activity_at timestamptz;

UPDATE boards SET last_activity_at=greatest(
  boards.updated_at,
  (SELECT max(tasks.updated_at) FROM tasks WHERE tasks.board_id=boards.id),
  (SELECT max(comments.updated_at) FROM comments JOIN tasks ON tasks.id=comments.task_id WHERE tasks.board_id=boards.id),
  (SELECT max(activity.created_at) FROM activity WHERE activity.board_id=boards.id),
  (SELECT max(task_attachments.created_at) FROM task_attachments JOIN tasks ON tasks.id=task_attachments.task_id WHERE tasks.board_id=boards.id AND task_attachments.state='ready')
);
ALTER TABLE boards ALTER COLUMN last_activity_at SET DEFAULT now();
ALTER TABLE boards ALTER COLUMN last_activity_at SET NOT NULL;

CREATE FUNCTION board_details_activity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.name,NEW.description) IS DISTINCT FROM ROW(OLD.name,OLD.description) THEN
    NEW.last_activity_at := greatest(NEW.last_activity_at,statement_timestamp());
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER board_details_activity BEFORE UPDATE ON boards
  FOR EACH ROW EXECUTE FUNCTION board_details_activity();

CREATE FUNCTION board_content_activity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_board_id uuid; target_task_id uuid;
BEGIN
  IF TG_TABLE_NAME='tasks' THEN
    IF TG_OP='UPDATE' AND
      ROW(NEW.board_id,NEW.type,NEW.status,NEW.title,NEW.description,NEW.assignee_id,NEW.priority,NEW.start_date,NEW.due_date)
      IS NOT DISTINCT FROM
      ROW(OLD.board_id,OLD.type,OLD.status,OLD.title,OLD.description,OLD.assignee_id,OLD.priority,OLD.start_date,OLD.due_date) THEN
      RETURN NULL;
    END IF;
    IF TG_OP='DELETE' THEN target_board_id := OLD.board_id;
    ELSE target_board_id := NEW.board_id;
    END IF;
    IF TG_OP='UPDATE' AND OLD.board_id IS DISTINCT FROM NEW.board_id THEN
      UPDATE boards SET last_activity_at=greatest(last_activity_at,statement_timestamp()) WHERE id=OLD.board_id;
    END IF;
  ELSE
    IF TG_TABLE_NAME='comments' AND TG_OP='UPDATE' THEN
      IF ROW(NEW.task_id,NEW.body) IS NOT DISTINCT FROM ROW(OLD.task_id,OLD.body) THEN RETURN NULL; END IF;
    END IF;
    IF TG_TABLE_NAME='task_attachments' THEN
      IF TG_OP='DELETE' THEN
        IF OLD.state<>'ready' THEN RETURN NULL; END IF;
      ELSE
        IF NEW.state<>'ready' THEN RETURN NULL; END IF;
        IF TG_OP='UPDATE' THEN
          IF ROW(NEW.state,NEW.file_name,NEW.content_type,NEW.size_bytes,NEW.sha256)
            IS NOT DISTINCT FROM ROW(OLD.state,OLD.file_name,OLD.content_type,OLD.size_bytes,OLD.sha256) THEN RETURN NULL; END IF;
        END IF;
      END IF;
    END IF;
    IF TG_OP='DELETE' THEN target_task_id := OLD.task_id;
    ELSE target_task_id := NEW.task_id;
    END IF;
    SELECT board_id INTO target_board_id FROM tasks WHERE id=target_task_id;
  END IF;
  UPDATE boards SET last_activity_at=greatest(last_activity_at,statement_timestamp()) WHERE id=target_board_id;
  RETURN NULL;
END;
$$;
CREATE TRIGGER tasks_board_activity AFTER INSERT OR UPDATE OR DELETE ON tasks
  FOR EACH ROW EXECUTE FUNCTION board_content_activity();
CREATE TRIGGER comments_board_activity AFTER INSERT OR UPDATE OR DELETE ON comments
  FOR EACH ROW EXECUTE FUNCTION board_content_activity();
CREATE TRIGGER attachments_board_activity AFTER INSERT OR UPDATE OR DELETE ON task_attachments
  FOR EACH ROW EXECUTE FUNCTION board_content_activity();

DO $$
BEGIN
  EXECUTE format('ALTER FUNCTION %I.board_details_activity() SET search_path TO pg_catalog, %I, pg_temp',current_schema(),current_schema());
  EXECUTE format('ALTER FUNCTION %I.board_content_activity() SET search_path TO pg_catalog, %I, pg_temp',current_schema(),current_schema());
END;
$$;
