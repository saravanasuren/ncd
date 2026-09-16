-- 095_digio_failed_session_not_live — a dead signing session is not a live one.
--
-- 092 gave each hirer at most one LIVE Digio session per agreement, and spelled
-- "live" as `status <> 'cancelled'`: everything except a deliberate supersede
-- counted. That was true while the only statuses ever written were 'requested'
-- and 'signed'.
--
-- Nothing used to record a signature that is never coming — an expired link or
-- a declined request sat at 'requested' for ever. Now that the poller writes
-- 'failed', the old predicate would count that dead row as the hirer's live
-- session and REFUSE the re-send it is asking for. 'failed' is terminal, so it
-- belongs on the same side of the line as 'cancelled'.
--
-- The rows themselves stay: the attempt and its reason (webhook_payload ->
-- digio_status) are the audit trail of why the customer was asked twice.
--
-- Idempotent; Postgres + PGlite. Narrower than the index it replaces, so it
-- cannot fail on existing data that the old one already allowed.

DROP INDEX IF EXISTS uq_digio_locker_agreement_signer;

CREATE UNIQUE INDEX IF NOT EXISTS uq_digio_locker_agreement_signer
  ON digio_signing_sessions (locker_agreement_signing_id, signer_position)
  WHERE locker_agreement_signing_id IS NOT NULL
    AND signer_position IS NOT NULL
    AND status <> 'cancelled'
    AND status <> 'failed';
