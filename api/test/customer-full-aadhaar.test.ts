/**
 * Full-Aadhaar capture (owner decision 2026-07-21 — printed on the application
 * form). A supplied 12-digit Aadhaar is stored in full and last-4 is derived
 * from it; without one, only last-4 is kept (the prior masking behaviour).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
beforeAll(async () => { ctx = await startTestServer(); });
afterAll(async () => { await ctx.close(); });
const admin = async () => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email: 'admin@dhanam.finance', password: 'ChangeMe_Dev_123' }); return c; };
const row = async (id: number) => (await ctx.db.query('SELECT aadhaar, aadhaar_last4 FROM customers WHERE id = $1', [id])).rows[0] as { aadhaar: string | null; aadhaar_last4: string | null };

describe('full Aadhaar capture', () => {
  it('stores the full 12-digit Aadhaar and derives last-4', async () => {
    const a = await admin();
    const r = await a.post('/api/customers', { full_name: 'Aadhaar Full Cust', phone: '9846500011', aadhaar: '1234 5678 9012' });
    const c = await row(r.json.id);
    expect(c.aadhaar).toBe('123456789012');
    expect(c.aadhaar_last4).toBe('9012');
  });

  it('keeps last-4 only when no full Aadhaar is supplied', async () => {
    const a = await admin();
    const r = await a.post('/api/customers', { full_name: 'Aadhaar LastFour Cust', phone: '9846500012', aadhaar_last4: '5678' });
    const c = await row(r.json.id);
    expect(c.aadhaar).toBeNull();
    expect(c.aadhaar_last4).toBe('5678');
  });

  it('rejects a non-12-digit full Aadhaar (stores neither)', async () => {
    const a = await admin();
    const r = await a.post('/api/customers', { full_name: 'Aadhaar Bad Cust', phone: '9846500013', aadhaar: '12345' });
    const c = await row(r.json.id);
    expect(c.aadhaar).toBeNull();
    expect(c.aadhaar_last4).toBeNull();
  });
});
