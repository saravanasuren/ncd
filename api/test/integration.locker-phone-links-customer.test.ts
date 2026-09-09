/**
 * Enrolling by PHONE must link the NCD customer, exactly as enrolling by PAN
 * does (owner 2026-09-09: "fix that too fast").
 *
 * The gap it closes, and why it was invisible: `customer_id` on locker-application
 * create is what makes the server attach the applicant block — nominee, address,
 * KYC, bank. The PAN lookup resolved an NCD customer and so sent it. The phone
 * lookup asked LockerHub ONLY and resolved nothing, so `customer_id` was
 * omitted and LockerHub received a bare name and phone.
 *
 * Nothing failed. The enrolment completed, the locker was allotted, and the
 * tenancy was simply empty on their side — which then surfaced, much later, as
 * `nominee_incomplete` at agreement time on data we had all along.
 *
 * Measured on production: 43 of 56 locker applications were created with no
 * customer linked, and 42 of those 43 match an NCD customer on the phone we
 * already held.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
beforeAll(async () => { ctx = await startTestServer(); });
afterAll(async () => { await ctx.close(); });

const as = async (email: string, password = 'Demo_1234') => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c; };
const admin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');

const byPhone = async (c: Client, phone: string) => (await c.get(`/api/lockers/customers/${phone}`)).json as Record<string, unknown>;

describe('the phone lookup links the NCD customer', () => {
  let custId = 0;

  it('returns the NCD customer on that number', async () => {
    const a = await admin();
    custId = Number((await a.post('/api/customers', { full_name: 'Phone Link Cust', phone: '9563000001' })).json.id);

    const r = await byPhone(a, '9563000001');
    const ncd = r.ncd_customer as Record<string, unknown> | null;
    expect(ncd).toBeTruthy();
    expect(Number(ncd!.id)).toBe(custId);
    expect(ncd!.full_name).toBe('Phone Link Cust');
    // A NUMBER, because the page sends it straight back as customer_id.
    expect(typeof ncd!.id).toBe('number');
  });

  it('matches on the last ten digits, however the number was stored', async () => {
    // Real numbers carry +91, spaces and dashes. Matching the raw column would
    // have found nothing for exactly the customers this exists to link.
    const a = await admin();
    const id = Number((await a.post('/api/customers', { full_name: 'Formatted Phone', phone: '+91 95630-00002' })).json.id);
    const ncd = (await byPhone(a, '9563000002')).ncd_customer as Record<string, unknown> | null;
    expect(ncd).toBeTruthy();
    expect(Number(ncd!.id)).toBe(id);
  });

  it('is null when nobody matches — the enrolment still proceeds without a block', async () => {
    const a = await admin();
    expect((await byPhone(a, '9563999999')).ncd_customer).toBeNull();
  });

  it('still returns LockerHub\'s own answer alongside it', async () => {
    // The field is ADDITIVE. The page reads `found` / `profile` from this same
    // object, so shadowing them would break the customer step.
    const a = await admin();
    const r = await byPhone(a, '9563000001');
    expect('found' in r).toBe(true);
    expect('ncd_customer' in r).toBe(true);
  });
});

describe('it does not hand out a customer the caller cannot see', () => {
  it('branch staff get null rather than an id that would 404 on create', async () => {
    // Scoped deliberately, unlike the by-PAN lookup: an invisible id would be
    // sent on create and rejected there, which reads as "the enrolment broke"
    // rather than "not your customer". Null degrades to the old behaviour.
    const a = await admin();
    await a.post('/api/customers', { full_name: 'Not Staff Customer', phone: '9563000003' });

    const staff = await as('staff@demo.local');
    const r = await byPhone(staff, '9563000003');
    expect(r.ncd_customer).toBeNull();
    // ...and an admin still sees them, so the null above is scope, not a miss.
    expect((await byPhone(a, '9563000003')).ncd_customer).toBeTruthy();
  });
});
