/**
 * Customers module (docs/04 §2, docs/03 scoping). Enrolment, list (scoped),
 * 360 detail, bank accounts (penny-drop stub), KYC, submit-for-approval
 * (hands off to the NCD Manager queue), correction + handover workflows.
 */
import type { Db } from '../../db/types.js';
import type { AuthUser } from '../../lib/authUser.js';
import { errors } from '../../lib/errors.js';
import { writeAudit } from '../../lib/audit.js';
import { nextCode } from '../../lib/sequences.js';
import { scopeFor, scopeWhere } from '../../lib/scope.js';
import { getSettingsMap } from '../settings/service.js';
import { OUTSTANDING_APPLICATION_STATUSES } from '@new-wealth/shared';

const OUTSTANDING_SQL_LIST = OUTSTANDING_APPLICATION_STATUSES.map((s) => `'${s}'`).join(',');
import { kycProvider } from '../../integrations/kyc/index.js';
import {
  createApprovalRequest,
  registerOnFinalApprove,
  type ApprovalRow,
} from '../approvals/service.js';

const SCOPE_COLS = {
  userCol: 'c.enrolled_by_user_id',
  agentCol: 'c.enrolled_by_agent_id',
  branchCol: 'c.branch_id',
  selfIdCol: 'c.id',
};

export interface CreateCustomerInput {
  full_name: string;
  pan?: string;
  dob?: string;
  gender?: string;
  phone?: string;
  email?: string;
  address?: string;
  city?: string;
  district?: string;
  state?: string;
  is_nri?: boolean;
  referred_by_text?: string;
  // Enrolment-wizard personal fields (all optional/additive).
  father_name?: string;
  occupation?: string;
  aadhaar_last4?: string;
  aadhaar?: string; // full 12-digit; last4 derived from it
  phone_secondary?: string;
  investor_category?: string;
  ckyc_number?: string;
  tds_applicable?: boolean;
  pincode?: string;
}

export async function createCustomer(db: Db, actor: AuthUser, input: CreateCustomerInput): Promise<{ id: number; customer_code: string }> {
  const settings = await getSettingsMap(db);
  const codeFmt = String(settings['numbering.customer_format'] ?? 'DHN{seq:6}');
  // Full Aadhaar (owner decision 2026-07-21 — printed on the application form)
  // when supplied; last-4 is derived from it, otherwise from aadhaar_last4.
  const aadhaarDigits = input.aadhaar ? String(input.aadhaar).replace(/\D/g, '') : '';
  const aadhaarFull = aadhaarDigits.length === 12 ? aadhaarDigits : null;
  const aadhaar4 = aadhaarFull ? aadhaarFull.slice(-4)
    : input.aadhaar_last4 ? String(input.aadhaar_last4).replace(/\D/g, '').slice(-4) || null : null;
  return db.withTx(async (tx) => {
    if (input.pan) {
      // Repeat customer (owner spec 2026-07-18): an existing PAN is not an
      // error to hide — surface WHO it is so the UI offers a handover request
      // (Admin/CXO/BM approve) and the new investment books on the SAME
      // customer record (→ customer_was_new_at_creation=false → repeat rate).
      const dup = (await tx.query<{ id: string; customer_code: string; full_name: string }>(
        'SELECT id, customer_code, full_name FROM customers WHERE upper(btrim(pan)) = upper(btrim($1))', [input.pan])).rows[0];
      if (dup) {
        throw errors.conflict('A customer with this PAN already exists — request a handover to book their new investment', {
          existing_customer: { id: Number(dup.id), customer_code: dup.customer_code, full_name: dup.full_name },
        });
      }
    }
    const code = await nextCode(tx, 'customer', codeFmt);
    const branchId = actor.branchIds[0] ?? null;
    const { rows } = await tx.query<{ id: string }>(
      // Customer creation no longer needs its own approval (owner 2026-07-21):
      // the customer is live immediately, and the single approval gate is the
      // investment — where the approver reviews the customer profile + the
      // investment together.
      `INSERT INTO customers (customer_code, full_name, pan, dob, gender, phone, email, address, city, district, state, is_nri, referred_by_text,
        father_name, occupation, aadhaar_last4, aadhaar, phone_secondary, investor_category, ckyc_number, tds_applicable, pincode,
        creation_status, enrolled_by_user_id, enrolled_by_agent_id, branch_id, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,'Approved',$23,$24,$25,TRUE) RETURNING id`,
      [code, input.full_name, input.pan ?? null, input.dob ?? null, input.gender ?? null, input.phone ?? null,
       input.email ?? null, input.address ?? null, input.city ?? null, input.district ?? null, input.state ?? null,
       input.is_nri ?? false, input.referred_by_text ?? null,
       input.father_name ?? null, input.occupation ?? null, aadhaar4, aadhaarFull, input.phone_secondary ?? null,
       input.investor_category ?? null, input.ckyc_number ?? null, input.tds_applicable ?? true, input.pincode ?? null,
       actor.id, actor.agentId, branchId]
    );
    const id = Number(rows[0]!.id);
    // Referred-by that matches no known agent/staff code or name → a brand-new
    // agent: create it PendingApproval + open an agent_registration approval
    // (owner: free text "will be created as new agent upon approval").
    const refText = input.referred_by_text?.trim();
    if (refText) {
      const { resolveReferrer, ensurePendingAgentForName } = await import('../agents/service.js');
      const known = await resolveReferrer(tx, refText);
      if (!known) await ensurePendingAgentForName(tx, actor, refText);
    }
    await writeAudit(tx, { actorId: actor.id, action: 'customer.create', entityType: 'customers', entityId: id, after: { code, name: input.full_name } });
    return { id, customer_code: code };
  });
}

