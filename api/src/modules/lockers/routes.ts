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
// Static for the same reason as the line above: it registers the
// locker_fee_waiver approval hooks, and a lazy import would leave an approval
// silently side-effect-free until the first waiver request after a restart.
import './feeWaivers.js';
import { linkTenant, removeTenant, restoreTenant } from './tenantOverrides.js';
import { errors } from '../../lib/errors.js';
import { writeAudit } from '../../lib/audit.js';

export const lockersRouter = Router();
lockersRouter.use(requirePermission('lockers:enroll'));

// staff_role goes on EVERY call, not just allocate: it costs nothing on the
// reads and means their audit log always knows who acted. Allocation is the one
// place they enforce it (§A11 — agents get 403 staff_only).
const staffOf = (req: { user?: { id: number; fullName: string; email: string; role: string } }): lh.ActingStaff => ({
  id: req.user!.id, name: req.user!.fullName, email: req.user!.email, staff_role: req.user!.role,
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
//
// Branch-scoped for branch_staff (owner 2026-07-24) — same rule as /tenants
// below. See branchScope.ts for who is restricted and why.
lockersRouter.get('/inventory', asyncHandler(async (req, res) => {
  const { lockerBranchScopeFor } = await import('./branchScope.js');
  const scope = await lockerBranchScopeFor(getDb(), req.user!);
  const requested = req.query.branch_id ? String(req.query.branch_id) : undefined;
  if (scope.restricted && requested && !scope.branchIds.includes(requested)) {
    return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'You can only view stock for your assigned branch.' } });
  }
  if (!scope.restricted || requested) {
    res.json(await lh.lockerInventory(requested));
    return;
  }
  if (scope.branchIds.length === 1) {
    res.json(await lh.lockerInventory(scope.branchIds[0]));
    return;
  }
  // More than one allowed branch (rare — today every branch_staff matches
  // exactly one) and the endpoint's comma-list support is unconfirmed for A15
  // (unlike A-tenants, which their contract explicitly documents as
  // comma-accepting): fetch the whole network and sum down to the allowed
  // set, rather than assume.
  const full = await lh.lockerInventory(undefined);
  const allowed = new Set(scope.branchIds);
  const branches = full.branches.filter((b) => allowed.has(b.branch_id));
  const zeroCounts = { total: 0, vacant: 0, occupied: 0, reserved: 0, other: 0 };
  const totals = branches.reduce((t, b) => ({
    total: t.total + b.total, vacant: t.vacant + b.vacant, occupied: t.occupied + b.occupied,
    reserved: t.reserved + b.reserved, other: t.other + b.other,
  }), { ...zeroCounts });
  const bySize = new Map<string, { size: string; total: number; vacant: number; occupied: number; reserved: number; other: number }>();
  for (const b of branches) for (const sz of b.by_size) {
    const e = bySize.get(sz.size) ?? { size: sz.size, ...zeroCounts };
    e.total += sz.total; e.vacant += sz.vacant; e.occupied += sz.occupied; e.reserved += sz.reserved; e.other += sz.other;
    bySize.set(sz.size, e);
  }
  res.json({
    ...full,
    branch_id: null,
    branches,
    by_size: [...bySize.values()],
    totals: { ...totals, occupancy_pct: totals.total ? Math.round((totals.occupied / totals.total) * 1000) / 10 : 0, branches: branches.length },
  });
}));
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
// Pass `customer_id` and the full profile is assembled HERE from our own book
// — address, DOB, the lot. LockerHub writes the profile on locker-application
// create going forward but does NOT backfill customers whose applications
// predate that (2026-07-31), which is why theirs come back blank; this is how
// we fill them. Server-side on purpose: the browser never supplies profile
// fields, so it cannot write a profile the operator could not otherwise see.
// Typed fields still win when passed, so the plain create-a-customer path is
// unchanged.
lockersRouter.post('/customers', asyncHandler(async (req, res) => {
  const b = z.object({
    phone: z.string().min(10), name: z.string().optional(), email: z.string().optional(),
    dob: z.string().optional(), address_line1: z.string().optional(), city: z.string().optional(),
    state: z.string().optional(), pincode: z.string().optional(),
    customer_id: z.number().int().positive().nullish(),
  }).parse(req.body ?? {});
  const { customer_id, ...typed } = b;

  let profile: Record<string, unknown> = typed;
  if (customer_id) {
    const { assertCustomerVisible } = await import('../../lib/visibility.js');
    await assertCustomerVisible(getDb(), req.user!, customer_id);
    const { buildCustomerProfile } = await import('./applicant.js');
    const built = await buildCustomerProfile(getDb(), customer_id);
    // What the operator typed on screen wins — they may be correcting us.
    if (built) profile = { ...built, ...typed };
  }
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
//
// §A20 override (2026-07-29): allot with money still outstanding. LockerHub
// asked us to gate it to a senior role, so it needs `lockers:allot-override` —
// super_admin / admin / CXO, the people who APPROVE a waiver. There is no
// second approver on this action, so it cannot sit with the role that merely
// REQUESTS one. Both fields are mandatory and it is audited on our side too:
// their log records it, but "who at NCD decided this" belongs in our book.
lockersRouter.post('/applications/:id/allocate', asyncHandler(async (req, res) => {
  const b = z.object({
    locker_id: z.string().optional(),
    lease_months: z.number().int().positive().optional(),
    override: z.object({
      reason: z.string().trim().min(5, 'Say why the locker is being handed over unpaid'),
      approved_by: z.string().trim().min(2, 'Name who authorised it'),
    }).optional(),
  }).parse(req.body ?? {});

  if (b.override && !req.user!.permissions.includes('lockers:allot-override')) {
    throw errors.forbidden('Allotting with money outstanding needs an Admin or CXO.');
  }
  if (b.override) {
    await writeAudit(getDb(), {
      actorId: req.user!.id, action: 'locker.allot.override', entityType: 'locker_applications',
      entityId: String(req.params.id),
      after: { reason: b.override.reason, approved_by: b.override.approved_by, locker_id: b.locker_id ?? null },
    });
  }
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
//
// Branch-scoped for branch_staff (owner 2026-07-24): "only those staffs who
// are assigned to those specific branch gets to look only that particular
// branch portfolio." See branchScope.ts for who is restricted and why.
lockersRouter.get('/tenants', asyncHandler(async (req, res) => {
  const { lockerTenants } = await import('./deposits.js');
  const { lockerBranchScopeFor } = await import('./branchScope.js');
  const scope = await lockerBranchScopeFor(getDb(), req.user!);
  const requested = req.query.branch_id ? String(req.query.branch_id) : undefined;
  if (scope.restricted && requested && !scope.branchIds.includes(requested)) {
    return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'You can only view locker tenants for your assigned branch.' } });
  }
  // No branch chosen + restricted → default to their own branch(es), not a
  // network-wide sweep they aren't meant to see.
  const branchId = requested ?? (scope.restricted ? scope.branchIds : undefined);
  const result = await lockerTenants(getDb(), { branchId });
  res.json({ ...result, restricted_to: scope.restricted ? scope.branches : null });
}));

// Whose locker rent is due. Same branch scoping as the roster above — it is
// built from that roster, so anything looser would leak through the back door.
//
// READ-ONLY on purpose: LockerHub has no renewal call (an application carries
// one rent leg and one deposit leg, and A18 is idempotent once a leg is
// settled), so there is nothing here to press. See ops/LOCKERHUB-CR-RENEWALS.md.
lockersRouter.get('/renewals', asyncHandler(async (req, res) => {
  const { lockerRenewals } = await import('./renewals.js');
  const { lockerBranchScopeFor } = await import('./branchScope.js');
  const scope = await lockerBranchScopeFor(getDb(), req.user!);
  const requested = req.query.branch_id ? String(req.query.branch_id) : undefined;
  if (scope.restricted && requested && !scope.branchIds.includes(requested)) {
    return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'You can only view locker renewals for your assigned branch.' } });
  }
  const branchId = requested ?? (scope.restricted ? scope.branchIds : undefined);
  const days = req.query.days ? Number(req.query.days) : undefined;
  const result = await lockerRenewals(getDb(), { branchId, withinDays: days });
  res.json({ ...result, restricted_to: scope.restricted ? scope.branches : null });
}));

