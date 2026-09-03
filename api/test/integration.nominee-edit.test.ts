/**
 * Editing a nominee (owner 2026-09-03: "im not able to edit nominee details").
 *
 * The endpoint could always do it — it replaces the whole set — but the customer
 * page rendered nominees as plain text with a single "+ Add" button, so there
 * was no way to correct a name, set a relationship, or take a nominee off. Two
 * nominees added on the morning of 2026-09-03 landed with a NULL relationship
 * for exactly that reason: the add flow never asked for one.
 *
 * These pin the two things the new editor leans on:
 *
 *  1. a resent nominee keeps the fields the profile page never shows — DOB, PAN,
 *     phone, address, guardian, KYC id. "Replace the set" means anything the
 *     caller omits is DELETED, and the old flow omitted all of them.
 *  2. a checker reviewing the change can see the nominees. The approval card
 *     used to fall through to the generic customer branch and show only name,
 *     phone and PAN — nothing about who was being made nominee.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { nomineeToInput } from '@new-wealth/shared';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
const as = async (email: string, password = 'Demo_1234') => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c; };
const admin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');
/** A DISTINCT checker — a maker cannot approve their own request. */
const checker = () => as('ncd@demo.local');

beforeAll(async () => { ctx = await startTestServer(); });
afterAll(async () => { await ctx.close(); });

const newCustomer = async (a: Client, name: string, phone: string) =>
  Number((await a.post('/api/customers', { full_name: name, phone })).json.id);
const nomineesOf = async (id: number) =>
  (await ctx.db.query<Record<string, unknown>>(
    'SELECT * FROM nominees WHERE customer_id = $1 ORDER BY id', [id])).rows;

/** The full nominee the enrolment wizard records. */
const FULL = {
  full_name: 'Meena Rajan', relationship: 'Spouse', share_pct: 100,
  dob: '1979-03-14', pan: 'AAAPM1234Q', phone: '9445001122',
  address: '14 Bharathi Street, Erode', guardian_name: 'Rajan K', guardian_pan: 'BBBPR5678L',
  kyc_id_type: 'Aadhaar', kyc_id_number: '123456789012',
};

describe('nomineeToInput keeps every field the editor does not show', () => {
  it('carries all eleven columns back out', () => {
    const out = nomineeToInput({ id: 7, customer_id: 3, ...FULL });
    expect(out).toEqual(FULL);
  });

  it('omits the share rather than sending 0, so blank still means "the rest"', () => {
    const out = nomineeToInput({ full_name: 'No Share', share_pct: 0 });
    expect('share_pct' in out).toBe(false);
  });

  it('turns blanks into null instead of empty strings', () => {
    const out = nomineeToInput({ full_name: '  Padded Name  ', relationship: '', pan: '   ' });
    expect(out.full_name).toBe('Padded Name');
    expect(out.relationship).toBeNull();
    expect(out.pan).toBeNull();
  });

  it('never lets a timestamp reach a DATE column as one', () => {
    expect(nomineeToInput({ full_name: 'X', dob: '1979-03-14T00:00:00.000Z' }).dob).toBe('1979-03-14');
  });
});

