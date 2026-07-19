-- 021: Merge referrers into agents (owner: "agents and referrers are the same").
--
-- Referrers were a thin fallback ledger for a "referred by" name that matched
-- neither an agent nor a staff user — a legacy stub, so the same person could
-- show up once as an Agent and again as a Referrer. There is only ONE kind of
-- external earner: an agent. This migration folds every referrer into agents,
-- repoints their incentive accruals/payouts to payee_type='agent', and drops
-- the referrers table. Plain Postgres SQL (no temp tables) so it runs the same
-- on PGlite (dev/test) and Postgres (prod).

-- 1. Ensure an agent exists for every referrer. Reuse a name-matching agent
--    when there is one (that reuse is exactly the duplicate we're collapsing);
--    otherwise create one. 'AG-R<id>' codes can't collide with the app's
--    'AG-####' sequence. Approved referrers carry that status across; the rest
--    land as PendingApproval and are granted commission via the normal flow.
INSERT INTO agents (agent_code, full_name, source, commission_status, is_active, bank_name, account_number, ifsc)
SELECT 'AG-R' || r.id, r.display_name, 'referral',
       CASE r.eligibility_status
         WHEN 'Approved' THEN 'Approved'
         WHEN 'Revoked'  THEN 'Revoked'
         ELSE 'PendingApproval'
       END,
       TRUE, r.bank_name, r.account_number, r.ifsc
FROM referrers r
WHERE NOT EXISTS (
  SELECT 1 FROM agents a WHERE lower(btrim(a.full_name)) = lower(btrim(r.display_name))
)
ON CONFLICT (agent_code) DO NOTHING;

-- 2. Drop referrer accruals that would collide with an existing agent accrual
--    for the same application (the same person as both enroller-agent and
--    referrer) — the unique (application_id, payee_type, payee_id) index forbids
--    two 'agent' rows, and the enroller row already holds that slot.
DELETE FROM incentive_accruals ia
WHERE ia.payee_type = 'referrer'
  AND EXISTS (
    SELECT 1 FROM incentive_accruals x
    WHERE x.application_id = ia.application_id
      AND x.payee_type = 'agent'
      AND x.payee_id = (
        SELECT a.id FROM agents a
        JOIN referrers r ON lower(btrim(a.full_name)) = lower(btrim(r.display_name))
        WHERE r.id = ia.payee_id ORDER BY a.id LIMIT 1)
  );

-- 3. Repoint the remaining referrer accruals to their agent.
UPDATE incentive_accruals ia
SET payee_type = 'agent',
    payee_id = (
      SELECT a.id FROM agents a
      JOIN referrers r ON lower(btrim(a.full_name)) = lower(btrim(r.display_name))
      WHERE r.id = ia.payee_id ORDER BY a.id LIMIT 1)
WHERE ia.payee_type = 'referrer';

-- 4. Repoint referrer payouts (no unique constraint → no collision handling).
UPDATE incentive_payouts ip
SET payee_type = 'agent',
    payee_id = (
      SELECT a.id FROM agents a
      JOIN referrers r ON lower(btrim(a.full_name)) = lower(btrim(r.display_name))
      WHERE r.id = ip.payee_id ORDER BY a.id LIMIT 1)
WHERE ip.payee_type = 'referrer';

-- 5. The referrers table is now fully absorbed into agents.
DROP TABLE IF EXISTS referrers;
