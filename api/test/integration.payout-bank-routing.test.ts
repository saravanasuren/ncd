/**
 * Which bank account a payout actually goes to.
 *
 * Two rules, both from the owner (2026-07-23):
 *   1. A payout keeps the account it was going to until it is PAID. Change the
 *      bank afterwards and only the still-unpaid rows move — money already sent
 *      keeps the account it was sent to.
 *   2. A customer with several NCDs can route each one to a different bank, by
 *      pinning that application to an account. The customer-level default must
 *      never overwrite a pinned application.
 *
 * The bug this pins: a bank account added AFTER the schedule was materialised
 * never reached the payout rows. 293 live customers had bank details on file
 * and 18k scheduled rows with none, so the bank file would have paid nobody.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, approveInvestment, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
let seriesId: number, schemeId: number;

beforeAll(async () => {
  ctx = await startTestServer();
  seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
  schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
});
afterAll(async () => { await ctx.close(); });

async function as(email: string, password = 'Demo_1234') {
  const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c;
}
const admin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');

/** A customer with an allotted NCD, so the schedule is already materialised. */
async function customerWithSchedule(a: Client, name: string, phone: string) {
  const c = await a.post('/api/customers', { full_name: name, phone });
  const cid = Number(c.json.id);
  const app = await a.post('/api/applications', {
    customer_id: cid, series_id: seriesId, scheme_id: schemeId, amount: 500000, date_money_received: '2026-07-01',
  });
  await approveInvestment(await as('ncd@demo.local'), app);
  return { cid, appId: Number(app.json.id) };
}

const scheduleRows = (cid: number) => ctx.db.query<Record<string, unknown>>(
  `SELECT ds.id, ds.status, ds.payee_account, ds.payee_ifsc
     FROM disbursement_schedule ds JOIN applications a ON a.id = ds.application_id
    WHERE a.customer_id = $1 ORDER BY ds.due_date`, [cid]);

describe('payout bank routing', () => {
  it('a bank account added after allotment reaches the unpaid payout rows', async () => {
    const a = await admin();
    const { cid } = await customerWithSchedule(a, 'Late Bank Cust', '9520000001');

    // Materialised with no bank on file — this is the state 293 customers were in.
    const before = await scheduleRows(cid);
    expect(before.rows.length).toBeGreaterThan(0);
    expect(before.rows.every((r) => !r.payee_account)).toBe(true);

    const add = await a.post(`/api/customers/${cid}/bank-accounts`, { account_number: '66660001111', ifsc: 'ICIC0001234' });
    expect(add.status).toBe(201);

    const after = await scheduleRows(cid);
    expect(after.rows.every((r) => r.payee_account === '66660001111')).toBe(true);
    expect(after.rows.every((r) => r.payee_ifsc === 'ICIC0001234')).toBe(true);
  });

  it('changing the default moves only the UNPAID rows — paid ones keep their bank', async () => {
    const a = await admin();
    const { cid } = await customerWithSchedule(a, 'Switch Bank Cust', '9520000002');
    await a.post(`/api/customers/${cid}/bank-accounts`, { account_number: '11110001111', ifsc: 'ICIC0001234' });

    // Pay the first row, exactly as a completed batch would leave it.
    const rows = await scheduleRows(cid);
    const paidId = Number(rows.rows[0]!.id);
    await ctx.db.query("UPDATE disbursement_schedule SET status = 'Paid' WHERE id = $1", [paidId]);

    const second = await a.post(`/api/customers/${cid}/bank-accounts`, { account_number: '22220002222', ifsc: 'HDFC0005678' });
    const newBankId = Number(second.json.id);
    // A second account is not the default until it is made one.
    expect((await scheduleRows(cid)).rows.every((r) => r.payee_account === '11110001111')).toBe(true);

    const act = await a.post(`/api/customers/${cid}/bank-accounts/${newBankId}/set-active`, {});
    expect(act.status).toBe(200);

    const after = await scheduleRows(cid);
    const paid = after.rows.find((r) => Number(r.id) === paidId)!;
    expect(paid.payee_account).toBe('11110001111');   // already sent — untouched
    for (const r of after.rows.filter((x) => Number(x.id) !== paidId)) {
      expect(r.payee_account).toBe('22220002222');    // still unpaid — follows the default
      expect(r.payee_ifsc).toBe('HDFC0005678');
    }
  });

  it('an NCD pinned to its own account ignores the customer default', async () => {
    const a = await admin();
    const { cid, appId } = await customerWithSchedule(a, 'Pinned Bank Cust', '9520000003');
    await a.post(`/api/customers/${cid}/bank-accounts`, { account_number: '33330003333', ifsc: 'ICIC0001234' });
    const pinned = await a.post(`/api/customers/${cid}/bank-accounts`, { account_number: '44440004444', ifsc: 'HDFC0005678' });
    const pinnedId = Number(pinned.json.id);

    // Route THIS NCD to the second bank — the per-NCD scenario.
    const set = await a.post(`/api/applications/${appId}/payout-account`, { bank_account_id: pinnedId });
    expect(set.status).toBe(200);
    expect((await scheduleRows(cid)).rows.every((r) => r.payee_account === '44440004444')).toBe(true);

    // Changing the customer-level default must NOT drag the pinned NCD back.
    const third = await a.post(`/api/customers/${cid}/bank-accounts`, { account_number: '55550005555', ifsc: 'SBIN0000827' });
    await a.post(`/api/customers/${cid}/bank-accounts/${Number(third.json.id)}/set-active`, {});

    const after = await scheduleRows(cid);
    expect(after.rows.every((r) => r.payee_account === '44440004444')).toBe(true);
  });
});
