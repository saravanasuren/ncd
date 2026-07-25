/**
 * Escrow reconciliation service.
 *
 * Ingests an SBI escrow-account statement, records each credit, and PROPOSES who
 * paid — matching by UTR (against a UTR staff typed on an application), then by
 * remitter account (against a customer's bank account), then by name. The
 * proposal is never applied automatically: a human confirms/assigns on the
 * reconciliation screen, and the existing investment approval flow is untouched
 * (owner: "flag for human").
 *
 * The two dashboard readings come from `escrowSummary`:
 *   - escrow balance      — the latest statement's closing balance
 *   - received-not-enrolled — credits from payers who aren't in the system yet
 */
import type { Db } from '../../db/types.js';
import type { AuthUser } from '../../lib/authUser.js';
import { errors } from '../../lib/errors.js';
import { writeAudit } from '../../lib/audit.js';
import { getSettingsMap } from '../settings/service.js';
import {
  isNcdUnitMultiple, isCompanySelfPayment, normaliseName,
  ESCROW_COMPANY_FLOOR_DEFAULT, type EscrowMatchStatus, type EscrowMatchMethod,
} from '@new-wealth/shared';
import { parseEscrowFile, type ParsedEscrowLine } from './parse.js';

interface EscrowConfig {
  companyAccounts: Set<string>;
  floor: number;
}

async function loadConfig(db: Db): Promise<EscrowConfig> {
  const s = await getSettingsMap(db);
  const accts = String(s['escrow.company_accounts'] ?? '')
    .split(',').map((x) => x.replace(/[^0-9]/g, '')).filter(Boolean);
  const floor = Number(s['escrow.company_floor'] ?? ESCROW_COMPANY_FLOOR_DEFAULT) || ESCROW_COMPANY_FLOOR_DEFAULT;
  return { companyAccounts: new Set(accts), floor };
}

interface Proposal {
  status: EscrowMatchStatus;
  method: EscrowMatchMethod | null;
  confidence: 'high' | 'medium' | 'low' | null;
  customerId: number | null;
  applicationId: number | null;
  flagReason: string | null;
}

/** Decide the proposed disposition of one parsed line (DB-backed match). */
async function propose(tx: Db, line: ParsedEscrowLine, cfg: EscrowConfig): Promise<Proposal> {
  const none: Proposal = { status: 'Unmatched', method: null, confidence: null, customerId: null, applicationId: null, flagReason: null };

  if (line.direction === 'debit') return { ...none, status: 'Debit' };
  if (isCompanySelfPayment({ remitterAccount: line.remitter_account, remitterName: line.remitter_name } as any, cfg.companyAccounts)) {
    return { ...none, status: 'Company' };
  }
  if (!isNcdUnitMultiple(line.amount)) {
    return { ...none, status: 'Flagged', flagReason: 'Amount is not a whole multiple of ₹1,00,000' };
  }

  // 1) UTR → a UTR staff already recorded on an application (strongest link).
  if (line.utr) {
    const a = (await tx.query<{ id: string; customer_id: string }>(
      `SELECT id, customer_id FROM applications
        WHERE collection_reference IS NOT NULL
          AND upper(btrim(collection_reference)) = upper(btrim($1))
        ORDER BY id LIMIT 2`, [line.utr])).rows;
    if (a.length === 1) return { status: 'Matched', method: 'utr', confidence: 'high', customerId: Number(a[0]!.customer_id), applicationId: Number(a[0]!.id), flagReason: null };
  }

  // 2) Remitter account → a customer's bank account (skip SBI clearing pools).
  if (line.remitter_account && !line.remitter_account_pooled) {
    const c = (await tx.query<{ customer_id: string }>(
      `SELECT customer_id FROM customer_bank_accounts
        WHERE regexp_replace(account_number, '[^0-9]', '', 'g') = $1
        ORDER BY is_active DESC, id LIMIT 2`, [line.remitter_account])).rows;
    if (c.length === 1) return { status: 'Matched', method: 'account', confidence: 'high', customerId: Number(c[0]!.customer_id), applicationId: null, flagReason: null };
  }

  // 3) Name → a customer, compared on a punctuation/honorific-stripped key.
  if (line.remitter_name) {
    const key = normaliseName(line.remitter_name).replace(/[^A-Z0-9]/g, '');
    if (key.length >= 4) {
      const c = (await tx.query<{ id: string }>(
        `SELECT id FROM customers
          WHERE is_active AND archived_at IS NULL
            AND regexp_replace(upper(full_name), '[^A-Z0-9]', '', 'g') = $1
          ORDER BY id LIMIT 2`, [key])).rows;
      if (c.length === 1) return { status: 'Matched', method: 'name', confidence: 'medium', customerId: Number(c[0]!.id), applicationId: null, flagReason: null };
    }
  }

  // No link. A bare cheque (no name/account/UTR) is unidentifiable from the
  // statement alone; anything else is a real credit whose payer isn't enrolled.
  if (line.pay_type === 'Cheque' && !line.remitter_name && !line.remitter_account) {
    return { ...none, status: 'Unidentified', flagReason: 'Cheque credit with no payer details — match by the cheque number recorded at collection' };
  }
  return { ...none, status: 'NotEnrolled' };
}

