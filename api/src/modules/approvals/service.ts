/**
 * Generic maker-checker engine (docs/03 §4, docs/08 core rule).
 *
 * 🔒 Rule zero: nobody approves their own submission, and no single person
 * appears twice in a multi-level chain — enforced here for EVERY role,
 * including Super Admin. Two distinct humans minimum per approval.
 *
 * Callbacks: modules register `onFinalApprove(type, cb)` / `onReject(type, cb)`;
 * they run INSIDE the approval transaction so side-effects commit atomically.
 */
import type { Db } from '../../db/types.js';
import type { AuthUser } from '../../lib/authUser.js';
import type { Permission } from '@new-wealth/shared';
import { errors } from '../../lib/errors.js';
import { writeAudit } from '../../lib/audit.js';
import { nextCode } from '../../lib/sequences.js';
import { typeDef, type ChainLevel } from './config.js';

type Callback = (tx: Db, request: ApprovalRow) => Promise<void>;
const onFinalApproveReg = new Map<string, Callback>();
const onRejectReg = new Map<string, Callback>();

export function registerOnFinalApprove(type: string, cb: Callback): void {
  onFinalApproveReg.set(type, cb);
}
export function registerOnReject(type: string, cb: Callback): void {
  onRejectReg.set(type, cb);
}

export interface ApprovalRow {
  id: number;
  request_no: string;
  request_type: string;
  entity_type: string | null;
  entity_id: string | null;
  level: number;
  max_levels: number;
  chain: ChainLevel[];
  status: string;
  maker_user_id: number | null;
  metadata: Record<string, unknown>;
}

function rowToApproval(r: Record<string, unknown>): ApprovalRow {
  return {
    id: Number(r.id),
    request_no: String(r.request_no),
    request_type: String(r.request_type),
    entity_type: (r.entity_type as string) ?? null,
    entity_id: (r.entity_id as string) ?? null,
    level: Number(r.level),
    max_levels: Number(r.max_levels),
    chain: (r.chain as ChainLevel[]) ?? [],
    status: String(r.status),
    maker_user_id: r.maker_user_id != null ? Number(r.maker_user_id) : null,
    metadata: (r.metadata as Record<string, unknown>) ?? {},
  };
}

export interface CreateApprovalInput {
  type: string;
  entityType?: string;
  entityId?: string | number;
  makerUserId: number | null; // null for system/app-originated requests
  metadata?: Record<string, unknown>;
}

/** Create a pending approval request. Call inside the maker's transaction. */
export async function createApprovalRequest(tx: Db, input: CreateApprovalInput): Promise<ApprovalRow> {
  const def = typeDef(input.type);
  const requestNo = await nextCode(tx, 'redemption', 'REQ-{yyyy}-{seq:6}'); // shared REQ sequence
  const { rows } = await tx.query<Record<string, unknown>>(
    `INSERT INTO approval_requests (request_no, request_type, entity_type, entity_id, level, max_levels, chain, status, maker_user_id, metadata)
     VALUES ($1,$2,$3,$4,1,$5,$6,'Pending',$7,$8) RETURNING *`,
    [
      requestNo,
      input.type,
      input.entityType ?? null,
      input.entityId != null ? String(input.entityId) : null,
      def.levels.length,
      JSON.stringify(def.levels),
      input.makerUserId,
      JSON.stringify(input.metadata ?? {}),
    ]
  );
  return rowToApproval(rows[0]!);
}

async function priorApprovers(db: Db, requestId: number): Promise<number[]> {
  const { rows } = await db.query<{ approver_user_id: string }>(
    'SELECT approver_user_id FROM approval_actions WHERE approval_request_id = $1',
    [requestId]
  );
  return rows.map((r) => Number(r.approver_user_id));
}

function assertDistinctChecker(req: ApprovalRow, user: AuthUser, prior: number[]): void {
  if (req.maker_user_id === user.id) {
    throw errors.forbidden('You cannot approve your own submission');
  }
  if (prior.includes(user.id)) {
    throw errors.forbidden('You already acted on this request at an earlier level');
  }
}

