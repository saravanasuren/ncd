/**
 * Locker authorised users (owner 2026-08-22). A locker holder can authorise
 * another named person (name / PAN / Aadhaar / phone) to operate the locker.
 * The person is NOT authorised until the holder e-signs a consent letter
 * (Digio, NCD's own account) — so a row is born `consent_pending` and only
 * flips to `active` when the signature completes (via the shared Digio
 * webhook/poller — see completeSigning's branch on document_type).
 *
 * NCD-only for now: LockerHub has no authorised-user endpoint (a CR is raised
 * separately). Keyed on the LockerHub application id, like pledges/cheques.
 */
import type { Db } from '../../db/types.js';
import type { AuthUser } from '../../lib/authUser.js';
import { errors } from '../../lib/errors.js';
import { writeAudit } from '../../lib/audit.js';
import * as lh from '../../integrations/lockerhub/client.js';
import { createSignRequest, digioConfigured } from '../../integrations/digio/index.js';
import { authorisedUserConsentPdf } from '../reports/forms/locker-authorisation-letter.js';

const DOC_TYPE = 'locker_authorised_user_consent';

export interface AuthorisedUserRow {
  id: number; name: string; pan: string | null; aadhaar: string | null; phone: string | null;
  status: string; consent_sign_url: string | null; consent_signed_at: string | null;
  consent_signed: boolean; created_at: string | null;
  lockerhub_synced: boolean; lockerhub_error: string | null;
}

const shape = (r: Record<string, unknown>): AuthorisedUserRow => ({
  id: Number(r.id), name: r.name as string,
  pan: (r.pan as string) ?? null, aadhaar: (r.aadhaar as string) ?? null, phone: (r.phone as string) ?? null,
  status: r.status as string,
  consent_sign_url: (r.consent_sign_url as string) ?? null,
  consent_signed_at: (r.consent_signed_at as string) ?? null,
  consent_signed: r.status === 'active',
  created_at: (r.created_at as string) ?? null,
  lockerhub_synced: r.lockerhub_synced_at != null,
  lockerhub_error: (r.lockerhub_error as string) ?? null,
});

/** Last 4 digits of an Aadhaar — the only form LockerHub accepts (Aadhaar Act). */
const aadhaarLast4 = (a: unknown): string | undefined => {
  const d = String(a ?? '').replace(/\D/g, '');
  return d.length >= 4 ? d.slice(-4) : undefined;
};

/** Authorised users on a locker — active first, then those awaiting consent. */
export async function listAuthorisedUsers(db: Db, lockerhubApplicationId: string): Promise<AuthorisedUserRow[]> {
  const { rows } = await db.query<Record<string, unknown>>(
    `SELECT id, name, pan, aadhaar, phone, status, consent_sign_url, consent_signed_at, created_at,
            lockerhub_synced_at, lockerhub_error
       FROM locker_authorised_users
      WHERE lockerhub_application_id = $1 AND status <> 'revoked'
      ORDER BY (status = 'active') DESC, id DESC`, [lockerhubApplicationId]);
  return rows.map(shape);
}

/**
 * Push an active authorised user to LockerHub (A22). Best-effort and idempotent
 * (upsert on ncd_ref) — never throws to the caller; a failure is stored and
 * stays retryable. Only pushes once consent is signed (status 'active'), and
 * only the LAST 4 of the Aadhaar ever leaves NCD.
 */
