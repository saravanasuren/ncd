/**
 * ops/diagnose-rent-status.mjs — the read-only tool that says WHY one customer's
 * rent reads Unpaid. It is only worth running on production if it tells the
 * causes apart, so each cause is planted here and its verdict asserted, plus a
 * proof that it never writes.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, type TestCtx } from './helpers/server.js';
// @ts-expect-error — plain .mjs tool, no types
import { diagnose } from '../../ops/diagnose-rent-status.mjs';

let ctx: TestCtx;
let adminId: number;
const PHONE = '9012345678';

const leg = (o: Record<string, unknown>) => ({ amount: 23600, original_amount: 23600, ...o });
const APPS: Record<string, any> = {
  d_cheque:  { application_no: 'APP-D1', phone: PHONE, allotment: { locker_number: 'D-1' }, legs: { rent: leg({ settled: false }) } },
  d_plain:   { application_no: 'APP-D2', phone: '9099999999', allotment: { locker_number: 'D-2' }, legs: { rent: leg({ settled: false }) } },
  d_paid:    { application_no: 'APP-D3', phone: '9088888888', allotment: { locker_number: 'D-3' }, legs: { rent: leg({ settled: true }) } },
  // one locker, two applications: the live one paid, a stale one never
  d_live:    { application_no: 'APP-D4', phone: '9077777777', allotment: { locker_number: 'D-4' }, legs: { rent: leg({ settled: true }) } },
  d_stale:   { application_no: 'APP-D5', phone: '9077777777', allotment: { locker_number: 'D-4' }, legs: { rent: leg({ settled: false }) } },
  d_cancel:  { application_no: 'APP-D7', phone: '9055555555', status: 'cancelled', allotment: { locker_number: 'D-7' }, legs: { rent: leg({ settled: false }) } },
  d_sonia:   { application_no: 'APP-D6', phone: '9066666666', allotment: { locker_number: 'D-6' }, legs: { rent: leg({ settled: false }) } },
};
const lh = {
  get: async (path: string) => {
    if (path === '/locker-tenants') return { tenants: [] };
    const m = path.match(/\/customers\/(\d+)/);
    if (m) return { found: true, lockers: [{ locker_number: 'D-1', annual_rent: 20000 }, { locker_number: 'D-6', annual_rent: 20000 }] };
    const a = path.match(/\/locker-applications\/([^/]+)$/);
    if (a && APPS[decodeURIComponent(a[1]!)]) return APPS[decodeURIComponent(a[1]!)];
    throw new Error(`LockerHub 404 on GET ${path}`);
  },
};

beforeAll(async () => {
  ctx = await startTestServer();
  adminId = Number((await ctx.db.query("SELECT id FROM users WHERE email='admin@dhanam.finance'")).rows[0]!.id);
  for (const [id, a] of Object.entries(APPS)) {
    await ctx.db.query('INSERT INTO locker_applications (lockerhub_application_id, application_no, phone, locker_number) VALUES ($1,$2,$3,$4)',
      [id, a.application_no, a.phone, a.allotment.locker_number]);
  }
  await ctx.db.query(
    `INSERT INTO locker_cheques (lockerhub_application_id, leg, amount, cheque_no, bank_name, received_on, status, recorded_by_user_id, lockerhub_error)
     VALUES ('d_cheque','rent',23600,'CHQ-5','Bank', now()::date,'Cleared',$1,'LockerHub unreachable')`, [adminId]);
  await ctx.db.query(
    `INSERT INTO locker_fee_waivers (lockerhub_application_id, leg, waiver_pct, category, reason, status, created_by_user_id)
     VALUES ('d_sonia','rent',100,'premium','Premium customer','PendingApproval',$1)`, [adminId]);
});
afterAll(async () => { await ctx.close(); });

const run = async (ref: string) => (await diagnose({ db: ctx.db, lh, ref })).text as string;

describe('diagnose-rent-status', () => {
  it('a cleared cheque LockerHub never settled → paid in NCD, not settled on LockerHub', async () => {
    const t = await run('d_cheque');
    expect(t).toMatch(/VERDICT: PAID IN NCD, NOT SETTLED ON LOCKERHUB — cheque CHQ-5/);
    expect(t).toContain('LockerHub unreachable');
  });

  it('nothing recorded anywhere → unpaid on LockerHub, no payment in NCD', async () => {
    expect(await run('d_plain')).toMatch(/VERDICT: UNPAID ON LOCKERHUB, NO PAYMENT RECORDED IN NCD/);
  });

  it('a settled leg → paid', async () => {
    expect(await run('d_paid')).toMatch(/VERDICT: PAID — LockerHub shows the rent leg settled/);
  });

  it('a pending premium request is named, and is not the same as paid', async () => {
    expect(await run('d_sonia')).toMatch(/VERDICT: WAIVER REQUEST AWAITING APPROVAL \(premium\)/);
  });

  it('two applications on one locker, one paid and one not, are called out as a stale duplicate', async () => {
    const t = await run(PHONE.replace(PHONE, '9077777777'));
    expect(t).toMatch(/locker D-4: 2 applications/);
    expect(t).toMatch(/ONE HAS BEEN PAID AND ANOTHER HAS NOT/);
  });

  it('explains ₹20,000 vs ₹23,600 with the numbers', async () => {
    const t = await run('d_cheque');
    expect(t).toContain('annual_rent = ₹20,000');
    expect(t).toContain('leg amount = ₹23,600');
    expect(t).toMatch(/NO standard GST waiver is applied/);
  });

  it('a cancelled application is named as such — it is not a customer who owes rent', async () => {
    expect(await run('d_cancel')).toMatch(/VERDICT: CANCELLED ON LOCKERHUB/);
  });

  it('finds the application by its APP- number too', async () => {
    expect(await run('APP-D3')).toMatch(/VERDICT: PAID/);
  });

  it('is read-only — the database is byte-identical afterwards', async () => {
    const snap = async () => JSON.stringify([
      (await ctx.db.query('SELECT * FROM locker_cheques ORDER BY id')).rows,
      (await ctx.db.query('SELECT * FROM locker_fee_waivers ORDER BY id')).rows,
      (await ctx.db.query('SELECT * FROM locker_offline_payments ORDER BY id')).rows,
      (await ctx.db.query('SELECT * FROM locker_applications ORDER BY lockerhub_application_id')).rows,
      (await ctx.db.query('SELECT count(*) FROM audit_log')).rows,
    ]);
    const before = await snap();
    for (const r of ['d_cheque', 'd_plain', 'd_sonia', '9077777777']) await run(r);
    expect(await snap()).toBe(before);
  });
});
