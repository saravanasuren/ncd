/**
 * Every hirer signs, IN ORDER, on ONE document (owner 2026-09-14: "i need
 * different buttons for each esigning... make sure to use one single
 * applicaition for all esigning... first the primary holder hirer 1 esigns and
 * then follow the rest of hirer according to how many are there").
 *
 * #427 put all of them on ONE Digio request, so everyone was invited at once
 * and the screen had a single button and a single status for the lot. The
 * owner wants a button and a visible state per person, signed in turn.
 *
 * So a locker agreement is now a CHAIN over one document: hirer 1 signs the
 * rendered agreement, hirer 2 signs the file hirer 1 produced, hirer 3 signs
 * that, then the CEO. The CEO stage has always worked this way, so this
 * generalises a proven mechanism rather than inventing one.
 *
 * The two ways it can go quietly wrong, both pinned:
 *   · sending out of order puts a signature on a document the next stage is
 *     about to replace — refused;
 *   · a failed download mid-chain leaves an EARLIER copy stored, and the next
 *     hirer would sign that, dropping the signature in between with nothing to
 *     show for it — refused by a watermark, not by hoping.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, Client, type TestCtx } from './helpers/server.js';

let ctx: TestCtx;
beforeAll(async () => { ctx = await startTestServer(); });
afterAll(async () => { await ctx.close(); });

const APP = 'LKR-CHAIN-1';
const actor = { id: 1 } as never;
const admin = async () => { const c = new Client(ctx.base); await c.post('/api/auth/login', { email: 'admin@dhanam.finance', password: 'ChangeMe_Dev_123' }); return c; };
const mod = () => import('../src/modules/lockers/agreements.js');

/**
 * Mark a stage signed the way the poller does: session signed, a REAL file
 * stored, and the watermark advanced to say whose signatures it carries.
 *
 * The file has to exist. A first version pointed at a path with nothing behind
 * it, and every later stage was refused — correctly, which is the guard doing
 * its job on a fixture rather than a bug.
 */
async function pretendSigned(position: number) {
  const sess = (await ctx.db.query<{ id: string; locker_agreement_signing_id: string }>(
    `SELECT id, locker_agreement_signing_id FROM digio_signing_sessions
      WHERE signer_position = $1 AND status = 'requested' ORDER BY id DESC LIMIT 1`, [position])).rows[0]!;
  await ctx.db.query("UPDATE digio_signing_sessions SET status = 'signed', signed_at = now() WHERE id = $1", [sess.id]);
  const { saveBuffer } = await import('../src/lib/storage.js');
  const stored = saveBuffer('locker-agreements', `stage-${position}.pdf`,
    Buffer.from(`%PDF-1.4 stage ${position}\n%%EOF\n`));
  await ctx.db.query(
    `UPDATE locker_agreement_signings
        SET signed_doc_path = $2, signed_doc_mime = 'application/pdf',
            signed_doc_filename = 'signed.pdf', signed_doc_position = $3
      WHERE id = $1`, [sess.locker_agreement_signing_id, stored.path, position]);
}

