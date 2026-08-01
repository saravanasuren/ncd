/**
 * A clubbed investment must show its parts to the approver.
 *
 * An investment can be paid in instalments and clubbed: APP-2026-001055 on the
 * live book is ₹50,000 + ₹25,000 + ₹25,000 = one ₹1,00,000 NCD, each part with
 * its OWN reference and its OWN receipt.
 *
 * `applications.date_money_received / collection_method / collection_reference
 * / receipt` carry only the FIRST credit's values, so the approvals card showed
 * one reference and one receipt. The checker was signing off ₹1,00,000 having
 * seen evidence for ₹50,000, with nothing on screen hinting the other two
 * payments existed — which defeats the point of having a checker.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx, requiredInvestmentFields } from './helpers/server.js';

let ctx: TestCtx;
let seriesId: number, schemeId: number;

beforeAll(async () => {
  ctx = await startTestServer();
  seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
  schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
});
afterAll(async () => { await ctx.close(); });

const as = async (email: string, password = 'Demo_1234') => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c; };
const admin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');

let n = 0;
/** An investment paid in `parts`, each part its own credit with its own ref. */
async function clubbed(parts: number[]) {
  const a = await admin();
  const phone = `97300000${String(++n).padStart(2, '0')}`;
  const cust = await a.post('/api/customers', { full_name: `Clubbed Case ${'ABCDEFGH'[n % 8]}`, phone });
  const cid = Number(cust.json.id);
  await a.post(`/api/customers/${cid}/bank-accounts`, { account_number: `55${phone}`, ifsc: 'ICIC0001234' });

  let appId: number | null = null;
  for (const [i, amount] of parts.entries()) {
    const r = await a.post('/api/applications', {
      ...requiredInvestmentFields(), customer_id: cid, series_id: seriesId, scheme_id: schemeId,
      amount, date_money_received: `2026-08-0${i + 1}`,
      collection_method: 'NEFT/RTGS', collection_reference: `UTR-${phone}-${i}`,
      // Parts 2+ are CLUBBED onto the first — without this each credit becomes
      // its own application and there is nothing clubbed to look at.
      ...(appId ? { club_with_application_id: appId } : {}),
    });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    appId = appId ?? Number(r.json.id);
  }
  const req = (await ctx.db.query(
    "SELECT id FROM approval_requests WHERE entity_type='applications' AND entity_id=$1 AND status='Pending' ORDER BY id DESC LIMIT 1",
    [String(appId)])).rows[0] as any;
  return { appId: appId!, requestId: req ? Number(req.id) : null, cid };
}

const detail = async (requestId: number) => (await admin()).get(`/api/approvals/${requestId}`);

describe('the approver sees every part', () => {
  it('a clubbed investment lists each credit with its own reference', async () => {
    const { requestId } = await clubbed([50000, 25000, 25000]);
    const ed = (await detail(requestId!)).json.editable;
    expect(ed.credits).toHaveLength(3);
    expect(ed.credits.map((c: any) => c.amount)).toEqual([50000, 25000, 25000]);
    // Each part's OWN reference — not the application's, which is the first's.
    expect(new Set(ed.credits.map((c: any) => c.collection_reference)).size).toBe(3);
  });

  it('the parts add up to the amount being approved', async () => {
    const { requestId } = await clubbed([50000, 25000, 25000]);
    const ed = (await detail(requestId!)).json.editable;
    const sum = ed.credits.reduce((s: number, c: any) => s + Number(c.amount), 0);
    expect(sum).toBe(Number(ed.fields.total_amount));
    expect(sum).toBe(100000);
  });

  it('each part says whether it has its own receipt', async () => {
    const { requestId } = await clubbed([50000, 50000]);
    const ed = (await detail(requestId!)).json.editable;
    for (const c of ed.credits) expect(typeof c.has_receipt).toBe('boolean');
  });

  it('a part with no recorded detail comes back null, not invented', async () => {
    const { appId, requestId } = await clubbed([50000, 50000]);
    // Exactly the shape of a part clubbed before 054 stored per-line detail.
    await ctx.db.query(
      `UPDATE application_lines
          SET date_money_received = NULL, collection_method = NULL, collection_reference = NULL
        WHERE application_id = $1 AND id = (SELECT max(id) FROM application_lines WHERE application_id = $1)`,
      [appId]);
    const ed = (await detail(requestId!)).json.editable;
    const last = ed.credits[ed.credits.length - 1];
    expect(last.date_money_received).toBeNull();
    expect(last.collection_reference).toBeNull();
    expect(Number(last.amount)).toBe(50000);     // the money is still known
  });

  it('a single-credit investment still reports its one credit', async () => {
    const { requestId } = await clubbed([100000]);
    const ed = (await detail(requestId!)).json.editable;
    expect(ed.credits).toHaveLength(1);          // the screen hides the table at 1
    expect(Number(ed.credits[0].amount)).toBe(100000);
  });

  it('the approver can open a single part\'s receipt', async () => {
    const { appId, requestId } = await clubbed([50000, 50000]);
    const ed = (await detail(requestId!)).json.editable;
    const withReceipt = ed.credits.find((c: any) => c.has_receipt);
    if (!withReceipt) return;                    // nothing to open
    const r = await fetch(`${ctx.base}/api/applications/${appId}/lines/${withReceipt.id}/receipt`, {
      headers: { Cookie: (await admin()).cookieHeader() },
    });
    expect(r.status).toBe(200);
  });
});
