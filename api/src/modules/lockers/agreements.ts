/**
 * How a locker agreement was signed (owner 2026-09-03).
 *
 * NCD stored nothing about the locker agreement before this: LockerHub builds
 * it, uploads it to Digio, owns the status and keeps the signed PDF, and our
 * routes were pure passthrough. The owner wants a second path — a printed,
 * PRE-FILLED agreement the customer signs by hand and staff scan back in — and
 * there was nowhere to record that.
 *
 * This module is the record for BOTH paths. The e-Sign flow is unchanged in
 * behaviour; it simply now leaves a row behind saying it was an e-Sign, so a
 * question like "which of our lockers were signed on paper?" has an answer.
 *
 * The methods differ ONLY in how the signature is captured. Same agreement,
 * same content, same obligations — one is signed in Digio, the other with a pen.
 *
 * PR 1 of 4: the record layer and the method choice. Generating the printable
 * form, uploading the scan and the maker-checker approval land in PRs 2-3, and
 * telling LockerHub about a paper signature in PR 4 (it needs an endpoint they
 * do not have yet).
 */
import type { Db } from '../../db/types.js';
import type { AuthUser } from '../../lib/authUser.js';
import { errors } from '../../lib/errors.js';
import { writeAudit } from '../../lib/audit.js';
import { registerOnFinalApprove, registerOnReject } from '../approvals/service.js';

export type SignMethod = 'esign' | 'physical';

/** Statuses a signing may still move on from — at most one of these per locker. */
// CustomerSigned + AwaitingCEO are the two-party e-sign's mid-states: the
// customer has signed and the CEO's counter-sign is pending (owner 2026-09-10).
export const LIVE_STATUSES = ['Draft', 'AwaitingSignature', 'CustomerSigned', 'AwaitingCEO', 'PendingApproval', 'Signed'] as const;

const COLS = `id, lockerhub_application_id, customer_id, method, status,
  form_pdf_path, form_generated_at, signed_doc_path, signed_doc_filename,
  signed_doc_mime, signed_doc_pages, signed_on, signed_at_branch, witness_name,
  note, esign_reference, approval_request_id, lockerhub_synced_at, lockerhub_error,
  created_by_user_id, uploaded_by_user_id, approved_by_user_id, signed_at, created_at`;

export interface SigningView {
  id: number;
  lockerhub_application_id: string;
  method: SignMethod;
  status: string;
  /** True once the agreement is signed by EITHER route — what most screens want. */
  is_signed: boolean;
  /** Ready to show: "e-Signed", "Physically signed", "Scan awaiting approval". */
  label: string;
  signed_on: string | null;
  signed_at: string | null;
  signed_at_branch: string | null;
  witness_name: string | null;
  has_form_pdf: boolean;
  has_signed_doc: boolean;
  signed_doc_pages: number | null;
  esign_reference: string | null;
  /** While the CUSTOMER's e-Sign is still out (status AwaitingSignature), the
   *  Digio link to hand them on screen. Null once they have signed, or on the
   *  physical path. Read from digio_signing_sessions so it survives a reload. */
  customer_sign_url: string | null;
  lockerhub_synced: boolean;
  lockerhub_error: string | null;
  created_at: string | null;
}

/**
 * The one place the method turns into words. Every screen reads this rather
 * than composing its own, so a locker can never show a bare "Signed" that hides
 * which way it happened — the whole point of the exercise.
 */
export function signingLabel(method: string, status: string): string {
  if (status === 'Signed') return method === 'physical' ? 'Physically signed' : 'e-Signed';
  if (status === 'PendingApproval') return 'Scan awaiting approval';
  if (status === 'AwaitingSignature') return method === 'physical' ? 'Awaiting signature on paper' : 'Awaiting e-signature';
  if (status === 'CustomerSigned') return 'Awaiting authorised signatory';
  // Without this AwaitingCEO fell through to "e-Sign started", which reads
  // like nobody has signed when in fact everyone but the company has.
  if (status === 'AwaitingCEO') return 'Sent to authorised signatory';
  if (status === 'Rejected') return 'Scan rejected';
  if (status === 'Cancelled') return 'Cancelled';
  return method === 'physical' ? 'Physical signing started' : 'e-Sign started';
}

const shape = (r: Record<string, unknown>): SigningView => ({
  id: Number(r.id),
  lockerhub_application_id: r.lockerhub_application_id as string,
  method: r.method as SignMethod,
  status: r.status as string,
  is_signed: r.status === 'Signed',
  label: signingLabel(String(r.method), String(r.status)),
  signed_on: r.signed_on ? String(r.signed_on).slice(0, 10) : null,
  signed_at: (r.signed_at as string) ?? null,
  signed_at_branch: (r.signed_at_branch as string) ?? null,
  witness_name: (r.witness_name as string) ?? null,
  has_form_pdf: r.form_pdf_path != null,
  has_signed_doc: r.signed_doc_path != null,
  signed_doc_pages: r.signed_doc_pages == null ? null : Number(r.signed_doc_pages),
  esign_reference: (r.esign_reference as string) ?? null,
  customer_sign_url: (r.customer_sign_url as string) ?? null,
  lockerhub_synced: r.lockerhub_synced_at != null,
  lockerhub_error: (r.lockerhub_error as string) ?? null,
  created_at: (r.created_at as string) ?? null,
});

/** The live signing for a locker application, or null when none has started. */
export async function getSigning(db: Db, applicationId: string): Promise<SigningView | null> {
  const r = (await db.query<Record<string, unknown>>(
    `SELECT ${COLS},
       -- 'requested' only: a superseded, expired or declined request's link is
       -- dead, and handing it to a customer wastes their trip to the branch.
       (SELECT d.sign_url FROM digio_signing_sessions d
          WHERE d.locker_agreement_signing_id = s.id
            AND d.document_type = 'locker_agreement' AND d.status = 'requested'
          ORDER BY d.id DESC LIMIT 1) AS customer_sign_url
       FROM locker_agreement_signings s
      WHERE s.lockerhub_application_id = $1 AND s.status = ANY($2::text[])
      ORDER BY s.id DESC LIMIT 1`, [applicationId, [...LIVE_STATUSES]])).rows[0];
  return r ? shape(r) : null;
}

/** Everything ever raised for this locker, newest first — including the
 *  rejected and cancelled attempts, which are the audit trail. */
export async function listSignings(db: Db, applicationId: string): Promise<SigningView[]> {
  const { rows } = await db.query<Record<string, unknown>>(
    `SELECT ${COLS} FROM locker_agreement_signings
      WHERE lockerhub_application_id = $1 ORDER BY id DESC`, [applicationId]);
  return rows.map(shape);
}