function checkerPermFor(req: ApprovalRow): Permission {
  const lvl = req.chain.find((l) => l.level === req.level) ?? req.chain[req.chain.length - 1]!;
  return lvl.checkerPermission;
}

async function loadForUpdate(tx: Db, id: number): Promise<ApprovalRow> {
  const { rows } = await tx.query<Record<string, unknown>>(
    'SELECT * FROM approval_requests WHERE id = $1 FOR UPDATE',
    [id]
  );
  if (!rows[0]) throw errors.notFound('Approval request not found');
  return rowToApproval(rows[0]);
}

/** Approve at the current level. Advances or finalises. */
export async function approve(
  db: Db,
  user: AuthUser,
  id: number,
  extra?: Record<string, unknown>
): Promise<ApprovalRow> {
  return db.withTx(async (tx) => {
    const req = await loadForUpdate(tx, id);
    if (req.status !== 'Pending') throw errors.conflict('Request is not pending');
    if (!user.permissions.includes(checkerPermFor(req))) {
      throw errors.forbidden('You are not a checker for this level');
    }
    // An approver may correct the maker's input at the moment of approval; only
    // whitelisted fields are applied, and the change is audited.
    const edits = (extra?.edits ?? null) as Record<string, unknown> | null;
    if (edits && req.entity_type === 'applications' && req.entity_id) {
      const sets: string[] = []; const params: unknown[] = [];
      for (const f of EDITABLE_APPLICATION_FIELDS) {
        if (!(f in edits)) continue;
        const raw = edits[f];
        const val = raw === '' || raw === undefined ? null : raw;
        params.push(f === 'total_amount' && val !== null ? Number(val) : val);
        sets.push(`${f} = $${params.length}`);
      }
      if (sets.length) {
        params.push(Number(req.entity_id));
        await tx.query(`UPDATE applications SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length}`, params);
        await writeAudit(tx, {
          actorId: user.id, action: 'approval.edit-on-approve',
          entityType: 'applications', entityId: Number(req.entity_id), after: edits,
        });
      }
    }
    const prior = await priorApprovers(tx, id);
    assertDistinctChecker(req, user, prior);

    await tx.query(
      'INSERT INTO approval_actions (approval_request_id, level, approver_user_id, action) VALUES ($1,$2,$3,$4)',
      [id, req.level, user.id, 'approve']
    );

    if (extra && Object.keys(extra).length) {
      req.metadata = { ...req.metadata, ...extra };
      await tx.query('UPDATE approval_requests SET metadata = $1 WHERE id = $2', [JSON.stringify(req.metadata), id]);
    }

    if (req.level < req.max_levels) {
      await tx.query('UPDATE approval_requests SET level = level + 1, updated_at = now() WHERE id = $1', [id]);
      req.level += 1;
    } else {
      await tx.query("UPDATE approval_requests SET status = 'Approved', updated_at = now() WHERE id = $1", [id]);
      req.status = 'Approved';
      const cb = onFinalApproveReg.get(req.request_type);
      if (cb) await cb(tx, req);
    }
    await writeAudit(tx, {
      actorId: user.id,
      action: 'approval.approve',
      entityType: 'approval_requests',
      entityId: id,
      after: { level: req.level, status: req.status },
    });
    return req;
  });
}

/** Reject at the current level — terminal. */
export async function reject(db: Db, user: AuthUser, id: number, reason: string): Promise<ApprovalRow> {
  return db.withTx(async (tx) => {
    const req = await loadForUpdate(tx, id);
    if (req.status !== 'Pending') throw errors.conflict('Request is not pending');
    if (!user.permissions.includes(checkerPermFor(req))) {
      throw errors.forbidden('You are not a checker for this level');
    }
    const prior = await priorApprovers(tx, id);
    assertDistinctChecker(req, user, prior);

    await tx.query(
      'INSERT INTO approval_actions (approval_request_id, level, approver_user_id, action, reason) VALUES ($1,$2,$3,$4,$5)',
      [id, req.level, user.id, 'reject', reason]
    );
    await tx.query("UPDATE approval_requests SET status = 'Rejected', updated_at = now() WHERE id = $1", [id]);
    req.status = 'Rejected';
    const cb = onRejectReg.get(req.request_type);
    if (cb) await cb(tx, req);
    await writeAudit(tx, {
      actorId: user.id,
      action: 'approval.reject',
      entityType: 'approval_requests',
      entityId: id,
      after: { reason },
    });
    return req;
  });
}

