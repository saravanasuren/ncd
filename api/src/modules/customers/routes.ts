/** Customers routes (docs/04 §2). */
import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../../db/index.js';
import { asyncHandler } from '../../middleware/error.js';
import { requirePermission } from '../../middleware/auth.js';
import * as s from './service.js';

export const customersRouter = Router();

customersRouter.get('/', requirePermission('customers:read'),
  asyncHandler(async (req, res) => {
    const filters = { status: req.query.status as string, district: req.query.district as string, q: req.query.q as string };
    res.json({ rows: await s.listCustomers(getDb(), req.user!, filters) });
  }));

const createSchema = z.object({
  full_name: z.string().min(1),
  pan: z.string().optional(),
  dob: z.string().optional(),
  gender: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().email().optional(),
  address: z.string().optional(),
  city: z.string().optional(),
  district: z.string().optional(),
  state: z.string().optional(),
  is_nri: z.boolean().optional(),
  referred_by_text: z.string().optional(),
});

customersRouter.post('/', requirePermission('customers:create'),
  asyncHandler(async (req, res) => res.status(201).json(await s.createCustomer(getDb(), req.user!, createSchema.parse(req.body)))));

customersRouter.get('/:id', requirePermission('customers:read'),
  asyncHandler(async (req, res) => res.json(await s.getCustomerDetail(getDb(), req.user!, Number(req.params.id)))));

customersRouter.post('/:id/bank-accounts', requirePermission('customers:update'),
  asyncHandler(async (req, res) => {
    const b = z.object({ account_number: z.string().min(4), ifsc: z.string().min(4), bank_name: z.string().optional(), holder_name: z.string().optional() }).parse(req.body);
    res.status(201).json(await s.addBankAccount(getDb(), req.user!, Number(req.params.id), b));
  }));

customersRouter.post('/:id/bank-accounts/:bankId/set-active', requirePermission('customers:update'),
  asyncHandler(async (req, res) => { await s.setActiveBank(getDb(), req.user!, Number(req.params.id), Number(req.params.bankId)); res.json({ ok: true }); }));

customersRouter.post('/:id/kyc/verify', requirePermission('kyc:verify'),
  asyncHandler(async (req, res) => { await s.setKyc(getDb(), req.user!, Number(req.params.id), 'Verified'); res.json({ ok: true }); }));

customersRouter.post('/:id/kyc/reject', requirePermission('kyc:reject'),
  asyncHandler(async (req, res) => {
    const { reason } = z.object({ reason: z.string().min(2) }).parse(req.body);
    await s.setKyc(getDb(), req.user!, Number(req.params.id), 'Rejected', reason);
    res.json({ ok: true });
  }));

customersRouter.post('/:id/submit-for-approval', requirePermission('customers:create'),
  asyncHandler(async (req, res) => res.status(201).json({ request: await s.submitForApproval(getDb(), req.user!, Number(req.params.id)) })));

customersRouter.post('/:id/correction-request', requirePermission('customers:correction-request'),
  asyncHandler(async (req, res) => {
    const { changes, reason } = z.object({ changes: z.record(z.unknown()), reason: z.string().min(2) }).parse(req.body);
    res.status(201).json({ request: await s.requestCorrection(getDb(), req.user!, Number(req.params.id), changes, reason) });
  }));

customersRouter.post('/:id/handover-request', requirePermission('customers:handover-request'),
  asyncHandler(async (req, res) => {
    const { toUserId, reason } = z.object({ toUserId: z.number(), reason: z.string().min(2) }).parse(req.body);
    res.status(201).json({ request: await s.requestHandover(getDb(), req.user!, Number(req.params.id), toUserId, reason) });
  }));
