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
  return db.withTx(async (tx) => {
    const sess = (await tx.query<{ id: string; application_id: string; status: string }>(
      'SELECT id, application_id, status FROM digio_signing_sessions WHERE digio_request_id = $1', [digioRequestId])).rows[0];
    if (!sess) { console.warn(`[digio] webhook for unknown request_id=${digioRequestId} — ignored`); return { ok: false }; }
    if (sess.status === 'signed') return { ok: true, applicationId: Number(sess.application_id) }; // idempotent
    await tx.query(
      `UPDATE digio_signing_sessions SET status='signed', signed_at=COALESCE($2::timestamptz, now()), signed_document_url=$3, webhook_payload=$4::jsonb, updated_at=now() WHERE id=$1`,
      [sess.id, opts.signedAt ?? null, opts.signedDocumentUrl ?? null, JSON.stringify(opts.payload ?? {})]);
    // eSign is off the critical path — just stamp esigned_at if not already set.
    await tx.query('UPDATE applications SET esigned_at = COALESCE(esigned_at, now()) WHERE id = $1', [sess.application_id]);
    // Generate + store the Bond certificate right after eSign (owner spec).
    // Defensive — a PDF hiccup must not fail the signing webhook.
    try {
      const { bondCertificatePdf } = await import('../../modules/reports/forms/bond.js');
      const { saveBuffer } = await import('../../lib/storage.js');
      const pdf = await bondCertificatePdf(tx, Number(sess.application_id));
      const { path } = saveBuffer('bonds', `bond-${sess.application_id}.pdf`, pdf);
      await tx.query('UPDATE applications SET bond_pdf_path = $1, bond_generated_at = now() WHERE id = $2', [path, sess.application_id]);
    } catch (e) {
      console.warn(`[documents] bond generation failed for app ${sess.application_id}: ${(e as Error).message}`);
    }
    await writeAudit(tx, { actorId: null, action: 'esign.complete', entityType: 'applications', entityId: Number(sess.application_id), after: { digioRequestId } });
    return { ok: true, applicationId: Number(sess.application_id) };
  });
}

/** Poll outstanding sessions against Digio (real mode only). Cron-gated. */
export async function pollOutstanding(db: Db): Promise<{ checked: number; signed: number }> {
  if (!digioConfigured()) return { checked: 0, signed: 0 };
  const { rows } = await db.query<{ digio_request_id: string }>(
    "SELECT digio_request_id FROM digio_signing_sessions WHERE status = 'requested' AND digio_request_id IS NOT NULL LIMIT 50");
  let signed = 0;
  for (const r of rows) {
    const status = await fetchStatus(r.digio_request_id).catch(() => null);
    if (isSignedStatus(status)) { await completeSigning(db, r.digio_request_id, {}); signed++; }
  }
  return { checked: rows.length, signed };
}
