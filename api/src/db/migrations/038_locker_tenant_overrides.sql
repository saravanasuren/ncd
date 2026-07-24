-- NCD-side overrides on LockerHub's tenant roster (owner 2026-07-24).
--
-- Two things staff need that LockerHub's data can't give us:
--
-- 1. LINK a tenant to an NCD customer by hand. Automatic matching needs phone
--    plus a full name agreement, so "SEENU RAJAPPA" never links to our "SEENU".
--    PAN would settle it, but LockerHub does not expose one: their customer
--    `profile` is null for these tenants, and where a profile does exist the PAN
--    is MASKED ("KX****0L"). So the honest answer is an explicit human decision,
--    recorded here, rather than a cleverer guess.
--
-- 2. REMOVE a tenancy from our roster. super_admin only. LockerHub owns the
--    tenancy and exposes no close/delete endpoint (every variant 404s), so this
--    hides OUR row only — the locker stays allotted on their side. The UI says
--    so plainly; the reason is mandatory and audited.
--
-- Keyed on LockerHub's tenant_id, their immutable tenancy PK.
CREATE TABLE IF NOT EXISTS locker_tenant_overrides (
  lockerhub_tenant_id TEXT PRIMARY KEY,
  -- Manual link
  customer_id         BIGINT REFERENCES customers(id) ON DELETE SET NULL,
  linked_by_user_id   BIGINT REFERENCES users(id),
  linked_at           TIMESTAMPTZ,
  -- Removal from NCD's view
  removed_at          TIMESTAMPTZ,
  removed_reason      TEXT,
  removed_by_user_id  BIGINT REFERENCES users(id),
  -- Snapshot so a removed/unreachable tenancy is still identifiable in reports
  tenant_name         TEXT,
  locker_no           TEXT,
  branch_id           TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_lto_removed ON locker_tenant_overrides(removed_at);

INSERT INTO role_permissions (role_id, permission)
SELECT r.id, 'lockers:remove-tenant' FROM roles r WHERE r.name = 'super_admin'
ON CONFLICT DO NOTHING;