export async function syncAuthorisedUserToLockerHub(db: Db, id: number): Promise<{ synced: boolean; error?: string; skipped?: string }> {
  const r = (await db.query<Record<string, unknown>>(
    `SELECT au.*, u.full_name AS creator_name, ro.name AS creator_role
       FROM locker_authorised_users au
       LEFT JOIN users u ON u.id = au.created_by_user_id
       LEFT JOIN roles ro ON ro.id = u.role_id
      WHERE au.id = $1`, [id])).rows[0];
  if (!r) return { synced: false, skipped: 'not found' };
  if (r.status !== 'active') return { synced: false, skipped: 'consent not signed yet' };
  if (!lh.lockerHubConfigured()) return { synced: false, skipped: 'LockerHub not configured' };
  const staff = { id: (r.created_by_user_id as string) ?? 0, name: (r.creator_name as string) ?? 'NCD', staff_role: (r.creator_role as string) ?? undefined };
  try {
    await lh.pushAuthorisedUser(staff, String(r.lockerhub_application_id), {
      name: String(r.name), phone: (r.phone as string) ?? undefined, pan: (r.pan as string) ?? undefined,
      aadhaar_last4: aadhaarLast4(r.aadhaar), consent_ref: (r.consent_digio_request_id as string) ?? undefined,
      ncd_ref: `au_${id}`,
    });
    await db.query('UPDATE locker_authorised_users SET lockerhub_synced_at = now(), lockerhub_error = NULL, updated_at = now() WHERE id = $1', [id]);
    return { synced: true };
  } catch (e) {
    const msg = (e as Error).message || 'LockerHub did not accept the authorised user';
    await db.query('UPDATE locker_authorised_users SET lockerhub_error = $2, updated_at = now() WHERE id = $1', [id, msg]);
    return { synced: false, error: msg };
  }
}

interface AddInput { lockerhub_application_id: string; customer_id?: number | null; name: string; pan?: string | null; aadhaar?: string | null; phone?: string | null; }

/**
 * Add an authorised user and start the holder's consent e-Sign. Returns the
 * signing URL (a stub URL when Digio is unconfigured, so the flow is testable).
 */
