/**
 * Agent-app surface (NCD_INTEGRATION_CONTRACT.md B23) — the endpoints the
 * DhanamFin/LockerHub AGENT app calls on the agent's behalf. All are
 * X-Integration-Key authed and resolve the acting agent from the
 * `X-Acting-As-Agent: <ncd agent id>` header.
 *
 *   GET/PUT /api/my/profile
 *   GET     /api/my/customers
 *   GET     /api/my/earnings/summary
 *   GET     /api/my/earnings/breakdown
 *   GET     /api/investor-leads?mine=1
 */
import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { getDb } from '../../db/index.js';
import { asyncHandler } from '../../middleware/error.js';
import { requireIntegrationKey } from '../../middleware/integrationAuth.js';
import { writeAudit } from '../../lib/audit.js';
import { payeeBalance, payeeAccruals } from '../incentives/service.js';

/** Resolve the acting agent from X-Acting-As-Agent; 400 missing / 404 unknown. */
const resolveAgent: RequestHandler = asyncHandler(async (req, res, next) => {
  const id = parseInt(String(req.get('X-Acting-As-Agent') ?? ''), 10);
  if (!id || Number.isNaN(id)) { res.status(400).json({ error: 'X-Acting-As-Agent header required' }); return; }
  const agent = (await getDb().query<Record<string, unknown>>(
    `SELECT id, agent_code, full_name, phone, email, commission_status, commission_rate_pct,
            bank_name, account_number, ifsc, is_active
       FROM agents WHERE id = $1`, [id])).rows[0];
  if (!agent) { res.status(404).json({ error: 'agent not found' }); return; }
  res.locals.agent = agent;
  res.locals.agentId = Number(agent.id);
  next();
});

function agentProfile(a: Record<string, unknown>) {
  return {
    id: Number(a.id), agent_code: a.agent_code, full_name: a.full_name,
    phone: a.phone ?? null, email: a.email ?? null,
    commission_status: a.commission_status,
    commission_rate_pct: a.commission_rate_pct != null ? Number(a.commission_rate_pct) : null,
    bank_name: a.bank_name ?? null, account_number: a.account_number ?? null, ifsc: a.ifsc ?? null,
    is_active: a.is_active === true,
  };
}

export const myRouter = Router();
myRouter.use(requireIntegrationKey, resolveAgent);

myRouter.get('/profile', asyncHandler(async (_req, res) => {
  res.json({ profile: agentProfile(res.locals.agent) });
}));

// Self-service editable fields only (not code / name / commission).
myRouter.put('/profile', asyncHandler(async (req, res) => {
  const b = z.object({
    phone: z.string().nullish(), email: z.string().nullish(),
    bank_name: z.string().nullish(), account_number: z.string().nullish(), ifsc: z.string().nullish(),
  }).parse(req.body ?? {});
  const id = res.locals.agentId as number;
  const sets: string[] = []; const vals: unknown[] = [];
  for (const [k, v] of Object.entries(b)) {
    if (v !== undefined) { vals.push(v === '' ? null : v); sets.push(`${k} = $${vals.length}`); }
  }
  if (sets.length) {
    vals.push(id);
    await getDb().query(`UPDATE agents SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    await writeAudit(getDb(), { actorId: null, action: 'agent.self-update', entityType: 'agents', entityId: id, after: b });
  }
  const a = (await getDb().query<Record<string, unknown>>(
    `SELECT id, agent_code, full_name, phone, email, commission_status, commission_rate_pct,
            bank_name, account_number, ifsc, is_active FROM agents WHERE id = $1`, [id])).rows[0]!;
  res.json({ success: true, profile: agentProfile(a) });
}));

myRouter.get('/customers', asyncHandler(async (_req, res) => {
  const id = res.locals.agentId as number;
  const { rows } = await getDb().query(
    `SELECT c.id, c.customer_code, c.full_name, c.phone, c.district, c.kyc_status, c.created_at,
            COALESCE((SELECT count(*) FROM applications a
                       WHERE a.customer_id = c.id AND a.status NOT IN ('Rejected','Cancelled')),0)::int AS investments
       FROM customers c
      WHERE c.enrolled_by_agent_id = $1
      ORDER BY c.created_at DESC LIMIT 2000`, [id]);
  res.json({ customers: rows });
}));

myRouter.get('/earnings/summary', asyncHandler(async (_req, res) => {
  res.json(await payeeBalance(getDb(), 'agent', res.locals.agentId as number));
}));

myRouter.get('/earnings/breakdown', asyncHandler(async (_req, res) => {
  res.json({ rows: await payeeAccruals(getDb(), 'agent', res.locals.agentId as number) });
}));

/** GET /api/investor-leads?mine=1 — the acting agent's own leads (B23). */
export const agentLeadsRouter = Router();
agentLeadsRouter.get('/', requireIntegrationKey, resolveAgent, asyncHandler(async (req, res) => {
  const id = res.locals.agentId as number;
  const mine = String(req.query.mine ?? '') === '1' || String(req.query.mine ?? '') === 'true';
  if (!mine) { res.json({ leads: [] }); return; } // only the agent-scoped view is exposed here
  const { rows } = await getDb().query(
    `SELECT id, full_name, phone, district, status, interested_scheme, expected_amount,
            follow_up_date, created_at
       FROM investor_leads WHERE created_by_agent_id = $1 ORDER BY created_at DESC LIMIT 2000`, [id]);
  res.json({ leads: rows });
}));
