/**
 * Report attribution by referred-by (docs/06). Agent-wise / Staff-wise attribute
 * by the customer's `referred_by_text` (imported from wealth), NOT the enroller:
 * a referrer that matches a staff user shows Staff-wise; every other referrer
 * shows Agent-wise by their typed name. Fixes the "everyone is Direct / Dhanam
 * Admin" bug.
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
  await buildBook();
});
afterAll(async () => { await ctx.close(); });

const as = async (email: string, password = 'Demo_1234') => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c; };
const admin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');

/** Fund an app for a new customer carrying `referredBy`. */
async function fund(a: Client, name: string, amount: number, referredBy: string) {
  const cust = await a.post('/api/customers', { full_name: name, phone: `9${Math.floor(amount)}`, referred_by_text: referredBy });
  const cid = cust.json.id;
  await a.post(`/api/customers/${cid}/bank-accounts`, { account_number: `3333${amount}`, ifsc: 'ICIC0001111' });
  const app = await a.post('/api/applications', { customer_id: cid, series_id: seriesId, scheme_id: schemeId, amount });
  await a.post(`/api/applications/${app.json.id}/confirm-collection`, { amount_received: amount, date_money_received: '2026-07-10', method: 'NEFT' });
}

async function buildBook() {
  const a = await admin();
  await fund(a, 'Cust Agent', 500000, 'Gokul');                 // referrer = an agent name (not a staff user)
  await fund(a, 'Cust Staff', 300000, 'Demo NCD Manager');      // referrer = a seeded staff user's full name
  // activate the funded apps so they enter the book
  const ncd = await as('ncd@demo.local');
  const batch = await ncd.post(`/api/activations/series/${seriesId}`, {});
  await a.post(`/api/approvals/${batch.json.request.id}/approve`);
}

const keys = (groups: Array<{ key: string }>) => groups.map((g) => g.key);

describe('agent/staff attribution by referred-by', () => {
  it('an agent-name referrer shows Agent-wise, not Staff-wise', async () => {
    const a = await admin();
    const agent = await a.get('/api/reports/segments/agent');
    expect(agent.status).toBe(200);
    expect(keys(agent.json.groups)).toContain('Gokul');

    const staff = await a.get('/api/reports/segments/staff');
    expect(keys(staff.json.groups)).not.toContain('Gokul');
  });

  it('a staff-user referrer shows Staff-wise, not Agent-wise', async () => {
    const a = await admin();
    const staff = await a.get('/api/reports/segments/staff');
    expect(keys(staff.json.groups)).toContain('Demo NCD Manager');

    const agent = await a.get('/api/reports/segments/agent');
    expect(keys(agent.json.groups)).not.toContain('Demo NCD Manager');
  });

  it('dashboard staff/agent tiles split the money-in (not the same total)', async () => {
    const a = await admin();
    const ov = await a.get('/api/dashboard/overview');
    expect(ov.status).toBe(200);
    // staff tile = staff-referred money only; agent tile = everything else
    expect(Number(ov.json.flow.money_in_staff)).toBe(300000);   // Demo NCD Manager
    expect(Number(ov.json.flow.money_in_agent)).toBe(500000);   // Gokul
    expect(Number(ov.json.flow.money_in_staff) + Number(ov.json.flow.money_in_agent)).toBe(Number(ov.json.flow.money_in));
  });

  it('no referrer falls back to Direct in Agent-wise', async () => {
    const a = await admin();
    await fund(a, 'Cust Direct', 100000, '');
    const ncd = await as('ncd@demo.local');
    const batch = await ncd.post(`/api/activations/series/${seriesId}`, {});
    await a.post(`/api/approvals/${batch.json.request.id}/approve`);

    const agent = await a.get('/api/reports/segments/agent');
    expect(keys(agent.json.groups)).toContain('Direct');
  });
  it('resolves a referrer by CODE and stays correct after the staff is renamed', async () => {
    const a = await admin();
    // Give the seeded staff user a stable code, refer a customer by that code.
    await ctx.db.query("UPDATE users SET code = 'STAFF1' WHERE email = 'ncd@demo.local'");
    await fund(a, 'Coded Ref Cust', 120000, 'STAFF1');
    const ncd = await as('ncd@demo.local');
    const batch = await ncd.post(`/api/activations/series/${seriesId}`, {});
    await a.post(`/api/approvals/${batch.json.request.id}/approve`);

    const before = await a.get('/api/reports/segments/staff');
    const name = (await ctx.db.query("SELECT full_name FROM users WHERE email='ncd@demo.local'")).rows[0].full_name as string;
    expect(keys(before.json.groups)).toContain(name); // shows under current name via code

    // Rename the staff user — code-based match must survive.
    await ctx.db.query("UPDATE users SET full_name = 'Renamed Manager X' WHERE email = 'ncd@demo.local'");
    const after = await a.get('/api/reports/segments/staff');
    expect(keys(after.json.groups)).toContain('Renamed Manager X'); // resolved to NEW name, attribution intact
  });

  it('falls back to the customer referrer when the app-level copy is wiped', async () => {
    const a = await admin();
    await fund(a, 'Wipe Test Cust', 90000, 'Gokul');
    const ncd = await as('ncd@demo.local');
    const batch = await ncd.post(`/api/activations/series/${seriesId}`, {});
    await a.post(`/api/approvals/${batch.json.request.id}/approve`);
    // Simulate a re-import wiping the app-level referrer (customer keeps it).
    await ctx.db.query("UPDATE applications a SET referred_by_text = NULL FROM customers c WHERE c.id = a.customer_id AND c.full_name = 'Wipe Test Cust'");
    const agent = await a.get('/api/reports/segments/agent');
    // still attributed to Gokul via the customer fallback — not dropped to Direct
    const gokul = (agent.json.groups as Array<{ key: string; children: Array<{ customer: string }> }>).find((g) => g.key === 'Gokul');
    expect(gokul?.children.some((ch) => ch.customer === 'Wipe Test Cust')).toBe(true);
  });
});
