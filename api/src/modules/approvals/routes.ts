/** Approvals routes (docs/04 §2). */
import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../../db/index.js';
import { asyncHandler } from '../../middleware/error.js';
import { requirePermission } from '../../middleware/auth.js';
import { errors } from '../../lib/errors.js';
import * as service from './service.js';

export const approvalsRouter = Router();

// Visible to anyone who can check anything (generic or premature).
const canCheck = requirePermission('approvals:check', 'approvals:check-premature', 'approvals:check-handover');

approvalsRouter.get(
  '/queue',
  canCheck,
  asyncHandler(async (req, res) => {
    res.json({ rows: await service.getQueue(getDb(), req.user!) });
  })
);

approvalsRouter.get(
  '/:id',
  canCheck,
  asyncHandler(async (req, res) => {
    const row = await service.getById(getDb(), Number(req.params.id));
    if (!row) throw errors.notFound('Approval request not found');
    const [covered, editable, detail] = await Promise.all([
      service.coveredApplications(getDb(), row),
      service.editableForRequest(getDb(), row),
      service.describeRequest(getDb(), row),
    ]);
    res.json({ request: row, covered, detail, editable });
  })
);

approvalsRouter.post(
  '/:id/approve',
  canCheck,
  asyncHandler(async (req, res) => {
    const extra = z.record(z.unknown()).optional().parse(req.body?.extra);
    const out = await service.approve(getDb(), req.user!, Number(req.params.id), extra);
    res.json({ request: out });
  })
);

approvalsRouter.post(
  '/:id/reject',
  canCheck,
  asyncHandler(async (req, res) => {
    const { reason } = z.object({ reason: z.string().min(2) }).parse(req.body);
    const out = await service.reject(getDb(), req.user!, Number(req.params.id), reason);
    res.json({ request: out });
  })
);
