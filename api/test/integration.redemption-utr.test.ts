/**
 * The reason a redemption was asked for, and the bank reference once it is paid.
 *
 * Owner 2026-10-16: "i should be able to see the reson for redeemetion when i
 * click on the customers redeemetion" and "only when i enter the utr number
 * for the transaction. so get me that field also."
 *
 * The reason was captured at request time and shown nowhere. The UTR column
 * has existed since migration 003 and NOTHING has ever written to it — 1 of 88
 * settled redemptions carries one, and that arrived with the wealth import.
 *
 * Asked and answered the same day: recording a UTR does NOT move the status.
 * Anyone who handles redemptions may enter one; only a Super Admin may change
 * one already on file.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, approveInvestment, type TestCtx, requiredInvestmentFields } from './helpers/server.js';

let ctx: TestCtx;
let seriesId: number, schemeId: number;

beforeAll(async () => {
  ctx = await startTestServer();
  seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
  schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
});
afterAll(async () => { await ctx.close(); });

const as = async (email: string, password = 'Demo_1234') => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c; };
const superAdmin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');

async function approvedRedemption(name: string, phone: string, reason: string): Promise<number> {
  const a = await superAdmin();
  const ncd = await as('ncd@demo.local');
  const cust = await a.post('/api/customers', { full_name: name, phone, email: `${phone}@ex.com` });
  await a.post(`/api/customers/${cust.json.id}/bank-accounts`, { account_number: `88${phone}`, ifsc: 'ICIC0001234' });
  const app = await a.post('/api/applications', {
    ...requiredInvestmentFields(), customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId,
    amount: 500000, date_money_received: '2026-07-12' });
  await a.post(`/api/applications/${app.json.id}/mark-esigned`);
  await approveInvestment(ncd, app);
  const init = await ncd.post('/api/redemptions/premature', { application_id: Number(app.json.id), reason });
  const reqId = init.json.request?.id ?? init.json.approval_request_id;
  await (await as('cxo@demo.local')).post(`/api/approvals/${reqId}/approve`);
  return Number((await ncd.get('/api/redemptions')).json.rows.find((r: any) => r.customer_name === name).id);
}
const rowOf = async (c: Client, id: number) =>
  (await c.get('/api/redemptions')).json.rows.find((r: any) => Number(r.id) === id);

describe('the reason reaches the screen', () => {
  it('carries the reason the customer gave', async () => {
    const id = await approvedRedemption('Utr Reason One', '9712000001', 'Daughter’s wedding in December');
    const r = await rowOf(await as('ncd@demo.local'), id);
    expect(r.reason).toBe('Daughter’s wedding in December');
    // …along with what the panel shows beside it.
    expect(r.application_no).toBeTruthy();
    expect(Number(r.broken_interest)).toBeGreaterThanOrEqual(0);
    expect(r.created_by).toBeTruthy();
  });
});

describe('recording the bank reference', () => {
  it('staff can record one, and it does NOT move the status', async () => {
    const id = await approvedRedemption('Utr Save One', '9712000002', 'Medical');
    const ncd = await as('ncd@demo.local');
    expect((await ncd.post(`/api/redemptions/${id}/utr`, { utr: 'sbin226291938401' })).status).toBe(200);

    const r = await rowOf(ncd, id);
    expect(r.utr).toBe('SBIN226291938401');          // normalised to upper case
    expect(r.utr_entered_by).toBe('Demo NCD Manager');
    expect(r.status).toBe('Approved');                // the owner's choice: records only
  });

  it('refuses a change by anyone but a Super Admin', async () => {
    const id = await approvedRedemption('Utr Lock One', '9712000003', 'Medical');
    const ncd = await as('ncd@demo.local');
    await ncd.post(`/api/redemptions/${id}/utr`, { utr: 'FIRSTREF0001' });

    const second = await ncd.post(`/api/redemptions/${id}/utr`, { utr: 'SECONDREF0002' });
    expect(second.status).toBe(409);
    expect(second.json.error.message).toMatch(/Super Admin/);
    expect((await rowOf(ncd, id)).utr).toBe('FIRSTREF0001');   // unchanged

    const sa = await superAdmin();
    expect((await sa.post(`/api/redemptions/${id}/utr`, { utr: 'SECONDREF0002' })).status).toBe(200);
    expect((await rowOf(sa, id)).utr).toBe('SECONDREF0002');
    // The correction keeps the replaced value, which is the point of auditing it.
    const audit = (await ctx.db.query(
      "SELECT before_data FROM audit_log WHERE action = 'redemption.utr-corrected' AND entity_id = $1", [String(id)])).rows;
    expect(audit).toHaveLength(1);
    expect((audit[0] as any).before_data.utr).toBe('FIRSTREF0001');
  });

  it('re-entering the SAME reference is not treated as a change', async () => {
    // Otherwise a double-click from the person who entered it would 409 at them.
    const id = await approvedRedemption('Utr Same One', '9712000004', 'Medical');
    const ncd = await as('ncd@demo.local');
    await ncd.post(`/api/redemptions/${id}/utr`, { utr: 'SAMEREF00001' });
    const again = await ncd.post(`/api/redemptions/${id}/utr`, { utr: 'sameref00001' });
    expect(again.status).toBe(200);
    expect(again.json.unchanged).toBe(true);
  });

  it('rejects something that is not a reference', async () => {
    const id = await approvedRedemption('Utr Bad One', '9712000005', 'Medical');
    const ncd = await as('ncd@demo.local');
    expect((await ncd.post(`/api/redemptions/${id}/utr`, { utr: 'abc' })).status).toBe(400);
    expect((await ncd.post(`/api/redemptions/${id}/utr`, { utr: 'has spaces in it' })).status).toBe(400);
    expect((await rowOf(ncd, id)).utr).toBeNull();
  });

  it('leaves the NEFT rules alone — a recorded UTR does not unlock a second copy', async () => {
    const id = await approvedRedemption('Utr Neft One', '9712000006', 'Medical');
    const ncd = await as('ncd@demo.local');
    expect((await ncd.raw(`/api/redemptions/${id}/neft.xlsx`)).status).toBe(200);
    await ncd.post(`/api/redemptions/${id}/utr`, { utr: 'NEFTREF00001' });
    expect((await ncd.req('GET', `/api/redemptions/${id}/neft.xlsx`)).status).toBe(409);
  });
});
