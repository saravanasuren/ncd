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

incentivesRouter.get('/agents', requirePermission('incentives:manage-eligibility'),
  asyncHandler(async (_req, res) => res.json({ rows: await s.listAgentsForEligibility(getDb()) })));

incentivesRouter.get('/my-earnings', requirePermission('earnings:read-own'),
  asyncHandler(async (req, res) => res.json(await s.myEarnings(getDb(), req.user!))));

incentivesRouter.get('/payees/:type/:id/statement.pdf', requirePermission('incentives:manage-eligibility', 'earnings:read-own'),
  asyncHandler(async (req, res) => {
    const buf = await s.statementPdf(getDb(), req.params.type!, Number(req.params.id));
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="incentive-statement.pdf"`);
    res.end(buf);
  }));

incentivesRouter.get('/payees/:type/:id/balance', requirePermission('incentives:manage-eligibility'),
  asyncHandler(async (req, res) => res.json(await s.payeeBalance(getDb(), req.params.type!, Number(req.params.id)))));

// Per-customer incentive breakdown + pay-in-full for one customer.
incentivesRouter.get('/payees/:type/:id/accruals', requirePermission('incentives:manage-eligibility'),
  asyncHandler(async (req, res) => res.json({ rows: await s.payeeAccruals(getDb(), req.params.type!, Number(req.params.id)) })));

incentivesRouter.post('/payees/:type/:id/accruals/:applicationId/pay', requirePermission('incentives:pay'),
  asyncHandler(async (req, res) => res.json(await s.payCustomerAccrual(getDb(), req.user!, req.params.type!, Number(req.params.id), Number(req.params.applicationId)))));

// Revert a per-customer payment — Super Admin only (enforced in the service).
incentivesRouter.post('/payees/:type/:id/accruals/:applicationId/revert-payment', requirePermission('incentives:pay'),
  asyncHandler(async (req, res) => res.json(await s.revertCustomerPayment(getDb(), req.user!, req.params.type!, Number(req.params.id), Number(req.params.applicationId)))));

// Agent commission eligibility (maker-checker).
incentivesRouter.post('/agents/:id/eligibility', requirePermission('incentives:manage-eligibility'),
  asyncHandler(async (req, res) => {
    const input = z.object({ rate_pct: z.number(), payout_mode: z.string().optional(), bank_name: z.string().optional(), account_number: z.string().optional(), ifsc: z.string().optional() }).parse(req.body);
    res.status(201).json({ request: await s.requestAgentEligibility(getDb(), req.user!, Number(req.params.id), input) });
  }));
incentivesRouter.post('/agents/:id/eligibility/revoke', requirePermission('incentives:manage-eligibility'),
  asyncHandler(async (req, res) => { await s.revokeAgentEligibility(getDb(), req.user!, Number(req.params.id)); res.json({ ok: true }); }));
