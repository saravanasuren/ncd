/**
 * Identity + handover + incentive routing (owner spec 2026-07-18).
 * - Users carry a unique CODE + staff flag; agents have their own admin.
 * - "Referred by" resolves code → payee; unknown free text → pending agent
 *   with an agent_registration approval.
 * - Duplicate PAN on enrol → 409 carrying the existing customer (handover
 *   offer); handover approval works for CXO / Branch Manager (any one).
 * - Accrual: fresh+referrer pays the referrer 2%; existing-customer+referrer
 *   pays the referrer 0.25% and the staff 0.
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
const admin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');

describe('users: code + staff flag', () => {
  it('creates a user with a unique code; duplicate code is rejected', async () => {
    const a = await admin();
    const r = await a.post('/api/users', { full_name: 'Coded Staff', email: 'coded@demo.local', password: 'Password1', role: 'branch_staff', code: 'st01', is_staff: true });
    expect(r.status).toBe(201);
    const list = await a.get('/api/users');
    const u = (list.json.rows as Array<Record<string, unknown>>).find((x) => x.email === 'coded@demo.local')!;
    expect(u.code).toBe('ST01'); // upper-cased
    expect(u.is_staff).toBe(true);
    const dup = await a.post('/api/users', { full_name: 'Other', email: 'other@demo.local', password: 'Password1', role: 'branch_staff', code: 'ST01' });
    expect(dup.status).toBe(409);
  });
});

describe('agents admin + payee search', () => {
  it('creates a manual agent (auto code) and finds both kinds in payee-search', async () => {
    const a = await admin();
    const ag = await a.post('/api/agents', { full_name: 'Field Agent Gokul' });
    expect(ag.status).toBe(201);
    expect(String(ag.json.agent_code)).toMatch(/^AG-\d{4}$/);
    const s = await a.get('/api/agents/payee-search?q=gokul');
    expect((s.json.rows as Array<{ kind: string }>).some((r) => r.kind === 'agent')).toBe(true);
    const s2 = await a.get('/api/agents/payee-search?q=coded');
    expect((s2.json.rows as Array<{ kind: string }>).some((r) => r.kind === 'staff')).toBe(true);
  });

  it('edits an agent: name, phone and bank details persist; list returns them', async () => {
    const a = await admin();
    const ag = await a.post('/api/agents', { full_name: 'Editable Agent' });
    const upd = await a.put(`/api/agents/${ag.json.id}`, {
      full_name: 'Edited Agent', phone: '9812345678',
      bank_name: 'ICICI', account_number: '9988776655', ifsc: 'ICIC0001234',
    });
    expect(upd.status).toBe(200);
    const list = await a.get('/api/agents');
    const row = (list.json.rows as any[]).find((r) => r.id === ag.json.id);
    expect(row.full_name).toBe('Edited Agent');
    expect(row.phone).toBe('9812345678');
    expect(row.bank_name).toBe('ICICI');
    expect(row.account_number).toBe('9988776655');
    expect(row.ifsc).toBe('ICIC0001234');

    // Clearing a field sends null (what the edit form does) — must not 400.
    const clear = await a.put(`/api/agents/${ag.json.id}`, { phone: null, bank_name: null });
    expect(clear.status).toBe(200);
    const list2 = await a.get('/api/agents');
    const row2 = (list2.json.rows as any[]).find((r) => r.id === ag.json.id);
    expect(row2.phone).toBeNull();
    expect(row2.bank_name).toBeNull();
  });
});

describe('enrol: duplicate PAN → handover offer; free text → pending agent', () => {
  it('returns 409 with the existing customer on a duplicate PAN', async () => {
    const a = await admin();
    const first = await a.post('/api/customers', { full_name: 'Original Investor', pan: 'AAAPZ9999Z', phone: '9811110001' });
    expect(first.status).toBe(201);
    const again = await a.post('/api/customers', { full_name: 'Same Person', pan: 'AAAPZ9999Z', phone: '9811110002' });
    expect(again.status).toBe(409);
    expect(again.json.error.detail.existing_customer.id).toBe(first.json.id);
  });

  it('an unknown referred-by name creates a PendingApproval agent + approval request', async () => {
    const a = await admin();
    const r = await a.post('/api/customers', { full_name: 'Referred Cust', phone: '9811110003', referred_by_text: 'Brand New Agentman' });
    expect(r.status).toBe(201);
    const agent = (await ctx.db.query("SELECT id, commission_status, is_active FROM agents WHERE lower(full_name) = 'brand new agentman'")).rows[0] as any;
    expect(agent).toBeDefined();
    expect(agent.commission_status).toBe('PendingApproval');
    expect(agent.is_active).toBe(false);
    const req = (await ctx.db.query("SELECT 1 FROM approval_requests WHERE request_type='agent_registration' AND entity_id=$1", [agent.id])).rows[0];
    expect(req).toBeDefined();
  });
});

describe('handover approval — any one of Admin / CXO / Branch Manager', () => {
  it('CXO can approve a handover request', async () => {
    const a = await admin();
    const cust = await a.post('/api/customers', { full_name: 'Handover Cust', phone: '9811110004' });
    const toUser = Number((await ctx.db.query("SELECT id FROM users WHERE email='bm@demo.local'")).rows[0]!.id);
    const req = await a.post(`/api/customers/${cust.json.id}/handover-request`, { toUserId: toUser, reason: 'New agent brought repeat money' });
    expect(req.status).toBe(201);
    const cxo = await as('cxo@demo.local');
    const ok = await cxo.post(`/api/approvals/${req.json.request.id}/approve`);
    expect(ok.status).toBe(200);
    const row = (await ctx.db.query('SELECT enrolled_by_user_id FROM customers WHERE id=$1', [cust.json.id])).rows[0] as any;
    expect(Number(row.enrolled_by_user_id)).toBe(toUser);
  });
});

describe('incentive accrual routing', () => {
  async function invest(a: Client, custBody: Record<string, unknown>, amount: number) {
    const cust = await a.post('/api/customers', custBody);
    const cid = cust.json.id;
    await a.post(`/api/customers/${cid}/bank-accounts`, { account_number: `9${amount}${cid}`, ifsc: 'ICIC0001111' });
    const app = await a.post('/api/applications', { customer_id: cid, series_id: seriesId, scheme_id: schemeId, amount });
    await a.post(`/api/applications/${app.json.id}/confirm-collection`, { amount_received: amount, date_money_received: '2026-07-10', method: 'NEFT' });
    return { cid, appId: Number(app.json.id) };
  }
  async function activate(a: Client) {
    const ncd = await as('ncd@demo.local');
    const batch = await ncd.post(`/api/activations/series/${seriesId}`, {});
    await a.post(`/api/approvals/${batch.json.request.id}/approve`);
  }

  it('fresh customer referred by an agent code → agent gets 2%, staff 0', async () => {
    const a = await admin();
    const ag = await a.post('/api/agents', { full_name: 'Commission Agent', agent_code: 'AG-COMM' });
    const { appId } = await invest(a, { full_name: 'Fresh Investor', phone: '9811110005', referred_by_text: 'AG-COMM' }, 200000);
    await activate(a);
    const acc = (await ctx.db.query("SELECT payee_type, payee_id, amount FROM incentive_accruals WHERE application_id=$1", [appId])).rows as any[];
    const agentRow = acc.find((r) => r.payee_type === 'agent');
    expect(agentRow).toBeDefined();
    expect(Number(agentRow.payee_id)).toBe(Number(ag.json.id));
    expect(Number(agentRow.amount)).toBe(4000); // 2% of 2,00,000
    expect(acc.find((r) => r.payee_type === 'staff')).toBeUndefined(); // newWithReferrer = 0
  });

  it('repeat investment referred by an agent → agent gets 0.25%, staff 0', async () => {
    const a = await admin();
    const { cid } = await invest(a, { full_name: 'Repeat Investor', phone: '9811110006' }, 100000);
    await activate(a);
    // second investment for the SAME customer, brought by the agent
    await ctx.db.query('UPDATE customers SET referred_by_text = $1 WHERE id = $2', ['AG-COMM', cid]);
    const app2 = await a.post('/api/applications', { customer_id: cid, series_id: seriesId, scheme_id: schemeId, amount: 400000 });
    await a.post(`/api/applications/${app2.json.id}/confirm-collection`, { amount_received: 400000, date_money_received: '2026-07-11', method: 'NEFT' });
    await activate(a);
    const acc = (await ctx.db.query("SELECT payee_type, amount FROM incentive_accruals WHERE application_id=$1", [app2.json.id])).rows as any[];
    const agentRow = acc.find((r) => r.payee_type === 'agent');
    expect(agentRow).toBeDefined();
    expect(Number(agentRow.amount)).toBe(1000); // 0.25% of 4,00,000
    expect(acc.find((r) => r.payee_type === 'staff')).toBeUndefined(); // existingWithReferrer = 0
  });
});
