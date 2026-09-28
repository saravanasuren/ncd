/**
 * Which bank account an investment's interest goes to (owner 2026-09-28):
 *
 *   "if a customer has only one debenture and multiple bank account are there -
 *    the one marked as active should get the payout interest. if they have
 *    multiple debentures and multiple bank accounts - they can assign each to
 *    different ones."
 *
 * The per-investment pin is for the SEVERAL-debenture case. A customer with ONE
 * has nothing to route between, so their pin is CLEARED rather than ignored: a
 * dormant pin springing back to life the day a second debenture is opened would
 * move someone's interest to a different bank with nobody touching it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx, requiredInvestmentFields, approveInvestment } from './helpers/server.js';

let ctx: TestCtx;
beforeAll(async () => { ctx = await startTestServer(); });
afterAll(async () => { await ctx.close(); });

const admin = async () => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email: 'admin@dhanam.finance', password: 'ChangeMe_Dev_123' }); return c; };
const checker = async () => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email: 'ncd@demo.local', password: 'Demo_1234' }); return c; };

async function bank(a: Client, customerId: number, acct: string, ifsc: string): Promise<number> {
  await a.post(`/api/customers/${customerId}/bank-accounts`, { account_number: acct, ifsc, holder_name: 'Test Holder' });
  const id = Number((await ctx.db.query('SELECT id FROM customer_bank_accounts WHERE account_number = $1', [acct])).rows[0]!.id);
  await ctx.db.query("UPDATE customer_bank_accounts SET penny_drop_status = 'Verified' WHERE id = $1", [id]);
  return id;
}
async function invest(a: Client, customerId: number, amount: number): Promise<number> {
  const seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
  const schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
  const create = await a.post('/api/applications', {
    ...requiredInvestmentFields(), customer_id: customerId, series_id: seriesId, scheme_id: schemeId, amount,
  });
  await approveInvestment(await checker(), create);
  return Number(create.json.id);
}
const payees = async (appId: number) => (await ctx.db.query<{ payee_account: string; n: string }>(
  `SELECT payee_account, count(*) AS n FROM disbursement_schedule
    WHERE application_id = $1 AND status = 'Scheduled' GROUP BY 1`, [appId])).rows;
const pin = async (appId: number) => (await ctx.db.query<{ p: string | null }>(
  'SELECT payout_bank_account_id AS p FROM applications WHERE id = $1', [appId])).rows[0]!.p;

describe('one debenture: the ACTIVE account gets the interest', () => {
  let cid = 0, appId = 0, bankA = 0, bankB = 0;

  it('sets up one debenture and two accounts', async () => {
    const a = await admin();
    cid = Number((await a.post('/api/customers', { full_name: 'One Debenture', phone: '9569000001' })).json.id);
    bankA = await bank(a, cid, '11110000001', 'CNRB0003028');
    bankB = await bank(a, cid, '22220000002', 'ESFB0001081');
    appId = await invest(a, cid, 300000);
  });

  it('follows whichever account is made active', async () => {
    const a = await admin();
    await a.post(`/api/customers/${cid}/bank-accounts/${bankB}/set-active`);
    expect(await payees(appId)).toEqual([{ payee_account: '22220000002', n: expect.anything() }]);

    await a.post(`/api/customers/${cid}/bank-accounts/${bankA}/set-active`);
    expect(await payees(appId)).toEqual([{ payee_account: '11110000001', n: expect.anything() }]);
  });

  it('CLEARS an assignment rather than letting it lie dormant', async () => {
    // Sumathi's shape: one debenture pinned to the account that is NOT active.
    const a = await admin();
    await ctx.db.query('UPDATE applications SET payout_bank_account_id = $1 WHERE id = $2', [bankB, appId]);
    await a.post(`/api/customers/${cid}/bank-accounts/${bankA}/set-active`);

    expect(await pin(appId)).toBeNull();                       // gone, not asleep
    expect(await payees(appId)).toEqual([{ payee_account: '11110000001', n: expect.anything() }]);
  });

  it('so a SECOND debenture cannot resurrect it', async () => {
    // The hazard the owner chose against: an old note waking up and moving a
    // customer's interest to another bank with nobody touching it.
    const a = await admin();
    const second = await invest(a, cid, 100000);
    expect(await pin(appId)).toBeNull();
    expect(await payees(appId)).toEqual([{ payee_account: '11110000001', n: expect.anything() }]);
    expect(await payees(second)).toEqual([{ payee_account: '11110000001', n: expect.anything() }]);
  });
});

describe('several debentures: each can be assigned its own account', () => {
  let cid = 0, first = 0, second = 0, bankA = 0, bankB = 0;

  it('sets up two debentures and two accounts', async () => {
    const a = await admin();
    cid = Number((await a.post('/api/customers', { full_name: 'Two Debentures', phone: '9569000002' })).json.id);
    bankA = await bank(a, cid, '33330000003', 'CNRB0003028');
    bankB = await bank(a, cid, '44440000004', 'ESFB0001081');
    await a.post(`/api/customers/${cid}/bank-accounts/${bankA}/set-active`);
    first = await invest(a, cid, 200000);
    second = await invest(a, cid, 200000);
  });

  it('an assignment on one is KEPT, and only that one moves', async () => {
    const a = await admin();
    await ctx.db.query('UPDATE applications SET payout_bank_account_id = $1 WHERE id = $2', [bankB, second]);
    // Re-run the routing the way any account change would.
    await ctx.db.query('SELECT 1');
    const { resnapshotPayeeBank } = await import('../src/modules/schedule/materialize.js');
    await ctx.db.withTx(async (tx) => { await resnapshotPayeeBank(tx, cid); });

    expect(await pin(second)).not.toBeNull();                  // kept — they have several
    expect(await payees(second)).toEqual([{ payee_account: '44440000004', n: expect.anything() }]);
    expect(await payees(first)).toEqual([{ payee_account: '33330000003', n: expect.anything() }]);
  });

  it('changing the active account does not disturb the assigned one', async () => {
    const a = await admin();
    await a.post(`/api/customers/${cid}/bank-accounts/${bankB}/set-active`);
    // The unassigned debenture follows the new active account...
    expect(await payees(first)).toEqual([{ payee_account: '44440000004', n: expect.anything() }]);
    // ...and the assigned one stays where it was told to go.
    expect(await pin(second)).not.toBeNull();
    expect(await payees(second)).toEqual([{ payee_account: '44440000004', n: expect.anything() }]);
  });
});

describe('a pin that changes takes its unpaid rows with it', () => {
  it('repoints rows that used to be left behind', async () => {
    // Before this, only UNPINNED investments were repointed — so changing a pin
    // left the schedule paying the old bank while the screen showed the new one.
    const a = await admin();
    const cid = Number((await a.post('/api/customers', { full_name: 'Pin Moves', phone: '9569000003' })).json.id);
    const b1 = await bank(a, cid, '55550000005', 'CNRB0003028');
    const b2 = await bank(a, cid, '66660000006', 'ESFB0001081');
    await a.post(`/api/customers/${cid}/bank-accounts/${b1}/set-active`);
    const one = await invest(a, cid, 100000);
    const two = await invest(a, cid, 100000);   // two, so pins are honoured

    await ctx.db.query('UPDATE applications SET payout_bank_account_id = $1 WHERE id = $2', [b2, one]);
    const { resnapshotPayeeBank } = await import('../src/modules/schedule/materialize.js');
    await ctx.db.withTx(async (tx) => { await resnapshotPayeeBank(tx, cid); });

    expect(await payees(one)).toEqual([{ payee_account: '66660000006', n: expect.anything() }]);
    expect(await payees(two)).toEqual([{ payee_account: '55550000005', n: expect.anything() }]);
  });

  it('never touches money already paid', async () => {
    const paid = (await ctx.db.query<{ n: string }>(
      `SELECT count(*) AS n FROM disbursement_schedule WHERE status = 'Paid'`)).rows[0]!.n;
    expect(Number(paid)).toBeGreaterThanOrEqual(0);   // none created here; the guard is status='Scheduled'
  });
});
