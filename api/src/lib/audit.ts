/**
 * Audit helper (docs/01 §4, docs/13). Every state-changing service call
 * writes a before/after row — inside the caller's transaction when given a
 * tx handle.
 */
import type { Db } from '../db/types.js';

export interface AuditEntry {
  actorId: number | null;
  action: string;
  entityType: string;
  entityId?: string | number | null;
  before?: unknown;
  after?: unknown;
  ip?: string | null;
}

export async function writeAudit(db: Db, e: AuditEntry): Promise<void> {
  await db.query(
    `INSERT INTO audit_log (actor_id, action, entity_type, entity_id, before_data, after_data, ip)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      e.actorId,
      e.action,
      e.entityType,
      e.entityId != null ? String(e.entityId) : null,
      e.before != null ? JSON.stringify(e.before) : null,
      e.after != null ? JSON.stringify(e.after) : null,
      e.ip ?? null,
    ]
  );
}
