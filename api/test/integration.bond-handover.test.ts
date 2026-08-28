/**
 * "Bond given to customer" is WRITE-ONCE (owner 2026-08-28):
 *   "clicking on bond given - should ask me for the date of given. and it should
 *    not be un tickable. and any changes to it should be going to approval only."
 *   "also add notes field - so that I'll add something like sent through courier
 *    / given to so and so."
 *   "restrict it to NCD Manager and above."
 *
 * What it used to be: a checkbox that stamped now() — so a bond handed over on
 * the 20th and ticked on the 28th read as the 28th — with no note, and which
 * anyone holding applications:update could silently untick, erasing the record
 * of who vouched for the handover.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx, requiredInvestmentFields } from './helpers/server.js';

let ctx: TestCtx;
let seriesId: number, schemeId: number;

beforeAll(async () => {
  ctx = await startTestServer();
  seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
  schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
});
afterAll(async () => { await ctx.close(); });

const as = async (email: string, password = 'Demo_1234') => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c; };
const superAdmin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');
const ncdManager = () => as('ncd@demo.local');
const branchStaff = () => as('staff@demo.local');

let seq = 0;
async function investment(a: Client) {
  const cust = await a.post('/api/customers', { full_name: `Bond Cust ${String.fromCharCode(65 + (seq++ % 26))}`, phone: `97050000${String(seq).padStart(2, '0')}` });
  expect(cust.status, `customer create: ${JSON.stringify(cust.json)}`).toBe(201);
  const app = await a.post('/api/applications', { ...requiredInvestmentFields(),
    customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId, amount: 100000 });
  expect(app.status, `application create: ${JSON.stringify(app.json)}`).toBe(201);
  return Number(app.json.id);
}
/** The endpoint wraps the row: { application, lines, schedule, ... }. */
const detail = async (a: Client, id: number) => (await a.get(`/api/applications/${id}`)).json.application;

describe('recording the handover', () => {
  it('stores the date the operator gives, not the moment they clicked', async () => {
    const a = await superAdmin();
    const id = await investment(a);
    const res = await a.post(`/api/applications/${id}/bond-distributed`,
      { given_on: '2026-08-20', note: 'Sent by courier, AWB 123456' });
    expect(res.status).toBe(200);

    const d = await detail(a, id);
    // The handover date is what was typed...
    expect(String(d.bond_distributed_on).slice(0, 10)).toBe('2026-08-20');
    expect(d.bond_distributed_note).toBe('Sent by courier, AWB 123456');
    // ...while the record stamp is today. The old code conflated the two.
    expect(String(d.bond_distributed_at).slice(0, 10)).toBe(new Date().toISOString().slice(0, 10));
    expect(String(d.bond_distributed_on).slice(0, 10)).not.toBe(String(d.bond_distributed_at).slice(0, 10));
  });

  it('refuses a handover dated in the future', async () => {
    const a = await superAdmin();
    const id = await investment(a);
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    expect((await a.post(`/api/applications/${id}/bond-distributed`, { given_on: tomorrow })).status).toBe(400);
  });

  it('the note is optional', async () => {
    const a = await superAdmin();
    const id = await investment(a);
    expect((await a.post(`/api/applications/${id}/bond-distributed`, { given_on: '2026-08-20' })).status).toBe(200);
    expect((await detail(a, id)).bond_distributed_note).toBeNull();
  });

  it('only NCD Manager and above can record one', async () => {
    const sa = await superAdmin();
    const id = await investment(sa);
    expect((await (await branchStaff()).post(`/api/applications/${id}/bond-distributed`, { given_on: '2026-08-20' })).status).toBe(403);
    expect((await detail(sa, id)).bond_distributed_at).toBeNull();
    expect((await (await ncdManager()).post(`/api/applications/${id}/bond-distributed`, { given_on: '2026-08-20' })).status).toBe(200);
  });
});

