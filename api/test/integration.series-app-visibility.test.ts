/**
 * Which series the customer-facing apps may offer (owner 2026-08-29: "there are
 * 2 series actively opened. I need only NCD 29 to be visible to dhanamfin
 * application. can we make this UI editable?").
 *
 * The bug being fixed: /integration/series/active returned every series with
 * status = 'Open', so OPENING a series published it to customers as a side
 * effect. NCD BOND was opened on 28 Aug and was immediately on offer.
 *
 * Two facts that were conflated and are now separate:
 *   status = 'Open'   — this series MAY take money. Internal.
 *   visible_in_app    — customers are OFFERED it. Deliberate, opt-in, and
 *                       changed only through Admin/CXO approval.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
const KEY = 'dev-integration-key';   // config.ts's test default

beforeAll(async () => { ctx = await startTestServer(); });
afterAll(async () => { await ctx.close(); });

const as = async (email: string, password = 'Demo_1234') => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c; };
const superAdmin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');

/** What DhanamFin / LockerHub actually see. The integration facade is key-authed,
 *  not cookie-authed, so it is called with fetch like the other facade tests. */
async function appSeries() {
  const res = await fetch(`${ctx.base}/api/integration/series/active`, {
    headers: { 'X-Integration-Key': KEY },
  });
  expect(res.status).toBe(200);
  const json = await res.json() as { series: Array<Record<string, unknown>> };
  return json.series;
}

async function openSeries(code: string, visible: boolean) {
  const row = (await ctx.db.query<{ id: string }>(
    `INSERT INTO series (code, name, status, visible_in_app, opened_at)
     VALUES ($1, $1, 'Open', $2, now()) RETURNING id`, [code, visible])).rows[0]!;
  return Number(row.id);
}

describe('what the customer apps are offered', () => {
  it('an Open series is NOT offered until it is published — opening is not publishing', async () => {
    const hidden = await openSeries('VIS HIDDEN', false);
    const shown = await openSeries('VIS SHOWN', true);
    const codes = (await appSeries()).map((s) => s.code);
    expect(codes).toContain('VIS SHOWN');
    // The whole point: it is Open, it can take money, and customers are not
    // offered it.
    expect(codes).not.toContain('VIS HIDDEN');
    expect(Number(hidden)).toBeGreaterThan(0);
    expect(Number(shown)).toBeGreaterThan(0);
  });

  it('a published series that is no longer Open drops out too', async () => {
    const id = await openSeries('VIS CLOSED', true);
    expect((await appSeries()).map((s) => s.code)).toContain('VIS CLOSED');
    await ctx.db.query("UPDATE series SET status = 'Allotted' WHERE id = $1", [id]);
    // Both conditions must hold — publishing does not override the status.
    expect((await appSeries()).map((s) => s.code)).not.toContain('VIS CLOSED');
  });
});

describe('changing it needs a checker', () => {
  it('a request is held, and only applies once Admin/CXO approves', async () => {
    const sa = await superAdmin();
    const id = await openSeries('VIS PENDING', false);

    const mgr = await as('ncd@demo.local');
    const req = await mgr.patch(`/api/series/${id}/app-visibility`, { visible: true, reason: 'ready to sell' });
    expect(req.status).toBe(200);
    expect(req.json.applied).toBe(false);

    // Nothing published yet — the gate is the point.
    expect((await appSeries()).map((s) => s.code)).not.toContain('VIS PENDING');

    const reqId = Number(req.json.approval_request.id);
    expect((await mgr.post(`/api/approvals/${reqId}/approve`, {})).status).toBe(403);   // maker ≠ checker
    expect((await sa.post(`/api/approvals/${reqId}/approve`, {})).status).toBe(200);

    expect((await appSeries()).map((s) => s.code)).toContain('VIS PENDING');
  });

  it('withdrawing one takes it away from customers, once approved', async () => {
    const sa = await superAdmin();
    const id = await openSeries('VIS WITHDRAW', true);
    const mgr = await as('ncd@demo.local');
    const req = await mgr.patch(`/api/series/${id}/app-visibility`, { visible: false, reason: 'not for the app' });
    expect((await appSeries()).map((s) => s.code)).toContain('VIS WITHDRAW');   // still there, unapproved
    expect((await sa.post(`/api/approvals/${Number(req.json.approval_request.id)}/approve`, {})).status).toBe(200);
    expect((await appSeries()).map((s) => s.code)).not.toContain('VIS WITHDRAW');
  });

  it('asking for the state it is already in is refused', async () => {
    const sa = await superAdmin();
    const id = await openSeries('VIS NOOP', true);
    expect((await sa.patch(`/api/series/${id}/app-visibility`, { visible: true })).status).toBe(400);
  });

  it('branch staff cannot request it', async () => {
    const id = await openSeries('VIS GUARDED', false);
    expect((await (await as('staff@demo.local')).patch(
      `/api/series/${id}/app-visibility`, { visible: true })).status).toBe(403);
  });
});

describe('the NCD side is unaffected', () => {
  it('a hidden series still shows to staff and can still take money', async () => {
    const sa = await superAdmin();
    const id = await openSeries('VIS INTERNAL', false);
    const rows = (await sa.get('/api/series')).json.rows as Array<Record<string, unknown>>;
    const found = rows.find((r) => Number(r.id) === id)!;
    // Invisible to customers, entirely normal internally — the case this was
    // built for: branch staff keep enrolling into it.
    expect(found).toBeDefined();
    expect(found.visible_in_app).toBe(false);
    expect(found.status).toBe('Open');
  });
});
