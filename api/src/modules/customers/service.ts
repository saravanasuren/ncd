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
import {
  OUTSTANDING_APPLICATION_STATUSES,
  CORRECTABLE_CUSTOMER_KEYS,
  customerFieldError,
  isCorrectableCustomerField,
  normaliseCustomerFieldValue,
} from '@new-wealth/shared';

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
  // Staff also own the customers they REFERRED, not just the ones they keyed
  // in — see scope.ts referrerMatchSql.
  refCol: 'c.referred_by_text',
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
      const { ensureAgentForReferrerText } = await import('../agents/service.js');
      await ensureAgentForReferrerText(tx, actor, refText);
    }
    // Customer creation is NOT gated (owner 2026-07-21 — the customer is live on
    // creation; the investment is the only maker/checker gate). But it should be
    // VISIBLE (owner 2026-07-24): raise a notice on the Approvals page so an
    // admin can eyeball each new customer. Acknowledging it clears the notice —
    // the registered handler only re-affirms the status it already has.
    const notice = await createApprovalRequest(tx, {
      type: 'customer_creation',
      entityType: 'customers',
      entityId: id,
      makerUserId: actor.id,
      metadata: { customerName: input.full_name, customer_code: code, notice: true },
    });
    await writeAudit(tx, { actorId: actor.id, action: 'customer.create', entityType: 'customers', entityId: id, after: { code, name: input.full_name, notice_no: notice.request_no } });
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

