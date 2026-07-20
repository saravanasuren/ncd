-- 024: Fold "My Dashboard" back into My Earnings (owner spec 2026-07-20).
--
-- There is no separate My Dashboard section any more. Branch staff keep My
-- Earnings — it now carries what they brought in (investments, applications,
-- customers, series-wise + month-wise) alongside what they've been PAID.
-- They still do NOT get the company-wide NCD Portfolio dashboard (022 stands).
--
-- deploy.sh runs migrate but NOT seed, so the grant fixes have to land here.

-- Give branch staff My Earnings back (023 had revoked it).
INSERT INTO role_permissions (role_id, permission)
SELECT r.id, 'earnings:read-own' FROM roles r
WHERE r.name = 'branch_staff'
ON CONFLICT DO NOTHING;

-- dashboard:view-own no longer exists as a permission — drop any stale grant.
DELETE FROM role_permissions WHERE permission = 'dashboard:view-own';
