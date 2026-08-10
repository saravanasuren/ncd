/**
 * Subordinate Bonds backing a locker deposit (owner spec 2026-08-10, stage 5).
 *
 * Owner: "locker deposit can be pledge with ncd or sbu debt. either of them."
 *
 * linkDeposit already worked for a subordinate bond — it reads the applications
 * table directly and never joined series. The candidates query DID join series,
 * so a sub bond was simply never offered: the choice existed in the rules but
 * not on the screen, which is the kind of gap nobody reports as a bug because
 * the option is invisible rather than broken.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, approveInvestment, type TestCtx, requiredInvestmentFields } from './helpers/server.js';

let ctx: TestCtx;
let custId: number, seriesId: number, schemeId: number, sobId: number;

beforeAll(async () => {
  ctx = await startTestServer();
  seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
  schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
  sobId = Number((await ctx.db.query(
    `INSERT INTO sob_products (code, name, tenure_months, coupon_rate_pct)
     VALUES ('SOB-L','Sub Bond Locker', 36, 12) RETURNING id`)).rows[0]!.id);

  const a = await as('admin@dhanam.finance', 'ChangeMe_Dev_123');
  custId = (await a.post('/api/customers', { full_name: 'Locker Pledge Cust', phone: '9000004444' })).json.id;

  const ncd = await a.post('/api/applications', {
    ...requiredInvestmentFields(), customer_id: custId, series_id: seriesId, scheme_id: schemeId,
    amount: 500000, date_money_received: '2026-08-01',
  });
  await approveInvestment(await as('ncd@demo.local'), ncd);
  const sob = await a.post('/api/applications', {
    ...requiredInvestmentFields(), customer_id: custId, product_type: 'subordinate_bond',
    sob_product_id: sobId, amount: 300000, date_money_received: '2026-08-01',
  });
  await approveInvestment(await as('ncd@demo.local'), sob);
});
afterAll(async () => { await ctx.close(); });

async function as(email: string, password = 'Demo_1234') {
  const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c;
}
const admin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');
const candidates = async () =>
  (await (await admin()).get(`/api/lockers/deposit-links/candidates?customer_id=${custId}`)).json.candidates as any[];

describe('what can back a locker deposit', () => {
  it('offers BOTH the NCD and the subordinate bond', async () => {
    const rows = await candidates();
    const refs = rows.map((r) => String(r.application_no));
    expect(refs.some((x) => x.startsWith('APP-'))).toBe(true);
    expect(refs.some((x) => x.startsWith('SOB-'))).toBe(true);
  });

  it('labels which product each one is', async () => {
    // The two are priced, reported and paid differently, so a staff member
    // pledging one should know which they just picked.
    const rows = await candidates();
    const sob = rows.find((r) => String(r.application_no).startsWith('SOB-'))!;
    const ncd = rows.find((r) => String(r.application_no).startsWith('APP-'))!;
    expect(sob.product_type).toBe('subordinate_bond');
    expect(ncd.product_type).toBe('ncd');
  });

  it('identifies a sub bond by its PRODUCT where an NCD shows its series', async () => {
    // A sub bond has no series; falling back to the NCD field would print a
    // blank label beside a real amount of money.
    const rows = await candidates();
    const sob = rows.find((r) => String(r.application_no).startsWith('SOB-'))!;
    const ncd = rows.find((r) => String(r.application_no).startsWith('APP-'))!;
    expect(sob.series_code).toBe('SOB-L');
    expect(ncd.series_code).toBe('NCD DEMO');
  });

  it('reports the free-to-pledge amount for a sub bond like any other', async () => {
    const rows = await candidates();
    const sob = rows.find((r) => String(r.application_no).startsWith('SOB-'))!;
    expect(Number(sob.outstanding)).toBe(300000);
    expect(Number(sob.linked)).toBe(0);
    expect(Number(sob.free)).toBe(300000);
  });

  it('still excludes what is not live', async () => {
    // The widened join must not also start offering pending or archived
    // investments — only the series filter was meant to go.
    const pending = await (await admin()).post('/api/applications', {
      ...requiredInvestmentFields(), customer_id: custId, product_type: 'subordinate_bond',
      sob_product_id: sobId, amount: 150000, date_money_received: '2026-08-02',
    });
    const rows = await candidates();
    expect(rows.some((r) => Number(r.id) === Number(pending.json.id))).toBe(false);
  });
});
