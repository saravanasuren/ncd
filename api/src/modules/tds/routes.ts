/** TDS threshold routes. Importing the service also registers the
 *  tds_threshold approval handlers at boot (static, like the locker waivers). */
import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../../db/index.js';
import { asyncHandler } from '../../middleware/error.js';
import { requirePermission } from '../../middleware/auth.js';
import { errors } from '../../lib/errors.js';
import * as s from './service.js';

export const tdsRouter = Router();

// Run the detection now (nightly cron does this on its own). Admin/CXO.
tdsRouter.post('/scan', requirePermission('approvals:check-premature'),
  asyncHandler(async (req, res) => res.json(await s.scanTdsThreshold(getDb(), req.user!))));

// History of every ₹30L crossing — what it recovered and how each one ended.
tdsRouter.get('/events', requirePermission('approvals:check-premature'),
  asyncHandler(async (req, res) => {
    const q = z.object({ status: z.string().optional() }).parse(req.query);
    res.json({ rows: await s.listTdsEvents(getDb(), { status: q.status || undefined }) });
  }));

// Put a rejected customer back in scope, so a later scan may raise it again.
tdsRouter.post('/events/:id/reopen', requirePermission('approvals:check-premature'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) throw errors.badRequest('Bad event id');
    res.json(await s.reopenTdsEvent(getDb(), req.user!, id));
  }));
