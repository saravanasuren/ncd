/** Allotment routes (docs/04 §2). */
import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../../db/index.js';
import { asyncHandler } from '../../middleware/error.js';
import { requirePermission } from '../../middleware/auth.js';
import * as s from './service.js';

export const allotmentsRouter = Router();

allotmentsRouter.get('/series', requirePermission('allotments:execute'),
  asyncHandler(async (_req, res) => res.json({ rows: await s.pendingBySeriesSummary(getDb()) })));

allotmentsRouter.post('/series/:id', requirePermission('allotments:execute'),
  asyncHandler(async (req, res) => {
    const input = z.object({ allotment_date: z.string(), isin: z.string().optional(), notes: z.string().optional() }).parse(req.body);
    res.status(201).json(await s.createAllotmentBatch(getDb(), req.user!, { series_id: Number(req.params.id), ...input }));
  }));

allotmentsRouter.post('/series/:id/revert', requirePermission('allotments:revert'),
  asyncHandler(async (req, res) => {
    const { reason } = z.object({ reason: z.string().min(3) }).parse(req.body);
    res.json(await s.revertSeriesAllotment(getDb(), req.user!, Number(req.params.id), reason));
  }));

// Cancel a still-pending allotment approval (Revert while awaiting a checker).
allotmentsRouter.post('/series/:id/cancel-pending', requirePermission('allotments:execute'),
  asyncHandler(async (req, res) => res.json(await s.cancelPendingAllotment(getDb(), req.user!, Number(req.params.id)))));
