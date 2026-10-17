ALTER TABLE comments ADD COLUMN parent_id uuid;
ALTER TABLE comments ADD CONSTRAINT comments_id_task UNIQUE(id,task_id);
ALTER TABLE comments ADD CONSTRAINT comments_parent_same_task
  FOREIGN KEY(parent_id,task_id) REFERENCES comments(id,task_id) ON DELETE SET NULL(parent_id);
ALTER TABLE comments ADD CONSTRAINT comments_not_own_parent CHECK(parent_id IS DISTINCT FROM id);
CREATE INDEX comments_parent_created ON comments(task_id,parent_id,created_at DESC,id DESC);
