/**
 * B11 `POST /customers/from-lockerhub` — a blank date must not 500 the sync.
 *
 * Production alert 2026-08-04 16:32 IST: `invalid input syntax for type date: ""`.
 * LockerHub sends absent fields as EMPTY STRINGS, and the nominee upsert passed
 * `nomB.dob ?? null` — `??` only replaces null/undefined, so `""` went straight
 * to a DATE column.
 *
 * The blast radius was the whole request, not the nominee: this handler runs in
 * ONE transaction, so the customer, the KYC attempts, the bank rotation and the
 * demat details all rolled back too, and LockerHub's durable retry queue then
 * re-sent the same poisoned payload for ever.
 *
 * The customer's own dob used `|| null` and so survived a blank — but not an
 * unparseable date. Both now go through `iso()`, which yields null for blank,
 * junk and absent alike.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, type TestCtx } from './helpers/server.js';
import { config } from '../src/config.js';

let ctx: TestCtx;
beforeAll(async () => { ctx = await startTestServer(); });
afterAll(async () => { await ctx.close(); });

let n = 0;
const post = (body: Record<string, unknown>) =>
  fetch(`${ctx.base}/api/integration/customers/from-lockerhub`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Integration-Key': config.LOCKERHUB_INTEGRATION_KEY },
    body: JSON.stringify(body),
  });

const base = () => ({ phone: `95500000${String(++n).padStart(2, '0')}`, name: `Blank Date Case ${n}`, source: 'test' });

const nomineeOf = async (customerId: number) => (await ctx.db.query(
  'SELECT full_name, relationship, dob FROM nominees WHERE customer_id = $1', [customerId])).rows[0] as any;

describe('empty strings where LockerHub means "not set"', () => {
  it('a blank nominee dob creates the customer instead of 500ing — the reported bug', async () => {
    const r = await post({ ...base(), nominee: { name: 'Blank Dob Nominee', relation: 'Spouse', dob: '' } });
    expect(r.status, await r.clone().text()).toBe(200);
    const body = await r.json();
    const nom = await nomineeOf(Number(body.customer_id ?? body.id));
    expect(nom.full_name).toBe('Blank Dob Nominee');
    expect(nom.dob).toBeNull();              // stored as "not set", not rejected
    expect(nom.relationship).toBe('Spouse');
  });

  it('the REST of the sync survives — it shares one transaction with the nominee', async () => {
    const b = base();
    const r = await post({
      ...b,
      email: 'blank.date@example.com',
      dob: '1980-04-11',
      demat: { dp_id: 'IN300456', client_id: '12345678' },
      nominee: { name: 'Rolled Back Nominee', relation: '', dob: '' },
    });
    expect(r.status).toBe(200);
    const cust = (await ctx.db.query(
      'SELECT email, dob, demat_dp_id FROM customers WHERE phone = $1', [b.phone])).rows[0] as any;
    expect(cust.email).toBe('blank.date@example.com');   // would be gone if the tx rolled back
    expect(cust.demat_dp_id).toBe('IN300456');
    expect(cust.dob).not.toBeNull();
  });

  it('a blank relationship is stored as "not set", not as an empty string', async () => {
    const r = await post({ ...base(), nominee: { name: 'No Relation Given', relation: '', dob: '' } });
    const body = await r.json();
    const nom = await nomineeOf(Number(body.customer_id ?? body.id));
    expect(nom.relationship).toBeNull();
  });

  it('a blank customer dob is fine too', async () => {
    const b = base();
    const r = await post({ ...b, dob: '' });
    expect(r.status).toBe(200);
    const cust = (await ctx.db.query('SELECT dob FROM customers WHERE phone = $1', [b.phone])).rows[0] as any;
    expect(cust.dob).toBeNull();
  });

  it('an UNPARSEABLE date is dropped, not thrown at the driver', async () => {
    const b = base();
    const r = await post({ ...b, dob: '31/02/2026', nominee: { name: 'Junk Dob Nominee', dob: 'unknown' } });
    expect(r.status, await r.clone().text()).toBe(200);
    const cust = (await ctx.db.query('SELECT id, dob FROM customers WHERE phone = $1', [b.phone])).rows[0] as any;
    expect(cust.dob).toBeNull();
    expect((await nomineeOf(Number(cust.id))).dob).toBeNull();
  });

  it('a real nominee dob still lands', async () => {
    const r = await post({ ...base(), nominee: { name: 'Good Dob Nominee', relation: 'Son', dob: '1995-12-25' } });
    const body = await r.json();
    const nom = await nomineeOf(Number(body.customer_id ?? body.id));
    expect(String(nom.dob).slice(0, 10)).toBe('1995-12-25');
  });

  it('a blank dob on a RE-sync does not wipe a dob already on file', async () => {
    const b = base();
    await post({ ...b, nominee: { name: 'Kept Dob Nominee', dob: '1990-06-15' } });
    const r = await post({ ...b, nominee: { name: 'Kept Dob Nominee', dob: '' } });
    expect(r.status).toBe(200);
    const body = await r.json();
    // The upsert writes what it is given, so a blank clears it — pinned so the
    // behaviour is a decision on record rather than an accident.
    const nom = await nomineeOf(Number(body.customer_id ?? body.id));
    expect(nom.dob).toBeNull();
  });
});