describe('the signing chain', () => {
  beforeAll(async () => {
    const a = await admin();
    const cust = await a.post('/api/customers', { full_name: 'Chain Primary', phone: '9714000001' });
    await ctx.db.query(
      `INSERT INTO locker_applications (lockerhub_application_id, customer_id, customer_name, phone, locker_size, status)
       VALUES ($1, $2, 'Chain Primary', '9714000001', 'Large', 'approved')`, [APP, Number(cust.json.id)]);
    const { setHirers } = await import('../src/modules/lockers/hirers.js');
    await setHirers(ctx.db, actor, APP, [
      { position: 2, full_name: 'Chain Second', phone: '9714000002', pan: 'AAAPC1111A', dob: '1980-01-01', address: '2 St' },
      { position: 3, full_name: 'Chain Third', phone: '9714000003', pan: 'AAAPC2222B', dob: '1981-01-01', address: '3 St' },
    ], '9714000001');
  });

  it('lists one signer per hirer, with only the first able to send', async () => {
    const { agreementSigners } = await mod();
    const s = await agreementSigners(ctx.db, APP);
    expect(s.map((x) => x.position)).toEqual([1, 2, 3]);
    expect(s.map((x) => x.name)).toEqual(['Chain Primary', 'Chain Second', 'Chain Third']);
    expect(s[0]!.can_send).toBe(true);
    // Locked, and it says WHY rather than just being greyed out.
    expect(s[1]!.can_send).toBe(false);
    expect(s[1]!.blocked_reason).toMatch(/Hirer 1 has to sign first/);
    expect(s[2]!.blocked_reason).toMatch(/Hirer 2 has to sign first/);
  });

  it('refuses hirer 2 before hirer 1 has signed', async () => {
    const { initiateHirerEsign } = await mod();
    await expect(initiateHirerEsign(ctx.db, actor, APP, 2)).rejects.toThrow(/Hirer 1 has to sign first/);
  });

  it('sends hirer 1, then unlocks hirer 2 only once they have signed', async () => {
    const { initiateHirerEsign, agreementSigners } = await mod();
    await initiateHirerEsign(ctx.db, actor, APP, 1);
    let s = await agreementSigners(ctx.db, APP);
    expect(s[0]!.status).toBe('sent');
    expect(s[1]!.can_send).toBe(false);      // sent is not signed

    await pretendSigned(1);
    s = await agreementSigners(ctx.db, APP);
    expect(s[0]!.status).toBe('signed');
    expect(s[1]!.can_send).toBe(true);
  });

  it('refuses hirer 3 when the file still only carries hirer 1', async () => {
    // The silent-corruption case. Hirer 2's session exists and their download
    // failed, so the stored file is still hirer 1's copy — signing it would
    // drop hirer 2 with nothing to show for it.
    const { initiateHirerEsign } = await mod();
    await initiateHirerEsign(ctx.db, actor, APP, 2);
    const sess = (await ctx.db.query<{ id: string }>(
      `SELECT id FROM digio_signing_sessions WHERE signer_position = 2 AND status = 'requested' ORDER BY id DESC LIMIT 1`)).rows[0]!;
    await ctx.db.query("UPDATE digio_signing_sessions SET status = 'signed' WHERE id = $1", [sess.id]);
    // ...watermark deliberately left at 1, which is what a failed download does.
    await expect(initiateHirerEsign(ctx.db, actor, APP, 3)).rejects.toThrow(/not available yet/);
  });

  it('lets hirer 3 through once the file carries hirer 2', async () => {
    await ctx.db.query(
      `UPDATE locker_agreement_signings SET signed_doc_position = 2 WHERE lockerhub_application_id = $1`, [APP]);
    const { initiateHirerEsign } = await mod();
    const r = await initiateHirerEsign(ctx.db, actor, APP, 3);
    expect(r.position).toBe(3);
    expect(r.digio_request_id).toBeTruthy();
  });

  it('will not let the hirers be changed once anyone has signed', async () => {
    const { setHirers } = await import('../src/modules/lockers/hirers.js');
    await expect(setHirers(ctx.db, actor, APP, [
      { position: 2, full_name: 'Renamed Second', phone: '9714000002', pan: 'AAAPC1111A', dob: '1980-01-01', address: '2 St' },
    ], '9714000001')).rejects.toThrow(/already signed/);
  });
});

describe('a sole hirer is unchanged', () => {
  it('one signer, sendable immediately — the flow that already worked', async () => {
    const a = await admin();
    const cust = await a.post('/api/customers', { full_name: 'Sole Holder', phone: '9714000009' });
    await ctx.db.query(
      `INSERT INTO locker_applications (lockerhub_application_id, customer_id, customer_name, phone, locker_size, status)
       VALUES ('LKR-CHAIN-SOLE', $1, 'Sole Holder', '9714000009', 'Large', 'approved')`, [Number(cust.json.id)]);
    const { agreementSigners, initiateCustomerEsign } = await mod();
    const s = await agreementSigners(ctx.db, 'LKR-CHAIN-SOLE');
    expect(s).toHaveLength(1);
    expect(s[0]!.can_send).toBe(true);
    // The old entry point still starts the chain at hirer 1.
    const r = await initiateCustomerEsign(ctx.db, actor, 'LKR-CHAIN-SOLE');
    expect(r.digio_request_id).toBeTruthy();
  });
});
