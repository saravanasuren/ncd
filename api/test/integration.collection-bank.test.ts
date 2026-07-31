/**
 * "Credited to which Dhanam account" on an investment (Wealth had it; NCD never
 * captured it). Settable at creation and markable later, and surfaced on the
 * application with its label.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx, requiredInvestmentFields } from './helpers/server.js';

let ctx: TestCtx;
let seriesId: number, schemeId: number, bankId: number;
const as = async (email: string, password = 'Demo_1234') => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c; };
const admin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');

beforeAll(async () => {
  ctx = await startTestServer();
  seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
  schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
  bankId = Number((await ctx.db.query('SELECT id FROM banks ORDER BY id LIMIT 1')).rows[0]!.id);
});
afterAll(async () => { await ctx.close(); });

const book = async (a: Client, phone: string, extra: Record<string, unknown> = {}) => {
  const cust = await a.post('/api/customers', { full_name: 'Credited Acct', phone });
  const app = await a.post('/api/applications', {
    ...requiredInvestmentFields(), customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId,
    amount: 100000, date_money_received: '2026-07-12', ...extra,
  });
  expect(app.status).toBe(201);
  return Number(app.json.id);
};

describe('investment credited-to Dhanam account', () => {
  it('is set at creation and shown with its label', async () => {
    const a = await admin();
    const appId = await book(a, '9849000001', { collection_bank_id: bankId });
    const det = await a.get(`/api/applications/${appId}`);
    expect(Number(det.json.application.collection_bank_id)).toBe(bankId);
    expect(det.json.application.collection_bank_account).toBeTruthy();  // joined label present
  });

  it('defaults to null and can be marked / cleared later', async () => {
    const a = await admin();
    const appId = await book(a, '9849000002');
    expect((await a.get(`/api/applications/${appId}`)).json.application.collection_bank_id).toBeNull();

    expect((await a.post(`/api/applications/${appId}/collection-bank`, { bank_id: bankId })).status).toBe(200);
    expect(Number((await a.get(`/api/applications/${appId}`)).json.application.collection_bank_id)).toBe(bankId);

    await a.post(`/api/applications/${appId}/collection-bank`, { bank_id: null });
    expect((await a.get(`/api/applications/${appId}`)).json.application.collection_bank_id).toBeNull();
  });

  it('rejects an unknown Dhanam account', async () => {
    const a = await admin();
    const appId = await book(a, '9849000003');
    expect((await a.post(`/api/applications/${appId}/collection-bank`, { bank_id: 999999 })).status).toBe(400);
  });
});
