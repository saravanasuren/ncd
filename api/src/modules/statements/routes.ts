/** Bank-statement routes (docs/04 §2). */
import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../../db/index.js';
import { asyncHandler } from '../../middleware/error.js';
import { requirePermission } from '../../middleware/auth.js';
import * as s from './service.js';

export const statementsRouter = Router();
const perm = requirePermission('payouts:generate');

statementsRouter.get('/', perm, asyncHandler(async (_req, res) => res.json({ rows: await s.listStatements(getDb()) })));

statementsRouter.post('/', perm, asyncHandler(async (req, res) => {
  const b = z.object({
    source_bank: z.string().default('Federal'),
    lines: z.array(z.object({ value_date: z.string(), amount: z.number(), reference: z.string().optional(), utr: z.string().optional() })).min(1),
  }).parse(req.body);
  res.status(201).json(await s.uploadStatement(getDb(), req.user!, b.source_bank, b.lines));
}));

statementsRouter.post('/:id/run-match', perm, asyncHandler(async (req, res) => res.json(await s.runMatch(getDb(), req.user!, Number(req.params.id)))));