export interface AwaitingCeoRow {
  application_id: string; customer_name: string | null; customer_code: string | null;
  signed_at: string | null;
  /** 'CustomerSigned' = nobody has sent it yet; 'AwaitingCEO' = a link is out. */
  status: string;
  /** Digio says the signatory HAS signed, but we never got the file back. The
   *  row needs "Fetch signed copy", not another signing link. */
  final_copy_pending: boolean;
}
/** Agreements the customer has e-signed and that await the CEO's counter-sign —
 *  the "Locker agreements" queue (owner 2026-09-10). Oldest first.
 *
 *  AwaitingCEO belongs here just as much as CustomerSigned. Listing only the
 *  latter meant that sending the link REMOVED the agreement from the only
 *  screen that could act on it: a signatory who never opened the link, or a
 *  counter-sign whose file failed to download, left the locker with no way
 *  forward from any screen (initiateCeoEsign refused every status but
 *  CustomerSigned, and the live-status index blocks starting a fresh signing). */
export async function listAwaitingCeo(db: Db): Promise<AwaitingCeoRow[]> {
  const { rows } = await db.query<Record<string, unknown>>(
    `SELECT s.lockerhub_application_id, s.signed_at, s.status, c.full_name, c.customer_code,
            EXISTS (SELECT 1 FROM digio_signing_sessions ds
                     WHERE ds.locker_agreement_signing_id = s.id
                       AND ds.document_type = 'locker_agreement_ceo'
                       AND ds.status = 'signed') AS final_copy_pending
       FROM locker_agreement_signings s
       LEFT JOIN customers c ON c.id = s.customer_id
      WHERE s.status IN ('CustomerSigned', 'AwaitingCEO')
      ORDER BY s.signed_at ASC NULLS LAST, s.id ASC`);
  return rows.map((r) => ({
    application_id: r.lockerhub_application_id as string,
    customer_name: (r.full_name as string) ?? null,
    customer_code: (r.customer_code as string) ?? null,
    signed_at: r.signed_at ? String(r.signed_at) : null,
    status: String(r.status),
    final_copy_pending: r.status === 'AwaitingCEO' && Boolean(r.final_copy_pending),
  }));
}

/**
 * Choose how this agreement gets signed.
 *
 * Re-choosing is allowed while nothing has been committed to — a Draft or an
 * unsigned e-Sign can still become a physical signing and back. It is refused
 * once a scan is uploaded or a signature has landed, because at that point the
 * two paths would disagree about which document governs.
 *
 * The row is created if there is none, so this is also "start signing".
 */
export async function chooseMethod(
  db: Db, actor: AuthUser,
  input: { lockerhub_application_id: string; method: SignMethod; customer_id?: number | null },
): Promise<SigningView> {
  const appId = String(input.lockerhub_application_id ?? '').trim();
  if (!appId) throw errors.badRequest('lockerhub_application_id is required');
  if (input.method !== 'esign' && input.method !== 'physical') {
    throw errors.badRequest('Choose how the agreement will be signed — e-Sign or physical signature.');
  }

  return db.withTx(async (tx) => {
    const cur = (await tx.query<Record<string, unknown>>(
      `SELECT ${COLS} FROM locker_agreement_signings
        WHERE lockerhub_application_id = $1 AND status = ANY($2::text[])
        ORDER BY id DESC LIMIT 1 FOR UPDATE`, [appId, [...LIVE_STATUSES]])).rows[0];

    if (cur) {
      if (cur.method === input.method) return shape(cur);
      if (cur.status === 'Signed') {
        throw errors.conflict('This agreement is already signed — the signing method cannot be changed.');
      }
      if (cur.status === 'PendingApproval') {
        throw errors.conflict('A signed scan is already waiting for approval. Cancel it first to switch to e-Sign.');
      }
      const next = (await tx.query<Record<string, unknown>>(
        `UPDATE locker_agreement_signings
            SET method = $1, status = 'Draft',
                form_pdf_path = NULL, form_generated_at = NULL,
                esign_reference = NULL, updated_at = now()
          WHERE id = $2 RETURNING ${COLS}`, [input.method, cur.id])).rows[0]!;
      await writeAudit(tx, {
        actorId: actor.id, action: 'locker.agreement.method',
        entityType: 'locker_agreement_signings', entityId: Number(cur.id),
        before: { method: cur.method, status: cur.status }, after: { method: input.method },
      });
      return shape(next);
    }

    const created = (await tx.query<Record<string, unknown>>(
      `INSERT INTO locker_agreement_signings
         (lockerhub_application_id, customer_id, method, status, created_by_user_id)
       VALUES ($1, $2, $3, 'Draft', $4) RETURNING ${COLS}`,
      [appId, input.customer_id ?? null, input.method, actor.id])).rows[0]!;
    await writeAudit(tx, {
      actorId: actor.id, action: 'locker.agreement.method',
      entityType: 'locker_agreement_signings', entityId: Number(created.id),
      after: { application: appId, method: input.method },
    });
    return shape(created);
  });
}

/**
 * Record that an e-Sign was sent. Called by the existing initiate route AFTER
 * LockerHub accepts it, so a failed initiate leaves no row claiming otherwise.
 *
 * Deliberately forgiving: it never throws. A bookkeeping row must not be able
 * to break the signing flow that has worked since July — if this cannot be
 * written, the e-Sign has still gone out and LockerHub remains the source of
 * truth for it.
 */
export async function recordEsignSent(
  db: Db, actor: AuthUser, applicationId: string, reference?: string | null, customerId?: number | null,
): Promise<void> {
  try {
    await db.withTx(async (tx) => {
      const cur = (await tx.query<{ id: string; status: string; method: string }>(
        `SELECT id, status, method FROM locker_agreement_signings
          WHERE lockerhub_application_id = $1 AND status = ANY($2::text[])
          ORDER BY id DESC LIMIT 1 FOR UPDATE`, [applicationId, [...LIVE_STATUSES]])).rows[0];

      // A physical signing already waiting on a checker, or a signed agreement,
      // is left exactly as it is: a stray initiate must not overwrite it.
      if (cur && (cur.status === 'Signed' || cur.status === 'PendingApproval')) return;

      if (cur) {
        await tx.query(
          `UPDATE locker_agreement_signings
              SET method = 'esign', status = 'AwaitingSignature',
                  esign_reference = COALESCE($1, esign_reference), updated_at = now()
            WHERE id = $2`, [reference ?? null, cur.id]);
      } else {
        await tx.query(
          `INSERT INTO locker_agreement_signings
             (lockerhub_application_id, customer_id, method, status, esign_reference, created_by_user_id)
           VALUES ($1, $2, 'esign', 'AwaitingSignature', $3, $4)`,
          [applicationId, customerId ?? null, reference ?? null, actor.id]);
      }
    });
  } catch {
    /* bookkeeping only — never break the e-Sign */
  }
}

