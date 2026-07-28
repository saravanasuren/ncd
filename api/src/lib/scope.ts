/**
 * Data-scoping model (docs/03 §2). Every scoped repo query takes a Scope
 * built from the authenticated user. This is the one place that decides
 * "whose rows can this user see".
 */
import type { Role } from '@new-wealth/shared';

export type Scope =
  | { kind: 'all' }
  | { kind: 'branch'; branchIds: number[]; userId: number }
  | { kind: 'own-staff'; userId: number }
  | { kind: 'own-agent'; agentId: number | null; userId: number }
  | { kind: 'self-customer'; customerId: number | null; userId: number };

export interface ScopeUser {
  id: number;
  role: Role;
  branchIds: number[];
  agentId: number | null;
  customerId: number | null;
}

export function scopeFor(user: ScopeUser): Scope {
  switch (user.role) {
    case 'super_admin':
    case 'admin':
    case 'cxo':
    case 'ncd_manager':
      return { kind: 'all' };
    case 'branch_manager':
      return { kind: 'branch', branchIds: user.branchIds, userId: user.id };
    case 'branch_staff':
      return { kind: 'own-staff', userId: user.id };
    case 'agent':
      return { kind: 'own-agent', agentId: user.agentId, userId: user.id };
    case 'customer':
      return { kind: 'self-customer', customerId: user.customerId, userId: user.id };
    default:
      return { kind: 'own-staff', userId: user.id };
  }
}

/**
 * Build a SQL WHERE fragment + params for a scoped query over a table that
 * has `enrolled_by_user_id`, `enrolled_by_agent_id`, `branch_id`, and
 * (optionally) an `id` for the customer self case. `paramOffset` = how many
 * params already precede these (so $N numbering is correct).
 * Returns `{ sql, params }` where sql is like `(enrolled_by_user_id = $3)`.
 */
/**
 * "This staff member is the REFERRER on the row" — the same resolution the
 * reports use (reports/book.ts REFERRER): match the free-text referrer to the
 * staff user by CODE first, then by name.
 *
 * Ownership does not only follow who typed the enrolment in. A customer
 * brought in by one staff member is often keyed in by admin, which left the
 * person who actually introduced them unable to see their own customer — or
 * add their next investment (owner report 2026-07-28: Venkateswari S could
 * not see Jayakumar, whom she referred). Returns '' when the table has no
 * referrer column, so those queries keep the plain enroller rule.
 */
function referrerMatchSql(refCol: string | undefined, userParam: string): string {
  if (!refCol) return '';
  return ` OR EXISTS (
    SELECT 1 FROM users su JOIN roles sr ON sr.id = su.role_id
     WHERE su.id = ${userParam} AND su.is_staff = TRUE AND sr.name <> 'customer'
       AND btrim(COALESCE(${refCol}, '')) <> ''
       AND (upper(btrim(su.code)) = upper(btrim(${refCol}))
            OR lower(btrim(su.full_name)) = lower(btrim(${refCol}))))`;
}

export function scopeWhere(
  scope: Scope,
  cols: { userCol: string; agentCol: string; branchCol: string; selfIdCol?: string; refCol?: string },
  paramOffset = 0
): { sql: string; params: unknown[] } {
  let p = paramOffset;
  switch (scope.kind) {
    case 'all':
      return { sql: 'TRUE', params: [] };
    case 'branch': {
      // Their branches OR their own enrolments OR what they referred.
      const branchParam = `$${++p}`;
      const userParam = `$${++p}`;
      return {
        sql: `(${cols.branchCol} = ANY(${branchParam}) OR ${cols.userCol} = ${userParam}${referrerMatchSql(cols.refCol, userParam)})`,
        params: [scope.branchIds, scope.userId],
      };
    }
    case 'own-staff': {
      // What they enrolled OR what they referred — see referrerMatchSql.
      const userParam = `$${++p}`;
      return {
        sql: `(${cols.userCol} = ${userParam}${referrerMatchSql(cols.refCol, userParam)})`,
        params: [scope.userId],
      };
    }
    case 'own-agent':
      return { sql: `${cols.agentCol} = $${++p}`, params: [scope.agentId] };
    case 'self-customer':
      return {
        sql: cols.selfIdCol ? `${cols.selfIdCol} = $${++p}` : 'FALSE',
        params: cols.selfIdCol ? [scope.customerId] : [],
      };
  }
}
