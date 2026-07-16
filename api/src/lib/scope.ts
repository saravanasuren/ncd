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
export function scopeWhere(
  scope: Scope,
  cols: { userCol: string; agentCol: string; branchCol: string; selfIdCol?: string },
  paramOffset = 0
): { sql: string; params: unknown[] } {
  let p = paramOffset;
  switch (scope.kind) {
    case 'all':
      return { sql: 'TRUE', params: [] };
    case 'branch': {
      // Their branches OR their own enrolments.
      const branchParam = `$${++p}`;
      const userParam = `$${++p}`;
      return {
        sql: `(${cols.branchCol} = ANY(${branchParam}) OR ${cols.userCol} = ${userParam})`,
        params: [scope.branchIds, scope.userId],
      };
    }
    case 'own-staff':
      return { sql: `${cols.userCol} = $${++p}`, params: [scope.userId] };
    case 'own-agent':
      return { sql: `${cols.agentCol} = $${++p}`, params: [scope.agentId] };
    case 'self-customer':
      return {
        sql: cols.selfIdCol ? `${cols.selfIdCol} = $${++p}` : 'FALSE',
        params: cols.selfIdCol ? [scope.customerId] : [],
      };
  }
}
