/**
 * /api/lookups/ifsc wiring — auth-gated, and an invalid code returns
 * { found:false } (which short-circuits before any network call, so this test
 * never leaves the process). A valid-code lookup is covered by the injected-
 * fetch unit test in ifsc-lookup.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
beforeAll(async () => { ctx = await startTestServer(); });
afterAll(async () => { await ctx.close(); });

const as = async (email: string, password = 'Demo_1234') => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c; };

describe('GET /api/lookups/ifsc/:code', () => {
  it('needs authentication', async () => {
    const anon = new Client(ctx.base);
    expect((await anon.get('/api/lookups/ifsc/HDFC0000001')).status).toBe(401);
  });

  it('a malformed IFSC resolves to found:false (no network)', async () => {
    const staff = await as('staff@demo.local');
    const r = await staff.get('/api/lookups/ifsc/NOTACODE');
    expect(r.status).toBe(200);
    expect(r.json.found).toBe(false);
  });
});
