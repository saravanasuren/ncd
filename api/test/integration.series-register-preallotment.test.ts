/**
 * Money that left BEFORE the series was issued was never issued (owner
 * 2026-09-28, on NCD_28: "during allotment the issued amount was 4,88 cr only -
 * so the issue should come as 4.88 - only redemptions after issue should fall
 * into redemption and outstanding changes accordingly").
 *
 * The case on production: ₹3,00,000 came in on 23 Jul and was redeemed on 12
 * Aug — eight days before the series was allotted on 20 Aug — so it never
 * became part of the issue. The register counted it in BOTH columns: Issued
 * read ₹4,91,00,000 against the ₹4,88,00,000 actually allotted, and Redeemed
 * read ₹3,00,000 against nothing having been redeemed out of the issue.
 *
 * So the rule has two halves, and the second is what keeps it honest:
 *   · an investment that exited without ever being allotted leaves BOTH columns;
 *   · one that exited AFTER allotment stays in both, exactly as before.
 *
 * `allotment_date` is the marker: it is set when the allotment batch is
 * approved, and an investment keeps it after it redeems.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, approveInvestment, type TestCtx, requiredInvestmentFields } from './helpers/server.js';

let ctx: TestCtx;
let seriesId: number;
let schemeId: number;

beforeAll(async () => {
  ctx = await startTestServer();
  seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
  schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
});
afterAll(async () => { await ctx.close(); });

const as = async (email: string, password = 'Demo_1234') => {
  const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c;
};
const admin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');

/** A live investment in the demo series. */
async function invest(a: Client, name: string, phone: string, amount: number, on: string): Promise<number> {
  const cust = await a.post('/api/customers', { full_name: name, phone });
  const created = await a.post('/api/applications', {
    ...requiredInvestmentFields(), customer_id: cust.json.id, series_id: seriesId,
    scheme_id: schemeId, amount, date_money_received: on,
  });
  await approveInvestment(await as('ncd@demo.local'), created);
  return Number(created.json.id);
}

/** Mark an investment exited. `allottedOn` null = it never reached allotment. */
async function exited(id: number, allottedOn: string | null, redeemedOn: string) {
  await ctx.db.query(
    `UPDATE applications SET status = 'Redeemed', allotment_date = $2, redemption_date = $3 WHERE id = $1`,
    [id, allottedOn, redeemedOn]);
  await ctx.db.query('UPDATE application_lines SET outstanding_amount = 0 WHERE application_id = $1', [id]);
}

const register = async (a: Client) => {
  const r = await a.get('/api/reports/segments/series');
  expect(r.status).toBe(200);
  return (r.json.groups as any[]).find((g) => g.key === 'NCD DEMO');
};

describe('series register — an investment that left before allotment was never issued', () => {
  it('keeps it out of Issued AND out of Redeemed, and Outstanding still reconciles', async () => {
    const a = await admin();

    // Allotted and still live — this is the issue.
    const kept = await invest(a, 'Register Allotted', '9878000001', 1000000, '2026-07-18');
    await ctx.db.query("UPDATE applications SET allotment_date = '2026-08-20' WHERE id = $1", [kept]);

    // In on 23 Jul, out on 12 Aug — before the 20 Aug allotment. Never allotted.
    const gone = await invest(a, 'Register Pre-allotment Exit', '9878000002', 300000, '2026-07-23');
    await exited(gone, null, '2026-08-12');

    const g = await register(a);
    // ₹10L issued — NOT ₹13L. The ₹3L never became part of the issue…
    expect(Number(g.issued)).toBe(1000000);
    // …and it is not a redemption out of the issue either.
    expect(Number(g.redeemed)).toBe(0);
    expect(Number(g.outstanding)).toBe(1000000);
    // The invariant the register is read by.
    expect(Number(g.issued)).toBe(Number(g.outstanding) + Number(g.redeemed));
  });

  it('CONTROL: an investment redeemed AFTER allotment stays in both columns', async () => {
    // The half that must not loosen — otherwise "issued" would quietly shrink
    // every time an investor exits, and the series would look smaller than it
    // was raised.
    const a = await admin();
    const later = await invest(a, 'Register Post-allotment Exit', '9878000003', 500000, '2026-07-25');
    await exited(later, '2026-08-20', '2026-09-15');

    const g = await register(a);
    expect(Number(g.issued)).toBe(1500000);        // 10L live + 5L redeemed after issue
    expect(Number(g.redeemed)).toBe(500000);
    expect(Number(g.outstanding)).toBe(1000000);
    expect(Number(g.issued)).toBe(Number(g.outstanding) + Number(g.redeemed));
  });
});
