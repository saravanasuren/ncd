/**
 * The customers behind a series, and their bonds (owner 2026-08-28):
 *   "upon clicking on a series name ... should get me list of customers in that
 *    series and another column which says who referred them. and I need 2
 *    buttons which says download all bonds, and another button on every unique
 *    customer's name to download the individual consolidated bond ... for those
 *    who have multiple debentures in one series ... a dropdown of their
 *    individual investments."
 *
 * The shape that matters: ONE ROW PER PERSON, not per investment — a consolidated
 * bond covers everything one customer holds in a series, so a page listing
 * investments would offer the same bond three times to the same person.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx, requiredInvestmentFields } from './helpers/server.js';

let ctx: TestCtx;
let seriesId: number, schemeId: number;

beforeAll(async () => {
  ctx = await startTestServer();
  seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
  schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
});
afterAll(async () => { await ctx.close(); });

async function admin() {
  const c = new Client(ctx.base);
  await c.post('/api/auth/login', { email: 'admin@dhanam.finance', password: 'ChangeMe_Dev_123' });
  return c;
}

/** An ACTIVE investment, since only issued statuses carry a bond. */
async function invest(a: Client, customerId: number, amount = 100000) {
  const app = await a.post('/api/applications', {
    ...requiredInvestmentFields(), customer_id: customerId, series_id: seriesId, scheme_id: schemeId, amount,
  });
  expect(app.status).toBe(201);
  await ctx.db.query("UPDATE applications SET status = 'Active' WHERE id = $1", [app.json.id]);
  return Number(app.json.id);
}
async function customer(a: Client, full_name: string, phone: string, referred_by_text?: string) {
  const c = await a.post('/api/customers', { full_name, phone, ...(referred_by_text ? { referred_by_text } : {}) });
  expect(c.status, JSON.stringify(c.json)).toBe(201);
  return Number(c.json.id);
}
const list = async (a: Client) => (await a.get(`/api/allotments/series/${seriesId}/customers`)).json;

describe('the customers behind a series', () => {
  it('gives one row per PERSON, with their investments attached for the dropdown', async () => {
    const a = await admin();
    const multi = await customer(a, 'Holds Three', '9400011001');
    for (const amt of [100000, 200000, 300000]) await invest(a, multi, amt);
    const single = await customer(a, 'Holds One', '9400011002');
    await invest(a, single, 500000);

    const d = await list(a);
    const m = (d.rows as any[]).find((r) => Number(r.customer_id) === multi)!;
    const s = (d.rows as any[]).find((r) => Number(r.customer_id) === single)!;

    // Three investments, ONE row — the whole point.
    expect(m.investment_count).toBe(3);
    expect(Number(m.total_amount)).toBe(600000);
    expect(m.investments).toHaveLength(3);
    expect(m.investments[0].application_no).toBeTruthy();
    // The single-holder still carries its one investment, so the row can expand
    // uniformly even where the UI chooses not to.
    expect(s.investment_count).toBe(1);
    expect(s.investments).toHaveLength(1);
  });

  it('names who referred each customer', async () => {
    const a = await admin();
    await a.post('/api/agents', { full_name: 'Series Referrer', agent_code: 'AG-SC1' });
    const cid = await customer(a, 'Referred Holder', '9400011003', 'AG-SC1');
    await invest(a, cid);
    const row = ((await list(a)).rows as any[]).find((r) => Number(r.customer_id) === cid)!;
    // The referrer's NAME, not their code — the rule the reports already use.
    expect(row.referred_by).toBe('Series Referrer');
  });

  it('counts how many customers a bulk download would issue a NEW number to', async () => {
    const a = await admin();
    const d = await list(a);
    // Nothing has been generated yet, so every customer is un-numbered and the
    // warning must say so — this is the figure shown before the click.
    expect(d.without_bond).toBe(d.rows.length);
    expect((d.rows as any[]).every((r) => r.has_bond === false)).toBe(true);
  });

  it('excludes an investment that was never issued', async () => {
    const a = await admin();
    const cid = await customer(a, 'Never Issued', '9400011004');
    const appId = await invest(a, cid);
    await ctx.db.query("UPDATE applications SET status = 'Withdrawn' WHERE id = $1", [appId]);
    const found = ((await list(a)).rows as any[]).find((r) => Number(r.customer_id) === cid);
    // A bond cannot be produced for it, so listing the name would offer a
    // download that 404s.
    expect(found).toBeUndefined();
  });
});

describe('downloading the bonds', () => {
  it('one customer, one bond — and it issues their certificate number', async () => {
    const a = await admin();
    const cid = await customer(a, 'Bond Downloader', '9400011005');
    await invest(a, cid);

    const before = ((await list(a)).rows as any[]).find((r) => Number(r.customer_id) === cid)!;
    expect(before.has_bond).toBe(false);

    const pdf = await a.raw(`/api/reports/consolidated-bond/${cid}/${seriesId}.pdf`);
    expect(pdf.status).toBe(200);
    expect(pdf.buffer.subarray(0, 4).toString()).toBe('%PDF');

    const after = ((await list(a)).rows as any[]).find((r) => Number(r.customer_id) === cid)!;
    expect(after.has_bond).toBe(true);
    expect(String(after.bond_serial_no)).toMatch(/^CB-\d{4}-\d+$/);
  });

  it('the whole series comes back as ONE pdf covering every customer', async () => {
    const a = await admin();
    const d = await list(a);
    expect(d.rows.length).toBeGreaterThan(1);

    const pdf = await a.raw(`/api/reports/consolidated-bonds/series/${seriesId}.pdf`);
    expect(pdf.status).toBe(200);
    expect(pdf.buffer.subarray(0, 4).toString()).toBe('%PDF');
    expect(String(pdf.headers.get('content-disposition'))).toMatch(/-bonds\.pdf"$/);

    // One page per customer — the merge actually merged, rather than returning
    // the first bond and stopping.
    const pages = (pdf.buffer.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;
    expect(pages).toBeGreaterThanOrEqual(d.rows.length);
  });

  it('after a bulk download every customer in the series has a number', async () => {
    const a = await admin();
    await a.raw(`/api/reports/consolidated-bonds/series/${seriesId}.pdf`);
    const d = await list(a);
    expect(d.without_bond).toBe(0);
    expect((d.rows as any[]).every((r) => r.has_bond === true)).toBe(true);
    // ...and they are all distinct. Certificate numbers are never reused.
    const serials = (d.rows as any[]).map((r) => r.bond_serial_no);
    expect(new Set(serials).size).toBe(serials.length);
  });

  it('needs the allotment permission — it is a series-wide, number-minting action', async () => {
    const staff = new Client(ctx.base);
    await staff.post('/api/auth/login', { email: 'staff@demo.local', password: 'Demo_1234' });
    expect((await staff.raw(`/api/reports/consolidated-bonds/series/${seriesId}.pdf`)).status).toBe(403);
  });
});
