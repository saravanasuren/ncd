/**
 * The Locker Tenants page and the Locker Rent Report must say the SAME thing
 * about a locker's rent.
 *
 * They used to compute it separately. Tenants: "no approved waiver, so PAID" —
 * nothing about the money was ever checked. Report: "no approved waiver, so PAID
 * only if LockerHub's rent leg is settled, otherwise UNPAID". A customer flagged
 * Premium whose request was still awaiting Admin/CXO approval therefore read
 * Paid on one page and Unpaid on the other (Sonia, DHN0892), and during a
 * LockerHub outage Tenants said Paid for everyone while the Report said Unpaid.
 *
 * One rule now, one entry point, used by both — and this file is the guard that
 * keeps it so: every scenario is asserted on BOTH pages, and a generic loop
 * asserts equality for every locker either page can see, so a future edit to
 * one page cannot quietly drift.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import ExcelJS from 'exceljs';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';
import { config } from '../src/config.js';

let ctx: TestCtx;
let mock: Server;
let adminId: number;
let admin: Client;

const app = (id: string, no: string, settled: boolean | null) => ({
  application_no: `APP-${id}`, locker_size: 'Extra Large', branch_id: 'br1', allotment: { locker_number: no },
  name: `Tenant ${id}`, phone: `98${String(Math.abs([...id].reduce((a, c) => a * 31 + c.charCodeAt(0), 7))).padStart(8, '0').slice(0, 8)}`,
  legs: { rent: { amount: 23600, settled } },
});
// id → what LockerHub says about the application. `null` = the call fails (outage).
const APPS: Record<string, any | null> = {
  rs_paid:               app('rs_paid', 'P-1', true),
  rs_unpaid:             app('rs_unpaid', 'P-2', false),
  rs_premium_ok:         app('rs_premium_ok', 'P-3', false),
  rs_waived_ok:          app('rs_waived_ok', 'P-4', false),
  rs_partial:            app('rs_partial', 'P-5', true),
  rs_premium_pending:    app('rs_premium_pending', 'P-6', false),   // Sonia
  rs_premium_rejected:   app('rs_premium_rejected', 'P-7', true),
  rs_ncd_backed:         app('rs_ncd_backed', 'P-8', true),
  rs_cheque_unsettled:   app('rs_cheque_unsettled', 'P-9', false),  // cleared in NCD, LockerHub never told
  rs_transfer_unsettled: app('rs_transfer_unsettled', 'P-10', false),
  rs_transfer_pending:   app('rs_transfer_pending', 'P-11', false),
  rs_lh_down:            null,
  rs_premium_ok_lh_down: null,
};

const EXPECT: Record<string, string> = {
  rs_paid: 'paid', rs_unpaid: 'unpaid', rs_premium_ok: 'premium', rs_waived_ok: 'waived', rs_partial: 'paid',
  rs_premium_pending: 'unpaid', rs_premium_rejected: 'paid', rs_ncd_backed: 'paid',
  rs_cheque_unsettled: 'unpaid', rs_transfer_unsettled: 'unpaid', rs_transfer_pending: 'unpaid',
  rs_lh_down: 'unknown', rs_premium_ok_lh_down: 'premium',
};

beforeAll(async () => {
  ctx = await startTestServer();
  adminId = Number((await ctx.db.query("SELECT id FROM users WHERE email='admin@dhanam.finance'")).rows[0]!.id);
  mock = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const send = (code: number, obj: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (/\/branches$/.test(url.pathname)) return send(200, { branches: [{ id: 'br1', name: 'HOPE COLLAGE BRANCH' }] });
    if (/\/locker-tenants$/.test(url.pathname)) {
      return send(200, { tenants: Object.keys(APPS).map((id, i) => ({
        tenant_id: `t_${id}`, application_id: id, branch_id: 'br1', branch_name: 'HOPE COLLAGE BRANCH', size: 'Extra Large',
        locker_number: `L-${i}`, tenant: { name: `Tenant ${id}`, phone: `97000000${String(i).padStart(2, '0')}` },
      })) });
    }
    const m = url.pathname.match(/\/locker-applications\/([^/]+)$/);
    if (m) { const id = decodeURIComponent(m[1]!); const a = APPS[id]; return a ? send(200, a) : send(a === null ? 500 : 404, { error: 'x' }); }
    return send(404, {});
  });
  await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r));
  config.LOCKERHUB_API_URL = `http://127.0.0.1:${(mock.address() as { port: number }).port}`;

  const w = (id: string, o: { pct?: number | null; amt?: number | null; cat: string; status: string; reason?: string }) => ctx.db.query(
    `INSERT INTO locker_fee_waivers (lockerhub_application_id, leg, waiver_pct, waiver_amount, category, reason, status, created_by_user_id, approved_by_user_id)
     VALUES ($1,'rent',$2,$3,$4,$5,$6,$7,$8)`,
    [id, o.pct ?? null, o.amt ?? null, o.cat, o.reason ?? 'r', o.status, adminId, o.status === 'Approved' ? adminId : null]);
  await w('rs_premium_ok',         { pct: 100, cat: 'premium', status: 'Approved', reason: 'Premium customer' });
  await w('rs_waived_ok',          { pct: 100, cat: 'waiver', status: 'Approved', reason: 'Goodwill' });
  await w('rs_partial',            { amt: 3050, cat: 'waiver', status: 'Approved', reason: 'Standard GST waiver' });
  await w('rs_premium_pending',    { pct: 100, cat: 'premium', status: 'PendingApproval', reason: 'Premium customer — rent made complimentary (owner policy)' });
  await w('rs_premium_rejected',   { pct: 100, cat: 'premium', status: 'Rejected' });
  await w('rs_premium_ok_lh_down', { pct: 100, cat: 'premium', status: 'Approved', reason: 'Premium customer' });
  // NCD-backed: a cleared cheque puts the locker in NCD's own tables as well as the roster.
  await ctx.db.query(
    `INSERT INTO locker_cheques (lockerhub_application_id, leg, amount, cheque_no, bank_name, received_on, status, recorded_by_user_id)
     VALUES ('rs_ncd_backed','rent',23600,'CHQ-1','Test Bank', now()::date, 'Cleared', $1)`, [adminId]);

  await ctx.db.query(
    `INSERT INTO locker_cheques (lockerhub_application_id, leg, amount, cheque_no, bank_name, received_on, status, recorded_by_user_id, lockerhub_error)
     VALUES ('rs_cheque_unsettled','rent',23600,'CHQ-77','Test Bank', now()::date, 'Cleared', $1, 'LockerHub unreachable')`, [adminId]);
  const off = (id: string, status: string) => ctx.db.query(
    `INSERT INTO locker_offline_payments (lockerhub_application_id, leg, method, reference, amount, status, created_by_user_id)
     VALUES ($1,'rent','transfer','UTR-9',23600,$2,$3)`, [id, status, adminId]);
  await off('rs_transfer_unsettled', 'Approved');
  await off('rs_transfer_pending', 'PendingApproval');

  admin = new Client(ctx.base);
  await admin.post('/api/auth/login', { email: 'admin@dhanam.finance', password: 'ChangeMe_Dev_123' });
});
afterAll(async () => { config.LOCKERHUB_API_URL = ''; await new Promise<void>((r) => mock.close(() => r())); await ctx.close(); });

const both = async () => {
  const t = await admin.get('/api/lockers/tenants');
  const r = await admin.get('/api/lockers/rent-report');
  expect(t.status).toBe(200); expect(r.status).toBe(200);
  const tenant = new Map<string, any>((t.json.rows as any[]).filter((x) => x.lockerhub_application_id).map((x) => [x.lockerhub_application_id, x]));
  const report = new Map<string, any>((r.json.rows as any[]).map((x) => [x.lockerhub_application_id, x]));
  return { tenant, report, reportJson: r.json };
};

describe('Locker Tenants and the Locker Rent Report agree', () => {
  it('on every locker either page can see (the guard against drift)', async () => {
    const { tenant, report } = await both();
    const ids = [...new Set([...tenant.keys(), ...report.keys()])];
    expect(ids.length).toBeGreaterThanOrEqual(Object.keys(EXPECT).length);
    for (const id of ids) {
      if (!tenant.has(id) || !report.has(id)) continue;
      expect(`${id}: ${tenant.get(id).rent_status}`).toBe(`${id}: ${report.get(id).rent_status}`);
    }
  });

  it.each(Object.entries(EXPECT))('%s is %s on BOTH pages', async (id, status) => {
    const { tenant, report } = await both();
    expect(report.get(id)?.rent_status).toBe(status);
    expect(tenant.get(id)?.rent_status).toBe(status);
  });

  it('a Premium request still awaiting approval is not "Paid", and says why (Sonia)', async () => {
    const { tenant, report } = await both();
    expect(tenant.get('rs_premium_pending').rent_status).not.toBe('paid');
    expect(report.get('rs_premium_pending').reason).toMatch(/awaiting approval/i);
    expect(tenant.get('rs_premium_pending').rent_reason).toMatch(/awaiting approval/i);
  });

  it('every Unpaid says why — including money NCD collected that LockerHub never settled', async () => {
    const { tenant, report } = await both();
    for (const [id, re] of [
      ['rs_cheque_unsettled', /CHQ-77 cleared in NCD — rent not settled on LockerHub \(LockerHub unreachable\)/],
      ['rs_transfer_unsettled', /UTR-9 approved in NCD — rent not settled on LockerHub/],
      ['rs_transfer_pending', /awaiting approval/],
      ['rs_unpaid', /LockerHub shows the rent unsettled.*no payment recorded in NCD/],
    ] as const) {
      expect(report.get(id).reason, id).toMatch(re);
      expect(tenant.get(id).rent_reason, id).toMatch(re);
    }
    // a settled leg needs no excuse
    expect(report.get('rs_ncd_backed').reason).toBeNull();
  });

  it('LockerHub being unreachable reads Unknown, never Paid and never Unpaid', async () => {
    const { tenant, report } = await both();
    expect(tenant.get('rs_lh_down').rent_status).toBe('unknown');
    expect(report.get('rs_lh_down').rent_status).toBe('unknown');
  });

  it('the report totals, its row count and its Excel summary all agree', async () => {
    const { report, reportJson } = await both();
    const counted: Record<string, number> = {};
    for (const r of report.values()) counted[r.rent_status] = (counted[r.rent_status] ?? 0) + 1;
    for (const [k, n] of Object.entries(counted)) expect(reportJson.totals[k]).toBe(n);
    expect(Object.values(reportJson.totals as Record<string, number>).reduce((a, b) => a + b, 0)).toBe(report.size);

    const x = await admin.raw('/api/lockers/rent-report.xlsx');
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(x.buffer as never);
    const summary = String(wb.worksheets[0]!.getRow(2).getCell(1).value);
    for (const [k, label] of [['paid', 'Paid'], ['waived', 'Waived'], ['premium', 'Premium'], ['unpaid', 'Unpaid']] as const) {
      expect(summary).toContain(`${label}: ${reportJson.totals[k] ?? 0}`);
    }
  });
});
