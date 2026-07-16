/**
 * Integration façade (docs/08 §1) — LockerHub / DhanamFin-facing endpoints.
 * Own key auth, no cookie/CSRF. Response SHAPES are the external contract
 * (byte-compatible with the legacy spec); these are thin adapters over the
 * same services first-party routes use. Contract-tested.
 */
import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../../db/index.js';
import { asyncHandler } from '../../middleware/error.js';
import { requireIntegrationKey } from '../../middleware/integrationAuth.js';
import { errors } from '../../lib/errors.js';
import { round2 } from '../../lib/dates.js';
import { kycProvider } from '../../integrations/kyc/index.js';
import { createApprovalRequest, registerOnFinalApprove } from '../approvals/service.js';
import { enqueue } from '../notifications/service.js';

// On agent-registration approval: activate the agent + notify.
registerOnFinalApprove('agent_registration', async (tx, req) => {
  if (!req.entity_id) return;
  await tx.query("UPDATE agents SET is_active = TRUE, commission_status = 'Approved' WHERE id = $1", [Number(req.entity_id)]);
  const agent = (await tx.query<{ email: string | null; phone: string | null; full_name: string; agent_code: string }>(
    'SELECT email, phone, full_name, agent_code FROM agents WHERE id = $1', [Number(req.entity_id)])).rows[0];
  const to = agent?.email ?? agent?.phone;
  if (to && agent) await enqueue(tx, { channel: agent.email ? 'email' : 'sms', template: 'agent_registration_approved', to, payload: { agentName: agent.full_name, agentCode: agent.agent_code } });
});

export const integrationRouter = Router();
integrationRouter.use(requireIntegrationKey);

/** L1 — customer summary by phone. */
integrationRouter.get('/customers/by-phone/:phone', asyncHandler(async (req, res) => {
  const { rows } = await getDb().query<Record<string, unknown>>(
    `SELECT id, customer_code, full_name, phone, email, kyc_status FROM customers WHERE phone = $1 AND is_active = TRUE LIMIT 1`, [req.params.phone]);
  if (!rows[0]) throw errors.notFound('Customer not found');
  const c = rows[0];
  res.json({ id: Number(c.id), customer_code: c.customer_code, name: c.full_name, phone: c.phone, email: c.email, kyc_status: c.kyc_status });
}));

/** L2 — holdings, with is_locker_deposit flag + totals block (avoids the
 * LockerHub double-count of locker deposits). */
integrationRouter.get('/customers/:id/holdings', asyncHandler(async (req, res) => {
  const db = getDb();
  const cid = Number(req.params.id);
  const rows = (await db.query<Record<string, unknown>>(
    `SELECT a.application_no, s.code AS series_code, a.total_amount, a.status, a.is_locker_deposit,
            a.allotment_date, a.maturity_date
     FROM applications a JOIN series s ON s.id = a.series_id
     WHERE a.customer_id = $1 AND a.status IN ('Active','Matured') ORDER BY a.allotment_date DESC`, [cid])).rows;
  const holdings = rows.map((r) => ({
    application_no: r.application_no, series: r.series_code, principal: r.total_amount,
    status: 'Active', // customer-facing mapping: pre-Active live states show Active
    is_locker_deposit: r.is_locker_deposit === true,
    next_payout_date: null, maturity_date: r.maturity_date,
  }));
  const ncdPrincipal = round2(rows.reduce((s, r) => s + Number(r.total_amount), 0));
  const lockerDeposit = round2(rows.filter((r) => r.is_locker_deposit === true).reduce((s, r) => s + Number(r.total_amount), 0));
  res.json({
    holdings,
    totals: {
      ncd_principal: ncdPrincipal,
      ncd_principal_excluding_locker_deposits: round2(ncdPrincipal - lockerDeposit),
      locker_deposit_via_ncd: lockerDeposit,
    },
  });
}));

/** Active series (for the app to show what's open). */
integrationRouter.get('/series/active', asyncHandler(async (_req, res) => {
  const rows = (await getDb().query("SELECT code, name, deemed_date FROM series WHERE status IN ('Open','Closing') ORDER BY code")).rows;
  res.json({ series: rows });
}));

/** Penny-drop bank verification (BAV v3 shape: status + detail + error code). */
integrationRouter.post('/penny-drop', asyncHandler(async (req, res) => {
  const { account_number, ifsc } = z.object({ account_number: z.string(), ifsc: z.string() }).parse(req.body);
  const r = await kycProvider().pennyDrop(account_number, ifsc);
  res.json({ status: r.status, detail: r.detail, error_code: r.status === 'Failed' ? 'BAV_FAILED' : null, holder_name: r.holderName ?? null });
}));