/** Queue for the user: pending requests they can currently act on, plus a
 * `canAct` flag (own submissions are shown but not actionable). */
export async function getQueue(db: Db, user: AuthUser): Promise<Array<ApprovalRow & { canAct: boolean; subject: string; amount: number | null }>> {
  const { rows } = await db.query<Record<string, unknown>>(
    "SELECT * FROM approval_requests WHERE status = 'Pending' ORDER BY created_at DESC"
  );
  const out: Array<ApprovalRow & { canAct: boolean; subject: string; amount: number | null }> = [];
  for (const r of rows) {
    const req = rowToApproval(r);
    const hasPerm = user.permissions.includes(checkerPermFor(req));
    if (!hasPerm) continue; // not their queue at all
    const prior = await priorApprovers(db, req.id);
    const canAct = req.maker_user_id !== user.id && !prior.includes(user.id);
    // Carry the subject so the queue can say WHAT each request is about
    // instead of just its type + request number.
    const desc = await describeRequest(db, req);
    out.push({ ...req, canAct, subject: desc.subject, amount: desc.amount });
  }
  return out;
}

export async function getById(db: Db, id: number): Promise<ApprovalRow | null> {
  const { rows } = await db.query<Record<string, unknown>>('SELECT * FROM approval_requests WHERE id = $1', [id]);
  return rows[0] ? rowToApproval(rows[0]) : null;
}

/**
 * The applications a pending batch approval will act on — the same predicate
 * the on-approve handler uses (activation: PendingActivation in the series;
 * allotment: Active and not yet allotted). Snapshot at read time.
 */
/** Fields an approver may correct while approving an investment request. Only
 * these are accepted from the client — anything else in the payload is ignored. */
export const EDITABLE_APPLICATION_FIELDS = [
  'total_amount', 'date_money_received', 'collection_method',
  'collection_reference', 'referred_by_text', 'interest_start_date',
] as const;

/** The maker's input, pre-filled so the approver sees (and can correct) exactly
 * what was entered. Null for request types with no application behind them. */
export async function editableForRequest(db: Db, req: { entity_type?: string | null; entity_id?: string | null }) {
  if (req.entity_type !== 'applications' || !req.entity_id) return null;
  const r = (await db.query<Record<string, unknown>>(
    `SELECT a.id, a.application_no, a.total_amount, a.date_money_received, a.collection_method,
            a.collection_reference, a.referred_by_text, a.interest_start_date, a.created_at,
            a.status, s.code AS series_code, sc.code AS scheme_code,
            sc.coupon_rate_pct, sc.tenure_months,
            c.full_name AS customer, c.customer_code, c.pan
       FROM applications a
       JOIN customers c ON c.id = a.customer_id
       JOIN series s ON s.id = a.series_id
       LEFT JOIN application_lines l ON l.application_id = a.id
       LEFT JOIN schemes sc ON sc.id = l.scheme_id
      WHERE a.id = $1 LIMIT 1`, [Number(req.entity_id)])).rows[0];
  if (!r) return null;
  const d = (v: unknown) => (v ? String(v).slice(0, 10) : '');
  return {
    application_id: Number(r.id),
    readonly: {
      customer: `${r.customer} (${r.customer_code})`,
      pan: r.pan ?? '—',
      application_no: r.application_no,
      series: r.series_code,
      scheme: r.scheme_code ?? '—',
      rate: r.coupon_rate_pct != null ? `${Number(r.coupon_rate_pct)}%` : '—',
      tenure: r.tenure_months != null ? `${r.tenure_months} months` : '—',
      created_at: d(r.created_at),
      status: r.status,
    },
    fields: {
      total_amount: Number(r.total_amount),
      date_money_received: d(r.date_money_received),
      collection_method: (r.collection_method ?? '') as string,
      collection_reference: (r.collection_reference ?? '') as string,
      referred_by_text: (r.referred_by_text ?? '') as string,
      interest_start_date: d(r.interest_start_date),
    },
  };
}

