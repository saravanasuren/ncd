/**
 * Transaction register (owner 2026-08-05) — every addition and deletion of
 * customers' money in one chronological list, the shape the old wealth sheet
 * had: Sl.No · Date · NCD Series · PA.NO · Name · Agent Code · Trans Type ·
 * Amount · District · DOB · Int.
 *
 * Two owner decisions this pins:
 *   1. Redemptions are NEGATIVE, so the Amount column sums to the net movement
 *      of the book. The reference sheet was inconsistent — one redemption at
 *      -2,00,000 and another at +10,00,000 on the same page.
 *   2. There is NO rollover transaction type. Six series are literally NAMED
 *      "NCD 05 Rollover" … "NCD 10 Rollover"; a redemption inside one is an
 *      ordinary redemption that happens to sit in a series with Rollover in its
 *      name. Reading it as a transaction kind would invent a concept the book
 *      does not have.
 *
 * The date window applies to a DIFFERENT column on each side of the union
 * (money-received vs redemption date), which is the thing most likely to be got
 * wrong here — filter by month and a redemption must be judged on when it was
 * redeemed, not when the money originally arrived.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, type TestCtx } from './helpers/server.js';
import { transactionRegister } from '../src/modules/reports/book.js';

let ctx: TestCtx;
let seriesId: number, rolloverSeriesId: number, custId: number, appId: number;

beforeAll(async () => {
  ctx = await startTestServer();
  seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
  rolloverSeriesId = Number((await ctx.db.query(
    `INSERT INTO series (code, name, status, opened_at, allotted_at)
     VALUES ('NCD_08_ROLLOVER','NCD 08 Rollover','Allotted','2026-01-01','2026-01-15') RETURNING id`)).rows[0]!.id);

  custId = Number((await ctx.db.query(
    `INSERT INTO customers (customer_code, full_name, phone, pan, dob, district, creation_status, is_active, referred_by_text)
     VALUES ('TXN001','Register Case One','9744000001','ABCDE1234F','1970-05-12','Coimbatore','Approved',TRUE,'Yamini ma')
     RETURNING id`)).rows[0]!.id);

  const mkApp = async (no: string, sid: number, amount: number, dmr: string, status = 'Active') =>
    Number((await ctx.db.query(
      `INSERT INTO applications (application_no, customer_id, series_id, status, total_amount, date_money_received, allotment_date)
       VALUES ($1,$2,$3,$4,$5,$6,$6) RETURNING id`, [no, custId, sid, status, amount, dmr])).rows[0]!.id);

  appId = await mkApp('APP-TXN-1', seriesId, 500000, '2026-03-10');
  await ctx.db.query(
    `INSERT INTO application_lines (application_id, amount, outstanding_amount, coupon_rate_pct, tenure_months, payout_frequency, status)
     VALUES ($1, 500000, 500000, 13.0, 36, 'Monthly', 'Active')`, [appId]);

  // A second investment, in a series NAMED "… Rollover", later redeemed.
  const rollApp = await mkApp('APP-TXN-2', rolloverSeriesId, 200000, '2026-04-01');
  await ctx.db.query(
    `INSERT INTO application_lines (application_id, amount, outstanding_amount, coupon_rate_pct, tenure_months, payout_frequency, status)
     VALUES ($1, 200000, 0, 12.5, 36, 'Monthly', 'Redeemed')`, [rollApp]);
  await ctx.db.query(
    `INSERT INTO redemptions (redemption_no, application_id, redemption_date, type, status, principal, net_payment)
     VALUES ('RED-TXN-1',$1,'2026-06-20','premature','Paid',200000,200000)`, [rollApp]);

  // Never-issued states must not appear at all.
  await mkApp('APP-TXN-REJECTED', seriesId, 900000, '2026-03-15', 'Rejected');
  await mkApp('APP-TXN-PENDING', seriesId, 800000, '2026-03-16', 'PendingApproval');
});
afterAll(async () => { await ctx.close(); });

const reg = (f = {}) => transactionRegister(ctx.db, { id: 1, role: 'super_admin', branchIds: [], agentId: null, customerId: null, permissions: [] } as any, f);

describe('what a transaction is', () => {
  it('an issue is positive and dated by when the money arrived', async () => {
    const row = (await reg()).find((r) => r.application_no === 'APP-TXN-1' && r.trans_type === 'Issue')!;
    expect(row).toBeTruthy();
    expect(row.amount).toBe(500000);
    expect(row.txn_date).toBe('2026-03-10');
  });

  it('a redemption is NEGATIVE and dated by when it was redeemed', async () => {
    const row = (await reg()).find((r) => r.trans_type === 'Redemption')!;
    expect(row.amount).toBe(-200000);
    expect(row.txn_date).toBe('2026-06-20');       // not 2026-04-01, when it was funded
  });

  it('so the Amount column totals the NET movement of the book', async () => {
    const net = (await reg()).reduce((s, r) => s + r.amount, 0);
    expect(net).toBe(500000 + 200000 - 200000);   // both issues in, one out
  });

  it('a redeemed investment KEEPS its issue row — the register is what happened', async () => {
    const rows = await reg();
    expect(rows.filter((r) => r.application_no === 'APP-TXN-2')).toHaveLength(2);
    expect(rows.filter((r) => r.application_no === 'APP-TXN-2').map((r) => r.trans_type).sort())
      .toEqual(['Issue', 'Redemption']);
  });

  it('never-issued states are absent — rejected and pending are not transactions', async () => {
    const nos = (await reg()).map((r) => r.application_no);
    expect(nos).not.toContain('APP-TXN-REJECTED');
    expect(nos).not.toContain('APP-TXN-PENDING');
  });
});

describe('a series named "… Rollover" is just a series', () => {
  it('its redemption is an ordinary Redemption, not a special type', async () => {
    const row = (await reg()).find((r) => r.series_code === 'NCD_08_ROLLOVER' && r.trans_type === 'Redemption')!;
    expect(row).toBeTruthy();
    expect(row.trans_type).toBe('Redemption');
    expect(new Set((await reg()).map((r) => r.trans_type))).toEqual(new Set(['Issue', 'Redemption']));
  });
});

describe('the columns the sheet needs', () => {
  it('carries PAN, name, agent, district, DOB and the coupon', async () => {
    const row = (await reg()).find((r) => r.application_no === 'APP-TXN-1')!;
    expect(row.pan).toBe('ABCDE1234F');
    expect(row.name).toBe('Register Case One');
    expect(row.agent_code).toBe('Yamini ma');
    expect(row.district).toBe('Coimbatore');
    expect(row.dob).toBe('1970-05-12');
    expect(Number(row.rate)).toBe(13);
  });

  it('is ordered oldest first', async () => {
    const dates = (await reg()).map((r) => r.txn_date ?? '');
    expect([...dates].sort()).toEqual(dates);
  });
});

describe('the date window', () => {
  it('judges a redemption on its redemption date, not its funding date', async () => {
    // June holds the redemption only — the investment was funded in April.
    const june = await reg({ from: '2026-06-01', to: '2026-06-30' });
    expect(june).toHaveLength(1);
    expect(june[0]!.trans_type).toBe('Redemption');

    const april = await reg({ from: '2026-04-01', to: '2026-04-30' });
    expect(april.map((r) => r.trans_type)).toEqual(['Issue']);
  });

  it('a quiet window is empty rather than falling back to everything', async () => {
    expect(await reg({ from: '2015-01-01', to: '2015-12-31' })).toHaveLength(0);
  });
});

