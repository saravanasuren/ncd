/** Payout (interest NEFT batch) routes (docs/04 §2). */
import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../../db/index.js';
import { asyncHandler } from '../../middleware/error.js';
import { requirePermission } from '../../middleware/auth.js';
import * as s from './service.js';

export const payoutsRouter = Router();

payoutsRouter.get('/preview', requirePermission('payouts:generate'),
  asyncHandler(async (req, res) => res.json(await s.previewDue(getDb(), String(req.query.date ?? new Date().toISOString().slice(0, 10))))));

payoutsRouter.get('/', requirePermission('payouts:generate'),
  asyncHandler(async (_req, res) => res.json({ rows: await s.listBatches(getDb()) })));

payoutsRouter.post('/', requirePermission('payouts:generate'),
  asyncHandler(async (req, res) => {
    const { payout_date } = z.object({ payout_date: z.string() }).parse(req.body);
    res.status(201).json(await s.createInterestBatch(getDb(), req.user!, payout_date));
  }));

payoutsRouter.post('/:id/mark-paid', requirePermission('payouts:mark-paid-manual'),
  asyncHandler(async (req, res) => {
    const { utr } = z.object({ utr: z.string().optional() }).parse(req.body);
    res.json(await s.markBatchPaid(getDb(), req.user!, Number(req.params.id), utr));
  }));
