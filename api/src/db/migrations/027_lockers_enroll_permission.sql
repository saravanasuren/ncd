-- 027_lockers_enroll_permission — staff can enroll a customer for a LockerHub
-- locker (NCD_INTEGRATION_CONTRACT.md Part A). deploy runs migrate not seed, so
-- the grant lands here (same pattern as 022–024).
--
-- Granted to the enrollment tier: super_admin, admin, ncd_manager,
-- branch_manager, branch_staff. NOT agents (they source leads, not lockers).

INSERT INTO role_permissions (role_id, permission)
SELECT r.id, 'lockers:enroll'
FROM roles r
WHERE r.name IN ('super_admin', 'admin', 'ncd_manager', 'branch_manager', 'branch_staff')
ON CONFLICT DO NOTHING;
