/**
 * The customer's signed redemption request letter — the gate between asking for
 * a redemption and an approver seeing it (owner 2026-11-18).
 *
 * THE FLOW. Staff press Redeem early and give a reason; the redemption record
 * is created but, unlike before, is NOT submitted for approval. The letter is
 * generated from that record, the customer signs it — on paper, scanned back
 * in, or through Digio — and only a signed letter unlocks submit-for-approval.
 * The approver then sees the letter, the scan and the reason together, and
 * approves the redemption itself. There is deliberately no second approval for
 * the signature: the owner asked for the approver to check it as part of the
 * redemption they are already approving, not in another queue.
 *
 * WHY THE PDF IS STORED RATHER THAN REGENERATED. The customer signed one
 * particular file. Regenerating it on demand would quietly produce a different
 * document the moment a bank account, a name or the letter format changed, and
 * the signature on file would then attest to wording nobody ever saw.
 *
 * WHAT VOIDS A SIGNATURE. The approver may still waive the penalty or move the
 * redemption date, and the date recomputes the broken-period interest. Asked
 * what should happen, the owner chose: the letter voids and the customer signs
 * again. `supersede()` below is that rule, and it is called from the two places
 * that can move those figures rather than left to a comparison somebody might
 * forget to run — though `isStale()` also compares the frozen figures, so a
 * path added later that forgets to call supersede is still caught at the gate.
 */
import type { Db } from '../../db/types.js';
import type { AuthUser } from '../../lib/authUser.js';
import { errors } from '../../lib/errors.js';
import { writeAudit } from '../../lib/audit.js';

export const LIVE = ['Draft', 'AwaitingSignature', 'Signed'] as const;

export interface SigningRow {
  id: number;
  redemption_id: number;
  method: 'esign' | 'physical' | null;
  status: string;
  letter_pdf_path: string | null;
  letter_generated_at: string | null;
  signed_principal: string | null;
  signed_penalty: string | null;
  signed_redemption_date: string | null;
  signed_doc_path: string | null;
  signed_doc_filename: string | null;
  signed_doc_mime: string | null;
  signed_doc_pages: number | null;
  signed_on: string | null;
  note: string | null;
  digio_request_id: string | null;
  sign_url: string | null;
  signed_at: string | null;
  superseded_at: string | null;
  superseded_reason: string | null;
}

const COLS = `id, redemption_id, method, status, letter_pdf_path, letter_generated_at,
  signed_principal, signed_penalty, signed_redemption_date,
  signed_doc_path, signed_doc_filename, signed_doc_mime, signed_doc_pages, signed_on, note,
  digio_request_id, sign_url, signed_at, superseded_at, superseded_reason`;

/** The one live signature attempt for a redemption, if there is one. */
export async function liveSigning(db: Db, redemptionId: number): Promise<SigningRow | null> {
  const { rows } = await db.query<SigningRow>(
    `SELECT ${COLS} FROM redemption_signings
      WHERE redemption_id = $1 AND status = ANY($2::text[]) LIMIT 1`,
    [redemptionId, LIVE as unknown as string[]]);
  return rows[0] ?? null;
}

interface RedemptionFacts {
  id: number; status: string; type: string; source: string | null; created_at: string;
  principal: string; penalty: string; redemption_date: string | null;
  approval_request_id: string | null;
}

async function redemptionFacts(db: Db, redemptionId: number): Promise<RedemptionFacts> {
  const { rows } = await db.query<RedemptionFacts>(
    `SELECT id, status, type, source, created_at, principal, penalty, redemption_date, approval_request_id
       FROM redemptions WHERE id = $1`, [redemptionId]);
  if (!rows[0]) throw errors.notFound('Redemption not found');
  return rows[0];
}

