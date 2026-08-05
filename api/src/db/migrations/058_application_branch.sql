-- Which branch earned this investment (owner 2026-08-04).
--
-- Staff are linked to a branch, so the person who BROUGHT the business tells
-- you the branch: Rahini A → Tiruppur, Bindhu R → RS Puram.
--
-- Two decisions from the owner, both load-bearing:
--
--   1. Agent-sourced business counts under HO. 706 of 808 investments on the
--      live book came through agents (RAJU-P, Viswanath, Guna, …) and agents
--      have no branch of their own, so HO owns those relationships. Anything
--      that cannot be traced to a branch person lands there too.
--   2. The branch is STAMPED ON THE INVESTMENT and never moves. If Bindhu
--      transfers to Tiruppur, the business she already booked stays with
--      RS Puram — last month's report never changes underneath you. That is
--      why this is a column and not a join through users.branch_id.
--
-- "Brought by" is the REFERRER, not the enroller. The enroller is whoever typed
-- the record in, and that is 'Dhanam Admin' on 638 of 808 rows (the migration
-- and bulk entry) — deriving a branch from it would put the whole book in one
-- place. Bindhu has 35 referred investments against 5 enrolled; Rahini 33
-- against 4.
--
-- The resolution below is deliberately the SAME rule reports/book.ts uses for
-- Staff-wise (EFF_REF → code first, then name), so a branch total and a staff
-- total can never disagree about who brought an investment:
--   * effective referrer = the application's referred_by_text, falling back to
--     the customer's (survives a legacy re-import wiping the app-level copy),
--   * matched to users.code first, then full_name.
ALTER TABLE applications ADD COLUMN IF NOT EXISTS branch_id BIGINT REFERENCES branches(id);
CREATE INDEX IF NOT EXISTS idx_applications_branch ON applications(branch_id);

WITH ho AS (SELECT id FROM branches WHERE upper(btrim(code)) = 'HO' ORDER BY id LIMIT 1)
UPDATE applications a
   SET branch_id = COALESCE(
     (SELECT u.branch_id
        FROM users u JOIN roles r ON r.id = u.role_id
        CROSS JOIN LATERAL (
          SELECT COALESCE(NULLIF(btrim(a.referred_by_text), ''),
                          NULLIF(btrim(c.referred_by_text), '')) AS ref
        ) e
       WHERE r.name <> 'customer' AND u.is_staff = TRUE AND u.branch_id IS NOT NULL
         AND e.ref IS NOT NULL
         AND (upper(btrim(u.code)) = upper(e.ref) OR lower(btrim(u.full_name)) = lower(e.ref))
       ORDER BY (upper(btrim(u.code)) = upper(e.ref)) DESC
       LIMIT 1),
     (SELECT id FROM ho))
  FROM customers c
 WHERE c.id = a.customer_id
   AND a.branch_id IS NULL;
