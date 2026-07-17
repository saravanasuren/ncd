/**
 * Customers list excludes dhanamfin/LockerHub profile-only syncs.
 *
 * A "customer" is someone a human enrolled (staff or agent) or who holds ≥1
 * application. Pure profile syncs (no enroller, no application) are leads and
 * must NOT appear on the Customers page — even though they live in the
 * `customers` table (the dhanamfin integration lands them there Approved).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
let seriesId: number;

beforeAll(async () => {
  ctx = await startTestServer();
  seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
});
afterAll(async () => { await ctx.close(); });

const admin = async () => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email: 'admin@dhanam.finance', password: 'ChangeMe_Dev_123' }); return c; };

/** Insert a customer row directly (bypasses enrolment), like a LockerHub sync. */
async function syncCustomer(code: string, name: string): Promise<number> {
  const { rows } = await ctx.db.query<{ id: string }>(
    `INSERT INTO customers (customer_code, full_name, kyc_status, creation_status, is_active)
     VALUES ($1,$2,'Pending','Approved',TRUE) RETURNING id`, [code, name]);
  return Number(rows[0]!.id);
}

async function addApplication(customerId: number, appNo: string) {
  await ctx.db.query(
    `INSERT INTO applications (application_no, customer_id, series_id, status, total_amount)
     VALUES ($1,$2,$3,'PendingActivation',100000)`, [appNo, customerId, seriesId]);
}

describe('Customers list — leads vs customers', () => {
  it('hides profile-only syncs, keeps staff-enrolled and app-holders', async () => {
    const a = await admin();

    // 1) staff-enrolled (via the API → enrolled_by_user_id set)
    const staff = await a.post('/api/customers', { full_name: 'Staff Enrolled', phone: '9811111111' });
    const staffId = Number(staff.json.id);

    // 2) pure dhanamfin sync — no enroller, no application → a lead
    const leadId = await syncCustomer('SYNC-LEAD-1', 'Dhanamfin Lead');

    // 3) sync profile that later got an application → a real customer
    const convertedId = await syncCustomer('SYNC-CONV-1', 'Converted Investor');
    await addApplication(convertedId, 'APP-TEST-CONV-1');

    const list = await a.get('/api/customers');
    expect(list.status).toBe(200);
    const ids = (list.json.rows as Array<{ id: number }>).map((r) => Number(r.id));

    expect(ids).toContain(staffId);        // staff-enrolled → shown
    expect(ids).toContain(convertedId);    // has an application → shown
    expect(ids).not.toContain(leadId);     // profile-only sync → hidden
  });

  it('still reachable directly (search/enrol a lead is not blocked)', async () => {
    const a = await admin();
    const leadId = await syncCustomer('SYNC-LEAD-2', 'Reachable Lead');
    // The detail endpoint does not apply the list filter — staff can open a
    // lead to enrol them; once they have an application they join the list.
    const detail = await a.get(`/api/customers/${leadId}`);
    expect(detail.status).toBe(200);
    expect(detail.json.customer.full_name).toBe('Reachable Lead');
  });
});
