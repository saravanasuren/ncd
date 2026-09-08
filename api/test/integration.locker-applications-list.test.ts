/**
 * The Locker Applications list (owner 2026-09-08).
 *
 * What broke: NCD created locker applications and kept no index of them.
 * LockerHub publishes no list endpoint, `GET /applications/:id` needs an id
 * like `mts88mk6d0a6l7h`, and nothing on any screen ever showed one — so once
 * the enrolment tab closed the application was unreachable. It could not be
 * resumed and it could not be deleted. 45 were live and invisible in
 * production when this was found.
 *
 * So the load-bearing assertion here is the FIRST one: creating an application
 * puts it on the list. Everything else on this page is reachable only through
 * that row. The delete tests are the other half of the owner's sentence —
 * "when i create a locker application it should get created and if i delete it
 * should get deleted".
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';
import { config } from '../src/config.js';

let ctx: TestCtx;
let mock: Server;
let seen: Array<{ path: string; method: string; body: any }> = [];
/** Applications the fake LockerHub has, and whether it will allow a cancel. */
const upstream = new Map<string, { status: string; cancellable: boolean }>();
let nextId = 1;

beforeAll(async () => {
  ctx = await startTestServer();
  mock = createServer((req, res) => {
    let raw = ''; req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      const url = new URL(req.url ?? '/', 'http://x');
      const p = url.pathname;
      seen.push({ path: p, method: req.method ?? '', body });
      const send = (code: number, obj: unknown) => {
        res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj));
      };

      if (p === '/locker-applications' && req.method === 'POST') {
        const id = `lhapp_${nextId++}`;
        upstream.set(id, { status: 'created', cancellable: true });
        return send(200, { id, status: 'created', branch_name: 'Erode', locker_size: body.locker_size });
      }
      let m = /^\/locker-applications\/([^/]+)\/cancel$/.exec(p);
      if (m && req.method === 'POST') {
        const a = upstream.get(m[1]!);
        if (!a) return send(404, { error: 'not_found' });
        if (!a.cancellable) return send(409, { error: 'payment_collected', message: 'payment_collected' });
        a.status = 'cancelled';
        return send(200, { success: true, locker_released: 'L1-1' });
      }
      m = /^\/locker-applications\/([^/]+)$/.exec(p);
      if (m && req.method === 'GET') {
        const a = upstream.get(m[1]!);
        if (!a) return send(404, { error: 'not_found' });
        return send(200, { id: m[1], status: a.status, branch_name: 'Erode', locker_size: 'Medium', locker_no: 'M1-2' });
      }
      if (/\/waiver$/.test(p) && req.method === 'POST') return send(200, { success: true, leg: body.leg });
      return send(404, { error: 'not found' });
    });
  });
  await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r));
  const addr = mock.address();
  config.LOCKERHUB_API_URL = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});
afterAll(async () => {
  config.LOCKERHUB_API_URL = '';
  await new Promise<void>((r) => mock.close(() => r()));
  await ctx.close();
});

const as = async (email: string, password = 'Demo_1234') => {
  const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c;
};
const manager = () => as('ncd@demo.local');
const superAdmin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');

const create = async (client: Client, over: Record<string, unknown> = {}) =>
  client.post('/api/lockers/applications', {
    phone: '9876500011', name: 'Locker Lister', branch_id: 'br_erode', locker_size: 'Medium', ...over,
  });
const listOf = async (client: Client, qs = '') =>
  client.get(`/api/lockers/applications${qs}`);

