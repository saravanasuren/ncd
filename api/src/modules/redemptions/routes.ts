/** Redemption routes (docs/04 §2). */
import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../../db/index.js';
import { asyncHandler } from '../../middleware/error.js';
import { requirePermission } from '../../middleware/auth.js';
import * as s from './service.js';

export const redemptionsRouter = Router();

redemptionsRouter.get('/', requirePermission('redemptions:initiate', 'dashboard:view'),
  asyncHandler(async (_req, res) => res.json({ rows: await s.listRedemptions(getDb()) })));

redemptionsRouter.post('/premature', requirePermission('redemptions:initiate'),
  asyncHandler(async (req, res) => {
    const input = z.object({ application_id: z.number(), redemption_date: z.string().optional(), reason: z.string().min(2) }).parse(req.body);
    res.status(201).json(await s.initiatePremature(getDb(), req.user!, input));
  }));