export interface UploadResult {
  statement_id: number;
  line_count: number;
  credit_count: number;
  inserted: number;
  duplicates: number;
  matched: number;
  not_enrolled: number;
  flagged: number;
}

export async function uploadStatement(db: Db, actor: AuthUser, filename: string, buf: Buffer): Promise<UploadResult> {
  const parsed = await parseEscrowFile(buf, filename);
  if (!parsed.lines.length) throw errors.badRequest('No transaction rows found in the file.');
  const cfg = await loadConfig(db);

  return db.withTx(async (tx) => {
    const credits = parsed.lines.filter((l) => l.direction === 'credit').length;
    const stmt = (await tx.query<{ id: string }>(
      `INSERT INTO escrow_statements (account_number, ifsc, period_from, period_to, opening_balance, closing_balance, line_count, credit_count, source_file, uploaded_by_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [parsed.meta.account_number, parsed.meta.ifsc, parsed.meta.period_from, parsed.meta.period_to,
       parsed.meta.opening_balance, parsed.meta.closing_balance, parsed.lines.length, credits, filename, actor.id])).rows[0]!;
    const statementId = Number(stmt.id);

    const res: UploadResult = { statement_id: statementId, line_count: parsed.lines.length, credit_count: credits, inserted: 0, duplicates: 0, matched: 0, not_enrolled: 0, flagged: 0 };

    for (const line of parsed.lines) {
      // Idempotent: the same bank line never ingests twice, even across
      // overlapping statement windows.
      const dup = (await tx.query<{ id: string }>('SELECT id FROM escrow_statement_lines WHERE dedupe_key = $1 LIMIT 1', [line.dedupe_key])).rows[0];
      if (dup) { res.duplicates++; continue; }

      const p = await propose(tx, line, cfg);
      await tx.query(
        `INSERT INTO escrow_statement_lines
          (statement_id, row_no, txn_date, value_date, amount, direction, pay_type, utr, remitter_account, remitter_account_pooled,
           remitter_name, cheque_no, presenting_bank, description, ref_no, balance,
           match_status, match_method, match_confidence, matched_customer_id, matched_application_id, flag_reason, dedupe_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)`,
        [statementId, line.row_no, line.txn_date, line.value_date, line.amount, line.direction, line.pay_type, line.utr,
         line.remitter_account, line.remitter_account_pooled, line.remitter_name, line.cheque_no, line.presenting_bank,
         line.description, line.ref_no, line.balance,
         p.status, p.method, p.confidence, p.customerId, p.applicationId, p.flagReason, line.dedupe_key]);
      res.inserted++;
      if (p.status === 'Matched') res.matched++;
      else if (p.status === 'NotEnrolled' || p.status === 'Unidentified') res.not_enrolled++;
      else if (p.status === 'Flagged') res.flagged++;
    }
    await writeAudit(tx, { actorId: actor.id, action: 'escrow.upload', entityType: 'escrow_statements', entityId: statementId, after: res });
    return res;
  });
}

export async function listStatements(db: Db) {
  return (await db.query(
    `SELECT s.id, s.account_number, s.ifsc, s.period_from, s.period_to, s.opening_balance, s.closing_balance,
            s.line_count, s.credit_count, s.source_file, s.created_at, u.full_name AS uploaded_by
       FROM escrow_statements s LEFT JOIN users u ON u.id = s.uploaded_by_user_id
      ORDER BY s.id DESC LIMIT 100`)).rows;
}

export async function listLines(db: Db, filters: { status?: string; statementId?: number } = {}) {
  const conds: string[] = [];
  const params: unknown[] = [];
  if (filters.statementId) { params.push(filters.statementId); conds.push(`l.statement_id = $${params.length}`); }
  if (filters.status) { params.push(filters.status); conds.push(`l.match_status = $${params.length}`); }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  return (await db.query(
    `SELECT l.*, c.full_name AS matched_customer_name, c.customer_code AS matched_customer_code,
            a.application_no AS matched_application_no
       FROM escrow_statement_lines l
       LEFT JOIN customers c ON c.id = l.matched_customer_id
       LEFT JOIN applications a ON a.id = l.matched_application_id
       ${where}
      ORDER BY l.txn_date DESC, l.id DESC LIMIT 1000`, params)).rows;
}

/** Confirm a proposed match as-is (human sign-off). */
export async function confirmLine(db: Db, actor: AuthUser, lineId: number) {
  return db.withTx(async (tx) => {
    const line = (await tx.query<{ match_status: string; matched_customer_id: string | null }>('SELECT match_status, matched_customer_id FROM escrow_statement_lines WHERE id = $1', [lineId])).rows[0];
    if (!line) throw errors.notFound('Statement line not found');
    if (line.match_status !== 'Matched' || !line.matched_customer_id) throw errors.badRequest('Only a proposed match can be confirmed. Use assign for the rest.');
    await tx.query('UPDATE escrow_statement_lines SET reviewed_by_user_id = $1, reviewed_at = now() WHERE id = $2', [actor.id, lineId]);
    await writeAudit(tx, { actorId: actor.id, action: 'escrow.confirm', entityType: 'escrow_statement_lines', entityId: lineId });
    return { ok: true };
  });
}

/** Manually assign a line to a customer (overrides the proposal). */
export async function assignLine(db: Db, actor: AuthUser, lineId: number, customerId: number) {
  return db.withTx(async (tx) => {
    const cust = (await tx.query<{ id: string }>('SELECT id FROM customers WHERE id = $1 AND archived_at IS NULL', [customerId])).rows[0];
    if (!cust) throw errors.notFound('Customer not found');
    const upd = await tx.query(
      `UPDATE escrow_statement_lines
          SET match_status = 'Matched', match_method = 'manual', match_confidence = 'high',
              matched_customer_id = $1, flag_reason = NULL, reviewed_by_user_id = $2, reviewed_at = now()
        WHERE id = $3`, [customerId, actor.id, lineId]);
    if (!upd.rowCount) throw errors.notFound('Statement line not found');
    await writeAudit(tx, { actorId: actor.id, action: 'escrow.assign', entityType: 'escrow_statement_lines', entityId: lineId, after: { customerId } });
    return { ok: true };
  });
}

/** Dismiss a line from reconciliation (e.g. a duplicate refund, a test credit). */
export async function ignoreLine(db: Db, actor: AuthUser, lineId: number, reason?: string) {
  return db.withTx(async (tx) => {
    const upd = await tx.query(
      `UPDATE escrow_statement_lines SET match_status = 'Ignored', flag_reason = $1, reviewed_by_user_id = $2, reviewed_at = now() WHERE id = $3`,
      [reason ?? null, actor.id, lineId]);
    if (!upd.rowCount) throw errors.notFound('Statement line not found');
    await writeAudit(tx, { actorId: actor.id, action: 'escrow.ignore', entityType: 'escrow_statement_lines', entityId: lineId, after: { reason } });
    return { ok: true };
  });
}

/** Dashboard tiles + drill-down breakup. */
export async function escrowSummary(db: Db) {
  const latest = (await db.query<{ closing_balance: string | null; period_to: string | null; account_number: string | null }>(
    'SELECT closing_balance, period_to, account_number FROM escrow_statements ORDER BY id DESC LIMIT 1')).rows[0];

  const byStatus = (await db.query<{ match_status: string; total: string; n: string }>(
    `SELECT match_status, COALESCE(SUM(amount),0) AS total, COUNT(*) AS n
       FROM escrow_statement_lines WHERE direction = 'credit' GROUP BY match_status`)).rows;
  const sum = (s: string) => Number(byStatus.find((r) => r.match_status === s)?.total ?? 0);
  const cnt = (s: string) => Number(byStatus.find((r) => r.match_status === s)?.n ?? 0);

  const investors = (await db.query<{ matched_customer_id: string; full_name: string; customer_code: string; total: string; n: string }>(
    `SELECT l.matched_customer_id, c.full_name, c.customer_code, SUM(l.amount) AS total, COUNT(*) AS n
       FROM escrow_statement_lines l JOIN customers c ON c.id = l.matched_customer_id
      WHERE l.match_status = 'Matched' AND l.direction = 'credit'
      GROUP BY l.matched_customer_id, c.full_name, c.customer_code
      ORDER BY SUM(l.amount) DESC`)).rows;

  const notEnrolledTotal = sum('NotEnrolled') + sum('Unidentified');
  const notEnrolledCount = cnt('NotEnrolled') + cnt('Unidentified');

  return {
    escrow_balance: latest?.closing_balance != null ? Number(latest.closing_balance) : null,
    escrow_account: latest?.account_number ?? null,
    as_of: latest?.period_to ?? null,
    not_enrolled_total: notEnrolledTotal,
    not_enrolled_count: notEnrolledCount,
    breakup: {
      company: sum('Company'),
      enrolled_total: sum('Matched'),
      enrolled_investors: investors.map((r) => ({ customer_id: Number(r.matched_customer_id), full_name: r.full_name, customer_code: r.customer_code, total: Number(r.total), count: Number(r.n) })),
      not_enrolled_total: notEnrolledTotal,
      flagged_total: sum('Flagged'),
      flagged_count: cnt('Flagged'),
      ignored_total: sum('Ignored'),
    },
  };
}
