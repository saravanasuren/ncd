/**
 * Senior citizens are out of scope for the ₹30L TDS alert (owner 2026-08-11:
 * "if a person is above 60 years and if their investments are higher than
 * 30lakhs, then tds alert is not applicable for them").
 *
 * 60+ is the SAME line §194A draws for Form 15H vs 15G, which reports/documents
 * already uses — reused rather than restated so the two cannot drift.
 *
 * The asymmetry in the no-DOB case is deliberate and is what most of this file
 * is about: flagging someone who turns out to be exempt is visible on the TDS
 * screen and reversible; NOT flagging someone who is liable loses tax silently
 * and nobody finds out. So an unknown age is treated as NOT senior.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, approveInvestment, type TestCtx, requiredInvestmentFields } from './helpers/server.js';

let ctx: TestCtx;
let seriesId: number, schemeId: number;
const OVER_30L = 3500000;

beforeAll(async () => {
  ctx = await startTestServer();
  seriesId = Number((await ctx.db.query("SELECT id FROM series WHERE code = 'NCD DEMO'")).rows[0]!.id);
  schemeId = Number((await ctx.db.query("SELECT id FROM schemes WHERE code = 'NCD-DEMO'")).rows[0]!.id);
});
afterAll(async () => { await ctx.close(); });

async function as(email: string, password = 'Demo_1234') {
  const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c;
}
const admin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');

/** A No-TDS customer with a live book over ₹30L, born `yearsAgo` years ago. */
async function customerOver30L(code: string, name: string, yearsAgo: number | null): Promise<number> {
  const a = await admin();
  const id = (await a.post('/api/customers', { full_name: name, phone: `90000${code}` })).json.id as number;
  const dob = yearsAgo == null ? null
    : new Date(Date.UTC(new Date().getUTCFullYear() - yearsAgo, 0, 1)).toISOString().slice(0, 10);
  await ctx.db.query('UPDATE customers SET tds_applicable = FALSE, dob = $2 WHERE id = $1', [id, dob]);
  const app = await a.post('/api/applications', {
    ...requiredInvestmentFields(), customer_id: id, series_id: seriesId, scheme_id: schemeId,
    amount: OVER_30L, date_money_received: '2026-07-01',
  });
  await approveInvestment(await as('ncd@demo.local'), app);
  return id;
}

const scan = async () => (await (await admin()).post('/api/tds/scan', {})).json as { customers: { customer_id: number }[] };
const flagged = async (id: number) => (await scan()).customers.some((c) => c.customer_id === id);

describe('₹30L TDS alert — senior citizens are out of scope', () => {
  it('does NOT flag a 74-year-old with a ₹35L book', async () => {
    expect(await flagged(await customerOver30L('11111', 'Senior Seventy Four', 74))).toBe(false);
  });

  it('does NOT flag someone who has just turned 60', async () => {
    // 60 completed years IS a senior citizen under §194A — the boundary belongs
    // inside the exemption, not outside it.
    expect(await flagged(await customerOver30L('22222', 'Exactly Sixty', 60))).toBe(false);
  });

  it('STILL flags a 59-year-old with the same book', async () => {
    // The exemption has to be narrow. If it widened by a year it would quietly
    // stop collecting tax from everyone approaching retirement.
    expect(await flagged(await customerOver30L('33333', 'Fifty Nine', 59))).toBe(true);
  });

  it('STILL flags someone with NO date of birth', async () => {
    // The asymmetry, stated outright: an unknown age is not evidence of being
    // exempt. A wrong flag is visible and reversible; a missed one is not.
    expect(await flagged(await customerOver30L('44444', 'No Dob Person', null))).toBe(true);
  });

  it('leaves a senior BELOW the threshold alone too — for the ordinary reason', async () => {
    // Nothing to do with age: they simply have not crossed ₹30L.
    const a = await admin();
    const id = (await a.post('/api/customers', { full_name: 'Small Senior', phone: '9000055555' })).json.id as number;
    await ctx.db.query(
      "UPDATE customers SET tds_applicable = FALSE, dob = '1950-01-01' WHERE id = $1", [id]);
    const app = await a.post('/api/applications', {
      ...requiredInvestmentFields(), customer_id: id, series_id: seriesId, scheme_id: schemeId,
      amount: 1000000, date_money_received: '2026-07-01',
    });
    await approveInvestment(await as('ncd@demo.local'), app);
    expect(await flagged(id)).toBe(false);
  });
});
