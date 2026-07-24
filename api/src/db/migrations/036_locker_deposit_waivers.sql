-- Locker deposit waivers / exceptions (owner 2026-07-24).
--
-- Some tenants hold a locker with NO NCD backing because the deposit
-- requirement was waived as an exception. Without a record, those rows are
-- indistinguishable from ordinary online-paid tenants. An NCD Manager (or
-- higher) records the waiver with a mandatory reason; Admin/CXO approves it in
-- the approvals queue; the Locker Tenants roster then tags the tenancy
-- "Deposit waived" with the reason. Purely informational — it settles nothing
-- on LockerHub's side.
--
-- Keyed on LockerHub's tenant_id (their tenancy PK — immutable, present on
-- every roster row). Identity + display fields are snapshotted so the record
-- stands on its own even when their API is unreachable.
CREATE TABLE IF NOT EXISTS locker_deposit_waivers (
  id                  BIGSERIAL PRIMARY KEY,
  lockerhub_tenant_id TEXT NOT NULL,
  locker_no           TEXT,
  branch_id           TEXT,
  tenant_name         TEXT,
  tenant_phone        TEXT,
  customer_id         BIGINT REFERENCES customers(id),
  reason              TEXT NOT NULL,
  -- PendingApproval -> Approved | Rejected | Cancelled
  status              TEXT NOT NULL DEFAULT 'PendingApproval',
  approval_request_id BIGINT,
  created_by_user_id  BIGINT REFERENCES users(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- One OPEN waiver per tenancy; history (rejected/cancelled) can accumulate.
CREATE UNIQUE INDEX IF NOT EXISTS uq_locker_waiver_tenant_open
  ON locker_deposit_waivers (lockerhub_tenant_id)
  WHERE status IN ('PendingApproval', 'Approved');

-- Maker permission for live installs (the seed map only re-syncs on a full
-- seed). admin/super_admin also granted so the live DB agrees with the seed.
INSERT INTO role_permissions (role_id, permission)
SELECT r.id, 'lockers:waive' FROM roles r WHERE r.name IN ('ncd_manager', 'admin', 'super_admin')
ON CONFLICT DO NOTHING;
