/**
 * Payout tranche consolidation (owner 2026-08-24, [[payout-tranche-consolidation]]).
 *
 * 🔒 interest-logic-locked territory. Three owner decisions, each pinned here:
 *   1. A tranche whose interest rounds to ₹0 SHOWS on the payout screen/Summary
 *      but is kept OUT of the NEFT bank file (a ₹0 wire is rejected).
 *   2. A clubbed investment's merged interest = COMBINE the principal first, then
 *      compute gross/TDS ONCE (rounded once) — authoritative over the sum of the
 *      per-tranche rounded figures.
 *   3. A tranche folds into the merged line once its BROKEN period has been paid;
 *      until then it is its own row.
 *
 * The proof the owner asked for — "the whole book's payout total does not move
 * except where consolidation is intended" — is: a single-tranche investment is a
 * group of one and is byte-identical (control test), the entire existing payout
 * suite still passes, and the ONLY movement is the round-once delta on a genuinely
 * clubbed investment (asserted to the rupee here).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import ExcelJS from 'exceljs';
import { startTestServer, Client, approveInvestment, requiredInvestmentFields, type TestCtx } from './helpers/server.js';
import { roundRupee } from '../src/lib/dates.js';

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
// Demo scheme: 12% Monthly, Actual365 (denom 365). Deemed 2026-07-01, payout day 28.
const RATE = 12, DENOM = 365;

/** Create a customer with a uniquely-numbered bank account (so NEFT rows can be filtered to it). */
async function customerWithBank(a: Client, name: string, phone: string, account: string) {
  const cust = await a.post('/api/customers', { full_name: name, phone });
  await a.post(`/api/customers/${cust.json.id}/bank-accounts`, { account_number: account, ifsc: 'ICIC0001234', holder_name: name });
  return Number(cust.json.id);
}
/** Mark a line's first (broken) period Paid at 2026-07-28, so it becomes foldable. */
async function payBrokenPeriod(lineIds: number[]) {
  await ctx.db.query(
    `UPDATE disbursement_schedule SET status = 'Paid', paid_at = '2026-07-28'
      WHERE line_id = ANY($1) AND due_date = '2026-07-28' AND due_type IN ('Interest','BrokenInterest')`, [lineIds]);
}
const linesOf = async (appId: number) =>
  (await ctx.db.query('SELECT id FROM application_lines WHERE application_id = $1 ORDER BY id', [appId])).rows.map((r) => Number(r.id));
const preview = async (date: string) => (await (await admin()).get(`/api/payouts/preview?date=${date}`)).json;

describe('decision 2 + 3 — clubbed tranches fold into ONE line, principal combined then computed once', () => {
  it('merges to a single row whose gross is the round-once figure, and leaves a single-tranche control untouched', async () => {
    const a = await admin();
    // Clubbed investment: three ₹1,00,000 tranches → ₹3,00,000.
    const cust = await customerWithBank(a, 'Consol Clubbed', '9702000001', '600000001');
    const first = await a.post('/api/applications', {
      ...requiredInvestmentFields(), customer_id: cust, series_id: seriesId, scheme_id: schemeId,
      amount: 100000, date_money_received: '2026-07-05',
    });
    await approveInvestment(await as('ncd@demo.local'), first);
    const appId = Number(first.json.id);
    for (const amt of [100000, 100000]) {
      const club = await a.post('/api/applications', {
        ...requiredInvestmentFields(), customer_id: cust, series_id: seriesId, scheme_id: schemeId,
        amount: amt, date_money_received: '2026-07-05', club_with_application_id: appId,
      });
      expect(club.json.clubbed).toBe(true);
    }
    const lines = await linesOf(appId);
    expect(lines).toHaveLength(3);

    // Control: an ordinary single-tranche ₹1,00,000 investment.
    const cust2 = await customerWithBank(a, 'Consol Control', '9702000002', '600000002');
    const solo = await a.post('/api/applications', {
      ...requiredInvestmentFields(), customer_id: cust2, series_id: seriesId, scheme_id: schemeId,
      amount: 100000, date_money_received: '2026-07-05',
    });
    await approveInvestment(await as('ncd@demo.local'), solo);
    const soloLines = await linesOf(Number(solo.json.id));

    // Settle every tranche's broken period → all foldable, sharing 2026-07-28.
    await payBrokenPeriod([...lines, ...soloLines]);

    // Next cut-off: the clubbed investment now pays as ONE line.
    const p = await preview('2026-08-28');
    const clubbedRows = (p.rows as any[]).filter((r) => Number(r.application_id) === appId);
    expect(clubbedRows).toHaveLength(1);                       // decision 3: folded into one
    const m = clubbedRows[0]!;
    expect(Number(m.days)).toBe(31);
    // decision 2: combine principal (₹3,00,000) THEN round once.
    const roundOnce = roundRupee((300000 * RATE) / 100 * Number(m.days) / DENOM);
    const sumOfTranches = 3 * roundRupee((100000 * RATE) / 100 * Number(m.days) / DENOM);
    expect(Number(m.gross_amount)).toBe(roundOnce);
    expect(roundOnce).not.toBe(sumOfTranches);                // the two genuinely differ (₹3058 vs ₹3057)
    expect(Number(m.investment_amount)).toBe(300000);         // Summary shows the combined principal
    expect(Number(m.net_amount)).toBe(Number(m.gross_amount) - Number(m.tds_amount));

    // Control is a group of one → byte-identical to the plain per-line formula.
    const soloRows = (p.rows as any[]).filter((r) => Number(r.application_id) === Number(solo.json.id));
    expect(soloRows).toHaveLength(1);
    expect(Number(soloRows[0]!.gross_amount)).toBe(roundRupee((100000 * RATE) / 100 * Number(soloRows[0]!.days) / DENOM));
  });
});

