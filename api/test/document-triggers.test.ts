/**
 * Document workflow triggers: the Acknowledgement is generated + stored when
 * the investment goes Active (funds received), and the Bond right after eSign
 * completes. Both are defensive — a PDF failure must not break the flow.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, approveInvestment, type TestCtx, requiredInvestmentFields } from './helpers/server.js';

let ctx: TestCtx;
let appId: number;
const login = async (email: string, password = 'Demo_1234') => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c; };
const admin = () => login('admin@dhanam.finance', 'ChangeMe_Dev_123');
const appRow = async () => (await ctx.db.query(
  'SELECT acknowledgment_pdf_path, acknowledgment_generated_at, bond_pdf_path, bond_generated_at FROM applications WHERE id = $1', [appId])).rows[0] as Record<string, unknown>;

beforeAll(async () => {
  ctx = await startTestServer();
  const seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
  const schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
  const a = await admin();
  const cust = await a.post('/api/customers', { full_name: 'Trigger Cust', phone: '9848111222' });
  const app = await a.post('/api/applications', { ...requiredInvestmentFields(), customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId, amount: 500000, date_money_received: '2026-07-18' });
  appId = Number(app.json.id);
  await approveInvestment(await login('ncd@demo.local'), app); // → Active (fires the ack trigger)
});
afterAll(async () => { await ctx.close(); });

describe('document workflow triggers', () => {
  it('generates + stores the Acknowledgement when the investment goes Active', async () => {
    const r = await appRow();
    expect(r.acknowledgment_pdf_path).toBeTruthy();
    expect(String(r.acknowledgment_pdf_path)).toContain('acknowledgments/');
    expect(r.acknowledgment_generated_at).not.toBeNull();
    expect(r.bond_pdf_path).toBeNull(); // bond not yet — eSign hasn't happened
  });

  it('generates + stores the Bond after eSign completes', async () => {
    const a = await admin();
    await a.post(`/api/applications/${appId}/esign/initiate`);
    const reqId = (await ctx.db.query('SELECT digio_request_id FROM digio_signing_sessions WHERE application_id = $1', [appId])).rows[0] as { digio_request_id: string };
    const { completeSigning } = await import('../src/integrations/digio/service.js');
    await completeSigning(ctx.db, reqId.digio_request_id, {});
    const r = await appRow();
    expect(r.bond_pdf_path).toBeTruthy();
    expect(String(r.bond_pdf_path)).toContain('bonds/');
    expect(r.bond_generated_at).not.toBeNull();
  });
});
