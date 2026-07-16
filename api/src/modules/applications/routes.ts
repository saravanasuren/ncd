/** Applications routes (docs/04 §2). */
import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../../db/index.js';
import { asyncHandler } from '../../middleware/error.js';
import { requirePermission } from '../../middleware/auth.js';
import * as s from './service.js';

export const applicationsRouter = Router();

applicationsRouter.get('/', requirePermission('customers:read'),
  asyncHandler(async (req, res) => res.json({ rows: await s.listApplications(getDb(), req.user!, { status: req.query.status as string, series_id: req.query.series_id ? Number(req.query.series_id) : undefined }) })));

applicationsRouter.get('/:id', requirePermission('customers:read'),
  asyncHandler(async (req, res) => res.json(await s.getApplicationDetail(getDb(), req.user!, Number(req.params.id)))));

applicationsRouter.post('/', requirePermission('applications:create'),
  asyncHandler(async (req, res) => {
    const input = z.object({ customer_id: z.number(), series_id: z.number(), scheme_id: z.number(), amount: z.number().positive() }).parse(req.body);
    res.status(201).json(await s.createApplication(getDb(), req.user!, input));
  }));

applicationsRouter.post('/:id/confirm-collection', requirePermission('applications:confirm-collection'),
  asyncHandler(async (req, res) => {
    const input = z.object({ amount_received: z.number().positive(), date_money_received: z.string(), method: z.string(), reference: z.string().optional() }).parse(req.body);
    res.json(await s.confirmCollection(getDb(), req.user!, Number(req.params.id), input));
  }));

applicationsRouter.post('/:id/mark-esigned', requirePermission('applications:mark-esigned'),
  asyncHandler(async (req, res) => { await s.markESigned(getDb(), req.user!, Number(req.params.id)); res.json({ ok: true }); }));
