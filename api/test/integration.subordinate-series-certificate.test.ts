/**
 * The bond a subordinate series issues: ONE per customer per series.
 *
 * Owner 2026-11-03: "consolidate at the Customer ID plus Series level, keep
 * transactions recorded separately in the background, and generate only one bond
 * document per series." Three investments of 5 lakh in the same series are one
 * bond for 15 lakh, not three bonds.
 *
 * This can state one coupon rate and one redemption date truthfully only because
 * the series makes it so: no customer's own investments inside a series disagree
 * on rate or term, and since migration 108 every investment in a series matures
 * on the series close date + tenure. Both are asserted here rather than assumed.
 *
 * The per-investment certificate is therefore NOT issued for such a series —
 * except as a reprint of one already handed out under the older rule.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { inflateSync } from 'node:zlib';
import { startTestServer, Client, approveInvestment, type TestCtx, requiredInvestmentFields } from './helpers/server.js';

let ctx: TestCtx;
let subSeriesId: number, plainSeriesId: number, schemeId: number;
let admin: Client, checker: Client;

const CLOSE = '2026-09-30';

beforeAll(async () => {
  ctx = await startTestServer();
  plainSeriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
  schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
  // The subordinate series run 60 months; the demo scheme defaults to 36.
  await ctx.db.query("UPDATE schemes SET tenure_months = 60, name = '13% - 60 Months - Monthly' WHERE id = $1", [schemeId]);
  subSeriesId = Number((await ctx.db.query(
    `INSERT INTO series (code, name, status, face_value, is_subordinate, close_date, deemed_date)
     VALUES ('SD3', 'Subordinate Debt 3', 'Open', 100000, TRUE, DATE '${CLOSE}', DATE '${CLOSE}') RETURNING id`)).rows[0]!.id);
  await ctx.db.query('INSERT INTO series_schemes (series_id, scheme_id) VALUES ($1, $2)', [subSeriesId, schemeId]);
  admin = new Client(ctx.base);
  await admin.post('/api/auth/login', { email: 'admin@dhanam.finance', password: 'ChangeMe_Dev_123' });
  checker = new Client(ctx.base);
  await checker.post('/api/auth/login', { email: 'ncd@demo.local', password: 'Demo_1234' });
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
const caps = (s: string) => squash(s).toUpperCase();

/** A customer with `amounts.length` separate investments in one series. */
async function holding(seriesId: number, name: string, phone: string, tranches: Array<[string, number]>) {
  const cust = await admin.post('/api/customers', { full_name: name, phone });
  const customerId = Number(cust.json.id);
  const appIds: number[] = [];
  for (const [received, amount] of tranches) {
    const app = await admin.post('/api/applications', {
      ...requiredInvestmentFields(), customer_id: customerId,
      series_id: seriesId, scheme_id: schemeId, amount, date_money_received: received,
    });
    await approveInvestment(checker, app);
    appIds.push(Number(app.json.id));
  }
  return { customerId, appIds };
}

