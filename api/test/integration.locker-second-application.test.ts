/**
 * A SECOND locker for a customer who already has one (owner 2026-09-10:
 * "eashwar customer has multiple lockers and when i go to add another locker
 * for him premium customer is getting auto filled … for each locker it has its
 * own payment collections").
 *
 * LockerHub's A7 does not always create. While a customer has an unfinished
 * application, `POST /locker-applications` answers with THAT one — same id,
 * same APP-number — and says nothing about having done so. The enrolment screen
 * then showed the earlier locker's application as the new one, wearing its rent
 * state: waiver, "★ Premium — rent free", payments already collected.
 *
 * The mock here reproduces that exactly: one open application per phone.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';
import { config } from '../src/config.js';

let ctx: TestCtx;
let mock: Server;

/** phone -> the one open application LockerHub keeps for them. */
const openApp = new Map<string, string>();
let seq = 0;

beforeAll(async () => {
  ctx = await startTestServer();
  mock = createServer((req, res) => {
    let raw = ''; req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://x');
      const body = raw ? JSON.parse(raw) : {};
      const send = (code: number, o: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (/\/branches$/.test(url.pathname)) return send(200, { branches: [{ id: 'br1', name: 'Erode' }] });
      if (req.method === 'POST' && /\/locker-applications$/.test(url.pathname)) {
        // THE BEHAVIOUR UNDER TEST: one open application per phone. A second
        // create for the same customer gets the first one back.
        const phone = String(body.phone ?? '');
        if (!openApp.has(phone)) { seq += 1; openApp.set(phone, `la_reuse_${seq}`); }
        const id = openApp.get(phone)!;
        return send(200, { id, application_no: `APP-REUSE-${id.slice(-1)}`, status: 'payment_pending' });
      }
      if (req.method === 'POST' && /\/waiver$/.test(url.pathname)) return send(200, { success: true, leg_settled: true });
      if (req.method === 'GET' && /\/locker-applications\/[^/]+$/.test(url.pathname)) {
        // THE OTHER HALF OF THE BUG: while an application is esign_pending
        // LockerHub sends NO allotment block, so the screen read "not allotted".
        const id = url.pathname.split('/').pop();
        return send(200, { id, application_no: `APP-REUSE-${String(id).slice(-1)}`, status: 'esign_pending', locker_size: 'Large', branch_id: 'br1' });
      }
      if (req.method === 'POST' && /\/allocate$/.test(url.pathname)) {
        return send(200, {
          success: true,
          allotment: { locker_number: String(body.locker_id ?? 'L10-1'), branch_id: 'br1', allotted_on: new Date().toISOString().slice(0, 10) },
          tenant: { phone: '9812000001', branch_id: 'br1' },
        });
      }
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

const admin = async () => {
  const c = new Client(ctx.base);
  await c.post('/api/auth/login', { email: 'admin@dhanam.finance', password: 'ChangeMe_Dev_123' });
  return c;
};
const create = (a: Client, phone: string, extra: Record<string, unknown> = {}) =>
  a.post('/api/lockers/applications', {
    phone, name: 'Multi Locker', branch_id: 'br1', locker_size: 'Large', ...extra,
  });

describe('a second locker cannot ride on the first locker’s application', () => {
  it('refuses once the handed-back application already carries a rent waiver', async () => {
    const a = await admin();
    const phone = '9812000001';
    const first = await create(a, phone, { locker_id: 'lk_1', locker_number: 'L6-14' });
    expect(first.status).toBe(201);
    const appId = String(first.json.application_id ?? first.json.id);

    // The premium the owner gave THIS locker. It is what was bleeding onto the
    // next one — the tick, and the ₹0 rent behind it.
    const prem = await a.post(`/api/lockers/applications/${appId}/premium-rent`, {});
    expect(prem.status).toBe(200);

    // Now enrol a second locker for the same customer. LockerHub answers with
    // the first application; we must not carry on with it.
    const second = await create(a, phone, { locker_id: 'lk_2', locker_number: 'L6-15' });
    expect(second.status).toBe(409);
    expect(second.json.error.detail.reused_application_id).toBe(appId);
    expect(second.json.error.detail.rent_waiver).toBe(true);
    // The message has to name the application: "it already exists" with no
    // reference is what sends staff hunting.
    expect(String(second.json.error.message)).toContain(String(first.json.application_no));

    // And the premium really is still sitting on that application — i.e. this
    // is the state the second enrolment would have inherited.
    const waivers = await a.get(`/api/lockers/applications/${appId}/fee-waivers`);
    expect((waivers.json.rows as any[]).some((w) => w.leg === 'rent' && w.category === 'premium')).toBe(true);
  });

  it('lets a plain re-press through — nothing has happened on it, same size', async () => {
    const a = await admin();
    const phone = '9812000002';
    const first = await create(a, phone);
    expect(first.status).toBe(201);
    // A double-click, or a retry after a lost response. The automatic 100%
    // DEPOSIT waiver every application is born with is not "something happened".
    const again = await create(a, phone);
    expect(again.status).toBe(201);
    expect(again.json.application_id ?? again.json.id).toBe(first.json.application_id ?? first.json.id);
  });

  it('refuses when the handed-back application is for a different size', async () => {
    const a = await admin();
    const phone = '9812000003';
    const first = await create(a, phone);           // Large
    expect(first.status).toBe(201);
    const second = await create(a, phone, { locker_size: 'Extra Large' });
    expect(second.status).toBe(409);
    expect(String(second.json.error.message)).toMatch(/Large/);
  });
});

describe('one application, one locker', () => {
  it('refuses to allot a DIFFERENT locker onto an application already allotted', async () => {
    const a = await admin();
    const phone = '9812000004';
    const first = await create(a, phone);
    const appId = String(first.json.application_id ?? first.json.id);

    const allot = await a.post(`/api/lockers/applications/${appId}/allocate`, {
      locker_id: 'L10-1', locker_number: 'L10-1',
      override: { reason: 'Rent yet to be paid — allotted per policy', approved_by: 'Tester' },
    });
    expect(allot.status).toBe(200);

    // Our record is keyed on the application, so a second locker here would
    // REPLACE the first — one rent for two boxes, and the first traceable only
    // in the audit log. This is the case that actually lost data in production.
    const second = await a.post(`/api/lockers/applications/${appId}/allocate`, {
      locker_id: 'L10-9', locker_number: 'L10-9',
      override: { reason: 'Rent yet to be paid — allotted per policy', approved_by: 'Tester' },
    });
    expect(second.status).toBe(409);
    expect(String(second.json.error.message)).toMatch(/already allotted/i);

    // The first locker is untouched.
    const row = (await ctx.db.query(
      'SELECT locker_no FROM locker_allotments WHERE lockerhub_application_id = $1', [appId])).rows[0] as any;
    expect(row.locker_no).toBe('L10-1');
  });

  it('a resumed application still reports the locker LockerHub does not echo', async () => {
    const a = await admin();
    const phone = '9812000006';
    const first = await create(a, phone);
    const appId = String(first.json.application_id ?? first.json.id);
    await a.post(`/api/lockers/applications/${appId}/allocate`, {
      locker_id: 'L12-7', locker_number: 'L12-7',
      override: { reason: 'Rent yet to be paid — allotted per policy', approved_by: 'Tester' },
    });

    // Their GET says esign_pending and carries no allotment. Ours has to, or
    // the screen offers "Allot" for a box the customer is already holding —
    // which is how a second locker got onto one application in the first place.
    const resumed = await a.get(`/api/lockers/applications/${appId}`);
    expect(resumed.status).toBe(200);
    expect(resumed.json.allotment?.locker_number).toBe('L12-7');
    // Labelled, so nobody reads our record as LockerHub's answer.
    expect(resumed.json.allotment?.source).toBe('ncd-record');
  });

  it('re-driving the SAME locker still goes through, as it always did', async () => {
    const a = await admin();
    const phone = '9812000005';
    const first = await create(a, phone);
    const appId = String(first.json.application_id ?? first.json.id);
    const body = {
      locker_id: 'L11-3', locker_number: 'L11-3',
      override: { reason: 'Rent yet to be paid — allotted per policy', approved_by: 'Tester' },
    };
    expect((await a.post(`/api/lockers/applications/${appId}/allocate`, body)).status).toBe(200);
    // A lost response, pressed again. Not a second locker — the same one.
    expect((await a.post(`/api/lockers/applications/${appId}/allocate`, body)).status).toBe(200);
  });
});
