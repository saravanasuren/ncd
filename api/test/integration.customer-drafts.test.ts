/**
 * Draft customers (owner 2026-08-22) — a half-finished enrolment, persisted
 * server-side. A user keeps their own; a SUPER-ADMIN can see every user's
 * in-progress enrolment.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
beforeAll(async () => { ctx = await startTestServer(); });
afterAll(async () => { await ctx.close(); });

const as = async (email: string, password = 'Demo_1234') => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c; };
const superAdmin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');

describe('draft customers', () => {
  it('a user saves their own draft and reads it back', async () => {
    const m = await as('ncd@demo.local');
    const save = await m.put('/api/customers/drafts', { draft: { f: { full_name: 'Half Done' }, step: 1 }, display_name: 'Half Done', display_phone: '9700000001' });
    expect(save.status).toBe(200);
    const mine = await m.get('/api/customers/drafts/mine');
    expect((mine.json as any).draft.f.full_name).toBe('Half Done');
    // Their own list shows just theirs, not flagged all.
    const list = await m.get('/api/customers/drafts');
    expect(list.json.all).toBe(false);
    expect(list.json.rows.every((r: any) => r.mine)).toBe(true);
    expect(list.json.rows.find((r: any) => r.display_name === 'Half Done')).toBeTruthy();
  });

  it('a super-admin sees every user\'s draft, with the owner named', async () => {
    const sa = await superAdmin();
    await sa.put('/api/customers/drafts', { draft: { f: { full_name: 'Admin WIP' } }, display_name: 'Admin WIP', display_phone: '9700000002' });

    const list = await sa.get('/api/customers/drafts');
    expect(list.json.all).toBe(true);
    const names = list.json.rows.map((r: any) => r.display_name);
    expect(names).toContain('Half Done');   // another user's draft
    expect(names).toContain('Admin WIP');    // their own
    const others = list.json.rows.find((r: any) => r.display_name === 'Half Done');
    expect(others.mine).toBe(false);
    expect(others.owner_name).toBeTruthy();  // who started it
  });

  it('a non-super user does NOT see another user\'s draft', async () => {
    const staff = await as('staff@demo.local');
    const list = await staff.get('/api/customers/drafts');
    expect(list.json.all).toBe(false);
    expect(list.json.rows.map((r: any) => r.display_name)).not.toContain('Admin WIP');
  });

  it('discarding removes it', async () => {
    const m = await as('ncd@demo.local');
    expect((await m.del('/api/customers/drafts/mine')).status).toBe(200);
    expect(await (await m.get('/api/customers/drafts/mine')).json).toBeNull();
  });
});
