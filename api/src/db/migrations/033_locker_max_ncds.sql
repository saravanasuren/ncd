-- 033_locker_max_ncds — how many NCDs may jointly back one locker deposit.
--
-- A single investment often doesn't cover the deposit (a ₹1L NCD against a ₹3L
-- deposit), so staff can pledge more than one and the deposit leg settles once
-- the pledged total reaches it. Configurable from Settings rather than hardcoded
-- because it's a business rule, not a technical limit.
INSERT INTO app_settings (key, value, group_name, label, description, editable_by)
VALUES ('lockers.max_ncds_per_deposit',
        '2',
        'Lockers',
        'Max NCDs per locker deposit',
        'How many investments may jointly back one locker deposit. The leg settles on LockerHub once the pledged total reaches the deposit amount.',
        'admin')
ON CONFLICT (key) DO NOTHING;

-- Multiple NCDs may now jointly back one locker deposit (owner, 2026-07-22), so
-- the old "one active link per locker" index has to go — it was the schema-level
-- expression of the single-NCD rule (031). Replaced with a per-(locker,
-- investment) uniqueness rule: additional investments are allowed, but the SAME
-- investment can't be pledged to the same locker twice. How many may join is a
-- business rule, enforced in linkDeposit from the setting above, not in an index.
DROP INDEX IF EXISTS uq_locker_links_locker_active;
CREATE UNIQUE INDEX IF NOT EXISTS uq_locker_links_locker_app_active
  ON locker_deposit_links (lockerhub_application_id, application_id) WHERE status = 'active';