/**
 * Reconcile our row against what LockerHub says, and stamp it signed when they
 * report a signature. They own the e-Sign, so their answer wins for an e-Sign
 * row; a PHYSICAL row is never touched by this — their status would still read
 * `esign_pending` for one, and letting that overwrite an approved paper
 * signature would undo a checker's decision.
 *
 * Returns the row as it now stands (or null when the locker has no signing).
 */
export async function syncFromEsignStatus(
  db: Db, applicationId: string, status: Record<string, unknown> | null,
): Promise<SigningView | null> {
  const cur = await getSigning(db, applicationId);
  const state = String(status?.status ?? '').toLowerCase();
  const theySay = state === 'signed' || state === 'completed';
  const ref = (status?.esign_id ?? status?.id) as string | undefined;

  if (!theySay) return cur;
  // They report a signature but we have no row: an e-Sign started before this
  // table existed, or from outside NCD. Record it rather than showing nothing.
  if (!cur) {
    await db.query(
      `INSERT INTO locker_agreement_signings
         (lockerhub_application_id, method, status, esign_reference, signed_at)
       VALUES ($1, 'esign', 'Signed', $2, now())`, [applicationId, ref ?? null]);
    return getSigning(db, applicationId);
  }
  if (cur.method !== 'esign' || cur.status === 'Signed') return cur;

  await db.query(
    `UPDATE locker_agreement_signings
        SET status = 'Signed', signed_at = COALESCE(signed_at, now()),
            esign_reference = COALESCE($1, esign_reference), updated_at = now()
      WHERE id = $2`, [ref ?? null, cur.id]);
  return getSigning(db, applicationId);
}

/**
 * The pre-filled agreement, ready to print (owner 2026-09-03: "it should not be
 * a blank application form, everything should be pre filled").
 *
 * Assembles what NCD knows about the customer with what LockerHub knows about
 * the locker, so the customer is handed a finished document and writes one
 * thing on it: their signature.
 *
 * Generating it also moves the signing to AwaitingSignature and stamps when —
 * "printed on the 3rd, still not back on the 20th" is a question the branch
 * needs to be able to ask.
 */
/**
 * Assemble the agreement (customer on file + LockerHub's locker facts + the
 * top-share nominee) and render our own copy — the one the CEO's counter-sign
 * and the filled rent both live on. Shared by the print form and the e-sign, so
 * the printed and the e-signed agreement are byte-for-byte the same document.
 * Returns the full render result (buffer + both signature boxes) plus the
 * customer row and the locker number for the caller's bookkeeping.
 */
/**
 * The agreement's own number — DIF0001, allocated once and kept.
 *
 * Printed on the Schedule in place of the LockerHub application id, which the
 * owner saw as "mu57ytsh53ldvkg" and rightly called junk on a document a
 * customer signs (2026-09-17).
 *
 * ALLOCATED ONCE, THEN STORED. The agreement is re-rendered at every signing
 * stage — hirer 1, each joint hirer, then the authorised signatory — and each
 * stage signs the file the stage before produced. A number derived per render
 * could differ between them, so a counter-signed contract would carry a
 * different number from the copy the customer signed. Reading it back is
 * therefore the first thing this does, and the common path writes nothing.
 *
 * The bare-row insert covers an application LockerHub knows about that our own
 * index has not caught up with: the number belongs to the locker, so it must not
 * depend on the sync having run.
 */
export async function ensureAgreementNo(db: Db, applicationId: string): Promise<string | null> {
  const read = async (q: Db) => (await q.query<{ agreement_no: string | null }>(
    'SELECT agreement_no FROM locker_applications WHERE lockerhub_application_id = $1',
    [applicationId])).rows[0]?.agreement_no ?? null;

  const existing = await read(db);
  if (existing) return existing;

  try {
    return await db.withTx(async (tx) => {
      await tx.query(
        `INSERT INTO locker_applications (lockerhub_application_id) VALUES ($1)
         ON CONFLICT (lockerhub_application_id) DO NOTHING`, [applicationId]);
      // Lock the row before deciding, so two renders racing on the same locker
      // cannot both see NULL and mint two numbers.
      const locked = (await tx.query<{ agreement_no: string | null }>(
        'SELECT agreement_no FROM locker_applications WHERE lockerhub_application_id = $1 FOR UPDATE',
        [applicationId])).rows[0];
      if (locked?.agreement_no) return locked.agreement_no;

      const { nextCode } = await import('../../lib/sequences.js');
      const code = await nextCode(tx, 'locker_agreement');
      await tx.query(
        'UPDATE locker_applications SET agreement_no = $1, updated_at = now() WHERE lockerhub_application_id = $2',
        [code, applicationId]);
      return code;
    });
  } catch (e) {
    // A number already taken means another render won the race; read theirs.
    // Anything else must not stop an agreement printing — it falls back to the
    // LockerHub id, which is what printed before this existed.
    const again = await read(db).catch(() => null);
    if (again) return again;
    console.warn(`[locker-agreement] could not allocate an agreement number for ${applicationId}: ${(e as Error).message}`);
    return null;
  }
}