describe('editing a nominee through the endpoint', () => {
  it('adding a second nominee does not strip the first one bare', async () => {
    const a = await admin();
    const id = await newCustomer(a, 'Nominee Edit Cust', '9531000001');
    // First capture applies straight away.
    expect((await a.put(`/api/customers/${id}/nominees`, { nominees: [FULL] })).status).toBe(200);
    const [first] = await nomineesOf(id);
    expect(first!.pan).toBe('AAAPM1234Q');
    expect(first!.kyc_id_number).toBe('123456789012');

    // What the page now sends when a second name is added: the stored row
    // resent WHOLE. The old flow sent {full_name, relationship, share_pct} only.
    const resent = nomineeToInput(first!);
    const r = await a.put(`/api/customers/${id}/nominees`, {
      nominees: [{ ...resent, share_pct: 60 }, { full_name: 'Arun Rajan', relationship: 'Son', share_pct: 40 }],
    });
    expect(r.status).toBe(200);
    // A customer who already has a nominee: the change waits for a checker.
    expect(r.json.applied).toBe(false);

    // Until then nothing moved — and, crucially, nothing was lost.
    const still = await nomineesOf(id);
    expect(still).toHaveLength(1);
    expect(still[0]!.pan).toBe('AAAPM1234Q');
    expect(still[0]!.dob).toBe('1979-03-14');
    expect(still[0]!.guardian_name).toBe('Rajan K');
  });

  it('a rename applies with the hidden fields intact once approved', async () => {
    const a = await admin();
    const id = await newCustomer(a, 'Nominee Rename Cust', '9531000002');
    await a.put(`/api/customers/${id}/nominees`, { nominees: [FULL] });
    const [stored] = await nomineesOf(id);

    const r = await a.put(`/api/customers/${id}/nominees`, {
      nominees: [{ ...nomineeToInput(stored!), full_name: 'Meena R Rajan', relationship: 'Mother' }],
      reason: 'Nominee updated: Meena R Rajan',
    });
    expect(r.json.applied).toBe(false);
    const reqId = Number(r.json.approval_request.id);
    expect((await (await checker()).post(`/api/approvals/${reqId}/approve`, { note: 'ok' })).status).toBe(200);

    const [after] = await nomineesOf(id);
    expect(after!.full_name).toBe('Meena R Rajan');
    expect(after!.relationship).toBe('Mother');
    expect(Number(after!.share_pct)).toBe(100);
    // The point of the whole exercise.
    expect(after!.pan).toBe('AAAPM1234Q');
    expect(after!.phone).toBe('9445001122');
    expect(after!.address).toBe('14 Bharathi Street, Erode');
    expect(after!.kyc_id_number).toBe('123456789012');
  });

  it('removing a nominee is a set with that row left out', async () => {
    const a = await admin();
    const id = await newCustomer(a, 'Nominee Remove Cust', '9531000003');
    await a.put(`/api/customers/${id}/nominees`, {
      nominees: [{ full_name: 'Keep Me', share_pct: 50 }, { full_name: 'Drop Me', share_pct: 50 }],
    });
    expect(await nomineesOf(id)).toHaveLength(2);

    const rows = (await nomineesOf(id)).map(nomineeToInput);
    const r = await a.put(`/api/customers/${id}/nominees`, {
      nominees: rows.filter((n) => n.full_name !== 'Drop Me'), reason: 'Nominee removed: Drop Me',
    });
    await (await checker()).post(`/api/approvals/${Number(r.json.approval_request.id)}/approve`, { note: 'ok' });

    const left = await nomineesOf(id);
    expect(left).toHaveLength(1);
    expect(left[0]!.full_name).toBe('Keep Me');
  });

  it('the last nominee can be taken off entirely', async () => {
    const a = await admin();
    const id = await newCustomer(a, 'Nominee Clear Cust', '9531000004');
    await a.put(`/api/customers/${id}/nominees`, { nominees: [{ full_name: 'Only One' }] });
    const r = await a.put(`/api/customers/${id}/nominees`, { nominees: [], reason: 'Nominee removed: Only One' });
    await (await checker()).post(`/api/approvals/${Number(r.json.approval_request.id)}/approve`, { note: 'ok' });
    expect(await nomineesOf(id)).toHaveLength(0);
  });
});

describe('the checker can see what they are approving', () => {
  it('the approval card names the nominees, now and proposed', async () => {
    const a = await admin();
    const id = await newCustomer(a, 'Nominee Card Cust', '9531000005');
    await a.put(`/api/customers/${id}/nominees`, { nominees: [{ full_name: 'Old Nominee', relationship: 'Sister' }] });
    const r = await a.put(`/api/customers/${id}/nominees`, {
      nominees: [{ full_name: 'New Nominee', relationship: 'Spouse' }], reason: 'Nominee updated: New Nominee',
    });
    const reqId = Number(r.json.approval_request.id);

    const card = (await a.get(`/api/approvals/${reqId}`)).json;
    const facts = JSON.stringify(card);
    // Before this, a nominee card showed the customer's own name, phone and PAN
    // and not one word about the nominee.
    expect(facts).toContain('Old Nominee');
    expect(facts).toContain('New Nominee');
    expect(facts).toContain('Spouse');
  });
});
