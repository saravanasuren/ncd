/**
 * An agent record that is really an employee, folded into their staff user.
 *
 * Ticking `is_staff` on a user does NOTHING to their `agents` row — two tables,
 * no link — so the person stays on the Agents list and, worse, their incentive
 * stays on the AGENT side of every report. Live cases 2026-08-03: Dhanapal
 * (one person, one user, one agent row, ₹34,000 accrued of which ₹30,000 paid)
 * and S ASHOKKUMAR (a branch_manager whose ₹10,000 landed on a stale agent
 * record of the same name, because `resolveReferrer` checks agents BEFORE
 * users).
 *
 * Owner decision 2026-08-03: **move everything** — paid history too. Leaving
 * paid rows behind keeps the agent's name in the reports and makes the merge
 * look half-done.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
let seriesId: number;
beforeAll(async () => {
  ctx = await startTestServer();
  seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
});
afterAll(async () => { await ctx.close(); });

const as = async (email: string, password = 'Demo_1234') => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c; };
const admin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');

let n = 0;
const staffUserId = async (email: string) =>
  Number((await ctx.db.query('SELECT id FROM users WHERE email = $1', [email])).rows[0]!.id);

/** An agent carrying incentive — some paid, some not, like the live cases. */
async function agentWithMoney(opts: { paid?: number; unpaid?: number } = {}) {
  const a = await admin();
  const created = await a.post('/api/agents', { full_name: `Merge Case ${'ABCDEFGHIJ'[++n % 10]}${n}` });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  const agentId = Number(created.json.id);

  const cid = Number((await ctx.db.query(
    `INSERT INTO customers (customer_code, full_name, phone, creation_status, is_active)
     VALUES ($1,$2,$3,'Approved',TRUE) RETURNING id`,
    [`MRG${String(n).padStart(3, '0')}`, `Merge Customer ${n}`, `94100000${String(n).padStart(2, '0')}`])).rows[0]!.id);

  const app = async (amount: number, paid: boolean) => {
    const appId = Number((await ctx.db.query(
      `INSERT INTO applications (application_no, customer_id, series_id, status, total_amount)
       VALUES ($1,$2,$3,'Active',$4) RETURNING id`,
      [`APP-MRG-${++n}`, cid, seriesId, amount])).rows[0]!.id);
    await ctx.db.query(
      `INSERT INTO incentive_accruals (application_id, payee_type, payee_id, matrix_cell, rate_mode, rate_value, amount, accrual_date, paid_at)
       VALUES ($1,'agent',$2,'referrer','pct',2,$3,'2026-07-18',$4)`,
      [appId, agentId, amount * 0.02, paid ? new Date().toISOString() : null]);
    if (paid) await ctx.db.query(
      "INSERT INTO incentive_payouts (payee_type, payee_id, amount, application_id) VALUES ('agent',$1,$2,$3)",
      [agentId, amount * 0.02, appId]);
    return appId;
  };
  if (opts.paid) await app(opts.paid, true);
  if (opts.unpaid) await app(opts.unpaid, false);
  return { agentId, cid };
}

const accrualsFor = async (type: string, id: number) => (await ctx.db.query(
  'SELECT amount, paid_at FROM incentive_accruals WHERE payee_type = $1 AND payee_id = $2 ORDER BY id', [type, id])).rows as any[];

describe('everything moves — paid history included', () => {
  it('both the paid and the unpaid accrual land on the staff user', async () => {
    const { agentId } = await agentWithMoney({ paid: 1_500_000, unpaid: 200_000 });
    const uid = await staffUserId('ncd@demo.local');
    expect(await accrualsFor('agent', agentId)).toHaveLength(2);

    const r = await (await admin()).post(`/api/agents/${agentId}/merge-into-staff`, { user_id: uid });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.accruals_moved).toBe(2);

    expect(await accrualsFor('agent', agentId)).toHaveLength(0);
    const moved = await accrualsFor('staff', uid);
    expect(moved.filter((m) => m.paid_at !== null)).toHaveLength(1);   // the ₹30,000 case
    expect(moved.filter((m) => m.paid_at === null)).toHaveLength(1);
  });

  it('the payout ledger follows too — otherwise the money still reads as paid to an agent', async () => {
    const { agentId } = await agentWithMoney({ paid: 1_000_000 });
    const uid = await staffUserId('ncd@demo.local');
    const r = await (await admin()).post(`/api/agents/${agentId}/merge-into-staff`, { user_id: uid });
    expect(r.json.payouts_moved).toBe(1);
    const left = await ctx.db.query("SELECT 1 FROM incentive_payouts WHERE payee_type='agent' AND payee_id=$1", [agentId]);
    expect(left.rowCount).toBe(0);
  });

  it('the agent leaves the list, but is never hard-deleted', async () => {
    const { agentId } = await agentWithMoney({ unpaid: 100_000 });
    const uid = await staffUserId('ncd@demo.local');
    await (await admin()).post(`/api/agents/${agentId}/merge-into-staff`, { user_id: uid });

    const list = await (await admin()).get('/api/agents');
    expect((list.json.rows as any[]).some((a) => a.id === agentId)).toBe(false);
    // Still on the table — payee_id has no FK, so a hard delete orphans money.
    const still = await ctx.db.query('SELECT deleted_at FROM agents WHERE id = $1', [agentId]);
    expect(still.rowCount).toBe(1);
    expect(still.rows[0]!.deleted_at).not.toBeNull();
  });

  it('a referred-by naming them now resolves to the STAFF member, not the dead agent', async () => {
    const a = await admin();
    const created = await a.post('/api/agents', { full_name: 'Demo NCD Manager' });   // same name as the staff user
    const agentId = Number(created.json.id);
    const uid = await staffUserId('ncd@demo.local');
    const { resolveReferrer } = await import('../src/modules/agents/service.js');

    // Before: the agent shadows the employee — this is the S ASHOKKUMAR bug.
    expect((await resolveReferrer(ctx.db, 'Demo NCD Manager'))!.kind).toBe('agent');
    await a.post(`/api/agents/${agentId}/merge-into-staff`, { user_id: uid });
    const after = await resolveReferrer(ctx.db, 'Demo NCD Manager');
    expect(after!.kind).toBe('staff');
    expect(after!.id).toBe(uid);
  });
});