async function renderLockerAgreement(
  db: Db, applicationId: string, signingId: number,
): Promise<{ result: import('../reports/forms/locker-agreement.js').LockerAgreementResult; customer: Record<string, unknown>; lockerNo: string | null }> {
  const [{ lockerAgreementPdf }, lh] = await Promise.all([
    import('../reports/forms/locker-agreement.js'),
    import('../../integrations/lockerhub/client.js'),
  ]);

  // LockerHub owns the locker: number, size, branch, lease and the amounts.
  // Best-effort — an outage prints the form with those lines ruled for the
  // branch to complete by hand rather than refusing to print at all.
  let app: Record<string, unknown> | null = null;
  if (lh.lockerHubConfigured()) {
    app = await lh.getLockerApplication(applicationId).catch(() => null) as Record<string, unknown> | null;
    if (app && !app.branch_name && app.branch_id) {
      const bl = await lh.branches().catch(() => null);
      const b = bl?.branches.find((x) => String(x.id) === String(app!.branch_id));
      if (b) app.branch_name = b.name;
    }
  }
  const allot = (app?.allotment ?? {}) as Record<string, unknown>;
  const legs = (app?.legs ?? {}) as Record<string, { amount?: number }>;

  const CUSTOMER_COLS = `id, full_name, customer_code, pan, phone, email, dob, father_name, occupation,
                         address, city, district, state, pincode`;
  let customer: Record<string, unknown> | null = null;
  const cid = (await db.query<{ customer_id: string | null }>(
    'SELECT customer_id FROM locker_agreement_signings WHERE id = $1', [signingId])).rows[0]?.customer_id;
  if (cid) {
    customer = (await db.query<Record<string, unknown>>(
      `SELECT ${CUSTOMER_COLS} FROM customers WHERE id = $1`, [Number(cid)])).rows[0] ?? null;
  }
  // OUR OWN index next. locker_applications carries the customer for every
  // application NCD creates, and it is the only source that does not depend on
  // LockerHub being reachable — the agreement is our document now, so it should
  // not fail to render because their API is down.
  if (!customer) {
    const idx = (await db.query<{ customer_id: string | null }>(
      'SELECT customer_id FROM locker_applications WHERE lockerhub_application_id = $1', [applicationId])).rows[0];
    if (idx?.customer_id) {
      customer = (await db.query<Record<string, unknown>>(
        `SELECT ${CUSTOMER_COLS} FROM customers WHERE id = $1`, [Number(idx.customer_id)])).rows[0] ?? null;
    }
  }
  if (!customer && app?.phone) {
    const digits = String(app.phone).replace(/\D/g, '').slice(-10);
    if (digits.length === 10) {
      customer = (await db.query<Record<string, unknown>>(
        `SELECT ${CUSTOMER_COLS} FROM customers
          WHERE right(regexp_replace(phone, '\\D', '', 'g'), 10) = $1 LIMIT 1`, [digits])).rows[0] ?? null;
    }
  }
  if (!customer) {
    throw errors.badRequest('No NCD customer is linked to this locker application, so the agreement cannot be filled in. Link the customer first.');
  }

  const nom = (await db.query<Record<string, unknown>>(
    `SELECT full_name, relationship, phone FROM nominees
      WHERE customer_id = $1 ORDER BY share_pct DESC NULLS LAST, id LIMIT 1`,
    [Number(customer.id)])).rows[0] ?? null;

  // Joint hirers (holders 2 and 3) the branch added at enrolment. They belong on
  // the very document the customer e-signs — without this they were saved but
  // printed blank (owner 2026-09-10: "the joint applicant I added is missing").
  const { listHirers } = await import('./hirers.js');
  const jointHirers = await listHirers(db, applicationId).catch(() => []);

  // The authorised signatory is named on the Schedule's "For the Company" block
  // because they e-sign it (owner 2026-09-14). Same setting the CEO stage uses,
  // so the printed name and the Digio signer can never disagree.
  const { getSettingsMap } = await import('../settings/service.js');
  const signatoryName = String(
    (await getSettingsMap(db))['lockers.agreement_signatory_name'] ?? 'Saravana Suren');

  const agreementNo = await ensureAgreementNo(db, applicationId);

  const result = await lockerAgreementPdf(db, {
    signatoryName,
    customer: customer as never,
    hirers: jointHirers.map((h) => ({
      position: h.position,
      full_name: h.full_name,
      pan: h.pan ?? null,
      address: h.address ?? null,
      email: h.email ?? null,
      phone: h.phone ?? null,
    })),
    locker: {
      lockerhub_application_id: applicationId,
      agreement_no: agreementNo,
      locker_number: (allot.locker_number as string) ?? null,
      size: (app?.locker_size as string) ?? null,
      branch: (app?.branch_name as string) ?? null,
      lease_start: (app?.lease_start as string) ?? null,
      lease_end: (app?.lease_expires_on as string) ?? (app?.lease_end as string) ?? null,
      rent_amount: legs.rent?.amount ?? null,
      deposit_amount: legs.deposit?.amount ?? null,
    },
    nominee: nom ? {
      name: nom.full_name as string,
      relationship: (nom.relationship as string) ?? null,
      phone: (nom.phone as string) ?? null,
    } : null,
  });
  return { result, customer, lockerNo: (allot.locker_number as string) ?? null };
}

export async function generateAgreementForm(
  db: Db, actor: AuthUser, applicationId: string,
): Promise<{ buffer: Buffer; filename: string }> {
  const signing = await getSigning(db, applicationId);
  if (!signing) throw errors.badRequest('Choose how this agreement will be signed first.');
  if (signing.method !== 'physical') {
    throw errors.badRequest('This agreement is set to e-Sign. Switch it to a physical signature to print a copy for signing.');
  }
  if (signing.status === 'Signed') throw errors.conflict('This agreement is already signed.');

  const { result, lockerNo } = await renderLockerAgreement(db, applicationId, signing.id);
  const buffer = result.buffer;

  await db.query(
    `UPDATE locker_agreement_signings
        SET status = CASE WHEN status = 'Draft' THEN 'AwaitingSignature' ELSE status END,
            form_generated_at = now(), updated_at = now()
      WHERE id = $1`, [signing.id]);
  await writeAudit(db, {
    actorId: actor.id, action: 'locker.agreement.form',
    entityType: 'locker_agreement_signings', entityId: signing.id,
    after: { application: applicationId, locker: lockerNo },
  });

  return { buffer, filename: `locker-agreement-${applicationId}.pdf` };
}

/**
 * Start the CUSTOMER's e-Sign on OUR OWN copy of the agreement (owner 2026-09-10),
 * via OUR Digio — so the document that carries the filled rent is the one signed,
 * and the company's authorised signatory (the CEO) can counter-sign the SAME
 * document later (stage 4). The signature is placed on the "Signature of Hirer(s)"
 * line reported by the renderer.
 *
 * Mirrors the investment e-Sign: a digio_signing_sessions row (document_type
 * 'locker_agreement') carries it, so the existing poller + completeSigning drive
 * it to done. Inert-but-recorded in stub mode (no Digio creds).
 */
/**
 * The signers of this agreement, in signing order: hirer 1 (the customer) then
 * each joint hirer, with the signature box the renderer gave each of them.
 *
 * Exported so the SCREEN can draw one row per signer with its own button and
 * its own state, rather than inferring who is next from a single status.
 */
