/**
 * WhatsApp acknowledgement (approved `ncd_akn` template with a Document header).
 * Sending queues the message with a short-lived, path-scoped `?vt=` URL that
 * WappCloud fetches — that token serves the ack PDF WITHOUT a session, but only
 * for its exact document; no token (and no session) is refused.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, approveInvestment, type TestCtx, requiredInvestmentFields } from './helpers/server.js';
import { templateFor } from '../src/integrations/notify/wappcloud.js';
import { config } from '../src/config.js';

let ctx: TestCtx;
let seriesId: number, schemeId: number, appId: number;

beforeAll(async () => {
  ctx = await startTestServer();
  config.PUBLIC_BASE_URL = 'https://ncd.test'; // so the ack can build a fetch URL
  seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
  schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
  const a = await as('admin@dhanam.finance', 'ChangeMe_Dev_123');
  const cust = await a.post('/api/customers', { full_name: 'Ack Cust', phone: '9765500001', email: 'ack@ex.com' });
  const ncd = await as('ncd@demo.local');
  await a.post(`/api/customers/${cust.json.id}/bank-accounts`, { account_number: '889765500001', ifsc: 'ICIC0001234' });
  const app = await a.post('/api/applications', { ...requiredInvestmentFields(), customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId, amount: 400000, date_money_received: '2026-07-12' });
  await a.post(`/api/applications/${app.json.id}/mark-esigned`);
  await approveInvestment(ncd, app); // Active → the ack PDF renders
  appId = app.json.id;
});
afterAll(async () => { await ctx.close(); });

async function as(email: string, password = 'Demo_1234') {
  const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c;
}

describe('WhatsApp acknowledgement', () => {
  it('queues ncd_akn with a tokenised document URL and reports the send', async () => {
    const a = await as('admin@dhanam.finance', 'ChangeMe_Dev_123');
    const r = await a.post(`/api/applications/${appId}/whatsapp-ack`);
    expect(r.status).toBe(200);
    expect(r.json.phone).toBe('+919765500001');       // normalised
    expect(['Sent', 'Pending']).toContain(r.json.status);

    const q = (await ctx.db.query(
      "SELECT to_address, payload FROM notifications_queue WHERE channel = 'whatsapp' AND template = 'acknowledgment' ORDER BY id DESC LIMIT 1")).rows[0] as any;
    expect(q.to_address).toBe('+919765500001');
    expect(q.payload.name).toBe('Ack Cust');
    expect(String(q.payload.documentUrl)).toContain(`/api/reports/acknowledgment/${appId}.pdf?vt=`);
    expect(String(q.payload.documentName)).toContain('Acknowledgment.pdf');
  });

  it('the ?vt= token serves the ack PDF with no session; without it, refused', async () => {
    const a = await as('admin@dhanam.finance', 'ChangeMe_Dev_123');
    await a.post(`/api/applications/${appId}/whatsapp-ack`);
    const q = (await ctx.db.query(
      "SELECT payload FROM notifications_queue WHERE channel = 'whatsapp' AND template = 'acknowledgment' ORDER BY id DESC LIMIT 1")).rows[0] as any;
    const vt = new URL(String(q.payload.documentUrl)).searchParams.get('vt')!;
    expect(vt).toBeTruthy();

    // WappCloud fetch: no cookies, valid token → the PDF.
    const ok = await fetch(`${ctx.base}/api/reports/acknowledgment/${appId}.pdf?vt=${encodeURIComponent(vt)}`);
    expect(ok.status).toBe(200);
    const head = Buffer.from(await ok.arrayBuffer()).subarray(0, 5).toString();
    expect(head).toBe('%PDF-');

    // No token + no session → unauthorised. Wrong appId with the same token → refused.
    expect((await fetch(`${ctx.base}/api/reports/acknowledgment/${appId}.pdf`)).status).toBe(401);
    expect((await fetch(`${ctx.base}/api/reports/acknowledgment/${appId + 1}.pdf?vt=${encodeURIComponent(vt)}`)).status).toBe(401);
  });

  it('a customer with no phone cannot be sent (clear 400)', async () => {
    const a = await as('admin@dhanam.finance', 'ChangeMe_Dev_123');
    const cust = await a.post('/api/customers', { full_name: 'No Phone Ack', phone: '9765500009' });
    const app = await a.post('/api/applications', { ...requiredInvestmentFields(), customer_id: cust.json.id, series_id: seriesId, scheme_id: schemeId, amount: 100000 });
    await ctx.db.query('UPDATE customers SET phone = NULL WHERE id = $1', [cust.json.id]);
    const r = await a.post(`/api/applications/${app.json.id}/whatsapp-ack`);
    expect(r.status).toBe(400);
    expect(r.json.error.message).toContain('phone');
  });

  it('the WappCloud provider maps acknowledgment → ncd_akn with a document header', () => {
    const tpl = templateFor({ template: 'acknowledgment', payload: { name: 'Ravi', documentUrl: 'https://ncd.test/x.pdf?vt=abc', documentName: 'Ravi - NCD Acknowledgment.pdf' } });
    expect(tpl).toEqual({
      name: 'ncd_akn',
      variables: { '1': 'Ravi' },
      document: { url: 'https://ncd.test/x.pdf?vt=abc', filename: 'Ravi - NCD Acknowledgment.pdf' },
    });
  });

  // ── Who may send it (owner 2026-09-09: "cxo also needs that access") ───────
  // CXO had no way to send an acknowledgement while 23 external agents did.
  // The fix is a NARROW permission, because both shortcuts were worse:
  // applications:update also grants investment-date and payout-bank edits, and
  // notifications:admin also grants the per-batch interest send.
  describe('who may send it', () => {
    it('CXO can send — the button they were missing', async () => {
      const c = await as('cxo@demo.local');
      const r = await c.post(`/api/applications/${appId}/whatsapp-ack`);
      expect(r.status).toBe(200);
    });

    it('and CXO still cannot edit the investment behind it', async () => {
      // The whole point of the narrow permission. If these ever start passing,
      // someone has widened CXO to applications:update and should not have.
      const c = await as('cxo@demo.local');
      expect((await c.patch(`/api/applications/${appId}/investment-date`,
        { date_money_received: '2026-07-01', reason: 'nope' })).status).toBe(403);
      expect((await c.post(`/api/applications/${appId}/payout-account`,
        { bank_account_id: 1 })).status).toBe(403);
    });

    it('and CXO does not gain the notification queue or the batch interest send', async () => {
      const c = await as('cxo@demo.local');
      expect((await c.get('/api/system/notifications')).status).toBe(403);
    });
  });
});