export async function coveredApplications(db: Db, request: { request_type?: string; metadata?: Record<string, unknown> }) {
  const type = String(request.request_type ?? '');
  const seriesId = Number((request.metadata as Record<string, unknown> | undefined)?.series_id ?? 0);
  if (!seriesId || (type !== 'activation_batch' && type !== 'allotment_batch')) return null;
  const cond = type === 'activation_batch'
    ? "a.status = 'PendingActivation'"
    : "a.status = 'Active' AND a.allotment_date IS NULL";
  const { rows } = await db.query(
    `SELECT a.application_no, c.full_name AS customer, c.customer_code, a.total_amount AS amount,
            a.date_money_received, s.code AS series_code
     FROM applications a JOIN customers c ON c.id = a.customer_id JOIN series s ON s.id = a.series_id
     WHERE a.series_id = $1 AND ${cond}
     ORDER BY a.total_amount DESC, a.application_no`, [seriesId]);
  return rows;
}

/**
 * A human description of what a request is actually about, so the Approvals
 * queue can show the subject up front and the detail panel can show real
 * information instead of the raw request record. Resolved from the entity the
 * request points at, falling back to its metadata for types with no row of
 * their own.
 */
export interface RequestDescription {
  subject: string;            // "Ramesh Kumar · APP-2026-000784"
  amount: number | null;      // the ₹ figure that matters, when there is one
  facts: Array<{ label: string; value: string }>;
}

const money = (v: unknown) => (v == null ? null : Number(v));
const fact = (label: string, value: unknown): { label: string; value: string } | null =>
  value == null || value === '' ? null : { label, value: String(value) };
const clean = (xs: Array<{ label: string; value: string } | null>) => xs.filter((x): x is { label: string; value: string } => !!x);
const dateOnly = (v: unknown) => (v == null ? null : String(toISO(v)));
const toISO = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