/**
 * Which redemptions need the customer's signed letter: PREMATURE ones that
 * STAFF raised.
 *
 * Two separate decisions by the owner on 2026-11-18, both deliberate.
 *
 * Premature only. Asked whether maturity payouts should need a letter too,
 * they said no: an early withdrawal is the customer breaking the agreed term
 * and taking a penalty, so their written authority is the point. Money falling
 * due on the agreed date is not that.
 *
 * Staff-raised only. The same question offered a third option that explicitly
 * covered "requests raised from the customer portal and from LockerHub", and
 * they chose the one that did not. It holds together: a customer who signs in
 * to the portal and asks has already made the request themselves, in their own
 * authenticated session. A staff-raised redemption is somebody ELSE asking for
 * a customer's money back, which is exactly where a signature earns its keep.
 *
 * Practical consequence worth knowing: this is why the portal flow's existing
 * tests still pass untouched rather than being rewritten around a new step.
 */
export function needsSignature(
  type: string,
  source: string | null | undefined,
  createdAt?: string | null,
  consentFrom?: string | null,
): boolean {
  if (String(type) !== 'premature') return false;
  if (String(source ?? 'staff') !== 'staff') return false;
  // AND RAISED ON OR AFTER THE CUT-OFF (owner 2026-11-20: "note this is only
  // for from nov 13th and for the future one which goes hereafter" — then
  // moved back to 1 November on 2026-11-21, one date for this gate and the
  // bulk letter tool alike).
  //
  // Without a date this returns true, which is the right default: a brand new
  // redemption has no created_at yet at the moment the rule is first asked,
  // and the safe answer for something being raised now is that it needs the
  // letter. The date only ever EXCLUDES older ones.
  if (!createdAt || !consentFrom) return true;
  return String(createdAt).slice(0, 10) >= String(consentFrom).slice(0, 10);
}

const money = (v: unknown) => Math.round(Number(v ?? 0) * 100) / 100;
const day = (v: unknown) => (v == null ? null : String(v).slice(0, 10));

/**
 * Has the redemption moved since the customer signed?
 *
 * Compares the frozen figures with the record as it stands. `supersede()` is
 * the primary mechanism and runs from the two endpoints that change these; this
 * is the backstop, so a third path added later cannot slip a changed figure
 * past a stale signature just by forgetting to call it.
 */
export function isStale(signing: SigningRow, r: { principal: unknown; penalty: unknown; redemption_date: unknown }): boolean {
  if (signing.signed_principal == null) return false;
  return money(signing.signed_principal) !== money(r.principal)
    || money(signing.signed_penalty) !== money(r.penalty)
    || day(signing.signed_redemption_date) !== day(r.redemption_date);
}

/**
 * Generate (or regenerate) the letter for a redemption and open a Draft
 * signature against it.
 *
 * Regenerating is allowed right up until the customer has signed: staff fix a
 * bank account or a spelling and want the corrected letter. Once a signature is
 * on file the document is frozen — changing it would leave a signature attached
 * to wording the customer never read.
 */
