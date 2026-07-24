/** Locker-deposit flag: staff can set it at creation and correct it later;
 * the LockerHub integration path keeps flagging automatically (untouched). */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx, requiredInvestmentFields } from './helpers/server.js';

let ctx: TestCtx;
let seriesId: number;
let schemeId: number;

beforeAll(async () => {
  ctx = await startTestServer();
  seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
  schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
});
afterAll(async () => { await ctx.close(); });

const admin = async () => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email: 'admin@dhanam.finance', password: 'ChangeMe_Dev_123' }); return c; };

describe('locker-deposit flag (manual path)', () => {
  it('checkbox at creation persists; toggle endpoint corrects it', async () => {
    const a = await admin();
    const cust = await a.post('/api/customers', { full_name: 'Locker Cust', phone: '9766600001' });
    const app = await a.post('/api/applications', { ...requiredInvestmentFields(),
      customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId, amount: 200000, is_locker_deposit: true,
    });
    let row = (await ctx.db.query('SELECT is_locker_deposit FROM applications WHERE id = $1', [app.json.id])).rows[0] as any;
    expect(row.is_locker_deposit).toBe(true);

    const off = await a.post(`/api/applications/${app.json.id}/locker-deposit`, { is_locker_deposit: false });
    expect(off.status).toBe(200);
    row = (await ctx.db.query('SELECT is_locker_deposit FROM applications WHERE id = $1', [app.json.id])).rows[0] as any;
    expect(row.is_locker_deposit).toBe(false);
  });

  it('defaults to false when the checkbox is not sent', async () => {
    const a = await admin();
    const cust = await a.post('/api/customers', { full_name: 'Normal Cust', phone: '9766600002' });
    const app = await a.post('/api/applications', { ...requiredInvestmentFields(), customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId, amount: 100000 });
    const row = (await ctx.db.query('SELECT is_locker_deposit FROM applications WHERE id = $1', [app.json.id])).rows[0] as any;
    expect(row.is_locker_deposit).toBe(false);
  });
});