export async function agreementSigners(db: Db, applicationId: string): Promise<Array<{
  position: number; name: string; phone: string | null; email: string | null;
  status: 'pending' | 'sent' | 'signed' | 'failed'; sign_url: string | null; can_send: boolean; blocked_reason: string | null;
}>> {
  const signing = await getSigning(db, applicationId);
  const { result, customer } = await renderLockerAgreement(db, applicationId, signing?.id ?? 0);
  const { listHirers } = await import('./hirers.js');
  const joint = new Map((await listHirers(db, applicationId)).map((h) => [Number(h.position), h]));

  const sessions = signing
    ? (await db.query<{ signer_position: number; status: string; sign_url: string | null }>(
        // Oldest first, so the map below keeps each hirer's LATEST attempt: a
        // re-send after a failure must not be shadowed by the failure it
        // replaced. Unordered, which session won was down to the planner.
        // 'failed' rows ARE read here — that is the state the screen has to
        // show — and only superseded ones are dropped.
        `SELECT signer_position, status, sign_url FROM digio_signing_sessions
          WHERE locker_agreement_signing_id = $1 AND signer_position IS NOT NULL AND status <> 'cancelled'
          ORDER BY id ASC`,
        [signing.id])).rows
    : [];
  const byPos = new Map(sessions.map((r) => [Number(r.signer_position), r]));

  const out: Array<{ position: number; name: string; phone: string | null; email: string | null;
    status: 'pending' | 'sent' | 'signed' | 'failed'; sign_url: string | null; can_send: boolean; blocked_reason: string | null }> = [];
  let previousSigned = true;   // nobody comes before hirer 1
  for (const h of result.hirers) {
    const jh = h.position === 1 ? null : joint.get(h.position);
    const name = h.position === 1 ? String(customer.full_name ?? h.name) : (jh?.full_name ?? h.name);
    const phone = h.position === 1 ? ((customer.phone as string) ?? null) : (jh?.phone ?? null);
    const email = h.position === 1 ? ((customer.email as string) ?? null) : (jh?.email ?? null);
    const sess = byPos.get(h.position);
    // 'failed' is a fourth state, not a flavour of 'sent': the link expired or
    // the hirer declined, so nobody is coming and the row needs sending again.
    // Collapsing it into 'sent' left the screen saying "waiting" for ever.
    const status: 'pending' | 'sent' | 'signed' | 'failed' =
      sess?.status === 'signed' ? 'signed'
      : sess?.status === 'failed' ? 'failed'
      : sess ? 'sent' : 'pending';

    // In ORDER (owner 2026-09-14). Each stage signs the file the stage before
    // it produced, so sending out of order would put a signature on a document
    // that is about to be replaced. The ordering gate below is what enforces
    // that; being 'sent' is NOT a reason to refuse.
    //
    // A hirer who abandons the Aadhaar OTP leaves the Digio document open, so
    // their session stays 'sent' for ever and this row could never be sent
    // again — one abandoned attempt and the agreement was stuck (the same trap
    // the owner hit on investments, 2026-09-17: "unless a esign becomes
    // successful i should have attempts to make signing"). So: anything but a
    // real signature may be sent again.
    const sendable = status !== 'signed';
    const blocked_reason =
      !sendable ? null
      : !previousSigned ? `Hirer ${h.position - 1} has to sign first.`
      : !String(phone ?? '').trim() ? 'No phone number — the signing link cannot reach them.'
      : null;
    out.push({ position: h.position, name, phone, email, status,
      // A dead link is not worth opening.
      sign_url: status === 'failed' ? null : (sess?.sign_url ?? null),
      can_send: sendable && !blocked_reason, blocked_reason });
    previousSigned = status === 'signed';
  }
  return out;
}

/**
 * Send ONE hirer their e-Sign, on the document every signature so far is
 * already on (owner 2026-09-14: "make sure to use one single applicaition for
 * all esigning. i dont need fresh one for all different hirer").
 *
 * Hirer 1 signs the freshly rendered agreement. Every hirer after them signs
 * the FILE THE PREVIOUS STAGE PRODUCED, so signatures accumulate on one
 * document instead of each person signing their own copy of it. The CEO stage
 * has always worked this way; this generalises it.
 *
 * Refuses out of order, because a signature placed on a document that is then
 * replaced by the next stage is a signature on nothing.
 */
export async function initiateHirerEsign(
  db: Db, actor: AuthUser, applicationId: string, position: number, customerId?: number | null,
): Promise<{ sign_url: string | null; digio_request_id: string; stub: boolean; position: number }> {
  let signing = await getSigning(db, applicationId);
  if (!signing) {
    signing = await chooseMethod(db, actor, { lockerhub_application_id: applicationId, method: 'esign', customer_id: customerId ?? null });
  }
  if (signing.status === 'Signed') throw errors.conflict('This agreement is already fully signed.');

  const signers = await agreementSigners(db, applicationId);
  const me = signers.find((x) => x.position === position);
  if (!me) throw errors.badRequest(`There is no hirer ${position} on this agreement.`);
  if (me.status === 'signed') throw errors.conflict(`Hirer ${position} (${me.name}) has already signed.`);
  if (me.blocked_reason) throw errors.badRequest(me.blocked_reason);

  const { result } = await renderLockerAgreement(db, applicationId, signing.id);
  const box = result.hirers.find((h) => h.position === position);
  const first = box?.placements[0];
  if (!box || !first) throw errors.badRequest(`No signature box for hirer ${position} on this agreement.`);

  // Hirer 1 signs the fresh render; everyone after signs what the last stage
  // produced. Falling back to the fresh render would silently drop the earlier
  // signatures, so a missing file is refused rather than papered over.
  let document: { fileName: string; contentBase64: string };
  if (position === 1) {
    document = { fileName: `locker-agreement-${applicationId}.pdf`, contentBase64: result.buffer.toString('base64') };
  } else {
    const prior = await getSignedDocument(db, applicationId);
    // WHOSE signatures that file carries. Existence is not enough: a failed
    // download mid-chain leaves an EARLIER copy in place, and signing that
    // would drop the signature in between without anything saying so.
    const carries = (await db.query<{ signed_doc_position: number | null }>(
      'SELECT signed_doc_position FROM locker_agreement_signings WHERE id = $1', [signing.id])).rows[0]?.signed_doc_position;
    if (!prior || Number(carries ?? 0) !== position - 1) {
      throw errors.badRequest(
        `The copy signed by hirer ${position - 1} is not available yet — it arrives a moment after they sign. Try again shortly.`);
    }
    document = { fileName: `locker-agreement-${applicationId}.pdf`, contentBase64: prior.buffer.toString('base64') };
  }

  const { createSignRequest, digioConfigured } = await import('../../integrations/digio/index.js');
  const req = await createSignRequest({
    signerName: me.name, signerPhone: me.phone ?? undefined, signerEmail: me.email ?? undefined,
    reason: 'Locker hire agreement',
    document,
    // Hirer 1 signs the Schedule's witness table AND the closing line; hirers 2
    // and 3 sign their table column only. One request covers every box.
    signature: { box: first.box, page: first.page, also: box.placements.slice(1) },
  });

  await db.withTx(async (tx) => {
    // Supersede any earlier open link for THIS hirer only — another hirer's
    // live link must survive, which a signing-wide cancel would have killed.
    await tx.query(
      `UPDATE digio_signing_sessions SET status = 'cancelled', updated_at = now()
        WHERE locker_agreement_signing_id = $1 AND signer_position = $2
          AND status = 'requested' AND digio_request_id <> $3`,
      [signing!.id, position, req.digioRequestId]);
    await tx.query(
      `INSERT INTO digio_signing_sessions
         (application_id, digio_request_id, sign_url, signer_email, signer_phone, status,
          created_by_user_id, document_type, locker_agreement_signing_id, signer_position)
       VALUES (NULL, $1, $2, $3, $4, $5, $6, 'locker_agreement', $7, $8)
       ON CONFLICT (digio_request_id) DO UPDATE SET sign_url = EXCLUDED.sign_url, status = EXCLUDED.status, updated_at = now()`,
      [req.digioRequestId, req.signUrl, me.email ?? null, me.phone ?? null, req.status, actor.id, signing!.id, position]);
    await tx.query(
      `UPDATE locker_agreement_signings
          SET status = CASE WHEN status = 'Draft' THEN 'AwaitingSignature' ELSE status END,
              -- The LATEST request for this agreement, not the first: a
              -- re-send has to point at the link that now works, and a test
              -- pins that. Per-signer detail lives on the sessions.
              esign_reference = $2, updated_at = now()
        WHERE id = $1`, [signing!.id, req.digioRequestId]);
    await writeAudit(tx, {
      actorId: actor.id, action: 'locker.agreement.esign-sent',
      entityType: 'locker_agreement_signings', entityId: signing!.id,
      after: { application: applicationId, position, signer: me.name },
    });
  });

  return { sign_url: req.signUrl, digio_request_id: req.digioRequestId, stub: !digioConfigured(), position };
}