export async function describeRequest(db: Db, req: ApprovalRow): Promise<RequestDescription> {
  const id = req.entity_id ? Number(req.entity_id) : null;
  const meta = req.metadata ?? {};

  if (id && req.entity_type === 'applications') {
    const r = (await db.query<Record<string, unknown>>(
      `SELECT a.application_no, a.total_amount, a.status, a.date_money_received, a.referred_by_text,
              c.full_name AS customer, c.customer_code, s.code AS series_code,
              u.full_name AS enrolled_by
         FROM applications a JOIN customers c ON c.id = a.customer_id
         JOIN series s ON s.id = a.series_id
         LEFT JOIN users u ON u.id = a.enrolled_by_user_id
        WHERE a.id = $1`, [id])).rows[0];
    if (r) return {
      subject: `${r.customer} · ${r.application_no}`,
      amount: money(r.total_amount),
      facts: clean([
        fact('Customer', `${r.customer} (${r.customer_code})`),
        fact('Application', r.application_no),
        fact('Series', r.series_code),
        fact('Money received', dateOnly(r.date_money_received) ?? 'not recorded'),
        fact('Referred by', r.referred_by_text ?? 'Direct'),
        fact('Enrolled by', r.enrolled_by),
        fact('Current status', r.status),
      ]),
    };
  }

  if (id && req.entity_type === 'redemptions') {
    const r = (await db.query<Record<string, unknown>>(
      `SELECT r.redemption_no, r.type, r.principal, r.penalty, r.net_payment, r.redemption_date,
              a.application_no, c.full_name AS customer
         FROM redemptions r JOIN applications a ON a.id = r.application_id
         JOIN customers c ON c.id = a.customer_id
        WHERE r.id = $1`, [id])).rows[0];
    if (r) return {
      subject: `${r.customer} · ${r.application_no}`,
      amount: money(r.net_payment),
      facts: clean([
        fact('Customer', r.customer),
        fact('Application', r.application_no),
        fact('Redemption', `${r.redemption_no} (${r.type})`),
        fact('Principal', r.principal),
        fact('Penalty', r.penalty),
        fact('Net payable', r.net_payment),
        fact('Redemption date', dateOnly(r.redemption_date)),
      ]),
    };
  }

  if (id && req.entity_type === 'customers') {
    const r = (await db.query<Record<string, unknown>>(
      'SELECT full_name, customer_code, phone, pan FROM customers WHERE id = $1', [id])).rows[0];
    if (r) {
      const changes = meta.changes ? JSON.stringify(meta.changes) : null;
      let toUser: string | null = null;
      if (meta.toUserId) {
        toUser = String((await db.query<{ full_name: string }>('SELECT full_name FROM users WHERE id = $1', [Number(meta.toUserId)])).rows[0]?.full_name ?? '');
      }
      return {
        subject: `${r.full_name}${r.customer_code ? ` · ${r.customer_code}` : ''}`,
        amount: null,
        facts: clean([
          fact('Customer', `${r.full_name}${r.customer_code ? ` (${r.customer_code})` : ''}`),
          fact('Phone', r.phone), fact('PAN', r.pan),
          fact('Hand over to', toUser),
          fact('Reason', meta.reason),
          fact('Changes', changes),
        ]),
      };
    }
  }

  if (id && req.entity_type === 'payout_batches') {
    const r = (await db.query<Record<string, unknown>>(
      `SELECT b.payout_date, b.total_net, b.status,
              (SELECT count(*)::int FROM disbursement_schedule d WHERE d.batch_id = b.id) AS rows
         FROM payout_batches b WHERE b.id = $1`, [id])).rows[0];
    if (r) return {
      subject: `Interest payout · ${dateOnly(r.payout_date)}`,
      amount: money(r.total_net),
      facts: clean([
        fact('Payout date', dateOnly(r.payout_date)),
        fact('Payments in batch', r.rows),
        fact('Net amount', r.total_net),
        fact('UTR', meta.utr),
        fact('Batch status', r.status),
      ]),
    };
  }

  if (req.request_type === 'allotment_batch') {
    return {
      subject: `${meta.series_code ?? 'Series'} · allotment`,
      amount: null,
      facts: clean([
        fact('Series', meta.series_code),
        fact('Allotment date', meta.allotment_date),
        fact('ISIN', meta.isin),
        fact('Investments covered', meta.count),
      ]),
    };
  }

  if (id && req.entity_type === 'agents') {
    const r = (await db.query<Record<string, unknown>>(
      'SELECT full_name, agent_code, commission_status, commission_rate_pct FROM agents WHERE id = $1', [id])).rows[0];
    if (r) return {
      subject: `${r.full_name} · ${r.agent_code}`,
      amount: null,
      facts: clean([
        fact('Agent', `${r.full_name} (${r.agent_code})`),
        fact('Commission status', r.commission_status),
        fact('Requested rate %', meta.rate_pct ?? r.commission_rate_pct),
        fact('Payout mode', meta.payout_mode),
      ]),
    };
  }

  if (id && req.entity_type === 'users') {
    const r = (await db.query<Record<string, unknown>>(
      'SELECT full_name, email, phone, code FROM users WHERE id = $1', [id])).rows[0];
    if (r) return {
      subject: `${r.full_name}${meta.kind ? ` · ${meta.kind}` : ''}`,
      amount: null,
      facts: clean([
        fact('Name', r.full_name), fact('Kind', meta.kind),
        fact('Mobile', meta.mobile ?? r.phone), fact('Email', r.email),
        fact('Employee ID', meta.employee_id), fact('Agent code', meta.agent_code),
      ]),
    };
  }

  // Fallback: no dedicated row — surface the metadata readably rather than the
  // raw request record.
  return {
    subject: String(meta.application_no ?? meta.series_code ?? meta.name ?? req.request_no),
    amount: money(meta.net_payment ?? meta.amount ?? null),
    facts: clean(Object.entries(meta).map(([k, v]) =>
      fact(k.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()), typeof v === 'object' ? JSON.stringify(v) : v))),
  };
}