export interface CustomerFilters {
  status?: string;
  district?: string;
  q?: string;
  showArchived?: boolean;
}

export async function listCustomers(db: Db, actor: AuthUser, filters: CustomerFilters = {}) {
  const scope = scopeFor(actor);
  const conds: string[] = [];
  const params: unknown[] = [];
  const sc = scopeWhere(scope, SCOPE_COLS, params.length);
  conds.push(sc.sql);
  params.push(...sc.params);
  // A real NCD customer is someone a human enrolled (staff or agent) or who
  // holds ≥1 application. Pure dhanamfin/LockerHub profile syncs with no
  // application are leads, not customers — keep them off this list.
  conds.push(`(c.enrolled_by_user_id IS NOT NULL
    OR c.enrolled_by_agent_id IS NOT NULL
    OR EXISTS (SELECT 1 FROM applications a WHERE a.customer_id = c.id))`);
  // Archived (super-admin soft-deleted) customers are hidden unless a super-admin
  // (customers:delete) explicitly asks to see them.
  const showArchived = filters.showArchived && actor.permissions.includes('customers:delete');
  if (!showArchived) conds.push('c.archived_at IS NULL');
  if (filters.district) { params.push(filters.district); conds.push(`c.district = $${params.length}`); }
  if (filters.q) { params.push(`%${filters.q}%`); conds.push(`(c.full_name ILIKE $${params.length} OR c.customer_code ILIKE $${params.length} OR c.phone ILIKE $${params.length})`); }
  const LIMIT = 2000;
  const base = `FROM customers c WHERE ${conds.join(' AND ')}`;
  const total = Number((await db.query<{ n: number }>(`SELECT count(*)::int AS n ${base}`, params)).rows[0]!.n);
  const { rows } = await db.query(
    `SELECT c.id, c.customer_code, c.full_name, c.phone, c.district, c.kyc_status, c.creation_status, c.is_active, c.archived_at
     ${base} ORDER BY c.created_at DESC LIMIT ${LIMIT}`,
    params
  );
  // total/truncated let the UI warn "showing N of M" instead of silently
  // dropping rows past the cap. rows stays first for back-compat.
  return { rows, total, truncated: total > rows.length };
}

