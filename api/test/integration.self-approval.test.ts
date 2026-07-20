/**
 * Super Admin self-approval override (owner decision 2026-07-20).
 *
 * Rule zero stays for everyone else: maker ≠ checker. A Super Admin may approve
 * their OWN submission, but only with a written reason, which is stored on the
 * request and audited as a self-approval. This is the single break in the
 * two-person rule, so it is pinned down hard here.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';

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
/** Seeded super_admin. */
const superAdmin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');

async function ownInvestment(c: Client, phone: string, amount: number) {
  const cust = await c.post('/api/customers', { full_name: `Self ${phone}`, phone });
  const app = await c.post('/api/applications', {
    customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId, amount, date_money_received: '2026-07-12',
  });
  return { appId: Number(app.json.id), reqId: Number(app.json.subscription_request.id) };
}

describe('super admin self-approval', () => {
  it('is refused without a reason, and accepted with one', async () => {
    const sa = await superAdmin();
    const { reqId } = await ownInvestment(sa, '9822000001', 200000);

    // No reason → refused, even for super admin.
    const bare = await sa.post(`/api/approvals/${reqId}/approve`, {});
    expect(bare.status).toBe(403);

    // Too short → still refused.
    const thin = await sa.post(`/api/approvals/${reqId}/approve`, { extra: { self_approval_reason: 'ok' } });
    expect(thin.status).toBe(403);

    // With a real reason → allowed.
    const ok = await sa.post(`/api/approvals/${reqId}/approve`, { extra: { self_approval_reason: 'Verified the bank credit myself; no second checker available today.' } });
    expect(ok.status).toBe(200);
    expect(ok.json.request.status).toBe('Approved');
  });

  it('records the reason on the request and audits it as a self-approval', async () => {
    const sa = await superAdmin();
    const { reqId } = await ownInvestment(sa, '9822000002', 300000);
    const reason = 'Month-end cutoff; sole admin on duty.';
    expect((await sa.post(`/api/approvals/${reqId}/approve`, { extra: { self_approval_reason: reason } })).status).toBe(200);

    const meta = (await ctx.db.query('SELECT metadata FROM approval_requests WHERE id = $1', [reqId])).rows[0] as any;
    expect(meta.metadata.self_approval_reason).toBe(reason);

    const audit = (await ctx.db.query(
      "SELECT action, after_data FROM audit_log WHERE entity_type='approval_requests' AND entity_id=$1 ORDER BY id", [String(reqId)])).rows as any[];
    const self = audit.find((a) => a.action === 'approval.self-approve');
    expect(self).toBeTruthy();                       // its own loud audit entry
    expect(self.after_data.reason).toBe(reason);
    const appr = audit.find((a) => a.action === 'approval.approve');
    expect(appr.after_data.self_approved).toBe(true);     // and flagged on the normal one
  });

  it('a NON super-admin still cannot approve their own submission, reason or not', async () => {
    const ncd = await as('ncd@demo.local');          // ncd_manager holds approvals:check
    const { reqId } = await ownInvestment(ncd, '9822000003', 150000);

    const withReason = await ncd.post(`/api/approvals/${reqId}/approve`, { extra: { self_approval_reason: 'I would like to approve my own request please.' } });
    expect(withReason.status).toBe(403);

    // …but a different checker still can.
    const sa = await superAdmin();
    expect((await sa.post(`/api/approvals/${reqId}/approve`, {})).status).toBe(200);
  });

  it('the queue flags a super admin own-submission so the UI can demand a reason', async () => {
    const sa = await superAdmin();
    const { reqId } = await ownInvestment(sa, '9822000004', 120000);
    const row = ((await sa.get('/api/approvals/queue')).json.rows as any[]).find((r) => r.id === reqId);
    expect(row.canAct).toBe(true);          // super admin may act…
    expect(row.selfApproval).toBe(true);    // …but the UI must collect a reason

    // For a different checker it's an ordinary approval, no reason needed.
    const ncd = await as('ncd@demo.local');
    const otherRow = ((await ncd.get('/api/approvals/queue')).json.rows as any[]).find((r) => r.id === reqId);
    expect(otherRow.canAct).toBe(true);
    expect(otherRow.selfApproval).toBe(false);
  });
});
