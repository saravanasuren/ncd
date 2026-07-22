/**
 * Background Verification (BGV) — one ops screen answering "which customers are
 * not ready, and what exactly is missing?" (spec: wealth BACKGROUND_VERIFICATION_SPEC).
 *
 * Status is computed SERVER-side so the client never re-derives "is this
 * customer complete" and disagrees with us. Every check is three-state:
 *   valid              → green (present and well-formed)
 *   present but partial → orange (there, but half-done — the ones that actually bite)
 *   missing/invalid    → red
 *
 * NCD deviations from the wealth spec, deliberate (see the PR):
 *  - Documents live in the existing `customer_documents` table, which has NO
 *    unique (customer, doc_type) constraint and already holds duplicate pairs,
 *    so we read the LATEST row per canonical type rather than adding a
 *    constraint that would fail on existing data and change upload behaviour.
 *  - Two doc vocabularies coexist (wealth-import wrote `PAN`/`Aadhaar`/…, the
 *    enrolment wizard writes `pan_card`/`aadhaar_card`/…) — both are unioned so
 *    historical uploads don't read as missing.
 *  - Email / address / city / PIN are surfaced but NOT blocking: NCD holds
 *    almost none of them (PIN 0, address 1, email 127 of 563), so blocking on
 *    them would paint every customer red and make the screen useless.
 */
import type { Db } from '../../db/types.js';
import type { AuthUser } from '../../lib/authUser.js';
import { errors } from '../../lib/errors.js';
import { writeAudit } from '../../lib/audit.js';
import { toISODate } from '../../lib/dates.js';

/** Canonical doc type → every alias actually stored in NCD. */
const DOC_ALIASES: Record<string, string[]> = {
  PAN: ['PAN', 'pan_card'],
  Aadhaar: ['Aadhaar', 'aadhaar_card'],
  Photo: ['Photo', 'customer_photo'],
  Signature: ['Signature', 'customer_signature'],
  AddressProof: ['AddressProof', 'address_proof'],
  BankProof: ['BankProof', 'bank_proof'],
  CML: ['CML_Copy', 'cml'],
};
/** The five that gate KYC verification (spec §6). */
export const KYC_DOC_TYPES = ['PAN', 'Aadhaar', 'Photo', 'Signature', 'AddressProof'] as const;
/** Shown on the grid but never blocking. */
export const EXTRA_DOC_TYPES = ['BankProof', 'CML'] as const;
export const ALL_DOC_TYPES = [...KYC_DOC_TYPES, ...EXTRA_DOC_TYPES];

const canonicalOf = (raw: string): string | null => {
  for (const [canon, aliases] of Object.entries(DOC_ALIASES)) if (aliases.includes(raw)) return canon;
  return null;
};

const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const AADHAAR_RE = /^\d{12}$/;
const DEPOSITORIES = ['NSDL', 'CDSL'];

export interface DataCheck {
  key: string; label: string;
  present: boolean; valid: boolean;
  partial?: boolean; optional?: boolean;
  value?: string | null;
}

const chk = (key: string, label: string, raw: unknown, opts: { re?: RegExp; optional?: boolean; mask?: boolean } = {}): DataCheck => {
  const v = raw == null ? '' : String(raw).trim();
  const present = v.length > 0;
  const valid = present && (opts.re ? opts.re.test(v) : true);
  return { key, label, present, valid, optional: opts.optional, value: present ? (opts.mask ? maskTail(v) : v) : null };
};
/** Never echo a full sensitive value back (spec §7.9). */
const maskTail = (v: string) => (v.length <= 4 ? v : '•'.repeat(Math.max(0, v.length - 4)) + v.slice(-4));

export interface BgvFilters { q?: string; seriesId?: number; kycStatus?: string; }

/**
 * The whole grid — one ready-to-render row per active, non-archived customer
 * the caller is allowed to see. Scoped exactly like the customers list, so a
 * branch staffer sees their own book and management sees everything.
 */