// ── Visit Log (contract §A14) ─────────────────────────────────────────────
// Who opened which locker, when and why. Branch-scoped on read exactly like
// the tenant roster above: a branch_staff sees their own branch's visits, not
// the network's.
//
// `tenant_phone` arrives MASKED to last-4 from their side; we pass it through
// as-is rather than pretending we can unmask it.
lockersRouter.get('/visits', asyncHandler(async (req, res) => {
  const { lockerBranchScopeFor } = await import('./branchScope.js');
  const scope = await lockerBranchScopeFor(getDb(), req.user!);
  const requested = req.query.branch_id ? String(req.query.branch_id) : undefined;
  if (scope.restricted && requested && !scope.branchIds.includes(requested)) {
    return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'You can only view locker visits for your assigned branch.' } });
  }
  // Restricted + nothing chosen → their own branches, never a network sweep.
  // Their API takes a comma-separated list (max 50).
  const branchId = requested ?? (scope.restricted ? scope.branchIds.join(',') : undefined);
  const limit = req.query.limit ? Number(req.query.limit) : undefined;
  const result = await lh.lockerVisits({ branch_id: branchId, phone: req.query.phone ? String(req.query.phone) : undefined, limit });
  res.json({ ...result, restricted_to: scope.restricted ? scope.branches : null });
}));

