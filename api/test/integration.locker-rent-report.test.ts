/**
 * Locker rent report (owner 2026-08-22) — every NCD locker as paid / waived /
 * premium. Category is NCD's own (locker_fee_waivers); the locker + live rent
 * leg come from LockerHub. Pins the categorisation: premium beats a 100%
 * discretionary waiver beats paid, and the STANDARD partial GST waiver stays
 * "paid" (the customer still pays the base).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';
import { config } from '../src/config.js';

let ctx: TestCtx;
let mock: Server;
let adminId: number;

const APPS: Record<string, any> = {
  la_rr_premium: { application_no: 'APP-RR-1', locker_size: 'Large', branch_id: 'br1', allotment: { locker_number: 'L-1' }, name: 'Prem Cust', phone: '9800000001', legs: { rent: { amount: 20000, settled: true } } },
  la_rr_waived:  { application_no: 'APP-RR-2', locker_size: 'Medium', branch_id: 'br1', allotment: { locker_number: 'L-2' }, name: 'Waive Cust', phone: '9800000002', legs: { rent: { amount: 7000, settled: true } } },
  la_rr_paid:    { application_no: 'APP-RR-3', locker_size: 'Large', branch_id: 'br1', allotment: { locker_number: 'L-3' }, name: 'Pay Cust', phone: '9800000003', legs: { rent: { amount: 20000, settled: true } } },
  // A tenant who simply paid online: no fee waiver, no NCD-backed deposit
  // pledge, no cheque — nothing in any of the three NCD-side tables. Only the
  // LockerHub roster (below) knows this tenancy exists at all.
  la_rr_clean_online: { application_no: 'APP-RR-4', locker_size: 'Extra Large', branch_id: 'br1', allotment: { locker_number: 'L-4' }, name: 'Sathya', phone: '9363456687', legs: { rent: { amount: 20000, settled: true } } },
  // Same shape, but the leg is genuinely NOT settled — must show unpaid, not
  // be swept in as "paid" just for having a roster entry.
  la_rr_clean_unpaid: { application_no: 'APP-RR-5', locker_size: 'Large', branch_id: 'br1', allotment: { locker_number: 'L-5' }, name: 'Owes Rent', phone: '9800000005', legs: { rent: { amount: 20000, settled: false } } },
};

beforeAll(async () => {
  ctx = await startTestServer();
  adminId = Number((await ctx.db.query("SELECT id FROM users WHERE email='admin@dhanam.finance'")).rows[0]!.id);
  mock = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const send = (code: number, obj: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (/\/branches$/.test(url.pathname)) return send(200, { branches: [{ id: 'br1', name: 'Dindigul' }] });
    if (/\/locker-tenants$/.test(url.pathname)) {
      return send(200, { tenants: [
        { tenant_id: 't-clean-online', application_id: 'la_rr_clean_online' },
        { tenant_id: 't-clean-unpaid', application_id: 'la_rr_clean_unpaid' },
      ] });
    }
    const m = url.pathname.match(/\/locker-applications\/([^/]+)$/);
    if (m) { const a = APPS[decodeURIComponent(m[1]!)]; return a ? send(200, a) : send(404, {}); }
    return send(404, {});
  });
  await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r));
  const addr = mock.address();
  config.LOCKERHUB_API_URL = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;

  // premium rent waiver
  await ctx.db.query(
    `INSERT INTO locker_fee_waivers (lockerhub_application_id, leg, waiver_pct, category, reason, status, created_by_user_id, approved_by_user_id)
     VALUES ('la_rr_premium','rent',100,'premium','Premium customer','Approved',$1,$1)`, [adminId]);
  // a 100% discretionary waiver
  await ctx.db.query(
    `INSERT INTO locker_fee_waivers (lockerhub_application_id, leg, waiver_pct, category, reason, status, created_by_user_id, approved_by_user_id)
     VALUES ('la_rr_waived','rent',100,'waiver','Goodwill','Approved',$1,$1)`, [adminId]);
  // the standard PARTIAL GST waiver — customer still pays the base → stays "paid"
  await ctx.db.query(
    `INSERT INTO locker_fee_waivers (lockerhub_application_id, leg, waiver_amount, category, reason, status, created_by_user_id, approved_by_user_id)
     VALUES ('la_rr_paid','rent',3050,'waiver','Standard GST waiver','Approved',$1,$1)`, [adminId]);
});
afterAll(async () => { config.LOCKERHUB_API_URL = ''; await new Promise<void>((r) => mock.close(() => r())); await ctx.close(); });

const admin = async () => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email: 'admin@dhanam.finance', password: 'ChangeMe_Dev_123' }); return c; };

describe('locker rent report', () => {
  it('categorises premium / waived / paid correctly', async () => {
    const r = await (await admin()).get('/api/lockers/rent-report');
    expect(r.status).toBe(200);
    const by = new Map(r.json.rows.map((x: any) => [x.lockerhub_application_id, x]));
    expect((by.get('la_rr_premium') as any).rent_status).toBe('premium');
    expect((by.get('la_rr_waived') as any).rent_status).toBe('waived');
    // partial standard waiver → the customer paid the base, so it is NOT "waived"
    expect((by.get('la_rr_paid') as any).rent_status).toBe('paid');

    // the locker + branch resolved from LockerHub
    expect((by.get('la_rr_premium') as any).locker_no).toBe('L-1');
    expect((by.get('la_rr_premium') as any).branch).toBe('Dindigul');

    expect(r.json.totals.premium).toBeGreaterThanOrEqual(1);
    expect(r.json.totals.waived).toBeGreaterThanOrEqual(1);
    expect(r.json.totals.paid).toBeGreaterThanOrEqual(1);
  });

  it('includes a tenant with NO fee waiver, deposit pledge or cheque — only a LockerHub roster entry (regression: Sathya)', async () => {
    const r = await (await admin()).get('/api/lockers/rent-report');
    expect(r.status).toBe(200);
    const by = new Map(r.json.rows.map((x: any) => [x.lockerhub_application_id, x]));
    const sathya = by.get('la_rr_clean_online') as any;
    expect(sathya).toBeTruthy();
    expect(sathya.customer_name).toBe('Sathya');
    expect(sathya.locker_no).toBe('L-4');
    expect(sathya.rent_amount).toBe(20000);
    expect(sathya.rent_status).toBe('paid');

    // A roster-only tenant whose leg genuinely is NOT settled must show
    // unpaid — the fix must not default every roster tenant to "paid".
    const unpaid = by.get('la_rr_clean_unpaid') as any;
    expect(unpaid).toBeTruthy();
    expect(unpaid.rent_status).toBe('unpaid');
  });

  it('builds a non-empty xlsx', async () => {
    const { lockerRentReport, lockerRentReportXlsx } = await import('../src/modules/lockers/report.js');
    const buf = await lockerRentReportXlsx(await lockerRentReport(ctx.db));
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(1000); // a real workbook, not empty
  });
});
