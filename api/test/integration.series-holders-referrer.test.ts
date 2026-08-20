/**
 * Series holders — demat report (owner 2026-08-20): each holder row now carries
 * the referrer NAME. Pins that seriesHoldersReport resolves + returns it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, approveInvestment, type TestCtx, requiredInvestmentFields } from './helpers/server.js';
import * as book from '../src/modules/reports/book.js';
import type { AuthUser } from '../src/lib/authUser.js';

let ctx: TestCtx;
let seriesId: number;
let schemeId: number;
let actor: AuthUser;

async function as(email: string, password: string) { const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c; }

beforeAll(async () => {
  ctx = await startTestServer();
  seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
  schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
  const adminId = Number((await ctx.db.query("SELECT id FROM users WHERE email = 'admin@dhanam.finance'")).rows[0]!.id);
  actor = { id: adminId, email: 'admin@dhanam.finance', fullName: 'Admin', role: 'super_admin', permissions: [], branchIds: [], agentId: null, customerId: null };
});
afterAll(async () => { await ctx.close(); });

describe('series holders report — referrer name', () => {
  it('returns the referrer for each holder', async () => {
    const a = await as('admin@dhanam.finance', 'ChangeMe_Dev_123');
    const ncd = await as('ncd@demo.local', 'Demo_1234');
    const cust = await a.post('/api/customers', { full_name: 'Holder Cust', phone: '9701114444', pan: 'HOLDR1234C', referred_by_text: 'Ref Person' });
    const create = await a.post('/api/applications', {
      ...requiredInvestmentFields(), customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId,
      amount: 100000, date_money_received: '2026-07-10',
    });
    await approveInvestment(ncd, create); // → Active, so it's a current holder

    const rows = await book.seriesHoldersReport(ctx.db, actor, seriesId);
    const row = rows.find((r) => r.full_name === 'Holder Cust');
    expect(row, 'holder is in the report').toBeTruthy();
    expect(row!.referred_by).toBe('Ref Person');
    // every row carries the field (null when there's no referrer)
    expect(rows.every((r) => 'referred_by' in r)).toBe(true);
  });
});