async function assertVisible(db: Db, actor: AuthUser, customerId: number): Promise<void> {
  const scope = scopeFor(actor);
  const sc = scopeWhere(scope, SCOPE_COLS, 1);
  const { rowCount } = await db.query(
    `SELECT 1 FROM customers c WHERE c.id = $1 AND ${sc.sql}`,
    [customerId, ...sc.params]
  );
  if (!rowCount) throw errors.notFound('Customer not found');
}

export async function getCustomerDetail(db: Db, actor: AuthUser, id: number) {
  await assertVisible(db, actor, id);
  const c = (await db.query('SELECT * FROM customers WHERE id = $1', [id])).rows[0];
  const bankAccounts = (await db.query('SELECT * FROM customer_bank_accounts WHERE customer_id = $1 ORDER BY is_active DESC, id', [id])).rows;
  const nominees = (await db.query('SELECT * FROM nominees WHERE customer_id = $1', [id])).rows;
  const jointHolders = (await db.query('SELECT * FROM joint_holders WHERE customer_id = $1', [id])).rows;
  const documents = (await db.query('SELECT id, doc_type, original_filename, origin, uploaded_at FROM customer_documents WHERE customer_id = $1', [id])).rows;
  // The customer's investments — every application with its live outstanding
  // (partial withdrawals reduce it), newest first.
  const applications = (await db.query(
    `SELECT a.id, a.application_no, s.code AS series_code, a.total_amount AS amount,
            -- Outstanding is 0 once the investment has exited (Redeemed/Matured/…);
            -- the COALESCE fallback to total_amount is only for a live app whose
            -- lines were never materialised. Without the status guard a redeemed
            -- app wrongly showed its original amount as outstanding.
            CASE WHEN a.status IN (${OUTSTANDING_SQL_LIST}) THEN COALESCE(bk.live, a.total_amount) ELSE 0 END AS outstanding,
            a.status,
            a.date_money_received, a.allotment_date, a.archived_at,
            -- eSign state per investment, so the customer's list shows at a
            -- glance which applications are signed (and which have a signed
            -- copy on file to open).
            a.esigned_at, (a.esigned_pdf_path IS NOT NULL) AS has_signed_copy
     FROM applications a JOIN series s ON s.id = a.series_id
     LEFT JOIN LATERAL (
       SELECT sum(al.outstanding_amount) FILTER (WHERE al.status = 'Active') AS live
       FROM application_lines al WHERE al.application_id = a.id
     ) bk ON TRUE
     WHERE a.customer_id = $1
     ORDER BY a.date_money_received DESC NULLS LAST, a.id DESC`, [id])).rows;
  return { customer: c, bankAccounts, nominees, jointHolders, documents, applications };
}

export async function addBankAccount(db: Db, actor: AuthUser, customerId: number, input: { account_number: string; ifsc: string; bank_name?: string; branch_name?: string; branch_city?: string; account_type?: string; holder_name?: string; tds_applicable?: boolean }) {
  await assertVisible(db, actor, customerId);
  const pd = await kycProvider().pennyDrop(input.account_number, input.ifsc);
  return db.withTx(async (tx) => {
    const dup = await tx.query('SELECT 1 FROM customer_bank_accounts WHERE customer_id = $1 AND account_number = $2 AND ifsc = $3', [customerId, input.account_number, input.ifsc]);
    if (dup.rowCount) throw errors.conflict('This bank account is already on file');
    const anyActive = await tx.query('SELECT 1 FROM customer_bank_accounts WHERE customer_id = $1 AND is_active = TRUE', [customerId]);
    const makeActive = anyActive.rowCount === 0 && pd.status === 'Verified';
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO customer_bank_accounts (customer_id, account_number, ifsc, bank_name, branch_name, branch_city, account_type, holder_name, penny_drop_status, penny_drop_detail, is_active, verified_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [customerId, input.account_number, input.ifsc, input.bank_name ?? null, input.branch_name ?? null, input.branch_city ?? null,
       input.account_type ?? null, input.holder_name ?? pd.holderName ?? null,
       pd.status, pd.detail, makeActive, pd.status === 'Verified' ? new Date().toISOString() : null]
    );
    // The TDS-on-payout choice is a customer-level fact (matches the old wizard's Bank step).
    if (typeof input.tds_applicable === 'boolean') {
      await tx.query('UPDATE customers SET tds_applicable = $1, updated_at = now() WHERE id = $2', [input.tds_applicable, customerId]);
    }
    // A first (or newly default) account must reach the payout rows that were
    // materialised before it existed — otherwise the bank file pays nobody.
    let moved = 0;
    if (makeActive) {
      const { resnapshotPayeeBank } = await import('../schedule/materialize.js');
      moved = await resnapshotPayeeBank(tx, customerId);
    }
    await writeAudit(tx, { actorId: actor.id, action: 'customer.bank.add', entityType: 'customer_bank_accounts', entityId: Number(rows[0]!.id), after: { customerId, pennyDrop: pd.status, futureRowsRepointed: moved } });
    return { id: Number(rows[0]!.id), pennyDrop: pd };
  });
}

