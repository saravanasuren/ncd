/**
 * One interest message per INVESTMENT, not one per customer (owner 2026-07-29:
 * "need not club every investment into one message and send. send separate
 * messages for each investment").
 *
 * Batch NEFT-2026-000131 clubbed: 159 of 384 customers got a single message
 * with their investments added together — RATHIKA's eight debentures arrived
 * as one figure of ₹33,568.37, which says nothing about any of the eight.
 *
 * The approved template is unchanged and does not name the debenture (owner
 * decided against a new one), so the split shows up in the COUNT of messages
 * and in our own records, not in the wording the customer reads.
 *
 * The dangerous half of the change is the top-up. 92 customers WERE already
 * notified for that batch by the old clubbed message, whose queue row has no
 * application_id. If that NULL is read as "this investment was never told",
 * turning the split on messages all 92 again — several times each.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx, requiredInvestmentFields, approveInvestment } from './helpers/server.js';
import { drainOnce } from '../src/modules/notifications/service.js';

let ctx: TestCtx;
let seriesId: number, schemeId: number;

beforeAll(async () => {
  ctx = await startTestServer();
  seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
  schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
});
afterAll(async () => { await ctx.close(); });

const as = async (email: string, password = 'Demo_1234') => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c; };
const admin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');

/** A customer holding `n` separate investments — RATHIKA's shape. */
async function holder(name: string, phone: string, n: number) {
  const a = await admin();
  const cust = await a.post('/api/customers', { full_name: name, phone });
  const cid = Number(cust.json.id);
  await a.post(`/api/customers/${cid}/bank-accounts`, { account_number: `77${phone}`, ifsc: 'ICIC0001234' });
  const apps: string[] = [];
  for (let i = 0; i < n; i++) {
    const app = await a.post('/api/applications', {
      ...requiredInvestmentFields(), customer_id: cid, series_id: seriesId, scheme_id: schemeId,
      amount: 500000, date_money_received: '2026-07-12', collection_reference: `UTR-${phone}-${i}`,
    });
    await approveInvestment(await as('ncd@demo.local'), app);
    apps.push(app.json.application_no);
  }
  return { cid, apps };
}

async function settledBatch(date = '2026-09-28') {
  const b = await (await as('ncd@demo.local')).post('/api/payouts', { payout_date: date });
  await (await admin()).post(`/api/approvals/${b.json.request.id}/approve`);
  return Number(b.json.batch_id);
}

const msgsFor = async (phone: string) => (await ctx.db.query(
  `SELECT payload, application_id FROM notifications_queue
    WHERE template = 'interest_paid' AND to_address = $1 ORDER BY id`, [phone])).rows as any[];

describe('a customer with several debentures', () => {
  it('gets one message per debenture, each recorded against its own investment', async () => {
    const phone = '9788000001';
    const { apps } = await holder('Five Debentures', phone, 5);
    const batchId = await settledBatch();

    const r = await (await admin()).post(`/api/payouts/${batchId}/whatsapp-interest`);
    expect(r.json.queued).toBe(5);                       // five, not one
    expect(r.json.total).toBe(5);

    const msgs = await msgsFor(phone);
    expect(msgs).toHaveLength(5);
    // The customer's text does not name the debenture (owner: no new template),
    // but every row records which one it was for — that is what makes the
    // top-up and the delivery report per-investment rather than per-customer.
    expect(msgs.map((m) => m.payload.application_no).sort()).toEqual([...apps].sort());
    for (const m of msgs) expect(m.application_id).not.toBeNull();
  });

  it('each amount is that debenture alone, not the total', async () => {
    const phone = '9788000002';
    await holder('Amount Per Debenture', phone, 3);
    const batchId = await settledBatch();
    await (await admin()).post(`/api/payouts/${batchId}/whatsapp-interest`);

    const msgs = await msgsFor(phone);
    const amounts = msgs.map((m) => Number(String(m.payload.amount).replace(/,/g, '')));
    expect(amounts).toHaveLength(3);
    const one = amounts[0]!;
    for (const a of amounts) expect(a).toBeCloseTo(one, 2);      // equal investments → equal interest
    // The clubbed behaviour would have produced a single row of 3x this.
    const total = amounts.reduce((s, a) => s + a, 0);
    expect(total).toBeCloseTo(one * 3, 2);
  });

  it('the delivery report lists every investment separately', async () => {
    const phone = '9788000003';
    const { apps } = await holder('Report Per Debenture', phone, 4);
    const batchId = await settledBatch();
    const a = await admin();
    await a.post(`/api/payouts/${batchId}/whatsapp-interest`);

    const st = (await a.get(`/api/payouts/${batchId}/whatsapp-status`)).json;
    const mine = (st.rows as any[]).filter((r) => r.full_name === 'Report Per Debenture');
    expect(mine).toHaveLength(4);
    expect(mine.map((r) => r.application_no).sort()).toEqual([...apps].sort());
    expect(st.total).toBeGreaterThanOrEqual(4);          // payments, not customers
    expect(st.customers).toBeGreaterThanOrEqual(1);
  });
});

