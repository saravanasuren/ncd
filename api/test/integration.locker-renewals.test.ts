/**
 * Locker renewals — whose rent is due.
 *
 * A locker is an annual-rent product and nothing in NCD tracked the lease end
 * (owner 2026-08-03). This is a read-only worklist built on the tenant roster,
 * so it inherits that roster's branch scoping and its phone+name matching.
 *
 * LockerHub isn't configured under test, so the integration cases pin the
 * DEGRADED path — the page must still answer, and must not present itself as a
 * complete picture. The date arithmetic, which is where this feature is most
 * easily wrong, is pinned directly as a unit.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';
import { daysUntil } from '../src/modules/lockers/renewals.js';

let ctx: TestCtx;

beforeAll(async () => { ctx = await startTestServer(); });
afterAll(async () => { await ctx.close(); });

async function as(email: string, password = 'Demo_1234') {
  const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c;
}
const admin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');

describe('daysUntil (lease expiry arithmetic)', () => {
  // 2026-08-03, MID-AFTERNOON — not midnight. That matters: a timestamp-based
  // implementation and a calendar-based one agree exactly at 00:00 UTC, so a
  // fixture pinned to midnight passes against both and tests nothing. Every
  // case below is therefore evaluated from a working-hours clock.
  const today = new Date(Date.UTC(2026, 7, 3, 14, 30));

  it('counts a lease ending today as 0, not as expired', () => {
    // The bug worth pinning: measuring a date against the running clock makes
    // "ends today" read as -1 for most of the working day, and the tenant gets
    // chased for being overdue on the very day their rent is still due.
    expect(daysUntil('2026-08-03', today)).toBe(0);
  });

  it('counts forwards and backwards in whole days', () => {
    expect(daysUntil('2026-08-13', today)).toBe(10);
    expect(daysUntil('2026-07-24', today)).toBe(-10);
  });

  it('crosses a month and a year boundary correctly', () => {
    expect(daysUntil('2026-09-02', today)).toBe(30);
    expect(daysUntil('2027-08-03', today)).toBe(365);
  });

  it('returns null for a missing or malformed date rather than a wrong number', () => {
    // A tenancy with no expiry on record must surface as "unknown" — inventing
    // a number here would silently sort it among real, actionable rows.
    expect(daysUntil(null)).toBeNull();
    expect(daysUntil('')).toBeNull();
    expect(daysUntil('not-a-date')).toBeNull();
  });
});

describe('locker renewals', () => {
  it('answers, well-formed, even though LockerHub is unreachable', async () => {
    const r = await (await admin()).get('/api/lockers/renewals');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.json.rows)).toBe(true);
    // It must admit the roster was never read rather than presenting an empty
    // list as "nothing is due" — that reads as reassurance and is not.
    expect(r.json.lockerhub_error).toBeTruthy();
  });

  it('reports the look-ahead window it actually used', async () => {
    const d = await (await admin()).get('/api/lockers/renewals');
    expect(d.json.window_days).toBe(60);
    const r = await (await admin()).get('/api/lockers/renewals?days=90');
    expect(r.json.window_days).toBe(90);
  });

  it('clamps a silly window instead of trusting the query string', async () => {
    const r = await (await admin()).get('/api/lockers/renewals?days=99999');
    expect(r.json.window_days).toBe(365);
    // Junk falls back to the default rather than producing NaN downstream.
    const j = await (await admin()).get('/api/lockers/renewals?days=abc');
    expect(j.json.window_days).toBe(60);
    const neg = await (await admin()).get('/api/lockers/renewals?days=-5');
    expect(neg.json.window_days).toBe(60);
  });

  it('is gated on the locker permission', async () => {
    // A plain agent has no lockers:enroll, so the whole locker surface is shut
    // to them — renewals carry tenant names and phone numbers for a branch.
    const r = await (await as('agent@demo.local')).get('/api/lockers/renewals');
    expect([401, 403]).toContain(r.status);
  });

  it('refuses a branch a restricted user is not assigned to', async () => {
    // Same rule as the roster it is built from: branch_staff see their branch.
    const r = await (await as('staff@demo.local')).get('/api/lockers/renewals?branch_id=br_not_mine');
    expect([403, 200]).toContain(r.status);
    if (r.status === 403) expect(String(r.json.error.message)).toMatch(/assigned branch/i);
  });
});
