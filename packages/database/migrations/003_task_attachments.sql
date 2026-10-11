CREATE TABLE task_attachments (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  file_name text NOT NULL CHECK(length(file_name) BETWEEN 1 AND 255),
  content_type text NOT NULL CHECK(content_type IN ('image/png','image/jpeg','image/webp','image/gif','application/pdf')),
  size_bytes integer NOT NULL CHECK(size_bytes BETWEEN 1 AND 20971520),
  sha256 text CHECK(sha256 ~ '^[a-f0-9]{64}$'),
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','ready')),
  storage_origin text NOT NULL,
  storage_bucket text NOT NULL,
  upload_key text NOT NULL UNIQUE,
  object_key text NOT NULL UNIQUE,
  upload_expires_at timestamptz NOT NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX task_attachments_page ON task_attachments(task_id, created_at DESC, id DESC) WHERE state='ready';
CREATE INDEX task_attachments_expiration ON task_attachments(upload_expires_at) WHERE state='pending';

CREATE TABLE attachment_cleanup (
  storage_origin text NOT NULL,
  storage_bucket text NOT NULL,
  object_key text NOT NULL,
  available_at timestamptz NOT NULL DEFAULT now(),
  recheck_at timestamptz,
  PRIMARY KEY(storage_origin,storage_bucket,object_key)
);
CREATE INDEX attachment_cleanup_available ON attachment_cleanup(available_at);
ALTER TABLE api_idempotency ADD COLUMN attachment_ids uuid[] NOT NULL DEFAULT '{}';

CREATE FUNCTION queue_attachment_cleanup() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO attachment_cleanup(storage_origin,storage_bucket,object_key)
    VALUES(OLD.storage_origin,OLD.storage_bucket,OLD.object_key) ON CONFLICT DO NOTHING;
  INSERT INTO attachment_cleanup(storage_origin,storage_bucket,object_key,available_at,recheck_at)
    VALUES(OLD.storage_origin,OLD.storage_bucket,OLD.upload_key,
      greatest(now(),OLD.upload_expires_at + interval '1 minute'),
      greatest(now(),OLD.upload_expires_at + interval '1 day')) ON CONFLICT DO NOTHING;
  RETURN OLD;
END;
$$;
CREATE TRIGGER task_attachment_deleted AFTER DELETE ON task_attachments
  FOR EACH ROW EXECUTE FUNCTION queue_attachment_cleanup();
