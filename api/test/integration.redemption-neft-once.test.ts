/**
 * A redemption's NEFT instruction leaves the building ONCE.
 *
 * Owner 2026-10-16: "once i approve it i see the neft can be downloaded from
 * the redemption section - but it can be downloaded multiple times. keep it as
 * downloaded only once. only super admin will have the access to download it
 * again."
 *
 * The sheet IS the instruction to pay. A second copy of the same line is how a
 * customer gets paid twice, and nothing downstream catches it: the UTR is
 * written only after the bank confirms, so until then the row looks freshly
 * payable on every click.
 *
 * The rule is per REDEMPTION, which is why the BULK sheet is pinned here too —
 * locking only the row button would leave the same payment line one click away.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import ExcelJS from 'exceljs';
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
const superAdmin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');   // seeded super_admin

/** An Active investment, redeemed and approved — i.e. payable. Returns its redemption id. */
async function approvedRedemption(name: string, phone: string, amount = 500000): Promise<number> {
  const a = await superAdmin();
  const ncd = await as('ncd@demo.local');
  const cust = await a.post('/api/customers', { full_name: name, phone, email: `${phone}@ex.com` });
  await a.post(`/api/customers/${cust.json.id}/bank-accounts`, { account_number: `88${phone}`, ifsc: 'ICIC0001234' });
  const app = await a.post('/api/applications', {
    ...requiredInvestmentFields(), customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId,
    amount, date_money_received: '2026-07-12' });
  await a.post(`/api/applications/${app.json.id}/mark-esigned`);
  await approveInvestment(ncd, app);
  const init = await ncd.post('/api/redemptions/premature', { application_id: Number(app.json.id), reason: 'Needs funds' });
  const reqId = init.json.request?.id ?? init.json.approval_request_id;
  const cxo = await as('cxo@demo.local');
  expect((await cxo.post(`/api/approvals/${reqId}/approve`)).json.request.status).toBe('Approved');
  const list = await ncd.get('/api/redemptions');
  return Number(list.json.rows.find((r: any) => r.customer_name === name).id);
}

const rowsIn = async (buffer: Buffer) => {
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buffer);
  return wb.worksheets[0]!.rowCount - 1;   // minus the header
};

describe('a redemption NEFT sheet can be taken once', () => {
  it('lets the first download through, then refuses the second by name and date', async () => {
    const id = await approvedRedemption('Neft Once One', '9711000001');
    const ncd = await as('ncd@demo.local');

    const first = await ncd.raw(`/api/redemptions/${id}/neft.xlsx`);
    expect(first.status).toBe(200);
    expect(await rowsIn(first.buffer)).toBe(1);

    const second = await ncd.req('GET', `/api/redemptions/${id}/neft.xlsx`);
    expect(second.status).toBe(409);
    // The refusal has to be actionable: who holds the first copy, and the way back.
    expect(second.json.error.message).toMatch(/already downloaded/i);
    expect(second.json.error.message).toMatch(/Super Admin/);
  });

  it('records who took it, and shows it on the list', async () => {
    const id = await approvedRedemption('Neft Once Two', '9711000002');
    const ncd = await as('ncd@demo.local');
    expect((await ncd.raw(`/api/redemptions/${id}/neft.xlsx`)).status).toBe(200);

    const row = (await ncd.get('/api/redemptions')).json.rows.find((r: any) => Number(r.id) === id);
    expect(row.neft_downloaded_at).toBeTruthy();
    expect(row.neft_downloaded_by).toBe('Demo NCD Manager');
    expect(Number(row.neft_download_count)).toBe(1);
  });

  it('lets a Super Admin release it again, and counts the re-issue', async () => {
    const id = await approvedRedemption('Neft Once Three', '9711000003');
    const ncd = await as('ncd@demo.local');
    expect((await ncd.raw(`/api/redemptions/${id}/neft.xlsx`)).status).toBe(200);
    expect((await ncd.req('GET', `/api/redemptions/${id}/neft.xlsx`)).status).toBe(409);

    const sa = await superAdmin();
    const again = await sa.raw(`/api/redemptions/${id}/neft.xlsx`);
    expect(again.status).toBe(200);
    expect(await rowsIn(again.buffer)).toBe(1);

    const row = (await sa.get('/api/redemptions')).json.rows.find((r: any) => Number(r.id) === id);
    expect(Number(row.neft_download_count)).toBe(2);
    // The FIRST taker is kept, not overwritten by whoever re-issued it.
    expect(row.neft_downloaded_by).toBe('Demo NCD Manager');
    // A re-issue is the event worth finding after a double payment.
    const audit = (await ctx.db.query(
      "SELECT actor_id FROM audit_log WHERE action = 'redemption.neft-reissued' AND entity_id = $1", [String(id)])).rows;
    expect(audit).toHaveLength(1);
  });

  it('has no bulk sheet to fall back on', async () => {
    // Removed outright (owner: "remove that button"). The route goes with the
    // button — a link that still answers is a link someone will still use, and
    // it handed out every payable line at once.
    const ncd = await as('ncd@demo.local');
    expect((await ncd.req('GET', '/api/redemptions/neft.xlsx')).status).toBe(404);
  });

  it('an unknown id still 404s and burns nobody’s copy', async () => {
    const ncd = await as('ncd@demo.local');
    expect((await ncd.raw('/api/redemptions/999999/neft.xlsx')).status).toBe(404);
  });
});

