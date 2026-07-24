/**
 * Customer create validation (shared/validation): person names take letters,
 * spaces and real-name punctuation (. ' -) but never digits; occupation and
 * city/district/state are letters-and-spaces only (all trimmed); PAN must be
 * ABCDE1234F (uppercased server-side); dob must be a real ISO date — the
 * wizard's DD/MM/YYYY input converts before sending.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;

beforeAll(async () => { ctx = await startTestServer(); });
afterAll(async () => { await ctx.close(); });

const admin = async () => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email: 'admin@dhanam.finance', password: 'ChangeMe_Dev_123' }); return c; };

describe('POST /api/customers — identity-field validation', () => {
  it('rejects digits / disallowed characters per field', async () => {
    const a = await admin();
    const cases: Array<Record<string, string>> = [
      { full_name: 'Cust 123' },
      { full_name: 'Cust@Home' },
      { full_name: 'Valid Name', father_name: 'Father 1' },
      { full_name: 'Valid Name', occupation: 'IT/Software' },
      { full_name: 'Valid Name', city: 'Chennai 600001' },
      { full_name: 'Valid Name', district: 'Erode!' },
      { full_name: 'Valid Name', state: 'T.N.' },
    ];
    for (const body of cases) {
      const r = await a.post('/api/customers', { phone: '9700000001', ...body });
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.json.error.code).toBe('VALIDATION');
    }
  });

  it('accepts the punctuation real names carry — dots, apostrophes, hyphens', async () => {
    const a = await admin();
    const names = ['K. Pallavi', "Antony D'Souza", 'Mary-Anne Joseph', 'A.R. Rahman'];
    for (let i = 0; i < names.length; i++) {
      const r = await a.post('/api/customers', { full_name: names[i], father_name: names[i], phone: `970001000${i}` });
      expect(r.status, names[i]).toBe(201);
      const detail = await a.get(`/api/customers/${r.json.id}`);
      expect(detail.json.customer.full_name).toBe(names[i]);
    }
  });

  it('rejects a malformed PAN and a bad dob; accepts lowercase PAN by uppercasing', async () => {
    const a = await admin();
    for (const pan of ['ABCDE123F', '1BCDE1234F', 'ABCDE1234FF']) {
      const r = await a.post('/api/customers', { full_name: 'Pan Case Cust', phone: '9700000002', pan });
      expect(r.status, pan).toBe(400);
    }
    const badDob = await a.post('/api/customers', { full_name: 'Dob Case Cust', phone: '9700000003', dob: '2024-02-31' });
    expect(badDob.status).toBe(400);
    // The API takes ISO only — DD/MM/YYYY is the FORM's input format, converted
    // client-side. Raw DD/MM must be a 400, never reach the DB.
    const ddmm = await a.post('/api/customers', { full_name: 'Dob Case Cust', phone: '9700000003', dob: '31/01/1990' });
    expect(ddmm.status).toBe(400);

    const ok = await a.post('/api/customers', { full_name: 'Lower Pan Cust', phone: '9700000004', pan: 'abcpe1234f', dob: '1990-01-31' });
    expect(ok.status).toBe(201);
    const detail = await a.get(`/api/customers/${ok.json.id}`);
    expect(detail.json.customer.pan).toBe('ABCPE1234F');
    expect(String(detail.json.customer.dob).slice(0, 10)).toBe('1990-01-31');
  });

  it('demat: DP ID takes NSDL letter-form or CDSL numeric-form, uppercased; junk is refused', async () => {
    const a = await admin();
    const cust = await a.post('/api/customers', { full_name: 'Demat Cust', phone: '9700000010' });
    const put = (dp_id: string) => a.put(`/api/customers/${cust.json.id}/demat`, { dp_id, client_id: '12345678' });
    expect((await put('IN300456')).status).toBe(200);
    expect((await put('12345678')).status).toBe(200);
    expect((await put('in300456')).status).toBe(200); // lowercase uppercased server-side
    for (const bad of ['IN30045', 'IN30045X', '1N300456', 'ABCDEFGH']) {
      expect((await put(bad)).status, bad).toBe(400);
    }
    const detail = await a.get(`/api/customers/${cust.json.id}`);
    expect(detail.json.customer.demat_dp_id).toBe('IN300456');
  });

  it('bank: digits-only account (leading zeros kept), strict IFSC uppercased, name-rule fields', async () => {
    const a = await admin();
    const cust = await a.post('/api/customers', { full_name: 'Bank Rules Cust', phone: '9700000011' });
    const base = { account_number: '00123456', ifsc: 'sbin0001234' };
    for (const bad of [
      { ...base, account_number: 'AB123456' },
      { ...base, account_number: '12-34 56' },
      { ...base, ifsc: 'SBIN1001234' },   // 5th char must be 0
      { ...base, ifsc: 'SBIN000123' },    // 10 chars
      { ...base, bank_name: 'HDFC Bank 2' },
      { ...base, branch_name: 'Sector 17' },
      { ...base, branch_city: 'Chennai 42' },
      { ...base, holder_name: 'Holder 9' },
    ]) {
      const r = await a.post(`/api/customers/${cust.json.id}/bank-accounts`, bad);
      expect(r.status, JSON.stringify(bad)).toBe(400);
    }
    const ok = await a.post(`/api/customers/${cust.json.id}/bank-accounts`, {
      ...base, bank_name: 'State Bank of India', branch_name: 'R.S. Puram', holder_name: "Mary-Anne D'Souza",
    });
    expect(ok.status).toBe(201);
    const detail = await a.get(`/api/customers/${cust.json.id}`);
    const acct = detail.json.bankAccounts.find((b: { account_number: string }) => b.account_number === '00123456');
    expect(acct, 'leading zeros preserved').toBeTruthy();
    expect(acct.ifsc).toBe('SBIN0001234');
  });

  it('nominee: name follows the shared person-name rule', async () => {
    const a = await admin();
    const cust = await a.post('/api/customers', { full_name: 'Nominee Rules Cust', phone: '9700000012' });
    const bad = await a.put(`/api/customers/${cust.json.id}/nominees`, { nominees: [{ full_name: 'Nominee 1', share_pct: 100 }] });
    expect(bad.status).toBe(400);
    const ok = await a.put(`/api/customers/${cust.json.id}/nominees`, { nominees: [{ full_name: 'K. Nominee-Raj', share_pct: 100 }] });
    expect(ok.status).toBe(200);
  });

  it('trims leading/trailing spaces on the alpha-space fields', async () => {
    const a = await admin();
    const r = await a.post('/api/customers', { full_name: '  Trimmed Cust  ', phone: '9700000005', city: ' Chennai ', occupation: ' Business ' });
    expect(r.status).toBe(201);
    const detail = await a.get(`/api/customers/${r.json.id}`);
    expect(detail.json.customer.full_name).toBe('Trimmed Cust');
    expect(detail.json.customer.city).toBe('Chennai');
    expect(detail.json.customer.occupation).toBe('Business');
  });
});
