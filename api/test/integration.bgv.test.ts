/**
 * Background Verification screen — computed status, inline fixer, verify gate.
 * Covers the three-state rule (the point of the screen), the two doc
 * vocabularies NCD holds (wealth-import `PAN` vs wizard `pan_card`), the
 * patch whitelist, and that verification is gated on all five KYC documents.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
let custId: number;

beforeAll(async () => {
  ctx = await startTestServer();
  const a = await as('admin@dhanam.finance', 'ChangeMe_Dev_123');
  const c = await a.post('/api/customers', { full_name: 'BGV Subject', phone: '9880000001' });
  custId = c.json.id;
  // Half-done on purpose: legacy last-4 Aadhaar only, nominee with just a name.
  await ctx.db.query("UPDATE customers SET pan = NULL, aadhaar = NULL, aadhaar_last4 = '9012', depository = NULL WHERE id = $1", [custId]);
  await a.put(`/api/customers/${custId}/nominees`, { nominees: [{ full_name: 'Partial Nominee' }] });
});
afterAll(async () => { await ctx.close(); });

async function as(email: string, password = 'Demo_1234') {
  const c = new Client(ctx.base); await c.post('/api/auth/login', { email, password }); return c;
}
const admin = () => as('admin@dhanam.finance', 'ChangeMe_Dev_123');
const rowFor = async (id: number) => {
  const r = await (await admin()).get('/api/background-verification');
  return (r.json.rows as any[]).find((x) => x.id === id);
};
const check = (row: any, key: string) => row.data_checks.find((k: any) => k.key === key);

describe('BGV — computed three-state status', () => {
  it('Aadhaar with only the legacy last-4 is ORANGE (partial), not missing', async () => {
    const c = check(await rowFor(custId), 'aadhaar');
    expect(c.present).toBe(true);
    expect(c.valid).toBe(false);
    expect(c.partial).toBe(true);
    expect(String(c.value)).not.toMatch(/^\d{12}$/); // masked, never echoed in full
  });

  it('a nominee with no relationship/DOB is ORANGE; missing PAN is RED', async () => {
    const row = await rowFor(custId);
    const nom = check(row, 'nominee');
    expect(nom.present).toBe(true);
    expect(nom.partial).toBe(true);
    expect(nom.valid).toBe(false);

    const pan = check(row, 'pan');
    expect(pan.present).toBe(false);
    expect(pan.valid).toBe(false);
  });

  it('email/address/PIN are surfaced but flagged optional (non-blocking in NCD)', async () => {
    const row = await rowFor(custId);
    for (const k of ['email', 'address', 'pincode']) expect(check(row, k).optional).toBe(true);
    expect(check(row, 'pan').optional).toBeFalsy();
  });

  it('counters summarise the book', async () => {
    const r = await (await admin()).get('/api/background-verification');
    expect(r.status).toBe(200);
    for (const k of ['customers', 'kyc_verified', 'kyc_pending', 'data_complete', 'needs_attention']) {
      expect(r.json.counters).toHaveProperty(k);
    }
    expect(r.json.counters.needs_attention).toBeGreaterThanOrEqual(1);
  });
});

describe('BGV — both document vocabularies count as present', () => {
  it('wealth-import `PAN` and wizard `aadhaar_card` both map to canonical types', async () => {
    await ctx.db.query(
      "INSERT INTO customer_documents (customer_id, doc_type, file_path, original_filename, mime, origin) VALUES ($1,'PAN','/x/p.pdf','p.pdf','application/pdf','wealth-import'), ($1,'aadhaar_card','/x/a.pdf','a.pdf','application/pdf','staff')",
      [custId]);
    const row = await rowFor(custId);
    expect(row.docs.PAN).toBeTruthy();
    expect(row.docs.Aadhaar).toBeTruthy();
    expect(row.docs.Photo).toBeFalsy();
  });
});

describe('BGV — inline fixer', () => {
  it('validates + uppercases PAN, and rejects a bad one', async () => {
    const a = await admin();
    expect((await a.patch(`/api/background-verification/${custId}/fix-field`, { field: 'pan', value: 'notapan' })).status).toBe(400);
    const ok = await a.patch(`/api/background-verification/${custId}/fix-field`, { field: 'pan', value: 'abcde1234f' });
    expect(ok.status).toBe(200);
    expect(check(await rowFor(custId), 'pan').valid).toBe(true);
  });

  it('a full Aadhaar mirrors its last 4 into the legacy column', async () => {
    const a = await admin();
    expect((await a.patch(`/api/background-verification/${custId}/fix-field`, { field: 'aadhaar', value: '123456789012' })).status).toBe(200);
    const c = (await ctx.db.query('SELECT aadhaar, aadhaar_last4 FROM customers WHERE id = $1', [custId])).rows[0] as any;
    expect(c.aadhaar).toBe('123456789012');
    expect(c.aadhaar_last4).toBe('9012');
    expect(check(await rowFor(custId), 'aadhaar').valid).toBe(true);
  });

  it('refuses a field that is not on the whitelist', async () => {
    const a = await admin();
    const r = await a.patch(`/api/background-verification/${custId}/fix-field`, { field: 'kyc_status', value: 'Verified' });
    expect(r.status).toBe(400);
    const still = (await ctx.db.query('SELECT kyc_status FROM customers WHERE id = $1', [custId])).rows[0] as any;
    expect(still.kyc_status).not.toBe('Verified');
  });

  it('rejects a malformed IFSC', async () => {
    const a = await admin();
    expect((await a.patch(`/api/background-verification/${custId}/fix-field`, { field: 'bank_ifsc', value: 'BADIFSC' })).status).toBe(400);
  });
});

describe('BGV — verification gate', () => {
  it('refuses to verify until all five KYC documents are on file, naming what is missing', async () => {
    const a = await admin();
    const r = await a.post(`/api/background-verification/${custId}/mark-verified`);
    expect(r.status).toBe(400);
    expect(r.json.error.message).toContain('Photo');       // still missing
    expect(r.json.error.message).not.toContain('PAN,');    // PAN is present
  });

  it('verifies once all five are present', async () => {
    await ctx.db.query(
      "INSERT INTO customer_documents (customer_id, doc_type, file_path, original_filename, mime, origin) VALUES ($1,'Photo','/x/ph.jpg','ph.jpg','image/jpeg','staff'), ($1,'customer_signature','/x/s.jpg','s.jpg','image/jpeg','staff'), ($1,'AddressProof','/x/ad.pdf','ad.pdf','application/pdf','wealth-import')",
      [custId]);
    const r = await (await admin()).post(`/api/background-verification/${custId}/mark-verified`);
    expect(r.status).toBe(200);
    expect(r.json.kyc_status).toBe('Verified');
    expect((await rowFor(custId)).kyc_status).toBe('Verified');
  });
});

describe('BGV — scope', () => {
  it('a branch staffer only sees their own book, not the whole customer base', async () => {
    const staff = await as('staff@demo.local');
    const r = await staff.get('/api/background-verification');
    expect(r.status).toBe(200);
    expect((r.json.rows as any[]).some((x) => x.id === custId)).toBe(false); // admin-enrolled
  });
});
