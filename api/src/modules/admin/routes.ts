/** Admin: audit browser + System screen (docs/05 §23). */
import { Router } from 'express';
import { getDb } from '../../db/index.js';
import { asyncHandler } from '../../middleware/error.js';
import { requirePermission } from '../../middleware/auth.js';
import { listQueue } from '../notifications/service.js';

export const auditRouter = Router();
auditRouter.get('/', requirePermission('audit:read'), asyncHandler(async (req, res) => {
  const conds: string[] = [];
  const params: unknown[] = [];
  if (req.query.entity_type) { params.push(req.query.entity_type); conds.push(`entity_type = $${params.length}`); }
  if (req.query.action) { params.push(`%${req.query.action}%`); conds.push(`action ILIKE $${params.length}`); }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const rows = (await getDb().query(
    `SELECT a.id, a.action, a.entity_type, a.entity_id, a.actor_id, u.full_name AS actor_name, a.created_at
     FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id ${where} ORDER BY a.id DESC LIMIT 200`, params)).rows;
  res.json({ rows });
}));

export const systemRouter = Router();
systemRouter.get('/jobs', requirePermission('settings:manage'), asyncHandler(async (_req, res) => {
  const rows = (await getDb().query('SELECT job, started_at, finished_at, ok, note FROM job_runs ORDER BY id DESC LIMIT 50').catch(() => ({ rows: [] as unknown[] }))).rows;
  res.json({ rows });
}));
systemRouter.get('/notifications', requirePermission('notifications:admin'), asyncHandler(async (_req, res) => {
  res.json({ rows: await listQueue(getDb(), 100) });
}));
systemRouter.post('/notifications/drain', requirePermission('notifications:admin'), asyncHandler(async (_req, res) => {
  const { drainOnce } = await import('../notifications/service.js');
  res.json(await drainOnce(getDb(), 25));
}));

// Manual LockerHub reconciliation run (explicit human action — works even
// while the daily cron flag is off; read-only against LockerHub's SQLite).
systemRouter.post('/lockerhub-reconciliation/run', requirePermission('settings:manage'), asyncHandler(async (req, res) => {
  const { runReconciliation } = await import('../../integrations/lockerhub/reconciliation.js');
  const date = typeof req.body?.report_date === 'string' ? req.body.report_date : undefined;
  res.json(await runReconciliation(getDb(), date));
}));
