/**
 * Locker enrollment (NCD_INTEGRATION_CONTRACT.md Part A). The staff web app
 * calls THESE first-party routes (cookie + CSRF + lockers:enroll); each proxies
 * to LockerHub via the outbound client, injecting the acting staff member from
 * the session. The shared integration key never leaves the server.
 *
 * Pricing/allocation are server-side on LockerHub — NCD forwards, never invents,
 * amounts. A locker auto-allots when the last mandatory leg settles (the second
 * record-payment response already says application_status: approved).
 */
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../middleware/error.js';
import { requirePermission } from '../../middleware/auth.js';
import * as lh from '../../integrations/lockerhub/client.js';

export const lockersRouter = Router();
lockersRouter.use(requirePermission('lockers:enroll'));

const staffOf = (req: { user?: { id: number; fullName: string; email: string } }): lh.ActingStaff => ({
  id: req.user!.id, name: req.user!.fullName, email: req.user!.email,
});

const LEG = z.enum(['rent', 'deposit']);

// ── Reads ────────────────────────────────────────────────────────────────
lockersRouter.get('/ping', asyncHandler(async (_req, res) => res.json(await lh.ping())));
lockersRouter.get('/branches', asyncHandler(async (_req, res) => res.json(await lh.branches())));
lockersRouter.get('/availability', asyncHandler(async (req, res) =>
  res.json(await lh.lockerAvailability(req.query.branch_id ? String(req.query.branch_id) : undefined))));
lockersRouter.get('/lockers', asyncHandler(async (req, res) => {
  const branchId = String(req.query.branch_id ?? '');
  if (!branchId) return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'branch_id required' } });
  res.json(await lh.lockers(branchId, req.query.size ? String(req.query.size) : undefined));
}));
lockersRouter.get('/customers/:phone', asyncHandler(async (req, res) =>
  res.json(await lh.getCustomer(String(req.params.phone)))));
lockersRouter.get('/applications/:id', asyncHandler(async (req, res) =>
  res.json(await lh.getLockerApplication(String(req.params.id)))));

// ── Writes (staff injected from the session) ──────────────────────────────
lockersRouter.post('/customers', asyncHandler(async (req, res) => {
  const profile = z.object({
    phone: z.string().min(10), name: z.string().optional(), email: z.string().optional(),
    dob: z.string().optional(), address_line1: z.string().optional(), city: z.string().optional(),
    state: z.string().optional(), pincode: z.string().optional(),
  }).parse(req.body ?? {});
  res.json(await lh.upsertCustomer(staffOf(req), profile));
}));

lockersRouter.post('/applications', asyncHandler(async (req, res) => {
  const b = z.object({
    phone: z.string().min(10), name: z.string().optional(), email: z.string().optional(),
    branch_id: z.string().min(1), locker_size: z.string().min(1),
  }).parse(req.body ?? {});
  res.status(201).json(await lh.createLockerApplication(staffOf(req), b));
}));

lockersRouter.post('/applications/:id/payment-link', asyncHandler(async (req, res) => {
  const { leg } = z.object({ leg: LEG }).parse(req.body ?? {});
  res.json(await lh.paymentLink(staffOf(req), String(req.params.id), leg));
}));

lockersRouter.post('/applications/:id/record-payment', asyncHandler(async (req, res) => {
  const b = z.object({
    leg: LEG, method: z.enum(['cash', 'cheque', 'bank_transfer']),
    reference: z.string().optional(), notes: z.string().optional(),
  }).parse(req.body ?? {});
  // Amount is server-derived on LockerHub — never sent from here.
  res.json(await lh.recordPayment(staffOf(req), String(req.params.id), b));
}));

lockersRouter.post('/applications/:id/allocate', asyncHandler(async (req, res) => {
  const b = z.object({ locker_id: z.string().optional(), lease_months: z.number().int().positive().optional() }).parse(req.body ?? {});
  res.json(await lh.allocate(staffOf(req), String(req.params.id), b));
}));
