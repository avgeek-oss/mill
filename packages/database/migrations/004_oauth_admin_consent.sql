ALTER TABLE credentials DROP CONSTRAINT credentials_access_shape;
ALTER TABLE credentials ADD CONSTRAINT credentials_access_shape CHECK (
  (token_type='api-key' AND board_ids IS NULL AND scopes='{}' AND oauth_client_id IS NULL AND resource IS NULL
    AND (user_id IS NOT NULL OR created_by IS NOT NULL)
    AND (include_admin=false OR access_level='edit'))
  OR (token_type='oauth' AND user_id IS NOT NULL AND expires_at IS NOT NULL
    AND scopes <@ ARRAY['read','write','admin']::text[] AND 'read'=ANY(scopes)
    AND (include_admin = ('admin'=ANY(scopes)))
    AND (include_admin=false OR (access_level='edit' AND 'write'=ANY(scopes))))
);

CREATE OR REPLACE FUNCTION narrow_personal_credentials() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.role='viewer' AND OLD.role<>'viewer' THEN
    UPDATE credentials SET access_level='read',include_admin=false WHERE user_id=NEW.id AND token_type='api-key' AND revoked_at IS NULL;
  ELSIF NEW.role='member' AND OLD.role='admin' THEN
    UPDATE credentials SET include_admin=false WHERE user_id=NEW.id AND token_type='api-key' AND revoked_at IS NULL;
  END IF;
  IF NEW.role<>'admin' AND OLD.role='admin' THEN
    UPDATE credentials SET include_admin=false,scopes=array_remove(scopes,'admin') WHERE user_id=NEW.id AND token_type='oauth' AND revoked_at IS NULL;
  END IF;
  RETURN NEW;
END;
$$;

DO $$
BEGIN
  EXECUTE format('ALTER FUNCTION %I.narrow_personal_credentials() SET search_path TO pg_catalog, %I, pg_temp',current_schema(),current_schema());
END;
$$;