describe('it cannot be unticked', () => {
  it('re-posting over a recorded handover is refused — there is no untick', async () => {
    const a = await superAdmin();
    const id = await investment(a);
    await a.post(`/api/applications/${id}/bond-distributed`, { given_on: '2026-08-20', note: 'by hand' });

    // The old endpoint took { distributed: false } and wiped the record. Now the
    // only write path refuses outright once something is recorded.
    const again = await a.post(`/api/applications/${id}/bond-distributed`, { given_on: '2026-08-25' });
    expect(again.status).toBe(409);

    const d = await detail(a, id);
    expect(String(d.bond_distributed_on).slice(0, 10)).toBe('2026-08-20');   // untouched
    expect(d.bond_distributed_note).toBe('by hand');
  });
});

describe('any change goes through approval', () => {
  it('a correction is held until a checker approves, then applied', async () => {
    const sa = await superAdmin();
    const id = await investment(sa);
    await sa.post(`/api/applications/${id}/bond-distributed`, { given_on: '2026-08-20', note: 'by hand' });

    const mgr = await ncdManager();
    const req = await mgr.patch(`/api/applications/${id}/bond-distributed`,
      { given_on: '2026-08-15', note: 'Actually couriered on the 15th', reason: 'wrong date entered' });
    expect(req.status).toBe(200);
    expect(req.json.pending_approval).toBe(true);

    // Nothing has moved yet — that is the whole point of the gate.
    let d = await detail(sa, id);
    expect(String(d.bond_distributed_on).slice(0, 10)).toBe('2026-08-20');
    expect(d.bond_distributed_note).toBe('by hand');

    const reqId = Number(req.json.approval_request.id);
    expect((await mgr.post(`/api/approvals/${reqId}/approve`, {})).status).toBe(403);  // maker ≠ checker
    expect((await sa.post(`/api/approvals/${reqId}/approve`, {})).status).toBe(200);

    d = await detail(sa, id);
    expect(String(d.bond_distributed_on).slice(0, 10)).toBe('2026-08-15');
    expect(d.bond_distributed_note).toBe('Actually couriered on the 15th');
  });

  it('a reversal is the only way back, and it clears the whole record', async () => {
    const sa = await superAdmin();
    const id = await investment(sa);
    await sa.post(`/api/applications/${id}/bond-distributed`, { given_on: '2026-08-20', note: 'by hand' });

    const mgr = await ncdManager();
    const req = await mgr.patch(`/api/applications/${id}/bond-distributed`,
      { given_on: null, reason: 'bond was never actually handed over' });
    expect(req.status).toBe(200);
    expect((await sa.post(`/api/approvals/${Number(req.json.approval_request.id)}/approve`, {})).status).toBe(200);

    const d = await detail(sa, id);
    // Nothing left claiming a handover happened.
    expect(d.bond_distributed_at).toBeNull();
    expect(d.bond_distributed_on).toBeNull();
    expect(d.bond_distributed_note).toBeNull();
    expect(d.bond_distributed_by).toBeNull();
  });

  it('a change needs a reason, and cannot be requested on an unmarked bond', async () => {
    const sa = await superAdmin();
    const id = await investment(sa);
    // Not marked yet → nothing to change.
    expect((await sa.patch(`/api/applications/${id}/bond-distributed`,
      { given_on: '2026-08-15', reason: 'x' })).status).toBe(400);

    await sa.post(`/api/applications/${id}/bond-distributed`, { given_on: '2026-08-20' });
    expect((await sa.patch(`/api/applications/${id}/bond-distributed`,
      { given_on: '2026-08-15', reason: '' })).status).toBe(400);
  });

  it('branch staff cannot request a change either', async () => {
    const sa = await superAdmin();
    const id = await investment(sa);
    await sa.post(`/api/applications/${id}/bond-distributed`, { given_on: '2026-08-20' });
    expect((await (await branchStaff()).patch(`/api/applications/${id}/bond-distributed`,
      { given_on: '2026-08-15', reason: 'nope' })).status).toBe(403);
  });
});
