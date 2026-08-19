/**
 * Demat and nominee changes go through approval (owner 2026-08-19: "bring the
 * demat and nominee details in the profile itself. so that when i make some
 * changes in it will go through approval").
 *
 * The split that matters: the FIRST capture applies straight away, every later
 * CHANGE needs a checker. The enrolment wizard records both moments after
 * creating a customer through these same endpoints — queueing that first entry
 * would leave brand-new customers with no nominee and no demat on file until
 * someone got round to approving them.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
let custId: number;

beforeAll(async () => {
  ctx = await startTestServer();
  const a = await admin();
  const c = await a.post('/api/customers', {
    full_name: 'Profile Approval Cust', phone: '9400008001', pan: 'PAPPR1234K', dob: '1980-01-01',
  });
  custId = c.json.id;
});
afterAll(async () => { await ctx.close(); });

async function admin() {
  const c = new Client(ctx.base);
  await c.post('/api/auth/login', { email: 'admin@dhanam.finance', password: 'ChangeMe_Dev_123' });
  return c;
}
// Super admin may self-approve when they state why — the same escape the
// existing correction tests use, so these do not need a second seeded user.
const SELF_APPROVE = { extra: { self_approval_reason: 'Verified against the customer file; approving as super admin.' } };

const demat = async () => (await ctx.db.query(
  'SELECT demat_dp_id, demat_client_id, depository FROM customers WHERE id = $1', [custId])).rows[0] as any;
const nominees = async () => (await ctx.db.query(
  'SELECT full_name, share_pct FROM nominees WHERE customer_id = $1 ORDER BY id', [custId])).rows as any[];

describe('demat changes', () => {
  it('the FIRST capture applies immediately — enrolment must not stall', async () => {
    const a = await admin();
    const r = await a.put(`/api/customers/${custId}/demat`, { dp_id: 'IN300456', client_id: '12345678', depository: 'NSDL' });
    expect(r.status).toBe(200);
    expect(r.json.applied).toBe(true);
    expect((await demat()).demat_dp_id).toBe('IN300456');
  });

  it('a CHANGE to details already on file goes to a checker, and does NOT apply yet', async () => {
    const a = await admin();
    const r = await a.put(`/api/customers/${custId}/demat`, { dp_id: 'IN999999', client_id: '87654321', depository: 'CDSL' });
    expect(r.status).toBe(200);
    expect(r.json.applied).toBe(false);
    expect(r.json.approval_request?.id).toBeTruthy();
    // Still the old details — this is the whole point.
    expect((await demat()).demat_dp_id).toBe('IN300456');
  });

  it('applies once approved', async () => {
    const a = await admin();
    const pending = (await ctx.db.query(
      "SELECT id FROM approval_requests WHERE request_type = 'customer_correction' AND entity_id = $1 AND status = 'Pending' ORDER BY id DESC LIMIT 1",
      [String(custId)])).rows[0] as any;
    const ap = await a.post(`/api/approvals/${pending.id}/approve`, SELF_APPROVE);
    expect(ap.status).toBe(200);
    const d = await demat();
    expect(d.demat_dp_id).toBe('IN999999');
    expect(d.demat_client_id).toBe('87654321');
    expect(d.depository).toBe('CDSL');
  });

  it('rejects a malformed DP ID when it is SUBMITTED, not at apply time', async () => {
    // A checker approving rubbish would either fail deep in the applier or save
    // it — both worse than telling the maker while they are still typing.
    const a = await admin();
    const r = await a.post(`/api/customers/${custId}/correction-request`, {
      changes: { demat_dp_id: 'NOPE' }, reason: 'typo test',
    });
    expect(r.status).toBe(400);
    expect(String(r.json.error.message)).toMatch(/8 characters/i);
  });
});

describe('nominee changes', () => {
  it('the FIRST nominee applies immediately', async () => {
    const a = await admin();
    const r = await a.put(`/api/customers/${custId}/nominees`, { nominees: [{ full_name: 'First Nominee' }] });
    expect(r.status).toBe(200);
    expect(r.json.applied).toBe(true);
    const n = await nominees();
    expect(n.length).toBe(1);
    // Sole nominee takes the whole holding.
    expect(Number(n[0]!.share_pct)).toBe(100);
  });

  it('changing an existing nominee set goes to a checker and does NOT apply yet', async () => {
    const a = await admin();
    const r = await a.put(`/api/customers/${custId}/nominees`, {
      nominees: [{ full_name: 'First Nominee', share_pct: 50 }, { full_name: 'Second Nominee', share_pct: 50 }],
    });
    expect(r.status).toBe(200);
    expect(r.json.applied).toBe(false);
    // Nominee decides who receives the money — it must not move on one click.
    const n = await nominees();
    expect(n.length).toBe(1);
    expect(n[0]!.full_name).toBe('First Nominee');
  });

  it('applies the whole set once approved', async () => {
    const a = await admin();
    const pending = (await ctx.db.query(
      "SELECT id FROM approval_requests WHERE request_type = 'customer_nominees' AND entity_id = $1 AND status = 'Pending' ORDER BY id DESC LIMIT 1",
      [String(custId)])).rows[0] as any;
    expect(pending).toBeTruthy();
    const ap = await a.post(`/api/approvals/${pending.id}/approve`, SELF_APPROVE);
    expect(ap.status).toBe(200);
    const n = await nominees();
    expect(n.map((x) => x.full_name)).toEqual(['First Nominee', 'Second Nominee']);
    expect(n.map((x) => Number(x.share_pct))).toEqual([50, 50]);
  });

  it('still refuses shares over 100% before anything is queued', async () => {
    const a = await admin();
    const r = await a.put(`/api/customers/${custId}/nominees`, {
      nominees: [{ full_name: 'A', share_pct: 80 }, { full_name: 'B', share_pct: 40 }],
    });
    expect(r.status).toBe(400);
    const stillPending = (await ctx.db.query(
      "SELECT count(*)::int AS n FROM approval_requests WHERE request_type = 'customer_nominees' AND entity_id = $1 AND status = 'Pending'",
      [String(custId)])).rows[0] as any;
    expect(Number(stillPending.n)).toBe(0);
  });
});
