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
export async function getQueue(db: Db, user: AuthUser): Promise<Array<ApprovalRow & { canAct: boolean }>> {
  const { rows } = await db.query<Record<string, unknown>>(
    "SELECT * FROM approval_requests WHERE status = 'Pending' ORDER BY created_at DESC"
  );
  const out: Array<ApprovalRow & { canAct: boolean }> = [];
  for (const r of rows) {
    const req = rowToApproval(r);
    const hasPerm = user.permissions.includes(checkerPermFor(req));
    if (!hasPerm) continue; // not their queue at all
    const prior = await priorApprovers(db, req.id);
    const canAct = req.maker_user_id !== user.id && !prior.includes(user.id);
    out.push({ ...req, canAct });
  }
  return out;
}

export async function getById(db: Db, id: number): Promise<ApprovalRow | null> {
  const { rows } = await db.query<Record<string, unknown>>('SELECT * FROM approval_requests WHERE id = $1', [id]);
  return rows[0] ? rowToApproval(rows[0]) : null;
}
