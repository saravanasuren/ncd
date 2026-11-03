/**
 * What a rejected investment approval does to the investment (owner 2026-11-02:
 * "rejecting should vanish it and pending approval shall remain pending and wait
 * until it gets approved").
 *
 * Rejecting used to be emit-only. The investment kept the status
 * `PendingApproval`, so it appeared in NO approval queue — there was no Pending
 * request left to show — while every count of PendingApproval still included it.
 * Three real investments sat in that limbo for up to six weeks.
 *
 * Both halves of the owner's sentence are asserted here, because fixing the
 * first half by sweeping everything out of PendingApproval would be worse than
 * the bug: an investment still awaiting a decision must keep waiting.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx, requiredInvestmentFields } from './helpers/server.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let ctx: TestCtx;
let seriesId: number, schemeId: number;

beforeAll(async () => {
  ctx = await startTestServer();
  seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
  schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
});
afterAll(async () => { await ctx.close(); });

/** An investment awaiting approval, plus the request id raised for it. */
async function pendingInvestment(name: string, phone: string): Promise<{ appId: number; requestId: number }> {
  const c = new Client(ctx.base);
  await c.post('/api/auth/login', { email: 'admin@dhanam.finance', password: 'ChangeMe_Dev_123' });
  const cust = await c.post('/api/customers', { full_name: name, phone });
  const app = await c.post('/api/applications', {
    ...requiredInvestmentFields(), customer_id: cust.json.id,
    series_id: seriesId, scheme_id: schemeId, amount: 500000, date_money_received: '2026-09-17',
  });
  const appId = Number(app.json.id);
  const req = (await ctx.db.query<{ id: string }>(
    `SELECT id FROM approval_requests
      WHERE entity_type = 'applications' AND entity_id = $1 AND request_type = 'subscription' AND status = 'Pending'
      ORDER BY id DESC LIMIT 1`, [String(appId)])).rows[0];
  expect(req, 'the investment should have raised a subscription approval').toBeTruthy();
  return { appId, requestId: Number(req!.id) };
}

const statusOf = async (appId: number) =>
  String((await ctx.db.query<{ status: string }>('SELECT status FROM applications WHERE id = $1', [appId])).rows[0]!.status);

describe('rejecting an investment approval', () => {
  it('takes the investment off the book instead of leaving it pending', async () => {
    const { appId, requestId } = await pendingInvestment('Reject Me', '9552550001');
    expect(await statusOf(appId)).toBe('PendingApproval');

    const checker = new Client(ctx.base);
    await checker.post('/api/auth/login', { email: 'ncd@demo.local', password: 'Demo_1234' });
    const res = await checker.post(`/api/approvals/${requestId}/reject`, { reason: 'Not proceeding — funds returned' });
    expect(res.status, JSON.stringify(res.json)).toBeLessThan(300);

    // The whole point: it must NOT still read PendingApproval.
    expect(await statusOf(appId)).toBe('Rejected');

    // And it must be gone from the queue — no Pending request, nothing to act on.
    const stillPending = await ctx.db.query(
      "SELECT 1 FROM approval_requests WHERE entity_type = 'applications' AND entity_id = $1 AND status = 'Pending'",
      [String(appId)]);
    expect(stillPending.rows.length).toBe(0);

    // Recorded, not silently flipped.
    const audit = await ctx.db.query(
      "SELECT 1 FROM audit_log WHERE action = 'application.rejected' AND entity_id = $1", [String(appId)]);
    expect(audit.rows.length).toBe(1);
  });

  it('leaves an investment that is still awaiting a decision alone', async () => {
    // The other half of the instruction. Nothing about the fix may disturb an
    // investment whose approval has not been acted on.
    const { appId } = await pendingInvestment('Still Waiting', '9552550002');
    expect(await statusOf(appId)).toBe('PendingApproval');
    const pending = await ctx.db.query(
      "SELECT 1 FROM approval_requests WHERE entity_type = 'applications' AND entity_id = $1 AND status = 'Pending'",
      [String(appId)]);
    expect(pending.rows.length).toBe(1);
  });

  it('does not pull a live investment off the book if its approval is rejected late', async () => {
    // Guard on the status: only PendingApproval moves. An Active NCD must survive.
    const { appId, requestId } = await pendingInvestment('Already Live', '9552550003');
    await ctx.db.query("UPDATE applications SET status = 'Active' WHERE id = $1", [appId]);

    const checker = new Client(ctx.base);
    await checker.post('/api/auth/login', { email: 'ncd@demo.local', password: 'Demo_1234' });
    await checker.post(`/api/approvals/${requestId}/reject`, { reason: 'Late rejection' });

    expect(await statusOf(appId)).toBe('Active');
  });

  it('migration 105 clears the records already stranded, and only those', async () => {
    // The backfill runs against live customers, so the migration's OWN sql is
    // executed here rather than a paraphrase of it.
    const stranded = await pendingInvestment('Stranded Already', '9552550004');
    const waiting = await pendingInvestment('Waiting Already', '9552550005');
    const live = await pendingInvestment('Live Already', '9552550006');

    // Reproduce the limbo: the request was rejected but the investment was left
    // pending — exactly the state the three real ones were found in.
    await ctx.db.query("UPDATE approval_requests SET status = 'Rejected' WHERE id = $1", [stranded.requestId]);
    // ...and one that was rejected AFTER going live, which must not be touched.
    await ctx.db.query("UPDATE approval_requests SET status = 'Rejected' WHERE id = $1", [live.requestId]);
    await ctx.db.query("UPDATE applications SET status = 'Active' WHERE id = $1", [live.appId]);

    const runMigration = async () => {
      const sql = readFileSync(
        fileURLToPath(new URL('../src/db/migrations/105_rejected_subscriptions_leave_pending.sql', import.meta.url)),
        'utf8');
      // The test driver takes ONE statement per call, and comment lines must go
      // first or they attach to the wrong half of the split.
      const bare = sql.split('\n').filter((l) => !l.trimStart().startsWith('--')).join('\n');
      for (const stmt of bare.split(';').map((x) => x.trim()).filter(Boolean)) {
        await ctx.db.query(stmt);
      }
    };
    await runMigration();

    expect(await statusOf(stranded.appId)).toBe('Rejected');   // swept
    expect(await statusOf(waiting.appId)).toBe('PendingApproval'); // still waiting, untouched
    expect(await statusOf(live.appId)).toBe('Active');          // live money untouched

    const audit = await ctx.db.query(
      "SELECT 1 FROM audit_log WHERE action = 'application.rejected' AND entity_id = $1", [String(stranded.appId)]);
    expect(audit.rows.length).toBe(1);

    // Running it twice must not double-write or disturb anything.
    await runMigration();
    expect(await statusOf(waiting.appId)).toBe('PendingApproval');
    const again = await ctx.db.query(
      "SELECT count(*)::int AS n FROM audit_log WHERE action = 'application.rejected' AND entity_id = $1", [String(stranded.appId)]);
    expect(Number((again.rows[0] as { n: number }).n)).toBe(1);
  });
});