// Record a walk-in. Branch and locker are derived from the tenancy on their
// side. Recording is explicitly not privileged there; the write is attributed
// to the acting user and audited as `ncd_app_visit_recorded`.
//
// Branch scope (2026-07-29). Reads above are scoped, so leaving the WRITE open
// meant a branch_staff could log a visit against another branch's tenant. Two
// layers close it, deliberately in this order:
//
//  1. We resolve the customer's own branch first (§A5 returns lockers[] with
//     branch_id) and refuse before writing, naming the branch — "that locker is
//     at Gandhipuram" is actionable at a counter in a way a bare 403 is not.
//     §A5 takes the full phone the operator just typed, so the masking on the
//     roster is not in the way.
//  2. We assert `staff.branch_id` so THEY re-check against the tenancy they
//     actually resolve (§A14). Belt and braces: our pre-flight cannot cover a
//     tenant_id-only write, and theirs is the authority on which tenancy wins.
lockersRouter.post('/visits', asyncHandler(async (req, res) => {
  const body = z.object({
    phone: z.string().trim().regex(/^\d{10}$/, 'phone must be 10 digits').optional(),
    tenant_id: z.string().trim().min(1).optional(),
    datetime: z.string().trim().optional(),
    purpose: z.string().trim().optional(),
    duration: z.string().trim().optional(),
    notes: z.string().trim().optional(),
    visit_time: z.string().trim().optional(),
    exit_time: z.string().trim().optional(),
  }).refine((b) => b.phone || b.tenant_id, { message: 'phone or tenant_id is required' }).parse(req.body);

  const { lockerBranchScopeFor } = await import('./branchScope.js');
  const scope = await lockerBranchScopeFor(getDb(), req.user!);
  const staff = staffOf(req);
  // scope.branches is {id,name} objects — name them, don't stringify them.
  const scopeNames = scope.branches.map((b) => b.name).join(', ');

  if (scope.restricted) {
    if (body.phone) {
      // Only ACTIVE tenancies count: a closed locker at another branch is
      // history, not a reason to refuse today's visit.
      const cust = await lh.getCustomer(body.phone).catch(() => null);
      const lockers = (cust?.lockers as Array<Record<string, unknown>> | undefined) ?? [];
      const active = lockers.filter((l) => !['Closed', 'Cancelled'].includes(String(l.account_status ?? '')));
      const theirs = active.filter((l) => scope.branchIds.includes(String(l.branch_id ?? '')));
      if (active.length && !theirs.length) {
        const at = [...new Set(active.map((l) => String(l.branch_name ?? l.branch_id ?? '')))].filter(Boolean).join(', ');
        return res.status(403).json({ error: { code: 'FORBIDDEN', message:
          `That customer's locker is at ${at || 'another branch'}. You can only record visits for ${scopeNames}.` } });
      }
    }
    // One branch → assert it. Several (a manager covering more than one) → we
    // cannot name a single branch honestly, so leave it to our own pre-flight.
    if (scope.branchIds.length === 1) staff.branch_id = scope.branchIds[0]!;
  }

  try {
    res.json(await lh.recordLockerVisit(staff, body));
  } catch (e) {
    // Their scope refusal, turned into something a branch operator can act on.
    const msg = e instanceof Error ? e.message : String(e);
    if (/branch_scope/i.test(msg)) {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message:
        `That customer's locker belongs to another branch. You can only record visits for ${scopeNames || 'your assigned branch'}.` } });
    }
    throw e;
  }
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

