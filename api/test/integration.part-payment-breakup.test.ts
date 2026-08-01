/**
 * Payment breakup on a clubbed investment (owner 2026-08-01): "the breakup
 * should be shown properly so that I know in the future that a customer has
 * paid this in parts."
 *
 * The investment stays ONE ₹1,00,000 NCD — that is not in question here. What
 * is, is whether the app can still tell you HOW it was paid a year later.
 * Before this, the payment detail lived only on the application: one date, one
 * reference, one receipt for the whole thing. Clubbing a second credit also
 * OVERWROTE the first credit's receipt, so the paper trail for money already
 * banked was destroyed.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx, requiredInvestmentFields, uniqueName } from './helpers/server.js';

let ctx: TestCtx;
const login = async (email: string, password = 'Demo_1234') => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c; };
const admin = () => login('admin@dhanam.finance', 'ChangeMe_Dev_123');
const seriesId = () => ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'").then((r: any) => Number(r.rows[0].id));
const schemeId = () => ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'").then((r: any) => Number(r.rows[0].id));

beforeAll(async () => { ctx = await startTestServer(); });
afterAll(async () => { await ctx.close(); });

async function customer(staff: Client, phone: string) {
  const c = await staff.post('/api/customers', { full_name: uniqueName('Breakup Cust', phone), phone });
  return Number(c.json.id);
}

/** Two credits, different days and references, clubbed into one ₹1L NCD. */
async function twoPartInvestment(staff: Client, phone: string) {
  const cid = await customer(staff, phone);
  const sid = await seriesId();
  const schId = await schemeId();
  const first = await staff.post('/api/applications', {
    ...requiredInvestmentFields(), customer_id: cid, series_id: sid, scheme_id: schId, amount: 50000,
    date_money_received: '2026-08-01', collection_method: 'NEFT/RTGS', collection_reference: 'FIRST-111',
    receipt: { filename: 'first.pdf', mime: 'application/pdf', data_base64: Buffer.from('%PDF-1.4 first-half').toString('base64') },
  });
  const appId = Number(first.json.id);
  await staff.post('/api/applications', {
    ...requiredInvestmentFields(), customer_id: cid, series_id: sid, scheme_id: schId, amount: 50000,
    club_with_application_id: appId,
    date_money_received: '2026-08-05', collection_method: 'Cheque', collection_reference: 'SECOND-222',
    receipt: { filename: 'second.pdf', mime: 'application/pdf', data_base64: Buffer.from('%PDF-1.4 second-half').toString('base64') },
  });
  return { appId, requestId: first.json.subscription_request.id };
}

describe('payment breakup', () => {
  it('keeps each credit\'s own date, method and reference', async () => {
    const staff = await admin();
    const { appId } = await twoPartInvestment(staff, '9897000001');

    const detail = await staff.get(`/api/applications/${appId}`);
    const lines = detail.json.lines.sort((x: any, y: any) => Number(x.id) - Number(y.id));
    expect(lines).toHaveLength(2);

    expect(String(lines[0].date_money_received).slice(0, 10)).toBe('2026-08-01');
    expect(lines[0].collection_method).toBe('NEFT/RTGS');
    expect(lines[0].collection_reference).toBe('FIRST-111');
    expect(Number(lines[0].amount)).toBe(50000);

    expect(String(lines[1].date_money_received).slice(0, 10)).toBe('2026-08-05');
    expect(lines[1].collection_method).toBe('Cheque');
    expect(lines[1].collection_reference).toBe('SECOND-222');
    expect(Number(lines[1].amount)).toBe(50000);

    // …and it is still ONE ₹1,00,000 investment.
    expect(Number(detail.json.application.total_amount)).toBe(100000);
  });

  it('the FIRST credit\'s receipt survives clubbing — it used to be overwritten', async () => {
    const staff = await admin();
    const { appId } = await twoPartInvestment(staff, '9897000002');
    const lines = (await staff.get(`/api/applications/${appId}`)).json.lines
      .sort((x: any, y: any) => Number(x.id) - Number(y.id));

    // A PDF body is bytes, so fetch directly with the session cookie — the
    // JSON-parsing helper cannot represent it (see Client.cookieHeader).
    const fetchReceipt = async (lineId: number) => {
      const r = await fetch(`${ctx.base}/api/applications/${appId}/lines/${lineId}/receipt`,
        { headers: { Cookie: staff.cookieHeader(), 'X-Requested-With': 'dhanam' } });
      return { status: r.status, body: await r.text() };
    };
    const one = await fetchReceipt(Number(lines[0].id));
    const two = await fetchReceipt(Number(lines[1].id));
    expect(one.status).toBe(200);
    expect(two.status).toBe(200);
    // Distinct bytes — proof the second did not replace the first.
    expect(one.body).toContain('first-half');
    expect(two.body).toContain('second-half');
  });

  it('a line receipt cannot be fetched through another application', async () => {
    const staff = await admin();
    const mine = await twoPartInvestment(staff, '9897000003');
    const other = await twoPartInvestment(staff, '9897000004');
    const otherLineId = (await staff.get(`/api/applications/${other.appId}`)).json.lines[0].id;
    // Right line id, wrong application — must 404, not serve someone else's paper.
    expect((await staff.get(`/api/applications/${mine.appId}/lines/${otherLineId}/receipt`)).status).toBe(404);
  });

  it('a single-credit investment still records its own detail on the line', async () => {
    const staff = await admin();
    const cid = await customer(staff, '9897000005');
    const r = await staff.post('/api/applications', {
      ...requiredInvestmentFields(), customer_id: cid, series_id: await seriesId(), scheme_id: await schemeId(),
      amount: 200000, date_money_received: '2026-08-02', collection_method: 'NEFT/RTGS', collection_reference: 'SOLO-999',
    });
    const lines = (await staff.get(`/api/applications/${Number(r.json.id)}`)).json.lines;
    expect(lines).toHaveLength(1);
    expect(lines[0].collection_reference).toBe('SOLO-999');
    expect(String(lines[0].date_money_received).slice(0, 10)).toBe('2026-08-02');
  });

  it('the breakup survives approval — it is a record, not a draft', async () => {
    const staff = await admin();
    const ncd = await login('ncd@demo.local');
    const { appId, requestId } = await twoPartInvestment(staff, '9897000006');

    expect((await ncd.post(`/api/approvals/${requestId}/approve`)).status).toBe(200);

    const detail = await staff.get(`/api/applications/${appId}`);
    expect(detail.json.application.status).toBe('Active');
    const refs = detail.json.lines.map((l: any) => l.collection_reference).sort();
    expect(refs).toEqual(['FIRST-111', 'SECOND-222']);
  });
});