export async function addAuthorisedUser(db: Db, actor: AuthUser, input: AddInput): Promise<{ id: number; sign_url: string | null; stub: boolean }> {
  const appId = String(input.lockerhub_application_id || '').trim();
  const name = String(input.name || '').trim();
  if (!appId) throw errors.badRequest('lockerhub_application_id is required');
  if (name.length < 2) throw errors.badRequest("The authorised user's name is required");

  // The holder giving consent — theirs is the signature and the contact Digio
  // notifies. Resolve from the passed customer, else the locker's own pledge.
  let owner = input.customer_id
    ? (await db.query<Record<string, unknown>>('SELECT id, full_name, customer_code, pan, phone, email FROM customers WHERE id = $1', [input.customer_id])).rows[0] ?? null
    : null;
  if (!owner) {
    owner = (await db.query<Record<string, unknown>>(
      `SELECT c.id, c.full_name, c.customer_code, c.pan, c.phone, c.email
         FROM locker_deposit_links l JOIN applications a ON a.id = l.application_id JOIN customers c ON c.id = a.customer_id
        WHERE l.lockerhub_application_id = $1 ORDER BY l.id DESC LIMIT 1`, [appId])).rows[0] ?? null;
  }
  if (!owner) throw errors.badRequest('Could not identify the locker holder to sign the consent — open this from the customer, or pass customer_id.');

  // Best-effort locker context for the letter (never fatal — a LockerHub outage
  // must not block recording the authorised user).
  let locker: { locker_no?: string | null; branch?: string | null; size?: string | null } = {};
  if (lh.lockerHubConfigured()) {
    try {
      const app = await lh.getLockerApplication(appId) as Record<string, any>;
      locker.size = app?.locker_size ?? app?.allotment?.size ?? null;
      locker.locker_no = app?.allotment?.locker_number ?? app?.locker_no ?? null;
      let branchName = app?.branch_name ?? null;
      if (!branchName && app?.branch_id) {
        try { const { branches } = await lh.branches(); branchName = branches.find((b) => String(b.id) === String(app.branch_id))?.name ?? null; } catch { /* cosmetic */ }
      }
      locker.branch = branchName;
    } catch { /* letter still renders with the ids we have */ }
  }

  return db.withTx(async (tx) => {
    const ins = (await tx.query<{ id: string }>(
      `INSERT INTO locker_authorised_users (lockerhub_application_id, customer_id, name, pan, aadhaar, phone, created_by_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [appId, owner!.id, name, input.pan ?? null, input.aadhaar ?? null, input.phone ?? null, actor.id])).rows[0]!;
    const id = Number(ins.id);

    const { buffer, signatureBox, signaturePage } = await authorisedUserConsentPdf(tx, {
      owner: { full_name: String(owner!.full_name), customer_code: owner!.customer_code as string, pan: owner!.pan as string, phone: owner!.phone as string },
      authorised: { name, pan: input.pan ?? null, aadhaar: input.aadhaar ?? null, phone: input.phone ?? null },
      locker: { ...locker, lockerhub_application_id: appId },
    });
    const req = await createSignRequest({
      signerEmail: (owner!.email as string) ?? undefined, signerPhone: (owner!.phone as string) ?? undefined,
      signerName: String(owner!.full_name), document: { fileName: `locker-consent-${id}.pdf`, contentBase64: buffer.toString('base64') },
      signature: { box: signatureBox, page: signaturePage },
    });
    await tx.query(
      `INSERT INTO digio_signing_sessions (application_id, document_type, locker_authorised_user_id, digio_request_id, sign_url, signer_email, signer_phone, status, created_by_user_id)
       VALUES (NULL,$1,$2,$3,$4,$5,$6,$7,$8)`,
      [DOC_TYPE, id, req.digioRequestId, req.signUrl, (owner!.email as string) ?? null, (owner!.phone as string) ?? null, req.status, actor.id]);
    await tx.query('UPDATE locker_authorised_users SET consent_digio_request_id = $1, consent_sign_url = $2, updated_at = now() WHERE id = $3',
      [req.digioRequestId, req.signUrl, id]);
    await writeAudit(tx, {
      actorId: actor.id, action: 'locker.authorised_user.add', entityType: 'locker_authorised_users', entityId: id,
      after: { application: appId, name, has_pan: !!input.pan, has_aadhaar: !!input.aadhaar, digio_request_id: req.digioRequestId },
    });
    return { id, sign_url: req.signUrl, stub: !digioConfigured() };
  });
}

/** Flip an authorised user to active once the holder's consent is signed. Called
 *  from the Digio completion path (webhook/poller) for DOC_TYPE sessions. */
export async function completeAuthorisedUserConsent(
  db: Db, authorisedUserId: number, opts: { signedAt?: string; signedPdfPath?: string | null } = {},
): Promise<void> {
  await db.query(
    `UPDATE locker_authorised_users
        SET status = CASE WHEN status = 'revoked' THEN status ELSE 'active' END,
            consent_signed_at = COALESCE(consent_signed_at, $2::timestamptz, now()),
            consent_pdf_path = COALESCE($3, consent_pdf_path),
            updated_at = now()
      WHERE id = $1`, [authorisedUserId, opts.signedAt ?? null, opts.signedPdfPath ?? null]);
  await writeAudit(db, {
    actorId: null, action: 'locker.authorised_user.consent-signed',
    entityType: 'locker_authorised_users', entityId: authorisedUserId, after: {},
  });
  // Now that consent is signed (and the locker is allotted — the UI only lets you
  // add post-allotment), push to LockerHub. Best-effort: a failure is stored and
  // retryable, and must never undo the signed status.
  await syncAuthorisedUserToLockerHub(db, authorisedUserId).catch(() => undefined);
}

/** Withdraw an authorised user (owner can revoke in writing). */
export async function revokeAuthorisedUser(db: Db, actor: AuthUser, id: number, reason: string): Promise<{ ok: true }> {
  if (!reason?.trim() || reason.trim().length < 3) throw errors.badRequest('A reason is required');
  const row = (await db.query('SELECT id FROM locker_authorised_users WHERE id = $1', [id])).rows[0];
  if (!row) throw errors.notFound('Authorised user not found');
  await db.query("UPDATE locker_authorised_users SET status = 'revoked', revoked_at = now(), revoked_reason = $2, updated_at = now() WHERE id = $1", [id, reason.trim()]);
  await writeAudit(db, { actorId: actor.id, action: 'locker.authorised_user.revoke', entityType: 'locker_authorised_users', entityId: id, after: { reason: reason.trim() } });
  return { ok: true };
}
