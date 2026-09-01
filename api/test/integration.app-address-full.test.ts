/**
 * The whole street address from a DhanamFin sync, not just its first line
 * (owner 2026-08-29, from a side-by-side of the two systems).
 *
 * DHN0735 is the worked example. LockerHub holds:
 *   SECTOR 26, SAMBHAJI CHOWK, NEAR SOUTH INDIAN BANK, 'SAI ATHARVA',
 *   BUNGALOW NO.2, PLOT F6-F10,, NIGDI PRADHIKARAN, Maharashtra, 411044
 * NCD stored:
 *   SECTOR 26, SAMBHAJI CHOWK
 *
 * Everything between the first line and the city was lost, because the handler
 * read `line1` and nothing else. The doubled comma in their display string is
 * the giveaway — they join components, and at least one of them had no home
 * here.
 *
 * The contract does not document the address shape and the audit keeps no
 * payloads, so the handler now also records which address KEYS arrived — names
 * only, never values — which is how we learn what the app really sends.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
const KEY = 'dev-integration-key';

beforeAll(async () => { ctx = await startTestServer(); });
afterAll(async () => { await ctx.close(); });

const sync = async (b: Record<string, unknown>) => {
  const res = await fetch(`${ctx.base}/api/integration/customers/from-lockerhub`, {
    method: 'POST',
    headers: { 'X-Integration-Key': KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(b),
  });
  return res.status;
};
const byPhone = async (phone: string) => (await ctx.db.query<Record<string, unknown>>(
  'SELECT * FROM customers WHERE phone = $1', [phone])).rows[0];

describe('the full street address survives the sync', () => {
  it('keeps every street part, not just line1 — the DHN0735 case', async () => {
    const phone = '9600090001';
    expect(await sync({
      name: 'Full Address Cust', phone,
      address: {
        line1: 'SECTOR 26, SAMBHAJI CHOWK',
        line2: "NEAR SOUTH INDIAN BANK, 'SAI ATHARVA'",
        line3: 'BUNGALOW NO.2, PLOT F6-F10',
        city: 'NIGDI PRADHIKARAN', state: 'Maharashtra', pincode: '411044',
      },
    })).toBeLessThan(300);

    const c = (await byPhone(phone))!;
    expect(c.address).toBe("SECTOR 26, SAMBHAJI CHOWK, NEAR SOUTH INDIAN BANK, 'SAI ATHARVA', BUNGALOW NO.2, PLOT F6-F10");
    // city / state / pincode keep their own columns and are NOT repeated in the
    // address line, or every address would end in its own city twice.
    expect(c.city).toBe('NIGDI PRADHIKARAN');
    expect(c.state).toBe('Maharashtra');
    expect(c.pincode).toBe('411044');
    expect(String(c.address)).not.toContain('NIGDI');
    expect(String(c.address)).not.toContain('411044');
  });

  it('reads the other names a sender might use for the same thing', async () => {
    const phone = '9600090002';
    await sync({
      name: 'Alt Keys', phone,
      address: { street: '4 Gandhi Road', area: 'RS Puram', landmark: 'Opp. the temple', city: 'Coimbatore' },
    });
    const c = (await byPhone(phone))!;
    expect(c.address).toBe('4 Gandhi Road, RS Puram, Opp. the temple');
  });

  it('a single-line address is unchanged — no stray separators', async () => {
    const phone = '9600090003';
    await sync({ name: 'One Line', phone, address: { line1: '12 Mill Road', city: 'Erode' } });
    expect((await byPhone(phone))!.address).toBe('12 Mill Road');
  });

  it('a later sync widens a previously truncated address', async () => {
    const phone = '9600090004';
    await sync({ name: 'Grows Later', phone, address: { line1: 'FIRST BIT' } });
    expect((await byPhone(phone))!.address).toBe('FIRST BIT');
    await sync({ name: 'Grows Later', phone, address: { line1: 'FIRST BIT', line2: 'SECOND BIT' } });
    expect((await byPhone(phone))!.address).toBe('FIRST BIT, SECOND BIT');
  });

  it('records WHICH address keys arrived, and never their values', async () => {
    const phone = '9600090005';
    await sync({
      name: 'Key Recorder', phone,
      address: { line1: '9 Secret Lane', line2: '', city: 'Salem', pincode: '636001' },
    });
    const c = (await byPhone(phone))!;
    const audit = (await ctx.db.query<{ after_data: unknown }>(
      `SELECT after_data FROM audit_log WHERE action = 'LOCKERHUB_CUSTOMER_SYNC' AND entity_id = $1
        ORDER BY id DESC LIMIT 1`, [String(c.id)])).rows[0]!;
    const after = (typeof audit.after_data === 'string' ? JSON.parse(audit.after_data) : audit.after_data) as Record<string, unknown>;

    const keys = after.address_keys as string[];
    expect(keys).toContain('line1');
    expect(keys).toContain('city');
    expect(keys).toContain('pincode');
    expect(keys).not.toContain('line2');            // empty, so not "arrived"
    // The whole point of names-only: no address content in the audit row.
    expect(JSON.stringify(after)).not.toContain('Secret Lane');
    expect(JSON.stringify(after)).not.toContain('636001');
  });
});
