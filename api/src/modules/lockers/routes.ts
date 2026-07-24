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
// Static import ON PURPOSE: it registers the locker_deposit_waiver approval
// handlers at boot. A dynamic import inside the route would leave approvals
// silently side-effect-free until the first waiver request after a restart —
// the exact failure the agent-registration flow hit on 2026-07-23.
import { createWaiver, cancelWaiver } from './waivers.js';
import { linkTenant, removeTenant, restoreTenant } from './tenantOverrides.js';
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
// Stock position (A15) — the counterpart to /availability above, NOT a
// replacement for it. /availability quotes a sale and omits sold-out sizes;
// this reports every size at every branch including the zeroes, which is what
// a stock screen has to say. branch_id is optional: omit for the whole network.
lockersRouter.get('/inventory', asyncHandler(async (req, res) =>
  res.json(await lh.lockerInventory(req.query.branch_id ? String(req.query.branch_id) : undefined))));
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

// A7 create. Pass `customer_id` and the full applicant profile (address,
// nominee, KYC, bank) is assembled HERE from our own book and sent with the
// create, so the tenancy is complete on LockerHub and nobody opens their app to
// finish it. Built server-side on purpose: the browser never supplies profile
// fields, so it cannot be used to write a profile the operator can't otherwise
// see. Unknown/invisible customer → we still create the application, since the
// applicant block is enrichment and losing it must not block an enrolment.
lockersRouter.post('/applications', asyncHandler(async (req, res) => {
  const b = z.object({
    phone: z.string().min(10), name: z.string().optional(), email: z.string().optional(),
    branch_id: z.string().min(1), locker_size: z.string().min(1),
    customer_id: z.number().int().positive().nullish(),
  }).parse(req.body ?? {});
  const { customer_id, ...input } = b;

  let applicant: Record<string, unknown> | undefined;
  if (customer_id) {
    const { assertCustomerVisible } = await import('../../lib/visibility.js');
    await assertCustomerVisible(getDb(), req.user!, customer_id);
    const { buildApplicantBlock } = await import('./applicant.js');
    applicant = (await buildApplicantBlock(getDb(), customer_id)) ?? undefined;
  }
  res.status(201).json(await lh.createLockerApplication(staffOf(req), { ...input, ...(applicant ? { applicant } : {}) }));
}));

lockersRouter.post('/applications/:id/payment-link', asyncHandler(async (req, res) => {
  const { leg } = z.object({ leg: LEG }).parse(req.body ?? {});
  res.json(await lh.paymentLink(staffOf(req), String(req.params.id), leg));
}));

// A10 record-payment was RETIRED by LockerHub (contract v1.2 §A10): lockers and
// NCD are online-only products and the route now 400s for every caller. The
// proxy is gone rather than left to fail — collect via payment-link above, or
// back the deposit leg with an NCD investment (A12 link-ncd).

// A11 allocate — the APPROVAL step, and the call that creates the tenant.
// Everything else (obligations_pending, no_vacancy, the vacancy race) is passed
// through with LockerHub's own status and body so the operator sees the real
// reason. The ONE case we translate is `already:true`, which they return as a
// 400: the locker IS allotted, so re-driving a completed allocation has
// succeeded — reporting that as an error would send staff hunting a failure
// that never happened.
lockersRouter.post('/applications/:id/allocate', asyncHandler(async (req, res) => {
  const b = z.object({ locker_id: z.string().optional(), lease_months: z.number().int().positive().optional() }).parse(req.body ?? {});
  try {
    res.json(await lh.allocate(staffOf(req), String(req.params.id), b));
  } catch (e) {
    const detail = (e as { detail?: { already?: boolean } }).detail;
    if (detail?.already === true) { res.json({ ...detail, success: true, already: true }); return; }
    throw e;
  }
}));

// ── Deposit links: back a locker's deposit with an NCD investment ──────────
// The amount is LockerHub's own deposit figure — never typed by staff — and
// linking settles that deposit leg on their side.
// Which of this customer's investments could back a deposit, and how much of
// each is still free. Registered before the ':linkId' routes.
// Everything NCD knows about one customer's lockers — their LockerHub record
// plus our own pledges and cheques. Powers the Lockers card on customer 360.
lockersRouter.get('/customers/:customerId/lockers', asyncHandler(async (req, res) => {
  const { assertCustomerVisible } = await import('../../lib/visibility.js');
  const id = Number(req.params.customerId);
  await assertCustomerVisible(getDb(), req.user!, id);
  const { customerLockers } = await import('./deposits.js');
  res.json(await customerLockers(getDb(), id));
}));

// Locker tenants, branch-wise (sidebar page) — the full branch roster from
// LockerHub's /locker-tenants, with NCD's own pledges/cheques layered on.
lockersRouter.get('/tenants', asyncHandler(async (req, res) => {
  const { lockerTenants } = await import('./deposits.js');
  res.json(await lockerTenants(getDb(), { branchId: req.query.branch_id ? String(req.query.branch_id) : undefined }));
}));