export async function grid(db: Db, actor: AuthUser, f: BgvFilters = {}) {
  const { scopeFor, scopeWhere } = await import('../../lib/scope.js');
  const params: unknown[] = [];
  const where: string[] = ['c.archived_at IS NULL'];
  if (f.q && f.q.trim()) {
    params.push(`%${f.q.trim()}%`);
    where.push(`(c.full_name ILIKE $${params.length} OR c.customer_code ILIKE $${params.length} OR c.pan ILIKE $${params.length})`);
  }
  if (f.kycStatus) { params.push(f.kycStatus); where.push(`c.kyc_status = $${params.length}`); }
  if (f.seriesId) {
    params.push(f.seriesId);
    where.push(`EXISTS (SELECT 1 FROM applications a WHERE a.customer_id = c.id AND a.series_id = $${params.length} AND a.status <> 'Cancelled' AND a.archived_at IS NULL)`);
  }
  const sc = scopeWhere(scopeFor(actor), { userCol: 'c.enrolled_by_user_id', agentCol: 'c.enrolled_by_agent_id', branchCol: 'c.branch_id', selfIdCol: 'c.id' }, params.length);
  where.push(sc.sql);
  params.push(...sc.params);

  const customers = (await db.query<Record<string, unknown>>(
    `SELECT c.id, c.customer_code, c.full_name, c.pan, c.dob, c.phone, c.email, c.address, c.city, c.pincode,
            c.aadhaar, c.aadhaar_last4, c.depository, c.demat_dp_id, c.demat_client_id, c.kyc_status
       FROM customers c WHERE ${where.join(' AND ')} ORDER BY c.full_name LIMIT 2000`, params)).rows;
  if (!customers.length) return { rows: [], counters: counters([]) };
  const ids = customers.map((c) => Number(c.id));

  const docRows = (await db.query<Record<string, unknown>>(
    `SELECT DISTINCT ON (customer_id, doc_type) id, customer_id, doc_type, original_filename, mime, origin, uploaded_at
       FROM customer_documents WHERE customer_id = ANY($1)
      ORDER BY customer_id, doc_type, uploaded_at DESC, id DESC`, [ids])).rows;
  const banks = (await db.query<Record<string, unknown>>(
    `SELECT DISTINCT ON (customer_id) customer_id, bank_name, account_number, ifsc
       FROM customer_bank_accounts WHERE customer_id = ANY($1)
      ORDER BY customer_id, is_active DESC NULLS LAST, id DESC`, [ids])).rows;
  const noms = (await db.query<Record<string, unknown>>(
    `SELECT DISTINCT ON (customer_id) customer_id, id, full_name, relationship, dob, share_pct
       FROM nominees WHERE customer_id = ANY($1)
      ORDER BY customer_id, share_pct DESC NULLS LAST, id ASC`, [ids])).rows;
  const invs = (await db.query<Record<string, unknown>>(
    `SELECT customer_id, count(*)::int AS n,
            count(*) FILTER (WHERE interest_start_date IS NULL AND status NOT IN ('Cancelled','Rejected'))::int AS missing_isd
       FROM applications WHERE customer_id = ANY($1) AND archived_at IS NULL GROUP BY customer_id`, [ids])).rows;

  const byCust = (rows: Record<string, unknown>[]) => {
    const m = new Map<number, Record<string, unknown>[]>();
    for (const r of rows) {
      const k = Number(r.customer_id);
      const arr = m.get(k);
      if (arr) arr.push(r); else m.set(k, [r]);
    }
    return m;
  };
  const docsBy = byCust(docRows), bankBy = byCust(banks), nomBy = byCust(noms), invBy = byCust(invs);

  const rows = customers.map((c) => {
    const id = Number(c.id);
    const docs: Record<string, unknown> = {};
    for (const d of docsBy.get(id) ?? []) {
      const canon = canonicalOf(String(d.doc_type));
      if (!canon) continue;
      // Two aliases can map to the same canonical type — keep the newest.
      // (timestamptz comes back as a Date, so compare epoch millis, not strings)
      const at = (x: unknown) => new Date(x as string).getTime() || 0;
      const prev = docs[canon] as { uploaded_at?: unknown } | undefined;
      if (prev && at(prev.uploaded_at) >= at(d.uploaded_at)) continue;
      docs[canon] = { id: Number(d.id), original_filename: d.original_filename, mime: d.mime, origin: d.origin, uploaded_at: d.uploaded_at };
    }
    const bank = (bankBy.get(id) ?? [])[0];
    const nominee = (nomBy.get(id) ?? [])[0];
    const inv = (invBy.get(id) ?? [])[0];
    return {
      id, customer_code: c.customer_code, full_name: c.full_name, kyc_status: c.kyc_status,
      docs,
      data_checks: dataChecks(c, bank, nominee),
      nominee: nominee ? { id: Number(nominee.id), full_name: nominee.full_name, relationship: nominee.relationship, dob: toISODate(nominee.dob as string | null), share_pct: nominee.share_pct } : null,
      investments: Number(inv?.n ?? 0),
      investments_missing_interest_start: Number(inv?.missing_isd ?? 0),
    };
  });
  return { rows, counters: counters(rows) };
}

