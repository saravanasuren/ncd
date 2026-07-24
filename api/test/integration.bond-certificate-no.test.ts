/**
 * Bond certificate number. NCD had no such column, so the ported certificate
 * printed "—". It's now assigned lazily on first generation (BC-{year}-{seq}),
 * only for an investment that has actually issued.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, approveInvestment, type TestCtx, requiredInvestmentFields, uniqueName } from './helpers/server.js';

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
const serialOf = async (id: number) =>
  ((await ctx.db.query<{ bond_serial_no: string | null }>('SELECT bond_serial_no FROM applications WHERE id = $1', [id])).rows[0]!).bond_serial_no;

describe('bond certificate number', () => {
  it('is assigned on first generation and stays stable afterwards', async () => {
    const a = await admin();
    const cust = await a.post('/api/customers', { full_name: 'Bond Cert Cust', phone: '9550000001' });
    const app = await a.post('/api/applications', { ...requiredInvestmentFields(), customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId, amount: 100000, date_money_received: '2026-07-12' });
    await approveInvestment(await as('ncd@demo.local'), app); // → Active (issuable)
    const id = app.json.id;
    expect(await serialOf(id)).toBeNull();

    const { bondCertificatePdf } = await import('../src/modules/reports/forms/bond.js');
    const pdf1 = await bondCertificatePdf(ctx.db, id);
    expect(pdf1.subarray(0, 5).toString()).toBe('%PDF-');
    const first = await serialOf(id);
    expect(first).toMatch(/^BC-\d{4}-\d{6}$/);

    // Regenerating must NOT mint a second number.
    await bondCertificatePdf(ctx.db, id);
    expect(await serialOf(id)).toBe(first);
  });

  it('does not burn a number on an investment that has not issued', async () => {
    const a = await admin();
    const cust = await a.post('/api/customers', { full_name: 'Pending Bond Cust', phone: '9550000002' });
    const app = await a.post('/api/applications', { ...requiredInvestmentFields(), customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId, amount: 100000 });
    // Left PendingApproval on purpose.
    const { bondCertificatePdf } = await import('../src/modules/reports/forms/bond.js');
    await bondCertificatePdf(ctx.db, app.json.id);
    expect(await serialOf(app.json.id)).toBeNull();
  });

  it('numbers are unique across investments', async () => {
    const a = await admin();
    const { bondCertificatePdf } = await import('../src/modules/reports/forms/bond.js');
    const made: string[] = [];
    for (const phone of ['9550000003', '9550000004']) {
      const cust = await a.post('/api/customers', { full_name: uniqueName('Bond Uniq', phone), phone });
      const app = await a.post('/api/applications', { ...requiredInvestmentFields(), customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId, amount: 100000, date_money_received: '2026-07-12' });
      await approveInvestment(await as('ncd@demo.local'), app);
      await bondCertificatePdf(ctx.db, app.json.id);
      made.push((await serialOf(app.json.id))!);
    }
    expect(made[0]).not.toBe(made[1]);
    expect(new Set(made).size).toBe(2);
  });
});
