/**
 * The "Credited to…" dropdown asked the wrong URL.
 *
 * `productsRouter` is mounted at `/api`, so its `/banks` route is **`/api/banks`**.
 * Both selects that let staff record which Dhanam account received an
 * investment asked for `/api/products/banks`, which is a 404. react-query left
 * `data` undefined, `?? []` turned that into an empty option list, and the
 * dropdown read as "no accounts configured" rather than "this request failed" —
 * so it sat broken while Masters, which asks the right URL, showed all six
 * accounts.
 *
 * Production at the time: 6 company accounts configured, and 576 of 808
 * applications with no credited-to recorded.
 *
 * These tests pin the CONTRACT the screens depend on, so the path cannot drift
 * again without something going red.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
beforeAll(async () => { ctx = await startTestServer(); });
afterAll(async () => { await ctx.close(); });

const as = async (email: string, password = 'Demo_1234') => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c; };
const admin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');

describe('the company-accounts endpoint the Credited-to selects call', () => {
  beforeAll(async () => {
    await ctx.db.query(
      `INSERT INTO banks (account_label, bank_name, account_number, ifsc, is_collection_account, is_disbursement_account, is_active)
       VALUES ('NCD - Escrow - Test','State Bank of India','45352882769','SBIN0012778',TRUE,FALSE,TRUE),
              ('Payout Only - Test','Federal Bank','19820200007409','FDRL0001982',FALSE,TRUE,TRUE)`);
  });

  it('lives at /api/banks', async () => {
    const r = await (await admin()).get('/api/banks');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.json.rows)).toBe(true);
    expect(r.json.rows.length).toBeGreaterThan(0);
  });

  it('/api/products/banks does NOT exist — the path the selects used to ask for', async () => {
    const r = await (await admin()).get('/api/products/banks');
    expect(r.status).toBe(404);
  });

  it('carries the fields the dropdown filters and labels on', async () => {
    const r = await (await admin()).get('/api/banks');
    const bank = (r.json.rows as any[]).find((b) => b.account_label === 'NCD - Escrow - Test');
    expect(bank).toBeTruthy();
    for (const f of ['id', 'account_label', 'bank_name', 'account_number', 'is_collection_account', 'is_active']) {
      expect(bank, `missing ${f}`).toHaveProperty(f);
    }
  });

  it('a collection account survives the exact filter the New Investment select applies', async () => {
    const r = await (await admin()).get('/api/banks');
    const offered = (r.json.rows as any[]).filter((b) => b.is_collection_account && b.is_active);
    expect(offered.length).toBeGreaterThan(0);
    expect(offered.map((b) => b.account_label)).toContain('NCD - Escrow - Test');
    // A disbursement-only account is deliberately not offered as "credited to".
    expect(offered.map((b) => b.account_label)).not.toContain('Payout Only - Test');
  });

  it('any signed-in staff member can read it — the select renders for all of them', async () => {
    const r = await (await as('staff@demo.local')).get('/api/banks');
    expect(r.status).toBe(200);
  });

  it('is not public', async () => {
    const r = await fetch(`${ctx.base}/api/banks`);
    expect(r.status).toBe(401);
  });
});
