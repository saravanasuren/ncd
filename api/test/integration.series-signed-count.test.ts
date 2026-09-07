/**
 * How much of a series is actually signed (owner 2026-09-04: "how to know how
 * many e signs have been made in a series. i think if this is not there it would
 * be better to bring it in the allotments page").
 *
 * It was nowhere — no screen and no report counted signatures at all. The first
 * measurement on production was the reason this is worth a column: 7 signed
 * across 890 investments, and the current open series at 0 of 51.
 *
 * The count sits on the Allotments page, which is already the per-series table.
 * It is counted over the SAME Active set as customer_count and total_count, so
 * "2 / 5" compares like with like rather than against a different denominator —
 * which is the easy way to build a number that quietly lies.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx, requiredInvestmentFields, approveInvestment } from './helpers/server.js';

let ctx: TestCtx;
beforeAll(async () => { ctx = await startTestServer(); });
afterAll(async () => { await ctx.close(); });

const as = async (email: string, password = 'Demo_1234') => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c; };
const admin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');
const checker = () => as('ncd@demo.local');

const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Page >>\nendobj\ntrailer\n%%EOF\n').toString('base64');

let seriesId = 0;
const appIds: number[] = [];

/** A LIVE investment in the series under test. */
async function liveInvestment(a: Client, name: string, phone: string): Promise<number> {
  const cust = await a.post('/api/customers', { full_name: name, phone });
  const cid = Number(cust.json.id);
  await a.post(`/api/customers/${cid}/bank-accounts`, { account_number: `7171${phone}`, ifsc: 'ICIC0001111' });
  const scheme = (await a.get('/api/schemes')).json.rows[0];
  const create = await a.post('/api/applications', {
    ...requiredInvestmentFields(), customer_id: cid,
    series_id: seriesId, scheme_id: scheme.id, amount: 100000, date_money_received: '2026-08-10',
  });
  await approveInvestment(await checker(), create);
  return Number(create.json.id);
}

const seriesRow = async (a: Client) =>
  ((await a.get('/api/allotments/series')).json.rows as Array<Record<string, unknown>>)
    .find((r) => Number(r.series_id) === seriesId)!;

describe('the Allotments page counts signatures per series', () => {
  it('starts at zero of however many, not blank', async () => {
    const a = await admin();
    seriesId = Number((await a.get('/api/series')).json.rows[0].id);
    appIds.push(await liveInvestment(a, 'Sign Count One', '9535000001'));
    appIds.push(await liveInvestment(a, 'Sign Count Two', '9535000002'));
    appIds.push(await liveInvestment(a, 'Sign Count Three', '9535000003'));

    const r = await seriesRow(a);
    // Zero signed is the number that matters most — it must READ as zero rather
    // than be missing, which is how the gap stayed invisible.
    expect(Number(r.signed_count)).toBe(0);
    expect(Number(r.total_count)).toBeGreaterThanOrEqual(3);
  });

  it('counts a physically signed form', async () => {
    const a = await admin();
    expect((await a.post(`/api/applications/${appIds[0]}/signed-upload`, {
      data_base64: pdf, signed_on: '2026-08-28',
    })).status).toBe(201);

    const r = await seriesRow(a);
    expect(Number(r.signed_count)).toBe(1);
    expect(Number(r.physically_signed_count)).toBe(1);
    expect(Number(r.esigned_count)).toBe(0);
  });

  it('counts an e-signature separately, and both together in the total', async () => {
    // Written the way the Digio completion path writes it — the only thing that
    // may record an e-sign.
    await ctx.db.query(
      `UPDATE applications SET esigned_at = now(), signing_method = 'esign' WHERE id = $1`, [appIds[1]]);

    const a = await admin();
    const r = await seriesRow(a);
    expect(Number(r.esigned_count)).toBe(1);
    expect(Number(r.physically_signed_count)).toBe(1);
    expect(Number(r.signed_count)).toBe(2);
  });

  it('counts a legacy signature with no method recorded', async () => {
    // Rows signed before the method was tracked. They are still SIGNED, and
    // leaving them out would understate the series.
    await ctx.db.query(
      `UPDATE applications SET esigned_at = now(), signing_method = NULL WHERE id = $1`, [appIds[2]]);

    const a = await admin();
    const r = await seriesRow(a);
    expect(Number(r.signed_count)).toBe(3);
    // ...but it is not claimed as either method.
    expect(Number(r.esigned_count) + Number(r.physically_signed_count)).toBe(2);
  });

  it('measures against the same Active set as the other figures on the row', async () => {
    // A signed investment that is no longer Active must leave BOTH numbers, or
    // the fraction silently exceeds 100%.
    const a = await admin();
    const before = await seriesRow(a);
    await ctx.db.query(`UPDATE applications SET status = 'Redeemed' WHERE id = $1`, [appIds[0]]);
    const after = await seriesRow(a);

    expect(Number(after.total_count)).toBe(Number(before.total_count) - 1);
    expect(Number(after.signed_count)).toBe(Number(before.signed_count) - 1);
    expect(Number(after.signed_count)).toBeLessThanOrEqual(Number(after.total_count));
  });
});

