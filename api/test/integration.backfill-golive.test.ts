/**
 * Go-live backfill — in particular the stranded-application case found in prod.
 *
 * Legacy-imported subscriptions land in PendingApproval with NO approval request
 * (the importer bulk-loads the old status and never creates approvals). That
 * strands them: they wait on an approval nobody can give, never appear in the
 * Approvals queue, and can never go live. The backfill must heal them.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';
import { backfillGoLive } from '../src/db/backfill-golive.js';

let ctx: TestCtx;
let seriesId: number;
let schemeId: number;

beforeAll(async () => {
  ctx = await startTestServer();
  seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
  schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
});
afterAll(async () => { await ctx.close(); });

const as = async (email: string, password = 'Demo_1234') => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c; };
const admin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');

/** An app exactly as the legacy importer leaves it: PendingApproval, no request. */
async function strandedApp(amount: number, phone: string): Promise<number> {
  const a = await admin();
  const cust = await a.post('/api/customers', { full_name: `Stranded ${phone}`, phone });
  const app = await a.post('/api/applications', { customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId, amount });
  const id = Number(app.json.id);
  // Strip the approval the app created, leaving it stranded like the import does.
  await ctx.db.query("DELETE FROM approval_requests WHERE entity_type='applications' AND entity_id=$1", [String(id)]);
  await ctx.db.query("UPDATE applications SET status='PendingApproval', enrolled_by_user_id=NULL WHERE id=$1", [id]);
  return id;
}

const openReqs = async (appId: number) => Number((await ctx.db.query(
  "SELECT count(*)::int n FROM approval_requests WHERE request_type='subscription' AND entity_type='applications' AND entity_id=$1 AND status='Pending'",
  [String(appId)])).rows[0]!.n);

describe('backfill:golive — heals stranded PendingApproval applications', () => {
  it('raises an approval so a stranded app becomes approvable, and is idempotent', async () => {
    const id = await strandedApp(500000, '9855000001');
    expect(await openReqs(id)).toBe(0); // stranded: nothing to approve

    const first = await backfillGoLive(ctx.db);
    expect(first.gated).toBeGreaterThanOrEqual(1);
    expect(first.gatedFailed).toBe(0);
    expect(await openReqs(id)).toBe(1); // now it can be approved

    // Re-running must not pile up a second request for the same app.
    const second = await backfillGoLive(ctx.db);
    expect(second.gated).toBe(0);
    expect(await openReqs(id)).toBe(1);
  });

  it('the healed approval actually takes the investment live', async () => {
    const id = await strandedApp(300000, '9855000002');
    await backfillGoLive(ctx.db);

    const reqId = Number((await ctx.db.query(
      "SELECT id FROM approval_requests WHERE entity_type='applications' AND entity_id=$1 AND status='Pending'",
      [String(id)])).rows[0]!.id);

    // A checker approves it → the NCD goes live (schedule + status).
    const ncd = await as('ncd@demo.local');
    const ok = await ncd.post(`/api/approvals/${reqId}/approve`);
    expect(ok.status).toBe(200);

    const app = (await ctx.db.query('SELECT status FROM applications WHERE id=$1', [id])).rows[0] as any;
    expect(app.status).toBe('Active');
    const sched = (await ctx.db.query('SELECT count(*)::int n FROM disbursement_schedule WHERE application_id=$1', [id])).rows[0] as any;
    expect(Number(sched.n)).toBeGreaterThan(0);
  });
});