/** Lead from the app. Deduped on phone. */
integrationRouter.post('/leads', asyncHandler(async (req, res) => {
  const b = z.object({ full_name: z.string(), phone: z.string().optional(), interested_scheme: z.string().optional(), expected_amount: z.number().optional(), lockerhub_application_no: z.string().optional() }).parse(req.body);
  const db = getDb();
  if (b.lockerhub_application_no) {
    const dup = await db.query('SELECT id FROM investor_leads WHERE lockerhub_application_no = $1', [b.lockerhub_application_no]);
    if (dup.rows[0]) return res.json({ id: Number((dup.rows[0] as { id: string }).id), deduped: true });
  }
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO investor_leads (full_name, phone, source, interested_scheme, expected_amount, lockerhub_application_no, status)
     VALUES ($1,$2,'DhanamFin App',$3,$4,$5,'New') RETURNING id`,
    [b.full_name, b.phone ?? null, b.interested_scheme ?? null, b.expected_amount ?? null, b.lockerhub_application_no ?? null]);
  res.status(201).json({ id: Number(rows[0]!.id), deduped: false });
}));

/** Agent self-signup from the DhanamFin app → agent row + approval queue. */
integrationRouter.post('/agents/from-lockerhub', asyncHandler(async (req, res) => {
  const b = z.object({ full_name: z.string(), phone: z.string(), email: z.string().email().optional() }).parse(req.body);
  const db = getDb();
  const out = await db.withTx(async (tx) => {
    const existing = await tx.query('SELECT id FROM agents WHERE phone = $1', [b.phone]);
    if (existing.rows[0]) return { agent_id: Number((existing.rows[0] as { id: string }).id), status: 'exists' };
    const code = `AG-LH-${b.phone.slice(-6)}`;
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO agents (agent_code, full_name, phone, email, source, commission_status, is_active)
       VALUES ($1,$2,$3,$4,'dhanamfin','PendingApproval',FALSE) RETURNING id`,
      [code, b.full_name, b.phone, b.email ?? null]);
    const agentId = Number(rows[0]!.id);
    const req2 = await createApprovalRequest(tx, { type: 'agent_registration', entityType: 'agents', entityId: agentId, makerUserId: null, metadata: { agentName: b.full_name, agentCode: code } });
    return { agent_id: agentId, status: 'pending_approval', request_no: req2.request_no };
  });
  res.status(201).json(out);
}));

/** Redemption request from the app — lands in the staff queue (no self-approve). */
integrationRouter.post('/redemption-request', asyncHandler(async (req, res) => {
  const b = z.object({ application_no: z.string(), reason: z.string().default('App request') }).parse(req.body);
  const app = (await getDb().query<{ id: string }>("SELECT id FROM applications WHERE application_no = $1 AND status = 'Active'", [b.application_no])).rows[0];
  if (!app) throw errors.notFound('Investment not found or not redeemable');
  const { requestRedemption } = await import('../redemptions/service.js');
  const r = await requestRedemption(getDb(), { applicationId: Number(app.id), reason: b.reason, source: 'lockerhub' });
  res.status(201).json({ redemption_no: r.redemption_no, net_payment: r.netPayment, status: 'Requested' });
}));

/** KYC-doc mirror — DhanamFin app pushes a captured KYC document into Wealth. */
integrationRouter.post('/customers/:id/kyc-docs', asyncHandler(async (req, res) => {
  const b = z.object({ doc_type: z.string(), filename: z.string(), mime: z.string(), data_base64: z.string().min(1) }).parse(req.body);
  const db = getDb();
  const cust = await db.query('SELECT 1 FROM customers WHERE id = $1', [Number(req.params.id)]);
  if (!cust.rowCount) throw errors.notFound('Customer not found');
  const { saveBase64 } = await import('../../lib/storage.js');
  const { path } = saveBase64('kyc-docs', b.filename, b.data_base64);
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO customer_documents (customer_id, doc_type, file_path, original_filename, mime, origin) VALUES ($1,$2,$3,$4,$5,'dhanamfin') RETURNING id`,
    [Number(req.params.id), b.doc_type, path, b.filename, b.mime]);
  res.status(201).json({ id: Number(rows[0]!.id), origin: 'dhanamfin' });
}));

/** Email-check — route existing agents to Sign-In not Sign-Up (read-only). */
integrationRouter.get('/agents/email-check', asyncHandler(async (req, res) => {
  const email = String(req.query.email ?? '');
  const { rows } = await getDb().query('SELECT id FROM agents WHERE lower(email) = lower($1) LIMIT 1', [email]);
  res.json({ exists: rows.length > 0 });
}));
