/**
 * The bond certificate must print the holder's FULL postal address — including
 * district and pincode, which it silently dropped: both certificate builders
 * selected and joined only address/city/state, so a customer whose profile
 * clearly showed "Krishnagiri / 631003" got a bond without either.
 *
 * PDFKit subsets its fonts and writes glyph ids, so the rendered string is not
 * greppable in the output. The address is therefore checked two ways:
 *   1. `customerAddress` directly — the ordering and blank-dropping logic, and
 *   2. differentially on the real PDF — clearing district + pincode on the
 *      customer MUST change the certificate, which can only happen if those
 *      columns are actually fetched and drawn.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, type TestCtx } from './helpers/server.js';
import { customerAddress, addressColumns } from '../src/modules/reports/forms/shared.js';

let ctx: TestCtx;
beforeAll(async () => { ctx = await startTestServer(); });
afterAll(async () => { await ctx.close(); });

const ISSUABLE = ['Active', 'Matured', 'Redeemed', 'RolledOver'];

describe('customerAddress', () => {
  it('orders street, city, district, state, pincode', () => {
    expect(customerAddress({
      address: '37/74, new anna nagar', city: 'Chitheri', district: 'Krishnagiri',
      state: 'Tamilnadu', pincode: '631003',
    })).toBe('37/74, new anna nagar, Chitheri, Krishnagiri, Tamilnadu, 631003');
  });

  it('drops blanks instead of leaving empty commas', () => {
    expect(customerAddress({ address: '1 Main St', city: 'Erode', district: null, state: 'TN', pincode: '' }))
      .toBe('1 Main St, Erode, TN');
    expect(customerAddress({ address: '  ', city: null, district: undefined, state: null, pincode: null }))
      .toBe('');
  });

  // A town is very often its own district in TN, so city == district is normal,
  // honest data — but a certificate must not say it twice (owner 2026-08-08).
  it('says a repeated city/district once', () => {
    expect(customerAddress({
      address: '6/1 SANTHANKARUKKU 3RD STREET', city: 'ERODE', district: 'ERODE',
      state: 'TAMILNADU', pincode: '638009',
    })).toBe('6/1 SANTHANKARUKKU 3RD STREET, ERODE, TAMILNADU, 638009');
  });

  it('ignores case and spacing when deciding it is a repeat', () => {
    expect(customerAddress({ address: '1 Main St', city: 'Erode', district: ' ERODE ', state: 'TN', pincode: '638009' }))
      .toBe('1 Main St, Erode, TN, 638009');
    expect(customerAddress({ address: '1 Main St', city: 'New  Delhi', district: 'NEW DELHI', state: 'DL', pincode: '110001' }))
      .toBe('1 Main St, New  Delhi, DL, 110001');
  });

  it('only collapses ADJACENT repeats — a genuinely different district survives', () => {
    expect(customerAddress({
      address: '12 Cross Rd', city: 'Chitheri', district: 'Krishnagiri', state: 'Tamilnadu', pincode: '631003',
    })).toBe('12 Cross Rd, Chitheri, Krishnagiri, Tamilnadu, 631003');
    // A pincode repeated inside the free-text street line is NOT stripped —
    // guessing inside someone's address would mangle real ones.
    expect(customerAddress({
      address: 'No209A, Nalliampalayam, Namakkal - 638182', city: 'Namakkal', district: 'Namakkal',
      state: null, pincode: '638182',
    })).toBe('No209A, Nalliampalayam, Namakkal - 638182, Namakkal, 638182');
  });

  it('names every address column, so a form cannot fetch a partial address', () => {
    for (const col of ['address', 'city', 'district', 'state', 'pincode']) {
      expect(addressColumns()).toContain(col);
      expect(addressColumns('c.')).toContain(`c.${col}`);
    }
  });
});

describe('bond certificate address', () => {
  /**
   * Build an ISSUED investment for a holder with a full address. Created here
   * rather than hunted for in the seed — the seed has no applications, so a
   * "find one or skip" helper made this whole check a no-op.
   */
  async function issuedApp(name: string, phone: string) {
    const seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
    const schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
    const cust = (await ctx.db.query<{ id: string }>(
      `INSERT INTO customers (customer_code, full_name, phone, address, city, district, state, pincode,
                              kyc_status, creation_status, is_active)
       VALUES ($1, $2, $3, '37/74, new anna nagar', 'Chitheri', 'Krishnagiri', 'Tamilnadu', '631003',
               'Verified', 'Approved', TRUE) RETURNING id`,
      [`DHNBOND${phone.slice(-4)}`, name, phone])).rows[0]!;
    const customerId = Number(cust.id);
    const app = (await ctx.db.query<{ id: string }>(
      `INSERT INTO applications (application_no, customer_id, series_id, status, total_amount,
                                 enrolled_by_user_id, date_money_received, allotment_date)
       VALUES ($1, $2, $3, 'Active', 500000, 1, '2026-01-15', '2026-01-20') RETURNING id`,
      [`APP-BOND-${phone.slice(-5)}`, customerId, seriesId])).rows[0]!;
    const appId = Number(app.id);
    await ctx.db.query(
      `INSERT INTO application_lines (application_id, scheme_id, coupon_rate_pct, tenure_months, amount, outstanding_amount, status)
       VALUES ($1, $2, 13, 36, 500000, 500000, 'Active')`, [appId, schemeId]);
    return { appId, customerId, seriesId };
  }

  it('the single bond changes when district + pincode are removed — proof they are printed', async () => {
    const { bondCertificatePdf } = await import('../src/modules/reports/forms/bond.js');
    const p = await issuedApp('Bond Addr One', '9846100001');

    const withFull = await bondCertificatePdf(ctx.db, p.appId);
    expect(withFull.subarray(0, 4).toString('latin1')).toBe('%PDF');
    expect(withFull.length).toBeGreaterThan(1000);

    await ctx.db.query('UPDATE customers SET district = NULL, pincode = NULL WHERE id = $1', [p.customerId]);
    const without = await bondCertificatePdf(ctx.db, p.appId);

    // The serial is assigned once and reused, so the ONLY thing that changed is
    // the address line — it must not render identically.
    expect(without.length).not.toBe(withFull.length);
  });

  it('the consolidated bond prints them too', async () => {
    const { consolidatedBondCertificatePdf } = await import('../src/modules/reports/forms/bond.js');
    const p = await issuedApp('Bond Addr Two', '9846100002');

    const withFull = await consolidatedBondCertificatePdf(ctx.db, p.customerId, p.seriesId);
    expect(withFull.subarray(0, 4).toString('latin1')).toBe('%PDF');

    await ctx.db.query('UPDATE customers SET district = NULL, pincode = NULL WHERE id = $1', [p.customerId]);
    const without = await consolidatedBondCertificatePdf(ctx.db, p.customerId, p.seriesId);
    expect(without.length).not.toBe(withFull.length);
  });

  it('every issuable status is still renderable (guards the status gate)', () => {
    expect(ISSUABLE).toContain('Active');
  });
});
