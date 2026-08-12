/**
 * NCD lockers are RENT-ONLY (owner 2026-08-12): at enrolment the deposit is
 * auto-waived 100% via A21 (a POLICY waiver — no maker-checker), so LockerHub
 * allots on rent alone. This pins the waiver row that gets written; the actual
 * LockerHub push is best-effort (swallowed on failure, so no real LockerHub is
 * needed here).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, type TestCtx } from './helpers/server.js';
import { autoWaiveDeposit } from '../src/modules/lockers/feeWaivers.js';
import type { AuthUser } from '../src/lib/authUser.js';

let ctx: TestCtx;
let actor: AuthUser;

beforeAll(async () => {
  ctx = await startTestServer();
  const u = (await ctx.db.query("SELECT id FROM users WHERE email = 'admin@dhanam.finance'")).rows[0]!;
  actor = { id: Number(u.id), email: 'admin@dhanam.finance', fullName: 'Admin', role: 'super_admin', permissions: [], branchIds: [], agentId: null, customerId: null };
});
afterAll(async () => { await ctx.close(); });

describe('rent-only lockers auto-waive the deposit', () => {
  it('writes an APPROVED 100% deposit waiver with no maker-checker, idempotently', async () => {
    await autoWaiveDeposit(ctx.db, actor, 'LH-TEST-123');
    const w = (await ctx.db.query(
      "SELECT * FROM locker_fee_waivers WHERE lockerhub_application_id = 'LH-TEST-123' AND leg = 'deposit'")).rows[0] as any;
    expect(w, 'a deposit waiver row was created').toBeTruthy();
    expect(Number(w.waiver_pct)).toBe(100);
    expect(w.status).toBe('Approved');            // approved-on-creation
    expect(w.approval_request_id).toBeNull();      // POLICY waiver — skips maker-checker
    expect(String(w.reason).toLowerCase()).toContain('rent-only');

    // Idempotent — enrolling again (or a retry) never duplicates the waiver.
    await autoWaiveDeposit(ctx.db, actor, 'LH-TEST-123');
    const n = Number((await ctx.db.query(
      "SELECT count(*)::int AS c FROM locker_fee_waivers WHERE lockerhub_application_id = 'LH-TEST-123'")).rows[0]!.c);
    expect(n).toBe(1);
  });

  it('a blank application id is a no-op', async () => {
    const r = await autoWaiveDeposit(ctx.db, actor, '');
    expect(r).toBeNull();
  });
});
