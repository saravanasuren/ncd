/**
 * Backdating a locker allotment, and the notice it raises (owner 2026-09-04:
 * "some locker entry can be backdated too, do give a field to add the date of
 * locker allotment. and that should go be a approval when a locker is being
 * alloted, but it should [not] disturb any flow of work — just like how
 * dhanamfin app investment comes into approval but doesnt disturb any
 * workflow").
 *
 * The whole point is the second half. This is modelled on `app_investment`: the
 * locker is ALREADY handed over by the time the notice exists, there is no
 * registerOnFinalApprove handler, and nothing waits. So the tests that matter
 * most here are the ones proving allocation is undisturbed.
 *
 * LockerHub's A11 takes no date — they stamp "now" — so our date is ours alone
 * until they accept one. Their value is kept beside it, and renewals still
 * follow theirs.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';
import { config } from '../src/config.js';

let ctx: TestCtx;
let mock: Server;
/** Every body LockerHub was sent, so we can prove what we did and did not send. */
let allocateBodies: Array<Record<string, unknown>> = [];

beforeAll(async () => {
  ctx = await startTestServer();
  mock = createServer((req, res) => {
    let raw = ''; req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://x');
      const body = raw ? JSON.parse(raw) : {};
      const send = (code: number, o: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (/\/branches$/.test(url.pathname)) return send(200, { branches: [{ id: 'br_erode', name: 'Erode' }] });
      if (/\/allocate$/.test(url.pathname) && req.method === 'POST') {
        allocateBodies.push(body);
        return send(200, {
          success: true,
          allotment: {
            locker_number: 'C-14', size: 'M', branch_id: 'br_erode',
            // THEY stamp today, always — which is the whole problem.
            allotted_on: new Date().toISOString().slice(0, 10),
            lease_start: new Date().toISOString().slice(0, 10),
          },
          // Phone-keyed, and no NCD customer id: this phone is the only join
          // back to our customer, which is what the card needs to show a name.
          tenant: { phone: '9534000001', branch_id: 'br_erode' },
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

const as = async (email: string, password = 'Demo_1234') => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c; };
const admin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');

const allot = (a: Client, appId: string, body: Record<string, unknown> = {}) =>
  a.post(`/api/lockers/applications/${appId}/allocate`, body);
const rowOf = async (appId: string) =>
  (await ctx.db.query<Record<string, unknown>>(
    'SELECT * FROM locker_allotments WHERE lockerhub_application_id = $1', [appId])).rows[0];
const noticeFor = async (appId: string) =>
  (await ctx.db.query<Record<string, unknown>>(
    `SELECT * FROM approval_requests
      WHERE request_type = 'locker_allotment' AND metadata->>'lockerhub_application_id' = $1
      ORDER BY id DESC LIMIT 1`, [appId])).rows[0];

const TODAY = new Date().toISOString().slice(0, 10);

describe('an ordinary same-day allotment is unchanged', () => {
  it('allots with no date given, and records today', async () => {
    const a = await admin();
    const r = await allot(a, 'LKR-AL-1');
    expect(r.status).toBe(200);
    const row = await rowOf('LKR-AL-1');
    expect(row!.allotted_on).toBe(TODAY);
    expect(row!.backdated).toBe(false);
    expect(row!.locker_no).toBe('C-14');
  });

  it('raises the notice, and it is a NOTICE — no side effect on approval', async () => {
    const n = await noticeFor('LKR-AL-1');
    expect(n).toBeTruthy();
    expect(n!.status).toBe('Pending');

    // Approving clears it and changes nothing else. This is the app_investment
    // contract: the locker was already allotted before the notice existed.
    const checker = await as('ncd@demo.local');
    expect((await checker.post(`/api/approvals/${Number(n!.id)}/approve`, { note: 'seen' })).status).toBe(200);
    const row = await rowOf('LKR-AL-1');
    expect(row!.allotted_on).toBe(TODAY);      // untouched
    expect(row!.backdated).toBe(false);
  });
});

describe('the card has a human on it, not just LockerHub\'s id', () => {
  // Owner 2026-09-04: "what are those characters" — the first eight cards read
  // "Locker F21-11 · mtms1j5r0tepf3n", LockerHub's internal primary key, and
  // nothing else. The route never passed a customer through, so the name lookup
  // found nothing every time.
  it('links the NCD customer from the tenant phone, and names the branch', async () => {
    const a = await admin();
    await a.post('/api/customers', { full_name: 'Allot Card Cust', phone: '9534000001' });
    const r = await allot(a, 'LKR-AL-CARD');
    expect(r.status).toBe(200);

    const row = await rowOf('LKR-AL-CARD');
    expect(row!.customer_id).not.toBeNull();
    // branch_name is resolved from branch_id — LockerHub sends only the id.
    expect(row!.branch_name).toBe('Erode');
  });

  it('leads the card with the customer, and keeps the id as a reference', async () => {
    const n = await noticeFor('LKR-AL-CARD');
    const checker = await as('ncd@demo.local');
    const card = (await checker.get(`/api/approvals/${Number(n!.id)}`)).json;
    expect(card.detail.subject).toBe('Allot Card Cust · Locker C-14');
    // The raw id is still available — it is what you quote back to LockerHub —
    // but labelled as theirs rather than sitting alone as the headline.
    expect(JSON.stringify(card.detail.facts)).toContain('LockerHub application');
    expect(JSON.stringify(card.detail.facts)).toContain('LKR-AL-CARD');
  });

  it('falls back to the locker and branch when no customer matches the phone', async () => {
    const a = await admin();
    // No NCD customer on this application's phone at all.
    await allot(a, 'LKR-AL-NOCUST');
    await ctx.db.query(
      'UPDATE locker_allotments SET customer_id = NULL WHERE lockerhub_application_id = $1', ['LKR-AL-NOCUST']);
    const n = await noticeFor('LKR-AL-NOCUST');
    const checker = await as('ncd@demo.local');
    const card = (await checker.get(`/api/approvals/${Number(n!.id)}`)).json;
    // Still readable — never the bare application id on its own.
    expect(card.detail.subject).toContain('Locker C-14');
    expect(card.detail.subject).not.toBe('LKR-AL-NOCUST');
  });
});

describe('backdating', () => {
  it('records the stated date and keeps LockerHub\'s beside it', async () => {
    const a = await admin();
    const r = await allot(a, 'LKR-AL-2', { allotted_on: '2026-06-01', backdate_reason: 'handed over at the branch in June, entered late' });
    expect(r.status).toBe(200);

    const row = await rowOf('LKR-AL-2');
    expect(row!.allotted_on).toBe('2026-06-01');
    expect(row!.backdated).toBe(true);
    expect(row!.backdate_reason).toContain('entered late');
    // Theirs is kept, not overwritten — the disagreement has to stay visible.
    expect(row!.lockerhub_allotted_on).toBe(TODAY);
  });

  it('never sends the date to LockerHub — their contract has no such field', async () => {
    const sent = allocateBodies[allocateBodies.length - 1]!;
    expect(sent.allotted_on).toBeUndefined();
    expect(sent.backdate_reason).toBeUndefined();
    expect(sent.staff).toBeTruthy();
  });

  it('puts the backdate and both dates on the checker card', async () => {
    const n = await noticeFor('LKR-AL-2');
    const checker = await as('ncd@demo.local');
    const card = (await checker.get(`/api/approvals/${Number(n!.id)}`)).json;
    const facts = JSON.stringify(card.detail.facts);
    expect(facts).toContain('2026-06-01');
    expect(facts).toContain('entered late');
    expect(facts).toContain(TODAY);                       // what LockerHub recorded
    expect(facts).toContain('C-14');
    // The card must say plainly that approving does nothing.
    expect(facts).toContain('changes nothing');
  });

  it('refuses a backdate with no reason — BEFORE calling LockerHub', async () => {
    const a = await admin();
    const before = allocateBodies.length;
    const r = await allot(a, 'LKR-AL-3', { allotted_on: '2026-06-01' });
    expect(r.status).toBe(400);
    // The critical part: a bad date must not cost a real allotment. Nothing
    // reached LockerHub, so nothing was handed over.
    expect(allocateBodies.length).toBe(before);
    expect(await rowOf('LKR-AL-3')).toBeUndefined();
  });

  it('refuses a future date', async () => {
    const a = await admin();
    const r = await allot(a, 'LKR-AL-4', { allotted_on: '2099-01-01' });
    expect(r.status).toBe(400);
  });
});

describe('the notice cannot disturb the allotment', () => {
  it('an allotment still succeeds even when the record cannot be written', async () => {
    // Force the bookkeeping to fail: a customer_id that violates the FK. The
    // locker is already allotted on LockerHub by then, so reporting an error
    // would send staff chasing a failure that did not happen.
    const a = await admin();
    await ctx.db.query('DROP TABLE IF EXISTS locker_allotments_backup');
    await ctx.db.query('ALTER TABLE locker_allotments RENAME TO locker_allotments_backup');
    try {
      const r = await allot(a, 'LKR-AL-5');
      expect(r.status).toBe(200);                    // the allotment still worked
      expect(r.json.allotment.locker_number).toBe('C-14');
    } finally {
      await ctx.db.query('ALTER TABLE locker_allotments_backup RENAME TO locker_allotments');
    }
  });
});

describe('renewals flag a backdated locker rather than letting it drift', () => {
  it('marks the row so it is not silently renewed late', async () => {
    const { lockerRenewals } = await import('../src/modules/lockers/renewals.js');
    const { backdatedByApplication } = await import('../src/modules/lockers/allotments.js');
    // The map is what the renewals assembly joins on; prove LKR-AL-2 is in it.
    const map = await backdatedByApplication(ctx.db);
    expect(map.has('LKR-AL-2')).toBe(true);
    expect(map.get('LKR-AL-2')!.allotted_on).toBe('2026-06-01');
    expect(map.get('LKR-AL-2')!.date_differs).toBe(true);
    // ...and the screen builds without error against it.
    const out = await lockerRenewals(ctx.db, {});
    expect(Array.isArray(out.rows)).toBe(true);
  });
});