describe('decision 1 — a ₹0 tranche shows on the screen but not in the NEFT file', () => {
  it('keeps the rounds-to-zero tranche on the preview, and excludes it from the bank sheet', async () => {
    const a = await admin();
    const cust = await customerWithBank(a, 'Consol Zero', '9702000003', '600000003');
    // Credited close to the cut-off (13 days), the way S.Priyanka's ₹100 leg was —
    // previewDue accrues a never-paid tranche from the investment's interest-start
    // date, so ₹100 × 12% × 13/365 = ₹0.43 → ₹0, while the ₹1,00,000 leg pays ₹427.
    const first = await a.post('/api/applications', {
      ...requiredInvestmentFields(), customer_id: cust, series_id: seriesId, scheme_id: schemeId,
      amount: 100000, date_money_received: '2026-07-16',
    });
    await approveInvestment(await as('ncd@demo.local'), first);
    const appId = Number(first.json.id);
    const club = await a.post('/api/applications', {
      ...requiredInvestmentFields(), customer_id: cust, series_id: seriesId, scheme_id: schemeId,
      amount: 100, date_money_received: '2026-07-20', club_with_application_id: appId,
    });
    expect(club.json.clubbed).toBe(true);

    // First cut-off: both tranches are still in their own broken period.
    const p = await preview('2026-07-28');
    const rows = (p.rows as any[]).filter((r) => Number(r.application_id) === appId);
    const zero = rows.filter((r) => Number(r.gross_amount) === 0);
    expect(zero).toHaveLength(1);                              // the ₹0 tranche is SHOWN (no longer "missing")
    expect(rows.length).toBe(2);                              // both tranches visible on screen

    // The NEFT bank file for the same date must NOT carry the ₹0 line.
    const sheet = (await a.raw(`/api/payouts/sheet.xlsx?date=2026-07-28`)).buffer;
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(sheet);
    const ws = wb.worksheets[0]!;
    let toThisAccount = 0;
    ws.eachRow((row, n) => { if (n > 1 && String(row.getCell(5).value ?? '') === '600000003') toThisAccount++; });
    expect(toThisAccount).toBe(1);                            // only the ₹1,00,000 tranche wires; the ₹0 is dropped
  });
});

describe('safety — the folded tranches advance in lock-step, so nothing is paid twice', () => {
  it('after paying the merged batch, every tranche is settled to the date and the next cut-off does not re-accrue it', async () => {
    const a = await admin();
    const ncd = await as('ncd@demo.local');
    const cust = await customerWithBank(a, 'Consol NoDouble', '9702000004', '600000004');
    const first = await a.post('/api/applications', {
      ...requiredInvestmentFields(), customer_id: cust, series_id: seriesId, scheme_id: schemeId,
      amount: 100000, date_money_received: '2026-07-05',
    });
    await approveInvestment(ncd, first);
    const appId = Number(first.json.id);
    for (const amt of [100000, 100000]) {
      await a.post('/api/applications', {
        ...requiredInvestmentFields(), customer_id: cust, series_id: seriesId, scheme_id: schemeId,
        amount: amt, date_money_received: '2026-07-05', club_with_application_id: appId,
      });
    }
    const lines = await linesOf(appId);
    expect(lines).toHaveLength(3);
    await payBrokenPeriod(lines);

    // Maker creates the merged batch at the next cut-off; a distinct checker pays it.
    const batch = await ncd.post('/api/payouts', { payout_date: '2026-08-28' });
    expect(batch.status).toBe(201);
    await a.post(`/api/approvals/${batch.json.request.id}/approve`);

    // Every tranche now has a Paid row at 2026-08-28 — the ₹0 siblings carried the
    // watermark forward alongside the representative row.
    const paid = await ctx.db.query(
      "SELECT count(*)::int n FROM disbursement_schedule WHERE line_id = ANY($1) AND due_date = '2026-08-28' AND status = 'Paid'", [lines]);
    expect(Number(paid.rows[0]!.n)).toBe(3);

    // Re-previewing the SAME date must not re-bill the investment (no double-pay)…
    const same = (await preview('2026-08-28')).rows as any[];
    expect(same.filter((r) => Number(r.application_id) === appId)).toHaveLength(0);
    // …and the next cut-off accrues exactly one fresh merged period, not four.
    const next = (await preview('2026-09-28')).rows as any[];
    const nextRows = next.filter((r) => Number(r.application_id) === appId);
    expect(nextRows).toHaveLength(1);
    expect(Number(nextRows[0]!.gross_amount)).toBe(roundRupee((300000 * RATE) / 100 * Number(nextRows[0]!.days) / DENOM));
  });
});