describe('one bond per customer per series', () => {
  it('three investments of 5 lakh become ONE bond for 15 lakh', async () => {
    // The owner's own example.
    const { customerId } = await holding(subSeriesId, 'Three Tranches', '9552110001',
      [['2026-09-02', 500000], ['2026-09-15', 500000], ['2026-09-28', 500000]]);

    const { consolidatedBondCertificatePdf } = await import('../src/modules/reports/forms/bond.js');
    const text = squash(pdfText(await consolidatedBondCertificatePdf(ctx.db, customerId, subSeriesId)));

    expect(text).toContain(squash('Rs. 15,00,000'));
    expect(text).toContain(squash('Subordinate Debt Certificate'));
    // 15 bonds of Rs 1,00,000, not 3 documents.
    expect(text).toContain(squash('Number of Bonds'));

    // Exactly ONE certificate row exists for this customer in this series.
    const n = Number((await ctx.db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM consolidated_bonds WHERE customer_id = $1 AND series_id = $2',
      [customerId, subSeriesId])).rows[0]!.n);
    expect(n).toBe(1);
  });

  it('is numbered SD-2026-0001, not CB-', async () => {
    const { customerId } = await holding(subSeriesId, 'Numbered Sub', '9552110002', [['2026-09-10', 400000]]);
    const { consolidatedBondCertificatePdf } = await import('../src/modules/reports/forms/bond.js');
    await consolidatedBondCertificatePdf(ctx.db, customerId, subSeriesId);
    const serial = String((await ctx.db.query<{ s: string }>(
      'SELECT bond_serial_no AS s FROM consolidated_bonds WHERE customer_id = $1 AND series_id = $2',
      [customerId, subSeriesId])).rows[0]!.s);
    expect(serial).toMatch(/^SD-2026-\d{4}$/);
    expect(serial).not.toMatch(/^CB-/);
  });

  it('states ONE effective date and ONE redemption date for the whole holding', async () => {
    // Only possible because every investment in the series matures on the series
    // close date + tenure. Without that these rows would read "As per breakup
    // below" and point at a table that is not on the page.
    const { customerId } = await holding(subSeriesId, 'One Date', '9552110003',
      [['2026-09-03', 300000], ['2026-09-29', 700000]]);
    const { consolidatedBondCertificatePdf } = await import('../src/modules/reports/forms/bond.js');
    const text = squash(pdfText(await consolidatedBondCertificatePdf(ctx.db, customerId, subSeriesId)));

    expect(text).toContain(squash('Effective Date'));
    expect(text).toContain(squash('30-09-2026'));
    expect(text).toContain(squash('30-09-2031'));
    expect(text.toUpperCase()).not.toContain(caps('As per breakup below'));
    expect(text).toContain(squash('Rs. 10,00,000'));
  });

  it('prints the scheme NAME, not a dash', async () => {
    // This shipped broken once: scheme_name was computed inside the query's
    // LATERAL join but never listed in the OUTER select, so it never reached the
    // renderer and the row printed "—" on a live certificate. Asserting the
    // query is not enough — only the rendered page shows it.
    const { customerId } = await holding(subSeriesId, 'Scheme Printed', '9552110008', [['2026-09-14', 500000]]);
    const { consolidatedBondCertificatePdf } = await import('../src/modules/reports/forms/bond.js');
    const text = squash(pdfText(await consolidatedBondCertificatePdf(ctx.db, customerId, subSeriesId)));
    expect(text).toContain(squash('Scheme'));
    expect(text).toContain(caps('13% - 60 Months - Monthly'));
    // The label and a dash in the same cell is exactly what the bug looked like.
    expect(text).not.toContain(squash('Scheme—'));
  });

  it('keeps each investment recorded separately underneath', async () => {
    // "keep transactions recorded separately in the background" — merging the
    // DOCUMENT must not merge the money.
    const { customerId, appIds } = await holding(subSeriesId, 'Still Separate', '9552110004',
      [['2026-09-05', 200000], ['2026-09-20', 300000]]);
    expect(appIds.length).toBe(2);
    const rows = (await ctx.db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM applications WHERE customer_id = $1 AND series_id = $2',
      [customerId, subSeriesId])).rows[0]!.n;
    expect(Number(rows)).toBe(2);
  });
});

describe('the per-investment certificate is not issued for such a series', () => {
  it('refuses, and points at the bond that replaces it', async () => {
    const { appIds } = await holding(subSeriesId, 'No Per Investment', '9552110005', [['2026-09-08', 500000]]);
    const { bondCertificatePdf } = await import('../src/modules/reports/forms/bond.js');
    await expect(bondCertificatePdf(ctx.db, appIds[0]!)).rejects.toThrow(/one bond covering all/i);

    // ...and refusing must not have minted a number on the way.
    const serial = (await ctx.db.query<{ s: string | null }>(
      'SELECT bond_serial_no AS s FROM applications WHERE id = $1', [appIds[0]])).rows[0]!.s;
    expect(serial).toBeNull();
  });

  it('still reprints one issued under the older rule', async () => {
    // 8 investments were given their own BC- numbers before the rule changed. A
    // reprint of a document a customer holds has to keep working.
    const { appIds } = await holding(subSeriesId, 'Already Printed', '9552110006', [['2026-09-09', 500000]]);
    await ctx.db.query("UPDATE applications SET bond_serial_no = 'BC-2026-000017' WHERE id = $1", [appIds[0]]);
    const { bondCertificatePdf } = await import('../src/modules/reports/forms/bond.js');
    const text = squash(pdfText(await bondCertificatePdf(ctx.db, appIds[0]!)));
    expect(text).toContain(squash('BC-2026-000017'));
  });

  it('leaves an ordinary series issuing per-investment bonds as before', async () => {
    const { appIds } = await holding(plainSeriesId, 'Plain Per Investment', '9552110007', [['2026-09-11', 500000]]);
    const { bondCertificatePdf } = await import('../src/modules/reports/forms/bond.js');
    const text = squash(pdfText(await bondCertificatePdf(ctx.db, appIds[0]!)));
    expect(text).toContain(squash('Debenture Certificate'));
    const serial = (await ctx.db.query<{ s: string }>(
      'SELECT bond_serial_no AS s FROM applications WHERE id = $1', [appIds[0]])).rows[0]!.s;
    expect(serial).toMatch(/^BC-2026-\d{6}$/);
  });
});

/** Pages in a rendered PDF. pdfkit writes one `/Type /Page` object per page and
 *  a single `/Type /Pages` tree, which the negative lookahead excludes. */
function pageCount(buf: Buffer): number {
  return (buf.toString('latin1').match(/\/Type\s*\/Page(?!s)/g) || []).length;
}

