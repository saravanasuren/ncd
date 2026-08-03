/**
 * An agent's payout account needs a branch and a beneficiary name.
 *
 * `agents` carried bank_name / account_number / ifsc only. The Agents screen had
 * nowhere to put the branch the IFSC names, and no way to record who the account
 * is actually in the name of — an agent paid through a family member's or a
 * firm's account had that fact live nowhere, and a transfer goes out against a
 * beneficiary name.
 *
 * The IFSC → bank/branch autofill on the screen calls the same
 * `/api/lookups/ifsc/:code` the customer bank form uses, so it is covered here
 * only as far as the contract the screen depends on: an unknown code answers
 * `{found:false}` rather than erroring, which is what lets the operator fall
 * back to typing the bank in by hand.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
beforeAll(async () => { ctx = await startTestServer(); });
afterAll(async () => { await ctx.close(); });

const as = async (email: string, password = 'Demo_1234') => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c; };
const admin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');

let n = 0;
const row = async (id: number) => {
  const r = await (await admin()).get('/api/agents');
  return (r.json.rows as any[]).find((a) => a.id === id);
};

describe('the payout account round-trips', () => {
  it('stores the branch and the beneficiary on create', async () => {
    const a = await admin();
    const r = await a.post('/api/agents', {
      full_name: `Bank Detail Agent ${++n}`,
      bank_name: 'State Bank of India', branch_name: 'R.S. Puram',
      account_number: '36438774131', ifsc: 'SBIN0000571',
      account_holder_name: 'Narayanan R',
    });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect(await row(Number(r.json.id))).toMatchObject({
      bank_name: 'State Bank of India', branch_name: 'R.S. Puram',
      account_number: '36438774131', ifsc: 'SBIN0000571',
      account_holder_name: 'Narayanan R',
    });
  });

  it('an agent added without bank details still works — every field is optional', async () => {
    const a = await admin();
    const r = await a.post('/api/agents', { full_name: `No Bank Agent ${++n}` });
    expect(r.status).toBe(201);
    const got = await row(Number(r.json.id));
    expect(got.branch_name).toBeNull();
    expect(got.account_holder_name).toBeNull();
  });

  it('editing fills in a branch and beneficiary that were never captured before', async () => {
    const a = await admin();
    // Exactly the shape of every agent on the live book before this: bank and
    // account, no branch, no beneficiary.
    const created = await a.post('/api/agents', {
      full_name: `Legacy Agent ${++n}`, bank_name: 'sbi', account_number: '36438774131',
    });
    const id = Number(created.json.id);
    const up = await a.put(`/api/agents/${id}`, {
      bank_name: 'State Bank of India', branch_name: 'Gandhipuram',
      ifsc: 'SBIN0000571', account_holder_name: 'A Different Person',
    });
    expect(up.status).toBe(200);
    expect(await row(id)).toMatchObject({
      bank_name: 'State Bank of India', branch_name: 'Gandhipuram',
      account_holder_name: 'A Different Person', account_number: '36438774131',
    });
  });

  it('clearing a beneficiary sends null and it clears — not "null" the string', async () => {
    const a = await admin();
    const created = await a.post('/api/agents', {
      full_name: `Clearable Agent ${++n}`, account_holder_name: 'Typed By Mistake', branch_name: 'Somewhere',
    });
    const id = Number(created.json.id);
    await a.put(`/api/agents/${id}`, { account_holder_name: null, branch_name: null });
    const got = await row(id);
    expect(got.account_holder_name).toBeNull();
    expect(got.branch_name).toBeNull();
  });

  it('an agent cannot edit the agent book', async () => {
    const a = await admin();
    const created = await a.post('/api/agents', { full_name: `Protected Agent ${++n}` });
    const r = await (await as('agent@demo.local')).put(`/api/agents/${Number(created.json.id)}`, { branch_name: 'Anywhere' });
    expect(r.status).toBe(403);
  });
});

describe('the IFSC lookup the screen autofills from', () => {
  it('answers found:false for an unknown code instead of failing', async () => {
    const r = await (await admin()).get('/api/lookups/ifsc/ZZZZ0999999');
    expect(r.status).toBe(200);
    expect(r.json.found).toBe(false);   // the screen falls back to manual entry
  });
});
