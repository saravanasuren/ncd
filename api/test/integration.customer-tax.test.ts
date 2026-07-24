/**
 * A customer's tax position (owner report 2026-07-24: "where do I see whether
 * TDS applies?"). It drives computeTds on every payout but was settable ONLY at
 * enrolment — the correction whitelist is name/phone/email/address only — so a
 * customer who later filed a 15G/15H kept having TDS deducted with no way to
 * record the form.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
const as = async (email: string, password = 'Demo_1234') => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c; };
const admin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');

beforeAll(async () => { ctx = await startTestServer(); });
afterAll(async () => { await ctx.close(); });

async function customer(phone: string) {
  const c = await (await admin()).post('/api/customers', { full_name: 'Tax ' + phone, phone });
  return Number(c.json.id);
}

describe('customer tax position', () => {
  it('is visible on the customer record, defaulting to TDS applicable', async () => {
    const cid = await customer('9944000001');
    const d = await (await admin()).get(`/api/customers/${cid}`);
    expect(d.json.customer.tds_applicable).toBe(true);   // DB default
    expect(d.json.customer.tax_form).toBeNull();
  });

  it('recording a 15G stops TDS, and is audited with before/after', async () => {
    const cid = await customer('9944000002');
    const a = await admin();
    const r = await a.patch(`/api/customers/${cid}/tax`, {
      tds_applicable: false, tax_form: '15G', tax_form_expires_on: '2027-03-31',
    });
    expect(r.status).toBe(200);
    const d = await a.get(`/api/customers/${cid}`);
    expect(d.json.customer.tds_applicable).toBe(false);
    expect(d.json.customer.tax_form).toBe('15G');

    const log = (await ctx.db.query(
      "SELECT before_data, after_data FROM audit_log WHERE action='customer.tax-status' AND entity_id=$1", [String(cid)])).rows[0] as any;
    expect(log.before_data.tds_applicable).toBe(true);
    expect(log.after_data.tax_form).toBe('15G');
  });

  it('a form without its validity date is refused — it would be silently ignored', async () => {
    const cid = await customer('9944000003');
    const a = await admin();
    const r = await a.patch(`/api/customers/${cid}/tax`, { tds_applicable: false, tax_form: '15H' });
    expect(r.status).toBe(400);
    expect(r.json.error.message).toMatch(/validity date/i);
    // …and nothing was written.
    expect((await a.get(`/api/customers/${cid}`)).json.customer.tax_form).toBeNull();
  });

  it('an unknown form is refused, and turning TDS back on clears the form', async () => {
    const cid = await customer('9944000004');
    const a = await admin();
    expect((await a.patch(`/api/customers/${cid}/tax`, { tds_applicable: false, tax_form: '16A', tax_form_expires_on: '2027-03-31' })).status).toBe(400);

    await a.patch(`/api/customers/${cid}/tax`, { tds_applicable: false, tax_form: '15G', tax_form_expires_on: '2027-03-31' });
    await a.patch(`/api/customers/${cid}/tax`, { tds_applicable: true, tax_form: null, tax_form_expires_on: null });
    const d = await a.get(`/api/customers/${cid}`);
    expect(d.json.customer.tds_applicable).toBe(true);
    expect(d.json.customer.tax_form).toBeNull();          // no stale form left behind
    expect(d.json.customer.tax_form_expires_on).toBeNull();
  });
});
