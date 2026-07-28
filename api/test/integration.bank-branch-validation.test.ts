/**
 * Bank/branch/city are IFSC-DIRECTORY data, not person names.
 *
 * They were validated with the person-name rule, which forbids commas and
 * digits — so adding a bank account whose branch the directory returns as
 * "SURAMANGALAM, SALEM" (Canara CNRB0001219, a real customer's account) was
 * refused with a bare "Invalid request". 28 of the 322 IFSCs already in the
 * production book fail exactly this way. Beneficiary name stays strict: that
 * one IS a person's name.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
beforeAll(async () => { ctx = await startTestServer(); });
afterAll(async () => { await ctx.close(); });

const admin = async () => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email: 'admin@dhanam.finance', password: 'ChangeMe_Dev_123' }); return c; };

async function newCustomer(a: Client, name: string, phone: string) {
  const r = await a.post('/api/customers', { full_name: name, phone });
  expect(r.status).toBe(201);
  return Number(r.json.id);
}

describe('bank account accepts real IFSC-directory branch names', () => {
  it('a branch name with a comma is accepted (the reported failure)', async () => {
    const a = await admin();
    const id = await newCustomer(a, 'Comma Branch Cust', '9760000001');
    const r = await a.post(`/api/customers/${id}/bank-accounts`, {
      holder_name: 'Indirajayanthi R',
      account_number: '1219101029694',
      ifsc: 'CNRB0001219',
      bank_name: 'Canara Bank',
      branch_name: 'SURAMANGALAM, SALEM',
      branch_city: 'SALEM',
    });
    expect(r.status).toBe(201);
    const saved = (await ctx.db.query(
      'SELECT branch_name FROM customer_bank_accounts WHERE id = $1', [r.json.id])).rows[0] as any;
    expect(saved.branch_name).toBe('SURAMANGALAM, SALEM');
  });

  it('other real directory shapes — digits, dots, slashes, ampersands — are accepted', async () => {
    const a = await admin();
    const branches = ['A.P.T ROAD, ERODE', 'COIMBATORE,M BRANCH', 'SECTOR 62', 'R.S. PURAM (WEST)', 'MG ROAD/ANNA NAGAR'];
    const words = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo']; // person names take no digits
    for (const [i, branch] of branches.entries()) {
      const id = await newCustomer(a, `Branch Shape ${words[i]}`, `976000101${i}`);
      const r = await a.post(`/api/customers/${id}/bank-accounts`, {
        account_number: `55500011${i}`, ifsc: 'ICIC0001111',
        bank_name: 'ICICI Bank', branch_name: branch, branch_city: 'CHENNAI',
      });
      expect(r.status, `branch ${branch}`).toBe(201);
    }
  });

  it('the beneficiary NAME stays strict — a digit in a person name is still refused', async () => {
    const a = await admin();
    const id = await newCustomer(a, 'Strict Holder Cust', '9760000002');
    const r = await a.post(`/api/customers/${id}/bank-accounts`, {
      holder_name: 'Rathika 12345',            // a PAN/phone pasted into the name field
      account_number: '5550002222', ifsc: 'ICIC0001111',
    });
    expect(r.status).toBe(400);
  });

  it('branch fields still refuse markup / control characters', async () => {
    const a = await admin();
    const id = await newCustomer(a, 'Unsafe Branch Cust', '9760000003');
    for (const branch of ['<script>alert(1)</script>', '"quoted"', ', leading comma']) {
      const r = await a.post(`/api/customers/${id}/bank-accounts`, {
        account_number: '5550003333', ifsc: 'ICIC0001111', branch_name: branch,
      });
      expect(r.status, `branch ${branch}`).toBe(400);
    }
  });
});
