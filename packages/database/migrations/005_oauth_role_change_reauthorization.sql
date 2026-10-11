-- Keep issued connections and their board restrictions. Old unexchanged codes have no
-- role snapshot, so they must be approved again under the new consent contract.
ALTER TABLE oauth_requests ADD COLUMN approved_role text CHECK (approved_role IN ('viewer','member','admin'));
ALTER TABLE oauth_requests ADD COLUMN reviewed_role text CHECK (reviewed_role IN ('viewer','member','admin'));

UPDATE oauth_requests
SET consumed_at=COALESCE(consumed_at,now()),expires_at=LEAST(expires_at,now())
WHERE consumed_at IS NULL AND code_hash IS NOT NULL;

CREATE OR REPLACE FUNCTION narrow_personal_credentials() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.role IS DISTINCT FROM OLD.role THEN
    IF NEW.role='viewer' AND OLD.role<>'viewer' THEN
      UPDATE credentials SET access_level='read',include_admin=false
      WHERE user_id=NEW.id AND token_type='api-key' AND revoked_at IS NULL;
    ELSIF NEW.role='member' AND OLD.role='admin' THEN
      UPDATE credentials SET include_admin=false
      WHERE user_id=NEW.id AND token_type='api-key' AND revoked_at IS NULL;
    END IF;
    UPDATE credentials SET revoked_at=COALESCE(revoked_at,now())
    WHERE user_id=NEW.id AND token_type='oauth' AND revoked_at IS NULL;
    UPDATE oauth_requests SET consumed_at=COALESCE(consumed_at,now()),expires_at=LEAST(expires_at,now())
    WHERE user_id=NEW.id AND consumed_at IS NULL;
  END IF;
  RETURN NEW;
END;
$$;

DO $$
BEGIN
  EXECUTE format('ALTER FUNCTION %I.narrow_personal_credentials() SET search_path TO pg_catalog, %I, pg_temp',current_schema(),current_schema());
END;
$$;
