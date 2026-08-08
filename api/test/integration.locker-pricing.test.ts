/**
 * NCD-owned locker pricing (owner 2026-08-07): per-size deposit + rent, editable
 * in Masters, seeded with the owner's deposits (XL 60k / L 40k / M 20k) and rent
 * left blank.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
beforeAll(async () => { ctx = await startTestServer(); });
afterAll(async () => { await ctx.close(); });
const admin = async () => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email: 'admin@dhanam.finance', password: 'ChangeMe_Dev_123' }); return c; };

describe('locker pricing', () => {
  it('seeds the owner deposits with blank rent', async () => {
    const a = await admin();
    const r = await a.get('/api/locker-pricing');
    expect(r.status).toBe(200);
    const bySize = Object.fromEntries(r.json.rows.map((x: any) => [x.size, x]));
    expect(bySize.XL.deposit_amount).toBe(60000);
    expect(bySize.L.deposit_amount).toBe(40000);
    expect(bySize.M.deposit_amount).toBe(20000);
    expect(bySize.XL.annual_rent).toBeNull();   // rent set later in the UI
  });

  it('updates a size and accepts a new one', async () => {
    const a = await admin();
    const up = await a.put('/api/locker-pricing/XL', { deposit_amount: 65000, annual_rent: 5000 });
    expect(up.status).toBe(200);
    const add = await a.put('/api/locker-pricing/Jumbo', { deposit_amount: 100000, annual_rent: null });
    expect(add.status).toBe(200);

    const r = await a.get('/api/locker-pricing');
    const bySize = Object.fromEntries(r.json.rows.map((x: any) => [x.size, x]));
    expect(bySize.XL.deposit_amount).toBe(65000);
    expect(bySize.XL.annual_rent).toBe(5000);
    expect(bySize.Jumbo.deposit_amount).toBe(100000);
    expect(bySize.Jumbo.annual_rent).toBeNull();
  });

  it('is gated by products:manage', async () => {
    const staff = new Client(ctx.base);
    await staff.post('/api/auth/login', { email: 'staff@demo.local', password: 'Demo_1234' });
    const r = await staff.put('/api/locker-pricing/M', { deposit_amount: 1 });
    expect(r.status).toBe(403);
  });
});