describe('turning the split on must not re-message anyone', () => {
  it('an old CLUBBED message still counts as told for every one of that customer\'s investments', async () => {
    const phone = '9788000004';
    const { cid } = await holder('Already Told Clubbed', phone, 4);
    const batchId = await settledBatch();

    // Exactly what 28 Jul left behind: one delivered row, no application_id.
    await ctx.db.query(
      `INSERT INTO notifications_queue (channel, template, to_address, payload, status, customer_id, ref_kind, ref_id)
       VALUES ('whatsapp','interest_paid',$1,$2::jsonb,'Sent',$3,'payout_batch',$4)`,
      [phone, JSON.stringify({ name: 'Already Told Clubbed', amount: '4,000', month: 'September 2026', date: '28-Sep-2026' }), cid, batchId]);

    const r = await (await admin()).post(`/api/payouts/${batchId}/whatsapp-interest`);
    expect(r.json.queued).toBe(0);                       // nothing new
    expect(r.json.already_sent).toBe(4);                 // all four covered
    expect(await msgsFor(phone)).toHaveLength(1);        // still the single old one
  });

  it('and the report shows those investments as covered, not as gaps', async () => {
    const phone = '9788000005';
    const { cid } = await holder('Clubbed In Report', phone, 3);
    const batchId = await settledBatch();
    await ctx.db.query(
      `INSERT INTO notifications_queue (channel, template, to_address, payload, status, customer_id, ref_kind, ref_id)
       VALUES ('whatsapp','interest_paid',$1,$2::jsonb,'Sent',$3,'payout_batch',$4)`,
      [phone, JSON.stringify({ name: 'Clubbed In Report', amount: '3,000', month: 'September 2026', date: '28-Sep-2026' }), cid, batchId]);

    const st = (await (await admin()).get(`/api/payouts/${batchId}/whatsapp-status`)).json;
    const mine = (st.rows as any[]).filter((r) => r.full_name === 'Clubbed In Report');
    expect(mine).toHaveLength(3);
    for (const row of mine) {
      expect(row.state).toBe('Sent');
      expect(row.clubbed).toBe(true);                    // flagged as the older combined message
    }
  });

  it('a FAILED clubbed message is topped up per investment, one message each', async () => {
    const phone = '9788000006';
    const { cid } = await holder('Failed Clubbed', phone, 3);
    const batchId = await settledBatch();
    await ctx.db.query(
      `INSERT INTO notifications_queue (channel, template, to_address, payload, status, error, customer_id, ref_kind, ref_id)
       VALUES ('whatsapp','interest_paid',$1,$2::jsonb,'Failed','wappcloud: send failed (429)',$3,'payout_batch',$4)`,
      [phone, JSON.stringify({ name: 'Failed Clubbed', amount: '3,000', month: 'September 2026', date: '28-Sep-2026' }), cid, batchId]);

    const r = await (await admin()).post(`/api/payouts/${batchId}/whatsapp-interest`);
    expect(r.json.queued).toBe(3);                       // one per debenture
    const msgs = await msgsFor(phone);
    expect(msgs.filter((m) => m.application_id != null)).toHaveLength(3);
  });

  it('pressing Notify twice after the split still sends nothing extra', async () => {
    const phone = '9788000007';
    await holder('No Double After Split', phone, 3);
    const batchId = await settledBatch();
    const a = await admin();

    expect((await a.post(`/api/payouts/${batchId}/whatsapp-interest`)).json.queued).toBe(3);
    expect((await a.post(`/api/payouts/${batchId}/whatsapp-interest`)).json.queued).toBe(0);
    await drainOnce(ctx.db as any, 500);
    expect((await a.post(`/api/payouts/${batchId}/whatsapp-interest`)).json.queued).toBe(0);
    expect(await msgsFor(phone)).toHaveLength(3);
  });
});

