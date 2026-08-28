/**
 * Has the bond actually reached the customer? (owner 2026-08-19: "get me a
 * option in the investment application section to make is the bond has been
 * distributed to the customer or not").
 *
 * Every bond field that already existed records what we PRODUCED — the
 * consolidated bond can be generated at will, esigned_at says the customer
 * signed, bond_pdf_path says a file was written. None of them says the paper
 * was handed over. This is that fact, and the owner asked for it audited:
 * marked + who + when.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx, requiredInvestmentFields } from './helpers/server.js';

let ctx: TestCtx;
let appId: number;

beforeAll(async () => {
  ctx = await startTestServer();
  const seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
  const schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
  const a = await admin();
  const c = await a.post('/api/customers', {
    full_name: 'Bond Handover Cust', phone: '9400007001', pan: 'BHCUS1234K', dob: '1980-01-01',
  });
  const app = await a.post('/api/applications', {
    customer_id: c.json.id, series_id: seriesId, scheme_id: schemeId, amount: 100000, ...requiredInvestmentFields(),
  });
  appId = app.json.id;
});
afterAll(async () => { await ctx.close(); });

async function admin() {
  const c = new Client(ctx.base);
  await c.post('/api/auth/login', { email: 'admin@dhanam.finance', password: 'ChangeMe_Dev_123' });
  return c;
}
const row = async () => (await ctx.db.query(
  'SELECT bond_distributed_at, bond_distributed_by FROM applications WHERE id = $1', [appId])).rows[0] as any;

describe('bond distributed to the customer', () => {
  it('starts unmarked', async () => {
    const r = await row();
    expect(r.bond_distributed_at).toBeNull();
    expect(r.bond_distributed_by).toBeNull();
  });

  it('records WHO marked it and WHEN, not just that it happened', async () => {
    const a = await admin();
    const res = await a.post(`/api/applications/${appId}/bond-distributed`, { given_on: '2026-08-20' });
    expect(res.status).toBe(200);

    const r = await row();
    expect(r.bond_distributed_at).not.toBeNull();
    // The acting user, not a nullable free-text note — this is the whole point
    // of the owner choosing the audited option.
    const me = (await ctx.db.query("SELECT id FROM users WHERE email = 'admin@dhanam.finance'")).rows[0] as any;
    expect(Number(r.bond_distributed_by)).toBe(Number(me.id));
  });

  it('shows the marker by NAME on the detail page, not a user id', async () => {
    const a = await admin();
    const d = await a.get(`/api/applications/${appId}`);
    expect(d.status).toBe(200);
    expect(d.json.application.bond_distributed_at).toBeTruthy();
    expect(String(d.json.application.bond_distributed_by_name ?? '')).not.toBe('');
  });

  it('cannot be un-marked — the record stands until a checker approves otherwise', async () => {
    // This used to assert the opposite. Un-ticking wiped who vouched for the
    // handover, which is why the owner asked for it to be impossible
    // (2026-08-28); reversal now goes through Admin/CXO approval instead.
    const a = await admin();
    const again = await a.post(`/api/applications/${appId}/bond-distributed`, { given_on: '2026-08-25' });
    expect(again.status).toBe(409);
    const r = await row();
    expect(r.bond_distributed_at).not.toBeNull();
    expect(r.bond_distributed_by).not.toBeNull();
  });

  it('leaves an audit row for the marking', async () => {
    const { rows } = await ctx.db.query(
      "SELECT after_data FROM audit_log WHERE action = 'application.bond-distributed' AND entity_id = $1 ORDER BY id", [String(appId)]);
    expect(rows.length).toBe(1);
    expect((rows[0] as any).after_data.distributed).toBe(true);
    expect((rows[0] as any).after_data.given_on).toBe('2026-08-20');
  });

  it('needs the update permission', async () => {
    const anon = new Client(ctx.base);
    const res = await anon.post(`/api/applications/${appId}/bond-distributed`, { given_on: '2026-08-20' });
    expect(res.status).toBeGreaterThanOrEqual(401);
  });
});
