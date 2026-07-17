/** Activation routes (docs/04 §2). Funded apps → Active, maker-checker. */
import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../../db/index.js';
import { asyncHandler } from '../../middleware/error.js';
import { requirePermission } from '../../middleware/auth.js';
import * as s from './service.js';

export const activationsRouter = Router();

activationsRouter.get('/series', requirePermission('activations:execute'),
  asyncHandler(async (_req, res) => res.json({ rows: await s.pendingBySeriesSummary(getDb()) })));

activationsRouter.post('/series/:id', requirePermission('activations:execute'),
  asyncHandler(async (req, res) => {
    const input = z.object({ notes: z.string().optional() }).parse(req.body);
    res.status(201).json(await s.createActivationBatch(getDb(), req.user!, { series_id: Number(req.params.id), ...input }));
  }));
