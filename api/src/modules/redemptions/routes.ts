/** Redemption routes (docs/04 §2). */
import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../../db/index.js';
import { asyncHandler } from '../../middleware/error.js';
import { requirePermission } from '../../middleware/auth.js';
import * as s from './service.js';

export const redemptionsRouter = Router();

redemptionsRouter.get('/', requirePermission('redemptions:initiate', 'dashboard:view'),
  asyncHandler(async (req, res) => res.json({ rows: await s.listRedemptions(getDb(), req.user!, req.query.filter === 'requests' ? 'requests' : 'all') })));

redemptionsRouter.post('/premature', requirePermission('redemptions:initiate'),
  asyncHandler(async (req, res) => {
    // `amount` = partial withdrawal (capped at the unpledged portion). Omitted
    // → redeem everything that isn't pledged to a live locker deposit.
    const input = z.object({
      application_id: z.number(), redemption_date: z.string().optional(), reason: z.string().min(2),
      amount: z.number().positive().optional(),
    }).parse(req.body);
    res.status(201).json(await s.initiatePremature(getDb(), req.user!, input));
  }));

// CXO waives / discounts the premature penalty before approving.
redemptionsRouter.post('/:id/waive-penalty', requirePermission('approvals:check-premature'),
  asyncHandler(async (req, res) => {
    const input = z.object({ new_penalty: z.number().min(0), reason: z.string().min(3) }).parse(req.body);
    res.json(await s.adjustPrematurePenalty(getDb(), req.user!, Number(req.params.id), input));
  }));

// Staff picks up a customer/app request and starts the 2-level approval.
redemptionsRouter.post('/:id/submit-for-approval', requirePermission('redemptions:initiate'),
  asyncHandler(async (req, res) => res.status(201).json({ request: await s.submitForApproval(getDb(), req.user!, Number(req.params.id)) })));

redemptionsRouter.post('/maturity', requirePermission('redemptions:initiate'),
  asyncHandler(async (req, res) => {
    const { application_id } = z.object({ application_id: z.number() }).parse(req.body);
    res.status(201).json(await s.initiateMaturity(getDb(), req.user!, application_id));
  }));

redemptionsRouter.get('/neft.xlsx', requirePermission('redemptions:initiate'),
  asyncHandler(async (_req, res) => {
    const buf = await s.redemptionNeft(getDb());
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="redemption-neft.xlsx"');
    res.end(buf);
  }));

redemptionsRouter.get('/report.xlsx', requirePermission('redemptions:initiate', 'reports:download'),
  asyncHandler(async (req, res) => {
    const buf = await s.redemptionReport(getDb(), req.user!);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="redemption-report.xlsx"');
    res.end(buf);
  }));