/** Per §4 — mandatory ones are red until valid; `optional` ones never block. */
function dataChecks(c: Record<string, unknown>, bank: Record<string, unknown> | undefined, nominee: Record<string, unknown> | undefined): DataCheck[] {
  const out: DataCheck[] = [
    chk('pan', 'PAN', c.pan, { re: PAN_RE }),
    chk('phone', 'Phone', c.phone),
    chk('dob', 'Date of birth', c.dob ? toISODate(c.dob as string) : null),
    aadhaarCheck(c),
    chk('bank_name', 'Bank name', bank?.bank_name),
    chk('bank_account_number', 'Bank a/c #', bank?.account_number, { mask: true }),
    chk('bank_ifsc', 'Bank IFSC', bank?.ifsc, { re: IFSC_RE }),
    depositoryCheck(c),
    nomineeCheck(nominee),
    // Surfaced + fixable, but not blocking in NCD (see file header).
    chk('email', 'Email', c.email, { re: EMAIL_RE, optional: true }),
    chk('address', 'Address', c.address, { optional: true }),
    chk('city', 'City', c.city, { optional: true }),
    chk('pincode', 'PIN', c.pincode, { optional: true }),
    chk('demat_dp_id', 'DP ID', c.demat_dp_id, { optional: true }),
    chk('demat_client_id', 'Client ID', c.demat_client_id, { optional: true }),
  ];
  return out;
}

/** Green = full 12 digits, orange = only the legacy last-4, red = nothing. */
function aadhaarCheck(c: Record<string, unknown>): DataCheck {
  const full = String(c.aadhaar ?? '').replace(/\D/g, '');
  const last4 = String(c.aadhaar_last4 ?? '').replace(/\D/g, '');
  if (AADHAAR_RE.test(full)) return { key: 'aadhaar', label: 'Aadhaar', present: true, valid: true, value: maskTail(full) };
  if (last4) return { key: 'aadhaar', label: 'Aadhaar', present: true, valid: false, partial: true, value: maskTail(last4) };
  return { key: 'aadhaar', label: 'Aadhaar', present: false, valid: false, value: null };
}

function depositoryCheck(c: Record<string, unknown>): DataCheck {
  const v = String(c.depository ?? '').trim().toUpperCase();
  return { key: 'depository', label: 'Depository', present: v.length > 0, valid: DEPOSITORIES.includes(v), value: v || null };
}

/** Red = none, orange = name only (no relationship/DOB), green = all three. */
function nomineeCheck(n: Record<string, unknown> | undefined): DataCheck {
  if (!n || !String(n.full_name ?? '').trim()) return { key: 'nominee', label: 'Nominee', present: false, valid: false, value: null };
  const complete = !!String(n.relationship ?? '').trim() && !!n.dob;
  return { key: 'nominee', label: 'Nominee', present: true, valid: complete, partial: !complete, value: String(n.full_name) };
}

export const isDataComplete = (checks: DataCheck[]) => checks.every((k) => k.optional || k.valid);
const hasAllKycDocs = (docs: Record<string, unknown>) => KYC_DOC_TYPES.every((t) => !!docs[t]);

function counters(rows: Array<{ kyc_status?: unknown; docs?: Record<string, unknown>; data_checks?: DataCheck[] }>) {
  let verified = 0, pending = 0, dataComplete = 0, needsAttention = 0;
  for (const r of rows) {
    if (r.kyc_status === 'Verified') verified++; else pending++;
    const ok = isDataComplete(r.data_checks ?? []);
    if (ok) dataComplete++;
    if (!ok || !hasAllKycDocs(r.docs ?? {})) needsAttention++;
  }
  return { customers: rows.length, kyc_verified: verified, kyc_pending: pending, data_complete: dataComplete, needs_attention: needsAttention };
}

// ── Inline fixer ─────────────────────────────────────────────────────────
/** Whitelisted patchable fields → never build a column name from user input. */
const CUSTOMER_FIELDS: Record<string, { col: string; re?: RegExp; upper?: boolean; digits?: number }> = {
  pan: { col: 'pan', re: PAN_RE, upper: true },
  phone: { col: 'phone' },
  phone_secondary: { col: 'phone_secondary' },
  email: { col: 'email', re: EMAIL_RE },
  dob: { col: 'dob' },
  gender: { col: 'gender' },
  aadhaar: { col: 'aadhaar', re: AADHAAR_RE, digits: 12 },
  address: { col: 'address' },
  city: { col: 'city' },
  district: { col: 'district' },
  state: { col: 'state' },
  pincode: { col: 'pincode' },
  depository: { col: 'depository', upper: true },
  demat_dp_id: { col: 'demat_dp_id', upper: true },
  demat_client_id: { col: 'demat_client_id' },
};
const BANK_FIELDS: Record<string, { col: string; re?: RegExp; upper?: boolean }> = {
  bank_name: { col: 'bank_name' },
  bank_account_number: { col: 'account_number' },
  bank_ifsc: { col: 'ifsc', re: IFSC_RE, upper: true },
};

