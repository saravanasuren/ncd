/**
 * A joint hirer's full 12-digit Aadhaar (owner 2026-09-12: "get all the 12
 * digits of aadhar for the joint applicant also").
 *
 * 089 stored last-4 only and said a full number must never be held for a
 * hirer. That was written when the agreement was LockerHub's and a hirer was,
 * to us, a name to print. #421 made the agreement ours and #427 made every
 * joint hirer a SIGNATORY of it, so a hirer is now a KYC subject of ours in
 * the same way the primary customer is — whose full Aadhaar has been stored
 * since 026, on the owner's 2026-07-21 decision, for exactly this reason.
 *
 * WHAT MUST STILL HOLD, and is the point of most of this file: the full number
 * is never PUSHED. LockerHub rejects twelve digits and is not permitted to
 * hold one (Aadhaar Act 2016 s.29), so hirersForLockerHub sends last-4 alone.
 * Storing it and sending it are different decisions and only one of them
 * changed.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
beforeAll(async () => { ctx = await startTestServer(); });
afterAll(async () => { await ctx.close(); });

const APP = 'LKR-AADHAAR-1';
const FULL = '123456789012';
const actor = { id: 1 } as never;

const mod = () => import('../src/modules/lockers/hirers.js');

describe('a joint hirer carries the full Aadhaar', () => {
  it('stores twelve digits and derives the last four from them', async () => {
    const { setHirers } = await mod();
    await setHirers(ctx.db, actor, APP, [
      { position: 2, full_name: 'Joint Two', phone: '9701000002', aadhaar: FULL,
        pan: 'AAAPA1111A', dob: '1980-01-01', address: '1 Street' },
    ], '9701000001');

    const row = (await ctx.db.query<{ aadhaar: string; aadhaar_last4: string }>(
      'SELECT aadhaar, aadhaar_last4 FROM locker_application_hirers WHERE lockerhub_application_id = $1 AND position = 2',
      [APP])).rows[0]!;
    expect(row.aadhaar).toBe(FULL);
    // Derived, never typed separately — the two cannot disagree.
    expect(row.aadhaar_last4).toBe('9012');
  });

  it('NEVER pushes the full number to LockerHub — last four only', async () => {
    // The rule 089 was written to enforce, and the one thing that did not
    // change. Asserted on the actual payload, not on the intention.
    const { hirersForLockerHub } = await mod();
    const payload = await hirersForLockerHub(ctx.db, APP);
    const wire = JSON.stringify(payload);
    expect(wire).toContain('9012');
    expect(wire).not.toContain(FULL);
    // ...and not by some other spelling either.
    expect(wire.replace(/\D/g, '')).not.toContain(FULL);
  });

  it('does not hand the full number back on a read', async () => {
    // listHirers feeds the screen and every caller downstream. It selects
    // last-4 only, the same structural protection applicant.ts gives
    // customers.aadhaar — a full number cannot leak through a route that never
    // asked for it.
    const { listHirers } = await mod();
    const rows = await listHirers(ctx.db, APP);
    expect(JSON.stringify(rows)).not.toContain(FULL);
    expect(rows[0]!.aadhaar_last4).toBe('9012');
  });

  it('survives an edit that does not resend it', async () => {
    /**
     * The silent data loss this exists to prevent. setHirers deletes and
     * re-inserts, and the screen re-sends what listHirers gave it — which has
     * no full Aadhaar in it. Changing a hirer's PHONE would therefore have
     * erased their Aadhaar, with nothing on the page showing it had gone.
     */
    const { setHirers } = await mod();
    await setHirers(ctx.db, actor, APP, [
      { position: 2, full_name: 'Joint Two', phone: '9701000099', aadhaar_last4: '9012',
        pan: 'AAAPA1111A', dob: '1980-01-01', address: '1 Street' },
    ], '9701000001');

    const row = (await ctx.db.query<{ aadhaar: string; phone: string }>(
      'SELECT aadhaar, phone FROM locker_application_hirers WHERE lockerhub_application_id = $1 AND position = 2',
      [APP])).rows[0]!;
    expect(row.phone).toBe('9701000099');   // the edit landed
    expect(row.aadhaar).toBe(FULL);         // ...and the Aadhaar is still there
  });

  it('a NEW twelve digits replaces the kept one', async () => {
    const { setHirers } = await mod();
    await setHirers(ctx.db, actor, APP, [
      { position: 2, full_name: 'Joint Two', phone: '9701000099', aadhaar: '999988887777',
        pan: 'AAAPA1111A', dob: '1980-01-01', address: '1 Street' },
    ], '9701000001');
    const row = (await ctx.db.query<{ aadhaar: string; aadhaar_last4: string }>(
      'SELECT aadhaar, aadhaar_last4 FROM locker_application_hirers WHERE lockerhub_application_id = $1 AND position = 2',
      [APP])).rows[0]!;
    expect(row.aadhaar).toBe('999988887777');
    expect(row.aadhaar_last4).toBe('7777');
  });

  it('refuses a partial number rather than storing half an Aadhaar', async () => {
    // A partial reads as captured while being unusable, and a last-4 derived
    // from it would be wrong. The DB CHECK is the backstop; splitAadhaar keeps
    // it from ever getting that far.
    const { splitAadhaar } = await mod();
    expect(splitAadhaar({ position: 2, full_name: 'x', aadhaar: '12345' })).toEqual({ full: null, last4: null });
    expect(splitAadhaar({ position: 2, full_name: 'x', aadhaar: '12345', aadhaar_last4: '4321' }))
      .toEqual({ full: null, last4: '4321' });
    await expect(ctx.db.query(
      `INSERT INTO locker_application_hirers (lockerhub_application_id, position, full_name, aadhaar)
       VALUES ('LKR-AADHAAR-BAD', 2, 'Bad', '12345')`)).rejects.toThrow();
  });
});
