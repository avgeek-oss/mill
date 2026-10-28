DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM credentials c, unnest(c.scopes) AS entry(value)
    WHERE c.token_type='oauth' AND entry.value NOT IN ('read','write','admin')
  ) OR EXISTS (
    SELECT 1 FROM oauth_requests r WHERE r.scope=''
  ) OR EXISTS (
    SELECT 1 FROM oauth_requests r, unnest(string_to_array(r.scope,' ')) AS entry(value)
    WHERE entry.value NOT IN ('read','write','admin')
  ) THEN
    RAISE EXCEPTION 'Unknown OAuth scope; migration stopped without changing grants';
  END IF;
END;
$$;

ALTER TABLE credentials DROP CONSTRAINT credentials_access_shape;

UPDATE credentials c SET scopes=ARRAY(
  SELECT CASE entry.value WHEN 'read' THEN 'viewer' WHEN 'write' THEN 'member' ELSE 'admin' END
  FROM unnest(c.scopes) WITH ORDINALITY AS entry(value,position)
  ORDER BY entry.position
) WHERE c.token_type='oauth';

UPDATE oauth_requests r SET scope=(
  SELECT string_agg(
    CASE entry.value WHEN 'read' THEN 'viewer' WHEN 'write' THEN 'member' ELSE 'admin' END,
    ' ' ORDER BY entry.position
  )
  FROM unnest(string_to_array(r.scope,' ')) WITH ORDINALITY AS entry(value,position)
);

ALTER TABLE credentials ADD CONSTRAINT credentials_access_shape CHECK (
  (token_type='api-key' AND board_ids IS NULL AND scopes='{}' AND oauth_client_id IS NULL AND resource IS NULL
    AND (user_id IS NOT NULL OR created_by IS NOT NULL)
    AND (include_admin=false OR access_level='edit'))
  OR (token_type='oauth' AND user_id IS NOT NULL AND expires_at IS NOT NULL
    AND scopes <@ ARRAY['viewer','member','admin']::text[] AND 'viewer'=ANY(scopes)
    AND (include_admin = ('admin'=ANY(scopes)))
    AND (include_admin=false OR (access_level='edit' AND 'member'=ANY(scopes))))
);

ALTER TABLE oauth_requests ADD CONSTRAINT oauth_requests_scope_shape CHECK (
  scope IN ('viewer','viewer member','viewer member admin')
);