// ── Draft customers: a half-finished enrolment, persisted server-side ───────
// (owner 2026-08-22). One live draft per user. A user keeps their own; a
// super-admin can see everyone's in-progress enrolments.
export async function saveMyDraft(db: Db, actor: AuthUser, input: { draft?: unknown; display_name?: string | null; display_phone?: string | null }) {
  await db.query(
    `INSERT INTO customer_drafts (owner_user_id, draft, display_name, display_phone)
     VALUES ($1,$2::jsonb,$3,$4)
     ON CONFLICT (owner_user_id) DO UPDATE
       SET draft = EXCLUDED.draft, display_name = EXCLUDED.display_name, display_phone = EXCLUDED.display_phone, updated_at = now()`,
    [actor.id, JSON.stringify(input.draft ?? {}), input.display_name ?? null, input.display_phone ?? null]);
  return { ok: true };
}
export async function getMyDraft(db: Db, actor: AuthUser) {
  const r = (await db.query<Record<string, unknown>>(
    'SELECT draft, updated_at FROM customer_drafts WHERE owner_user_id = $1', [actor.id])).rows[0];
  return r ? { draft: r.draft, updated_at: r.updated_at } : null;
}
export async function discardMyDraft(db: Db, actor: AuthUser) {
  await db.query('DELETE FROM customer_drafts WHERE owner_user_id = $1', [actor.id]);
  return { ok: true };
}
export async function listDrafts(db: Db, actor: AuthUser) {
  // A user sees only their own; a super-admin sees every user's draft.
  const all = actor.role === 'super_admin';
  const { rows } = await db.query<Record<string, unknown>>(
    `SELECT d.owner_user_id, d.display_name, d.display_phone, d.updated_at, u.full_name AS owner_name
       FROM customer_drafts d JOIN users u ON u.id = d.owner_user_id
      ${all ? '' : 'WHERE d.owner_user_id = $1'}
      ORDER BY d.updated_at DESC`, all ? [] : [actor.id]);
  return {
    all,
    rows: rows.map((r) => ({
      owner_user_id: Number(r.owner_user_id), owner_name: (r.owner_name as string) ?? null,
      display_name: (r.display_name as string) ?? null, display_phone: (r.display_phone as string) ?? null,
      updated_at: r.updated_at, mine: Number(r.owner_user_id) === actor.id,
    })),
  };
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

/**
 * Resolve a free-text "referred by" to a person. Order matters: a DHN code is
 * unambiguous, then an agent (code or name), then staff. Returns the raw text
 * with kind 'text' when nothing matches, so the UI still shows what was typed.
 */
export async function resolveReferredBy(db: Db, raw: string | null) {
  const t = (raw ?? '').trim();
  if (!t) return null;
  if (/^DHN\d+$/i.test(t)) {
    const cust = (await db.query<{ id: string; full_name: string; customer_code: string }>(
      'SELECT id, full_name, customer_code FROM customers WHERE upper(customer_code) = upper($1) LIMIT 1', [t])).rows[0];
    if (cust) return { kind: 'customer' as const, id: Number(cust.id), name: cust.full_name, code: cust.customer_code, text: t };
  }
  const ag = (await db.query<{ id: string; full_name: string; agent_code: string }>(
    `SELECT id, full_name, agent_code FROM agents
      WHERE deleted_at IS NULL AND (upper(agent_code) = upper($1) OR lower(btrim(full_name)) = lower(btrim($1))) LIMIT 1`, [t])).rows[0];
  if (ag) return { kind: 'agent' as const, id: Number(ag.id), name: ag.full_name, code: ag.agent_code, text: t };
  const u = (await db.query<{ id: string; full_name: string; code: string | null }>(
    `SELECT u.id, u.full_name, u.code FROM users u JOIN roles r ON r.id = u.role_id
      WHERE r.name <> 'customer' AND (upper(COALESCE(u.code,'')) = upper($1) OR lower(btrim(u.full_name)) = lower(btrim($1))) LIMIT 1`, [t])).rows[0];
  if (u) return { kind: 'staff' as const, id: Number(u.id), name: u.full_name, code: u.code, text: t };
  return { kind: 'text' as const, id: null, name: null, code: null, text: t };
}

export async function getCustomerDetail(db: Db, actor: AuthUser, id: number) {
  await assertVisible(db, actor, id);
  // Who enrolled this customer — a staff user or an agent (owner 2026-07-24).
  // Resolved to a NAME here so the profile can just print it.
  const c = (await db.query(
    `SELECT c.*,
            -- An agent also HAS a user row, so the agent identity wins: enrolling
            -- as an agent is what the book attributes the customer to.
            COALESCE(ag.full_name, u.full_name) AS enrolled_by_name,
            -- Which COLUMN is populated does not decide what someone IS. An
            -- agent who has no agents row still logs in and enrols as a user,
            -- so the customer carries enrolled_by_user_id — and this used to
            -- print "(staff)" for a person the Users page calls Agent
            -- (Selvarajkumar, owner 2026-08-04: 4 such users, 6 customers).
            --
            -- is_staff is the same test the Incentives page already uses to
            -- decide the Staff vs Agent tab, so the two screens now agree
            -- instead of contradicting each other about one person.
            CASE
              WHEN ag.id IS NOT NULL THEN 'agent'
              WHEN u.id IS NOT NULL THEN CASE WHEN COALESCE(u.is_staff, FALSE) THEN 'staff' ELSE 'agent' END
            END AS enrolled_by_kind,
            ag.agent_code AS enrolled_by_agent_code
       FROM customers c
       LEFT JOIN users  u  ON u.id  = c.enrolled_by_user_id
       LEFT JOIN agents ag ON ag.id = c.enrolled_by_agent_id
      WHERE c.id = $1`, [id])).rows[0];

  // Who REFERRED this customer (owner 2026-07-24). Distinct from who enrolled
  // them: 402 of 565 customers carry a referrer, and the profile never showed
  // it. It's free text — 357 are names, 41 a customer code, 4 an agent code —
  // so resolve it to a real person where we can, and print the raw text where
  // we can't (some codes, e.g. DHN1084, point at records not in this book).
  const referredBy = await resolveReferredBy(db, (c?.referred_by_text as string | null) ?? null);
  const bankAccounts = (await db.query('SELECT * FROM customer_bank_accounts WHERE customer_id = $1 ORDER BY is_active DESC, id', [id])).rows;
  const nominees = (await db.query('SELECT * FROM nominees WHERE customer_id = $1', [id])).rows;
  const jointHolders = (await db.query('SELECT * FROM joint_holders WHERE customer_id = $1', [id])).rows;
  const documents = (await db.query('SELECT id, doc_type, original_filename, origin, uploaded_at FROM customer_documents WHERE customer_id = $1', [id])).rows;
  // The customer's investments — every application with its live outstanding
  // (partial withdrawals reduce it), newest first.
  const applications = (await db.query(
    `SELECT a.id, a.application_no, s.id AS series_id, s.code AS series_code, a.total_amount AS amount,
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
            a.esigned_at, (a.esigned_pdf_path IS NOT NULL) AS has_signed_copy,
            -- how many credits were clubbed into this investment (>1 = has a
            -- payment breakup), so the customer's list can flag it at a glance.
            (SELECT count(*)::int FROM application_lines al2 WHERE al2.application_id = a.id) AS line_count
     -- LEFT: subordinate bonds have no series and would otherwise vanish from
     -- the customer's own profile — the one place they must always appear.
     FROM applications a LEFT JOIN series s ON s.id = a.series_id
     LEFT JOIN LATERAL (
       SELECT sum(al.outstanding_amount) FILTER (WHERE al.status = 'Active') AS live
       FROM application_lines al WHERE al.application_id = a.id
     ) bk ON TRUE
     WHERE a.customer_id = $1
     ORDER BY a.date_money_received DESC NULLS LAST, a.id DESC`, [id])).rows;
  return { customer: c, referredBy, bankAccounts, nominees, jointHolders, documents, applications };
}

/**
 * Correct the beneficiary name on an existing account (owner 2026-07-24).
 *
 * There was no way to edit a bank account at all — only add, set-active and
 * delete — so a misspelt beneficiary name was unfixable: re-adding the same
 * account is refused as a duplicate, and deleting it is blocked while unpaid
 * payouts point at it. The name matters: it is what prints in the Beneficiary
 * Name column of the Federal NEFT file.
 *
 * Only the name changes. Account number and IFSC are identity — changing those
 * is a different account, so it stays add-then-delete and keeps its penny-drop.
 */
export async function updateBankAccountName(db: Db, actor: AuthUser, customerId: number, bankId: number, holderName: string) {
  await assertVisible(db, actor, customerId);
  const name = holderName.trim();
  if (name.length < 2) throw errors.badRequest('Beneficiary name is required');
  return db.withTx(async (tx) => {
    const before = (await tx.query<{ holder_name: string | null; account_number: string }>(
      'SELECT holder_name, account_number FROM customer_bank_accounts WHERE id = $1 AND customer_id = $2',
      [bankId, customerId])).rows[0];
    if (!before) throw errors.notFound('Bank account not found for this customer');
    await tx.query('UPDATE customer_bank_accounts SET holder_name = $1 WHERE id = $2', [name, bankId]);
    await writeAudit(tx, {
      actorId: actor.id, action: 'customer.bank.rename', entityType: 'customer_bank_accounts', entityId: bankId,
      before: { holder_name: before.holder_name },
      after: { holder_name: name, account_number: before.account_number },
    });
    return { ok: true, id: bankId, holder_name: name };
  });
}

/**
 * A customer's tax position: whether TDS applies, and any 15G/15H on file.
 *
 * These drive computeTds on every payout, but were settable ONLY at enrolment —
 * the correction whitelist doesn't carry them — so a customer who later filed a
 * 15G/15H had TDS deducted anyway, with no way for staff to record the form.
 * Changing it is real money, so every change is audited with before/after.
 *
 * A form without an expiry is refused: 15G/15H are per financial year, and
 * isFormValid() treats a missing expiry as "not valid", so accepting one would
 * silently do nothing.
 */
export async function updateTaxStatus(
  db: Db, actor: AuthUser, customerId: number,
  input: { tds_applicable?: boolean; tax_form?: string | null; tax_form_expires_on?: string | null },
) {
  await assertVisible(db, actor, customerId);
  const form = input.tax_form?.trim() || null;
  if (form && !['15G', '15H'].includes(form)) throw errors.badRequest('Tax form must be 15G or 15H');
  if (form && !input.tax_form_expires_on) {
    throw errors.badRequest('A 15G/15H needs its validity date — without one it is ignored when TDS is computed');
  }
  return db.withTx(async (tx) => {
    const before = (await tx.query<Record<string, unknown>>(
      'SELECT tds_applicable, tax_form, tax_form_expires_on FROM customers WHERE id = $1', [customerId])).rows[0];
    if (!before) throw errors.notFound('Customer not found');
    await tx.query(
      `UPDATE customers SET
         tds_applicable      = COALESCE($1, tds_applicable),
         tax_form            = $2,
         tax_form_expires_on = $3,
         updated_at = now()
       WHERE id = $4`,
      [input.tds_applicable ?? null, form, form ? input.tax_form_expires_on : null, customerId]);
    const after = (await tx.query<Record<string, unknown>>(
      'SELECT tds_applicable, tax_form, tax_form_expires_on FROM customers WHERE id = $1', [customerId])).rows[0];
    await writeAudit(tx, {
      actorId: actor.id, action: 'customer.tax-status', entityType: 'customers', entityId: customerId,
      before, after,
    });
    return { ok: true, ...after };
  });
}

/**
 * Manually mark whether the customer's bond is dematerialised. Staff-set (NCD
 * doesn't get this from the depository); shown as a sign on the profile.
 * value: true = dematerialised, false = physical, null = clear to "not marked".
 * Audited so a change of this record is traceable.
 */
export async function setDematerialised(db: Db, actor: AuthUser, customerId: number, value: boolean | null) {
  await assertVisible(db, actor, customerId);
  const before = (await db.query<{ is_dematerialised: boolean | null }>(
    'SELECT is_dematerialised FROM customers WHERE id = $1', [customerId])).rows[0];
  if (!before) throw errors.notFound('Customer not found');
  await db.query('UPDATE customers SET is_dematerialised = $1, updated_at = now() WHERE id = $2', [value, customerId]);
  await writeAudit(db, {
    actorId: actor.id, action: 'customer.dematerialised', entityType: 'customers', entityId: customerId,
    before: { is_dematerialised: before.is_dematerialised }, after: { is_dematerialised: value },
  });
  return { ok: true, is_dematerialised: value };
}

export async function addBankAccount(db: Db, actor: AuthUser, customerId: number, input: { account_number: string; ifsc: string; bank_name?: string; branch_name?: string; branch_city?: string; account_type?: string; holder_name?: string; tds_applicable?: boolean }) {
  await assertVisible(db, actor, customerId);
  // Pass the beneficiary name so the penny-drop does the NAME match too — not
  // just account+IFSC validity. Without it, an account with the right number
  // but a wrong holder name verified silently (inconsistent with enrolment,
  // which checks the name via /lookups/penny-drop). owner 2026-08-06.
  const pd = await kycProvider().pennyDrop(input.account_number, input.ifsc, input.holder_name);
  return db.withTx(async (tx) => {
    const dup = await tx.query('SELECT 1 FROM customer_bank_accounts WHERE customer_id = $1 AND account_number = $2 AND ifsc = $3', [customerId, input.account_number, input.ifsc]);
    if (dup.rowCount) {
      // The usual reason for re-adding the same account is a typo in the
      // beneficiary name — say how to fix that instead of just refusing.
      throw errors.conflict(
        'This bank account is already on file. To correct the beneficiary name on it, use "Edit name" on the existing account — you do not need to add it again.');
    }
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

/**
 * Re-run the penny drop on an account already on file. A Failed status can be
 * transient (provider down) or stale (the beneficiary name has since been
 * corrected), and without this the account is stuck Failed forever — which in
 * turn blocks activating it.
 */
export async function reverifyBankAccount(db: Db, actor: AuthUser, customerId: number, bankId: number) {
  await assertVisible(db, actor, customerId);
  const b = (await db.query<{ account_number: string; ifsc: string | null; holder_name: string | null; penny_drop_status: string }>(
    'SELECT account_number, ifsc, holder_name, penny_drop_status FROM customer_bank_accounts WHERE id = $1 AND customer_id = $2',
    [bankId, customerId])).rows[0];
  if (!b) throw errors.notFound('Bank account not found for this customer');
  if (!b.ifsc) throw errors.unprocessable('This account has no IFSC on file — it cannot be verified. Add the account again with its IFSC.');
  const pd = await kycProvider().pennyDrop(b.account_number, b.ifsc, b.holder_name ?? undefined);
  await db.withTx(async (tx) => {
    await tx.query(
      'UPDATE customer_bank_accounts SET penny_drop_status = $1, penny_drop_detail = $2, verified_at = CASE WHEN $1 = $3 THEN now() ELSE verified_at END WHERE id = $4',
      [pd.status, pd.detail ?? null, 'Verified', bankId]);
    await writeAudit(tx, {
      actorId: actor.id, action: 'customer.bank.reverify', entityType: 'customer_bank_accounts', entityId: bankId,
      before: { penny_drop_status: b.penny_drop_status }, after: { penny_drop_status: pd.status, detail: pd.detail ?? null },
    });
  });
  return { ok: true, pennyDrop: pd };
}

export async function setActiveBank(db: Db, actor: AuthUser, customerId: number, bankId: number, opts?: { force?: boolean; reason?: string }) {
  await assertVisible(db, actor, customerId);
  await db.withTx(async (tx) => {
    const chk = await tx.query<{ penny_drop_status: string }>('SELECT penny_drop_status FROM customer_bank_accounts WHERE id = $1 AND customer_id = $2', [bankId, customerId]);
    if (!chk.rows[0]) throw errors.notFound('Bank account not found');
    // A failed/pending penny-drop must not strand a customer on the WRONG
    // account. Penny drop fails for reasons that say nothing about the account
    // (provider down, name mismatch since corrected), and the book already
    // contains Active accounts that were never Verified — the NEFT file is
    // deliberately permissive and eyeballed. So: Verified activates freely;
    // anything else needs an explicit override with a written reason, audited.
    const pdStatus = chk.rows[0].penny_drop_status;
    if (pdStatus !== 'Verified' && !opts?.force) {
      throw errors.unprocessable(
        `This account's penny-drop is ${pdStatus}, not Verified. Retry the verification, or activate it anyway with a reason if you have confirmed the details another way.`);
    }
    if (pdStatus !== 'Verified' && !(opts?.reason ?? '').trim()) {
      throw errors.badRequest('A written reason is required to activate an unverified account');
    }
    await tx.query('UPDATE customer_bank_accounts SET is_active = FALSE WHERE customer_id = $1', [customerId]);
    await tx.query('UPDATE customer_bank_accounts SET is_active = TRUE WHERE id = $1', [bankId]);
    // Future unpaid payouts follow the new default; paid ones keep their bank.
    const { resnapshotPayeeBank } = await import('../schedule/materialize.js');
    const moved = await resnapshotPayeeBank(tx, customerId);
    await writeAudit(tx, { actorId: actor.id, action: 'customer.bank.set-active', entityType: 'customer_bank_accounts', entityId: bankId,
      after: { customerId, futureRowsRepointed: moved, penny_drop_status: pdStatus, forced: pdStatus !== 'Verified', reason: opts?.reason?.trim() || null } });
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
      const unpaid = Number((await tx.query<{ n: string }>(
        `SELECT count(*) AS n FROM disbursement_schedule ds JOIN applications a ON a.id = ds.application_id
          WHERE a.customer_id = $1 AND ds.status = 'Scheduled'`, [customerId])).rows[0]!.n);
      if (unpaid > 0) {
        // Telling someone to "make another account active" is a dead end when
        // this is the only one on file — say what actually unblocks them.
        const others = Number((await tx.query<{ n: string }>(
          'SELECT count(*) AS n FROM customer_bank_accounts WHERE customer_id = $1 AND id <> $2',
          [customerId, bankId])).rows[0]!.n);
        throw errors.conflict(
          others > 0
            ? `${unpaid} unpaid payout(s) are due to this active account — make one of the customer's other accounts active first, then delete this one.`
            // NB: adding an account does NOT activate it — it has to be made
            // active explicitly, so say all three steps or the advice dead-ends.
            : `${unpaid} unpaid payout(s) are due to this account and it is the customer's only one — deleting it would leave those payouts with nowhere to go. Add the replacement account, click "Make active" on it, then delete this one.`
        );
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
/**
 * Fill in the shares nobody stated (owner 2026-07-24: "everything should go to
 * the nominee only"). A nominee added without a share used to land at 0%, which
 * says the opposite of what was meant. Unstated shares split whatever is left
 * equally — so ONE nominee gets 100, two get 50/50 — while an explicit split
 * (60/40) is preserved exactly as typed.
 */
export function withNomineeShares<T extends { share_pct?: number | null }>(nominees: T[]): Array<T & { share_pct: number }> {
  const stated = (n: T) => Number(n.share_pct) > 0;
  const allocated = nominees.filter(stated).reduce((s, n) => s + Number(n.share_pct), 0);
  const unstated = nominees.filter((n) => !stated(n)).length;
  // Nothing left to share out (an explicit 100 plus an extra name) leaves the
  // remainder at 0 rather than inventing percentage points from nowhere.
  const each = unstated > 0 ? Math.max(0, Math.round(((100 - allocated) / unstated) * 100) / 100) : 0;
  return nominees.map((n) => ({ ...n, share_pct: stated(n) ? Number(n.share_pct) : each }));
}

/** Replace a customer's nominee set. INTERNAL — reached through the approval
 *  applier below and through enrolment, never straight from a staff click:
 *  the owner put nominee changes behind approval on 2026-08-19. */
async function applyNominees(tx: Db, actorId: number | null, customerId: number, nomineesIn: NomineeInput[]) {
  const nominees = withNomineeShares(nomineesIn);
  await tx.query('DELETE FROM nominees WHERE customer_id = $1', [customerId]);
  for (const n of nominees) {
    await tx.query('INSERT INTO nominees (customer_id, full_name, relationship, share_pct, dob, pan, phone, address, guardian_name, guardian_pan, kyc_id_type, kyc_id_number) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
      [customerId, n.full_name, n.relationship ?? null, n.share_pct, n.dob ?? null,
       n.pan ?? null, n.phone ?? null, n.address ?? null, n.guardian_name ?? null, n.guardian_pan ?? null,
       n.kyc_id_type ?? null, n.kyc_id_number ?? null]);
  }
  await writeAudit(tx, { actorId, action: 'customer.nominees', entityType: 'customers', entityId: customerId, after: { count: nominees.length } });
}

/**
 * Ask to change a customer's nominees → approval (owner 2026-08-19: "when i
 * make some changes in it will go through approval").
 *
 * Nominee decides who receives the money, so this is the last field that should
 * have been changeable by one person alone. The whole SET is carried in the
 * request rather than a per-row diff, because that is the shape the write has
 * always taken — replace the set — and a diff would have to reconcile rows
 * that may have moved underneath it while the request waited.
 */
export async function requestNomineeChange(db: Db, actor: AuthUser, customerId: number, nomineesIn: NomineeInput[], reason: string): Promise<ApprovalRow> {
  await assertVisible(db, actor, customerId);
  const stated = nomineesIn.reduce((s, n) => s + (Number(n.share_pct) > 0 ? Number(n.share_pct) : 0), 0);
  if (nomineesIn.length && stated > 100.01) throw errors.badRequest('Nominee shares exceed 100%');
  return db.withTx(async (tx) => createApprovalRequest(tx, {
    type: 'customer_nominees',
    entityType: 'customers',
    entityId: customerId,
    makerUserId: actor.id,
    // Shares are normalised NOW so the checker approves the exact split that
    // will be saved, not one the applier quietly rebalances afterwards.
    metadata: { nominees: withNomineeShares(nomineesIn), reason, count: nomineesIn.length },
  }));
}

registerOnFinalApprove('customer_nominees', async (tx, req) => {
  const nominees = (req.metadata.nominees ?? []) as NomineeInput[];
  if (req.entity_id) await applyNominees(tx, req.maker_user_id ?? null, Number(req.entity_id), nominees);
});

/**
 * Set nominees. FIRST capture applies straight away; every later CHANGE goes to
 * approval (owner 2026-08-19: "when i make some changes in it will go through
 * approval").
 *
 * The split is on the customer's state, not on who is calling: the enrolment
 * wizard records a nominee through this same endpoint moments after creating
 * the customer, and routing that first entry into a queue would leave brand-new
 * customers with no nominee on file until a checker got to it. Once a nominee
 * EXISTS, changing it is exactly what the owner asked to gate — nominee decides
 * who receives the money.
 */
export async function setNominees(db: Db, actor: AuthUser, customerId: number, nomineesIn: NomineeInput[], reason?: string) {
  await assertVisible(db, actor, customerId);
  const stated = nomineesIn.reduce((s, n) => s + (Number(n.share_pct) > 0 ? Number(n.share_pct) : 0), 0);
  if (nomineesIn.length && stated > 100.01) throw errors.badRequest('Nominee shares exceed 100%');

  const existing = Number((await db.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM nominees WHERE customer_id = $1', [customerId])).rows[0]?.n ?? 0);
  if (existing === 0) {
    await db.withTx(async (tx) => applyNominees(tx, actor.id, customerId, nomineesIn));
    return { ok: true, applied: true };
  }
  const req = await requestNomineeChange(db, actor, customerId, nomineesIn, reason ?? 'Nominee change');
  return { ok: true, applied: false, approval_request: req };
}

// ── Demat ─────────────────────────────────────────────────────────────
/**
 * Set demat details. FIRST capture applies; a CHANGE to details already on file
 * goes to approval (owner 2026-08-19) — the same rule as nominees, and for the
 * same reason: the enrolment wizard fills these in moments after creating the
 * customer, and queueing that would leave new customers blank.
 *
 * Demat is also one of the CORRECTABLE_CUSTOMER_FIELDS now, so the profile's
 * "Request correction" form edits it too; both roads end at a checker.
 */
export async function setDemat(db: Db, actor: AuthUser, customerId: number, dpId: string, clientId: string, depository?: string | null) {
  await assertVisible(db, actor, customerId);
  const before = (await db.query<{ demat_dp_id: string | null; demat_client_id: string | null }>(
    'SELECT demat_dp_id, demat_client_id FROM customers WHERE id = $1', [customerId])).rows[0];
  if (!before) throw errors.notFound('Customer not found');
  const hadOne = !!(String(before.demat_dp_id ?? '').trim() || String(before.demat_client_id ?? '').trim());

  if (hadOne) {
    const changes: Record<string, unknown> = { demat_dp_id: dpId, demat_client_id: clientId };
    if (depository != null) changes.depository = depository;
    const req = await requestCorrection(db, actor, customerId, changes, 'Demat details change');
    return { ok: true, applied: false, approval_request: req };
  }
  await db.query('UPDATE customers SET demat_dp_id = $1, demat_client_id = $2, depository = COALESCE($3, depository), updated_at = now() WHERE id = $4',
    [dpId, clientId, depository ?? null, customerId]);
  await writeAudit(db, { actorId: actor.id, action: 'customer.demat', entityType: 'customers', entityId: customerId, after: { dpId, clientId, depository } });
  return { ok: true, applied: true };
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
  // Reject unknown fields here rather than dropping them at apply time — a
  // maker who asks to correct something we cannot change must be told now,
  // not have the request approved and quietly do nothing.
  const unknown = Object.keys(changes).filter((k) => !isCorrectableCustomerField(k));
  if (unknown.length) {
    throw errors.badRequest(`Cannot correct: ${unknown.join(', ')}. Correctable fields are: ${CORRECTABLE_CUSTOMER_KEYS.join(', ')}`);
  }
  if (!Object.keys(changes).length) throw errors.badRequest('No changes to submit');
  // Shape is checked NOW, not at apply time. A checker approving a malformed
  // DP ID would either fail deep in the applier or save rubbish that looks
  // approved — both worse than telling the maker while they are still typing.
  for (const [k, v] of Object.entries(changes)) {
    const err = customerFieldError(k, v);
    if (err) throw errors.badRequest(err);
  }
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

registerOnFinalApprove('customer_correction', async (tx, req) => {
  const changes = (req.metadata.changes ?? {}) as Record<string, unknown>;
  const sets: string[] = [];
  const params: unknown[] = [];
  let p = 0;
  for (const [k, v] of Object.entries(changes)) {
    // Allow-list is CORRECTABLE_CUSTOMER_KEYS (shared with the UI that renders
    // the form), so `k` is never attacker-chosen SQL.
    const value = normaliseCustomerFieldValue(k, v);
    if (value === undefined) continue;
    sets.push(`${k} = $${++p}`);
    params.push(value);
  }
  if (sets.length && req.entity_id) {
    params.push(Number(req.entity_id));
    await tx.query(`UPDATE customers SET ${sets.join(', ')}, updated_at = now() WHERE id = $${++p}`, params);
  }
  // A correction can introduce a referrer nobody has heard of, and it used to
  // just save the text — so the same name that raises an agent at customer
  // creation raised nothing here (owner 2026-08-19). Same helper, same result.
  if ('referred_by_text' in changes) {
    const { ensureAgentForReferrerText } = await import('../agents/service.js');
    const actorId = req.maker_user_id ?? null;
    if (actorId != null) {
      const actor = { id: actorId } as unknown as AuthUser;
      await ensureAgentForReferrerText(tx, actor, String(changes.referred_by_text ?? ''));
    }
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