/** Hirer 1 — kept so existing callers and the "Send agreement for signing"
 *  button continue to mean "start the chain". */
export async function initiateCustomerEsign(
  db: Db, actor: AuthUser, applicationId: string, customerId?: number | null,
): Promise<{ sign_url: string | null; digio_request_id: string; stub: boolean }> {
  const r = await initiateHirerEsign(db, actor, applicationId, 1, customerId);
  return { sign_url: r.sign_url, digio_request_id: r.digio_request_id, stub: r.stub };
}

/**
 * Start the CEO's counter-sign on the CUSTOMER-signed copy (owner 2026-09-10,
 * stage 4). The company's authorised signatory (Settings) e-signs the SAME
 * document the customer signed, placed at the "Authorised Signatory" box. Only
 * a locker whose customer has already signed (status 'CustomerSigned') is
 * eligible — this is the queue's action, done later, off the enrolment path.
 */
export async function initiateCeoEsign(
  db: Db, actor: AuthUser, applicationId: string,
): Promise<{ sign_url: string | null; digio_request_id: string; stub: boolean }> {
  const signing = await getSigning(db, applicationId);
  if (!signing) throw errors.badRequest('No agreement signing found for this locker.');
  if (signing.status === 'Signed') throw errors.conflict('This agreement is already fully signed.');
  // AwaitingCEO is allowed: it means a link is already out, and re-sending is
  // the ONLY way back from a signatory who never opened it. Refusing it made
  // the status a dead end — the agreement was gone from the queue, could not be
  // re-sent, and could not be replaced either (the live-status index).
  if (signing.status !== 'CustomerSigned' && signing.status !== 'AwaitingCEO') {
    throw errors.badRequest('The customer has not e-signed this agreement yet — the authorised signatory signs after them.');
  }
  const signed = await getSignedDocument(db, applicationId);
  if (!signed) throw errors.badRequest('The customer-signed copy is not available yet — try again shortly.');

  // WHOSE signatures that copy carries. On a joint agreement the last hirer's
  // signed file can fail to download while the row still moves to
  // CustomerSigned, and existence alone would then hand the signatory a
  // document one holder short — countersigned, and unenforceable against them.
  // The hirer-to-hirer hop already checks this watermark; the CEO hop did not.
  // Single-hirer agreements are exempt: there is no chain to fall behind, and
  // rows predating the watermark column carry no position.
  const hirerCount = 1 + Number((await db.query<{ n: string }>(
    'SELECT count(*) AS n FROM locker_application_hirers WHERE lockerhub_application_id = $1',
    [applicationId])).rows[0]?.n ?? 0);
  if (hirerCount > 1) {
    const carries = Number((await db.query<{ signed_doc_position: number | null }>(
      'SELECT signed_doc_position FROM locker_agreement_signings WHERE id = $1',
      [signing.id])).rows[0]?.signed_doc_position ?? 0);
    if (carries < hirerCount) {
      throw errors.badRequest(
        `The copy on file carries ${carries || 'no'} of ${hirerCount} hirers' signatures — use "Fetch signed copy" before the authorised signatory signs it.`);
    }
  }

  // Re-render for the signatory box only (deterministic; same layout as signed).
  const { result } = await renderLockerAgreement(db, applicationId, signing.id);
  const { getSettingsMap } = await import('../settings/service.js');
  const s = await getSettingsMap(db);
  const ceoName = String(s['lockers.agreement_signatory_name'] ?? 'Saravana Suren');
  const ceoPhone = String(s['lockers.agreement_signatory_phone'] ?? '').replace(/\D/g, '') || undefined;
  const signatoryAt = result.signatoryPlacements[0];
  if (!signatoryAt) throw errors.badRequest('No authorised-signatory box on this agreement.');

  const { createSignRequest, digioConfigured } = await import('../../integrations/digio/index.js');
  const req = await createSignRequest({
    signerName: ceoName,
    signerPhone: ceoPhone,
    reason: 'Locker hire agreement (company signatory)',
    document: { fileName: `locker-agreement-${applicationId}.pdf`, contentBase64: signed.buffer.toString('base64') },
    // The signatory signs the Schedule's "For the Company" block and the
    // closing "Authorised Signatory" space (owner 2026-09-14).
    signature: {
      box: signatoryAt.box, page: signatoryAt.page,
      also: result.signatoryPlacements.slice(1),
    },
  });

  await db.withTx(async (tx) => {
    // A re-send kills the earlier signatory link so the poller stops chasing it
    // and only one live counter-sign request exists at a time.
    await tx.query(
      `UPDATE digio_signing_sessions SET status = 'cancelled', updated_at = now()
        WHERE locker_agreement_signing_id = $1 AND document_type = 'locker_agreement_ceo'
          AND status = 'requested' AND digio_request_id <> $2`,
      [signing.id, req.digioRequestId]);
    await tx.query(
      `INSERT INTO digio_signing_sessions
         (application_id, digio_request_id, sign_url, signer_phone, status, created_by_user_id, document_type, locker_agreement_signing_id)
       VALUES (NULL, $1, $2, $3, $4, $5, 'locker_agreement_ceo', $6)
       ON CONFLICT (digio_request_id) DO UPDATE SET sign_url = EXCLUDED.sign_url, status = EXCLUDED.status, updated_at = now()`,
      [req.digioRequestId, req.signUrl, ceoPhone ?? null, req.status, actor.id, signing.id]);
    await tx.query(
      `UPDATE locker_agreement_signings
          SET status = 'AwaitingCEO', esign_reference = $1, updated_at = now()
        WHERE id = $2`, [req.digioRequestId, signing.id]);
    await writeAudit(tx, {
      actorId: actor.id, action: 'locker.agreement.esign.ceo-initiate',
      entityType: 'locker_agreement_signings', entityId: signing.id,
      after: { digio_request_id: req.digioRequestId, signatory: ceoName },
    });
  });

  return { sign_url: req.signUrl, digio_request_id: req.digioRequestId, stub: !digioConfigured() };
}

