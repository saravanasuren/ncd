/** Consolidated (filing) bond — one certificate per customer + series. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
beforeAll(async () => { ctx = await startTestServer(); });
afterAll(async () => { await ctx.close(); });

const ISSUABLE = ['Active', 'Matured', 'Redeemed', 'RolledOver'];

describe('consolidated bond', () => {
  it('renders a PDF, assigns one CB- serial, and is idempotent', async () => {
    const { consolidatedBondCertificatePdf } = await import('../src/modules/reports/forms/bond.js');
    let pick = (await ctx.db.query<{ customer_id: string; series_id: string }>(
      `SELECT a.customer_id, a.series_id FROM applications a
        WHERE a.status = ANY($1::text[])
        GROUP BY a.customer_id, a.series_id ORDER BY count(*) DESC, a.customer_id LIMIT 1`, [ISSUABLE])).rows[0];
    if (!pick) {
      // Seed has no issued apps — force one (that has a line) Active so the PDF path runs.
      const any = (await ctx.db.query<{ id: string; customer_id: string; series_id: string }>(
        `SELECT a.id, a.customer_id, a.series_id FROM applications a
          WHERE EXISTS (SELECT 1 FROM application_lines al WHERE al.application_id = a.id)
          ORDER BY a.id LIMIT 1`)).rows[0];
      if (!any) { console.warn('[consolidated-bond] no applications in seed — skipping'); return; }
      await ctx.db.query(`UPDATE applications SET status = 'Active', allotment_date = COALESCE(allotment_date, now()::date) WHERE id = $1`, [any.id]);
      pick = { customer_id: any.customer_id, series_id: any.series_id };
    }
    const cid = Number(pick.customer_id), sid = Number(pick.series_id);

    const buf = await consolidatedBondCertificatePdf(ctx.db, cid, sid);
    expect(buf.length).toBeGreaterThan(1000);
    expect(buf.subarray(0, 4).toString()).toBe('%PDF');

    const row = (await ctx.db.query<{ bond_serial_no: string }>(
      'SELECT bond_serial_no FROM consolidated_bonds WHERE customer_id = $1 AND series_id = $2', [cid, sid])).rows[0];
    expect(row?.bond_serial_no).toMatch(/^CB-/);

    // regenerate → same serial, still exactly one row (idempotent)
    await consolidatedBondCertificatePdf(ctx.db, cid, sid);
    const cnt = (await ctx.db.query<{ c: number }>(
      'SELECT count(*)::int c FROM consolidated_bonds WHERE customer_id = $1 AND series_id = $2', [cid, sid])).rows[0]!.c;
    expect(cnt).toBe(1);
  });

  it('refuses when the customer has no issued investments in the series', async () => {
    const { consolidatedBondCertificatePdf } = await import('../src/modules/reports/forms/bond.js');
    await expect(consolidatedBondCertificatePdf(ctx.db, 999999, 999999)).rejects.toThrow();
  });
});