describe('a retried message reports its best outcome, not its first', () => {
  /**
   * Live data from 28 Jul 2026: the first blast 429'd, the owner re-sent, and
   * most customers ended up with BOTH a Failed row and a Sent row. Reporting
   * whichever turned up first said 445 messages had failed when 362 had
   * actually been delivered — a panel that cries wolf is worse than no panel.
   */
  it('a failed attempt followed by a delivered one reads as delivered', async () => {
    const phone = '9788000008';
    const { cid } = await holder('Failed Then Sent', phone, 1);
    const batchId = await settledBatch();
    const appId = Number((await ctx.db.query(
      'SELECT id FROM applications WHERE customer_id = $1 LIMIT 1', [cid])).rows[0]!.id);

    const ins = (status: string, error: string | null) => ctx.db.query(
      `INSERT INTO notifications_queue (channel, template, to_address, payload, status, error, customer_id, application_id, ref_kind, ref_id)
       VALUES ('whatsapp','interest_paid',$1,'{}'::jsonb,$2,$3,$4,$5,'payout_batch',$6)`,
      [phone, status, error, cid, appId, batchId]);
    await ins('Failed', 'wappcloud: send failed (429): Too many requests from this IP');
    await ins('Sent', null);

    const st = (await (await admin()).get(`/api/payouts/${batchId}/whatsapp-status`)).json;
    const row = (st.rows as any[]).find((r) => r.full_name === 'Failed Then Sent');
    expect(row.state).toBe('Sent');
    expect(st.failed).toBe(0);
  });

  it('the same holds for the older combined messages', async () => {
    const phone = '9788000009';
    const { cid } = await holder('Clubbed Failed Then Sent', phone, 3);
    const batchId = await settledBatch();
    const ins = (status: string) => ctx.db.query(
      `INSERT INTO notifications_queue (channel, template, to_address, payload, status, customer_id, ref_kind, ref_id)
       VALUES ('whatsapp','interest_paid',$1,'{}'::jsonb,$2,$3,'payout_batch',$4)`,
      [phone, status, cid, batchId]);
    await ins('Failed');
    await ins('Sent');

    const st = (await (await admin()).get(`/api/payouts/${batchId}/whatsapp-status`)).json;
    const mine = (st.rows as any[]).filter((r) => r.full_name === 'Clubbed Failed Then Sent');
    expect(mine).toHaveLength(3);
    for (const r of mine) expect(r.state).toBe('Sent');
  });

  it('a failure with no successful retry still reads as failed', async () => {
    const phone = '9788000010';
    const { cid } = await holder('Only Failed', phone, 1);
    const batchId = await settledBatch();
    const appId = Number((await ctx.db.query(
      'SELECT id FROM applications WHERE customer_id = $1 LIMIT 1', [cid])).rows[0]!.id);
    await ctx.db.query(
      `INSERT INTO notifications_queue (channel, template, to_address, payload, status, error, customer_id, application_id, ref_kind, ref_id)
       VALUES ('whatsapp','interest_paid',$1,'{}'::jsonb,'Failed','wappcloud: no valid phone (got "GUN")',$2,$3,'payout_batch',$4)`,
      [phone, cid, appId, batchId]);

    const st = (await (await admin()).get(`/api/payouts/${batchId}/whatsapp-status`)).json;
    const row = (st.rows as any[]).find((r) => r.full_name === 'Only Failed');
    expect(row.state).toBe('Failed');          // a real gap must stay visible
  });
});
