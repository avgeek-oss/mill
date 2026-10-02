-- Retain previously entered checklist data for a possible future restoration,
-- while removing it from the active task schema and every public interface.
CREATE TABLE retired_task_checklists (
  task_id uuid PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  items jsonb NOT NULL
);
INSERT INTO retired_task_checklists(task_id,items)
  SELECT id,checklist FROM tasks WHERE checklist <> '[]'::jsonb;
ALTER TABLE tasks DROP COLUMN checklist,
  DROP CONSTRAINT tasks_agent_assignee;

CREATE OR REPLACE FUNCTION enforce_task_agent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.agent_id IS NOT NULL AND NEW.assignee_id IS NOT NULL
     AND NOT check_agent_access(NEW.agent_id,NEW.assignee_id) THEN
    RAISE EXCEPTION 'Task assignees must have access to their Agent' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION clean_agent_access(selected_agent uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE tasks SET agent_id=NULL,version=version+1,updated_at=now()
    WHERE agent_id=selected_agent AND assignee_id IS NOT NULL
      AND NOT check_agent_access(selected_agent,assignee_id);
  UPDATE credentials SET revoked_at=COALESCE(revoked_at,now())
    WHERE token_type='oauth' AND agent_id=selected_agent AND revoked_at IS NULL
      AND NOT check_agent_access(selected_agent,user_id);
  UPDATE oauth_requests SET consumed_at=COALESCE(consumed_at,now()),expires_at=LEAST(expires_at,now())
    WHERE agent_id=selected_agent AND NOT check_agent_access(selected_agent,user_id);
END;
$$;

DO $$
DECLARE installation_schema text := current_schema();
BEGIN
  EXECUTE format('ALTER FUNCTION %I.enforce_task_agent() SET search_path TO pg_catalog, %I, pg_temp',installation_schema,installation_schema);
  EXECUTE format('ALTER FUNCTION %I.clean_agent_access(uuid) SET search_path TO pg_catalog, %I, pg_temp',installation_schema,installation_schema);
END;
$$;
