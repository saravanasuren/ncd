/**
 * Two forms of ONE certificate (owner 2026-11-06: two buttons on the customer's
 * page — the subordinate debt certificate, and the same holding in the NCD /
 * Debenture form).
 *
 * The thing that must not happen is TWO CERTIFICATE NUMBERS for one holding.
 * The number belongs to the (customer, series) pair and is minted from the
 * SERIES' own standing, never from whichever button was pressed — otherwise the
 * first person to press "NCD certificate" would decide that a subordinate bond
 * wears a CB- number, and the series' own certificate would then print it too.
 * Both orderings are pinned below.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { inflateSync } from 'node:zlib';
import { startTestServer, Client, type TestCtx, requiredInvestmentFields, approveInvestment } from './helpers/server.js';

let ctx: TestCtx;
beforeAll(async () => { ctx = await startTestServer(); });
afterAll(async () => { await ctx.close(); });

const as = async (email: string, password = 'Demo_1234') => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c; };
const admin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');
const checker = () => as('ncd@demo.local');

/** Visible text of a PDFKit document (deflated streams, hex TJ arrays). */
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
      if (hex.length % 2 === 0) out.push(Buffer.from(hex, 'hex').toString('latin1'));
    }
    for (const t of body.matchAll(/\((?:\\.|[^\\()])*\)/g)) out.push(t[0].slice(1, -1).replace(/\\([()\\])/g, '$1'));
  }
  return out.join('').replace(/\s+/g, '');
}
const squash = (s: string) => s.replace(/\s+/g, '');

/** A live investment on `seriesId`, returning the customer id. */
async function invest(a: Client, name: string, phone: string, seriesId: number, amount = 500000): Promise<number> {
  const cust = await a.post('/api/customers', { full_name: name, phone });
  const cid = Number(cust.json.id);
  const scheme = (await a.get('/api/schemes')).json.rows[0];
  const create = await a.post('/api/applications', {
    ...requiredInvestmentFields(), customer_id: cid,
    series_id: seriesId, scheme_id: scheme.id, amount, date_money_received: '2026-08-05',
  });
  await approveInvestment(await checker(), create);
  await ctx.db.query(
    `UPDATE applications SET status = 'Active', allotment_date = COALESCE(allotment_date, '2026-08-20') WHERE id = $1`,
    [Number(create.json.id)]);
  return cid;
}

