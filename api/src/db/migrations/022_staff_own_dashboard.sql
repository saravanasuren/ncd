-- 022: Branch staff get "My Dashboard" instead of the company-wide dashboard
-- (owner spec 2026-07-20). They should not see the NCD Portfolio at all; they
-- see only what they themselves brought in.
--
-- deploy.sh runs migrate but NOT seed, so the grant change has to land here or
-- the role_permissions table keeps the old rows until a manual reseed.

-- Grant the own-book dashboard to branch staff.
INSERT INTO role_permissions (role_id, permission)
SELECT r.id, 'dashboard:view-own' FROM roles r
WHERE r.name = 'branch_staff'
ON CONFLICT DO NOTHING;

-- …and take away the company-wide one (nav + API both key off this).
DELETE FROM role_permissions
WHERE permission = 'dashboard:view'
  AND role_id IN (SELECT id FROM roles WHERE name = 'branch_staff');