// ── A17.1 push KYC to an application that reached them bare ───────────────
// Only needed for applications created before the screen started sending
// customer_id; A7 now carries the KYC with the create.
//
// Built server-side from our own book, exactly like the applicant block: the
// browser never supplies KYC fields, so it cannot be used to assert a
// verification the operator cannot otherwise see. And we refuse outright
// unless our record says Verified — LockerHub accepts this approved-on-
// arrival, so a false assertion here becomes a false record there.
lockersRouter.post('/applications/:id/kyc', asyncHandler(async (req, res) => {
  const { customer_id } = z.object({ customer_id: z.number().int().positive() }).parse(req.body ?? {});
  const { assertCustomerVisible } = await import('../../lib/visibility.js');
  await assertCustomerVisible(getDb(), req.user!, customer_id);
  const { buildKycEvidence } = await import('./applicant.js');
  const kyc = await buildKycEvidence(getDb(), customer_id);
  if (!kyc) throw errors.notFound('Customer not found');
  if (!kyc.verified) {
    throw errors.badRequest(
      "This customer's KYC is not verified in NCD, so there is nothing to hand over. Verify it on their profile first.");
  }
  if (!kyc.pan) throw errors.badRequest('This customer has no PAN on file — LockerHub needs it.');
  res.json(await lh.pushKyc(staffOf(req), String(req.params.id), kyc));
}));

// ── A16 the signed agreement, as a PDF ────────────────────────────────────
// Keyed on the AGREEMENT id (`esign_id` from A19.2 /esign/status), not the
// application id. Streamed through us rather than linked directly: their
// endpoint needs the integration key, which must never reach a browser.
lockersRouter.get('/agreements/:esignId/pdf', asyncHandler(async (req, res) => {
  const { body, contentType } = await lh.agreementPdf(staffOf(req), String(req.params.esignId));
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Disposition', `inline; filename="locker-agreement-${String(req.params.esignId)}.pdf"`);
  res.end(body);
}));

// ── A19 locker-agreement e-Sign (post-allotment) ──────────────────────────
// Read is open to anyone who can enrol — staff need to see whether the
// customer has signed. Starting one messages the customer (Digio emails and
// SMSes them), so it is a deliberate click, never a page load.
lockersRouter.get('/applications/:id/esign', asyncHandler(async (req, res) =>
  res.json(await lh.esignStatus(String(req.params.id)))));

lockersRouter.post('/applications/:id/esign/initiate', asyncHandler(async (req, res) =>
  res.json(await lh.esignInitiate(staffOf(req), String(req.params.id)))));