export async function setActiveBank(db: Db, actor: AuthUser, customerId: number, bankId: number) {
  await assertVisible(db, actor, customerId);
  await db.withTx(async (tx) => {
    const chk = await tx.query<{ penny_drop_status: string }>('SELECT penny_drop_status FROM customer_bank_accounts WHERE id = $1 AND customer_id = $2', [bankId, customerId]);
    if (!chk.rows[0]) throw errors.notFound('Bank account not found');
    if (chk.rows[0].penny_drop_status !== 'Verified') throw errors.unprocessable('Cannot activate an unverified account');
    await tx.query('UPDATE customer_bank_accounts SET is_active = FALSE WHERE customer_id = $1', [customerId]);
    await tx.query('UPDATE customer_bank_accounts SET is_active = TRUE WHERE id = $1', [bankId]);
    // Future unpaid payouts follow the new default; paid ones keep their bank.
    const { resnapshotPayeeBank } = await import('../schedule/materialize.js');
    const moved = await resnapshotPayeeBank(tx, customerId);
    await writeAudit(tx, { actorId: actor.id, action: 'customer.bank.set-active', entityType: 'customer_bank_accounts', entityId: bankId, after: { customerId, futureRowsRepointed: moved } });
  });
}

/**
 * Delete a bank account from a customer's file. Super-admin only (routed
 * behind customers:delete, the same gate as customer delete/archive).
 *
 * Refused while anything still points at it:
 *   - an NCD pinned to it (payout_bank_account_id) — unpin or repin first;
 *   - it is the customer's ACTIVE account and unpaid payout rows would be
 *     left with nowhere to go (make another account active first).
 * Paid history is untouched: schedule rows carry their own snapshot of the
 * account they were paid to, so deleting the row loses nothing about the past.
 */
export async function deleteBankAccount(db: Db, actor: AuthUser, customerId: number, bankId: number) {
  await assertVisible(db, actor, customerId);
  return db.withTx(async (tx) => {
    const bank = (await tx.query<Record<string, unknown>>(
      'SELECT id, account_number, ifsc, is_active FROM customer_bank_accounts WHERE id = $1 AND customer_id = $2',
      [bankId, customerId])).rows[0];
    if (!bank) throw errors.notFound('Bank account not found for this customer');

    const pinned = (await tx.query<{ application_no: string }>(
      'SELECT application_no FROM applications WHERE payout_bank_account_id = $1', [bankId])).rows;
    if (pinned.length) {
      throw errors.conflict(
        `This account is the payout account for ${pinned.map((p) => p.application_no).join(', ')} — move those NCDs to another account first`);
    }

    if (bank.is_active === true) {
      const unpaid = await tx.query(
        `SELECT 1 FROM disbursement_schedule ds JOIN applications a ON a.id = ds.application_id
          WHERE a.customer_id = $1 AND ds.status = 'Scheduled' LIMIT 1`, [customerId]);
      if (unpaid.rowCount) {
        throw errors.conflict('This is the active payout account and unpaid payouts point at it — make another account active first');
      }
    }

    await tx.query('DELETE FROM customer_bank_accounts WHERE id = $1', [bankId]);
    await writeAudit(tx, {
      actorId: actor.id, action: 'customer.bank.delete', entityType: 'customer_bank_accounts', entityId: bankId,
      before: { customerId, account_number: bank.account_number, ifsc: bank.ifsc, was_active: bank.is_active },
    });
    return { ok: true };
  });
}

