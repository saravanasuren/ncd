/**
 * The three things that change for a subordinate series (owner 2026-11-02):
 *   · its certificate number is SD-2026-0001, on its own counter;
 *   · it prints the series' CLOSE DATE as the Effective Date, the same for every
 *     bond in the series, not each holder's own application date;
 *   · it has no consolidated certificate — one bond per investment — and asking
 *     for one must NOT burn a CB number on the way to refusing.
 *
 * All asserted on rendered PDFs and on what actually lands in the database,
 * because the failure that matters here is silent: minting a number is
 * permanent, and a certificate number issued in error cannot be taken back.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { inflateSync } from 'node:zlib';
import { startTestServer, Client, approveInvestment, type TestCtx, requiredInvestmentFields } from './helpers/server.js';

let ctx: TestCtx;
let subSeriesId: number, plainSeriesId: number, schemeId: number;

beforeAll(async () => {
  ctx = await startTestServer();
  plainSeriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
  schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
  // A monthly subordinate series, exactly as the split creates them.
  subSeriesId = Number((await ctx.db.query(
    `INSERT INTO series (code, name, status, face_value, is_subordinate, close_date)
     VALUES ('SD3', 'Subordinate Debt 3', 'Closed', 100000, TRUE, DATE '2026-09-30') RETURNING id`)).rows[0]!.id);
  await ctx.db.query('INSERT INTO series_schemes (series_id, scheme_id) VALUES ($1, $2)', [subSeriesId, schemeId]);
});
afterAll(async () => { await ctx.close(); });

function pdfText(buf: Buffer): string {
  const raw = buf.toString('latin1');
  const out: string[] = [];
  for (const m of raw.matchAll(/stream\r?\n/g)) {
    const start = m.index! + m[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) continue;
    let body: string;
    try { body = inflateSync(Buffer.from(raw.slice(start, end), 'latin1')).toString('latin1'); } catch { continue; }
    if (!body.includes('BT')) continue;
    for (const t of body.matchAll(/<([0-9A-Fa-f\s]+)>/g)) {
      const hex = t[1]!.replace(/\s+/g, '');
      if (hex.length % 2) continue;
      out.push(Buffer.from(hex, 'hex').toString('latin1'));
    }
    for (const t of body.matchAll(/\((?:\\.|[^\\()])*\)/g)) out.push(t[0].slice(1, -1).replace(/\\([()\\])/g, '$1'));
  }
  return out.join('');
}
const squash = (s: string) => s.replace(/\s+/g, '');

async function investment(seriesId: number, name: string, phone: string, received: string) {
  const c = new Client(ctx.base);
  await c.post('/api/auth/login', { email: 'admin@dhanam.finance', password: 'ChangeMe_Dev_123' });
  const cust = await c.post('/api/customers', { full_name: name, phone });
  const app = await c.post('/api/applications', {
    ...requiredInvestmentFields(), customer_id: cust.json.id,
    series_id: seriesId, scheme_id: schemeId, amount: 500000, date_money_received: received,
  });
  const checker = new Client(ctx.base);
  await checker.post('/api/auth/login', { email: 'ncd@demo.local', password: 'Demo_1234' });
  await approveInvestment(checker, app);
  return { customerId: Number(cust.json.id), appId: Number(app.json.id) };
}

const serialOf = async (appId: number) =>
  (await ctx.db.query<{ bond_serial_no: string | null }>(
    'SELECT bond_serial_no FROM applications WHERE id = $1', [appId])).rows[0]!.bond_serial_no;

describe('a subordinate series bond', () => {
  it('is numbered SD-2026-0001 and prints the series close date as the Effective Date', async () => {
    const { appId } = await investment(subSeriesId, 'Sub Series One', '9552440001', '2026-09-17');
    const { bondCertificatePdf } = await import('../src/modules/reports/forms/bond.js');
    const text = squash(pdfText(await bondCertificatePdf(ctx.db, appId)));

    // The number, in the database and on the page.
    const serial = await serialOf(appId);
    expect(serial).toMatch(/^SD-2026-\d{4}$/);
    expect(serial).toBe('SD-2026-0001');
    expect(text).toContain(squash(serial!));

    // The date is the SERIES' close date (30-09-2026), not the day this holder's
    // money arrived (17-09-2026).
    expect(text).toContain(squash('Effective Date'));
    expect(text).toContain(squash('30-09-2026'));
    expect(text).not.toContain(squash('17-09-2026'));
    expect(text).not.toContain(squash('Date of Application'));
    expect(text).toContain(squash('Subordinate Debt Certificate'));
  });

  it('gives every bond in the series the SAME effective date but its own number', async () => {
    const a = await investment(subSeriesId, 'Sub Series Two', '9552440002', '2026-09-02');
    const b = await investment(subSeriesId, 'Sub Series Three', '9552440003', '2026-09-28');
    const { bondCertificatePdf } = await import('../src/modules/reports/forms/bond.js');
    const ta = squash(pdfText(await bondCertificatePdf(ctx.db, a.appId)));
    const tb = squash(pdfText(await bondCertificatePdf(ctx.db, b.appId)));

    for (const t of [ta, tb]) expect(t).toContain(squash('30-09-2026'));
    const [sa, sb] = [await serialOf(a.appId), await serialOf(b.appId)];
    expect(sa).not.toBe(sb);
    expect([sa, sb].every((x) => x!.startsWith('SD-2026-'))).toBe(true);
  });

  it('still numbers an ordinary series BC-, on its own untouched counter', async () => {
    const { appId } = await investment(plainSeriesId, 'Plain Series', '9552440004', '2026-09-17');
    const { bondCertificatePdf } = await import('../src/modules/reports/forms/bond.js');
    const text = squash(pdfText(await bondCertificatePdf(ctx.db, appId)));
    expect(await serialOf(appId)).toMatch(/^BC-2026-\d{6}$/);
    // ...and keeps the Debenture Certificate, with Date of Allotment, untouched.
    expect(text).toContain(squash('Debenture Certificate'));
    expect(text).toContain(squash('Date of Allotment'));
    expect(text).not.toContain(squash('Effective Date'));
  });
});

describe('a subordinate series has no consolidated certificate', () => {
  it('refuses to issue one, and burns no number doing so', async () => {
    const { customerId } = await investment(subSeriesId, 'No Consolidated', '9552440005', '2026-09-10');
    const before = Number((await ctx.db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM consolidated_bonds')).rows[0]!.n);

    const { consolidatedBondCertificatePdf } = await import('../src/modules/reports/forms/bond.js');
    await expect(consolidatedBondCertificatePdf(ctx.db, customerId, subSeriesId)).rejects.toThrow(/one bond certificate per investment/i);

    // The refusal must come BEFORE the number is allocated — otherwise every
    // rejected click would permanently consume a CB number.
    const after = Number((await ctx.db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM consolidated_bonds')).rows[0]!.n);
    expect(after).toBe(before);
  });

  it('still reprints one that was already issued', async () => {
    // 32 consolidated certificates were already issued on these series before the
    // rule changed. A customer holding one must still be able to get a copy.
    const { customerId } = await investment(subSeriesId, 'Already Issued', '9552440006', '2026-09-11');
    await ctx.db.query(
      'INSERT INTO consolidated_bonds (customer_id, series_id, bond_serial_no) VALUES ($1, $2, $3)',
      [customerId, subSeriesId, 'CB-2026-000999']);

    const { consolidatedBondCertificatePdf } = await import('../src/modules/reports/forms/bond.js');
    const text = squash(pdfText(await consolidatedBondCertificatePdf(ctx.db, customerId, subSeriesId)));
    expect(text).toContain(squash('CB-2026-000999'));
  });

  it('leaves the consolidated certificate working for an ordinary series', async () => {
    const { customerId } = await investment(plainSeriesId, 'Plain Consolidated', '9552440007', '2026-09-12');
    const { consolidatedBondCertificatePdf } = await import('../src/modules/reports/forms/bond.js');
    const text = squash(pdfText(await consolidatedBondCertificatePdf(ctx.db, customerId, plainSeriesId)));
    expect(text).toContain(squash('Debenture Certificate'));
  });
});