/**
 * Chase a signed copy Digio holds and we do not.
 *
 * Both hand-offs store the file best-effort: the signature is recorded from the
 * webhook, the DOWNLOAD can still fail. Because the session is 'signed' by
 * then, completeSigning treats any later webhook as a duplicate and the file is
 * never fetched again — so this is the only route back for an agreement stuck
 * mid-chain or counter-signed without its final copy. It records nothing new;
 * it only fetches what Digio already says was signed.
 */
export async function fetchSignedCopy(
  db: Db, actor: AuthUser, applicationId: string,
): Promise<{ ok: boolean; status: string }> {
  const signing = await getSigning(db, applicationId);
  if (!signing) throw errors.notFound('No agreement signing found for this locker.');
  const { refetchSignedCopy } = await import('../../integrations/digio/service.js');
  const r = await refetchSignedCopy(db, signing.id);
  if (!r.kind) throw errors.badRequest('Nobody has e-signed this agreement yet — there is no copy to fetch.');
  if (!r.ok) throw errors.upstream(502, 'Digio did not return the signed copy. Try again in a few minutes.');
  const after = await getSigning(db, applicationId);
  await writeAudit(db, {
    actorId: actor.id, action: 'locker.agreement.signed-copy-refetched',
    entityType: 'locker_agreement_signings', entityId: signing.id,
    after: { application: applicationId, kind: r.kind, status: after?.status ?? null },
  });
  return { ok: true, status: after?.status ?? signing.status };
}

/**
 * Ask Digio where this locker agreement's signatures actually stand.
 *
 * The NCD side has had this since the manual "Mark eSigned" button was removed;
 * lockers never did, because checkOneApplication looks sessions up by
 * application_id and a locker agreement's are NULL there. Meanwhile the poller
 * stops chasing after POLL_WINDOW_DAYS, so a customer who signed on day eight
 * had no route into the system at all.
 *
 * Like its NCD twin it can only confirm what Digio reports — there is no path
 * here that marks an unsigned document signed.
 */
export async function recheckEsign(
  db: Db, actor: AuthUser, applicationId: string,
): Promise<{ ok: boolean; signed: number; failed: number }> {
  const signing = await getSigning(db, applicationId);
  if (!signing) throw errors.notFound('No agreement signing found for this locker.');
  const { checkOneLockerSigning } = await import('../../integrations/digio/service.js');
  const r = await checkOneLockerSigning(db, signing.id);
  if (!r.ok) {
    if (r.reason === 'not-configured') throw errors.badRequest('e-Sign is not configured, so there is nothing to ask Digio about.');
    throw errors.badRequest('No signing link is outstanding on this agreement.');
  }
  if (r.signed || r.failed) {
    await writeAudit(db, {
      actorId: actor.id, action: 'locker.agreement.esign-rechecked',
      entityType: 'locker_agreement_signings', entityId: signing.id,
      after: { application: applicationId, signed: r.signed, failed: r.failed, statuses: r.statuses },
    });
  }
  return { ok: true, signed: r.signed, failed: r.failed };
}

/**
 * Count pages in a PDF. Someone uploading page 1 of a four-page agreement is the
 * commonest scanning mistake there is, and it approves clean unless the count is
 * on the checker's card. Best-effort: an image scan has no page count, and an
 * unreadable PDF returns null rather than refusing an otherwise good document.
 */
function pdfPageCount(buf: Buffer, mime: string): number | null {
  if (mime !== 'application/pdf') return null;
  const raw = buf.toString('latin1');
  const byType = (raw.match(/\/Type\s*\/Page[^s]/g) ?? []).length;
  if (byType > 0) return byType;
  const m = raw.match(/\/Count\s+(\d+)/);
  return m ? Number(m[1]) : null;
}

/**
 * The signed scan comes back (owner 2026-09-03).
 *
 * This does NOT mark the agreement signed. Digio's signature is cryptographic
 * evidence that a named person signed; a scan is evidence that somebody
 * uploaded a file. The second claim is exactly what a checker is for, so the
 * upload raises an approval and the agreement stays unsigned until then.
 */
