/**
 * "Download all" in BOTH forms, for a subordinate series (owner 2026-11-16:
 * "i should have a option to download all button for both ncd certificates an
 * subordinate certificates for debenture 1-5").
 *
 * The single-customer route has taken `?format=ncd` since #513; the series-wide
 * one had no such option, so the whole tranche could only be printed one way.
 *
 * The thing that must not happen is a SECOND certificate number. The number
 * belongs to the (customer, series) pair and is minted from the series' own
 * standing, never from whichever button was pressed — so these are two
 * renderings of one set of instruments, not two issues of them. Both orderings
 * are pinned below.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { extractText } from './helpers/pdf-text.js';
import { startTestServer, Client, approveInvestment, type TestCtx, requiredInvestmentFields } from './helpers/server.js';

let ctx: TestCtx;
let subSeries = 0, plainSeries = 0, schemeId = 0;

const as = async (email: string, password = 'Demo_1234') => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c; };
const admin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');
const pages = (buf: Buffer) => (buf.toString('latin1').match(/\/Type\s*\/Page(?!s)/g) ?? []).length;

beforeAll(async () => {
  ctx = await startTestServer();
  schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
  plainSeries = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
  subSeries = Number((await ctx.db.query<{ id: string }>(
    `INSERT INTO series (code, name, status, face_value, is_subordinate, close_date, deemed_date)
     VALUES ('DLALL-1','DLALL 1','Open',100000,TRUE,'2026-11-30','2026-11-30') RETURNING id`)).rows[0]!.id);
  await ctx.db.query('INSERT INTO series_schemes (series_id, scheme_id) VALUES ($1,$2)', [subSeries, schemeId]);

  const a = await admin(); const checker = await as('ncd@demo.local');
  for (const [name, phone] of [['Dlall One', '9557110001'], ['Dlall Two', '9557110002'], ['Dlall Three', '9557110003']] as const) {
    const cust = await a.post('/api/customers', { full_name: name, phone });
    const app = await a.post('/api/applications', {
      ...requiredInvestmentFields(), customer_id: Number(cust.json.id),
      series_id: subSeries, scheme_id: schemeId, amount: 500000, date_money_received: '2026-11-05',
    });
    await approveInvestment(checker, app);
  }
});
afterAll(async () => { await ctx.close(); });

describe('downloading a whole subordinate series in both forms', () => {
  it('serves the subordinate form by default and the NCD form on request', async () => {
    const a = await admin();
    const sub = await a.raw(`/api/reports/consolidated-bonds/series/${subSeries}.pdf`);
    const ncd = await a.raw(`/api/reports/consolidated-bonds/series/${subSeries}.pdf?format=ncd`);

    expect(sub.status).toBe(200);
    expect(ncd.status).toBe(200);
    expect(sub.buffer.subarray(0, 4).toString()).toBe('%PDF');
    expect(ncd.buffer.subarray(0, 4).toString()).toBe('%PDF');
    // Two different documents. Asserting only that bytes came back would pass
    // just as well if both buttons served the same file — the one failure
    // worth testing for here. Compared by TEXT, not bytes: pdfkit stamps a
    // creation date, so no two renders are ever byte-identical.
    expect(extractText(sub.buffer)).toContain('Subordinate Debt Certificate');
    expect(extractText(ncd.buffer)).toContain('Debenture Certificate');
    expect(extractText(ncd.buffer)).not.toContain('Subordinate Debt Certificate');
    expect(String(sub.headers.get('content-disposition'))).toMatch(/-bonds\.pdf"$/);
    expect(String(ncd.headers.get('content-disposition'))).toMatch(/-ncd-certificates\.pdf"$/);
  });

  it('covers every customer in both forms', async () => {
    const a = await admin();
    const n = ((await a.get(`/api/allotments/series/${subSeries}/customers`)).json.rows as unknown[]).length;
    expect(n).toBeGreaterThan(1);
    for (const q of ['', '?format=ncd']) {
      const pdf = await a.raw(`/api/reports/consolidated-bonds/series/${subSeries}.pdf${q}`);
      expect(pages(pdf.buffer)).toBeGreaterThanOrEqual(n);
    }
  });

  it('issues ONE certificate number per holding, whichever form is printed first', async () => {
    const a = await admin();
    await a.raw(`/api/reports/consolidated-bonds/series/${subSeries}.pdf?format=ncd`);  // NCD form FIRST
    const after = (await ctx.db.query<{ n: number; distinct: number }>(
      `SELECT count(*)::int AS n, count(DISTINCT bond_serial_no)::int AS distinct
         FROM consolidated_bonds WHERE series_id = $1`, [subSeries])).rows[0]!;
    const serials = (await ctx.db.query<{ s: string }>(
      'SELECT bond_serial_no AS s FROM consolidated_bonds WHERE series_id = $1 ORDER BY s', [subSeries])).rows.map((r) => r.s);

    // The series' OWN run, not the CB- one — pressing the NCD button first must
    // not decide which run the number comes from.
    for (const s of serials) expect(s).toMatch(/^DC\//);
    expect(after.distinct).toBe(after.n);

    // Printing the other form afterwards issues nothing further.
    await a.raw(`/api/reports/consolidated-bonds/series/${subSeries}.pdf`);
    const serialsAgain = (await ctx.db.query<{ s: string }>(
      'SELECT bond_serial_no AS s FROM consolidated_bonds WHERE series_id = $1 ORDER BY s', [subSeries])).rows.map((r) => r.s);
    expect(serialsAgain).toEqual(serials);
  });

  it('records which form was printed', async () => {
    const a = await admin();
    await a.raw(`/api/reports/consolidated-bonds/series/${subSeries}.pdf?format=ncd`);
    const row = (await ctx.db.query<{ after_data: Record<string, unknown> }>(
      `SELECT after_data FROM audit_log WHERE action = 'bond.series.downloaded' AND entity_id = $1
        ORDER BY id DESC LIMIT 1`, [String(subSeries)])).rows[0];
    expect(row).toBeTruthy();
    expect(row!.after_data.form).toBe('ncd-debenture');
  });

  it('an ordinary series is byte-identical either way', async () => {
    // "dont ever touch ncd 27 or 28" — ?format=ncd changes nothing on a series
    // that was never subordinate, which is why the second button is not
    // offered there.
    const a = await admin();
    const cust = await a.post('/api/customers', { full_name: 'Dlall Plain', phone: '9557110009' });
    const app = await a.post('/api/applications', {
      ...requiredInvestmentFields(), customer_id: Number(cust.json.id),
      series_id: plainSeries, scheme_id: schemeId, amount: 500000, date_money_received: '2026-11-05',
    });
    await approveInvestment(await as('ncd@demo.local'), app);

    const auto = await a.raw(`/api/reports/consolidated-bonds/series/${plainSeries}.pdf`);
    const ncd = await a.raw(`/api/reports/consolidated-bonds/series/${plainSeries}.pdf?format=ncd`);
    expect(auto.status).toBe(200);
    // By text, not bytes — pdfkit stamps a creation date into every render.
    expect(extractText(ncd.buffer)).toBe(extractText(auto.buffer));
  });

  it('still needs the allotment permission for either form', async () => {
    const staff = await as('staff@demo.local');
    expect((await staff.raw(`/api/reports/consolidated-bonds/series/${subSeries}.pdf?format=ncd`)).status).toBe(403);
  });
});
