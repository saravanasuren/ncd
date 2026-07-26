-- 044_backfill_application_agent — attribute existing investments to the
-- customer's agent.
--
-- Application creation used to set enrolled_by_agent_id = the acting user's
-- agent id, which is NULL whenever staff/admin booked the investment — so every
-- staff-booked application had no agent, and an agent's own customer's
-- investment never appeared in that agent's scoped dashboard (it read ₹0).
-- The code now inherits the customer's agent; this fixes the rows already
-- written. Idempotent (only fills NULLs); Postgres + PGlite.

UPDATE applications a
   SET enrolled_by_agent_id = c.enrolled_by_agent_id
  FROM customers c
 WHERE a.customer_id = c.id
   AND a.enrolled_by_agent_id IS NULL
   AND c.enrolled_by_agent_id IS NOT NULL;