export async function generateLetter(db: Db, actor: AuthUser, redemptionId: number): Promise<SigningRow> {
  const r = await redemptionFacts(db, redemptionId);
  const { consentLetterFrom } = await import('./letter.js');
  const consentFrom = await consentLetterFrom(db);
  if (!needsSignature(r.type, r.source, r.created_at, consentFrom)) {
    throw errors.badRequest(
      'This redemption does not need a signed consent letter: only a staff-raised early withdrawal '
      + `raised on or after ${consentFrom} does. The letter can still be downloaded for the record.`);
  }
  if (r.status !== 'Requested') throw errors.conflict(`This redemption is ${r.status}; a request letter can only be prepared while it is awaiting submission.`);

  const existing = await liveSigning(db, redemptionId);
  if (existing?.status === 'Signed') {
    throw errors.conflict('This letter has already been signed. Nothing can change on it now — the approver reviews this copy.');
  }

  const { redemptionLetterPdf } = await import('./letter.js');
  const { saveBuffer, removeStored } = await import('../../lib/storage.js');
  const buf = await redemptionLetterPdf(db, redemptionId);
  const stored = saveBuffer('redemption-letters', `redemption-letter-${redemptionId}.pdf`, buf);
  const previousPath = existing?.letter_pdf_path ?? null;

  try {
    const row = await db.withTx(async (tx) => {
      if (existing) {
        return (await tx.query<SigningRow>(
          `UPDATE redemption_signings
              SET letter_pdf_path = $1, letter_generated_at = now(), status = 'Draft',
                  sign_url = NULL, digio_request_id = NULL, updated_at = now()
            WHERE id = $2 RETURNING ${COLS}`, [stored.path, existing.id])).rows[0]!;
      }
      return (await tx.query<SigningRow>(
        `INSERT INTO redemption_signings (redemption_id, status, letter_pdf_path, letter_generated_at, created_by_user_id)
         VALUES ($1, 'Draft', $2, now(), $3) RETURNING ${COLS}`,
        [redemptionId, stored.path, actor.id])).rows[0]!;
    });
    // The superseded file is only dropped once the new row is safely committed.
    if (previousPath && previousPath !== stored.path) { try { removeStored(previousPath); } catch { /* an orphan file is not worth failing the request over */ } }
    await writeAudit(db, {
      actorId: actor.id, action: 'redemption.letter.generated',
      entityType: 'redemptions', entityId: redemptionId, after: { bytes: buf.length },
    });
    return row;
  } catch (e) {
    // The row never landed, so the file must not survive it.
    try { removeStored(stored.path); } catch { /* best effort */ }
    throw e;
  }
}

/** Mark how this letter is going to be signed, and that it has gone out. */
export async function setMethod(db: Db, actor: AuthUser, redemptionId: number, method: 'esign' | 'physical'): Promise<SigningRow> {
  const signing = await liveSigning(db, redemptionId);
  if (!signing) throw errors.badRequest('Generate the redemption letter first.');
  if (signing.status === 'Signed') throw errors.conflict('This letter is already signed.');
  const row = (await db.query<SigningRow>(
    `UPDATE redemption_signings SET method = $1, status = 'AwaitingSignature', updated_at = now()
      WHERE id = $2 RETURNING ${COLS}`, [method, signing.id])).rows[0]!;
  await writeAudit(db, {
    actorId: actor.id, action: 'redemption.letter.method',
    entityType: 'redemptions', entityId: redemptionId, after: { method },
  });
  return row;
}

/**
 * The scan of the letter the customer signed by hand.
 *
 * Unlike the locker agreement's equivalent this does NOT raise its own
 * approval. The redemption's own approval is where a human looks at this file;
 * raising a second one would put the same document in two queues and let a
 * redemption be approved while its signature sat unchecked in the other.
 */
