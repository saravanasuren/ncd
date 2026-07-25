/**
 * Repair for LEGACY partially-redeemed lines whose schedule was never scaled to
 * the reduced principal (redeemed before #93 shipped the scaling on 2026-07-22).
 *
 * We reproduce that exact state — outstanding_amount reduced, but the unpaid
 * Interest and maturity Redemption rows still on the FULL principal — and assert
 * the repair rewrites those rows to the outstanding principal while leaving Paid
 * rows, batched rows and the redemption's BrokenInterest slice untouched. The
 * repair writes ABSOLUTE target values, so a second run is a no-op (idempotent)
 * and an already-half-repaired line lands correct rather than double-shrunk.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, approveInvestment, type TestCtx, requiredInvestmentFields } from './helpers/server.js';
import { planLineRepairs, applyLineRepairs } from '../src/scripts/repair-partial-redemption-schedule.js';

let ctx: TestCtx;
let appId: number, lineId: number, paidGrossBefore: number;
const as = async (email: string, password = 'Demo_1234') => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c; };
const admin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');

beforeAll(async () => {
  ctx = await startTestServer();
  const seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
  const schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
  const a = await admin();
  const cust = await a.post('/api/customers', { full_name: 'Legacy Partial Investor', phone: '9600000091' });
  await a.post(`/api/customers/${cust.json.id}/bank-accounts`, { account_number: '66660000091', ifsc: 'ICIC0001234' });
  const app = await a.post('/api/applications', {
    ...requiredInvestmentFields(), customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId,
    amount: 1500000, date_money_received: '2026-07-12',
  });
  await approveInvestment(await as('ncd@demo.local'), app);
  appId = Number(app.json.id);
  lineId = Number((await ctx.db.query('SELECT id FROM application_lines WHERE application_id=$1', [appId])).rows[0]!.id);

  // Reproduce the LEGACY state directly: ₹10L of the ₹15L was redeemed leaving
  // ₹5L, but the schedule was NOT scaled — outstanding is 5L while every unpaid
  // Interest and the maturity Redemption row still reflect 15L. Also mark the
  // earliest interest row Paid and add a BrokenInterest slice, to prove the
  // repair leaves both alone.
  await ctx.db.query("UPDATE application_lines SET outstanding_amount = 500000 WHERE id=$1", [lineId]);
  await ctx.db.query(
    `UPDATE disbursement_schedule SET status='Paid'
      WHERE id = (SELECT id FROM disbursement_schedule WHERE line_id=$1 AND due_type='Interest' ORDER BY due_date LIMIT 1)`, [lineId]);
  // Capture the paid row's gross NOW (still on the full 15L) so the untouched
  // assertion is exact — the first interest month is a partial period, so its
  // amount isn't a round ₹15,000 to hard-code.
  paidGrossBefore = Number((await ctx.db.query<{ gross_amount: string }>(
    "SELECT gross_amount FROM disbursement_schedule WHERE line_id=$1 AND status='Paid' ORDER BY due_date LIMIT 1", [lineId])).rows[0]!.gross_amount);
  await ctx.db.query(
    `INSERT INTO disbursement_schedule (line_id, application_id, due_date, due_type, gross_amount, tds_amount, net_amount, status, principal_basis)
     VALUES ($1,$2,'2026-07-16','BrokenInterest',5917.81,0,5917.81,'Scheduled',1000000)`, [lineId, appId]);
});
afterAll(async () => { await ctx.close(); });

const grossOn = (principal: number) => principal * 0.12 / 365; // per-day @ 12%, Actual365

describe('repair un-scaled legacy partial redemptions', () => {
  it('plans changes only for the over-stated unpaid rows', async () => {
    const plans = await planLineRepairs(ctx.db, undefined);
    const mine = plans.find((p) => p.line_id === lineId);
    expect(mine).toBeTruthy();
    expect(mine!.outstanding).toBe(500000);
    // Every planned change reduces the gross (over-statement removed), and the
    // maturity Redemption row is among them (15L → 5L principal).
    expect(mine!.changes.every((c) => c.to_gross < c.from_gross)).toBe(true);
    const maturity = mine!.changes.find((c) => c.due_type === 'Redemption');
    expect(maturity).toBeTruthy();
    expect(maturity!.to_gross).toBe(500000);
  });

  it('after commit, unpaid interest is on ₹5L and the maturity returns ₹5L', async () => {
    await applyLineRepairs(ctx.db, undefined);
    // A representative full-month interest row now reflects 5L, not 15L.
    const row = (await ctx.db.query<{ gross_amount: string; due_date: string }>(
      `SELECT gross_amount, due_date::text FROM disbursement_schedule
        WHERE line_id=$1 AND due_type='Interest' AND status='Scheduled'
        ORDER BY due_date DESC LIMIT 1`, [lineId])).rows[0]!;
    // ~5L @12% for a 30/31-day month — decisively nearer 5L's monthly interest
    // than 15L's (≈₹14,800). Loose bound keeps the test day-count-agnostic.
    expect(Number(row.gross_amount)).toBeLessThan(grossOn(500000) * 32);
    expect(Number(row.gross_amount)).toBeGreaterThan(grossOn(500000) * 27);

    const maturity = (await ctx.db.query<{ gross_amount: string }>(
      "SELECT gross_amount FROM disbursement_schedule WHERE line_id=$1 AND due_type='Redemption' AND status='Scheduled'", [lineId])).rows[0]!;
    expect(Number(maturity.gross_amount)).toBe(500000);
  });

  it('leaves the Paid row and the BrokenInterest slice untouched', async () => {
    const paid = (await ctx.db.query<{ gross_amount: string }>(
      "SELECT gross_amount FROM disbursement_schedule WHERE line_id=$1 AND status='Paid' ORDER BY due_date LIMIT 1", [lineId])).rows[0]!;
    // Exactly what it was before the repair — a Paid row is never rewritten.
    expect(Number(paid.gross_amount)).toBe(paidGrossBefore);

    const slice = (await ctx.db.query<{ gross_amount: string; principal_basis: string }>(
      "SELECT gross_amount, principal_basis FROM disbursement_schedule WHERE line_id=$1 AND due_type='BrokenInterest'", [lineId])).rows[0]!;
    expect(Number(slice.gross_amount)).toBe(5917.81);
    expect(Number(slice.principal_basis)).toBe(1000000);
  });

  it('is idempotent — a second run finds nothing left to change', async () => {
    const plans = await planLineRepairs(ctx.db, undefined);
    expect(plans.find((p) => p.line_id === lineId)).toBeFalsy();
  });
});