export async function setKyc(db: Db, actor: AuthUser, customerId: number, to: 'Verified' | 'Rejected', reason?: string) {
  await assertVisible(db, actor, customerId);
  await db.withTx(async (tx) => {
    const cur = (await tx.query<{ kyc_status: string }>('SELECT kyc_status FROM customers WHERE id = $1', [customerId])).rows[0];
    await tx.query('UPDATE customers SET kyc_status = $1, updated_at = now() WHERE id = $2', [to, customerId]);
    await writeAudit(tx, { actorId: actor.id, action: 'customer.kyc', entityType: 'customers', entityId: customerId, before: cur, after: { kyc_status: to, reason } });
  });
}

/** Staff finishes the customer and hands off to the NCD Manager queue. */
export async function submitForApproval(db: Db, actor: AuthUser, customerId: number): Promise<ApprovalRow> {
  await assertVisible(db, actor, customerId);
  return db.withTx(async (tx) => {
    const cur = (await tx.query<{ creation_status: string; full_name: string }>('SELECT creation_status, full_name FROM customers WHERE id = $1', [customerId])).rows[0];
    if (!cur) throw errors.notFound('Customer not found');
    if (cur.creation_status !== 'Draft') throw errors.conflict('Customer is not in Draft');
    await tx.query("UPDATE customers SET creation_status = 'PendingApproval', updated_at = now() WHERE id = $1", [customerId]);
    const req = await createApprovalRequest(tx, {
      type: 'customer_creation',
      entityType: 'customers',
      entityId: customerId,
      makerUserId: actor.id,
      metadata: { customerName: cur.full_name },
    });
    await writeAudit(tx, { actorId: actor.id, action: 'customer.submit', entityType: 'customers', entityId: customerId, after: { request_no: req.request_no } });
    return req;
  });
}

/** Register the approval callback that finalises a customer on approval. */
registerOnFinalApprove('customer_creation', async (tx, req) => {
  if (req.entity_id) {
    await tx.query("UPDATE customers SET creation_status = 'Approved', is_active = TRUE, updated_at = now() WHERE id = $1", [Number(req.entity_id)]);
  }
});

// ── Joint holders ─────────────────────────────────────────────────────
export async function setJointHolders(db: Db, actor: AuthUser, customerId: number, holders: Array<{ full_name: string; pan?: string | null; phone?: string | null; relationship?: string | null }>) {
  await assertVisible(db, actor, customerId);
  const settings = await getSettingsMap(db);
  const max = Number(settings['customers.max_joint_holders'] ?? 2);
  if (holders.length > max) throw errors.badRequest(`At most ${max} joint holders allowed`);
  await db.withTx(async (tx) => {
    await tx.query('DELETE FROM joint_holders WHERE customer_id = $1', [customerId]);
    for (const h of holders) {
      await tx.query('INSERT INTO joint_holders (customer_id, full_name, pan, phone, relationship) VALUES ($1,$2,$3,$4,$5)',
        [customerId, h.full_name, h.pan ?? null, h.phone ?? null, h.relationship ?? null]);
    }
    await writeAudit(tx, { actorId: actor.id, action: 'customer.joint-holders', entityType: 'customers', entityId: customerId, after: { count: holders.length } });
  });
  return { ok: true };
}

