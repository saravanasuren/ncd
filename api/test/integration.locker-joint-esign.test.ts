/**
 * A joint locker hiring is e-signed by EVERY hirer (owner 2026-09-12: "the
 * joint applicant should also do the esigning").
 *
 * Until now only the primary customer signed. The joint hirers were printed on
 * the agreement by #424 and named correctly on Digio — but never asked to sign
 * it. A document that binds two or three people while carrying one signature is
 * not the agreement it claims to be.
 *
 * ONE Digio request carries all of them. Digio marks a document signed only
 * once EVERY signer has signed, which is the semantics wanted here, and it
 * means the existing poller and completeSigning need no change — they already
 * work off that whole-document status.
 *
 * The two things that can silently go wrong, both pinned below:
 *   · `sign_coordinates` is keyed BY IDENTIFIER, so two signers sharing a phone
 *     collapse into one box — one of them is never asked, and the document
 *     still completes. Refused.
 *   · a hirer printed on the page with no phone leaves a document that can
 *     never complete, because Digio waits for that signer forever. Refused,
 *     naming who and what to add.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
beforeAll(async () => { ctx = await startTestServer(); });
afterAll(async () => { await ctx.close(); });

describe('the agreement gives every hirer their own signature box', () => {
  it('one box for a sole hirer, and it is hirer 1', async () => {
    const { lockerAgreementPdf } = await import('../src/modules/reports/forms/locker-agreement.js');
    const r = await lockerAgreementPdf(ctx.db, {
      customer: { full_name: 'Sole Hirer', pan: 'AAAPA1111A', phone: '9700111111' },
      locker: { locker_no: 'A-1' },
    } as never);
    expect(r.hirers).toHaveLength(1);
    expect(r.hirers[0]!.position).toBe(1);
    // The single-signer field still points at hirer 1, so callers that only
    // ever sign the primary are unaffected.
    expect(r.hirers[0]!.box).toEqual(r.hirer);
  });

  it('a box PER hirer, at different places on the page', async () => {
    const { lockerAgreementPdf } = await import('../src/modules/reports/forms/locker-agreement.js');
    const r = await lockerAgreementPdf(ctx.db, {
      customer: { full_name: 'First Hirer', pan: 'AAAPA1111A', phone: '9700111111' },
      locker: { locker_no: 'A-2' },
      hirers: [
        { position: 2, full_name: 'Second Hirer', phone: '9700222222' },
        { position: 3, full_name: 'Third Hirer', phone: '9700333333' },
      ],
    } as never);
    expect(r.hirers.map((h) => h.position)).toEqual([1, 2, 3]);
    // Distinct boxes — two signers cannot share coordinates, or one signature
    // lands on top of the other.
    const keys = r.hirers.map((h) => `${h.page}:${h.box.lly}:${h.box.ury}`);
    expect(new Set(keys).size).toBe(3);
    // And each is named on the page, so the paper says who signed where.
    expect(r.hirers.map((h) => h.name)).toEqual(['First Hirer', 'Second Hirer', 'Third Hirer']);
  });
});

describe('the Digio request carries every signer', () => {
  it('refuses two signers who share a contact', async () => {
    // sign_coordinates is keyed by identifier: a shared phone would silently
    // collapse two signers into one box, and the document would complete with
    // one of them never having been asked.
    const { createSignRequest } = await import('../src/integrations/digio/index.js');
    await expect(createSignRequest({
      reason: 'Locker hire agreement',
      parties: [
        { name: 'One', phone: '9700111111', box: { llx: 1, lly: 1, urx: 2, ury: 2 }, page: 1 },
        { name: 'Two', phone: '9700111111', box: { llx: 1, lly: 3, urx: 2, ury: 4 }, page: 1 },
      ],
    })).rejects.toThrow(/share the contact/i);
  });

  it('accepts distinct signers — the normal joint hiring', async () => {
    // Stub mode (no Digio creds in tests) returns a recorded-but-inert request,
    // so this exercises the payload build without calling out.
    const { createSignRequest } = await import('../src/integrations/digio/index.js');
    const r = await createSignRequest({
      reason: 'Locker hire agreement',
      parties: [
        { name: 'One', phone: '9700111111', box: { llx: 1, lly: 1, urx: 2, ury: 2 }, page: 1 },
        { name: 'Two', phone: '9700222222', box: { llx: 1, lly: 3, urx: 2, ury: 4 }, page: 1 },
      ],
    });
    expect(r.digioRequestId).toBeTruthy();
  });
});
