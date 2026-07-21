-- 025: Super-admin delete/archive of customers & investments (owner spec 2026-07-21).
-- Only the Super Admin may archive (recoverable) or permanently purge a customer
-- or an investment. Two new permissions + archive bookkeeping columns.
--
-- deploy.sh runs migrate but NOT seed, so the grant has to land here or the
-- role_permissions table never gets the new rows.

-- Grant the two delete permissions to super_admin ONLY (admin deliberately excluded).
INSERT INTO role_permissions (role_id, permission)
SELECT r.id, p.permission
FROM roles r
CROSS JOIN (VALUES ('customers:delete'), ('applications:delete')) AS p(permission)
WHERE r.name = 'super_admin'
ON CONFLICT DO NOTHING;

-- Archive (soft-delete) bookkeeping. archived_at IS NOT NULL ⇒ hidden from the
-- book, dashboard, reports and default lists, but fully recoverable.
ALTER TABLE customers    ADD COLUMN IF NOT EXISTS archived_at     TIMESTAMPTZ;
ALTER TABLE customers    ADD COLUMN IF NOT EXISTS archived_by     BIGINT REFERENCES users(id);
ALTER TABLE customers    ADD COLUMN IF NOT EXISTS archived_reason TEXT;

ALTER TABLE applications ADD COLUMN IF NOT EXISTS archived_at     TIMESTAMPTZ;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS archived_by     BIGINT REFERENCES users(id);
ALTER TABLE applications ADD COLUMN IF NOT EXISTS archived_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_customers_archived    ON customers(archived_at);
CREATE INDEX IF NOT EXISTS idx_applications_archived ON applications(archived_at);