// ── Nominees ──────────────────────────────────────────────────────────
export interface NomineeInput {
  full_name: string; relationship?: string | null; share_pct?: number | null; dob?: string | null;
  pan?: string | null; phone?: string | null; address?: string | null; guardian_name?: string | null; guardian_pan?: string | null;
  kyc_id_type?: string | null; kyc_id_number?: string | null;
}
export async function setNominees(db: Db, actor: AuthUser, customerId: number, nominees: NomineeInput[]) {
  await assertVisible(db, actor, customerId);
  const total = nominees.reduce((s, n) => s + (n.share_pct ?? 0), 0);
  if (nominees.length && total > 100.01) throw errors.badRequest('Nominee shares exceed 100%');
  await db.withTx(async (tx) => {
    await tx.query('DELETE FROM nominees WHERE customer_id = $1', [customerId]);
    for (const n of nominees) {
      await tx.query('INSERT INTO nominees (customer_id, full_name, relationship, share_pct, dob, pan, phone, address, guardian_name, guardian_pan, kyc_id_type, kyc_id_number) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
        [customerId, n.full_name, n.relationship ?? null, n.share_pct ?? null, n.dob ?? null,
         n.pan ?? null, n.phone ?? null, n.address ?? null, n.guardian_name ?? null, n.guardian_pan ?? null,
         n.kyc_id_type ?? null, n.kyc_id_number ?? null]);
    }
    await writeAudit(tx, { actorId: actor.id, action: 'customer.nominees', entityType: 'customers', entityId: customerId, after: { count: nominees.length } });
  });
  return { ok: true };
}

// ── Demat ─────────────────────────────────────────────────────────────
export async function setDemat(db: Db, actor: AuthUser, customerId: number, dpId: string, clientId: string, depository?: string | null) {
  await assertVisible(db, actor, customerId);
  await db.query('UPDATE customers SET demat_dp_id = $1, demat_client_id = $2, depository = COALESCE($3, depository), updated_at = now() WHERE id = $4',
    [dpId, clientId, depository ?? null, customerId]);
  await writeAudit(db, { actorId: actor.id, action: 'customer.demat', entityType: 'customers', entityId: customerId, after: { dpId, clientId, depository } });
  return { ok: true };
}

// ── Deceased flag ─────────────────────────────────────────────────────
export async function markDeceased(db: Db, actor: AuthUser, customerId: number, deceasedDate: string) {
  await db.query('UPDATE customers SET is_deceased = TRUE, deceased_date = $1, updated_at = now() WHERE id = $2', [deceasedDate, customerId]);
  await writeAudit(db, { actorId: actor.id, action: 'customer.deceased', entityType: 'customers', entityId: customerId, after: { deceasedDate } });
  return { ok: true };
}

// ── KYC documents ─────────────────────────────────────────────────────
export async function addDocument(db: Db, actor: AuthUser, customerId: number, docType: string, filename: string, _clientMime: string, dataBase64: string, origin = 'staff') {
  await assertVisible(db, actor, customerId);
  const { validateUpload } = await import('../../lib/uploads.js');
  const { buffer, mime } = validateUpload(dataBase64); // sniffed mime — client's is ignored
  const { saveBuffer } = await import('../../lib/storage.js');
  const { path } = saveBuffer('kyc-docs', filename, buffer);
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO customer_documents (customer_id, doc_type, file_path, original_filename, mime, origin, uploaded_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [customerId, docType, path, filename, mime, origin, actor.id]);
  await writeAudit(db, { actorId: actor.id, action: 'customer.doc.add', entityType: 'customer_documents', entityId: Number(rows[0]!.id), after: { docType, origin } });
  return { id: Number(rows[0]!.id) };
}

export async function getDocument(db: Db, actor: AuthUser, customerId: number, docId: number): Promise<{ buffer: Buffer; mime: string; filename: string } | null> {
  await assertVisible(db, actor, customerId);
  const doc = (await db.query<{ file_path: string; mime: string | null; original_filename: string | null }>(
    'SELECT file_path, mime, original_filename FROM customer_documents WHERE id = $1 AND customer_id = $2', [docId, customerId])).rows[0];
  if (!doc) return null;
  const { readStored } = await import('../../lib/storage.js');
  const buffer = readStored(doc.file_path);
  if (!buffer) return null;
  return { buffer, mime: doc.mime ?? 'application/octet-stream', filename: doc.original_filename ?? 'document' };
}

