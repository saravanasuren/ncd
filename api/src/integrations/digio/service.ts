/**
 * Digio eSign session lifecycle. eSign is off ncd's critical path — completing
 * a session stamps applications.esigned_at (and records the signed doc URL);
 * it does NOT drive a status transition.
 */
import type { Db } from '../../db/types.js';
import type { AuthUser } from '../../lib/authUser.js';
import { errors } from '../../lib/errors.js';
import { writeAudit } from '../../lib/audit.js';
import { createSignRequest, fetchStatus, isSignedStatus, digioConfigured, type SignaturePlacement } from './index.js';

/** Start a signing session for an application; returns the sign URL. */
export async function initiateSigning(db: Db, actor: AuthUser, applicationId: number): Promise<{ sign_url: string | null; digio_request_id: string; stub: boolean }> {
  const app = (await db.query<{ id: string; customer_id: string }>('SELECT id, customer_id FROM applications WHERE id = $1', [applicationId])).rows[0];
  if (!app) throw errors.notFound('Application not found');
  const c = (await db.query<{ email: string | null; phone: string | null; full_name: string }>('SELECT email, phone, full_name FROM customers WHERE id = $1', [app.customer_id])).rows[0];
  // The application form is the document Digio signs. Generate it here; if it
  // can't be produced, still start the session (eSign is off the critical path)
  // and log the degraded path rather than failing the request.
  let document: { fileName: string; contentBase64: string } | undefined;
  let signature: SignaturePlacement | undefined;
  try {
    const { applicationFormPdf } = await import('../../modules/reports/forms/application-form.js');
    const form = await applicationFormPdf(db, applicationId);
    document = { fileName: `application-${applicationId}.pdf`, contentBase64: form.buffer.toString('base64') };
    if (form.signatureBox) signature = { box: form.signatureBox, page: form.signaturePage };
  } catch (e) {
    console.warn(`[digio] application-form PDF unavailable for app ${applicationId}; initiating without a document: ${(e as Error).message}`);
  }
  const req = await createSignRequest({ signerEmail: c?.email ?? undefined, signerPhone: c?.phone ?? undefined, signerName: c?.full_name, document, signature });
  await db.query(
    `INSERT INTO digio_signing_sessions (application_id, digio_request_id, sign_url, signer_email, signer_phone, status, created_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (digio_request_id) DO UPDATE SET sign_url = EXCLUDED.sign_url, status = EXCLUDED.status, updated_at = now()`,
    [applicationId, req.digioRequestId, req.signUrl, c?.email ?? null, c?.phone ?? null, req.status, actor.id]);
  await writeAudit(db, { actorId: actor.id, action: 'esign.initiate', entityType: 'applications', entityId: applicationId, after: { digio_request_id: req.digioRequestId } });
  return { sign_url: req.signUrl, digio_request_id: req.digioRequestId, stub: !digioConfigured() };
}