// ── A21 fee waivers: waiving rent/deposit OWED on an application ──────────
// Real money, unlike the informational deposit waiver above. Maker requests,
// Admin/CXO approves, and only THEN does it reach LockerHub — they apply it
// approved-on-arrival, so our checker is the control.
lockersRouter.get('/applications/:id/fee-waivers', asyncHandler(async (req, res) => {
  const { listFeeWaivers } = await import('./feeWaivers.js');
  res.json({ rows: await listFeeWaivers(getDb(), String(req.params.id)) });
}));

lockersRouter.post('/applications/:id/fee-waivers', requirePermission('lockers:waive'),
  asyncHandler(async (req, res) => {
    const b = z.object({
      leg: LEG,
      waiver_pct: z.number().positive().max(100).nullish(),
      waiver_amount: z.number().positive().nullish(),
      reason: z.string().trim().min(3, 'A reason is required'),
      customer_id: z.number().int().positive().nullish(),
      applicant_name: z.string().trim().nullish(),
    }).parse(req.body ?? {});
    const { requestFeeWaiver } = await import('./feeWaivers.js');
    res.status(201).json(await requestFeeWaiver(getDb(), req.user!, { lockerhub_application_id: String(req.params.id), ...b }));
  }));

// Re-send an approved waiver LockerHub refused. Idempotent on their side.
lockersRouter.post('/fee-waivers/:id/retry', requirePermission('lockers:waive'),
  asyncHandler(async (req, res) => {
    const { retryFeeWaiver } = await import('./feeWaivers.js');
    res.json(await retryFeeWaiver(getDb(), req.user!, Number(req.params.id)));
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
    // Carried when there's no NCD customer_id — a LockerHub-only applicant.
    applicant_name: z.string().nullish(),
    applicant_phone: z.string().nullish(),
    leg: LEG,
    amount: z.number().positive(),
    cheque_no: z.string().min(1),
    bank_name: z.string().nullish(),
    received_on: z.string().min(4),
    notes: z.string().nullish(),
  }).parse(req.body ?? {});
  const { recordCheque } = await import('./cheques.js');
  res.status(201).json(await recordCheque(getDb(), req.user!, {
    lockerApplicationId: b.lockerhub_application_id, customerId: b.customer_id ?? null,
    applicantName: b.applicant_name ?? null, applicantPhone: b.applicant_phone ?? null, leg: b.leg,
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

// Retry a settlement that failed after the cheque cleared (§A18 is idempotent).
// Same permission as the clear itself — it is the same money decision, just the
// half that didn't land the first time.
lockersRouter.post('/cheques/:id/settle-retry', requirePermission('applications:confirm-collection'),
  asyncHandler(async (req, res) => {
    const { retrySettlement } = await import('./cheques.js');
    res.json(await retrySettlement(getDb(), req.user!, Number(req.params.id)));
  }));

// ── A18 settle-offline: money taken OUTSIDE the payment link ──────────────
// Cash and transfer settle immediately — unlike a cheque there is nothing to
// clear, so there is no NCD-side instrument to track and this goes straight to
// LockerHub. Cheques deliberately do NOT come through here: they settle when
// the register clears them (see cheques.ts), because a cheque in hand can still
// bounce and settling early would allot a locker against paper.
lockersRouter.post('/applications/:id/settle-offline', requirePermission('applications:confirm-collection'),
  asyncHandler(async (req, res) => {
    const b = z.object({
      leg: LEG,
      method: z.enum(['cash', 'transfer']),
      reference: z.string().trim().max(120).optional(),
      received_on: z.string().trim().min(4).optional(),
      reason: z.string().trim().max(500).optional(),
    }).parse(req.body ?? {});
    res.json(await lh.settleOffline(staffOf(req), String(req.params.id), b));
  }));

lockersRouter.post('/cheques/:id/bounce', requirePermission('applications:confirm-collection'),
  asyncHandler(async (req, res) => {
    const { reason } = z.object({ reason: z.string().min(2) }).parse(req.body ?? {});
    const { bounceCheque } = await import('./cheques.js');
    res.json(await bounceCheque(getDb(), req.user!, Number(req.params.id), reason));
  }));
