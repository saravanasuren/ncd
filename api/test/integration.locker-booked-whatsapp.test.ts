/**
 * A successful locker allocation queues a WhatsApp booking confirmation to the
 * customer (owner 2026-08-07) — best-effort, only after a real allocation, and
 * never blocking the allocate response.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';
import { config } from '../src/config.js';

let ctx: TestCtx;
let mock: Server;
let allocateOk = true;

beforeAll(async () => {
  ctx = await startTestServer();
  mock = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const send = (code: number, obj: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (/\/allocate$/.test(url.pathname) && req.method === 'POST') {
      if (!allocateOk) return send(409, { error: 'locker no longer vacant' });
      return send(200, { success: true, tenant: { name: 'Locker Buyer', phone: '9847011111', locker_no: 'A-7', branch_name: 'Dindigul' } });
    }
    return send(404, { error: 'not found' });
  });
  await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r));
  const addr = mock.address();
  config.LOCKERHUB_API_URL = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});
afterAll(async () => { config.LOCKERHUB_API_URL = ''; await new Promise<void>((r) => mock.close(() => r())); await ctx.close(); });

const admin = async () => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email: 'admin@dhanam.finance', password: 'ChangeMe_Dev_123' }); return c; };
const bookedRows = async () => (await ctx.db.query("SELECT to_address, payload FROM notifications_queue WHERE channel = 'whatsapp' AND template = 'locker_booked'")).rows as any[];

describe('locker booking WhatsApp', () => {
  it('queues a confirmation to the customer after a successful allocation', async () => {
    const a = await admin();
    const r = await a.post('/api/lockers/applications/la_book_1/allocate', { locker_id: 'lk1', lease_months: 12 });
    expect(r.status).toBe(200);
    // enqueue is async/best-effort — give the fire-and-forget a tick.
    await new Promise((res) => setTimeout(res, 150));
    const rows = await bookedRows();
    const mine = rows.find((x) => String(x.to_address).includes('9847011111'));
    expect(mine).toBeTruthy();
    expect(mine.payload.locker_no).toBe('A-7');
    expect(mine.payload.name).toBe('Locker Buyer');
  });

  it('queues nothing when the allocation fails', async () => {
    const a = await admin();
    allocateOk = false;
    try {
      const before = (await bookedRows()).length;
      const r = await a.post('/api/lockers/applications/la_book_2/allocate', { locker_id: 'lk2' });
      expect(r.status).toBeGreaterThanOrEqual(400);   // allocation failed
      await new Promise((res) => setTimeout(res, 100));
      expect((await bookedRows()).length).toBe(before);
    } finally { allocateOk = true; }
  });
});
