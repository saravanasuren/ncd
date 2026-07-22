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
import { getDb } from '../../db/index.js';
import { asyncHandler } from '../../middleware/error.js';
import { requirePermission } from '../../middleware/auth.js';
import * as lh from '../../integrations/lockerhub/client.js';
import { errors } from '../../lib/errors.js';

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
// PAN-first customer lookup (contract B11). LockerHub is phone-keyed, so we
// resolve the customer from NCD's own book by PAN and hand THEIR phone to
// LockerHub — staff enrol against the identity document in front of them
// rather than having to know the registered mobile.
// Registered BEFORE '/customers/:phone' so the literal segment can't be
// captured by the param route.
lockersRouter.get('/customers/by-pan/:pan', asyncHandler(async (req, res) => {
  const pan = String(req.params.pan ?? '').toUpperCase().trim();
  const c = (await getDb().query<{ id: string; customer_code: string; full_name: string; phone: string | null; email: string | null }>(
    `SELECT id, customer_code, full_name, phone, email FROM customers
      WHERE upper(pan) = $1 AND archived_at IS NULL ORDER BY id LIMIT 1`, [pan])).rows[0];
  if (!c) { res.json({ found_in_ncd: false, customer: null, locker: null }); return; }
  // Their LockerHub state (if any) — never fatal: a LockerHub hiccup must not
  // block reading our own customer.
  const locker = c.phone ? await lh.getCustomer(String(c.phone)).catch(() => null) : null;
  res.json({ found_in_ncd: true, customer: { ...c, id: Number(c.id) }, locker });
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

// A10 record-payment was RETIRED by LockerHub (contract v1.2 §A10): lockers and
// NCD are online-only products and the route now 400s for every caller. The
// proxy is gone rather than left to fail — collect via payment-link above, or
// back the deposit leg with an NCD investment (A12 link-ncd).

lockersRouter.post('/applications/:id/allocate', asyncHandler(async (req, res) => {
  const b = z.object({ locker_id: z.string().optional(), lease_months: z.number().int().positive().optional() }).parse(req.body ?? {});
  res.json(await lh.allocate(staffOf(req), String(req.params.id), b));
}));

// ── Deposit links: back a locker's deposit with an NCD investment ──────────
// The amount is LockerHub's own deposit figure — never typed by staff — and
// linking settles that deposit leg on their side.
// Which of this customer's investments could back a deposit, and how much of
// each is still free. Registered before the ':linkId' routes.
lockersRouter.get('/deposit-links/candidates', asyncHandler(async (req, res) => {
  const customerId = Number(req.query.customer_id);
  if (!Number.isFinite(customerId) || customerId <= 0) throw errors.badRequest('customer_id is required');
  const { linkCandidates } = await import('./deposits.js');
  res.json({ candidates: await linkCandidates(getDb(), customerId) });
}));

lockersRouter.post('/deposit-links', asyncHandler(async (req, res) => {
  const b = z.object({ application_id: z.number().int().positive(), lockerhub_application_id: z.string().min(1) }).parse(req.body ?? {});
  const { linkDeposit } = await import('./deposits.js');
  res.status(201).json(await linkDeposit(getDb(), req.user!, { applicationId: b.application_id, lockerApplicationId: b.lockerhub_application_id }));
}));

// Release a link once the locker is closed — frees the pledged amount to be redeemed.
lockersRouter.post('/deposit-links/:linkId/release', asyncHandler(async (req, res) => {
  const { reason } = z.object({ reason: z.string().min(2) }).parse(req.body ?? {});
  const { releaseLink } = await import('./deposits.js');
  res.json(await releaseLink(getDb(), req.user!, Number(req.params.linkId), reason));
}));
