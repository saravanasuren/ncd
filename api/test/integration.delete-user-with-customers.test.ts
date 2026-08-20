/**
 * Deleting a user who has a customer base (owner 2026-08-20: "even if he is
 * having a customer base ... that user should be deleted and that customers
 * should go under unknown referred by list").
 *
 * This used to be refused outright, and could not have worked anyway: 42
 * columns across the schema reference users(id) with no delete rule, so the
 * DATABASE blocked the row from going. The delete now detaches every one of
 * them first — discovered from the catalogue, so a new table cannot silently
 * reintroduce the block.
 *
 * The rules being guarded:
 *   - the customers and investments SURVIVE, they just stop naming anyone
 *   - somebody else's referral is never cleared as collateral damage
 *   - unpaid commission dies with the account; PAID history is kept
 *   - the deleted person's name is preserved in the audit row, because once
 *     the user row is gone that is the only record of who did the work
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
beforeAll(async () => { ctx = await startTestServer(); });
afterAll(async () => { await ctx.close(); });

const PW = 'ChangeMe_Dev_123';
async function admin() {
  const c = new Client(ctx.base);
  await c.post('/api/auth/login', { email: 'admin@dhanam.finance', password: PW });
  return c;
}

let n = 0;
async function staffUser(name: string): Promise<number> {
  const c = await admin();
  const r = await c.post('/api/users', {
    email: `del${++n}@dhanam.finance`, full_name: name, role: 'branch_staff', password: PW, is_staff: true,
  });
  expect(r.status).toBe(201);
  return Number(r.json.id);
}

async function customerOf(userId: number | null, code: string, referredBy: string | null): Promise<number> {
  const r = await ctx.db.query(
    `INSERT INTO customers (customer_code, full_name, phone, creation_status, is_active,
                            enrolled_by_user_id, referred_by_text)
     VALUES ($1,$2,$3,'Approved',TRUE,$4,$5) RETURNING id`,
    [code, `Cust ${code}`, '97' + String(++n).padStart(8, '0'), userId, referredBy]);
  return Number(r.rows[0]!.id);
}

const del = async (id: number) => (await admin()).del(`/api/users/${id}`);
const userExists = async (id: number) =>
  ((await ctx.db.query('SELECT 1 FROM users WHERE id = $1', [id])).rowCount ?? 0) > 0;

describe('a user with a customer base can now be deleted', () => {
  it('deletes, and the customers survive with no referrer', async () => {
    const uid = await staffUser('Has Customers');
    const c1 = await customerOf(uid, 'DELC01', 'Has Customers');
    const c2 = await customerOf(uid, 'DELC02', 'Has Customers');

    const r = await del(uid);
    expect(r.status).toBe(200);
    expect(await userExists(uid)).toBe(false);

    const rows = await ctx.db.query<{ id: string; enrolled_by_user_id: string | null; referred_by_text: string | null }>(
      'SELECT id, enrolled_by_user_id, referred_by_text FROM customers WHERE id = ANY($1)', [[c1, c2]]);
    expect(rows.rowCount).toBe(2);                       // customers are NOT deleted
    for (const row of rows.rows) {
      expect(row.enrolled_by_user_id).toBeNull();        // "unknown"
      expect(row.referred_by_text).toBeNull();
    }
  });

  it('does NOT clear a referral that names somebody else', async () => {
    const victim = await staffUser('Going Away');
    const other = await staffUser('Stays Put');
    const mine = await customerOf(victim, 'DELC03', 'Going Away');
    const theirs = await customerOf(other, 'DELC04', 'Stays Put');

    expect((await del(victim)).status).toBe(200);

    const keep = await ctx.db.query<{ referred_by_text: string | null; enrolled_by_user_id: string | null }>(
      'SELECT referred_by_text, enrolled_by_user_id FROM customers WHERE id = $1', [theirs]);
    expect(keep.rows[0]!.referred_by_text).toBe('Stays Put');       // untouched
    expect(Number(keep.rows[0]!.enrolled_by_user_id)).toBe(other);
    const gone = await ctx.db.query<{ referred_by_text: string | null }>(
      'SELECT referred_by_text FROM customers WHERE id = $1', [mine]);
    expect(gone.rows[0]!.referred_by_text).toBeNull();
  });

  it('drops unpaid commission but keeps what was already paid', async () => {
    const uid = await staffUser('Owed Money');
    const cid = await customerOf(uid, 'DELC05', null);
    const seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
    const appId = Number((await ctx.db.query(
      `INSERT INTO applications (application_no, customer_id, series_id, status, total_amount, date_money_received)
       VALUES ('APP-DEL-1',$1,$2,'Active',100000,'2026-07-01') RETURNING id`, [cid, seriesId])).rows[0]!.id);
    const appId2 = Number((await ctx.db.query(
      `INSERT INTO applications (application_no, customer_id, series_id, status, total_amount, date_money_received)
       VALUES ('APP-DEL-2',$1,$2,'Active',100000,'2026-07-01') RETURNING id`, [cid, seriesId])).rows[0]!.id);
    await ctx.db.query(
      `INSERT INTO incentive_accruals (application_id, payee_type, payee_id, rate_mode, rate_value, amount, accrual_date)
       VALUES ($1,'staff',$2,'pct',2,2000,'2026-07-01'), ($3,'staff',$2,'pct',2,3000,'2026-07-01')`,
      [appId, uid, appId2]);
    // Mark one as paid.
    await ctx.db.query("UPDATE incentive_accruals SET paid_at = now() WHERE application_id = $1", [appId2]);

    expect((await del(uid)).status).toBe(200);

    const left = await ctx.db.query<{ amount: string; paid: boolean }>(
      "SELECT amount, paid_at IS NOT NULL AS paid FROM incentive_accruals WHERE payee_type='staff' AND payee_id=$1", [uid]);
    expect(left.rowCount).toBe(1);
    expect(Number(left.rows[0]!.amount)).toBe(3000);     // the PAID one
    expect(left.rows[0]!.paid).toBe(true);
  });

  it('keeps the name in the audit log — the only record left of who did the work', async () => {
    const uid = await staffUser('Remembered Person');
    await customerOf(uid, 'DELC06', null);
    expect((await del(uid)).status).toBe(200);

    const { rows } = await ctx.db.query<{ before_data: any; after_data: any }>(
      `SELECT before_data, after_data FROM audit_log
        WHERE action = 'user.delete' AND entity_id = $1 ORDER BY id DESC LIMIT 1`, [String(uid)]);
    expect(rows[0]!.before_data.full_name).toBe('Remembered Person');
    expect(Number(rows[0]!.after_data.customers_to_unknown)).toBe(1);
  });

  it('detaches an audit stamp that would otherwise block the delete', async () => {
    // approval_requests.maker_user_id is one of the 42 no-delete-rule columns.
    // Before this change it made the DELETE fail at the database.
    const uid = await staffUser('Raised Approvals');
    await ctx.db.query(
      `INSERT INTO approval_requests (request_no, request_type, entity_type, entity_id, status, level, maker_user_id, metadata)
       VALUES ('REQ-DEL-1','subscription','applications','1','Pending',1,$1,'{}'::jsonb)`, [uid]);

    expect((await del(uid)).status).toBe(200);
    expect(await userExists(uid)).toBe(false);
    const req = await ctx.db.query<{ maker_user_id: string | null }>(
      "SELECT maker_user_id FROM approval_requests WHERE request_no = 'REQ-DEL-1'");
    expect(req.rowCount).toBe(1);                        // the request survives
    expect(req.rows[0]!.maker_user_id).toBeNull();       // just unattributed
  });
});

describe('the guards that stay', () => {
  it('still refuses to delete yourself', async () => {
    const me = Number((await ctx.db.query("SELECT id FROM users WHERE email='admin@dhanam.finance'")).rows[0]!.id);
    const r = await del(me);
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(await userExists(me)).toBe(true);
  });

  it('404s on a user that does not exist', async () => {
    expect((await del(99999)).status).toBe(404);
  });

  it('needs users:delete — branch staff cannot', async () => {
    const uid = await staffUser('Protected From Staff');
    const c = new Client(ctx.base);
    await c.post('/api/auth/login', { email: 'staff@demo.local', password: 'Demo_1234' });
    expect((await c.del(`/api/users/${uid}`)).status).toBe(403);
    expect(await userExists(uid)).toBe(true);
  });
});
