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

export type SignMethod = 'esign' | 'physical';

/** Statuses a signing may still move on from — at most one of these per locker. */
export const LIVE_STATUSES = ['Draft', 'AwaitingSignature', 'PendingApproval', 'Signed'] as const;

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
  lockerhub_synced: r.lockerhub_synced_at != null,
  lockerhub_error: (r.lockerhub_error as string) ?? null,
  created_at: (r.created_at as string) ?? null,
});

/** The live signing for a locker application, or null when none has started. */
export async function getSigning(db: Db, applicationId: string): Promise<SigningView | null> {
  const r = (await db.query<Record<string, unknown>>(
    `SELECT ${COLS} FROM locker_agreement_signings
      WHERE lockerhub_application_id = $1 AND status = ANY($2::text[])
      ORDER BY id DESC LIMIT 1`, [applicationId, [...LIVE_STATUSES]])).rows[0];
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
export async function generateAgreementForm(
  db: Db, actor: AuthUser, applicationId: string,
): Promise<{ buffer: Buffer; filename: string }> {
  const signing = await getSigning(db, applicationId);
  if (!signing) throw errors.badRequest('Choose how this agreement will be signed first.');
  if (signing.method !== 'physical') {
    throw errors.badRequest('This agreement is set to e-Sign. Switch it to a physical signature to print a copy for signing.');
  }
  if (signing.status === 'Signed') throw errors.conflict('This agreement is already signed.');

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

  // The customer: the id on the signing row, else matched on the phone
  // LockerHub holds, which is the key their side is organised around.
  const CUSTOMER_COLS = `id, full_name, customer_code, pan, phone, email, dob, father_name, occupation,
                         address, city, district, state, pincode`;
  let customer: Record<string, unknown> | null = null;
  const cid = (await db.query<{ customer_id: string | null }>(
    'SELECT customer_id FROM locker_agreement_signings WHERE id = $1', [signing.id])).rows[0]?.customer_id;
  if (cid) {
    customer = (await db.query<Record<string, unknown>>(
      `SELECT ${CUSTOMER_COLS} FROM customers WHERE id = $1`, [Number(cid)])).rows[0] ?? null;
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
    // Printing an agreement with no hirer on it would produce a document whose
    // most important field is blank — refuse, and say what to do about it.
    throw errors.badRequest('No NCD customer is linked to this locker application, so the agreement cannot be filled in. Link the customer first.');
  }

  // The largest share is the one that belongs on the agreement when a customer
  // has more than one nominee.
  const nom = (await db.query<Record<string, unknown>>(
    `SELECT full_name, relationship, phone FROM nominees
      WHERE customer_id = $1 ORDER BY share_pct DESC NULLS LAST, id LIMIT 1`,
    [Number(customer.id)])).rows[0] ?? null;

  const buffer = await lockerAgreementPdf(db, {
    customer: customer as never,
    locker: {
      lockerhub_application_id: applicationId,
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

  await db.query(
    `UPDATE locker_agreement_signings
        SET status = CASE WHEN status = 'Draft' THEN 'AwaitingSignature' ELSE status END,
            form_generated_at = now(), updated_at = now()
      WHERE id = $1`, [signing.id]);
  await writeAudit(db, {
    actorId: actor.id, action: 'locker.agreement.form',
    entityType: 'locker_agreement_signings', entityId: signing.id,
    after: { application: applicationId, locker: allot.locker_number ?? null },
  });

  return { buffer, filename: `locker-agreement-${applicationId}.pdf` };
}