describe('what the bond names, and how it spells money', () => {
  it('names the series, directly under the certificate number', async () => {
    // The SD- number does not say which tranche the bond belongs to — those run
    // in one sequence across every subordinate series — so the certificate said
    // nothing about it at all (owner 2026-11-04).
    const { customerId } = await holding(subSeriesId, 'Series Named', '9552110009', [['2026-09-18', 500000]]);
    const { consolidatedBondCertificatePdf } = await import('../src/modules/reports/forms/bond.js');
    const text = squash(pdfText(await consolidatedBondCertificatePdf(ctx.db, customerId, subSeriesId)));

    // The NAME, in the capitals the subordinate form prints its details in.
    expect(text).toContain('Series' + caps('Subordinate Debt 3'));
    // Between the certificate number and the holder, not appended at the end.
    expect(text.indexOf('CertificateNo')).toBeGreaterThanOrEqual(0);
    expect(text.indexOf('Series' + caps('Subordinate Debt 3')))
      .toBeGreaterThan(text.indexOf('CertificateNo'));
    expect(text.indexOf('Series' + caps('Subordinate Debt 3')))
      .toBeLessThan(text.indexOf(squash('Name of Bond Holder')));
  });

  it('spells the rupee prefix Rs., not RS.', async () => {
    // The subordinate form prints its filled-in details in capitals, which
    // turned _fmtINR's "Rs." into "RS." on every money row while the same
    // abbreviation on the pill and in the legal paragraph stayed "Rs.".
    const { customerId } = await holding(subSeriesId, 'Rupee Spelling', '9552110010', [['2026-09-19', 700000]]);
    const { consolidatedBondCertificatePdf } = await import('../src/modules/reports/forms/bond.js');
    const text = squash(pdfText(await consolidatedBondCertificatePdf(ctx.db, customerId, subSeriesId)));

    expect(text).toContain(squash('Rs. 7,00,000'));   // investment + redemption value
    expect(text).toContain(squash('Rs. 1,00,000'));   // face value per bond
    expect(text).not.toContain(squash('RS. 7,00,000'));
    // No money row anywhere on the page carries the shouted form.
    expect(text).not.toMatch(/RS\.\d/);
  });

  it('still prints on a single page with the extra row', async () => {
    // Thirteen rows instead of twelve. A long address is the case with the
    // least room left — its row grows to fit.
    const cust = await admin.post('/api/customers', {
      full_name: 'Long Address Holder', phone: '9552110011',
      address: 'DOOR NO 136-A, OTTANTHOTTAM, ENNAMANGALAM, SECOND STREET EXTENSION',
      city: 'BHAVANI', district: 'ERODE', state: 'TAMIL NADU', pincode: '638501',
    });
    const customerId = Number(cust.json.id);
    const app = await admin.post('/api/applications', {
      ...requiredInvestmentFields(), customer_id: customerId, series_id: subSeriesId,
      scheme_id: schemeId, amount: 1500000, date_money_received: '2026-09-21',
    });
    await approveInvestment(checker, app);

    const { consolidatedBondCertificatePdf } = await import('../src/modules/reports/forms/bond.js');
    const buf = await consolidatedBondCertificatePdf(ctx.db, customerId, subSeriesId);
    expect(pageCount(buf)).toBe(1);
    expect(squash(pdfText(buf))).toContain('Series' + caps('Subordinate Debt 3'));
  });

  it('carries the series on a reprint of a per-investment bond too', async () => {
    const { appIds } = await holding(subSeriesId, 'Reprint Series', '9552110012', [['2026-09-22', 500000]]);
    await ctx.db.query("UPDATE applications SET bond_serial_no = 'BC-2026-000018' WHERE id = $1", [appIds[0]]);
    const { bondCertificatePdf } = await import('../src/modules/reports/forms/bond.js');
    const buf = await bondCertificatePdf(ctx.db, appIds[0]!);
    const text = squash(pdfText(buf));
    expect(text).toContain('Series' + caps('Subordinate Debt 3'));
    expect(text).toContain(squash('Rs. 5,00,000'));
    expect(text).not.toMatch(/RS\.\d/);
    expect(pageCount(buf)).toBe(1);
  });

  it('leaves the Debenture Certificate exactly as it was', async () => {
    // Neither change touches the form NCD 27/28 print on: no Series row (it has
    // carried Category all along) and its values were never capitalised, so its
    // "Rs." was always correct.
    const { appIds } = await holding(plainSeriesId, 'Untouched Debenture', '9552110013', [['2026-09-23', 500000]]);
    const { bondCertificatePdf } = await import('../src/modules/reports/forms/bond.js');
    const buf = await bondCertificatePdf(ctx.db, appIds[0]!);
    const text = squash(pdfText(buf));
    expect(text).toContain(squash('Debenture Certificate'));
    expect(text).toContain(squash('Category'));
    expect(text).toContain(squash('Date of Allotment'));
    expect(text).toContain(squash('Rs. 5,00,000'));
    // The Series row is the subordinate form's; "...Series" here is Category's
    // own value, which is why this checks for the label-plus-value run.
    expect(text).not.toContain('Series' + caps('NCD DEMO'));
    expect(pageCount(buf)).toBe(1);
  });
});
