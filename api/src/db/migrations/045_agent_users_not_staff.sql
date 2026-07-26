-- Migration 039 gave every agent a users row but never set is_staff, so each
-- one inherited the column's TRUE default — silently misattributing every
-- agent's referred business as STAFF-sourced everywhere is_staff is read: the
-- Agent-wise/Staff-wise report split (reports/book.ts FROM_ATTR), the
-- incentive staff/agent split (incentives/service.ts), and the agent-code
-- lookup's "staff vs agent" kind (agents/service.ts).
--
-- Owner 2026-07-25: agents who are now also users are still agents, not
-- staff — only people who were ALREADY staff stay staff. role = 'agent' is
-- the reliable signal (039 always sets it; nothing else does), so this is a
-- deterministic, idempotent backfill — re-running it is a no-op.
UPDATE users u
   SET is_staff = FALSE
  FROM roles r
 WHERE r.id = u.role_id AND r.name = 'agent' AND u.is_staff = TRUE;
