-- 087 — record whether a removal actually reached LockerHub.
--
-- Owner 2026-09-08: "if i delete in ncd i want it to get deleted in locker hub
-- also". For an application that has not been allotted it already does — since
-- their cancel endpoint shipped on 24 Aug, 4 of 4 deletions cancelled on their
-- side and released the locker.
--
-- It could NOT for an allotted one when this was written: LockerHub had no
-- endpoint that closed a tenancy, so a Super Admin's force-removal hid our row
-- while the customer still held the locker. 8 tenancies are in that state.
--
-- They shipped A25 (close) and A26 (delete) on 2026-09-08, so that gap is
-- closing — but these columns stay useful either way: the 8 historical rows
-- still need marking, and a closure can still be refused (an open refund, for
-- one), which is exactly when FALSE must be visible.
--
-- A row that says "deleted" while the locker is still let is the exact
-- two-systems-disagreeing failure the removal code was written to avoid, and
-- right now nothing on screen distinguishes them.
--
--   TRUE  — cancelled on LockerHub; the locker is genuinely released
--   FALSE — hidden in NCD only; LockerHub still holds it
--   NULL  — unknown (removed before this column existed and not recoverable)
--
-- Idempotent; Postgres + PGlite.

ALTER TABLE locker_tenant_overrides ADD COLUMN IF NOT EXISTS lockerhub_cancelled BOOLEAN;
ALTER TABLE locker_tenant_overrides ADD COLUMN IF NOT EXISTS lockerhub_refusal   TEXT;

-- Backfill from the audit trail, which has recorded this on every application
-- removal since the cancel endpoint went in.
UPDATE locker_tenant_overrides o
   SET lockerhub_cancelled = (a.after_data ->> 'cancelled_on_lockerhub')::boolean,
       lockerhub_refusal   = NULLIF(a.after_data ->> 'lockerhub_refusal', '')
  FROM (
    SELECT DISTINCT ON (entity_id) entity_id, after_data
      FROM audit_log
     WHERE action = 'locker.application.remove'
     ORDER BY entity_id, id DESC          -- the most recent removal wins
  ) a
 WHERE a.entity_id = o.lockerhub_tenant_id
   AND o.removed_at IS NOT NULL
   AND o.lockerhub_cancelled IS NULL;

-- A tenancy removed from the roster NEVER reached LockerHub: that path has no
-- upstream call to make, because their API cannot close a tenancy. Recording
-- this as FALSE rather than leaving it NULL is the whole point — these are the
-- rows most likely to be believed gone.
UPDATE locker_tenant_overrides o
   SET lockerhub_cancelled = FALSE
 WHERE o.removed_at IS NOT NULL
   AND o.lockerhub_cancelled IS NULL
   AND EXISTS (
     SELECT 1 FROM audit_log a
      WHERE a.action = 'locker.tenant.remove'
        AND a.after_data ->> 'tenant_id' = o.lockerhub_tenant_id
   );
