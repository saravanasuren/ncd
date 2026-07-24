/**
 * Customer create validation (shared/validation): names, occupation and
 * city/district/state are letters-and-spaces only (trimmed); PAN must be
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
  it('rejects digits / special characters in the alpha-space fields', async () => {
    const a = await admin();
    const cases: Array<Record<string, string>> = [
      { full_name: 'Cust 123' },
      { full_name: 'Valid Name', father_name: 'Father-1' },
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
