-- 118 — the redemption request letter becomes a third thing Digio can sign
-- (owner 2026-11-18).
--
-- digio_signing_sessions is already the one table for every Digio session, with
-- `document_type` as the discriminator and a nullable foreign key per kind:
-- application_id for the application form, locker_authorised_user_id for a
-- consent letter, locker_agreement_signing_id for a locker agreement. The
-- redemption letter is the fourth document_type and follows exactly that
-- shape — a fourth nullable key rather than a fourth table, so the poller and
-- the webhook keep finding every outstanding signature in one query.
ALTER TABLE digio_signing_sessions
  ADD COLUMN IF NOT EXISTS redemption_signing_id BIGINT REFERENCES redemption_signings(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_digio_sessions_redemption
  ON digio_signing_sessions (redemption_signing_id)
  WHERE redemption_signing_id IS NOT NULL;
