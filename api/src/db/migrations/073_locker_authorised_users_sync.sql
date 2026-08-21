-- 073 — track the LockerHub A22 push for each authorised user. We push AFTER the
-- holder's consent is signed and the locker is allotted (LockerHub 409s before
-- allotment). Best-effort: a failure stores the error and stays retryable, it
-- never blocks the signing.
ALTER TABLE locker_authorised_users ADD COLUMN IF NOT EXISTS lockerhub_synced_at TIMESTAMPTZ;
ALTER TABLE locker_authorised_users ADD COLUMN IF NOT EXISTS lockerhub_error TEXT;