export async function fixField(db: Db, actor: AuthUser, customerId: number, field: string, rawValue: string) {
  const { assertCustomerVisible } = await import('../../lib/visibility.js');
  await assertCustomerVisible(db, actor, customerId); // can't fix what you can't see
  const cust = (await db.query('SELECT id FROM customers WHERE id = $1', [customerId])).rows[0];
  if (!cust) throw errors.notFound('Customer not found');

  const spec = CUSTOMER_FIELDS[field] ?? BANK_FIELDS[field];
  if (!spec) throw errors.badRequest(`Field '${field}' is not editable here`);

  let value = String(rawValue ?? '').trim();
  if (spec.upper) value = value.toUpperCase();
  if ('digits' in spec && spec.digits) value = value.replace(/\D/g, '');
  if (field === 'depository' && value && !DEPOSITORIES.includes(value)) throw errors.badRequest('Depository must be NSDL or CDSL');
  if (spec.re && value && !spec.re.test(value)) throw errors.badRequest(`${field} is not in the expected format`);

  return db.withTx(async (tx) => {
    if (BANK_FIELDS[field]) {
      const bank = (await tx.query<{ id: string }>(
        'SELECT id FROM customer_bank_accounts WHERE customer_id = $1 ORDER BY is_active DESC NULLS LAST, id DESC LIMIT 1', [customerId])).rows[0];
      if (!bank) throw errors.badRequest('No bank account on file — add one from the customer profile first');
      const before = (await tx.query(`SELECT ${BANK_FIELDS[field]!.col} AS v FROM customer_bank_accounts WHERE id = $1`, [Number(bank.id)])).rows[0];
      await tx.query(`UPDATE customer_bank_accounts SET ${BANK_FIELDS[field]!.col} = $1 WHERE id = $2`, [value || null, Number(bank.id)]);
      await writeAudit(tx, { actorId: actor.id, action: 'bgv.fix-field', entityType: 'customer_bank_accounts', entityId: Number(bank.id), before, after: { [field]: value } });
      return { ok: true, field, value };
    }
    const col = CUSTOMER_FIELDS[field]!.col;
    const before = (await tx.query(`SELECT ${col} AS v FROM customers WHERE id = $1`, [customerId])).rows[0];
    await tx.query(`UPDATE customers SET ${col} = $1, updated_at = now() WHERE id = $2`, [value || null, customerId]);
    // Saving a full Aadhaar mirrors the last 4 into the legacy column so older
    // read paths keep working (spec §5).
    if (field === 'aadhaar' && AADHAAR_RE.test(value)) {
      await tx.query('UPDATE customers SET aadhaar_last4 = $1 WHERE id = $2', [value.slice(-4), customerId]);
    }
    await writeAudit(tx, { actorId: actor.id, action: 'bgv.fix-field', entityType: 'customers', entityId: customerId, before, after: { [field]: field === 'aadhaar' ? maskTail(value) : value } });
    return { ok: true, field, value: field === 'aadhaar' ? maskTail(value) : value };
  });
}

/** Admin-only; refuses unless all five KYC documents are on file (spec §5). */
export async function markVerified(db: Db, actor: AuthUser, customerId: number) {
  const { assertCustomerVisible } = await import('../../lib/visibility.js');
  await assertCustomerVisible(db, actor, customerId);
  const cust = (await db.query<{ id: string; kyc_status: string }>('SELECT id, kyc_status FROM customers WHERE id = $1', [customerId])).rows[0];
  if (!cust) throw errors.notFound('Customer not found');
  const rows = (await db.query<{ doc_type: string }>('SELECT DISTINCT doc_type FROM customer_documents WHERE customer_id = $1', [customerId])).rows;
  const have = new Set(rows.map((r) => canonicalOf(r.doc_type)).filter(Boolean) as string[]);
  const missing = KYC_DOC_TYPES.filter((t) => !have.has(t));
  if (missing.length) throw errors.badRequest(`Cannot verify — missing document(s): ${missing.join(', ')}`);

  return db.withTx(async (tx) => {
    await tx.query("UPDATE customers SET kyc_status = 'Verified', updated_at = now() WHERE id = $1", [customerId]);
    await writeAudit(tx, { actorId: actor.id, action: 'bgv.mark-verified', entityType: 'customers', entityId: customerId, before: { kyc_status: cust.kyc_status }, after: { kyc_status: 'Verified' } });
    return { ok: true, kyc_status: 'Verified' };
  });
}