describe('a NEFT sheet exists only while there is a payment to make', () => {
  /** Force a redemption into a terminal state the way the lifecycle would. */
  const setStatus = (id: number, status: string) =>
    ctx.db.query('UPDATE redemptions SET status = $2 WHERE id = $1', [id, status]);

  it('refuses once the redemption is Paid — for everyone, Super Admin included', async () => {
    const id = await approvedRedemption('Neft Paid One', '9711000011');
    await setStatus(id, 'Paid');

    const ncd = await as('ncd@demo.local');
    const r = await ncd.req('GET', `/api/redemptions/${id}/neft.xlsx`);
    expect(r.status).toBe(409);
    expect(r.json.error.message).toMatch(/already been paid/i);

    // The Super Admin escape hatch is for a file lost BEFORE payment. Once the
    // money has gone there is no payment left to make, so it does not apply —
    // handing out a bank instruction for a settled redemption is the hazard.
    const sa = await superAdmin();
    const asSuper = await sa.req('GET', `/api/redemptions/${id}/neft.xlsx`);
    expect(asSuper.status).toBe(409);
    expect(asSuper.json.error.message).toMatch(/already been paid/i);
  });

  it('refuses before approval, which also closes the maker/checker hole', async () => {
    // A sheet could previously be pulled for a redemption nobody had approved.
    const id = await approvedRedemption('Neft Pending One', '9711000012');
    await setStatus(id, 'Requested');
    const ncd = await as('ncd@demo.local');
    const r = await ncd.req('GET', `/api/redemptions/${id}/neft.xlsx`);
    expect(r.status).toBe(409);
    expect(r.json.error.message).toMatch(/not been approved/i);
  });

  it('refuses a rejected or cancelled redemption', async () => {
    const ncd = await as('ncd@demo.local');
    const rejected = await approvedRedemption('Neft Rejected One', '9711000013');
    await setStatus(rejected, 'Rejected');
    expect((await ncd.req('GET', `/api/redemptions/${rejected}/neft.xlsx`)).json.error.message).toMatch(/rejected/i);

    const cancelled = await approvedRedemption('Neft Cancelled One', '9711000014');
    await setStatus(cancelled, 'Cancelled');
    expect((await ncd.req('GET', `/api/redemptions/${cancelled}/neft.xlsx`)).json.error.message).toMatch(/cancelled/i);
  });

  it('still releases an Approved one — the gate is not just "always no"', async () => {
    const id = await approvedRedemption('Neft Still Works', '9711000015');
    const ncd = await as('ncd@demo.local');
    const ok = await ncd.raw(`/api/redemptions/${id}/neft.xlsx`);
    expect(ok.status).toBe(200);
    expect(await rowsIn(ok.buffer)).toBe(1);
  });
});
