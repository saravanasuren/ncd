-- 017: Identity codes + staff flag (owner spec, 2026-07-18).
--
-- Every user gets a unique CODE and a "staff?" flag set at user creation.
-- Codes are what goes into the "referred by" field going forward: the person
-- mapped to the code earns the incentive. Referrers who are staff show under
-- Staff-wise; everyone else (agents — users or standalone people) under
-- Agent-wise. Agents keep their own table (agents.agent_code) — a user can be
-- both, and an agent need not have a login.
ALTER TABLE users ADD COLUMN IF NOT EXISTS code TEXT UNIQUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_staff BOOLEAN NOT NULL DEFAULT TRUE;

-- Agents created from the referred-by free-text path await approval before
-- they are payable; track where an agent came from.
-- (agents.commission_status already carries PendingApproval/Approved/Revoked.)
CREATE INDEX IF NOT EXISTS idx_users_code ON users(code) WHERE code IS NOT NULL;

-- Incentive repoint (owner 2026-07-18): on a repeat investment from an existing
-- customer the REFERRER earns the repeat rate (0.25% default), not the
-- enrolling staff. New referrer-existing setting row (visible/editable in the
-- Settings UI even before the next seed), and the staff-existing cell drops to
-- 0 — but only if it still holds the old default (an admin-customized value is
-- left alone).
INSERT INTO app_settings (key, value, group_name, label, description, editable_by)
VALUES ('incentive.referrer_existing_with_referrer',
        '{"mode":"pct","value":0.25}',
        'Incentives',
        'Referrer % — existing customer (repeat investment)',
        'Referrer incentive when they bring a repeat investment from an existing Dhanam customer (handover rate).',
        'workflow')
ON CONFLICT (key) DO NOTHING;

UPDATE app_settings
SET value = '{"mode":"pct","value":0}'
WHERE key = 'incentive.staff_existing_with_referrer'
  AND value::jsonb = '{"mode":"pct","value":0.25}'::jsonb;
