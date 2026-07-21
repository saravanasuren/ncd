/**
 * Dashboard redemptions, series-filtered (owner rule 2026-07-21): when a series
 * is picked the tile splits into two readings —
 *   • window   : money redeemed DURING that series' active window (open → allotment,
 *                or → today if not yet allotted). Ignores which series was redeemed.
 *   • ofSeries : redemptions that BELONG to that series (by ownership), any date.
 * Seeds series + redemptions directly so it is independent of the redemption HTTP flow.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
beforeAll(async () => { ctx = await startTestServer(); });
afterAll(async () => { await ctx.close(); });

async function admin() {
  const c = new Client(ctx.base);
  await c.post('/api/auth/login', { email: 'admin@dhanam.finance', password: 'ChangeMe_Dev_123' });
  return c;
}

describe('dashboard redemptions — series window vs ownership', () => {
  let seriesA: number, seriesB: number;

  beforeAll(async () => {
    const db = ctx.db;
    // Series A: live 2026-06-01 → allotted 2026-07-15. Series B: live earlier, allotted later.
    seriesA = Number((await db.query(
      "INSERT INTO series (code, name, status, opened_at, allotted_at) VALUES ('NCD-RWA','Redemption Window A','Closed','2026-06-01','2026-07-15') RETURNING id")).rows[0]!.id);
    seriesB = Number((await db.query(
      "INSERT INTO series (code, name, status, opened_at, allotted_at) VALUES ('NCD-RWB','Redemption Window B','Closed','2026-05-01','2026-08-20') RETURNING id")).rows[0]!.id);
    const cust = Number((await db.query(
      "INSERT INTO customers (customer_code, full_name, phone, creation_status, is_active) VALUES ('RWIN01','Redeemer','9333300000','Approved',TRUE) RETURNING id")).rows[0]!.id);
    const mkApp = async (no: string, sid: number) => Number((await db.query(
      "INSERT INTO applications (application_no, customer_id, series_id, status, total_amount) VALUES ($1,$2,$3,'Redeemed',1000000) RETURNING id", [no, cust, sid])).rows[0]!.id);
    const appA = await mkApp('APP-RWA', seriesA);
    const appB = await mkApp('APP-RWB', seriesB);
    const mkRed = async (no: string, appId: number, date: string, net: number) => db.query(
      "INSERT INTO redemptions (redemption_no, application_id, type, principal, net_payment, redemption_date, status) VALUES ($1,$2,'maturity',$3,$3,$4,'Paid')", [no, appId, net, date]);
    // Of series A, inside A's window (Jun 1–Jul 15):
    await mkRed('RED-A-IN', appA, '2026-06-20', 100000);
    // Of series B, but dated INSIDE A's window → counts for A's WINDOW, not A's ownership:
    await mkRed('RED-B-IN', appB, '2026-07-01', 200000);
    // Of series A, but dated OUTSIDE A's window (after allotment) → counts for A's OWNERSHIP, not A's window:
    await mkRed('RED-A-OUT', appA, '2026-08-05', 50000);
  });

  it('window reading = everything redeemed during the series window (any series)', async () => {
    const a = await admin();
    const ov = await a.get(`/api/dashboard/overview?series=${seriesA}`);
    // Window = Jun 1 → Jul 15: RED-A-IN (100k) + RED-B-IN (200k) = 300k. RED-A-OUT (Aug 5) excluded.
    expect(Number(ov.json.flow.redemptions_total)).toBe(300000);
    expect(ov.json.flow.redemptions_count).toBe(2);
    expect(ov.json.flow.redemptions_window).toEqual({ from: '2026-06-01', to: '2026-07-15' });
  });

  it('ownership reading = redemptions of the selected series (any date)', async () => {
    const a = await admin();
    const ov = await a.get(`/api/dashboard/overview?series=${seriesA}`);
    // Of series A: RED-A-IN (100k) + RED-A-OUT (50k) = 150k. RED-B-IN excluded (belongs to B).
    expect(Number(ov.json.flow.redemptions_of_series_total)).toBe(150000);
    expect(ov.json.flow.redemptions_of_series_count).toBe(2);
  });

  it('the drills mirror the tiles', async () => {
    const a = await admin();
    const win = await a.get(`/api/dashboard/drill/redemptions?series=${seriesA}`);
    expect(win.json.rows.map((r: any) => r.customer_name).length).toBe(2);
    expect(win.json.rows.reduce((s: number, r: any) => s + Number(r.net_payment), 0)).toBe(300000);
    const own = await a.get(`/api/dashboard/drill/redemptions-of-series?series=${seriesA}`);
    expect(own.json.rows.reduce((s: number, r: any) => s + Number(r.net_payment), 0)).toBe(150000);
  });

  it('with no series selected the ownership reading is null (single tile)', async () => {
    const a = await admin();
    const ov = await a.get('/api/dashboard/overview');
    expect(ov.json.flow.redemptions_window).toBeNull();
    expect(ov.json.flow.redemptions_of_series_total).toBeNull();
  });
});
