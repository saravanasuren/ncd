-- 093_locker_deposit_link_settlement — a failed NCD→locker deposit link must
-- leave a trace.
--
-- linkDeposit pledges the investment locally (which immediately blocks that
-- money from redemption), then tells LockerHub the deposit leg is NCD-backed
-- (§A12 link-ncd). If that call failed, the error went to the HTTP response and
-- a console.warn and NOWHERE ELSE: no column, no report, no retry. The pledge
-- stood, so the customer's money was frozen from redemption for good, the
-- locker's deposit leg stayed outstanding so it never allotted, and nothing in
-- any table or report knew. Re-linking was impossible too — the unique index in
-- 033 refuses the same investment on the same locker.
--
-- These two columns mirror what locker_cheques (052) and locker_fee_waivers
-- (053) already carry, so the same "recorded, surfaced, retryable" treatment
-- applies to the deposit leg.
--
-- Semantics, deliberately three-state:
--   settled_at SET            → LockerHub accepted the link.
--   error SET                 → LockerHub refused it. THIS is the chase list.
--   both NULL                 → never attempted, because the pledge does not yet
--                               cover the deposit in full (a partial pledge is
--                               not a failure). Existing rows are also both-NULL,
--                               which is why nothing is backfilled: we cannot
--                               know retroactively, and assuming failure would
--                               bury a real backlog under historical noise.
--
-- Idempotent; Postgres + PGlite.

ALTER TABLE locker_deposit_links ADD COLUMN IF NOT EXISTS lockerhub_settled_at TIMESTAMPTZ;
ALTER TABLE locker_deposit_links ADD COLUMN IF NOT EXISTS lockerhub_error      TEXT;

-- The chase list: a live pledge LockerHub refused.
CREATE INDEX IF NOT EXISTS idx_locker_links_unsettled
  ON locker_deposit_links (lockerhub_application_id)
  WHERE status = 'active' AND lockerhub_error IS NOT NULL;
