/**
 * Tell staff the nominee is incomplete at the START of a locker enrolment, not
 * at the end (owner 2026-09-09, after a live enrolment was stopped at the
 * agreement step by LockerHub's `nominee_incomplete`).
 *
 * The failure this moves: LockerHub validates the nominee only when the
 * AGREEMENT is generated — several steps after their application has been
 * created — so a missing date of birth surfaced only once the work was done.
 *
 * It TELLS, it does not block (owner: "say them to go fill the nominee name and
 * continue with the enrollment"). Enrolment and allotment genuinely work
 * without a nominee, and the paper agreement never calls their generator — so
 * this reports readiness and the screen acts on it.
 *
 * Measured on production when this was written: of 505 nominees, 437 had no
 * phone, 324 no date of birth, 290 no relationship. Of the locker customers we
 * had linked, 4 of 11 would have passed. This is the common case.
 *
 * NOT asserted as missing: nominee_flat_building / nominee_road_name, which
 * LockerHub also demands. ApplicantBlock.nominee carries no address at all, so
 * no data entry in NCD can satisfy them — that half is a contract change, and
 * listing it here would send staff to a screen that fixes nothing.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
beforeAll(async () => { ctx = await startTestServer(); });
afterAll(async () => { await ctx.close(); });

const as = async (email: string, password = 'Demo_1234') => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c; };
const admin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');

const readiness = async (c: Client, id: number) =>
  (await c.get(`/api/lockers/customers/${id}/nominee-readiness`)).json as
    { has_nominee: boolean; missing: string[]; ready: boolean; needs_approval_to_fix: boolean };

async function customer(a: Client, name: string, phone: string): Promise<number> {
  return Number((await a.post('/api/customers', { full_name: name, phone })).json.id);
}
/** A nominee written straight in, so each field can be withheld independently. */
async function nominee(customerId: number, cols: Record<string, unknown>) {
  const keys = Object.keys(cols);
  await ctx.db.query(
    `INSERT INTO nominees (customer_id, ${keys.join(', ')})
     VALUES ($1, ${keys.map((_, i) => `$${i + 2}`).join(', ')})`,
    [customerId, ...keys.map((k) => cols[k])]);
}

describe('the enrolment screen can ask whether the nominee will pass', () => {
  it('a customer with NO nominee is not ready, and nothing needs approving', async () => {
    const a = await admin();
    const id = await customer(a, 'No Nominee At All', '9560000001');
    const r = await readiness(a, id);
    expect(r.has_nominee).toBe(false);
    expect(r.ready).toBe(false);
    expect(r.missing).toContain('Nominee name');
    expect(r.missing).toContain('Date of birth');
    // The FIRST nominee saves outright, so telling staff to expect a checker
    // here would be wrong (owner 2026-08-19).
    expect(r.needs_approval_to_fix).toBe(false);
  });

  it('names exactly what is missing — the production shape: name only', async () => {
    const a = await admin();
    const id = await customer(a, 'Name Only Nominee', '9560000002');
    await nominee(id, { full_name: 'Partial Person' });
    const r = await readiness(a, id);
    expect(r.ready).toBe(false);
    expect(r.missing).not.toContain('Nominee name');
    expect(r.missing).toEqual(expect.arrayContaining(['Relationship', 'Date of birth', 'Phone']));
    // A nominee exists, so correcting it goes through the approvals queue.
    expect(r.needs_approval_to_fix).toBe(true);
  });

  it('a complete nominee is ready', async () => {
    const a = await admin();
    const id = await customer(a, 'Complete Nominee', '9560000003');
    await nominee(id, { full_name: 'Whole Person', relationship: 'Spouse', dob: '1980-04-01', phone: '9876500001' });
    const r = await readiness(a, id);
    expect(r.ready).toBe(true);
    expect(r.missing).toEqual([]);
  });

  it('blank strings do not count as filled', async () => {
    // The production failure mode: the column exists and is whitespace, not
    // NULL, so a naive `IS NOT NULL` would call it complete and the enrolment
    // would fail at LockerHub exactly as before.
    const a = await admin();
    const id = await customer(a, 'Whitespace Nominee', '9560000004');
    await nominee(id, { full_name: 'Blank Fields', relationship: '   ', dob: '1980-04-01', phone: '' });
    const r = await readiness(a, id);
    expect(r.ready).toBe(false);
    expect(r.missing).toEqual(expect.arrayContaining(['Relationship', 'Phone']));
  });

  it('judges the SAME nominee the applicant block would send', async () => {
    // buildApplicantBlock sends the highest-share nominee. If this read a
    // different one, the check could pass while the payload carried the
    // incomplete one — the bug would survive its own fix.
    const a = await admin();
    const id = await customer(a, 'Two Nominees', '9560000005');
    await nominee(id, { full_name: 'Minor Share', relationship: 'Son', dob: '2001-01-01', phone: '9876500002', share_pct: 10 });
    await nominee(id, { full_name: 'Major Share', share_pct: 90 });   // incomplete, and the one sent

    const r = await readiness(a, id);
    expect(r.ready).toBe(false);

    const { buildApplicantBlock } = await import('../src/modules/lockers/applicant.js');
    const block = await buildApplicantBlock(ctx.db, id);
    expect(block?.nominee?.name).toBe('Major Share');
    expect(block?.nominee?.relation).toBe('');
  });
});

describe('one customer\'s nominee is not another\'s to read', () => {
  it('refuses a customer the caller cannot see', async () => {
    const a = await admin();
    const id = await customer(a, 'Visibility Probe', '9560000006');
    // The route asserts customer visibility like every other customer-scoped
    // locker read; an id that does not exist must not 200 with a blank answer.
    expect((await a.get('/api/lockers/customers/99999999/nominee-readiness')).status).toBeGreaterThanOrEqual(400);
    expect((await a.get(`/api/lockers/customers/${id}/nominee-readiness`)).status).toBe(200);
  });
});
