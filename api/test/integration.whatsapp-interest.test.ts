/**
 * WhatsApp interest-credit notification. Settling an interest payout batch is
 * the "interest paid" moment (rows flip to Paid); it queues an approved
 * `ncd_interest_final` WhatsApp per paid customer, and the WappCloud provider
 * maps that queue template to the registered template + {{1..4}} variables.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, approveInvestment, type TestCtx } from './helpers/server.js';
import { templateFor } from '../src/integrations/notify/wappcloud.js';

let ctx: TestCtx;
let seriesId: number, schemeId: number;

beforeAll(async () => {
  ctx = await startTestServer();
  seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
  schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
});
afterAll(async () => { await ctx.close(); });

async function as(email: string, password = 'Demo_1234') {
  const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c;
}
const admin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');

/** Approved customer with one Active investment (schedule materialised). */
async function activeInvestment(name: string, phone: string, amount = 500000) {
  const a = await admin();
  const cust = await a.post('/api/customers', { full_name: name, phone, email: `${phone}@ex.com` });
  const cid = cust.json.id;
  const ncd = await as('ncd@demo.local');
  await a.post(`/api/customers/${cid}/bank-accounts`, { account_number: `88${phone}`, ifsc: 'ICIC0001234' });
  const app = await a.post('/api/applications', { customer_id: cid, series_id: seriesId, scheme_id: schemeId, amount, date_money_received: '2026-07-12' });
  await a.post(`/api/applications/${app.json.id}/mark-esigned`);
  await approveInvestment(ncd, app);
  return { customerId: cid, appId: app.json.id };
}

describe('WhatsApp interest-credit notification', () => {
  it('settling a payout batch queues ncd_interest_final for each paid customer', async () => {
    const phone = '9765400001';
    await activeInvestment('Interest Notify Cust', phone);
    const ncd = await as('ncd@demo.local');
    const a = await admin();

    // Create + settle a batch whose cut-off is after the first interest is due.
    const batch = await ncd.post('/api/payouts', { payout_date: '2026-09-28' });
    expect(batch.status).toBe(201);
    expect(batch.json.count).toBeGreaterThan(0);
    const batchId = batch.json.batch_id;
    expect((await a.post(`/api/approvals/${batch.json.request.id}/approve`)).status).toBe(200);

    // Settling does NOT send anything — the fan-out is an explicit staff action.
    const pendingAfterSettle = (await ctx.db.query(
      "SELECT count(*)::int n FROM notifications_queue WHERE channel = 'whatsapp' AND template = 'interest_paid' AND to_address = $1", [phone])).rows[0] as any;
    expect(Number(pendingAfterSettle.n)).toBe(0);

    // The staff "Notify customers" action fans out one message per paid customer.
    const notify = await a.post(`/api/payouts/${batchId}/whatsapp-interest`);
    expect(notify.status).toBe(200);
    expect(notify.json.queued).toBeGreaterThanOrEqual(1);
    expect(notify.json.sent).toBeGreaterThanOrEqual(1);

    // The customer's message carries the template's four display fields.
    const q = (await ctx.db.query(
      "SELECT to_address, payload FROM notifications_queue WHERE channel = 'whatsapp' AND template = 'interest_paid' AND to_address = $1 ORDER BY id DESC LIMIT 1",
      [phone])).rows[0] as any;
    expect(q.to_address).toBe(phone);
    expect(q.payload.name).toBe('Interest Notify Cust');
    expect(String(q.payload.amount).length).toBeGreaterThan(0);
    expect(q.payload.month).toBe('September 2026');
    expect(q.payload.date).toBe('28-Sep-2026');
  });

  it('cannot notify for a batch that is not settled yet', async () => {
    await activeInvestment('Unsettled Notify', '9765400002');
    const ncd = await as('ncd@demo.local');
    const batch = await ncd.post('/api/payouts', { payout_date: '2026-09-28' }); // created, not approved
    const r = await (await admin()).post(`/api/payouts/${batch.json.batch_id}/whatsapp-interest`);
    expect(r.status).toBe(409);
  });

  it('the WappCloud provider maps interest_paid → ncd_interest_final with {{1..4}}', () => {
    const tpl = templateFor({ template: 'interest_paid', payload: { name: 'Yasotha', amount: '6,000', month: 'September 2026', date: '28-Sep-2026' } });
    expect(tpl).toEqual({
      name: 'ncd_interest_final',
      variables: { '1': 'Yasotha', '2': '6,000', '3': 'September 2026', '4': '28-Sep-2026' },
    });
  });
});
