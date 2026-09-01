/**
 * A DhanamFin signup should complete the customer's profile, not just name and
 * phone (owner 2026-08-29: "if a customer signup using dhanamfin app and enters
 * all kyc and personal information — everything should come in here ... now only
 * name and phone number is coming").
 *
 * Measured on production first, across 321 app syncs: name/dob/address/city/
 * state/gender/email arrive, nominee 90 times, bank 31. PAN as a NUMBER, Aadhaar
 * and pincode: NEVER. So most of the gap is the app not sending — but three
 * things were genuinely being thrown away on our side, and those are what this
 * pins:
 *
 *   1. `pan` was read to FIND a customer and then omitted from both the insert
 *      and the update, so a PAN sent at signup was discarded.
 *   2. the pincode was concatenated into the address line as ", PIN 641062"
 *      because "ncd has no pin column" — it has had one for a while.
 *   3. aadhaar was never stored at all.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
const KEY = 'dev-integration-key';

beforeAll(async () => { ctx = await startTestServer(); });
afterAll(async () => { await ctx.close(); });

async function sync(body: Record<string, unknown>) {
  const res = await fetch(`${ctx.base}/api/integration/customers/from-lockerhub`, {
    method: 'POST',
    headers: { 'X-Integration-Key': KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) as Record<string, unknown> | null };
}
const byPhone = async (phone: string) => (await ctx.db.query<Record<string, unknown>>(
  'SELECT * FROM customers WHERE phone = $1', [phone])).rows[0];

describe('a signup carries the whole profile through', () => {
  it('stores everything the app sends, not just name and phone', async () => {
    const phone = '9600070001';
    const r = await sync({
      name: 'App Signup Full', phone, email: 'full@example.com',
      dob: '1985-04-12', gender: 'Male',
      pan: 'ABCPS1234K',
      aadhaar: '1234 5678 9012',
      father_name: 'Signup Senior', occupation: 'Teacher',
      ckyc_number: 'CKYC00099', phone_secondary: '9600070002',
      address: { line1: '12 Mill Road', city: 'Coimbatore', district: 'Coimbatore', state: 'TN', pincode: '641062' },
    });
    expect(r.status).toBeLessThan(300);

    const c = (await byPhone(phone))!;
    expect(c.full_name).toBe('App Signup Full');
    expect(c.email).toBe('full@example.com');
    expect(c.gender).toBe('Male');
    expect(c.pan).toBe('ABCPS1234K');            // was silently dropped
    expect(c.father_name).toBe('Signup Senior');
    expect(c.occupation).toBe('Teacher');
    expect(c.ckyc_number).toBe('CKYC00099');
    expect(c.district).toBe('Coimbatore');
    // Aadhaar is stored digits-only. Asserting the last four keeps a full
    // number out of the test output.
    expect(String(c.aadhaar)).toHaveLength(12);
    expect(String(c.aadhaar).slice(-4)).toBe('9012');
  });

  it('puts the pincode in its own column and leaves the address alone', async () => {
    const c = (await byPhone('9600070001'))!;
    expect(c.pincode).toBe('641062');
    // The old behaviour appended ", PIN 641062" to the address line.
    expect(c.address).toBe('12 Mill Road');
    expect(String(c.address)).not.toContain('PIN');
  });

  it('a partial or masked Aadhaar is refused rather than stored as if real', async () => {
    const phone = '9600070003';
    await sync({ name: 'Masked Aadhaar', phone, aadhaar: 'XXXXXXXX9012' });
    const c = (await byPhone(phone))!;
    // Storing 9012 here would read as a genuine Aadhaar to everything downstream.
    expect(c.aadhaar).toBeNull();
  });
});

describe('the profile completed AFTER signup still lands', () => {
  it('a later sync fills the fields the signup did not carry', async () => {
    const phone = '9600070004';
    // Signup: the bare minimum, which is what production actually sees.
    await sync({ name: 'Later Kyc', phone });
    let c = (await byPhone(phone))!;
    expect(c.pan).toBeNull();

    // KYC finished in the app — the merge path, which ignored all of this.
    await sync({
      name: 'Later Kyc', phone, pan: 'LTRPK4321M',
      address: { line1: '9 South St', pincode: '600001', district: 'Chennai' },
      occupation: 'Farmer',
    });
    c = (await byPhone(phone))!;
    expect(c.pan).toBe('LTRPK4321M');
    expect(c.pincode).toBe('600001');
    expect(c.district).toBe('Chennai');
    expect(c.occupation).toBe('Farmer');
  });

  it('a PAN belonging to somebody else does not destroy the whole sync', async () => {
    // customers.pan is UNIQUE. A blind write raises 23505 and rolls back the
    // entire transaction — losing name, address, nominee and bank over one bad
    // field. The sync must survive and keep the rest.
    const phone = '9600070005';
    await sync({ name: 'Pan Clash', phone });
    const r = await sync({
      name: 'Pan Clash Updated', phone,
      pan: 'ABCPS1234K',                     // already belongs to App Signup Full
      address: { line1: '77 New Street', pincode: '641001' },
    });
    expect(r.status).toBeLessThan(300);

    const c = (await byPhone(phone))!;
    expect(c.pan).toBeNull();                // the clashing PAN was not taken
    expect(c.full_name).toBe('Pan Clash Updated');   // ...and everything else landed
    expect(c.address).toBe('77 New Street');
    expect(c.pincode).toBe('641001');
  });

  it('never overwrites a PAN or Aadhaar that is already on record', async () => {
    const phone = '9600070006';
    await sync({ name: 'Already Verified', phone, pan: 'REALP1111A', aadhaar: '111122223333' });
    await sync({ name: 'Already Verified', phone, pan: 'WRONGP222B', aadhaar: '999988887777' });
    const c = (await byPhone(phone))!;
    // Staff-verified identity is better evidence than whatever the app holds.
    expect(c.pan).toBe('REALP1111A');
    expect(String(c.aadhaar).slice(-4)).toBe('3333');
  });

  it('takes the Aadhaar from a KYC attempt when it is not sent at the top level', async () => {
    const phone = '9600070007';
    await sync({
      name: 'Kyc Attempt Aadhaar', phone,
      kyc: { attempts: [{ document_type: 'AADHAAR', status: 'verified', id_number: '4444 5555 6666' }] },
    });
    const c = (await byPhone(phone))!;
    expect(String(c.aadhaar).slice(-4)).toBe('6666');
  });
});
