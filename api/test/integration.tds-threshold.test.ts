/**
 * TDS applicability on crossing the ₹30L outstanding threshold (owner 2026-08-07).
 *
 * A not-applicable customer whose live book crosses the threshold is detected by
 * the scan, an Admin/CXO approves, and on approval: the customer flips to
 * TDS-applicable and the TDS on already-paid (untaxed) interest is written as a
 * one-time Approved Deduction that the next interest batch consumes exactly once.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
let seriesId: number;
let schemeId: number;
const admin = async () => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email: 'admin@dhanam.finance', password: 'ChangeMe_Dev_123' }); return c; };

beforeAll(async () => {
  ctx = await startTestServer();
  seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
  schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
});
afterAll(async () => { await ctx.close(); });

/** A customer with an Active investment of `amount` outstanding, TDS not
 *  applicable, and `paidInterest` of already-paid untaxed interest. */
async function setup(name: string, phone: string, pan: string | null, amount: number, paidInterest: number) {
  const a = await admin();
  const cust = await a.post('/api/customers', { full_name: name, phone, ...(pan ? { pan } : {}) });
  const id = Number(cust.json.id);
  await ctx.db.query('UPDATE customers SET tds_applicable = FALSE WHERE id = $1', [id]);
  const app = (await ctx.db.query(
    `INSERT INTO applications (application_no, customer_id, series_id, status, total_amount, enrolled_by_user_id, date_money_received)
     VALUES ('APP-TDS-' || $3, $1, $2, 'Active', $4, 1, '2026-01-15') RETURNING id`,
    [id, seriesId, phone.slice(-5), amount])).rows[0] as { id: string };
  const line = (await ctx.db.query(
    `INSERT INTO application_lines (application_id, scheme_id, coupon_rate_pct, tenure_months, amount, outstanding_amount, status)
     VALUES ($1, $2, 13, 36, $3, $3, 'Active') RETURNING id`, [Number(app.id), schemeId, amount])).rows[0] as { id: string };
  if (paidInterest > 0) {
    // Two paid, untaxed interest rows (tds_amount 0).
    await ctx.db.query(
      `INSERT INTO disbursement_schedule (line_id, application_id, due_date, due_type, gross_amount, tds_amount, net_amount, status)
       VALUES ($1,$2,'2026-02-28','Interest',$3,0,$3,'Paid'), ($1,$2,'2026-03-28','Interest',$4,0,$4,'Paid')`,
      [Number(line.id), Number(app.id), paidInterest / 2, paidInterest / 2]);
  }
  return { customerId: id, applicationId: Number(app.id) };
}

describe('TDS threshold', () => {
  it('detects a crossing, and on approval flips TDS + writes the one-time recovery', async () => {
    const a = await admin();
    // ₹35L book, ₹2L interest already paid untaxed, PAN on file → 10%.
    const { customerId, applicationId } = await setup('TDS Cross', '9847000001', 'ABCDE1234F', 3500000, 200000);

    const scan = await a.post('/api/tds/scan');
    expect(scan.status).toBe(200);
    expect(scan.json.raised).toBeGreaterThanOrEqual(1);

    const ev = (await ctx.db.query('SELECT id, tds_rate_pct, tds_to_recover, approval_request_id, status FROM tds_threshold_events WHERE customer_id = $1', [customerId])).rows[0] as any;
    expect(Number(ev.tds_rate_pct)).toBe(10);
    expect(Number(ev.tds_to_recover)).toBe(20000);       // 10% of ₹2,00,000
    expect(ev.status).toBe('PendingApproval');

    // Approve (super-admin self-approval with a reason).
    const ok = await a.post(`/api/approvals/${ev.approval_request_id}/approve`, { extra: { self_approval_reason: 'TDS threshold crossed — verified the book and the paid interest.' } });
    expect(ok.status).toBe(200);

    const cust = (await ctx.db.query('SELECT tds_applicable FROM customers WHERE id = $1', [customerId])).rows[0] as any;
    expect(cust.tds_applicable).toBe(true);

    const evAfter = (await ctx.db.query('SELECT status, payout_adjustment_id FROM tds_threshold_events WHERE id = $1', [ev.id])).rows[0] as any;
    expect(evAfter.status).toBe('Applied');

    const adj = (await ctx.db.query('SELECT kind, amount, status, application_id FROM payout_adjustments WHERE id = $1', [evAfter.payout_adjustment_id])).rows[0] as any;
    expect(adj.kind).toBe('Deduction');
    expect(Number(adj.amount)).toBe(20000);
    expect(adj.status).toBe('Approved');                  // ready — the next batch consumes it once
    expect(Number(adj.application_id)).toBe(applicationId);
  });

  it('does not re-raise once an event is open/applied (no double-charge)', async () => {
    const a = await admin();
    const rescan = await a.post('/api/tds/scan');
    // The already-Applied customer above must not produce a second event.
    const n = (await ctx.db.query("SELECT count(*)::int AS c FROM tds_threshold_events e JOIN customers cu ON cu.id = e.customer_id WHERE cu.full_name = 'TDS Cross'")).rows[0] as any;
    expect(Number(n.c)).toBe(1);
    expect(rescan.status).toBe(200);
  });

  it('uses the higher rate when there is no PAN', async () => {
    const a = await admin();
    await setup('TDS NoPan', '9847000002', null, 4000000, 100000);   // 20% of ₹1L = ₹20k
    await a.post('/api/tds/scan');
    const ev = (await ctx.db.query("SELECT tds_rate_pct, tds_to_recover FROM tds_threshold_events e JOIN customers cu ON cu.id=e.customer_id WHERE cu.full_name='TDS NoPan'")).rows[0] as any;
    expect(Number(ev.tds_rate_pct)).toBe(20);
    expect(Number(ev.tds_to_recover)).toBe(20000);
  });

  it('leaves a below-threshold customer alone', async () => {
    const a = await admin();
    await setup('TDS Under', '9847000003', 'ZYXWV9876E', 1000000, 50000);   // ₹10L < ₹30L
    await a.post('/api/tds/scan');
    const n = (await ctx.db.query("SELECT count(*)::int AS c FROM tds_threshold_events e JOIN customers cu ON cu.id=e.customer_id WHERE cu.full_name='TDS Under'")).rows[0] as any;
    expect(Number(n.c)).toBe(0);
  });
});