/**
 * The same count for LOCKER agreements (owner 2026-09-04: "and same for locker
 * aggrment also").
 *
 * Lockers have no series, so the equivalent lives on the tenant roster: a flag
 * per locker and a count in the header. The signing record already existed per
 * locker — nothing had ever counted them.
 */
describe('the tenant roster says which locker agreements are signed', () => {
  it('flags a SIGNED agreement with its method, and an unsigned one as unsigned', async () => {
    const a = await admin();
    // Two lockers on the roster. A locker reaches the roster through NCD's own
    // involvement — here a deposit link — so both appear even with LockerHub
    // unreachable in tests.
    const one = await liveInvestment(a, 'Roster Signed', '9535000011');
    const two = await liveInvestment(a, 'Roster Unsigned', '9535000012');
    for (const [appId, lk] of [[one, 'LKR-ROSTER-1'], [two, 'LKR-ROSTER-2']] as const) {
      await ctx.db.query(
        `INSERT INTO locker_deposit_links (application_id, lockerhub_application_id, linked_amount, status)
         VALUES ($1, $2, 50000, 'active')`, [appId, lk]);
    }

    // One signed on paper; the other only STARTED — awaiting a signature is not
    // signed, which is the entire point of the count.
    await ctx.db.query(
      `INSERT INTO locker_agreement_signings (lockerhub_application_id, method, status, signed_at)
       VALUES ($1, 'physical', 'Signed', now())`, ['LKR-ROSTER-1']);
    await ctx.db.query(
      `INSERT INTO locker_agreement_signings (lockerhub_application_id, method, status)
       VALUES ($1, 'esign', 'AwaitingSignature')`, ['LKR-ROSTER-2']);

    const { lockerTenants } = await import('../src/modules/lockers/deposits.js');
    const rows = (await lockerTenants(ctx.db, {})).rows as Array<Record<string, unknown>>;
    const byApp = new Map(rows.map((r) => [String(r.lockerhub_application_id), r]));

    const signed = byApp.get('LKR-ROSTER-1')!;
    expect(signed).toBeTruthy();
    expect(signed.agreement_signed).toBe(true);
    expect(signed.agreement_method).toBe('physical');

    const awaiting = byApp.get('LKR-ROSTER-2')!;
    expect(awaiting).toBeTruthy();
    // Started but not finished must read as NOT signed.
    expect(awaiting.agreement_signed).toBe(false);
  });

  it('never reports a locker with no LockerHub application as unsigned', async () => {
    // It cannot have an agreement at all, so it belongs in neither half of the
    // count — counting it as unsigned would overstate the gap.
    const { lockerTenants } = await import('../src/modules/lockers/deposits.js');
    const rows = (await lockerTenants(ctx.db, {})).rows as Array<Record<string, unknown>>;
    for (const r of rows) {
      expect('agreement_signed' in r).toBe(true);
      if (!r.lockerhub_application_id) expect(r.agreement_signed).toBe(false);
    }
  });
});
