/**
 * The Statement of Account, fetched by what an operator can actually type.
 *
 * The Reports page offers a free-text "Customer ID" box, but the only
 * identifier this product ever SHOWS a human is the code — DHN0335 on the
 * customer's page, on their certificate, in every list. So that is what the
 * owner typed, `Number('DHN0335')` came out NaN, Postgres rejected it as a
 * bigint and the browser got a bare `{"error":{"code":"INTERNAL"}}` page with
 * no hint of what was wrong (owner 2026-11-17: "when i try to download SOA for
 * a customer i get an error like this. please fix it").
 *
 * Resolving a code must not become a way AROUND the scope check: the id it
 * resolves to still goes through assertCustomerVisible, which is the last test
 * here and the one that matters most.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
beforeAll(async () => { ctx = await startTestServer(); });
afterAll(async () => { await ctx.close(); });

async function as(email: string, password = 'Demo_1234') {
  const c = new Client(ctx.base);
  await c.post('/api/auth/login', { email, password });
  return c;
}
const admin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');

/** A customer, and the CODE the operator would read off the screen. */
async function customerWithCode(a: Client, full_name: string, phone: string) {
  const c = await a.post('/api/customers', { full_name, phone });
  expect(c.status, JSON.stringify(c.json)).toBe(201);
  const id = Number(c.json.id);
  const code = String((await ctx.db.query(
    'SELECT customer_code FROM customers WHERE id = $1', [id])).rows[0]!.customer_code);
  expect(code).toBeTruthy();
  return { id, code };
}

const isPdf = (r: { status: number; buffer: Buffer }) => {
  expect(r.status).toBe(200);
  expect(r.buffer.subarray(0, 4).toString()).toBe('%PDF');
};

describe('downloading a statement of account', () => {
  it('takes the customer CODE — the identifier actually on screen', async () => {
    const a = await admin();
    const { code } = await customerWithCode(a, 'Soa By Code', '9711100001');
    isPdf(await a.raw(`/api/reports/soa/${code}.pdf`));
  });

  it('still takes the numeric id, so every existing link keeps working', async () => {
    const a = await admin();
    const { id } = await customerWithCode(a, 'Soa By Id', '9711100002');
    isPdf(await a.raw(`/api/reports/soa/${id}.pdf`));
  });

  it('forgives the case and the stray spaces of a typed-in code', async () => {
    const a = await admin();
    const { code } = await customerWithCode(a, 'Soa Sloppy Typing', '9711100003');
    isPdf(await a.raw(`/api/reports/soa/${encodeURIComponent(`  ${code.toLowerCase()} `)}.pdf`));
  });

  it('answers an unknown code with a clean 404, never a 500', async () => {
    const a = await admin();
    const r = await a.raw('/api/reports/soa/DHN9999999.pdf');
    // The whole point: the operator mistyped, which is not a server fault.
    expect(r.status).toBe(404);
    expect(r.status).not.toBe(500);
  });

  it('answers nonsense with a 404 too, rather than reaching the database', async () => {
    const a = await admin();
    expect((await a.raw('/api/reports/soa/not-a-customer.pdf')).status).toBe(404);
  });

  it('a CODE cannot reach a customer the operator may not see', async () => {
    const a = await admin();
    // Enrolled by admin, so outside a branch_staff's own scope.
    const { id, code } = await customerWithCode(a, 'Soa Out Of Scope', '9711100004');
    const staff = await as('staff@demo.local');
    // Both doors are shut, and shut the same way — resolution is not access.
    expect((await staff.raw(`/api/reports/soa/${id}.pdf`)).status).toBe(404);
    expect((await staff.raw(`/api/reports/soa/${code}.pdf`)).status).toBe(404);
  });
});
