/**
 * Locker profile — one place to see everything about a single locker/tenancy.
 *
 * Clicking a name on Locker Tenants used to open the generic customer page;
 * locker facts were scattered across enrolment, tenants and the customer card.
 * This aggregates them per LOCKER APPLICATION: the LockerHub-live record (the
 * locker, lease, rent/deposit, per-leg PAYMENT STATUS + references, allotment
 * and e-sign) layered with everything NCD stores of its own — the NCD backing
 * (pledges), cheques and their clearance, and fee waivers.
 *
 * LockerHub owns the money and the locker, so its fields are read live and never
 * persisted; a LockerHub outage degrades to `lockerhub_error` rather than a
 * blank page, and the NCD-side records still render.
 */
import type { Db } from '../../db/types.js';
import { errors } from '../../lib/errors.js';
import { toISODate } from '../../lib/dates.js';
import * as lh from '../../integrations/lockerhub/client.js';

export async function lockerProfile(db: Db, lockerApplicationId: string) {
  const appId = String(lockerApplicationId ?? '').trim();
  if (!appId) throw errors.badRequest('application_id is required');

  // ── NCD-side records, keyed by the locker application id ──────────────────
  const pledges = (await db.query<Record<string, unknown>>(
    `SELECT l.id, l.lockerhub_application_id, l.locker_no, l.locker_size, l.linked_amount, l.status,
            l.linked_at, l.released_at, l.released_reason, a.application_no, a.id AS application_id, a.customer_id
       FROM locker_deposit_links l JOIN applications a ON a.id = l.application_id
      WHERE l.lockerhub_application_id = $1 ORDER BY (l.status = 'active') DESC, l.id DESC`, [appId])).rows;

  const cheques = (await db.query<Record<string, unknown>>(
    `SELECT id, customer_id, leg, amount, cheque_no, bank_name, status, received_on, cleared_on, reference,
            lockerhub_settled_at, lockerhub_error, applicant_name
       FROM locker_cheques WHERE lockerhub_application_id = $1 ORDER BY (status = 'Pending') DESC, id DESC`, [appId])).rows;

  const feeWaivers = (await db.query<Record<string, unknown>>(
    `SELECT id, leg, waiver_pct, waiver_amount, reason, status, applicant_name, category,
            lockerhub_applied_at, lockerhub_error, created_at
       FROM locker_fee_waivers WHERE lockerhub_application_id = $1 ORDER BY id DESC`, [appId])).rows;

  // Resolve an NCD customer from whatever row carries one.
  // locker_applications FIRST: it is the index NCD writes at create time and
  // carries the customer for every application. Cheques and pledges only carry
  // one when money happened to move that way, so a locker whose rent was waived
  // and which backs no NCD had NO customer here at all — hirer 1 rendered as a
  // dash on a page listing hirer 2 by name (owner 2026-09-14).
  const indexed = (await db.query<{ customer_id: string | null; customer_name: string | null; phone: string | null; agreement_no: string | null }>(
    'SELECT customer_id, customer_name, phone, agreement_no FROM locker_applications WHERE lockerhub_application_id = $1',
    [appId])).rows[0];
  const customerId =
    (indexed?.customer_id as string | null | undefined) ??
    (cheques.find((q) => q.customer_id != null)?.customer_id as string | undefined) ??
    (pledges.find((p) => p.customer_id != null)?.customer_id as string | undefined) ?? null;
  let customer: Record<string, unknown> | null = null;
  if (customerId != null) {
    customer = (await db.query<Record<string, unknown>>(
      'SELECT id, full_name, customer_code, phone FROM customers WHERE id = $1', [Number(customerId)])).rows[0] ?? null;
  }
  // A walk-in created straight on LockerHub has no NCD customer row, but the
  // index still knows their name. Better a name than a dash on the line that
  // says who holds the locker.
  if (!customer && (indexed?.customer_name || indexed?.phone)) {
    customer = { id: null, full_name: indexed.customer_name, customer_code: null, phone: indexed.phone };
  }

  // ── LockerHub-live: the application (payments/legs/allotment/lease) + e-sign ─
  let lockerhub: Record<string, unknown> | null = null;
  let lockerhub_error: string | null = null;
  let esign: Record<string, unknown> | null = null;
  if (lh.lockerHubConfigured()) {
    try { lockerhub = await lh.getLockerApplication(appId) as Record<string, unknown>; }
    catch (e) { lockerhub_error = (e as Error).message; }
    // The application carries branch_id but no branch_name, so the profile showed
    // "—" for the branch. Resolve it against the branches list (same as the tenant
    // roster does) — best-effort, never fatal.
    if (lockerhub && !lockerhub.branch_name && lockerhub.branch_id) {
      try {
        const { branches } = await lh.branches();
        const b = branches.find((x) => String(x.id) === String(lockerhub!.branch_id));
        if (b) lockerhub.branch_name = b.name;
      } catch { /* branch lookup is cosmetic — leave it unresolved on failure */ }
    }
    // e-sign status only exists after allotment — best-effort, never fatal.
    try { esign = await lh.esignStatus(appId) as Record<string, unknown>; } catch { /* not signed yet / unreachable */ }
  }

  // How the agreement was signed — e-Sign or a physical signature (owner
  // 2026-09-03). Reconciled against LockerHub's answer on the way past, so an
  // e-Sign they report as done stamps our row; a physical one is left alone.
  const { syncFromEsignStatus } = await import('./agreements.js');
  const signing = await syncFromEsignStatus(db, appId, esign).catch(() => null);

  // Joint hirers. They have been saved since 089 and shown NOWHERE — not on
  // this page, not on the tenant roster — so a jointly-held locker looked
  // single-held everywhere except the agreement PDF, and staff reasonably
  // concluded the second holder had not saved (owner 2026-09-14).
  const { listHirers } = await import('./hirers.js');
  const hirers = await listHirers(db, appId).catch(() => []);

  return {
    locker_application_id: appId,
    // The number a person reads — DIF0061. The LockerHub id beside it is what
    // every route and every call to them is keyed on, so it stays on the page
    // for support and for matching against LockerHub's own screens; it is just
    // no longer the first thing you see (owner 2026-09-18).
    agreement_no: indexed?.agreement_no ?? null,
    // id stays NULL for a walk-in with no NCD record — Number(null) is 0, and a
    // customer id of 0 would render as a link to a customer that does not exist.
    customer: customer && {
      id: customer.id == null ? null : Number(customer.id),
      full_name: customer.full_name, customer_code: customer.customer_code, phone: customer.phone,
    },
    hirers,
    lockerhub,          // raw LockerHub record: legs, payments[], allotment, lease, rent, deposit
    lockerhub_error,    // set only on a fetch failure, so "no data" ≠ "outage"
    esign,              // A19 status (null until signing starts / on outage)
    signing,            // OUR record: which way it was signed, and where it got to
    pledges: pledges.map((p) => ({
      id: Number(p.id), application_id: Number(p.application_id), application_no: p.application_no,
      locker_no: p.locker_no, locker_size: p.locker_size, linked_amount: Number(p.linked_amount),
      status: p.status, linked_at: p.linked_at, released_at: p.released_at, released_reason: p.released_reason,
    })),
    cheques: cheques.map((q) => ({
      id: Number(q.id), leg: q.leg, amount: Number(q.amount), cheque_no: q.cheque_no, bank_name: q.bank_name,
      status: q.status, received_on: toISODate(q.received_on as string | null), cleared_on: toISODate(q.cleared_on as string | null),
      reference: q.reference ?? null,
      lockerhub_settled_at: q.lockerhub_settled_at ?? null, lockerhub_error: q.lockerhub_error ?? null,
    })),
    fee_waivers: feeWaivers.map((w) => ({
      id: Number(w.id), leg: w.leg, category: (w.category as string) ?? 'waiver',
      waiver_pct: w.waiver_pct == null ? null : Number(w.waiver_pct),
      waiver_amount: w.waiver_amount == null ? null : Number(w.waiver_amount),
      reason: w.reason, status: w.status,
      lockerhub_applied_at: w.lockerhub_applied_at ?? null, lockerhub_error: w.lockerhub_error ?? null,
      created_at: w.created_at ?? null,
    })),
  };
}