describe('guards', () => {
  // An `agent` account can carry is_staff=TRUE in seeded and legacy rows, so
  // the flag alone is not enough — merging an agent into an agent moves the
  // money nowhere useful. The endpoint must refuse exactly what the shortlist
  // refuses to offer.
  it('refuses an agent account even when its staff flag is set', async () => {
    const { agentId } = await agentWithMoney({ unpaid: 100_000 });
    const uid = Number((await ctx.db.query("SELECT id FROM users WHERE email = 'agent@demo.local'")).rows[0]!.id);
    const r = await (await admin()).post(`/api/agents/${agentId}/merge-into-staff`, { user_id: uid });
    expect(r.status).toBe(400);
    expect(r.json.error.message).toMatch(/not a staff account/i);
    expect(await accrualsFor('agent', agentId)).toHaveLength(1);   // nothing moved
  });

  it('refuses a user whose staff flag is off, and says what to do', async () => {
    const { agentId } = await agentWithMoney({ unpaid: 100_000 });
    const uid = await staffUserId('staff@demo.local');
    await ctx.db.query('UPDATE users SET is_staff = FALSE WHERE id = $1', [uid]);
    const r = await (await admin()).post(`/api/agents/${agentId}/merge-into-staff`, { user_id: uid });
    expect(r.status).toBe(400);
    expect(r.json.error.message).toMatch(/tick "staff"/i);
    await ctx.db.query('UPDATE users SET is_staff = TRUE WHERE id = $1', [uid]);   // restore
  });

  it('refuses rather than put two incentives on one investment', async () => {
    const { agentId } = await agentWithMoney({ unpaid: 500_000 });
    const uid = await staffUserId('ncd@demo.local');
    const appId = Number((await ctx.db.query(
      "SELECT application_id FROM incentive_accruals WHERE payee_type='agent' AND payee_id=$1", [agentId])).rows[0]!.application_id);
    await ctx.db.query(
      `INSERT INTO incentive_accruals (application_id, payee_type, payee_id, matrix_cell, rate_mode, rate_value, amount, accrual_date)
       VALUES ($1,'staff',$2,'staff_new','pct',2,5000,'2026-07-18')`, [appId, uid]);

    const r = await (await admin()).post(`/api/agents/${agentId}/merge-into-staff`, { user_id: uid });
    expect(r.status).toBe(409);
    expect(await accrualsFor('agent', agentId)).toHaveLength(1);   // untouched
  });

  it('an unknown agent is a 404', async () => {
    const uid = await staffUserId('ncd@demo.local');
    const r = await (await admin()).post('/api/agents/99999999/merge-into-staff', { user_id: uid });
    expect(r.status).toBe(404);
  });

  it('an agent cannot merge anybody', async () => {
    const { agentId } = await agentWithMoney({ unpaid: 100_000 });
    const uid = await staffUserId('ncd@demo.local');
    const r = await (await as('agent@demo.local')).post(`/api/agents/${agentId}/merge-into-staff`, { user_id: uid });
    expect(r.status).toBe(403);
  });

  it('merging the same agent twice is a 404, not a double move', async () => {
    const { agentId } = await agentWithMoney({ unpaid: 100_000 });
    const uid = await staffUserId('ncd@demo.local');
    expect((await (await admin()).post(`/api/agents/${agentId}/merge-into-staff`, { user_id: uid })).status).toBe(200);
    expect((await (await admin()).post(`/api/agents/${agentId}/merge-into-staff`, { user_id: uid })).status).toBe(404);
  });
});

describe('the staff shortlist', () => {
  it('offers staff users only — never agents or customers', async () => {
    const r = await (await admin()).get('/api/agents/staff-candidates?q=demo');
    expect(r.status).toBe(200);
    for (const u of r.json.rows as any[]) expect(['agent', 'customer']).not.toContain(u.role);
  });

  it('says nothing for a one-character search rather than listing everyone', async () => {
    const r = await (await admin()).get('/api/agents/staff-candidates?q=d');
    expect(r.json.rows).toHaveLength(0);
  });
});
