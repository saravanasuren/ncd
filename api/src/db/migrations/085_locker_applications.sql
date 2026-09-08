-- 085_locker_applications — NCD's own index of the locker applications it made.
--
-- Owner 2026-09-08: "when i create a locker application it should get created
-- and if i delete it should get deleted." Before either can be true you have to
-- be able to FIND it, and you could not: the API had GET /applications/:id but
-- no GET /applications, and LockerHub has no list endpoint either, so once the
-- enrolment tab was closed the application was unreachable. 49 had been created
-- and 45 of them were live and invisible — not resumable, not deletable.
--
-- This is that list. One row per application NCD creates, written at create time
-- beside locker_intended_locker.
--
-- Removal deliberately does NOT gain a column here. It already lives in
-- locker_tenant_overrides.removed_at, keyed on this same id, and
-- removeLockerApplication already writes it; a second home for "is it gone"
-- would drift from the first. The list LEFT JOINs it instead.
--
-- LockerHub owns the application, so `status` here is a CACHE of what they last
-- told us, stamped with when we asked. It is never authority: refresh it when a
-- row is opened or when the user asks.
--
-- Idempotent; Postgres + PGlite.

CREATE TABLE IF NOT EXISTS locker_applications (
  lockerhub_application_id  TEXT PRIMARY KEY,
  customer_id               BIGINT REFERENCES customers(id) ON DELETE SET NULL,
  -- Who it is for, snapshotted. A row must still read when no NCD customer is
  -- linked (a walk-in created straight on LockerHub) or the customer is archived.
  customer_name             TEXT,
  phone                     TEXT,
  branch_id                 TEXT,
  branch_name               TEXT,
  locker_size               TEXT,
  locker_number             TEXT,
  -- Last known LockerHub status, and when we asked. NULL = never checked.
  status                    TEXT,
  status_checked_at         TIMESTAMPTZ,
  created_by_user_id        BIGINT REFERENCES users(id),
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_locker_apps_created  ON locker_applications (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_locker_apps_customer ON locker_applications (customer_id);
CREATE INDEX IF NOT EXISTS idx_locker_apps_branch   ON locker_applications (branch_id);

-- ── Backfill what NCD already created ───────────────────────────────────────
-- Every application gets an auto 100% deposit waiver at create (rent-only
-- policy), so locker_fee_waivers is the closest thing to a historical index of
-- them. The other locker tables then fill in what they happen to know.
--
-- Fields that need a LockerHub call (size, status, and the branch/customer of
-- an application that never reached allotment) stay NULL: a migration must not
-- make a network call. They fill in when a row is opened, or in one pass from
-- the page's own "Refresh from LockerHub" button. A row with nothing but an id
-- is still the thing that was missing — it is reachable.
INSERT INTO locker_applications (lockerhub_application_id, created_at, created_by_user_id)
SELECT w.lockerhub_application_id, min(w.created_at), min(w.created_by_user_id)
  FROM locker_fee_waivers w
 WHERE COALESCE(w.lockerhub_application_id, '') <> ''
 GROUP BY w.lockerhub_application_id
ON CONFLICT (lockerhub_application_id) DO NOTHING;

INSERT INTO locker_applications (lockerhub_application_id, created_at, created_by_user_id, locker_number)
SELECT i.lockerhub_application_id, i.created_at, i.created_by_user_id, i.locker_number
  FROM locker_intended_locker i
 WHERE COALESCE(i.lockerhub_application_id, '') <> ''
ON CONFLICT (lockerhub_application_id) DO NOTHING;

-- The locker the branch picked at step 1, for rows that came in via the waiver.
UPDATE locker_applications a
   SET locker_number = COALESCE(a.locker_number, i.locker_number)
  FROM locker_intended_locker i
 WHERE i.lockerhub_application_id = a.lockerhub_application_id
   AND a.locker_number IS NULL;

-- Allotted ones know the customer, the locker and the branch.
UPDATE locker_applications a
   SET customer_id   = COALESCE(a.customer_id, al.customer_id),
       locker_number = COALESCE(a.locker_number, al.locker_no),
       branch_id     = COALESCE(a.branch_id, al.branch_id),
       branch_name   = COALESCE(a.branch_name, al.branch_name)
  FROM locker_allotments al
 WHERE al.lockerhub_application_id = a.lockerhub_application_id;

-- An agreement signing knows the customer even when allotment never happened.
UPDATE locker_applications a
   SET customer_id = s.customer_id
  FROM locker_agreement_signings s
 WHERE s.lockerhub_application_id = a.lockerhub_application_id
   AND a.customer_id IS NULL
   AND s.customer_id IS NOT NULL;

-- Name and phone from whichever customer we managed to link above.
UPDATE locker_applications a
   SET customer_name = COALESCE(a.customer_name, c.full_name),
       phone         = COALESCE(a.phone, c.phone)
  FROM customers c
 WHERE c.id = a.customer_id;
