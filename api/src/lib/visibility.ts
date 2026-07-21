/**
 * Shared ownership/scope guards for by-id resource access (docs/03 §2).
 *
 * Document/PDF/receipt endpoints take a raw numeric id; without these guards an
 * own-scope user (branch_staff / agent) could enumerate ids and pull any
 * customer's SOA/receipt/bond/allotment — an IDOR. Call the matching assert
 * BEFORE rendering; it 404s (not 403 — don't confirm the id exists) when the
 * resource is outside the caller's scope. (Review 2026-07-21.)
 */
import type { Db } from '../db/types.js';
import type { AuthUser } from './authUser.js';
import { errors } from './errors.js';
import { scopeFor, scopeWhere } from './scope.js';

const CUSTOMER_COLS = {
  userCol: 'c.enrolled_by_user_id',
  agentCol: 'c.enrolled_by_agent_id',
  branchCol: 'c.branch_id',
  selfIdCol: 'c.id',
};
const APP_COLS = {
  userCol: 'a.enrolled_by_user_id',
  agentCol: 'a.enrolled_by_agent_id',
  branchCol: 'c.branch_id',
};

/** Throw 404 unless `customerId` is within the actor's scope. */
export async function assertCustomerVisible(db: Db, actor: AuthUser, customerId: number): Promise<void> {
  const sc = scopeWhere(scopeFor(actor), CUSTOMER_COLS, 1);
  const { rowCount } = await db.query(
    `SELECT 1 FROM customers c WHERE c.id = $1 AND ${sc.sql}`,
    [customerId, ...sc.params],
  );
  if (!rowCount) throw errors.notFound('Not found');
}

/** Throw 404 unless `applicationId`'s customer is within the actor's scope. */
export async function assertApplicationVisible(db: Db, actor: AuthUser, applicationId: number): Promise<void> {
  const sc = scopeWhere(scopeFor(actor), APP_COLS, 1);
  const { rowCount } = await db.query(
    `SELECT 1 FROM applications a JOIN customers c ON c.id = a.customer_id WHERE a.id = $1 AND ${sc.sql}`,
    [applicationId, ...sc.params],
  );
  if (!rowCount) throw errors.notFound('Not found');
}
