-- 072_locker_authorised_users — people the locker owner authorises to operate a
-- locker (owner 2026-08-22). An authorised user is NOT active until the owner has
-- e-signed a consent letter for them (Digio, NCD's own account), so the record is
-- born `consent_pending` and only flips to `active` on signature.
--
-- LockerHub has no authorised-user endpoint today (a CR is raised separately), so
-- this is an NCD-only record for now — keyed on the LockerHub application id, the
-- same key the pledges/cheques/waivers use.
CREATE TABLE IF NOT EXISTS locker_authorised_users (
  id                        BIGSERIAL PRIMARY KEY,
  lockerhub_application_id  TEXT NOT NULL,
  customer_id               BIGINT REFERENCES customers(id),  -- the owner giving consent
  name                      TEXT NOT NULL,
  pan                       TEXT,
  aadhaar                   TEXT,
  phone                     TEXT,
  status                    TEXT NOT NULL DEFAULT 'consent_pending', -- consent_pending | active | revoked
  consent_digio_request_id  TEXT,
  consent_sign_url          TEXT,
  consent_signed_at         TIMESTAMPTZ,
  consent_pdf_path          TEXT,
  created_by_user_id        BIGINT REFERENCES users(id),
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at                TIMESTAMPTZ,
  revoked_reason            TEXT
);
CREATE INDEX IF NOT EXISTS idx_locker_auth_users_app ON locker_authorised_users (lockerhub_application_id);

-- Make the Digio signing table polymorphic so a consent letter reuses the same
-- webhook + poller as an application form. application_id is dropped as mandatory
-- (a consent letter has none); document_type routes completion; the FK ties the
-- session back to the authorised-user row.
ALTER TABLE digio_signing_sessions ALTER COLUMN application_id DROP NOT NULL;
ALTER TABLE digio_signing_sessions ADD COLUMN IF NOT EXISTS document_type TEXT NOT NULL DEFAULT 'application_form';
ALTER TABLE digio_signing_sessions ADD COLUMN IF NOT EXISTS locker_authorised_user_id BIGINT REFERENCES locker_authorised_users(id) ON DELETE CASCADE;
