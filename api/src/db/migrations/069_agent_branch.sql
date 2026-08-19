-- An agent can belong to a branch (owner 2026-08-19: "make raju p investments
-- come in hosur branch").
--
-- Branch attribution has been: the referrer's branch if they are STAFF,
-- otherwise HO — "which is where agent relationships sit" (branch.ts, owner
-- 2026-08-04). That default is unchanged and still applies to every agent who
-- has no branch set here. This only adds a way to say that a PARTICULAR agent's
-- business belongs to a particular branch, which there was previously no way to
-- express at all: the agents table carried no branch column.
--
-- Nullable on purpose. NULL keeps the existing HO behaviour exactly, so no
-- agent's attribution changes until someone deliberately sets a branch.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS branch_id BIGINT REFERENCES branches(id);

CREATE INDEX IF NOT EXISTS idx_agents_branch ON agents(branch_id);
