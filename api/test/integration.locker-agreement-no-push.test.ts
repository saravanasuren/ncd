/**
 * Our agreement number reaches LockerHub (their A28, live 2026-09-18), so both
 * systems show the same number (owner 2026-09-18: "change it in lockerhub also
 * so that it sayys the same").
 *
 * The fake below behaves as LockerHub's own reply specifies: 200, 200 with
 * `already` on a repeat, 409 `agreement_no_conflict` when they hold a different
 * number (they never overwrite), 409 `agreement_no_in_use`, and an outage.
 *
 * What matters most is that EVERY outcome is written down. The push runs after
 * the number is stored and outside that transaction, so without a record a
 * number that never reached them would look exactly like one that did.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { startTestServer, type TestCtx } from './helpers/server.js';
import { config } from '../src/config.js';

let ctx: TestCtx;
let mock: Server;
/** What LockerHub holds, per application — its A28 state. */
const held = new Map<string, string>();
const calls: Array<{ app: string; body: Record<string, unknown> }> = [];
let down = false;

beforeAll(async () => {
  ctx = await startTestServer();
  mock = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const send = (code: number, body: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (down) return send(503, { error: 'maintenance' });
      const m = /\/locker-applications\/([^/]+)\/external-ref$/.exec(req.url ?? '');
      if (!m || req.method !== 'POST') return send(404, { error: 'not found' });
      const app = decodeURIComponent(m[1]!);
      const body = JSON.parse(raw || '{}') as Record<string, unknown>;
      calls.push({ app, body });
      const no = String(body.agreement_no ?? '').toUpperCase();
      const current = held.get(app);
      if (current === no) return send(200, { success: true, application_id: app, agreement_no: no, already: true });
      if (current && current !== no) return send(409, { error: 'agreement_no_conflict', current, requested: no });
      const owner = [...held.entries()].find(([, v]) => v === no)?.[0];
      if (owner) return send(409, { error: 'agreement_no_in_use', application_id: owner });
      held.set(app, no);
      return send(200, { success: true, application_id: app, agreement_no: no });
    });
  });
  await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r));
  const addr = mock.address();
  config.LOCKERHUB_API_URL = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});
afterAll(async () => { config.LOCKERHUB_API_URL = ''; await new Promise<void>((r) => mock.close(() => r())); await ctx.close(); });

const state = async (app: string) => (await ctx.db.query<{ agreement_no: string | null; pushed: boolean; err: string | null }>(
  `SELECT agreement_no, agreement_no_pushed_at IS NOT NULL AS pushed, agreement_no_push_error AS err
     FROM locker_applications WHERE lockerhub_application_id = $1`, [app])).rows[0]!;

/** The automatic push is fire-and-forget, so wait for it to leave its mark. */
async function settled(app: string) {
  for (let i = 0; i < 100; i++) {
    const s = await state(app);
    if (s.pushed || s.err) return s;
    await new Promise((r) => setTimeout(r, 20));
  }
  return state(app);
}

describe('the agreement number reaches LockerHub', () => {
  it('is pushed automatically the moment it is allocated', async () => {
    const { ensureAgreementNo } = await import('../src/modules/lockers/agreements.js');
    const no = await ensureAgreementNo(ctx.db, 'la_push_1');
    expect(no).toMatch(/^DIF\d{4,}$/);
    const s = await settled('la_push_1');
    expect(s.pushed).toBe(true);
    expect(s.err).toBeNull();
    // LockerHub now holds exactly our number, sent with a staff block.
    expect(held.get('la_push_1')).toBe(no);
    const call = calls.find((c) => c.app === 'la_push_1')!;
    expect(call.body.agreement_no).toBe(no);
    expect(call.body.staff).toBeTruthy();
  });

  it('treats the same number sent twice as success — that is what makes retrying safe', async () => {
    const { pushAgreementNo } = await import('../src/modules/lockers/agreements.js');
    const again = await pushAgreementNo(ctx.db, 'la_push_1');
    expect(again.outcome).toBe('already');
    expect((await state('la_push_1')).pushed).toBe(true);
  });

  it('records a conflict and does NOT count it as pushed', async () => {
    const { ensureAgreementNo, pushAgreementNo } = await import('../src/modules/lockers/agreements.js');
    // LockerHub already holds a DIFFERENT number for this application.
    held.set('la_push_conflict', 'DIF9999');
    await ensureAgreementNo(ctx.db, 'la_push_conflict');
    await settled('la_push_conflict');
    const r = await pushAgreementNo(ctx.db, 'la_push_conflict');
    expect(r.outcome).toBe('refused');
    const s = await state('la_push_conflict');
    expect(s.pushed).toBe(false);
    // The record says who holds what, so a person can decide which is right.
    expect(s.err).toContain('agreement_no_conflict');
    expect(s.err).toContain('DIF9999');
    // They were not overwritten.
    expect(held.get('la_push_conflict')).toBe('DIF9999');
  });

  it('records an outage without blocking the agreement from getting its number', async () => {
    const { ensureAgreementNo } = await import('../src/modules/lockers/agreements.js');
    down = true;
    try {
      const no = await ensureAgreementNo(ctx.db, 'la_push_down');
      // The number is ours and stored regardless of LockerHub.
      expect(no).toMatch(/^DIF\d{4,}$/);
      const s = await settled('la_push_down');
      expect(s.agreement_no).toBe(no);
      expect(s.pushed).toBe(false);
      expect(s.err).toContain('unavailable');
    } finally { down = false; }
  });

  it('a retry after the outage succeeds and clears the error', async () => {
    const { pushAgreementNo } = await import('../src/modules/lockers/agreements.js');
    const r = await pushAgreementNo(ctx.db, 'la_push_down');
    expect(r.outcome).toBe('pushed');
    const s = await state('la_push_down');
    expect(s.pushed).toBe(true);
    expect(s.err).toBeNull();
  });
});
