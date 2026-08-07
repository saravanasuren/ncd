/**
 * "Enrolled by" must call someone what they actually are.
 *
 * Owner, 2026-08-04: "I GET TO SEE ONLY agent selvaraj kumar but in the customer
 * enrollment i get to see selvarajkumar staff."
 *
 * Selvarajkumar is a `users` row with role=agent and is_staff=false, and NO
 * `agents` row. He logs in and enrols as a user, so the customer carries
 * enrolled_by_user_id — and the old rule read "user column populated ⇒ staff",
 * printing "(staff)" for the person the Users page lists as Agent. Four users
 * and six customers are in that state on production today.
 *
 * The test is is_staff, the same one the Incentives page uses to choose the
 * Staff vs Agent tab, so the screens agree about one person.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
beforeAll(async () => { ctx = await startTestServer(); });
afterAll(async () => { await ctx.close(); });

async function admin() {
  const c = new Client(ctx.base);
  await c.post('/api/auth/login', { email: 'admin@dhanam.finance', password: 'ChangeMe_Dev_123' });
  return c;
}
const kindOf = async (customerId: number) =>
  (await (await admin()).get(`/api/customers/${customerId}`)).json.customer;

/** A customer enrolled by `userId`, with no agents row involved. */
async function customerEnrolledBy(code: string, userId: number): Promise<number> {
  const r = await ctx.db.query(
    `INSERT INTO customers (customer_code, full_name, phone, creation_status, enrolled_by_user_id, is_active)
     VALUES ($1,$2,$3,'Approved',$4,TRUE) RETURNING id`,
    [code, `Cust ${code}`, '90000' + code.slice(-5), userId]);
  return Number(r.rows[0]!.id);
}

describe('enrolled_by_kind', () => {
  let agentUserId: number, staffUserId: number;

  beforeAll(async () => {
    agentUserId = Number((await ctx.db.query("SELECT id FROM users WHERE email = 'agent@demo.local'")).rows[0]!.id);
    staffUserId = Number((await ctx.db.query("SELECT id FROM users WHERE email = 'staff@demo.local'")).rows[0]!.id);
    // Pin the two states this distinction turns on, rather than trusting the
    // seed to have them the way this test needs.
    await ctx.db.query('UPDATE users SET is_staff = FALSE WHERE id = $1', [agentUserId]);
    await ctx.db.query('UPDATE users SET is_staff = TRUE  WHERE id = $1', [staffUserId]);
  });

  it('calls an agent-role user an AGENT, even with no agents row', async () => {
    // The Selvarajkumar case exactly: no agents row, so enrolled_by_agent_id is
    // null and only the user column is set. That must not read as staff.
    const id = await customerEnrolledBy('EBK001', agentUserId);
    const c = await kindOf(id);
    expect(c.enrolled_by_kind).toBe('agent');
    expect(c.enrolled_by_name).toBeTruthy();
    // No agents row means no agent_code — the UI prints a bare "(agent)", which
    // is honest. It must not invent one.
    expect(c.enrolled_by_agent_code ?? null).toBeNull();
  });

  it('still calls a real staff user STAFF', async () => {
    const id = await customerEnrolledBy('EBK002', staffUserId);
    expect((await kindOf(id)).enrolled_by_kind).toBe('staff');
  });

  it('follows the flag, not the role name, when a user is re-designated', async () => {
    // Ticking someone as staff is what moves them; the fix must track that
    // rather than pattern-matching the role string.
    const id = await customerEnrolledBy('EBK003', agentUserId);
    expect((await kindOf(id)).enrolled_by_kind).toBe('agent');
    await ctx.db.query('UPDATE users SET is_staff = TRUE WHERE id = $1', [agentUserId]);
    expect((await kindOf(id)).enrolled_by_kind).toBe('staff');
    await ctx.db.query('UPDATE users SET is_staff = FALSE WHERE id = $1', [agentUserId]);
    expect((await kindOf(id)).enrolled_by_kind).toBe('agent');
  });

  it('leaves it null when nobody is recorded as the enroller', async () => {
    // Migrated investments carry no enroller. "Unknown" must stay unknown
    // rather than defaulting to either side.
    const r = await ctx.db.query(
      `INSERT INTO customers (customer_code, full_name, phone, creation_status, is_active)
       VALUES ('EBK004','No Enroller','9000044444','Approved',TRUE) RETURNING id`);
    const c = await kindOf(Number(r.rows[0]!.id));
    expect(c.enrolled_by_kind ?? null).toBeNull();
    expect(c.enrolled_by_name ?? null).toBeNull();
  });
});
