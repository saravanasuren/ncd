-- 023: Branch staff lose the My Earnings page (owner spec 2026-07-20).
--
-- My Dashboard now carries a single tile showing the incentive they have
-- actually been PAID to date — deliberately not the accrued/pending balance.
-- That tile is served by the dashboard:view-own endpoint, so branch staff no
-- longer need earnings:read-own at all.
--
-- deploy.sh runs migrate but NOT seed, so the revoke has to land here.
DELETE FROM role_permissions
WHERE permission = 'earnings:read-own'
  AND role_id IN (SELECT id FROM roles WHERE name = 'branch_staff');
