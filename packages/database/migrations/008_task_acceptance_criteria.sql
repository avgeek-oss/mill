ALTER TABLE tasks ADD COLUMN acceptance_criteria text NOT NULL DEFAULT '';

CREATE OR REPLACE FUNCTION board_content_activity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_board_id uuid; target_task_id uuid;
BEGIN
  IF TG_TABLE_NAME='tasks' THEN
    IF TG_OP='UPDATE' AND
      ROW(NEW.board_id,NEW.type,NEW.status,NEW.title,NEW.description,NEW.acceptance_criteria,NEW.assignee_id,NEW.priority,NEW.start_date,NEW.due_date)
      IS NOT DISTINCT FROM
      ROW(OLD.board_id,OLD.type,OLD.status,OLD.title,OLD.description,OLD.acceptance_criteria,OLD.assignee_id,OLD.priority,OLD.start_date,OLD.due_date) THEN
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
DO $$
BEGIN
  EXECUTE format('ALTER FUNCTION %I.board_content_activity() SET search_path TO pg_catalog, %I, pg_temp',current_schema(),current_schema());
END;
$$;
