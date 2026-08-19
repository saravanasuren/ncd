/**
 * A series goes through approval, and can be edited (owner 2026-08-19: "THERE
 * is no edit option. and once a series is created it should go by approval").
 *
 * Owner chose the gated option: a new series is BLOCKED from taking
 * investments until approved, and edits need a checker too.
 *
 * There was no edit path at all before this — a mistyped code or deemed date
 * could only be fixed in the database.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx, requiredInvestmentFields } from './helpers/server.js';

let ctx: TestCtx;
let schemeId: number;

beforeAll(async () => {
  ctx = await startTestServer();
  schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
});
afterAll(async () => { await ctx.close(); });

async function admin() {
  const c = new Client(ctx.base);
  await c.post('/api/auth/login', { email: 'admin@dhanam.finance', password: 'ChangeMe_Dev_123' });
  return c;
}
const SELF_APPROVE = { extra: { self_approval_reason: 'Series verified against the term sheet; approving as super admin.' } };
const seriesRow = async (id: number) => (await ctx.db.query(
  'SELECT code, name, status, deemed_date, opened_at FROM series WHERE id = $1', [id])).rows[0] as any;

/** A customer to try investing with. Name carries NO digits — the shared
 *  person-name rule rejects them, and a 400 here would look like the gate. */
async function newCustomer(a: Client, phone: string, name: string) {
  const c = await a.post('/api/customers', { full_name: name, phone });
  if (c.status !== 201) throw new Error(`customer create failed: ${c.status} ${JSON.stringify(c.json)}`);
  return Number(c.json.id);
}

describe('a new series waits for approval', () => {
  it('is created PendingApproval, not Open, and has no opened_at yet', async () => {
    const a = await admin();
    const r = await a.post('/api/series', { code: 'SER-GATE-1', name: 'Gated Series' });
    expect(r.status).toBe(201);
    expect(r.json.approval_request?.id).toBeTruthy();

    const s = await seriesRow(r.json.id);
    expect(s.status).toBe('PendingApproval');
    // opened_at is when the series actually opened, not when someone typed it.
    expect(s.opened_at).toBeNull();
  });

  it('REFUSES an investment while it waits — the real gate, not just a hidden dropdown', async () => {
    const a = await admin();
    const sid = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'SER-GATE-1'")).rows[0]!.id);
    await ctx.db.query('INSERT INTO series_schemes (series_id, scheme_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [sid, schemeId]);
    const custId = await newCustomer(a, '9400006001', 'Gate Test Customer One');

    const res = await a.post('/api/applications', {
      customer_id: custId, series_id: sid, scheme_id: schemeId, amount: 100000, ...requiredInvestmentFields(),
    });
    expect(res.status).toBe(400);
    expect(String(res.json.error.message)).toMatch(/waiting for approval/i);
  });

  it('opens on approval, and then takes money', async () => {
    const a = await admin();
    const sid = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'SER-GATE-1'")).rows[0]!.id);
    const req = (await ctx.db.query(
      "SELECT id FROM approval_requests WHERE request_type = 'series_creation' AND entity_id = $1 ORDER BY id DESC LIMIT 1",
      [String(sid)])).rows[0] as any;
    const ap = await a.post(`/api/approvals/${req.id}/approve`, SELF_APPROVE);
    expect(ap.status).toBe(200);

    const s = await seriesRow(sid);
    expect(s.status).toBe('Open');
    expect(s.opened_at).not.toBeNull();

    const custId = await newCustomer(a, '9400006002', 'Gate Test Customer Two');
    const res = await a.post('/api/applications', {
      customer_id: custId, series_id: sid, scheme_id: schemeId, amount: 100000, ...requiredInvestmentFields(),
    });
    expect(res.status).toBe(201);
  });

  it('a rejected series is Withdrawn, not left dangling as pending', async () => {
    const a = await admin();
    const r = await a.post('/api/series', { code: 'SER-GATE-2', name: 'Rejected Series' });
    const req = (await ctx.db.query(
      "SELECT id FROM approval_requests WHERE request_type = 'series_creation' AND entity_id = $1 ORDER BY id DESC LIMIT 1",
      [String(r.json.id)])).rows[0] as any;
    const rej = await a.post(`/api/approvals/${req.id}/reject`, { reason: 'Wrong deemed date — will be re-raised.' });
    expect(rej.status).toBe(200);
    expect((await seriesRow(r.json.id)).status).toBe('Withdrawn');
  });
});

describe('editing a series', () => {
  it('sends the change to a checker and does NOT apply it yet', async () => {
    const a = await admin();
    const sid = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'SER-GATE-1'")).rows[0]!.id);
    const r = await a.put(`/api/series/${sid}`, { name: 'Renamed Series', deemed_date: '2026-03-01' });
    expect(r.status).toBe(200);
    expect(r.json.applied).toBe(false);

    const s = await seriesRow(sid);
    expect(s.name).toBe('Gated Series');            // unchanged until approved
    expect(s.status).toBe('Open');                  // an edit does not re-gate a live series
  });

  it('applies the change once approved', async () => {
    const a = await admin();
    const sid = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'SER-GATE-1'")).rows[0]!.id);
    const req = (await ctx.db.query(
      "SELECT id FROM approval_requests WHERE request_type = 'series_change' AND entity_id = $1 ORDER BY id DESC LIMIT 1",
      [String(sid)])).rows[0] as any;
    const ap = await a.post(`/api/approvals/${req.id}/approve`, SELF_APPROVE);
    expect(ap.status).toBe(200);

    const s = await seriesRow(sid);
    expect(s.name).toBe('Renamed Series');
    expect(String(s.deemed_date).slice(0, 10)).toBe('2026-03-01');
  });

  it('refuses a no-op instead of queueing an empty request', async () => {
    const a = await admin();
    const sid = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'SER-GATE-1'")).rows[0]!.id);
    const r = await a.put(`/api/series/${sid}`, { name: 'Renamed Series' });
    expect(r.status).toBe(400);
    expect(String(r.json.error.message)).toMatch(/no changes/i);
  });

  it('leaves an existing series alone — nothing else re-gates', async () => {
    // The demo series predates all of this and must keep working untouched.
    const s = (await ctx.db.query("SELECT status FROM series WHERE code = 'NCD DEMO'")).rows[0] as any;
    expect(s.status).toBe('Open');
  });
});
