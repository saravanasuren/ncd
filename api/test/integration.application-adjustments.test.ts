/**
 * A one-off deduction must be visible on the investment it was taken from
 * (owner 2026-08-20: "in the customers investment application i should be able
 * to see this detection").
 *
 * These were recorded and approved all along — but only the Payouts page ever
 * showed them. On 2026-07-28 three payouts went out Rs 7,231 short of
 * gross-minus-TDS, and the investment page gave no reason at all; it read as an
 * underpayment until someone went digging in payout_adjustments. Anyone
 * answering the customer needs the answer on the page they are already looking
 * at.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
let appId: number;

beforeAll(async () => {
  ctx = await startTestServer();
  const seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
  const cid = Number((await ctx.db.query(
    `INSERT INTO customers (customer_code, full_name, phone, creation_status, is_active)
     VALUES ('ADJ001','Adjust Case','9766000001','Approved',TRUE) RETURNING id`)).rows[0]!.id);
  appId = Number((await ctx.db.query(
    `INSERT INTO applications (application_no, customer_id, series_id, status, total_amount, date_money_received)
     VALUES ('APP-ADJ-1',$1,$2,'Active',500000,'2026-07-01') RETURNING id`, [cid, seriesId])).rows[0]!.id);
});
afterAll(async () => { await ctx.close(); });

async function admin() {
  const c = new Client(ctx.base);
  await c.post('/api/auth/login', { email: 'admin@dhanam.finance', password: 'ChangeMe_Dev_123' });
  return c;
}
const detail = async () => (await (await admin()).get(`/api/applications/${appId}`)).json;

describe('adjustments on the investment', () => {
  it('an investment with none reports an empty list, not a missing field', async () => {
    const d = await detail();
    expect(Array.isArray(d.adjustments)).toBe(true);
    expect(d.adjustments).toHaveLength(0);
  });

  it('a deduction shows with its amount and, crucially, its reason', async () => {
    await ctx.db.query(
      `INSERT INTO payout_adjustments (application_id, kind, amount, narration, status, created_by_user_id)
       VALUES ($1,'Deduction',6038,'TDS recovered — newer investment in NCD 27','Consumed',1)`, [appId]);

    const d = await detail();
    expect(d.adjustments).toHaveLength(1);
    const a = d.adjustments[0];
    expect(a.kind).toBe('Deduction');
    expect(Number(a.amount)).toBe(6038);
    // The reason is the whole point — an amount with no explanation is what
    // made this look like an underpayment in the first place.
    expect(a.narration).toMatch(/TDS recovered/);
    expect(a.status).toBe('Consumed');
    expect(a.created_by).toBeTruthy();
  });

  it('an addition is reported too, not just deductions', async () => {
    await ctx.db.query(
      `INSERT INTO payout_adjustments (application_id, kind, amount, narration, status, created_by_user_id)
       VALUES ($1,'Addition',250,'Goodwill top-up','Pending',1)`, [appId]);
    const d = await detail();
    const kinds = d.adjustments.map((x: any) => x.kind).sort();
    expect(kinds).toEqual(['Addition', 'Deduction']);
  });

  it('another investment does not pick up this one\'s adjustments', async () => {
    const seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
    const cid = Number((await ctx.db.query(
      `INSERT INTO customers (customer_code, full_name, phone, creation_status, is_active)
       VALUES ('ADJ002','Other Case','9766000002','Approved',TRUE) RETURNING id`)).rows[0]!.id);
    const otherId = Number((await ctx.db.query(
      `INSERT INTO applications (application_no, customer_id, series_id, status, total_amount, date_money_received)
       VALUES ('APP-ADJ-2',$1,$2,'Active',100000,'2026-07-01') RETURNING id`, [cid, seriesId])).rows[0]!.id);
    const d = (await (await admin()).get(`/api/applications/${otherId}`)).json;
    expect(d.adjustments).toHaveLength(0);
  });
});