export async function uploadSignedLetter(
  db: Db, actor: AuthUser, redemptionId: number,
  input: { data_base64: string; filename?: string | null; signed_on: string; note?: string | null },
): Promise<SigningRow> {
  const r = await redemptionFacts(db, redemptionId);

  // TWO CASES REACH HERE, and only the first one gates anything.
  //
  //  1. A redemption still awaiting submission. The scan is the thing that
  //     unlocks approval, and everything below applies.
  //
  //  2. A redemption ALREADY APPROVED (or paid) on or after the cut-off. The
  //     owner asked for the 19 of these to be filed rather than left in a
  //     drawer: "let them be uploaded against the redemption". Nothing is
  //     re-gated by it — the gate only ever runs at submit and at approval,
  //     both long past for these — so this is a record and nothing more. The
  //     alternative was 19 signed letters the system has no idea exist.
  const alreadySettled = r.status !== 'Requested';
  if (alreadySettled) {
    const { consentLetterFrom } = await import('./letter.js');
    const from = await consentLetterFrom(db);
    const eligible = r.type === 'premature'
      && String(r.created_at).slice(0, 10) >= from.slice(0, 10)
      && (r.status === 'Approved' || r.status === 'Paid');
    if (!eligible) {
      throw errors.conflict(
        `This redemption is ${r.status}; a signed letter can only be filed against one awaiting submission, `
        + `or against a premature redemption raised on or after ${from}.`);
    }
  }

  let signing = await liveSigning(db, redemptionId);

  // A settled one never went through the signing flow, so it has no row to
  // attach the scan to. Create it here rather than making staff press
  // "Generate letter" first on a redemption that is already paid.
  if (!signing && alreadySettled) {
    signing = (await db.query<SigningRow>(
      `INSERT INTO redemption_signings (redemption_id, status, method, created_by_user_id)
       VALUES ($1, 'Draft', 'physical', $2) RETURNING ${COLS}`,
      [redemptionId, actor.id])).rows[0]!;
  }
  if (!signing) throw errors.badRequest('Generate the redemption letter first.');
  if (signing.status === 'Signed') throw errors.conflict('A signed letter is already on file for this redemption.');
  if (signing.method === 'esign') {
    throw errors.badRequest('This letter was sent for e-Sign. Switch it to a physical signature before uploading a scanned copy.');
  }

  const signedOn = String(input.signed_on ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(signedOn)) throw errors.badRequest('Enter the date the customer signed, as it appears on the paper.');
  // Read off the paper, not the clock: a future date means somebody mistyped it.
  if (signedOn > new Date().toISOString().slice(0, 10)) throw errors.badRequest('The signing date cannot be in the future.');

  const { validateUpload, MAX_SIGNED_DOC_BYTES } = await import('../../lib/uploads.js');
  const { saveBuffer, removeStored } = await import('../../lib/storage.js');
  const { buffer, mime } = validateUpload(input.data_base64, MAX_SIGNED_DOC_BYTES);
  const filename = String(input.filename ?? '').trim() || `signed-redemption-letter-${redemptionId}.pdf`;
  const stored = saveBuffer('redemption-letters', filename, buffer);

  try {
    const row = await db.withTx(async (tx) => (await tx.query<SigningRow>(
      `UPDATE redemption_signings
          SET status = 'Signed', method = 'physical',
              signed_doc_path = $1, signed_doc_filename = $2, signed_doc_mime = $3,
              signed_on = $4::date, note = $5, signed_at = now(),
              signed_principal = $6, signed_penalty = $7, signed_redemption_date = $8::date,
              uploaded_by_user_id = $9, updated_at = now()
        WHERE id = $10 RETURNING ${COLS}`,
      [stored.path, filename, mime, signedOn, input.note ?? null,
       r.principal, r.penalty, r.redemption_date, actor.id, signing.id])).rows[0]!);
    await writeAudit(db, {
      actorId: actor.id, action: 'redemption.letter.signed.physical',
      entityType: 'redemptions', entityId: redemptionId,
      after: { signed_on: signedOn, bytes: buffer.length, principal: r.principal, penalty: r.penalty },
    });
    return row;
  } catch (e) {
    try { removeStored(stored.path); } catch { /* best effort */ }
    throw e;
  }
}

/**
 * Void the signature because the money or the date moved under it.
 *
 * Takes the caller's transaction so the void and the change that caused it
 * commit together: a penalty waived without its signature voided, or the other
 * way round, is exactly the inconsistency this rule exists to prevent.
 */
export async function supersede(tx: Db, redemptionId: number, reason: string): Promise<boolean> {
  const { rowCount } = await tx.query(
    `UPDATE redemption_signings
        SET status = 'Superseded', superseded_at = now(), superseded_reason = $2, updated_at = now()
      WHERE redemption_id = $1 AND status = ANY($3::text[])`,
    [redemptionId, reason, LIVE as unknown as string[]]);
  return (rowCount ?? 0) > 0;
}

/**
 * The gate. Throws unless a current signed letter is on file.
 *
 * Called from submit-for-approval AND again when the approver approves, since
 * the figures can move in between — that second call is the whole reason the
 * signed figures are frozen on the row.
 */
