/**
 * Migration 049 links the interest messages that were queued BEFORE the
 * delivery columns existed.
 *
 * This is the guard on a real hazard: 92 customers in batch NEFT-2026-000131
 * did get their WhatsApp on 28 Jul 2026. Their queue rows have no
 * customer_id/ref_id, and "already had theirs" is keyed on exactly those — so
 * if the backfill misses them, the very next Notify click messages all 92 a
 * second time. Over-matching is just as bad: linking the wrong customer would
 * mark someone as told who never was.
 *
 * The tricky case is families sharing one phone number, which is why the match
 * uses the name written into the message body, not the number alone.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { startTestServer, Client, type TestCtx, requiredInvestmentFields, approveInvestment } from './helpers/server.js';

let ctx: TestCtx;
let seriesId: number, schemeId: number;

const MIGRATION = readFileSync(new URL('../src/db/migrations/049_link_past_interest_notifications.sql', import.meta.url), 'utf8');

beforeAll(async () => {
  ctx = await startTestServer();
  seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
  schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
});
afterAll(async () => { await ctx.close(); });

const as = async (email: string, password = 'Demo_1234') => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c; };
const admin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');

/** A customer with a live investment, optionally sharing someone's phone. */
async function invest(name: string, phone: string, acct: string) {
  const a = await admin();
  const cust = await a.post('/api/customers', { full_name: name, phone });
  const cid = Number(cust.json.id);
  await a.post(`/api/customers/${cid}/bank-accounts`, { account_number: acct, ifsc: 'ICIC0001234' });
  const app = await a.post('/api/applications', {
    ...requiredInvestmentFields(), customer_id: cid, series_id: seriesId,
    scheme_id: schemeId, amount: 500000, date_money_received: '2026-07-12',
  });
  await approveInvestment(await as('ncd@demo.local'), app);
  return cid;
}

/** A pre-048 queue row: no customer_id, no ref. */
async function legacyRow(phone: string, name: string, date: string, status: string, error: string | null = null) {
  const r = await ctx.db.query<{ id: string }>(
    `INSERT INTO notifications_queue (channel, template, to_address, payload, status, error)
     VALUES ('whatsapp', 'interest_paid', $1, $2::jsonb, $3, $4) RETURNING id`,
    [phone, JSON.stringify({ name, amount: '1,000', month: 'September 2026', date }), status, error]);
  return Number(r.rows[0]!.id);
}

const rowOf = async (id: number) =>
  (await ctx.db.query('SELECT customer_id, ref_kind, ref_id, status FROM notifications_queue WHERE id = $1', [id])).rows[0] as any;

describe('linking the messages sent before the delivery columns existed', () => {
  it('links a delivered message to its customer and batch — so they are not messaged twice', async () => {
    const SHARED = '9766100001';
    // Two customers, ONE phone: the case phone-only matching cannot resolve.
    const alice = await invest('Backfill Alice', SHARED, '8801000001');
    const bob = await invest('Backfill Bob', SHARED, '8801000002');
    const soloId = await invest('Backfill Solo', '9766100002', '8801000003');

    const a = await admin();
    const batch = await (await as('ncd@demo.local')).post('/api/payouts', { payout_date: '2026-09-28' });
    await a.post(`/api/approvals/${batch.json.request.id}/approve`);
    const batchId = Number(batch.json.batch_id);

    // What 28 Jul left behind: Alice delivered, Bob 429'd, Solo delivered.
    const aliceMsg = await legacyRow(SHARED, 'Backfill Alice', '28-Sep-2026', 'Sent');
    const bobMsg = await legacyRow(SHARED, 'Backfill Bob', '28-Sep-2026', 'Failed',
      'wappcloud: send failed (429): Too many requests from this IP');
    const soloMsg = await legacyRow('9766100002', 'Backfill Solo', '28-Sep-2026', 'Sent');

    await ctx.db.query(MIGRATION);

    // Each row found its OWN customer despite Alice and Bob sharing a number.
    expect(Number((await rowOf(aliceMsg)).customer_id)).toBe(alice);
    expect(Number((await rowOf(bobMsg)).customer_id)).toBe(bob);
    expect(Number((await rowOf(soloMsg)).customer_id)).toBe(soloId);
    for (const id of [aliceMsg, bobMsg, soloMsg]) {
      const r = await rowOf(id);
      expect(r.ref_kind).toBe('payout_batch');
      expect(Number(r.ref_id)).toBe(batchId);
    }

    // The delivery report can now tell the story.
    const st = (await a.get(`/api/payouts/${batchId}/whatsapp-status`)).json;
    const state = (n: string) => (st.rows as any[]).find((r) => r.full_name === n)?.state;
    expect(state('Backfill Alice')).toBe('Sent');
    expect(state('Backfill Bob')).toBe('Failed');

    // And Notify tops up only Bob — Alice and Solo are left alone.
    const notify = await a.post(`/api/payouts/${batchId}/whatsapp-interest`);
    expect(notify.json.already_sent).toBeGreaterThanOrEqual(2);
    const bobAgain = (await ctx.db.query(
      "SELECT count(*)::int n FROM notifications_queue WHERE template='interest_paid' AND payload->>'name' = 'Backfill Bob'")).rows[0] as any;
    expect(Number(bobAgain.n)).toBe(2);          // the dead one + a fresh retry
    const aliceAgain = (await ctx.db.query(
      "SELECT count(*)::int n FROM notifications_queue WHERE template='interest_paid' AND payload->>'name' = 'Backfill Alice'")).rows[0] as any;
    expect(Number(aliceAgain.n)).toBe(1);        // never a second message
  });

  it('leaves a row alone when nothing identifies it cleanly', async () => {
    const orphan = await legacyRow('9766100099', 'Nobody At All', '28-Sep-2026', 'Sent');
    const wrongName = await legacyRow('9766100002', 'Not Their Name', '28-Sep-2026', 'Sent');
    await ctx.db.query(MIGRATION);
    expect((await rowOf(orphan)).ref_id).toBeNull();
    expect((await rowOf(wrongName)).ref_id).toBeNull();   // phone matches, name does not
  });

  it('runs twice without changing anything the second time', async () => {
    const id = await legacyRow('9766100002', 'Backfill Solo', '28-Sep-2026', 'Sent');
    await ctx.db.query(MIGRATION);
    const first = await rowOf(id);
    expect(first.ref_id).not.toBeNull();
    await ctx.db.query(MIGRATION);
    expect(await rowOf(id)).toEqual(first);
  });
});