/** Mark a session signed (from the webhook or the poller). Idempotent. */
export async function completeSigning(db: Db, digioRequestId: string, opts: { signedAt?: string; signedDocumentUrl?: string; payload?: unknown }): Promise<{ ok: boolean; applicationId?: number }> {
  const result = await db.withTx(async (tx) => {
    const sess = (await tx.query<{ id: string; application_id: string | null; status: string; document_type: string; locker_authorised_user_id: string | null }>(
      'SELECT id, application_id, status, document_type, locker_authorised_user_id FROM digio_signing_sessions WHERE digio_request_id = $1', [digioRequestId])).rows[0];
    if (!sess) { console.warn(`[digio] webhook for unknown request_id=${digioRequestId} — ignored`); return { ok: false, fresh: false }; }
    const authorisedUserId = sess.locker_authorised_user_id ? Number(sess.locker_authorised_user_id) : undefined;
    const applicationId = sess.application_id ? Number(sess.application_id) : undefined;
    if (sess.status === 'signed') return { ok: true, applicationId, authorisedUserId, docType: sess.document_type, fresh: false }; // idempotent
    await tx.query(
      `UPDATE digio_signing_sessions SET status='signed', signed_at=COALESCE($2::timestamptz, now()), signed_document_url=$3, webhook_payload=$4::jsonb, updated_at=now() WHERE id=$1`,
      [sess.id, opts.signedAt ?? null, opts.signedDocumentUrl ?? null, JSON.stringify(opts.payload ?? {})]);
    // A locker authorised-user consent letter — the application/bond logic does
    // NOT apply; the authorised user is flipped to active after the commit.
    if (sess.document_type === 'locker_authorised_user_consent') {
      return { ok: true, authorisedUserId, docType: sess.document_type, fresh: true };
    }
    // eSign is off the critical path — just stamp esigned_at if not already set.
    //
    // signing_method is stamped HERE, where a real Digio signature actually
    // lands, rather than anywhere a person could set it. It is the only place
    // that may write 'esign'; 'physical' is written only by an upload carrying
    // an actual signed document (owner 2026-09-03).
    await tx.query(
      `UPDATE applications
          SET esigned_at = COALESCE(esigned_at, now()),
              signing_method = COALESCE(signing_method, 'esign')
        WHERE id = $1`, [applicationId]);
    // Generate + store the Bond certificate right after eSign (owner spec).
    // Defensive — a PDF hiccup must not fail the signing webhook.
    try {
      const { bondCertificatePdf } = await import('../../modules/reports/forms/bond.js');
      const { saveBuffer } = await import('../../lib/storage.js');
      const pdf = await bondCertificatePdf(tx, Number(applicationId));
      const { path } = saveBuffer('bonds', `bond-${applicationId}.pdf`, pdf);
      await tx.query('UPDATE applications SET bond_pdf_path = $1, bond_generated_at = now() WHERE id = $2', [path, applicationId]);
    } catch (e) {
      console.warn(`[documents] bond generation failed for app ${applicationId}: ${(e as Error).message}`);
    }
    await writeAudit(tx, { actorId: null, action: 'esign.complete', entityType: 'applications', entityId: Number(applicationId), after: { digioRequestId } });
    return { ok: true, applicationId, docType: sess.document_type, fresh: true };
  });

  // Pull the SIGNED copy from Digio and store it — AFTER the transaction commits
  // (external network I/O must never hold a pool connection / row locks open).
  // Best-effort: a failure leaves the signed-PDF path NULL and never undoes the
  // completion.
  if (result.ok && result.fresh && result.docType === 'locker_authorised_user_consent' && result.authorisedUserId) {
    let signedPdfPath: string | null = null;
    try {
      const { downloadSignedDocument } = await import('./index.js');
      const signed = await downloadSignedDocument(digioRequestId);
      if (signed) { const { saveBuffer } = await import('../../lib/storage.js'); signedPdfPath = saveBuffer('locker-consent', `consent-${result.authorisedUserId}.pdf`, signed).path; }
    } catch (e) {
      console.warn(`[digio] consent signed-document download failed for authorised user ${result.authorisedUserId}: ${(e as Error).message}`);
    }
    const { completeAuthorisedUserConsent } = await import('../../modules/lockers/authorisedUsers.js');
    await completeAuthorisedUserConsent(db, result.authorisedUserId, { signedAt: opts.signedAt, signedPdfPath });
  } else if (result.ok && result.fresh && result.applicationId) {
    try {
      const { downloadSignedDocument } = await import('./index.js');
      const signed = await downloadSignedDocument(digioRequestId);
      if (signed) {
        const { saveBuffer } = await import('../../lib/storage.js');
        const { path } = saveBuffer('esigned', `esigned-${result.applicationId}.pdf`, signed);
        await db.query('UPDATE applications SET esigned_pdf_path = $1 WHERE id = $2', [path, result.applicationId]);
      }
    } catch (e) {
      console.warn(`[digio] signed-document download failed for app ${result.applicationId}: ${(e as Error).message}`);
    }
  }
  return { ok: result.ok, applicationId: result.applicationId };
}

/**
 * How long the automatic poller keeps chasing a signature. Exported because the
 * UI has to draw the same line: a request INSIDE this window is "awaiting the
 * customer" and needs no help, one OUTSIDE it is stalled and is the only place a
 * manual re-check earns its keep. Two copies of this number would silently
 * disagree and offer the button at the wrong time.
 */
export const POLL_WINDOW_DAYS = 7;

/** Poll outstanding sessions against Digio (real mode only). Cron-gated. */
export async function pollOutstanding(db: Db): Promise<{ checked: number; signed: number }> {
  if (!digioConfigured()) return { checked: 0, signed: 0 };
  // Only chase RECENT signatures. A customer who never signs leaves the session
  // 'requested' forever — without this cutoff the 15s poller would hit Digio for
  // that abandoned request indefinitely. Newest first so live signings win the
  // batch when several are open.
  const { rows } = await db.query<{ digio_request_id: string }>(
    `SELECT digio_request_id FROM digio_signing_sessions
      WHERE status = 'requested' AND digio_request_id IS NOT NULL
        AND created_at > now() - interval '${POLL_WINDOW_DAYS} days'
      ORDER BY created_at DESC LIMIT 50`);
  let signed = 0;
  for (const r of rows) {
    const status = await fetchStatus(r.digio_request_id).catch(() => null);
    if (isSignedStatus(status)) { await completeSigning(db, r.digio_request_id, {}); signed++; }
  }
  return { checked: rows.length, signed };
}

/**
 * Ask Digio about ONE application's outstanding signature, ignoring the age
 * cutoff above.
 *
 * This is the replacement for the old "Mark eSigned" button. That button
 * recorded a signature because a person said so; this one records it because
 * DIGIO says so, and it can only ever confirm what actually happened — there is
 * no path here that marks an unsigned document signed.
 *
 * It exists only for the stalled case. Inside the poll window the 15-second
 * cron has already asked, seconds ago, so a button would be theatre.
 */
export async function checkOneApplication(db: Db, applicationId: number): Promise<
  { ok: false; reason: 'not-configured' | 'no-session' } | { ok: true; signed: boolean; status: string | null }
> {
  if (!digioConfigured()) return { ok: false, reason: 'not-configured' };
  const row = (await db.query<{ digio_request_id: string }>(
    `SELECT digio_request_id FROM digio_signing_sessions
      WHERE application_id = $1 AND status = 'requested' AND digio_request_id IS NOT NULL
      ORDER BY created_at DESC LIMIT 1`, [applicationId])).rows[0];
  if (!row) return { ok: false, reason: 'no-session' };
  const status = await fetchStatus(row.digio_request_id).catch(() => null);
  if (isSignedStatus(status)) {
    await completeSigning(db, row.digio_request_id, {});
    return { ok: true, signed: true, status };
  }
  return { ok: true, signed: false, status };
}