describe('locker applications list', () => {
  let appId = '';

  it('creating an application puts it on the list — the whole point', async () => {
    seen = [];
    const r = await create(await manager());
    expect(r.status).toBe(201);
    appId = String(r.json.id);
    expect(appId).toBeTruthy();

    const l = await listOf(await manager());
    expect(l.status).toBe(200);
    const row = l.json.rows.find((x: any) => x.lockerhub_application_id === appId);
    expect(row).toBeTruthy();
    // The details the branch needs to recognise it, without opening anything.
    expect(row.customer_name).toBe('Locker Lister');
    expect(row.phone).toBe('9876500011');
    expect(row.locker_size).toBe('Medium');
    expect(row.removed_at).toBeNull();
  });

  it('the row survives a LockerHub outage — the index is OURS', async () => {
    // The failure this list exists to prevent is an application nobody can find.
    // If it were read from LockerHub it would vanish whenever they did.
    const saved = config.LOCKERHUB_API_URL;
    config.LOCKERHUB_API_URL = 'http://127.0.0.1:1';   // nothing listening
    try {
      const l = await listOf(await manager());
      expect(l.status).toBe(200);
      expect(l.json.rows.some((x: any) => x.lockerhub_application_id === appId)).toBe(true);
    } finally { config.LOCKERHUB_API_URL = saved; }
  });

  it('is searchable by name, phone and locker id', async () => {
    for (const q of ['Locker Lister', '9876500011', appId]) {
      const l = await listOf(await manager(), `?q=${encodeURIComponent(q)}`);
      expect(l.json.rows.some((x: any) => x.lockerhub_application_id === appId)).toBe(true);
    }
    const none = await listOf(await manager(), '?q=zzz-nobody-zzz');
    expect(none.json.rows).toHaveLength(0);
  });

  it('refresh re-reads LockerHub and updates the cached row', async () => {
    const r = await (await manager()).post(`/api/lockers/applications/${appId}/refresh`, {});
    expect(r.json.ok).toBe(true);
    const l = await listOf(await manager());
    const row = l.json.rows.find((x: any) => x.lockerhub_application_id === appId);
    expect(row.status).toBe('created');
    expect(row.locker_number).toBe('M1-2');
    expect(row.status_checked_at).toBeTruthy();
  });

  it('refresh on an application LockerHub has forgotten does NOT throw', async () => {
    // These are exactly the rows a user is trying to tidy up. A 500 here would
    // break the page on the rows that most need clearing.
    const r = await (await manager()).post('/api/lockers/applications/lhapp_does_not_exist/refresh', {});
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(false);
    expect(r.json.error).toBeTruthy();
  });

  it('deleting it cancels on LockerHub and drops it off the live list', async () => {
    seen = [];
    const r = await (await superAdmin()).post(`/api/lockers/applications/${appId}/remove`,
      { reason: 'entered by mistake' });
    expect(r.status).toBe(200);
    expect(r.json.cancelled).toBe(true);
    expect(seen.some((s) => s.path === `/locker-applications/${appId}/cancel`)).toBe(true);
    expect(upstream.get(appId)!.status).toBe('cancelled');

    const live = await listOf(await superAdmin());
    expect(live.json.rows.some((x: any) => x.lockerhub_application_id === appId)).toBe(false);

    // Still visible under Deleted, with the reason — removed, not erased.
    const gone = await listOf(await superAdmin(), '?show=removed');
    const row = gone.json.rows.find((x: any) => x.lockerhub_application_id === appId);
    expect(row).toBeTruthy();
    expect(row.removed_at).toBeTruthy();
    expect(row.removed_reason).toBe('entered by mistake');
  });

  it('a paid application is refused, and NOTHING is hidden locally', async () => {
    // The two sides must not disagree: if LockerHub still holds it, so do we,
    // unless a Super Admin deliberately forces the local-only removal.
    const c = await create(await manager(), { phone: '9876500022', name: 'Paid Already' });
    const paidId = String(c.json.id);
    upstream.get(paidId)!.cancellable = false;

    const r = await (await superAdmin()).post(`/api/lockers/applications/${paidId}/remove`,
      { reason: 'trying to delete a paid one' });
    expect(r.status).toBe(409);

    const live = await listOf(await superAdmin());
    expect(live.json.rows.some((x: any) => x.lockerhub_application_id === paidId)).toBe(true);
  });

  it('force_local hides a refused one, and says LockerHub still holds it', async () => {
    const c = await create(await manager(), { phone: '9876500033', name: 'Force Local' });
    const id = String(c.json.id);
    upstream.get(id)!.cancellable = false;

    const r = await (await superAdmin()).post(`/api/lockers/applications/${id}/remove`,
      { reason: 'settled with LockerHub out of band', force_local: true });
    expect(r.status).toBe(200);
    expect(r.json.cancelled).toBe(false);
    expect(r.json.lockerhub_kept).toBe(true);
    expect(upstream.get(id)!.status).not.toBe('cancelled');   // theirs is untouched

    const live = await listOf(await superAdmin());
    expect(live.json.rows.some((x: any) => x.lockerhub_application_id === id)).toBe(false);
  });

  it('CONTROL: only a Super Admin may delete', async () => {
    const c = await create(await manager(), { phone: '9876500044', name: 'Not Yours' });
    const id = String(c.json.id);
    const r = await (await manager()).post(`/api/lockers/applications/${id}/remove`, { reason: 'nope' });
    expect(r.status).toBe(403);
    const live = await listOf(await manager());
    expect(live.json.rows.some((x: any) => x.lockerhub_application_id === id)).toBe(true);
  });
});