/** DigiLocker/Aadhaar KYC (stub provider — real flow flips in via config). */
export async function startDigilocker(db: Db, actor: AuthUser, customerId: number) {
  await assertVisible(db, actor, customerId);
  // Stub returns a pseudo session/redirect; a real adapter would call Decentro.
  return { session_id: `stub-dl-${customerId}-${Date.now().toString(36)}`, redirect_url: `https://stub.digilocker/authorize?c=${customerId}` };
}
export async function completeDigilocker(db: Db, actor: AuthUser, customerId: number) {
  await setKyc(db, actor, customerId, 'Verified');
  return { kyc_status: 'Verified' };
}

/** Correction request → approval; applies the diff on final approve. */
export async function requestCorrection(db: Db, actor: AuthUser, customerId: number, changes: Record<string, unknown>, reason: string): Promise<ApprovalRow> {
  await assertVisible(db, actor, customerId);
  return db.withTx(async (tx) => {
    const req = await createApprovalRequest(tx, {
      type: 'customer_correction',
      entityType: 'customers',
      entityId: customerId,
      makerUserId: actor.id,
      metadata: { changes, reason },
    });
    await tx.query('INSERT INTO customer_change_requests (customer_id, changes, reason, source, approval_request_id, created_by_user_id) VALUES ($1,$2,$3,$4,$5,$6)',
      [customerId, JSON.stringify(changes), reason, 'staff', req.id, actor.id]);
    return req;
  });
}

const CORRECTABLE = new Set(['full_name', 'phone', 'email', 'address', 'city', 'district', 'state']);
registerOnFinalApprove('customer_correction', async (tx, req) => {
  const changes = (req.metadata.changes ?? {}) as Record<string, unknown>;
  const sets: string[] = [];
  const params: unknown[] = [];
  let p = 0;
  for (const [k, v] of Object.entries(changes)) {
    if (CORRECTABLE.has(k)) { sets.push(`${k} = $${++p}`); params.push(v); }
  }
  if (sets.length && req.entity_id) {
    params.push(Number(req.entity_id));
    await tx.query(`UPDATE customers SET ${sets.join(', ')}, updated_at = now() WHERE id = $${++p}`, params);
  }
});

/** Active staff (non-customer roles) eligible to receive a customer handover. */
export async function listAssignableStaff(db: Db): Promise<{ id: number; full_name: string; role: string }[]> {
  const { rows } = await db.query<{ id: string; full_name: string; role: string }>(
    `SELECT u.id, u.full_name, r.name AS role
       FROM users u JOIN roles r ON r.id = u.role_id
      WHERE u.is_active = TRUE AND r.name <> 'customer'
      ORDER BY u.full_name`);
  return rows.map((r) => ({ ...r, id: Number(r.id) }));
}

/** Handover request → approval; moves ownership on final approve. */
export async function requestHandover(db: Db, actor: AuthUser, customerId: number, toUserId: number, reason: string): Promise<ApprovalRow> {
  return db.withTx(async (tx) => {
    const cur = (await tx.query<{ enrolled_by_user_id: string | null }>('SELECT enrolled_by_user_id FROM customers WHERE id = $1', [customerId])).rows[0];
    if (!cur) throw errors.notFound('Customer not found');
    const req = await createApprovalRequest(tx, {
      type: 'customer_reassignment',
      entityType: 'customers',
      entityId: customerId,
      makerUserId: actor.id,
      metadata: { toUserId, reason, fromUserId: cur.enrolled_by_user_id ? Number(cur.enrolled_by_user_id) : null },
    });
    await tx.query('INSERT INTO customer_reassignments (customer_id, from_user_id, to_user_id, reason, approval_request_id, created_by_user_id) VALUES ($1,$2,$3,$4,$5,$6)',
      [customerId, cur.enrolled_by_user_id, toUserId, reason, req.id, actor.id]);
    return req;
  });
}

registerOnFinalApprove('customer_reassignment', async (tx, req) => {
  const toUserId = req.metadata.toUserId as number | undefined;
  if (toUserId && req.entity_id) {
    await tx.query('UPDATE customers SET enrolled_by_user_id = $1, updated_at = now() WHERE id = $2', [toUserId, Number(req.entity_id)]);
  }
});
