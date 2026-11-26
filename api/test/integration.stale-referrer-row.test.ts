/**
 * An UNPAID commission row on somebody the referrer does not name.
 *
 * The go-live import credited whoever CREATED the customer record, with the
 * right amount, while the referrer named on the investment is somebody else.
 * Those rows carry matrix_cell NULL, so any repair scoped to
 * matrix_cell = 'referrer' cannot see them. A full-book scan on 2026-11-26
 * found two, Rs 48,000, both unpaid:
 *   - one sitting BESIDE the correct earner's paid row (a duplicate)
 *   - one where nobody else held it at all (just the wrong name)
 * Hence the two branches below. Re-accruing is the wrong tool for both: it
 * would delete the correct paid row, and it mints an enroller commission that
 * these imported investments have never carried.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, approveInvestment, type TestCtx, requiredInvestmentFields } from './helpers/server.js';

let ctx: TestCtx;
let admin: Client, checker: Client;
let seriesId: number, schemeId: number;

beforeAll(async () => {
  ctx = await startTestServer();
  admin = new Client(ctx.base);
  await admin.post('/api/auth/login', { email: 'admin@dhanam.finance', password: 'ChangeMe_Dev_123' });
  checker = new Client(ctx.base);
  await checker.post('/api/auth/login', { email: 'ncd@demo.local', password: 'Demo_1234' });
  seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
  schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
});
afterAll(async () => { await ctx.close(); });

const fix = async (no: string) => {
  const { fixStaleReferrerRows } = await import('../src/modules/incentives/stale-referrer-row.js');
  return ctx.db.withTx((tx) => fixStaleReferrerRows(tx, no, { reason: 'Owner confirmed the named referrer earns it.' }));
};
const rowsOn = async (appId: number) => (await ctx.db.query<{
  payee_type: string; payee_id: string; matrix_cell: string | null; amount: string; paid_at: string | null;
}>(`SELECT payee_type, payee_id, matrix_cell, amount, paid_at FROM incentive_accruals
     WHERE application_id = $1 ORDER BY id`, [appId])).rows;

/** An imported investment: one NULL-cell accrual on the WRONG person. */
async function imported(name: string, phone: string, referrer: string, wrongPayeeId: number, amount: number) {
  await ctx.db.query(
    `INSERT INTO agents (agent_code, full_name, source, commission_status, is_active, commission_rate_pct)
     VALUES ($1,$2,'manual','Approved',TRUE,2) ON CONFLICT (agent_code) DO NOTHING`,
    [`AG-S${referrer.replace(/\W/g,'').slice(0,6)}`, referrer]);
  const cust = await admin.post('/api/customers', { full_name: name, phone, referred_by_text: referrer });
  const cid = Number(cust.json.id);
  const app = await admin.post('/api/applications', {
    ...requiredInvestmentFields(), customer_id: cid, series_id: seriesId, scheme_id: schemeId,
    amount: 400000, date_money_received: '2026-10-05',
  });
  await approveInvestment(checker, app);
  const appId = Number(app.json.id);
  await ctx.db.query('UPDATE applications SET referred_by_text = $1 WHERE id = $2', [referrer, appId]);
  // Wipe what the engine wrote and plant the import's row instead.
  await ctx.db.query('DELETE FROM incentive_accruals WHERE application_id = $1', [appId]);
  await ctx.db.query(
    `INSERT INTO incentive_accruals (application_id, payee_type, payee_id, matrix_cell, rate_mode, rate_value, amount, accrual_date)
     VALUES ($1,'staff',$2,NULL,'pct',2,$3,'2026-10-05')`, [appId, wrongPayeeId, amount]);
  const agentId = Number((await ctx.db.query<{ id: string }>(
    'SELECT id FROM agents WHERE lower(full_name) = lower($1) AND deleted_at IS NULL ORDER BY id LIMIT 1',
    [referrer])).rows[0]!.id);
  return { appId, appNo: String(app.json.application_no), agentId, cid };
}

