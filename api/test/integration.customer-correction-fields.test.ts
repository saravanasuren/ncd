/**
 * Customer corrections must apply every field the UI offers.
 *
 * The correction form and the apply-time allow-list used to be two hand-kept
 * lists that disagreed: the UI offered `pan`, the server's allow-list did not
 * contain it, so a PAN correction was submitted, approved by a checker, and
 * then silently discarded. Both sides now render from
 * CORRECTABLE_CUSTOMER_FIELDS in @new-wealth/shared. These tests pin that down
 * from both ends — a correctable field really lands, and a non-correctable one
 * is refused up front instead of being accepted and dropped.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { CORRECTABLE_CUSTOMER_KEYS } from '@new-wealth/shared';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
beforeAll(async () => { ctx = await startTestServer(); });
afterAll(async () => { await ctx.close(); });

const superAdmin = async () => {
  const c = new Client(ctx.base);
  await c.post('/api/auth/login', { email: 'admin@dhanam.finance', password: 'ChangeMe_Dev_123' });
  return c;
};
const SELF_APPROVE = { extra: { self_approval_reason: 'Correction verified against the customer file; approving as super admin.' } };

describe('customer correction — field coverage', () => {
  it('applies every correctable field, including PAN, on final approve', async () => {
    const a = await superAdmin();
    const cust = await a.post('/api/customers', { full_name: 'Correction Cust', phone: '9846700001' });
    const id = Number(cust.json.id);

    const changes = {
      full_name: 'Corrected Name',
      father_name: 'Corrected Father',
      pan: 'ABCDE1234F',          // the field that used to vanish on approve
      aadhaar_last4: '4321',
      ckyc_number: 'CKYC99881',
      dob: '1985-03-02',
      gender: 'Female',
      occupation: 'Teacher',
      phone: '9846700002',
      phone_secondary: '9846700003',
      email: 'corrected@example.com',
      address: '12 New Street',
      city: 'Kochi',
      district: 'Ernakulam',
      state: 'Kerala',
      pincode: '682001',
      investor_category: 'Individual',
      is_nri: true,
      tds_applicable: false,
    };
    // Everything asked for here must be a field the form can offer.
    for (const k of Object.keys(changes)) expect(CORRECTABLE_CUSTOMER_KEYS).toContain(k);

    const req = await a.post(`/api/customers/${id}/correction-request`, { changes, reason: 'Customer submitted corrected KYC documents.' });
    expect(req.status).toBe(201);

    const approve = await a.post(`/api/approvals/${req.json.request.id}/approve`, SELF_APPROVE);
    expect(approve.status).toBe(200);

    const row = (await ctx.db.query(`SELECT ${CORRECTABLE_CUSTOMER_KEYS.join(', ')} FROM customers WHERE id = $1`, [id])).rows[0] as Record<string, unknown>;
    expect(row.full_name).toBe('Corrected Name');
    expect(row.pan).toBe('ABCDE1234F');
    expect(row.father_name).toBe('Corrected Father');
    expect(row.aadhaar_last4).toBe('4321');
    expect(row.email).toBe('corrected@example.com');
    expect(row.address).toBe('12 New Street');
    expect(row.pincode).toBe('682001');
    expect(String(row.dob).slice(0, 10)).toBe('1985-03-02');
    expect(row.is_nri).toBe(true);
    expect(row.tds_applicable).toBe(false);
  });

  it('lower-cases nothing but upper-cases PAN, and clears a field set to empty', async () => {
    const a = await superAdmin();
    const cust = await a.post('/api/customers', { full_name: 'Blank Cust', phone: '9846700010', email: 'drop@example.com' });
    const id = Number(cust.json.id);

    const req = await a.post(`/api/customers/${id}/correction-request`, {
      changes: { pan: 'abcde9999z', email: '' },
      reason: 'PAN typed in lower case; the e-mail on file belongs to someone else.',
    });
    await a.post(`/api/approvals/${req.json.request.id}/approve`, SELF_APPROVE);

    const row = (await ctx.db.query('SELECT pan, email FROM customers WHERE id = $1', [id])).rows[0] as { pan: string; email: string | null };
    expect(row.pan).toBe('ABCDE9999Z');
    expect(row.email).toBeNull();
  });

  it('refuses a field it cannot apply instead of accepting and dropping it', async () => {
    const a = await superAdmin();
    const cust = await a.post('/api/customers', { full_name: 'Reject Cust', phone: '9846700020' });

    const res = await a.post(`/api/customers/${cust.json.id}/correction-request`, {
      changes: { kyc_status: 'Verified' },   // workflow state, not a correctable profile field
      reason: 'Trying to bypass the KYC workflow through a correction.',
    });
    expect(res.status).toBe(400);
    expect(String(res.json.error?.message ?? res.json.message ?? '')).toMatch(/kyc_status/);
  });
});
