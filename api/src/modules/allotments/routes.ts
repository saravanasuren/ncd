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