describe('an unpaid row on the wrong person', () => {
  it('MOVES it when nobody else holds the investment — amount untouched', async () => {
    const { appId, appNo, agentId } = await imported('Stale One', '9849100001', 'Stale Referrer A', 2, 8000);

    const acts = await fix(appNo);
    expect(acts).toHaveLength(1);
    expect(acts[0]!.action).toBe('moved');
    expect(acts[0]!.amount).toBe(8000);
    expect(acts[0]!.should_be.id).toBe(agentId);

    const after = await rowsOn(appId);
    expect(after, 'still exactly one row — moved, not duplicated').toHaveLength(1);
    expect(after[0]!.payee_type).toBe('agent');
    expect(Number(after[0]!.payee_id)).toBe(agentId);
    expect(Number(after[0]!.amount), 'the import had the figure right').toBe(8000);
  });

  it('DELETES it when the right earner already holds a PAID row', async () => {
    const { appId, appNo, agentId } = await imported('Stale Two', '9849100002', 'Stale Referrer B', 2, 40000);
    // The correct earner's row, already paid, beside the stale one.
    await ctx.db.query(
      `INSERT INTO incentive_accruals (application_id, payee_type, payee_id, matrix_cell, rate_mode, rate_value, amount, accrual_date, paid_at)
       VALUES ($1,'agent',$2,NULL,'pct',2,40000,'2026-10-05',now())`, [appId, agentId]);
    expect(await rowsOn(appId), 'two people credited to begin with').toHaveLength(2);

    const acts = await fix(appNo);
    expect(acts).toHaveLength(1);
    expect(acts[0]!.action).toBe('deleted');
    expect(acts[0]!.alongside_paid, 'and we say so, because it is why we deleted').toBe(true);

    const after = await rowsOn(appId);
    expect(after, 'one earner left').toHaveLength(1);
    expect(Number(after[0]!.payee_id)).toBe(agentId);
    expect(after[0]!.paid_at, 'the PAID row is the survivor').not.toBeNull();
    expect(Number(after[0]!.amount)).toBe(40000);
  });

  it('leaves a PAID row on the wrong person alone — that is a decision for a person', async () => {
    const { appId, appNo } = await imported('Stale Three', '9849100003', 'Stale Referrer C', 2, 5000);
    await ctx.db.query('UPDATE incentive_accruals SET paid_at = now() WHERE application_id = $1', [appId]);

    const acts = await fix(appNo);
    expect(acts, 'nothing is done').toHaveLength(0);
    const after = await rowsOn(appId);
    expect(after).toHaveLength(1);
    expect(after[0]!.payee_type).toBe('staff');
    expect(after[0]!.paid_at).not.toBeNull();
  });

  it('does nothing when the row is already on the named referrer', async () => {
    const { appId, appNo, agentId } = await imported('Stale Four', '9849100004', 'Stale Referrer D', 2, 9000);
    await ctx.db.query(
      "UPDATE incentive_accruals SET payee_type='agent', payee_id=$2 WHERE application_id=$1", [appId, agentId]);
    expect(await fix(appNo)).toHaveLength(0);
    expect(await rowsOn(appId)).toHaveLength(1);
  });

  it('refuses without a reason for the audit row', async () => {
    const { appNo } = await imported('Stale Five', '9849100005', 'Stale Referrer E', 2, 1000);
    const { fixStaleReferrerRows } = await import('../src/modules/incentives/stale-referrer-row.js');
    await expect(ctx.db.withTx((tx) => fixStaleReferrerRows(tx, appNo, { reason: '  ' })))
      .rejects.toThrow(/reason/i);
  });

  it('writes an audit row naming both people', async () => {
    const { appId, appNo } = await imported('Stale Six', '9849100006', 'Stale Referrer F', 2, 7000);
    await fix(appNo);
    const audit = (await ctx.db.query<{ action: string; before_data: unknown; after_data: unknown }>(
      `SELECT action, before_data, after_data FROM audit_log
        WHERE action LIKE 'incentive.stale-row-%' AND entity_id = $1 ORDER BY id DESC LIMIT 1`,
      [String(appId)])).rows[0];
    expect(audit, 'an audit row exists').toBeTruthy();
    expect(JSON.stringify(audit!.after_data)).toMatch(/Stale Referrer F/);
    expect(JSON.stringify(audit!.before_data)).toMatch(/7000/);
  });
});
