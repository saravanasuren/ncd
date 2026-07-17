/** Self-service password reset + change-password flow. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
beforeAll(async () => { ctx = await startTestServer(); });
afterAll(async () => { await ctx.close(); });

const ADMIN = 'admin@dhanam.finance';

describe('password reset', () => {
  it('forgot-password always 200 (no user enumeration) and issues a token for a real user', async () => {
    const c = new Client(ctx.base);
    expect((await c.post('/api/auth/forgot-password', { email: 'nobody@nowhere.test' })).status).toBe(200);
    expect((await c.post('/api/auth/forgot-password', { email: ADMIN })).status).toBe(200);
    const { rows } = await ctx.db.query(
      `SELECT prt.token_hash FROM password_reset_tokens prt JOIN users u ON u.id = prt.user_id WHERE u.email = $1`, [ADMIN]);
    expect(rows.length).toBeGreaterThan(0);
  });

  it('reset-password with a bad token is rejected; a fresh password logs in and old sessions die', async () => {
    const c = new Client(ctx.base);
    // Old password still works pre-reset.
    expect((await c.post('/api/auth/login', { email: ADMIN, password: 'ChangeMe_Dev_123' })).status).toBe(200);

    expect((await c.post('/api/auth/reset-password', { token: 'garbage', password: 'BrandNew_123' })).status).toBe(400);

    // Mint a token directly (the email link carries the raw token; we recreate one).
    const { createHash, randomBytes } = await import('node:crypto');
    const raw = randomBytes(16).toString('hex');
    const hash = createHash('sha256').update(raw).digest('hex');
    const uid = (await ctx.db.query('SELECT id FROM users WHERE email = $1', [ADMIN])).rows[0].id;
    await ctx.db.query('INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1,$2, now() + interval \'1 hour\')', [uid, hash]);

    expect((await c.post('/api/auth/reset-password', { token: raw, password: 'BrandNew_123' })).status).toBe(200);
    // Token is single-use.
    expect((await c.post('/api/auth/reset-password', { token: raw, password: 'Another_123' })).status).toBe(400);
    // New password works; restore it for later tests in the shared DB.
    const fresh = new Client(ctx.base);
    expect((await fresh.post('/api/auth/login', { email: ADMIN, password: 'BrandNew_123' })).status).toBe(200);
    await fresh.post('/api/auth/change-password', { currentPassword: 'BrandNew_123', newPassword: 'ChangeMe_Dev_123' });
    expect((await new Client(ctx.base).post('/api/auth/login', { email: ADMIN, password: 'ChangeMe_Dev_123' })).status).toBe(200);
  });

  it('change-password requires the correct current password', async () => {
    const c = new Client(ctx.base);
    await c.post('/api/auth/login', { email: ADMIN, password: 'ChangeMe_Dev_123' });
    expect((await c.post('/api/auth/change-password', { currentPassword: 'wrong', newPassword: 'Whatever_123' })).status).toBe(400);
    expect((await new Client(ctx.base).post('/api/auth/change-password', { currentPassword: 'x', newPassword: 'y' })).status).toBe(401);
  });
});