export async function assertSigned(db: Db, redemptionId: number): Promise<void> {
  const r = await redemptionFacts(db, redemptionId);
  const { consentLetterFrom } = await import('./letter.js');
  if (!needsSignature(r.type, r.source, r.created_at, await consentLetterFrom(db))) return;
  const signing = await liveSigning(db, redemptionId);
  if (!signing || signing.status !== 'Signed') {
    throw errors.conflict(
      'The customer has not signed the redemption request letter yet. '
      + 'Generate the letter, get it signed on paper or through e-Sign, and submit it before this goes for approval.');
  }
  if (isStale(signing, r)) {
    throw errors.conflict(
      'The redemption amount or date changed after the customer signed. '
      + 'The signed letter no longer matches what would be paid, so a fresh letter must be generated and signed.');
  }
}

/**
 * The stage label for the screen, in the owner's own words (2026-11-18).
 *
 * DERIVED, never stored. A duplicated status column drifts the first time one
 * of the two is written without the other, and then nobody can say which is
 * true. Everything here is read from the redemption and its signature.
 */
export function stageLabel(
  r: { status: string; type: string; source?: string | null; created_at?: string | null; approval_request_id: unknown },
  signing: SigningRow | null,
  consentFrom?: string | null,
): string {
  if (r.status === 'Rejected') return 'Rejected';
  if (r.status === 'Cancelled') return 'Cancelled';
  if (r.status === 'Paid') return 'Paid';
  // Approved IS the point at which the redemption processing sheet is released,
  // so the label says what that means rather than repeating the status word.
  if (r.status === 'Approved') return 'Ready for Redemption Processing';
  if (r.approval_request_id) return 'Pending Approval';
  if (!needsSignature(r.type, r.source, r.created_at, consentFrom)) return 'Redemption Initiated';
  if (!signing) return 'Redemption Initiated';
  if (signing.status === 'Signed') return 'Signature Submitted';
  if (signing.status === 'AwaitingSignature') {
    return signing.method === 'esign' ? 'Awaiting E-Sign' : 'Awaiting Physical Signature';
  }
  return 'Redemption Letter Generated';
}

/**
 * The redemption an investment currently has in flight, if any, with its
 * signing state — what the investment screen needs to show the stage and the
 * next action without the page having to know a redemption id.
 *
 * 'Requested' only: an Approved or Paid redemption is finished business and the
 * screen has other places that say so. Returns a null id rather than throwing
 * when there is none, because "no redemption in flight" is the normal case and
 * the screen asks on every render.
 */
export async function liveRedemptionForApplication(db: Db, applicationId: number): Promise<
  { redemption_id: number | null } & Partial<Awaited<ReturnType<typeof signingView>>>
> {
  const { rows } = await db.query<{ id: string }>(
    "SELECT id FROM redemptions WHERE application_id = $1 AND status = 'Requested' ORDER BY id DESC LIMIT 1",
    [applicationId]);
  if (!rows[0]) return { redemption_id: null };
  const id = Number(rows[0].id);
  return { redemption_id: id, ...(await signingView(db, id)) };
}

/**
 * Serve the stored letter, or the scan that came back.
 *
 * Reads the file off disk rather than re-rendering: the whole point of storing
 * it is that the customer signed one particular document. Visibility is checked
 * against the application the way the acknowledgement and application-form PDFs
 * check it — these carry the customer's name, address and bank account.
 */
