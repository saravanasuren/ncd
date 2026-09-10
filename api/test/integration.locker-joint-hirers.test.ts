/**
 * Joint hirers — holders 2 and 3 on a locker (owner 2026-09-09: "yes build it").
 *
 * The approved agreement has three hirer blocks and three signature columns.
 * NCD recorded one holder, so a jointly-held locker existed on paper and
 * nowhere else.
 *
 * The tests worth having here are the CROSS-ROW ones. A single hirer is easy;
 * what breaks a signed contract is two of them sharing a phone, because Digio
 * keys signature PLACEMENT by signer identifier and one signature then lands in
 * the wrong column. That failure is invisible until someone reads the executed
 * agreement.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';
import { config } from '../src/config.js';

let ctx: TestCtx;
let mock: Server;
let seen: Array<{ path: string; method: string; body: any }> = [];
let nextId = 1;

beforeAll(async () => {
  ctx = await startTestServer();
  mock = createServer((req, res) => {
    let raw = ''; req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      const url = new URL(req.url ?? '/', 'http://x');
      seen.push({ path: url.pathname, method: req.method ?? '', body });
      const send = (code: number, obj: unknown) => {
        res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj));
      };
      if (url.pathname === '/locker-applications' && req.method === 'POST') {
        return send(200, { id: `lhapp_h${nextId++}`, status: 'created' });
      }
      if (/\/waiver$/.test(url.pathname)) return send(200, { success: true });
      return send(200, {});
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
const staff = () => as('ncd@demo.local');

const FULL = {
  full_name: 'Second Holder', phone: '9811100002', email: 's@example.com',
  dob: '1980-04-04', pan: 'AAAPS1111S', aadhaar_last4: '4321', address: '4 Second Street',
};

const create = async (over: Record<string, unknown> = {}) =>
  (await staff()).post('/api/lockers/applications', {
    phone: '9811100001', name: 'First Holder', branch_id: 'br_1', locker_size: 'Medium', ...over,
  });

const postBody = () => seen.filter((s) => s.path === '/locker-applications' && s.method === 'POST').pop()!.body;

describe('joint hirers', () => {
  it('reach LockerHub on the applicant block, and are stored here', async () => {
    seen = [];
    const r = await create({ hirers: [{ position: 2, ...FULL }] });
    expect(r.status).toBe(201);

    const sent = postBody().applicant.hirers;
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ name: 'Second Holder', pan: 'AAAPS1111S', aadhaar_last4: '4321' });
    // One free-text line into road_name, as the applicant's own address is.
    expect(sent[0].address.road_name).toBe('4 Second Street');

    const got = await (await staff()).get(`/api/lockers/applications/${r.json.id}/hirers`);
    expect(got.json.hirers).toHaveLength(1);
    expect(got.json.hirers[0].position).toBe(2);
    expect(got.json.incomplete).toHaveLength(0);
  });

  it('the APPLICANT is never in the array — one answer to "who is the primary holder"', async () => {
    seen = [];
    await create({ hirers: [{ position: 2, ...FULL }] });
    const names = postBody().applicant.hirers.map((h: any) => h.name);
    expect(names).not.toContain('First Holder');
  });

  // ── The cross-row rules. These are the ones that damage a signed contract ──
  it('REFUSES two hirers sharing a phone — the signature would land in the wrong column', async () => {
    const r = await create({
      hirers: [
        { position: 2, ...FULL },
        { position: 3, ...FULL, full_name: 'Third Holder', pan: 'AAAPT2222T' },
      ],
    });
    expect(r.status).toBe(400);
    expect(r.json.error.message).toMatch(/same phone/i);
  });

  it('REFUSES a hirer sharing the APPLICANT\'s phone', async () => {
    const r = await create({ hirers: [{ position: 2, ...FULL, phone: '9811100001' }] });
    expect(r.status).toBe(400);
    expect(r.json.error.message).toMatch(/applicant/i);
  });

  it('REFUSES a full Aadhaar rather than silently keeping its tail', async () => {
    // Truncating would hide that a full number was transmitted at all.
    const r = await create({ hirers: [{ position: 2, ...FULL, aadhaar_last4: '123456789012' }] });
    expect(r.status).toBe(400);
    expect(r.json.error.message).toMatch(/last four/i);
  });

  it('REFUSES a third joint hirer — the agreement has only three columns', async () => {
    const r = await create({
      hirers: [
        { position: 2, ...FULL },
        { position: 3, ...FULL, full_name: 'T', phone: '9811100003', pan: 'AAAPT2222T' },
        { position: 4, ...FULL, full_name: 'F', phone: '9811100004', pan: 'AAAPF3333F' },
      ],
    });
    expect(r.status).toBe(400);
  });

  it('REFUSES position 1 — that is the applicant', async () => {
    const r = await create({ hirers: [{ position: 1, ...FULL }] });
    expect(r.status).toBe(400);
  });

  // ── Incompleteness is REPORTED, not enforced ──────────────────────────────
  it('names which hirer is missing which field, without blocking the enrolment', async () => {
    // LockerHub refuses the AGREEMENT, not the enrolment, and their advice was
    // to send the branch straight to the gap. Blocking here would remove a
    // route the owner uses: a locker can be enrolled and allotted before the
    // paperwork is complete.
    const r = await create({
      phone: '9811100009',
      hirers: [{ position: 2, full_name: 'Half Done', phone: '9811100022' }],
    });
    expect(r.status).toBe(201);

    const got = await (await staff()).get(`/api/lockers/applications/${r.json.id}/hirers`);
    expect(got.json.incomplete).toHaveLength(1);
    expect(got.json.incomplete[0]).toMatchObject({ position: 2, name: 'Half Done' });
    for (const f of ['address', 'pan', 'aadhaar_last4', 'dob']) {
      expect(got.json.incomplete[0].missing).toContain(f);
    }
  });

  it('a locker with no joint hirers omits the key entirely, rather than sending []', async () => {
    // An empty array reads as "we checked and there are none", which is a
    // different statement from "this is a single-holder locker".
    seen = [];
    await create({ phone: '9811100077' });
    expect(postBody().applicant?.hirers).toBeUndefined();
  });

  // ── Editing after creation ────────────────────────────────────────────────
  it('PUT replaces the set, and says plainly that it did NOT reach LockerHub', async () => {
    const r = await create({ phone: '9811100088', hirers: [{ position: 2, ...FULL, phone: '9811100055' }] });
    const id = String(r.json.id);

    const put = await (await staff()).put(`/api/lockers/applications/${id}/hirers`, {
      applicant_phone: '9811100088',
      hirers: [{ position: 2, ...FULL, full_name: 'Replaced Holder', phone: '9811100066' }],
    });
    expect(put.status).toBe(200);
    expect(put.json.hirers).toHaveLength(1);
    expect(put.json.hirers[0].full_name).toBe('Replaced Holder');
    // A7 CREATES. There is no second call that could carry an edit without
    // minting a duplicate application, so we must not imply the change travelled.
    expect(put.json.synced_to_lockerhub).toBe(false);
  });

  it('PUT with an empty list removes them — an add-only API could not', async () => {
    const r = await create({ phone: '9811100099', hirers: [{ position: 2, ...FULL, phone: '9811100044' }] });
    const id = String(r.json.id);
    const put = await (await staff()).put(`/api/lockers/applications/${id}/hirers`,
      { hirers: [], applicant_phone: '9811100099' });
    expect(put.status).toBe(200);
    expect(put.json.hirers).toHaveLength(0);
  });

  // ── A sole hirer must nominate (owner 2026-09-10) ─────────────────────────
  // "if there are more than one hirer, nominee can be optional. if there is
  // only one holder then nominee is mandatory."
  //
  // With one holder the nomination is the only instruction for what happens to
  // the contents if they die. With joint holders there is a surviving holder
  // who can already operate the locker.
  //
  // This REVERSES 2026-09-09, where the owner asked for the nominee to be told
  // and not enforced. The banner still tells; for a sole hirer it now blocks
  // too. If someone later "restores" the old behaviour, the first test fails.
  describe('a sole hirer must nominate', () => {
    let soleId = 0;
    let jointId = 0;

    beforeAll(async () => {
      const a = await as('admin@dhanam.finance', 'ChangeMe_Dev_123');
      const c1 = await a.post('/api/customers', {
        full_name: 'Sole No Nominee', phone: '9812200001', email: 'sole@example.com',
      });
      soleId = Number(c1.json.id);
      const c2 = await a.post('/api/customers', {
        full_name: 'Joint No Nominee', phone: '9812200002', email: 'joint@example.com',
      });
      jointId = Number(c2.json.id);
    });

    it('REFUSES a single-holder locker when the customer has no nominee', async () => {
      const r = await (await staff()).post('/api/lockers/applications', {
        phone: '9812200001', name: 'Sole No Nominee', branch_id: 'br_1',
        locker_size: 'Medium', customer_id: soleId,
      });
      expect(r.status).toBe(400);
      expect(r.json.error.message).toMatch(/single holder/i);
      // ...and it names the way out, both of them.
      expect(r.json.error.message).toMatch(/joint hirer/i);
    });

    it('ALLOWS it once a nominee exists — only the NAME is required to enrol', async () => {
      // The rest of the nominee (relationship, dob, phone, address) is what
      // LockerHub's agreement gate wants and stays reported, not enforced.
      await ctx.db.query(
        `INSERT INTO nominees (customer_id, full_name, share_pct) VALUES ($1, 'A Nominee', 100)`, [soleId]);
      const r = await (await staff()).post('/api/lockers/applications', {
        phone: '9812200001', name: 'Sole No Nominee', branch_id: 'br_1',
        locker_size: 'Medium', customer_id: soleId,
      });
      expect(r.status).toBe(201);
    });

    it('ALLOWS a JOINT locker with no nominee at all — that is the point of the rule', async () => {
      const r = await (await staff()).post('/api/lockers/applications', {
        phone: '9812200002', name: 'Joint No Nominee', branch_id: 'br_1',
        locker_size: 'Medium', customer_id: jointId,
        hirers: [{ position: 2, full_name: 'The Other Holder', phone: '9812200033',
                   pan: 'AAAPJ9999J', aadhaar_last4: '9999', dob: '1979-01-01', address: '9 Joint Road' }],
      });
      expect(r.status).toBe(201);
    });

    it('does not block a walk-in we hold no customer record for', async () => {
      // Nothing to check a nominee against. Refusing here would stop an
      // enrolment over a record that does not exist.
      const r = await (await staff()).post('/api/lockers/applications', {
        phone: '9812200044', name: 'Walk In', branch_id: 'br_1', locker_size: 'Medium',
      });
      expect(r.status).toBe(201);
    });
  });
});
