/**
 * Joint hirers must be READABLE, not just writable (owner 2026-09-14: "in the
 * locker tenant page when i click on a customers name — im nowhere seeing any
 * joint applicants name or details... the joint applicant name is not getting
 * properly saved or idk whats broken").
 *
 * Nothing was broken about the SAVING. Five joint hirers were on file in
 * production, correct, including one on the very locker the owner was looking
 * at. They were invisible because:
 *
 *   · lockerProfile never returned them, so the locker/tenant page showed a
 *     jointly-held locker as single-held; and
 *   · the enrolment screen never READ them back, so reopening an application
 *     showed an empty "+ Add a joint hirer".
 *
 * The second one is what made it look like a save bug: staff re-typed the
 * hirer into a form whose only write happens at CREATE, so the re-entry went
 * nowhere. A PUT existed the whole time and no screen called it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
beforeAll(async () => { ctx = await startTestServer(); });
afterAll(async () => { await ctx.close(); });

const APP = 'LKR-VISIBLE-1';
const admin = async () => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email: 'admin@dhanam.finance', password: 'ChangeMe_Dev_123' }); return c; };

describe('a joint hirer can be seen after it is saved', () => {
  it('the PUT saves onto an application that already exists', async () => {
    // The call the screen never made. Before this, a hirer added after create
    // was silently discarded.
    const a = await admin();
    const r = await a.put(`/api/lockers/applications/${APP}/hirers`, {
      hirers: [{ position: 2, full_name: 'Second Holder', phone: '9712000002',
                 pan: 'AAAPS1111A', dob: '1985-05-05', address: '2 Road', aadhaar: '111122223333' }],
    });
    expect(r.status).toBe(200);
  });

  it('the GET reads them back, so a reopened application is not blank', async () => {
    const a = await admin();
    const r = await a.get(`/api/lockers/applications/${APP}/hirers`);
    expect(r.status).toBe(200);
    const rows = r.json.hirers as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.full_name).toBe('Second Holder');
    expect(rows[0]!.phone).toBe('9712000002');
    // Last four only — the full number is write-only, as for customers.
    expect(rows[0]!.aadhaar_last4).toBe('3333');
    expect(JSON.stringify(rows)).not.toContain('111122223333');
  });

  it('the locker profile carries them, so the tenant page can show them', async () => {
    // The page the owner was looking at. It listed payments, waivers, e-sign
    // and authorised users — and never the other holders.
    const { lockerProfile } = await import('../src/modules/lockers/profile.js');
    const p = await lockerProfile(ctx.db, APP) as Record<string, unknown>;
    const hirers = p.hirers as Array<Record<string, unknown>>;
    expect(Array.isArray(hirers)).toBe(true);
    expect(hirers).toHaveLength(1);
    expect(hirers[0]!.full_name).toBe('Second Holder');
  });

  it('an edit through the PUT replaces rather than duplicating', async () => {
    const a = await admin();
    await a.put(`/api/lockers/applications/${APP}/hirers`, {
      hirers: [{ position: 2, full_name: 'Second Holder Renamed', phone: '9712000002',
                 pan: 'AAAPS1111A', dob: '1985-05-05', address: '2 Road' }],
    });
    const rows = (await a.get(`/api/lockers/applications/${APP}/hirers`)).json.hirers as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.full_name).toBe('Second Holder Renamed');
    // ...and the full Aadhaar from the first save survived an edit that did
    // not resend it.
    const kept = (await ctx.db.query<{ aadhaar: string }>(
      'SELECT aadhaar FROM locker_application_hirers WHERE lockerhub_application_id = $1 AND position = 2',
      [APP])).rows[0]!;
    expect(kept.aadhaar).toBe('111122223333');
  });

  it('a locker with no joint hirers reports an empty list, not a missing key', async () => {
    // The page renders "Single holder" off this; undefined would render nothing
    // and look like the old bug again.
    const { lockerProfile } = await import('../src/modules/lockers/profile.js');
    const p = await lockerProfile(ctx.db, 'LKR-VISIBLE-NONE') as Record<string, unknown>;
    expect(Array.isArray(p.hirers)).toBe(true);
    expect(p.hirers).toHaveLength(0);
  });
});
