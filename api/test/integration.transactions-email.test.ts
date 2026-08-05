/**
 * Daily transaction-register email (owner 2026-08-05) — "mail that particular
 * transaction tab report alone to the mail ids I give, on a daily basis. Make
 * it UI config."
 *
 * The rules this guards:
 *   - OFF by default, and silent until someone turns it on.
 *   - NO ROLE FALLBACK on recipients. The daily book summary degrades to the
 *     management roles when unset; this attachment is the ENTIRE register —
 *     every customer, PAN, DOB and amount — so an empty list must send nothing
 *     rather than guess an audience.
 *   - Per-IST-day idempotent, so a restart or a second tick cannot double-send.
 *   - Sends on a quiet day too (owner's call), so silence means a broken job
 *     rather than "no business today".
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startTestServer, type TestCtx } from './helpers/server.js';
import { runTransactionsEmail, istToday } from '../src/integrations/transactions-email.js';
import { attachmentFor } from '../src/modules/notifications/attachments.js';
import { buildRawEmail } from '../src/integrations/notify/mime.js';

let ctx: TestCtx;
beforeAll(async () => {
  ctx = await startTestServer();
  const seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
  const cid = Number((await ctx.db.query(
    `INSERT INTO customers (customer_code, full_name, phone, pan, dob, district, creation_status, is_active)
     VALUES ('TXE001','Mail Register Case','9755000001','ABCDE9876Z','1980-02-02','Erode','Approved',TRUE) RETURNING id`)).rows[0]!.id);
  await ctx.db.query(
    `INSERT INTO applications (application_no, customer_id, series_id, status, total_amount, date_money_received, allotment_date)
     VALUES ('APP-TXE-1',$1,$2,'Active',300000,$3,$3)`, [cid, seriesId, istToday()]);
});
afterAll(async () => { await ctx.close(); });

const setting = async (key: string, value: unknown) => {
  await ctx.db.query(
    `INSERT INTO app_settings (key, value, group_name, label) VALUES ($1,$2::jsonb,'Reports',$1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [key, JSON.stringify(value)]);
};
const queued = async () => (await ctx.db.query(
  "SELECT to_address, payload FROM notifications_queue WHERE template = 'transactions_daily' ORDER BY id")).rows as any[];

beforeEach(async () => {
  await ctx.db.query("DELETE FROM notifications_queue WHERE template = 'transactions_daily'");
});

describe('it stays quiet until configured', () => {
  it('does nothing while disabled', async () => {
    await setting('reports.transactions_email_enabled', false);
    await setting('reports.transactions_email_recipients', ['owner@dhanam.finance']);
    expect((await runTransactionsEmail(ctx.db)).skipped).toBe('disabled');
    expect(await queued()).toHaveLength(0);
  });

  it('sends NOTHING when enabled with no recipients — there is no role fallback', async () => {
    await setting('reports.transactions_email_enabled', true);
    await setting('reports.transactions_email_recipients', []);
    const r = await runTransactionsEmail(ctx.db);
    expect(r.sent).toBe(0);
    expect(r.skipped).toMatch(/no recipients/i);
    expect(await queued()).toHaveLength(0);
  });
});

describe('once configured', () => {
  beforeEach(async () => {
    await setting('reports.transactions_email_enabled', true);
    await setting('reports.transactions_email_recipients', ['owner@dhanam.finance', 'ops@dhanam.finance']);
  });

  it('queues one email per configured address', async () => {
    const r = await runTransactionsEmail(ctx.db);
    expect(r.sent).toBe(2);
    expect((await queued()).map((q) => q.to_address).sort())
      .toEqual(['ops@dhanam.finance', 'owner@dhanam.finance']);
  });

  it('running twice in a day does NOT send again', async () => {
    await runTransactionsEmail(ctx.db);
    const second = await runTransactionsEmail(ctx.db);
    expect(second.sent).toBe(0);
    expect(await queued()).toHaveLength(2);
  });

  it('carries the totals the body reads', async () => {
    await runTransactionsEmail(ctx.db);
    const p = (await queued())[0]!.payload;
    expect(p.report_date).toBe(istToday());
    expect(Number(p.rows)).toBeGreaterThan(0);
    expect(String(p.net)).toMatch(/^₹/);
    expect(p.changed_today).toBe(true);        // one investment funded today
  });

  it('still sends on a day with no activity, and says so', async () => {
    // Nothing dated tomorrow — the register is unchanged that day.
    const tomorrow = new Date(Date.now() + 24 * 3600 * 1000);
    await ctx.db.query("DELETE FROM notifications_queue WHERE template = 'transactions_daily'");
    const r = await runTransactionsEmail(ctx.db, new Date(tomorrow.getTime() + 24 * 3600 * 1000));
    expect(r.sent).toBe(2);
    const p = (await queued())[0]!.payload;
    expect(p.changed_today).toBe(false);
    expect(Number(p.today_rows)).toBe(0);
  });

  it('ignores junk in the recipient list rather than trying to send to it', async () => {
    await setting('reports.transactions_email_recipients', ['owner@dhanam.finance', 'not-an-email', '']);
    const r = await runTransactionsEmail(ctx.db);
    expect(r.sent).toBe(1);
  });
});

describe('the attachment', () => {
  it('is a real xlsx, built at send time from the same sheet as the workbook tab', async () => {
    const att = await attachmentFor(ctx.db, 'transactions_daily', { report_date: '2026-08-05' });
    expect(att).toBeTruthy();
    expect(att!.filename).toBe('dhanam-transactions-2026-08-05.xlsx');
    expect(att!.contentType).toMatch(/spreadsheetml/);
    expect(att!.content.subarray(0, 2).toString()).toBe('PK');   // a zip, i.e. a workbook

    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(att!.content as never);
    const ws = wb.getWorksheet('Transactions')!;
    expect(ws).toBeTruthy();
    expect([1, 7, 8].map((c) => ws.getRow(1).getCell(c).value)).toEqual(['Sl.No', 'Trans Type', 'Amount']);
  });

  it('templates without a file get none — the registry is opt-in', async () => {
    expect(await attachmentFor(ctx.db, 'password_reset', {})).toBeNull();
  });
});

describe('the MIME message', () => {
  const att = { filename: 'x.xlsx', content: Buffer.from('hello-attachment'), contentType: 'application/vnd.ms-excel' };

  it('wraps the base64 payload at 76 chars — one long line breaks SMTP', () => {
    const big = { ...att, content: Buffer.alloc(4000, 0x41) };
    const raw = buildRawEmail({ from: 'a@b.com', to: 'c@d.com', subject: 'S', text: 'T', attachment: big }).toString();
    const lines = raw.split('\r\n');
    // Every line must clear SMTP's hard 998-octet limit — headers included.
    expect(Math.max(...lines.map((l) => l.length))).toBeLessThanOrEqual(998);
    // And the ENCODED PAYLOAD specifically must wrap at 76. Headers may run
    // longer (the boundary declaration does, legitimately), so assert on the
    // base64 rather than on the longest line in the message.
    const b64 = lines.filter((l) => /^[A-Za-z0-9+/=]{40,}$/.test(l));
    expect(b64.length).toBeGreaterThan(10);                       // it really is chunked
    expect(Math.max(...b64.map((l) => l.length))).toBeLessThanOrEqual(76);
  });

  it('declares the attachment and its filename', () => {
    const raw = buildRawEmail({ from: 'a@b.com', to: 'c@d.com', subject: 'S', text: 'T', attachment: att }).toString();
    expect(raw).toMatch(/Content-Disposition: attachment; filename="x\.xlsx"/);
    expect(raw).toMatch(/multipart\/mixed; boundary="/);
    expect(raw).toContain(Buffer.from('hello-attachment').toString('base64'));
  });

  it('the boundary does not appear inside the content it is separating', () => {
    const raw = buildRawEmail({ from: 'a@b.com', to: 'c@d.com', subject: 'S', text: 'T', attachment: att }).toString();
    const boundary = /boundary="([^"]+)"/.exec(raw)![1]!;
    // Exactly three occurrences: the header, the two part openers, plus the closer.
    expect(raw.split(boundary).length - 1).toBe(4);
  });

  it('encodes a non-ASCII subject rather than emitting a raw 8-bit header', () => {
    const raw = buildRawEmail({ from: 'a@b.com', to: 'c@d.com', subject: 'Register — ₹62 cr', text: 'T', attachment: att }).toString();
    expect(raw).toMatch(/Subject: =\?UTF-8\?B\?/);
  });
});
