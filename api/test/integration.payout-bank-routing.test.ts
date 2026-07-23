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

  it('batch creation refreshes the bank on a row that was projected without one', async () => {
    // The batch INSERT resolves the bank live, but collides with the projected
    // row for that date. If ON CONFLICT drops the fresh details, a row projected
    // before the customer had an account reaches the bank file blank — which is
    // how 293 live customers were set up to be paid nowhere.
    const a = await admin();
    const { cid } = await customerWithSchedule(a, 'Batch Refresh Cust', '9520000004');
    await a.post(`/api/customers/${cid}/bank-accounts`, { account_number: '77770007777', ifsc: 'ICIC0001234' });

    // Force the stale state the projection used to leave behind.
    await ctx.db.query(
      `UPDATE disbursement_schedule ds SET payee_account = NULL, payee_ifsc = NULL
         FROM applications a WHERE a.id = ds.application_id AND a.customer_id = $1`, [cid]);

    // Bill on a date a projected Interest row ALREADY occupies, so the batch
    // INSERT collides and takes the ON CONFLICT path. Billing a date with no
    // projected row takes the plain INSERT and proves nothing.
    const projected = await ctx.db.query<{ due_date: string; line_id: string }>(
      `SELECT ds.due_date, ds.line_id FROM disbursement_schedule ds
         JOIN applications a ON a.id = ds.application_id
        WHERE a.customer_id = $1 AND ds.due_type = 'Interest' AND ds.status = 'Scheduled'
        ORDER BY ds.due_date LIMIT 1`, [cid]);
    const dueDate = String(projected.rows[0]!.due_date).slice(0, 10);
    const lineId = Number(projected.rows[0]!.line_id);

    const batch = await a.post('/api/payouts', { payout_date: dueDate });
    expect(batch.status).toBe(201);

    const collided = await ctx.db.query<Record<string, unknown>>(
      `SELECT payee_account, payee_ifsc, batch_id FROM disbursement_schedule
        WHERE line_id = $1 AND due_date = $2 AND due_type = 'Interest'`, [lineId, dueDate]);
    expect(collided.rows.length).toBe(1);              // updated in place, not duplicated
    expect(collided.rows[0]!.batch_id).toBeTruthy();   // it really took the batch path
    expect(collided.rows[0]!.payee_account).toBe('77770007777');
    expect(collided.rows[0]!.payee_ifsc).toBe('ICIC0001234');
  });

  it('an account that was never penny-dropped can still be chosen, and the pin can be cleared', async () => {
    // 403 of 433 live accounts are 'Pending' — never penny-dropped, mostly
    // migrated from wealth. Interest already pays out to whichever account is
    // active regardless of that status, so refusing to PIN an unverified
    // account blocked the feature for nearly every customer while making no
    // payment safer. Ownership is the check that matters.
    const a = await admin();
    const { cid, appId } = await customerWithSchedule(a, 'Unverified Bank Cust', '9520000005');
    await a.post(`/api/customers/${cid}/bank-accounts`, { account_number: '88880008888', ifsc: 'ICIC0001234' });
    const second = await a.post(`/api/customers/${cid}/bank-accounts`, { account_number: '99990009999', ifsc: 'HDFC0005678' });
    const secondId = Number(second.json.id);
    await ctx.db.query("UPDATE customer_bank_accounts SET penny_drop_status = 'Pending' WHERE id = $1", [secondId]);

    const set = await a.post(`/api/applications/${appId}/payout-account`, { bank_account_id: secondId });
    expect(set.status).toBe(200);
    expect((await scheduleRows(cid)).rows.every((r) => r.payee_account === '99990009999')).toBe(true);

    // Clearing the pin hands the NCD back to the customer default.
    const clear = await a.post(`/api/applications/${appId}/payout-account`, { bank_account_id: null });
    expect(clear.status).toBe(200);
    const pin = await ctx.db.query("SELECT payout_bank_account_id FROM applications WHERE id = $1", [appId]);
    expect(pin.rows[0]!.payout_bank_account_id).toBeNull();

    // Another customer's account is still refused — ownership is the real check.
    const other = await customerWithSchedule(a, 'Someone Else', '9520000006');
    const theirs = await a.post(`/api/customers/${other.cid}/bank-accounts`, { account_number: '12120001212', ifsc: 'SBIN0000827' });
    const bad = await a.post(`/api/applications/${appId}/payout-account`, { bank_account_id: Number(theirs.json.id) });
    expect(bad.status).toBe(400);
  });

  it('deleting a bank account is super-admin only, and blocked while anything points at it', async () => {
    const a = await admin();
    const { cid, appId } = await customerWithSchedule(a, 'Delete Bank Cust', '9520000007');
    await a.post(`/api/customers/${cid}/bank-accounts`, { account_number: '31310003131', ifsc: 'ICIC0001234' });
    const spare = await a.post(`/api/customers/${cid}/bank-accounts`, { account_number: '32320003232', ifsc: 'HDFC0005678' });
    const spareId = Number(spare.json.id);

    // Not super-admin → 403. staff@demo.local holds customers:update but not customers:delete.
    const staff = await as('staff@demo.local');
    expect((await staff.del(`/api/customers/${cid}/bank-accounts/${spareId}`)).status).toBe(403);

    // Pinned to an NCD → refused with the application number in the message.
    await a.post(`/api/applications/${appId}/payout-account`, { bank_account_id: spareId });
    const pinned = await a.del(`/api/customers/${cid}/bank-accounts/${spareId}`);
    expect(pinned.status).toBe(409);
    expect(String(pinned.json.error?.message ?? '')).toContain('payout account for');

    // Unpin → delete succeeds and the row is gone.
    await a.post(`/api/applications/${appId}/payout-account`, { bank_account_id: null });
    expect((await a.del(`/api/customers/${cid}/bank-accounts/${spareId}`)).status).toBe(200);
    expect((await ctx.db.query('SELECT 1 FROM customer_bank_accounts WHERE id = $1', [spareId])).rowCount).toBe(0);

    // The ACTIVE account with unpaid payouts pointing at it → refused.
    const activeId = Number((await ctx.db.query(
      'SELECT id FROM customer_bank_accounts WHERE customer_id = $1 AND is_active = TRUE', [cid])).rows[0]!.id);
    expect((await a.del(`/api/customers/${cid}/bank-accounts/${activeId}`)).status).toBe(409);
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