export async function uploadSignedAgreement(
  db: Db, actor: AuthUser,
  input: {
    lockerhub_application_id: string;
    data_base64: string;
    filename?: string | null;
    signed_on: string;
    signed_at_branch?: string | null;
    witness_name?: string | null;
    note?: string | null;
  },
): Promise<SigningView> {
  const appId = String(input.lockerhub_application_id ?? '').trim();
  const signing = await getSigning(db, appId);
  if (!signing) throw errors.badRequest('Choose how this agreement will be signed first.');
  if (signing.method !== 'physical') {
    throw errors.badRequest('This agreement is set to e-Sign. Switch it to a physical signature before uploading a signed copy.');
  }
  if (signing.status === 'Signed') throw errors.conflict('This agreement is already signed.');
  if (signing.status === 'PendingApproval') throw errors.conflict('A signed copy is already waiting for approval.');

  const signedOn = String(input.signed_on ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(signedOn)) throw errors.badRequest('Enter the date the customer signed, as it appears on the paper.');
  // The date is on the document, not the clock: it is read off the paper, so a
  // future one means somebody mistyped it.
  if (signedOn > new Date().toISOString().slice(0, 10)) throw errors.badRequest('The signing date cannot be in the future.');

  const { validateUpload, MAX_SIGNED_DOC_BYTES } = await import('../../lib/uploads.js');
  const { saveBuffer, removeStored } = await import('../../lib/storage.js');
  const { buffer, mime } = validateUpload(input.data_base64, MAX_SIGNED_DOC_BYTES);
  const pages = pdfPageCount(buffer, mime);
  const filename = String(input.filename ?? '').trim() || `signed-agreement-${appId}.pdf`;
  const stored = saveBuffer('locker-agreements', filename, buffer);

  try {
    return await db.withTx(async (tx) => {
      const { createApprovalRequest } = await import('../approvals/service.js');
      const req = await createApprovalRequest(tx, {
        type: 'locker_physical_agreement',
        entityType: 'locker_agreement_signings',
        entityId: signing.id,
        makerUserId: actor.id,
        metadata: {
          signing_id: signing.id,
          lockerhub_application_id: appId,
          signed_on: signedOn,
          branch: input.signed_at_branch ?? null,
          witness: input.witness_name ?? null,
          pages,
          filename,
        },
      });
      const row = (await tx.query<Record<string, unknown>>(
        `UPDATE locker_agreement_signings
            SET status = 'PendingApproval', signed_doc_path = $1, signed_doc_filename = $2,
                signed_doc_mime = $3, signed_doc_pages = $4, signed_on = $5::date,
                signed_at_branch = $6, witness_name = $7, note = $8,
                uploaded_by_user_id = $9, approval_request_id = $10, updated_at = now()
          WHERE id = $11 RETURNING ${COLS}`,
        [stored.path, filename, mime, pages, signedOn,
         input.signed_at_branch ?? null, input.witness_name ?? null, input.note ?? null,
         actor.id, req.id, signing.id])).rows[0]!;
      await writeAudit(tx, {
        actorId: actor.id, action: 'locker.agreement.uploaded',
        entityType: 'locker_agreement_signings', entityId: signing.id,
        after: { application: appId, signed_on: signedOn, pages, bytes: buffer.length },
      });
      return shape(row);
    });
  } catch (e) {
    // The row never landed, so the file must not survive it — otherwise every
    // failed upload leaves an orphan nobody will ever find or delete.
    removeStored(stored.path);
    throw e;
  }
}

/** The stored scan. This IS the agreement on file for a physical signing. */
export async function getSignedDocument(
  db: Db, applicationId: string,
): Promise<{ buffer: Buffer; mime: string | null; filename: string | null } | null> {
  const r = (await db.query<Record<string, unknown>>(
    `SELECT signed_doc_path, signed_doc_mime, signed_doc_filename
       FROM locker_agreement_signings
      WHERE lockerhub_application_id = $1 AND signed_doc_path IS NOT NULL
      ORDER BY id DESC LIMIT 1`, [applicationId])).rows[0];
  if (!r?.signed_doc_path) return null;
  const { readStored } = await import('../../lib/storage.js');
  const buffer = readStored(String(r.signed_doc_path));
  if (!buffer) return null;
  return { buffer, mime: (r.signed_doc_mime as string) ?? null, filename: (r.signed_doc_filename as string) ?? null };
}

/**
 * Abandon a signing that has not been approved — a wrong scan, a customer who
 * changed their mind. Cancelled rather than deleted: the attempt is part of the
 * audit trail, and the partial unique index then frees the locker for another.
 */
export async function cancelSigning(db: Db, actor: AuthUser, applicationId: string, reason?: string | null): Promise<void> {
  await db.withTx(async (tx) => {
    const cur = (await tx.query<Record<string, unknown>>(
      `SELECT id, status, approval_request_id FROM locker_agreement_signings
        WHERE lockerhub_application_id = $1 AND status = ANY($2::text[])
        ORDER BY id DESC LIMIT 1 FOR UPDATE`, [applicationId, [...LIVE_STATUSES]])).rows[0];
    if (!cur) throw errors.notFound('No signing to cancel on this locker.');
    if (cur.status === 'Signed') throw errors.conflict('This agreement is signed and cannot be cancelled.');
    if (cur.approval_request_id) {
      await tx.query(
        `UPDATE approval_requests SET status = 'Cancelled', updated_at = now()
          WHERE id = $1 AND status = 'Pending'`, [cur.approval_request_id]);
    }
    await tx.query(
      `UPDATE locker_agreement_signings
          SET status = 'Cancelled', approval_request_id = NULL, note = COALESCE($2, note), updated_at = now()
        WHERE id = $1`, [cur.id, reason ?? null]);
    await writeAudit(tx, {
      actorId: actor.id, action: 'locker.agreement.cancelled',
      entityType: 'locker_agreement_signings', entityId: Number(cur.id),
      before: { status: cur.status }, after: { reason: reason ?? null },
    });
  });
}

// ── Maker-checker ────────────────────────────────────────────────────────
// Approve first, sync second — like the offline payments and the cheque
// register: the approval stands on its own, and a LockerHub outage leaves the
// agreement Signed with the error recorded and retryable, never rolled back.
// Their push needs an endpoint they do not have yet (PR 4); until then the
// record is NCD's alone and lockerhub_synced_at stays null, honestly.
registerOnFinalApprove('locker_physical_agreement', async (tx, req) => {
  const id = req.metadata.signing_id ? Number(req.metadata.signing_id) : (req.entity_id ? Number(req.entity_id) : null);
  if (!id) return;
  const act = (await tx.query<{ approver_user_id: string }>(
    `SELECT approver_user_id FROM approval_actions WHERE approval_request_id = $1 AND action = 'approve'
      ORDER BY id DESC LIMIT 1`, [req.id])).rows[0];
  await tx.query(
    `UPDATE locker_agreement_signings
        SET status = 'Signed', approved_by_user_id = $1, approval_request_id = NULL,
            signed_at = COALESCE(signed_at, now()), updated_at = now()
      WHERE id = $2 AND status = 'PendingApproval' AND approval_request_id = $3`,
    [act?.approver_user_id ?? null, id, req.id]);
});

// A refused scan does NOT cancel the signing: the customer signed on paper, the
// upload was just wrong (a missing page, the wrong document, an illegible
// scan). It goes back to awaiting a signature so staff can upload a better one
// without starting the whole agreement again.
registerOnReject('locker_physical_agreement', async (tx, req) => {
  const id = req.metadata.signing_id ? Number(req.metadata.signing_id) : (req.entity_id ? Number(req.entity_id) : null);
  if (!id) return;
  await tx.query(
    `UPDATE locker_agreement_signings
        SET status = 'AwaitingSignature', approval_request_id = NULL,
            signed_doc_path = NULL, signed_doc_filename = NULL, signed_doc_mime = NULL,
            signed_doc_pages = NULL, updated_at = now()
      WHERE id = $1 AND status = 'PendingApproval' AND approval_request_id = $2`,
    [id, req.id]);
});
