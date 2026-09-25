-- The Locker Manager role (owner 2026-09-25): every branch's lockers, booking
-- included, and none of the NCD book beyond the customers who hold one.
--
-- id 9 and not "the next free id": seed.ts derives role ids POSITIONALLY from
-- the ROLES array (`ROLES.map((r, i) => [r, i + 1])`), and locker_manager is
-- appended ninth. A different id here and the seed would later try to insert
-- id 9 under a name that already exists elsewhere, and collide on roles.name.
--
-- Production never runs the seed — ops/deploy.sh runs migrate only — so the row
-- has to arrive here. Its PERMISSIONS do not: syncRolePermissions() grants
-- DEFAULT_ROLE_PERMISSIONS at every boot, additively.
--
-- DO NOTHING rather than overwrite: if id 9 is somehow taken, the role simply
-- will not appear in the picker, which is visible and harmless. Renaming
-- whatever holds it would not be.
INSERT INTO roles (id, name, label, level)
VALUES (9, 'locker_manager', 'Locker Manager', 3)
ON CONFLICT (id) DO NOTHING;