describe('the NCD form of a subordinate holding', () => {
  let subSeries = 0, plainSeries = 0;

  beforeAll(async () => {
    const a = await admin();
    const rows = (await a.get('/api/series')).json.rows as Array<Record<string, unknown>>;
    plainSeries = Number(rows[0]!.id);
    // A subordinate series to print both ways.
    const r = await ctx.db.query<{ id: string }>(
      `INSERT INTO series (code, name, deemed_date, is_subordinate, close_date, status)
       VALUES ('SUBTEST-1', 'Subordinate Debt Test 1', '2026-08-01', TRUE, '2026-08-31', 'Open')
       RETURNING id`);
    subSeries = Number(r.rows[0]!.id);
  });

  it('prints the subordinate form by default, and the NCD form on request', async () => {
    const { consolidatedBondCertificatePdf } = await import('../src/modules/reports/forms/bond.js');
    const cid = await invest(await admin(), 'Both Forms One', '9612000001', subSeries);

    const subPdf = await consolidatedBondCertificatePdf(ctx.db, cid, subSeries);
    const subText = pdfText(subPdf);
    expect(subText).toContain(squash('Subordinate Debt Certificate'));
    expect(subText).toContain(squash('Bond Holder'));

    const ncdPdf = await consolidatedBondCertificatePdf(ctx.db, cid, subSeries, 'debenture');
    const ncdText = pdfText(ncdPdf);
    expect(ncdText).toContain(squash('Debenture Certificate'));
    expect(ncdText).toContain(squash('NCD Holder'));
    expect(ncdText).not.toContain(squash('Subordinate Debt Certificate'));
  });

  it('gives BOTH forms the SAME certificate number, and mints only one', async () => {
    const cid = await invest(await admin(), 'Both Forms Two', '9612000002', subSeries);
    const { consolidatedBondCertificatePdf } = await import('../src/modules/reports/forms/bond.js');

    await consolidatedBondCertificatePdf(ctx.db, cid, subSeries);
    await consolidatedBondCertificatePdf(ctx.db, cid, subSeries, 'debenture');

    const rows = (await ctx.db.query<{ bond_serial_no: string }>(
      'SELECT bond_serial_no FROM consolidated_bonds WHERE customer_id = $1 AND series_id = $2', [cid, subSeries])).rows;
    expect(rows.length).toBe(1);                      // one holding, one number
    expect(rows[0]!.bond_serial_no).toMatch(/^SD-/);  // the series' own run

    // And the number actually PRINTS on both documents.
    const serial = squash(rows[0]!.bond_serial_no);
    expect(pdfText(await consolidatedBondCertificatePdf(ctx.db, cid, subSeries))).toContain(serial);
    expect(pdfText(await consolidatedBondCertificatePdf(ctx.db, cid, subSeries, 'debenture'))).toContain(serial);
  });

  it('still mints the SD- number when the NCD form is downloaded FIRST', async () => {
    // The ordering that would have broken it: minting off the requested form
    // would hand a subordinate bond a CB- number because somebody pressed the
    // other button first, and the series' own certificate would print it too.
    const cid = await invest(await admin(), 'Ncd First', '9612000003', subSeries);
    const { consolidatedBondCertificatePdf } = await import('../src/modules/reports/forms/bond.js');

    await consolidatedBondCertificatePdf(ctx.db, cid, subSeries, 'debenture');
    const row = (await ctx.db.query<{ bond_serial_no: string }>(
      'SELECT bond_serial_no FROM consolidated_bonds WHERE customer_id = $1 AND series_id = $2', [cid, subSeries])).rows[0];
    expect(row!.bond_serial_no).toMatch(/^SD-/);
  });

  it('leaves the investment record exactly as it was — no reclassification', async () => {
    const cid = await invest(await admin(), 'Unchanged Record', '9612000004', subSeries);
    const before = (await ctx.db.query<Record<string, unknown>>(
      `SELECT series_id, status, allotment_date, maturity_date, total_amount FROM applications WHERE customer_id = $1`, [cid])).rows;
    const { consolidatedBondCertificatePdf } = await import('../src/modules/reports/forms/bond.js');
    await consolidatedBondCertificatePdf(ctx.db, cid, subSeries, 'debenture');
    const after = (await ctx.db.query<Record<string, unknown>>(
      `SELECT series_id, status, allotment_date, maturity_date, total_amount FROM applications WHERE customer_id = $1`, [cid])).rows;
    expect(after).toEqual(before);
    // The series itself is untouched too.
    const s = (await ctx.db.query<{ is_subordinate: boolean }>('SELECT is_subordinate FROM series WHERE id = $1', [subSeries])).rows[0];
    expect(s!.is_subordinate).toBe(true);
  });

  it('states the NCD three-year term, off the series close date', async () => {
    // Owner 2026-11-06, on the first certificate printed from the new button:
    // "NCD is 3 years tenure, so redemption date will be 3 years from" the
    // allotment date, "not last working day" — plain calendar months.
    //
    // The holding here is the production shape: 60-month subordinated debt,
    // maturing on the series close date + 60, with applications.allotment_date
    // never stamped (the batch-allotment step has not been run for the SD
    // series, which is exactly why the NCD form printed a blank allotment row).
    const cid = await invest(await admin(), 'Three Year Term', '9612000007', subSeries);
    await ctx.db.query(
      `UPDATE applications SET allotment_date = NULL, maturity_date = '2031-08-31' WHERE customer_id = $1`, [cid]);
    await ctx.db.query(
      `UPDATE application_lines SET tenure_months = 60, maturity_date = '2031-08-31'
         WHERE application_id IN (SELECT id FROM applications WHERE customer_id = $1)`, [cid]);
    const { consolidatedBondCertificatePdf } = await import('../src/modules/reports/forms/bond.js');

    const ncd = pdfText(await consolidatedBondCertificatePdf(ctx.db, cid, subSeries, 'debenture'));
    expect(ncd).toContain(squash('31-08-2026'));       // allotment = series close date
    expect(ncd).toContain(squash('31-08-2029'));       // + 36 months, the NCD's own term
    expect(ncd).not.toContain(squash('31-08-2031'));   // never the subordinate term
    // And the row is filled, not the em-dash it printed in production.
    expect(ncd).toContain(squash('Date of Allotment31-08-2026'));

    // The subordinate form still states the term the money actually runs for.
    const sub = pdfText(await consolidatedBondCertificatePdf(ctx.db, cid, subSeries));
    expect(sub).toContain(squash('31-08-2031'));
    expect(sub).not.toContain(squash('31-08-2029'));
  });

  it('does not move the money it draws a shorter term for', async () => {
    // The three-year date is a DRAWING. The holding stays 60-month subordinated
    // debt: the line's tenure, both maturity dates and the schedule are the
    // subordinate ones before and after the NCD form is printed.
    const cid = await invest(await admin(), 'Money Unmoved', '9612000008', subSeries);
    await ctx.db.query(
      `UPDATE applications SET maturity_date = '2031-08-31' WHERE customer_id = $1`, [cid]);
    await ctx.db.query(
      `UPDATE application_lines SET tenure_months = 60, maturity_date = '2031-08-31'
         WHERE application_id IN (SELECT id FROM applications WHERE customer_id = $1)`, [cid]);
    const snap = async () => (await ctx.db.query<Record<string, unknown>>(
      `SELECT a.maturity_date, l.tenure_months, l.maturity_date AS line_maturity,
              (SELECT count(*) FROM disbursement_schedule d WHERE d.application_id = a.id) AS rows
         FROM applications a JOIN application_lines l ON l.application_id = a.id
        WHERE a.customer_id = $1 ORDER BY a.id`, [cid])).rows;

    const before = await snap();
    const { consolidatedBondCertificatePdf } = await import('../src/modules/reports/forms/bond.js');
    await consolidatedBondCertificatePdf(ctx.db, cid, subSeries, 'debenture');
    expect(await snap()).toEqual(before);
  });

  it('the Category row names the NCD series, not the monthly tranche', async () => {
    // Owner 2026-11-06: "category should show the NCD series, in vasanthamani
    // case, it should be NCD_29". SD1-SD5 are a re-filing of the NCD 29 book by
    // month of money received, so the tranche code reads as nothing to a holder.
    const ncd = await ctx.db.query<{ id: string }>(
      `INSERT INTO series (code, name, status) VALUES ('NCDTEST-29', 'NCD 29 Test', 'Closed') RETURNING id`);
    const tranche = await ctx.db.query<{ id: string }>(
      `INSERT INTO series (code, name, deemed_date, is_subordinate, close_date, status, ncd_series_id)
       VALUES ('SUBTEST-2', 'Subordinate Debt Test 2', '2026-08-01', TRUE, '2026-08-31', 'Open', $1)
       RETURNING id`, [Number(ncd.rows[0]!.id)]);
    const tid = Number(tranche.rows[0]!.id);
    const cid = await invest(await admin(), 'Category Ncd', '9612000009', tid);
    const { consolidatedBondCertificatePdf } = await import('../src/modules/reports/forms/bond.js');

    const ncdText = pdfText(await consolidatedBondCertificatePdf(ctx.db, cid, tid, 'debenture'));
    expect(ncdText).toContain(squash('Category NCDTEST-29 Series'));
    expect(ncdText).not.toContain(squash('SUBTEST-2'));

    // The subordinate form is untouched: it names the TRANCHE, by its name
    // (owner 2026-11-04), and never the NCD series.
    const subText = pdfText(await consolidatedBondCertificatePdf(ctx.db, cid, tid));
    expect(subText).toContain(squash('SUBORDINATE DEBT TEST 2'));
    expect(subText).not.toContain(squash('NCDTEST-29'));

    // A tranche with no NCD series set prints its own code, exactly as before.
    const unset = await invest(await admin(), 'Category Unset', '9612000010', subSeries);
    const unsetText = pdfText(await consolidatedBondCertificatePdf(ctx.db, unset, subSeries, 'debenture'));
    expect(unsetText).toContain(squash('Category SUBTEST-1 Series'));
  });

  it('a non-subordinate series is unaffected — both forms are the same document', async () => {
    const cid = await invest(await admin(), 'Plain Series', '9612000005', plainSeries);
    const { consolidatedBondCertificatePdf } = await import('../src/modules/reports/forms/bond.js');
    const auto = pdfText(await consolidatedBondCertificatePdf(ctx.db, cid, plainSeries));
    const ncd = pdfText(await consolidatedBondCertificatePdf(ctx.db, cid, plainSeries, 'debenture'));
    expect(auto).toContain(squash('Debenture Certificate'));
    expect(ncd).toContain(squash('Debenture Certificate'));
    // Byte for byte the same document — ?format=ncd changes nothing at all on a
    // series that was never subordinate ("dont ever touch ncd 27 or 28"), so
    // its dates keep coming off the investments, not off the series.
    expect(ncd).toBe(auto);
    const row = (await ctx.db.query<{ bond_serial_no: string }>(
      'SELECT bond_serial_no FROM consolidated_bonds WHERE customer_id = $1 AND series_id = $2', [cid, plainSeries])).rows[0];
    expect(row!.bond_serial_no).toMatch(/^CB-/);
  });

  it('the route serves both, and records which form was printed', async () => {
    const cid = await invest(await admin(), 'Route Both', '9612000006', subSeries);
    const a = await admin();
    // END TO END, through the URL the BUTTON actually uses. Asserting only
    // that bytes came back would pass even if both buttons served the same
    // document — which is the one thing worth checking here.
    const plain = await a.raw(`/api/reports/consolidated-bond/${cid}/${subSeries}.pdf`);
    expect(plain.status).toBe(200);
    expect(plain.buffer.subarray(0, 4).toString()).toBe('%PDF');
    const plainText = pdfText(plain.buffer);
    expect(plainText).toContain(squash('Subordinate Debt Certificate'));
    expect(plainText).toContain(squash('Bond Holder'));

    const ncd = await a.raw(`/api/reports/consolidated-bond/${cid}/${subSeries}.pdf?format=ncd`);
    expect(ncd.status).toBe(200);
    expect(ncd.buffer.subarray(0, 4).toString()).toBe('%PDF');
    const ncdText = pdfText(ncd.buffer);
    expect(ncdText).toContain(squash('Debenture Certificate'));
    expect(ncdText).toContain(squash('NCD Holder'));
    expect(ncdText).not.toContain(squash('Subordinate Debt Certificate'));

    // The two downloads are genuinely different documents.
    expect(ncdText).not.toBe(plainText);

    const forms = (await ctx.db.query<{ after_data: { form?: string } }>(
      `SELECT after_data FROM audit_log WHERE action = 'bond.consolidated.downloaded'
        AND (after_data->>'customer_id')::bigint = $1 ORDER BY id`, [cid])).rows.map((r) => r.after_data?.form);
    expect(forms).toEqual(['series-default', 'ncd-debenture']);
  });
});
