-- 019: Self-service sign-up (Staff / Agent).
--
-- New staff/agent accounts can be created from the login page and used
-- immediately (own-scope only, via their role). They start UNVERIFIED and
-- an Admin/CXO reviews them in Approvals. Unverified self-signups are blocked
-- from login after 30 days. Existing/migrated users have is_self_signup=FALSE
-- and are never subject to the verification block.
ALTER TABLE users ADD COLUMN IF NOT EXISTS employee_id     TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS verified_at     TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_self_signup  BOOLEAN NOT NULL DEFAULT FALSE;
