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
const upstream = new Map<string, {
  status: string; cancellable: boolean; no: string;
  /** How this one refuses a cancel: HTTP code + LockerHub's real prose. */
  refuseWith?: { code: number; message: string };
}>();
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
        const n = nextId++;
        const id = `lhapp_${n}`;
        upstream.set(id, { status: 'created', cancellable: true, no: `APP-2026-0${1200 + n}` });
        return send(200, { id, application_no: `APP-2026-0${1200 + n}`, status: 'created', locker_size: body.locker_size });
      }
      if (p === '/branches' && req.method === 'GET') {
        return send(200, { branches: [{ id: 'br_erode', name: 'Erode' }] });
      }
      let m = /^\/locker-applications\/([^/]+)\/cancel$/.exec(p);
      if (m && req.method === 'POST') {
        const a = upstream.get(m[1]!);
        if (!a) return send(404, { error: 'not_found' });
        if (!a.cancellable) {
          // LockerHub's REAL refusal wording, copied from production. Note there
          // is no `live_tenancy` token anywhere in it — matching on one is what
          // broke this.
          const r = a.refuseWith ?? { code: 409, message: 'payment_collected' };
          return send(r.code, { error: r.message, message: r.message });
        }
        a.status = 'cancelled';
        return send(200, { success: true, locker_released: 'L1-1' });
      }
      m = /^\/locker-applications\/([^/]+)$/.exec(p);
      if (m && req.method === 'GET') {
        const a = upstream.get(m[1]!);
        if (!a) return send(404, { error: 'not_found' });
        // THIS SHAPE IS COPIED FROM A LIVE LOCKERHUB RESPONSE, deliberately.
        // The first version of this mock returned `branch_name` and `locker_no`
        // because that is what our code happened to read — so the test proved
        // our own guess, passed, and 42 of 50 production rows still refreshed
        // to a blank Customer column. A mock that echoes the caller's
        // assumptions cannot catch a wrong assumption.
        return send(200, {
          application_id: m[1],
          application_no: a.no,
          status: a.status,
          phone: '9876500011',
          name: 'Locker Lister',
          branch_id: 'br_erode',          // no branch_name — we resolve it from /branches
          locker_size: 'Medium',
          legs: { rent: { amount: 6000, settled: false }, deposit: { amount: 0, settled: true } },
          allotment: { locker_number: 'M1-2', size: 'Medium' },   // locker number lives HERE
        });
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

  it('refresh maps every field LockerHub actually sends', async () => {
    // Each assertion below is a field whose name we got WRONG the first time:
    // they send `name` (not customer_name), `application_no`, the locker number
    // under `allotment`, and only a `branch_id` that has to be resolved to a
    // name through /branches.
    const r = await (await manager()).post(`/api/lockers/applications/${appId}/refresh`, {});
    expect(r.json.ok).toBe(true);
    const l = await listOf(await manager());
    const row = l.json.rows.find((x: any) => x.lockerhub_application_id === appId);
    expect(row.status).toBe('created');
    expect(row.customer_name).toBe('Locker Lister');    // from `name`
    expect(row.application_no).toMatch(/^APP-2026-/);   // their human reference
    expect(row.locker_number).toBe('M1-2');             // from allotment.locker_number
    expect(row.locker_size).toBe('Medium');
    expect(row.branch_name).toBe('Erode');              // resolved from branch_id
    expect(row.status_checked_at).toBeTruthy();
  });

  it('is searchable by LockerHub application number', async () => {
    const l = await listOf(await manager());
    const no = l.json.rows.find((x: any) => x.lockerhub_application_id === appId).application_no;
    const hit = await listOf(await manager(), `?q=${encodeURIComponent(no)}`);
    expect(hit.json.rows.some((x: any) => x.lockerhub_application_id === appId)).toBe(true);
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

  // ── The refusal the owner hit on 2026-09-08 ────────────────────────────────
  // LockerHub answers an allotted locker with prose: "Application is approved
  // into a live tenancy — that is a closure/refund, not a cancellation." The
  // first version matched /live_tenancy/ against that, missed, returned a 502,
  // and the UI (which offers the Super-Admin override only on a 409) never
  // showed the way out. An allotted locker could not be deleted at all.
  const LIVE_TENANCY = 'Application is approved into a live tenancy — that is a closure/refund, not a cancellation.';

  it('a prose refusal is a 409 carrying LOCKERHUB\'s own words, not a 502', async () => {
    const c = await create(await manager(), { phone: '9876500055', name: 'Live Tenancy' });
    const id = String(c.json.id);
    const u = upstream.get(id)!;
    u.cancellable = false;
    u.refuseWith = { code: 409, message: LIVE_TENANCY };

    const r = await (await superAdmin()).post(`/api/lockers/applications/${id}/remove`, { reason: 'owner asked' });
    expect(r.status).toBe(409);                       // NOT 502 — the UI keys on this
    expect(r.json.error.message).toContain('live tenancy');
    expect(r.json.error.message).toContain('Super Admin');   // tells them the way out
    // Nothing hidden locally while LockerHub still holds it.
    const live = await listOf(await superAdmin());
    expect(live.json.rows.some((x: any) => x.lockerhub_application_id === id)).toBe(true);
  });

  it('force_local then removes it, and the audit records THEIR reason', async () => {
    const c = await create(await manager(), { phone: '9876500066', name: 'Live Tenancy Two' });
    const id = String(c.json.id);
    const u = upstream.get(id)!;
    u.cancellable = false;
    u.refuseWith = { code: 409, message: LIVE_TENANCY };

    const r = await (await superAdmin()).post(`/api/lockers/applications/${id}/remove`,
      { reason: 'closed with LockerHub by phone', force_local: true });
    expect(r.status).toBe(200);
    expect(r.json.lockerhub_kept).toBe(true);
    expect(upstream.get(id)!.status).not.toBe('cancelled');   // theirs untouched

    const audit = (await ctx.db.query<Record<string, unknown>>(
      `SELECT after_data FROM audit_log WHERE action = 'locker.application.remove' AND entity_id = $1`, [id])).rows[0];
    expect(String((audit!.after_data as any).lockerhub_refusal)).toContain('live tenancy');
  });

  it('whichever 4xx they choose, the answer is the same', async () => {
    // We must not depend on them picking 409 rather than 400 — the refusal is
    // the 4xx, not the specific number or the wording.
    for (const [i, code] of [400, 403, 422].entries()) {
      const c = await create(await manager(), { phone: `987650007${i}`, name: `Refused ${code}` });
      const id = String(c.json.id);
      const u = upstream.get(id)!;
      u.cancellable = false;
      u.refuseWith = { code, message: 'This locker is let and cannot be cancelled here.' };
      const r = await (await superAdmin()).post(`/api/lockers/applications/${id}/remove`, { reason: 'testing' });
      expect(r.status, `upstream ${code}`).toBe(409);
    }
  });

  it('CONTROL: a 5xx is a real outage and still fails hard — retrying may work', async () => {
    const c = await create(await manager(), { phone: '9876500088', name: 'Their Outage' });
    const id = String(c.json.id);
    const u = upstream.get(id)!;
    u.cancellable = false;
    u.refuseWith = { code: 503, message: 'upstream unavailable' };
    const r = await (await superAdmin()).post(`/api/lockers/applications/${id}/remove`, { reason: 'testing' });
    expect(r.status).toBe(502);
    // And it is NOT hidden locally on a mere outage.
    const live = await listOf(await superAdmin());
    expect(live.json.rows.some((x: any) => x.lockerhub_application_id === id)).toBe(true);
  });

  // ── "Deleted" must not mean two different things ───────────────────────────
  // Owner 2026-09-08: "if i delete in ncd i want it to get deleted in locker hub
  // also". For an un-allotted application it already does. For an allotted one
  // LockerHub has NO endpoint that closes a tenancy, so a force-removal hides
  // our row while the customer still holds the locker — and the list showed
  // both outcomes as an identical grey "deleted".
  it('records that a real cancel reached LockerHub', async () => {
    const c = await create(await manager(), { phone: '9876500099', name: 'Clean Delete' });
    const id = String(c.json.id);
    await (await superAdmin()).post(`/api/lockers/applications/${id}/remove`, { reason: 'entered by mistake' });

    const gone = await listOf(await superAdmin(), '?show=removed');
    const row = gone.json.rows.find((x: any) => x.lockerhub_application_id === id);
    expect(row.lockerhub_cancelled).toBe(true);      // genuinely gone on both sides
    expect(row.lockerhub_refusal).toBeNull();
  });

  it('records that a forced removal did NOT reach LockerHub, and why', async () => {
    const c = await create(await manager(), { phone: '9876500100', name: 'Still Let' });
    const id = String(c.json.id);
    const u = upstream.get(id)!;
    u.cancellable = false;
    u.refuseWith = { code: 409, message: LIVE_TENANCY };

    await (await superAdmin()).post(`/api/lockers/applications/${id}/remove`,
      { reason: 'settled by phone', force_local: true });

    const gone = await listOf(await superAdmin(), '?show=removed');
    const row = gone.json.rows.find((x: any) => x.lockerhub_application_id === id);
    // FALSE, not null: the screen keys on this to warn that the locker is let.
    expect(row.lockerhub_cancelled).toBe(false);
    expect(row.lockerhub_refusal).toContain('live tenancy');
  });

  it('a re-delete that finally succeeds stops saying LockerHub holds it', async () => {
    const c = await create(await manager(), { phone: '9876500111', name: 'Second Try' });
    const id = String(c.json.id);
    const u = upstream.get(id)!;
    u.cancellable = false;
    u.refuseWith = { code: 409, message: LIVE_TENANCY };
    await (await superAdmin()).post(`/api/lockers/applications/${id}/remove`,
      { reason: 'first go', force_local: true });

    // LockerHub closes it on their side; we delete again and it goes through.
    u.cancellable = true;
    await (await superAdmin()).post(`/api/lockers/applications/${id}/remove`, { reason: 'now closed there' });

    const gone = await listOf(await superAdmin(), '?show=removed');
    const row = gone.json.rows.find((x: any) => x.lockerhub_application_id === id);
    expect(row.lockerhub_cancelled).toBe(true);       // overwritten, not stuck on FALSE
    expect(row.lockerhub_refusal).toBeNull();
  });

  // ── Schedule §5: who may operate the locker (LockerHub 2026-09-09) ─────────
  // NCD never captured this, so it printed as the uncircled list of options on
  // every locker agreement signed to date. On a sole locker that is academic;
  // on a jointly-held one it is the whole question.
  describe('locker operation mandate', () => {
    it('is sent to LockerHub on the applicant block, and stored', async () => {
      seen = [];
      const r = await create(await manager(), {
        phone: '9876500222', name: 'Mandate One', locker_operation_mandate: 'either_or_survivor',
      });
      expect(r.status).toBe(201);
      const post = seen.find((x) => x.path === '/locker-applications' && x.method === 'POST');
      expect(post!.body.applicant.locker_operation_mandate).toBe('either_or_survivor');

      const l = await listOf(await manager());
      const row = l.json.rows.find((x: any) => x.lockerhub_application_id === String(r.json.id));
      expect(row.operation_mandate).toBe('either_or_survivor');
    });

    it('reaches them even with NO NCD customer to build an applicant block from', async () => {
      // It is a property of the LOCKER, not the customer. Riding on the
      // applicant block is their wire format, not a reason to drop it when
      // there is no customer.
      seen = [];
      const r = await create(await manager(), {
        phone: '9876500333', name: 'No Customer', locker_operation_mandate: 'jointly',
      });
      expect(r.status).toBe(201);
      const post = seen.find((x) => x.path === '/locker-applications' && x.method === 'POST');
      expect(post!.body.applicant.locker_operation_mandate).toBe('jointly');
    });

    it('REFUSES a value outside the four, rather than storing free text', async () => {
      // This decides who may open a locker without the other holders. A typo
      // should fail at the door, not surface as a dispute at the counter.
      const r = await create(await manager(), {
        phone: '9876500444', name: 'Bad Mandate', locker_operation_mandate: 'either/survivor',
      });
      expect(r.status).toBe(400);
    });

    it('is optional — an unchosen mandate blocks nothing', async () => {
      const r = await create(await manager(), { phone: '9876500555', name: 'No Mandate' });
      expect(r.status).toBe(201);
      const l = await listOf(await manager());
      const row = l.json.rows.find((x: any) => x.lockerhub_application_id === String(r.json.id));
      expect(row.operation_mandate).toBeNull();
    });
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
