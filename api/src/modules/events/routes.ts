/** NCD event routes — rollover / transfer / transformation (docs/04 §2). */
import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../../db/index.js';
import { asyncHandler } from '../../middleware/error.js';
import { requirePermission } from '../../middleware/auth.js';
import * as s from './service.js';

export const eventsRouter = Router();
const manage = requirePermission('redemptions:initiate');

eventsRouter.get('/', manage, asyncHandler(async (_req, res) => res.json(await s.listEvents(getDb()))));

eventsRouter.post('/rollover', manage, asyncHandler(async (req, res) => {
  const { application_id } = z.object({ application_id: z.number() }).parse(req.body);
  res.status(201).json(await s.initiateRollover(getDb(), req.user!, application_id));
}));

eventsRouter.post('/transfer', manage, asyncHandler(async (req, res) => {
  const input = z.object({ application_id: z.number(), to_customer_id: z.number(), reason: z.string().min(2) }).parse(req.body);
  res.status(201).json(await s.initiateTransfer(getDb(), req.user!, input));
}));

eventsRouter.post('/transformation', manage, asyncHandler(async (req, res) => {
  const input = z.object({ application_id: z.number(), nominee_name: z.string().min(1), nominee_customer_id: z.number().optional(), nominee_bank_name: z.string().optional(), nominee_account: z.string().optional(), nominee_ifsc: z.string().optional() }).parse(req.body);
  res.status(201).json(await s.initiateTransformation(getDb(), req.user!, input));
}));
