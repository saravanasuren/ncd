-- Every agent becomes a user (owner 2026-07-24).
--
-- Agents used to live only in `agents`, so deleting someone from the Users page
-- left their name on the Agents and Incentives lists. From here every agent has
-- a users row (role 'agent'), and deleting that user retires the agent
-- everywhere — see users/service.ts deleteUser.
--
-- No email or password is required: agents without an email get a placeholder
-- at @agents.dhanam.local and a NULL password_hash, which cannot authenticate.
-- Set a real email + password later to let one of them actually log in.

-- Retirement marker. Soft, not a DELETE: incentive_accruals.payee_id is a plain
-- BIGINT (no FK), so hard-deleting an agent would orphan paid money records and
-- lose the payee's name on them. Retired agents vanish from every list instead.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_agents_live ON agents(is_active) WHERE deleted_at IS NULL;

-- One user per agent that lacks one. An agent whose email already belongs to a
-- user is LINKED to it rather than duplicated (e.g. Saravana Suren S).
INSERT INTO users (email, full_name, phone, role_id, is_active, password_hash)
SELECT DISTINCT ON (email_key)
       email_key, ag.full_name, ag.phone,
       (SELECT id FROM roles WHERE name = 'agent'),
       ag.is_active, NULL
  FROM agents ag
  CROSS JOIN LATERAL (
    SELECT COALESCE(NULLIF(lower(btrim(ag.email)), ''), lower(ag.agent_code) || '@agents.dhanam.local') AS email_key
  ) k
 WHERE ag.user_id IS NULL
   AND ag.deleted_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM users u WHERE lower(u.email) = k.email_key)
 ORDER BY email_key, ag.id
ON CONFLICT (email) DO NOTHING;

UPDATE agents ag
   SET user_id = u.id
  FROM users u
 WHERE ag.user_id IS NULL
   AND ag.deleted_at IS NULL
   AND lower(u.email) = COALESCE(NULLIF(lower(btrim(ag.email)), ''), lower(ag.agent_code) || '@agents.dhanam.local');