// ── Deposit waivers (owner 2026-07-24): exception cases holding a locker with
// no NCD backing. NCD Manager+ records with a reason; Admin/CXO approves.
// The router-level lockers:enroll still applies; these add the stricter perm.
lockersRouter.post('/waivers', requirePermission('lockers:waive'), asyncHandler(async (req, res) => {
  const b = z.object({
    lockerhub_tenant_id: z.string().trim().min(1),
    reason: z.string().trim().min(3, 'Reason is required'),
    locker_no: z.string().nullish(),
    branch_id: z.string().nullish(),
    tenant_name: z.string().nullish(),
    tenant_phone: z.string().nullish(),
    customer_id: z.number().int().positive().nullish(),
  }).parse(req.body);
  res.status(201).json(await createWaiver(getDb(), req.user!, b));
}));

// ── Roster overrides (owner 2026-07-24) ──────────────────────────────────
// Link a tenant to an NCD customer BY HAND. Automatic matching needs phone +
// a full name agreement, and LockerHub exposes no PAN to settle the rest
// (profile is null for these tenants; where present the PAN is masked).
const TENANT_SNAP = z.object({
  tenant_name: z.string().nullish(), locker_no: z.string().nullish(), branch_id: z.string().nullish(),
});
lockersRouter.post('/tenants/:tenantId/link', requirePermission('lockers:waive'), asyncHandler(async (req, res) => {
  const b = TENANT_SNAP.extend({ customer_id: z.number().int().positive().nullable() }).parse(req.body ?? {});
  res.json(await linkTenant(getDb(), req.user!, String(req.params.tenantId), b.customer_id, b));
}));

// Remove from NCD's roster — super_admin only. LockerHub owns the tenancy and
// has no close endpoint, so this hides OUR row; the locker stays allotted there.
lockersRouter.post('/tenants/:tenantId/remove', requirePermission('lockers:remove-tenant'), asyncHandler(async (req, res) => {
  const b = TENANT_SNAP.extend({ reason: z.string().trim().min(3, 'A reason is required') }).parse(req.body ?? {});
  res.json(await removeTenant(getDb(), req.user!, String(req.params.tenantId), b.reason, b));
}));

lockersRouter.post('/tenants/:tenantId/restore', requirePermission('lockers:remove-tenant'), asyncHandler(async (req, res) => {
  res.json(await restoreTenant(getDb(), req.user!, String(req.params.tenantId)));
}));

lockersRouter.post('/waivers/:id/cancel', requirePermission('lockers:waive'), asyncHandler(async (req, res) => {
  res.json(await cancelWaiver(getDb(), req.user!, Number(req.params.id)));
}));

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

// ── Cheque register (NCD-side only) ───────────────────────────────────────
// Lockers are online-only on LockerHub (§A10 retired offline record-payment),
// so a cheque can never settle a leg there. These routes record the instrument
// and its clearance in OUR books; every response repeats that the locker is not
// settled. Recording is enrolment-tier; CLEARING asserts money landed in the
// bank, so it needs the same permission as confirming a collection.
lockersRouter.get('/cheques', asyncHandler(async (req, res) => {
  const { listCheques } = await import('./cheques.js');
  res.json(await listCheques(getDb(), {
    status: req.query.status ? String(req.query.status) : undefined,
    lockerApplicationId: req.query.application_id ? String(req.query.application_id) : undefined,
  }));
}));

lockersRouter.post('/cheques', asyncHandler(async (req, res) => {
  const b = z.object({
    lockerhub_application_id: z.string().min(1),
    customer_id: z.number().int().positive().nullish(),
    leg: LEG,
    amount: z.number().positive(),
    cheque_no: z.string().min(1),
    bank_name: z.string().nullish(),
    received_on: z.string().min(4),
    notes: z.string().nullish(),
  }).parse(req.body ?? {});
  const { recordCheque } = await import('./cheques.js');
  res.status(201).json(await recordCheque(getDb(), req.user!, {
    lockerApplicationId: b.lockerhub_application_id, customerId: b.customer_id ?? null, leg: b.leg,
    amount: b.amount, chequeNo: b.cheque_no, bankName: b.bank_name ?? null,
    receivedOn: b.received_on, notes: b.notes ?? null,
  }));
}));

lockersRouter.post('/cheques/:id/clear', requirePermission('applications:confirm-collection'),
  asyncHandler(async (req, res) => {
    const b = z.object({ cleared_on: z.string().min(4), reference: z.string().nullish() }).parse(req.body ?? {});
    const { clearCheque } = await import('./cheques.js');
    res.json(await clearCheque(getDb(), req.user!, Number(req.params.id), { clearedOn: b.cleared_on, reference: b.reference ?? null }));
  }));

lockersRouter.post('/cheques/:id/bounce', requirePermission('applications:confirm-collection'),
  asyncHandler(async (req, res) => {
    const { reason } = z.object({ reason: z.string().min(2) }).parse(req.body ?? {});
    const { bounceCheque } = await import('./cheques.js');
    res.json(await bounceCheque(getDb(), req.user!, Number(req.params.id), reason));
  }));
