/** Incentives routes (docs/04 §2). */
import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../../db/index.js';
import { asyncHandler } from '../../middleware/error.js';
import { requirePermission } from '../../middleware/auth.js';
import * as s from './service.js';

export const incentivesRouter = Router();

incentivesRouter.get('/overview', requirePermission('incentives:manage-eligibility'),
  asyncHandler(async (_req, res) => res.json({ rows: await s.overview(getDb()) })));

incentivesRouter.get('/my-earnings', requirePermission('earnings:read-own'),
  asyncHandler(async (req, res) => res.json(await s.myEarnings(getDb(), req.user!))));

incentivesRouter.get('/payees/:type/:id/balance', requirePermission('incentives:manage-eligibility'),
  asyncHandler(async (req, res) => res.json(await s.payeeBalance(getDb(), req.params.type!, Number(req.params.id)))));

incentivesRouter.post('/payees/:type/:id/pay', requirePermission('incentives:pay'),
  asyncHandler(async (req, res) => {
    const { amount, reference } = z.object({ amount: z.number().positive(), reference: z.string().optional() }).parse(req.body);
    res.json(await s.pay(getDb(), req.user!, req.params.type!, Number(req.params.id), amount, reference));
  }));