export async function redemptionLetterFile(
  db: Db, actor: AuthUser, redemptionId: number, which: 'letter' | 'signed',
): Promise<{ buffer: Buffer; mime: string; filename: string }> {
  const { rows } = await db.query<{ application_id: string }>(
    'SELECT application_id FROM redemptions WHERE id = $1', [redemptionId]);
  if (!rows[0]) throw errors.notFound('Redemption not found');
  const { assertApplicationVisible } = await import('../../lib/visibility.js');
  await assertApplicationVisible(db, actor, Number(rows[0].application_id));

  // The live attempt first; falling back to the most recent one means a
  // superseded letter can still be looked at, which is what an auditor asking
  // "what did they actually sign in October?" needs.
  const signing = await liveSigning(db, redemptionId)
    ?? (await db.query<SigningRow>(
      `SELECT ${COLS} FROM redemption_signings WHERE redemption_id = $1 ORDER BY id DESC LIMIT 1`,
      [redemptionId])).rows[0] ?? null;

  const path = which === 'signed' ? signing?.signed_doc_path : signing?.letter_pdf_path;
  if (!path) {
    if (which === 'signed') throw errors.notFound('No signed copy has been uploaded for this redemption yet.');

    // NOTHING STORED, SO RENDER IT NOW — this is the download button for the
    // redemptions already raised on or after the cut-off (owner 2026-11-20:
    // "for the old ones just get me a download button"). Twenty-two of them —
    // nineteen from 13 November, three more once the owner moved the cut-off
    // back to 1 November on 2026-11-21 — are already Approved and several
    // already paid, so they never went through
    // the signing flow and have no stored letter. They still want the document
    // on paper, and refusing because no signing row exists would make the
    // button useless on exactly the rows it was asked for.
    //
    // Rendered fresh rather than stored: nothing here gates anything, so there
    // is no signature to pin a particular file to.
    const r = (await db.query<{ type: string; created_at: string }>(
      'SELECT type, created_at FROM redemptions WHERE id = $1', [redemptionId])).rows[0]!;
    const { consentLetterFrom, redemptionLetterPdf } = await import('./letter.js');
    const from = await consentLetterFrom(db);
    if (r.type !== 'premature' || String(r.created_at).slice(0, 10) < from.slice(0, 10)) {
      throw errors.notFound(
        `A consent letter applies to a premature redemption raised on or after ${from}; this one is outside that.`);
    }
    return {
      buffer: await redemptionLetterPdf(db, redemptionId),
      mime: 'application/pdf',
      filename: `consent-for-premature-redemption-${redemptionId}.pdf`,
    };
  }
  if (!signing) throw errors.notFound('No redemption letter has been generated yet.');
  const { readStored } = await import('../../lib/storage.js');
  const buffer = readStored(path);
  if (!buffer) throw errors.notFound('The stored file is missing.');
  const { serveHeaders } = await import('../../lib/uploads.js');
  const fallback = which === 'signed'
    ? `signed-redemption-letter-${redemptionId}.pdf`
    : `redemption-letter-${redemptionId}.pdf`;
  const h = serveHeaders(which === 'signed' ? signing.signed_doc_mime : 'application/pdf',
    which === 'signed' ? signing.signed_doc_filename : fallback, fallback);
  return { buffer, mime: h.type, filename: which === 'signed' ? (signing.signed_doc_filename || fallback) : fallback };
}

/** Everything the screen needs about where a redemption's letter stands. */
export async function signingView(db: Db, redemptionId: number): Promise<{
  stage: string;
  needs_signature: boolean;
  /** The letter may be printed, even where nothing is gated — the 19 already
   *  approved since the cut-off are exactly that case. */
  can_download_letter: boolean;
  signing: SigningRow | null;
  stale: boolean;
  can_submit: boolean;
}> {
  const r = await redemptionFacts(db, redemptionId);
  const signing = await liveSigning(db, redemptionId);
  const stale = signing != null && signing.status === 'Signed' && isStale(signing, r);
  const { consentLetterFrom } = await import('./letter.js');
  const consentFrom = await consentLetterFrom(db);
  const needs = needsSignature(r.type, r.source, r.created_at, consentFrom);
  // The 19 already raised on or after the cut-off are approved and are NOT
  // retrospectively gated — but their letter is still worth having on paper,
  // so the screen is told it can be downloaded even where nothing is gated.
  const onOrAfterCutOff = String(r.created_at ?? '').slice(0, 10) >= String(consentFrom).slice(0, 10);
  return {
    stage: stageLabel(r, signing, consentFrom),
    needs_signature: needs,
    can_download_letter: r.type === 'premature' && onOrAfterCutOff,
    signing,
    stale,
    can_submit: r.status === 'Requested' && !r.approval_request_id
      && (!needs || (signing?.status === 'Signed' && !stale)),
  };
}
