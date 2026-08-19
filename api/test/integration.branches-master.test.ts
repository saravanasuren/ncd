/**
 * Branches master (owner 2026-08-14): add/manage office branches from Masters,
 * the same way Schemes/Banks work. Backs the "Branches" screen so branches no
 * longer need a DB seed to exist.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
beforeAll(async () => { ctx = await startTestServer(); });
afterAll(async () => { await ctx.close(); });

async function admin() { const c = new Client(ctx.base); await c.post('/api/auth/login', { email: 'admin@dhanam.finance', password: 'ChangeMe_Dev_123' }); return c; }

describe('branches master CRUD', () => {
  it('creates a branch, lists it, and toggles active', async () => {
    const a = await admin();
    const created = await a.post('/api/branches', { code: 'cbe', name: 'Coimbatore', city: 'Coimbatore', district: 'Coimbatore' });
    expect(created.status).toBe(201);
    expect(created.json.code).toBe('CBE'); // upper-cased

    const list = await a.get('/api/branches');
    const row = list.json.rows.find((b: any) => b.code === 'CBE');
    expect(row, 'new branch is listed').toBeTruthy();
    expect(row.name).toBe('Coimbatore');
    expect(row.is_active).toBe(true);
    expect(row.state).toBe('Tamil Nadu'); // defaulted

    // Deactivate, then reactivate.
    expect((await a.put(`/api/branches/${row.id}/active`, { is_active: false })).status).toBe(200);
    const off = (await a.get('/api/branches')).json.rows.find((b: any) => b.id === row.id);
    expect(off.is_active).toBe(false);
    await a.put(`/api/branches/${row.id}/active`, { is_active: true });
    const on = (await a.get('/api/branches')).json.rows.find((b: any) => b.id === row.id);
    expect(on.is_active).toBe(true);
  });

  it('rejects a duplicate code and missing fields', async () => {
    const a = await admin();
    await a.post('/api/branches', { code: 'DUP1', name: 'First' });
    expect((await a.post('/api/branches', { code: 'dup1', name: 'Second (same code)' })).status).toBe(409);
    expect((await a.post('/api/branches', { code: '', name: 'No code' })).status).toBe(400);
    expect((await a.post('/api/branches', { code: 'NC1', name: '' })).status).toBe(400);
  });
});
