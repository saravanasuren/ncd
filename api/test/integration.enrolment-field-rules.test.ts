/**
 * Enrolment stopped dead on "Invalid request" (owner 2026-08-24 — three 400s in
 * a row, no clue which field).
 *
 * Two causes, both fixed:
 *  1. occupation / city / district / state allowed no `&`, `,` or `/`, so
 *     ordinary answers like "Agriculture & Allied" were rejected;
 *  2. the API's field-level reason lives in `detail`, and the wizard showed only
 *     `message` — which is the generic "Invalid request".
 *
 * These tests cover (1) end to end and pin that (2) has something to show.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
beforeAll(async () => { ctx = await startTestServer(); });
afterAll(async () => { await ctx.close(); });

const admin = async () => {
  const c = new Client(ctx.base);
  await c.post('/api/auth/login', { email: 'admin@dhanam.finance', password: 'ChangeMe_Dev_123' });
  return c;
};
let n = 0;
const create = async (extra: Record<string, unknown>) => {
  const a = await admin();
  return a.post('/api/customers', {
    full_name: 'Field Rule Cust', phone: `94000${String(10000 + (n += 1)).slice(-5)}`, ...extra,
  });
};

describe('enrolment accepts the answers people actually type', () => {
  it.each([
    ['Agriculture & Allied'],   // the ampersand that used to 400
    ['Business/Trade'],
    ['Self-Employed'],
    ['Retired (Govt.)'],
  ])('occupation %s is accepted', async (occupation) => {
    const r = await create({ occupation });
    expect(r.status).toBe(201);
  });

  it.each([
    ['city', 'Salem, Tamil Nadu'],
    ['district', 'Salem Dt.'],
    ['state', 'Jammu & Kashmir'],
  ])('%s "%s" is accepted', async (field, value) => {
    const r = await create({ [field]: value });
    expect(r.status).toBe(201);
  });

  it('still refuses digits — the rule that catches garbage stays', async () => {
    const r = await create({ occupation: '5 Star Hotel' });
    expect(r.status).toBe(400);
  });

  it('still refuses a value that does not start with a letter', async () => {
    const r = await create({ city: '-Salem' });
    expect(r.status).toBe(400);
  });

  it('a rejection carries a FIELD-LEVEL reason, not just "Invalid request"', async () => {
    // This is what the wizard now shows. Without something in `detail` the
    // operator is back to guessing which of five fields is wrong.
    const r = await create({ occupation: '5 Star Hotel' });
    expect(r.status).toBe(400);
    // The API sends zod's flatten() — { formErrors, fieldErrors } — so the
    // reason is keyed by field name. The wizard reads exactly this shape.
    const fieldErrors = (r.json?.error?.detail as any)?.fieldErrors;
    expect(fieldErrors?.occupation?.length).toBeTruthy();
    expect(String(fieldErrors.occupation[0])).toMatch(/letters/i);
  });
});
