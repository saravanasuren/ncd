-- Agents no longer see the NCD Portfolio dashboard (owner 2026-08-05).
--
-- Reported: "srinesh d is a agent - but in his login he is getting all the
-- dashboard views". He is Srinish D (user 3, role `agent`). The agent role
-- inherits STAFF_FUNNEL, which carries `dashboard:view`, so the page was his by
-- design rather than by accident.
--
-- No data leaked. An agent's scope is `enrolled_by_agent_id = <their agent id>`,
-- and every one of the fifteen dashboard queries goes through it — checked
-- against production, he could see 0 of 809 investments and 0 of 607 customers.
-- The objection is to what the page IS: the company's book — outstanding, cost
-- of funds, branch and series performance — not to what he could read off it.
--
-- He keeps the funnel (leads → customer → application) and My Earnings, and now
-- lands on Leads, exactly like branch_staff, whose role definition has always
-- filtered `dashboard:view` out of the same shared list.
--
-- THIS MIGRATION IS THE WHOLE FIX ON A LIVE BOX. `syncRolePermissions` runs at
-- every boot but is deliberately ADDITIVE ONLY — it grants what is missing and
-- never revokes, so changing the TypeScript alone would leave the live
-- `role_permissions` row untouched and the dashboard still on his menu. Taking a
-- permission away is a deliberate act and belongs here, where it is reviewable.
DELETE FROM role_permissions
 WHERE permission = 'dashboard:view'
   AND role_id = (SELECT id FROM roles WHERE name = 'agent');
