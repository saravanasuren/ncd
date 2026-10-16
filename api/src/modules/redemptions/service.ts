/**
 * Redemptions (docs/02 §6, docs/17). Flows:
 *  - Customer/app REQUESTS a redemption → 'Requested' record (no approval yet).
 *  - Staff (NCD Manager) SUBMITS a request → 2-level approval (NCD → CXO).
 *  - Staff can initiate + submit in one step (initiatePremature).
 *  - On final approval the application is RELIABLY closed (regression-tested).
 *  - Maturity redemption closes a Matured application at par (no penalty).
 */
import type { Db } from '../../db/types.js';
import type { AuthUser } from '../../lib/authUser.js';
import { errors } from '../../lib/errors.js';
import { writeAudit } from '../../lib/audit.js';
import { assertTransition } from '../../lib/statusMachine.js';
import { nextCode } from '../../lib/sequences.js';
import { computeRedemption } from '../../lib/redemption.js';
import { computeTds, DEFAULT_TDS_RULE } from '../../lib/tds.js';
import { round2, roundRupee, toISODate } from '../../lib/dates.js';
import type { RateSpec } from '../../lib/incentive.js';
import { getSettingsMap } from '../settings/service.js';
import { scopeFor, scopeWhere } from '../../lib/scope.js';
import { createApprovalRequest, registerOnFinalApprove, registerOnReject, type ApprovalRow } from '../approvals/service.js';
import { emitForApplication } from '../../integrations/lockerhub/customerEvents.js';

async function outstandingPrincipal(db: Db, applicationId: number): Promise<number> {
  return Number((await db.query<{ p: string }>(
    "SELECT COALESCE(sum(outstanding_amount),0) AS p FROM application_lines WHERE application_id = $1 AND status = 'Active'",
    [applicationId]
  )).rows[0]!.p);
}

async function penaltySetting(db: Db): Promise<RateSpec> {
  const s = await getSettingsMap(db);
  return (s['redemption.premature_penalty'] as RateSpec) ?? { mode: 'pct', value: 1.0 };
}

/** Create a 'Requested' redemption record (no approval). Shared by all callers. */
async function createRequest(
  tx: Db,
  input: { applicationId: number; type: 'premature' | 'maturity'; reason: string; source: string; byCustomer: boolean; redemptionDate?: string; createdBy: number | null; amount?: number }
): Promise<{ id: number; redemption_no: string; principal: number; penalty: number; netPayment: number; brokenInterest: number }> {
  const outstanding = await outstandingPrincipal(tx, input.applicationId);
  // Money pledged to a live locker deposit is that locker's security — it can't
  // be redeemed until the link is released (owner spec 2026-07-22). Only the
  // FREE portion is redeemable: a ₹25L NCD backing a ₹3L locker can redeem ₹22L
  // and stay live with ₹3L still securing the locker.
  const { linkedAmount } = await import('../lockers/deposits.js');
  const pledged = await linkedAmount(tx, input.applicationId);
  const free = round2(outstanding - pledged);
  if (free <= 0) {
    throw errors.unprocessable(
      `₹${pledged.toLocaleString('en-IN')} of this investment is pledged to a live locker deposit and cannot be redeemed. Release the locker link first (once the locker is closed).`
    );
  }
  // Partial withdrawal: redeem a stated amount, capped at the free portion.
  // Omitted → redeem everything that isn't pledged.
  const principal = input.amount != null ? round2(input.amount) : free;
  if (principal <= 0) throw errors.badRequest('Redemption amount must be greater than zero');
  if (principal > free) {
    throw errors.unprocessable(
      pledged > 0
        ? `Only ₹${free.toLocaleString('en-IN')} is redeemable — ₹${pledged.toLocaleString('en-IN')} of the ₹${outstanding.toLocaleString('en-IN')} is pledged to a live locker deposit.`
        : `Only ₹${free.toLocaleString('en-IN')} is outstanding on this investment.`
    );
  }
  const penalty = input.type === 'maturity' ? { mode: 'flat' as const, value: 0 } : await penaltySetting(tx);
  const redDate = input.redemptionDate ?? new Date().toISOString().slice(0, 10);
  // Accrued broken-period interest (last paid → redemption date) is now COMPUTED
  // and SETTLED WITH the premature payout, net of TDS (owner review 2026-07-21).
  // It was previously silently 0 (coupon/dates never passed) and the documented
  // "paid separately next cycle" never fired — the line closes, so the interest
  // run (Active lines only) could never pay it. Single-Active-line apps compute
  // exactly; multi-line uses the first line's rate on the total.
  let brokenArgs: Partial<Parameters<typeof computeRedemption>[0]> = {};
  let brokenLine: Record<string, unknown> | undefined;
  if (input.type === 'premature') {
    brokenLine = (await tx.query<Record<string, unknown>>(
      `SELECT l.id AS line_id, l.coupon_rate_pct, l.day_count_convention, l.payout_frequency,
              l.amount AS line_amount, l.scheme_id,
              c.is_nri, c.tds_applicable AS cust_tds, c.tax_form, c.tax_form_expires_on,
              COALESCE((SELECT max(ds.due_date) FROM disbursement_schedule ds
                         WHERE ds.line_id = l.id AND ds.due_type IN ('Interest','BrokenInterest') AND ds.status = 'Paid'),
                       a.interest_start_date) AS paid_through
         FROM application_lines l JOIN applications a ON a.id = l.application_id
         JOIN customers c ON c.id = a.customer_id
        WHERE l.application_id = $1 AND l.status = 'Active' ORDER BY l.id LIMIT 1`, [input.applicationId])).rows[0];
    const paidThrough = toISODate((brokenLine?.paid_through as string | null) ?? null);
    if (brokenLine && paidThrough) {
      brokenArgs = {
        couponRatePct: Number(brokenLine.coupon_rate_pct),
        lastRegularPayoutDate: paidThrough,
        redemptionDate: redDate,
        convention: brokenLine.day_count_convention as never,
      };
    }
  }
  // Penalty applies to the amount actually WITHDRAWN, but the accrued interest
  // is settled on the FULL outstanding up to the redemption date. That matters
  // for a partial withdrawal: paying the broken-interest row advances the line's
  // paid-through watermark to this date, so any interest already earned by the
  // portion that STAYS invested must be paid out now — otherwise it would be
  // silently lost. The remainder then accrues fresh from the redemption date.
  // (For a full redemption the two bases are equal, so nothing changes.)
  const calc = computeRedemption({ principal, penalty });
  const accrued = computeRedemption({ principal: outstanding, penalty: { mode: 'flat', value: 0 }, ...brokenArgs });
  // 🔒 Whole rupees, owner-approved 2026-08-16. A redemption's broken interest
  // is paid on the monthly interest sheet as a 'Redemption' row and is taken
  // there AS IS — never recomputed — so if it is not rounded HERE it arrives on
  // an otherwise whole-rupee NEFT file carrying paise.
  calc.brokenInterest = roundRupee(accrued.brokenInterest);
  // TDS on the broken interest (same rule the interest run uses), then fold the
  // net into the settlement. net_payment = (principal − penalty) + brokenNet.
  let brokenNet = 0;
  let brokenTds = 0;
  if (calc.brokenInterest > 0 && brokenLine) {
    const tdsRule = brokenLine.scheme_id
      ? (await tx.query<{ rate_pct: number }>('SELECT tr.* FROM schemes s JOIN tds_rules tr ON tr.id = s.tds_rule_id WHERE s.id = $1', [brokenLine.scheme_id])).rows[0] ?? DEFAULT_TDS_RULE
      : DEFAULT_TDS_RULE;
    brokenTds = roundRupee(computeTds(
      tdsRule,
      { is_nri: brokenLine.is_nri as boolean, tds_applicable: brokenLine.cust_tds as boolean,
        tax_form: brokenLine.tax_form as string | null, tax_form_expires_on: toISODate(brokenLine.tax_form_expires_on as string | null) },
      { payout_frequency: brokenLine.payout_frequency as string, amount: Number(brokenLine.line_amount) },
      { due_type: 'BrokenInterest', gross_amount: calc.brokenInterest, due_date: redDate },
    ));
    // Both inputs whole ⇒ whole, and NOT re-rounded — same rule as the
    // interest run: net = gross − tds, nothing more.
    brokenNet = calc.brokenInterest - brokenTds;
  }
  // Owner 2026-07-24: the broken interest is NOT bundled into the redemption
  // transfer any more — it is paid in that month's interest batch as a
  // 'Redemption' row. So the redemption pays principal less penalty only.
  // brokenNet/brokenTds are still recorded so the batch can pay them exactly.
  const netPayment = calc.netPayment;
  const redNo = await nextCode(tx, 'redemption', 'MCR-{yyyy}-{seq:6}');
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO redemptions (redemption_no, application_id, type, principal, penalty, net_payment, broken_interest, broken_tds, requested_date, redemption_date, reason, status, source, requested_by_customer, created_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'Requested',$12,$13,$14) RETURNING id`,
    [redNo, input.applicationId, input.type, calc.principal, calc.penalty, netPayment, calc.brokenInterest, brokenTds, redDate, redDate, input.reason, input.source, input.byCustomer, input.createdBy]
  );
  return { id: Number(rows[0]!.id), redemption_no: redNo, principal: calc.principal, penalty: calc.penalty, netPayment, brokenInterest: calc.brokenInterest };
}

/** Customer / app requests a redemption (no approval yet — lands in the staff queue). */
export async function requestRedemption(db: Db, input: { applicationId: number; reason: string; source: 'portal' | 'lockerhub'; createdBy?: number | null }) {
  return db.withTx(async (tx) => {
    const app = (await tx.query<{ status: string }>('SELECT status FROM applications WHERE id = $1', [input.applicationId])).rows[0];
    if (!app) throw errors.notFound('Application not found');
    if (app.status !== 'Active') throw errors.unprocessable('Only Active investments can be redeemed');
    const dupe = await tx.query("SELECT 1 FROM redemptions WHERE application_id = $1 AND status IN ('Requested','Approved')", [input.applicationId]);
    if (dupe.rowCount) throw errors.conflict('A redemption is already in progress for this investment');
    const r = await createRequest(tx, { applicationId: input.applicationId, type: 'premature', reason: input.reason, source: input.source, byCustomer: true, createdBy: input.createdBy ?? null });
    await writeAudit(tx, { actorId: input.createdBy ?? null, action: 'redemption.request', entityType: 'redemptions', entityId: r.id, after: { source: input.source, net: r.netPayment } });
    return r;
  });
}

/** Staff submits an existing 'Requested' redemption into the 2-level approval. */
export async function submitForApproval(db: Db, staff: AuthUser, redemptionId: number): Promise<ApprovalRow> {
  return db.withTx(async (tx) => {
    const red = (await tx.query<{ status: string; application_id: string; redemption_date: string; net_payment: string; penalty: string; approval_request_id: string | null }>(
      'SELECT status, application_id, redemption_date, net_payment, penalty, approval_request_id FROM redemptions WHERE id = $1', [redemptionId])).rows[0];
    if (!red) throw errors.notFound('Redemption not found');
    if (red.status !== 'Requested' || red.approval_request_id) throw errors.conflict('Redemption is not awaiting submission');
    const req = await createApprovalRequest(tx, {
      type: 'premature_redemption', entityType: 'redemptions', entityId: redemptionId, makerUserId: staff.id,
      metadata: { application_id: Number(red.application_id), redemption_id: redemptionId, redemption_date: red.redemption_date, net_payment: Number(red.net_payment), penalty: Number(red.penalty) },
    });
    await tx.query('UPDATE redemptions SET approval_request_id = $1 WHERE id = $2', [req.id, redemptionId]);
    await writeAudit(tx, { actorId: staff.id, action: 'redemption.submit', entityType: 'redemptions', entityId: redemptionId, after: { request_no: req.request_no } });
    return req;
  });
}

/** Staff initiates + submits a premature redemption in one step. */
export async function initiatePremature(db: Db, actor: AuthUser, input: { application_id: number; redemption_date?: string; reason: string; amount?: number }) {
  const app = (await db.query<{ status: string }>('SELECT status FROM applications WHERE id = $1', [input.application_id])).rows[0];
  if (!app) throw errors.notFound('Application not found');
  if (app.status !== 'Active') throw errors.unprocessable('Only Active applications can be prematurely redeemed');
  const rec = await db.withTx(async (tx) =>
    createRequest(tx, { applicationId: input.application_id, type: 'premature', reason: input.reason, source: 'staff', byCustomer: false, redemptionDate: input.redemption_date, createdBy: actor.id, amount: input.amount }));
  const req = await submitForApproval(db, actor, rec.id);
  return { redemption_id: rec.id, redemption_no: rec.redemption_no, request: req, principal: rec.principal, penalty: rec.penalty, netPayment: rec.netPayment, brokenInterest: rec.brokenInterest };
}

/** Maturity redemption — maker→checker approval gate (old-app parity: it does
 * NOT close immediately; a checker must approve). */
export async function initiateMaturity(db: Db, actor: AuthUser, applicationId: number) {
  return db.withTx(async (tx) => {
    const app = (await tx.query<{ status: string }>('SELECT status FROM applications WHERE id = $1', [applicationId])).rows[0];
    if (!app) throw errors.notFound('Application not found');
    if (app.status !== 'Matured' && app.status !== 'Active') throw errors.unprocessable('Only Matured/Active applications can be redeemed at maturity');
    const dupe = await tx.query("SELECT 1 FROM redemptions WHERE application_id = $1 AND status IN ('Requested','Approved')", [applicationId]);
    if (dupe.rowCount) throw errors.conflict('A redemption is already in progress for this investment');
    const rec = await createRequest(tx, { applicationId, type: 'maturity', reason: 'Maturity redemption', source: 'staff', byCustomer: false, createdBy: actor.id });
    const req = await createApprovalRequest(tx, {
      type: 'redemption', entityType: 'redemptions', entityId: rec.id, makerUserId: actor.id,
      metadata: { application_id: applicationId, redemption_id: rec.id },
    });
    await tx.query('UPDATE redemptions SET approval_request_id = $1 WHERE id = $2', [req.id, rec.id]);
    await writeAudit(tx, { actorId: actor.id, action: 'redemption.maturity.initiate', entityType: 'redemptions', entityId: rec.id });
    return { redemption_id: rec.id, redemption_no: rec.redemption_no, request: req };
  });
}

/**
 * CXO waives / discounts a pending premature penalty before approving.
 * new_penalty = 0 (waive) or a reduced amount (discount); can't exceed the
 * current penalty or go negative. Recomputes net = principal − penalty and
 * mirrors the new figures onto the approval request so the card is truthful.
 */
export async function adjustPrematurePenalty(db: Db, actor: AuthUser, redemptionId: number, input: { new_penalty: number; reason: string }) {
  const settings = await getSettingsMap(db);
  if (settings['redemption.premature_penalty_waiver_enabled'] === false) {
    throw errors.unprocessable('Premature penalty waivers are turned off in Settings');
  }
  if (input.new_penalty < 0) throw errors.badRequest('Penalty cannot be negative');
  if (!input.reason?.trim() || input.reason.trim().length < 3) throw errors.badRequest('A reason is required');

  return db.withTx(async (tx) => {
    const red = (await tx.query<{ type: string; status: string; principal: string; penalty: string; net_payment: string; penalty_original: string | null; approval_request_id: string | null }>(
      'SELECT type, status, principal, penalty, net_payment, penalty_original, approval_request_id FROM redemptions WHERE id = $1 FOR UPDATE', [redemptionId])).rows[0];
    if (!red) throw errors.notFound('Redemption not found');
    if (red.type !== 'premature') throw errors.unprocessable('Only premature redemptions carry a penalty');
    if (red.status !== 'Requested') throw errors.unprocessable('This redemption is no longer pending approval');
    const current = Number(red.penalty);
    if (input.new_penalty > current + 0.001) throw errors.badRequest('The penalty can only be waived or reduced, not increased');

    const principal = Number(red.principal);
    // Preserve the settled broken-interest portion of the payout across the
    // penalty change: net = (principal − penalty) + brokenNet.
    const brokenNet = round2(Number(red.net_payment) - (principal - current));
    const newPenalty = round2(input.new_penalty);
    const newNet = round2(principal - newPenalty + brokenNet);
    const original = red.penalty_original != null ? Number(red.penalty_original) : current;

    await tx.query(
      `UPDATE redemptions SET penalty = $1, net_payment = $2,
         penalty_original = $3, penalty_waived_by_user_id = $4, penalty_waive_reason = $5, penalty_waived_at = now()
       WHERE id = $6`,
      [newPenalty, newNet, original, actor.id, input.reason.trim(), redemptionId]);

    // Keep the approval card's metadata in sync (it shows penalty + net_payment).
    if (red.approval_request_id) {
      await tx.query(
        `UPDATE approval_requests SET metadata = metadata || jsonb_build_object('penalty', $1::numeric, 'net_payment', $2::numeric, 'penalty_waived', true) WHERE id = $3`,
        [newPenalty, newNet, Number(red.approval_request_id)]);
    }
    await writeAudit(tx, { actorId: actor.id, action: 'redemption.penalty-waive', entityType: 'redemptions', entityId: redemptionId, before: { penalty: current }, after: { penalty: newPenalty, net_payment: newNet, reason: input.reason.trim() } });
    return { redemption_id: redemptionId, penalty: newPenalty, penalty_original: original, net_payment: newNet };
  });
}

/** On maturity-redemption approval: close the application at par. */
registerOnFinalApprove('redemption', async (tx, req) => {
  const appId = Number(req.metadata.application_id);
  const redId = Number(req.metadata.redemption_id);
  const app = (await tx.query<{ status: string }>('SELECT status FROM applications WHERE id = $1', [appId])).rows[0];
  if (!app) return;
  if (app.status === 'Active') {
    assertTransition('application', 'Active', 'Matured');
    await tx.query("UPDATE applications SET status = 'Matured' WHERE id = $1", [appId]);
  }
  assertTransition('application', 'Matured', 'Redeemed');
  await tx.query("UPDATE applications SET status = 'Redeemed', redemption_date = now(), updated_at = now() WHERE id = $1", [appId]);
  await tx.query("UPDATE application_lines SET status = 'Matured' WHERE application_id = $1 AND status = 'Active'", [appId]);
  await tx.query("UPDATE redemptions SET status = 'Approved' WHERE id = $1", [redId]);
  await emitForApplication(tx, 'redemption.completed', appId, `red:${redId}`);
});

registerOnFinalApprove('premature_redemption', async (tx, req) => {
  const appId = Number(req.metadata.application_id);
  const redId = Number(req.metadata.redemption_id);
  const redDate = String(req.metadata.redemption_date ?? new Date().toISOString().slice(0, 10));
  const app = (await tx.query<{ status: string }>('SELECT status FROM applications WHERE id = $1', [appId])).rows[0];
  if (!app) return;

  // How much of the investment is being withdrawn, and what's left after it.
  const withdrawn = Number((await tx.query<{ principal: string }>(
    'SELECT principal FROM redemptions WHERE id = $1', [redId])).rows[0]?.principal ?? 0);
  const outstandingBefore = await outstandingPrincipal(tx, appId);
  const remaining = round2(outstandingBefore - withdrawn);

  if (remaining > 0) {
    // ── PARTIAL withdrawal (owner spec 2026-07-22) ────────────────────────
    // e.g. redeem ₹22L of a ₹25L investment and stay live with the ₹3L that
    // secures a locker. The investment is NOT closed: each line's outstanding
    // is reduced (in order) and its remaining projections are scaled down.
    // Interest is linear in principal, so scaling the unpaid rows by
    // remaining/before is exact — far safer than re-materialising over paid rows.
    let left = withdrawn;
    const lines = (await tx.query<{ id: string; outstanding_amount: string }>(
      "SELECT id, outstanding_amount FROM application_lines WHERE application_id = $1 AND status = 'Active' ORDER BY id", [appId])).rows;
    for (const l of lines) {
      if (left <= 0) break;
      const before = Number(l.outstanding_amount);
      const take = Math.min(before, left);
      const after = round2(before - take);
      left = round2(left - take);
      await tx.query('UPDATE application_lines SET outstanding_amount = $1 WHERE id = $2', [after, Number(l.id)]);
      // Scale this line's UNPAID future projections to the reduced principal.
      const ratio = before > 0 ? after / before : 0;
      // net is DERIVED, never rounded on its own — chk_ds_net enforces
      // net = gross - tds, and rounding all three independently breaks it.
      await tx.query(
        `UPDATE disbursement_schedule
            SET gross_amount = ROUND(gross_amount * $2, 2),
                tds_amount   = ROUND(tds_amount   * $2, 2),
                net_amount   = ROUND(gross_amount * $2, 2) - ROUND(tds_amount * $2, 2)
          WHERE line_id = $1 AND status = 'Scheduled' AND batch_id IS NULL
            AND due_type IN ('Interest','BrokenInterest') AND due_date > $3::date`,
        [Number(l.id), ratio, redDate]);
      if (after <= 0) await tx.query("UPDATE application_lines SET status = 'PrematureWithdrawn' WHERE id = $1", [Number(l.id)]);
    }
    await writeAudit(tx, {
      actorId: null, action: 'redemption.partial', entityType: 'applications', entityId: appId,
      after: { redemption_id: redId, withdrawn, outstanding_before: outstandingBefore, outstanding_after: remaining },
    });
    // The investment stays Active — fall through only to write the payout rows.
  } else {
    assertTransition('application', app.status, 'Redeemed');
    await tx.query("UPDATE applications SET status = 'Redeemed', redemption_date = $1, updated_at = now() WHERE id = $2", [redDate, appId]);
    await emitForApplication(tx, 'redemption.completed', appId, `red:${redId}`);
    await tx.query("UPDATE application_lines SET status = 'PrematureWithdrawn', outstanding_amount = 0 WHERE application_id = $1 AND status = 'Active'", [appId]);
    await tx.query("UPDATE disbursement_schedule SET status = 'Skipped' WHERE application_id = $1 AND status = 'Scheduled'", [appId]);
  }
  const red = (await tx.query<{ principal: string; penalty: string; net_payment: string; broken_interest: string; broken_tds: string }>(
    'SELECT principal, penalty, net_payment, broken_interest, broken_tds FROM redemptions WHERE id = $1', [redId])).rows[0]!;
  const lineId = (await tx.query<{ id: string }>('SELECT id FROM application_lines WHERE application_id = $1 ORDER BY id LIMIT 1', [appId])).rows[0]?.id;
  if (lineId) {
    // Two rows, paid through DIFFERENT sheets (owner 2026-07-24):
    //  · 'Premature'      — principal less penalty, paid by the redemption NEFT
    //                       sheet. This IS net_payment now.
    //  · 'BrokenInterest' — the accrued interest, left Scheduled for THAT
    //                       month's interest batch to pick up and pay as a
    //                       'Redemption' row. Its TDS was computed and stored at
    //                       request time (it can no longer be derived from
    //                       net_payment, which excludes the interest).
    const principalNet = round2(Number(red.principal) - Number(red.penalty));
    const brokenGross = Number(red.broken_interest);
    const brokenTds = Number(red.broken_tds);
    const brokenNet = round2(brokenGross - brokenTds);
    await tx.query(
      `INSERT INTO disbursement_schedule (line_id, application_id, due_date, due_type, gross_amount, tds_amount, net_amount, status)
       VALUES ($1,$2,$3,'Premature',$4,0,$4,'Scheduled') ON CONFLICT (line_id, due_date, due_type) DO NOTHING`,
      [Number(lineId), appId, redDate, principalNet]);
    if (brokenGross >= 0) {
      // principal_basis = the principal this interest was actually earned on,
      // which is what the summary sheet prints as "Invested". Note it is the
      // outstanding BEFORE the withdrawal, not the withdrawn slice: the accrual
      // above deliberately runs on the full outstanding (owner 2026-07-22) so
      // the portion that stays invested doesn't lose the interest it has already
      // earned. For a full redemption the two are the same number.
      // It also marks this row as a REDEMPTION slice rather than a maturity
      // catch-up — the sheet reads it to end the period a day early.
      //
      // >= 0, not > 0 (owner 2026-07-27, repeated instruction): a redemption
      // the day right after the last payout genuinely earns ₹0 broken
      // interest, but it still belongs to that month's batch/sheet — the row
      // must exist so it can show up paid at ₹0, not be silently absent.
      await tx.query(
        `INSERT INTO disbursement_schedule (line_id, application_id, due_date, due_type, gross_amount, tds_amount, net_amount, status, principal_basis)
         VALUES ($1,$2,$3,'BrokenInterest',$4,$5,$6,'Scheduled',$7) ON CONFLICT (line_id, due_date, due_type) DO NOTHING`,
        [Number(lineId), appId, redDate, brokenGross, brokenTds, brokenNet, outstandingBefore]);
    }
  }
  await tx.query("UPDATE redemptions SET status = 'Approved', redemption_date = $1 WHERE id = $2", [redDate, redId]);
});

/** Federal Bank NEFT sheet for approved (unpaid) redemptions. */
/**
 * The NEFT sheet for ONE redemption — the instruction to pay that customer.
 *
 * Two rules, both owner 2026-10-16, and both exist because a second copy of a
 * payment line is how somebody gets paid twice. Nothing downstream catches it:
 * the UTR is filled in on only 1 of the 88 settled redemptions, so the data
 * cannot tell you afterwards whether the money moved.
 *
 * 1. ONLY WHILE IT IS PAYABLE. The sheet is produced for an 'Approved'
 *    redemption and nothing else ("for the ones which are redeemed make the
 *    neft sheet download button not to work as the redemption is already
 *    made"). 'Paid' is the case asked for; 'Requested' is refused by the same
 *    rule, which also closes a real hole — a sheet could previously be pulled
 *    for a redemption nobody had approved yet, straight past maker/checker.
 *    Rejected and Cancelled are refused for the obvious reason.
 *
 * 2. ONCE. "keep it as downloaded only once. only super admin will have the
 *    access to download it again." Super Admin is the way back in when a file
 *    is lost before payment, and every re-issue is audited. That escape hatch
 *    does NOT extend to rule 1: once a redemption is Paid there is no payment
 *    left to make, so nobody gets a bank instruction for it — the redemption
 *    report is the route to a record copy.
 *
 * The bulk sheet this function also used to build is gone (owner: "remove that
 * button"). Releasing every payable line at once is the opposite of releasing
 * an instruction deliberately, one customer at a time.
 *
 * Marking happens only once the workbook has actually been built. A sheet that
 * failed to generate was never handed over, and must not burn the one copy.
 */
export async function redemptionNeft(db: Db, actor: AuthUser, redemptionId: number): Promise<Buffer> {
  const superAdmin = actor.role === 'super_admin';
  const debit = (await db.query<{ account_number: string }>("SELECT account_number FROM banks WHERE is_disbursement_account = TRUE AND is_active = TRUE ORDER BY id LIMIT 1")).rows[0];
  const neftSettings = await getSettingsMap(db);
  const asText = (v: unknown): string => {
    const t = (v === null || v === undefined ? '' : String(v)).trim();
    return t === 'null' || t === 'undefined' ? '' : t;
  };
  const debitSetting = asText(neftSettings['payouts.neft_debit_account']);
  const fallbackEmail = asText(neftSettings['payouts.neft_beneficiary_email']);
  const rows = (await db.query<Record<string, unknown>>(
    `SELECT r.id, r.redemption_no, r.net_payment, r.redemption_date, r.status, r.neft_download_count,
            r.neft_downloaded_at, nu.full_name AS downloaded_by, c.full_name AS name, c.email,
            cba.account_number AS payee_account, cba.ifsc AS payee_ifsc,
            cba.holder_name AS beneficiary_name, s.name AS series_name
     FROM redemptions r JOIN applications a ON a.id = r.application_id JOIN customers c ON c.id = a.customer_id
     LEFT JOIN customer_bank_accounts cba ON cba.customer_id = c.id AND cba.is_active = TRUE
     LEFT JOIN series s ON s.id = a.series_id
     LEFT JOIN users nu ON nu.id = r.neft_downloaded_by_user_id
     WHERE r.id = $1`, [redemptionId])).rows;
  if (rows.length === 0) throw errors.notFound('Redemption not found');
  const red = rows[0]!;

  // Rule 1 — payable, or no sheet. Named statuses rather than a catch-all, so
  // the refusal tells the person which case they are in.
  if (String(red.status) !== 'Approved') {
    const why: Record<string, string> = {
      Paid: 'This redemption has already been paid, so there is no payment left to make.'
        + ' Use the redemption report if you need a record of it.',
      Requested: 'This redemption has not been approved yet. The NEFT sheet is released only after approval.',
      Rejected: 'This redemption was rejected, so it must not be paid.',
      Cancelled: 'This redemption was cancelled, so it must not be paid.',
    };
    throw errors.conflict(why[String(red.status)]
      ?? `A NEFT sheet is only produced for an approved redemption; this one is ${String(red.status)}.`);
  }

  // Rule 2 — once. Refuse by NAME and DATE, not a bare "already downloaded":
  // the next thing the person does is go and ask someone, and they need to
  // know who.
  if (red.neft_downloaded_at && !superAdmin) {
    throw errors.conflict(
      `This NEFT sheet was already downloaded on ${String(red.neft_downloaded_at).slice(0, 10)}`
      + `${red.downloaded_by ? ` by ${red.downloaded_by}` : ''}. Paying from a second copy would pay the customer twice.`
      + ' A Super Admin can release it again if the first file was lost.');
  }
  const { buildNeftSheet } = await import('../../lib/neft.js');
  const sheet = await buildNeftSheet(
    { debitAccount: debitSetting || debit?.account_number || 'DISBURSEMENT-ACCT',
      sheetName: 'Sheet 1',
      valueDate: new Date(),     // value date = the day the sheet is generated
      beneficiaryEmail: fallbackEmail },
    rows.map((r) => ({
      amount: Number(r.net_payment), valueDate: String(r.redemption_date ?? new Date().toISOString().slice(0, 10)),
      beneAccount: String(r.payee_account ?? ''),
      // Beneficiary Name is the bank account's own holder, not the customer
      // record — joint/differently-named accounts must match the bank.
      beneName: String(r.beneficiary_name || r.name || ''), ifsc: String(r.payee_ifsc ?? ''),
      seriesName: String(r.series_name ?? ''),
      // Debit Remarks: 'ncdredemption' for a redemption sheet (the interest sheet
      // uses 'ncdinterest') — owner-confirmed exact string, goes verbatim to the bank.
      debitRemark: 'ncdredemption',
      // Unique reference must carry no symbols/spaces (some bank portals reject
      // them): MCR-2026-000157 → MCR2026000157.
      reference: String(r.redemption_no).replace(/[^A-Za-z0-9]/g, ''),
    }))
  );

  // Burn the copy only now that a real workbook exists. Order matters: a build
  // that threw never reached a person, and marking it first would have locked
  // the redemption on a failure nobody could see.
  const issued = rows.map((r) => Number(r.id));
  if (issued.length) {
    await db.query(
      `UPDATE redemptions
          SET neft_downloaded_at = COALESCE(neft_downloaded_at, now()),
              neft_downloaded_by_user_id = COALESCE(neft_downloaded_by_user_id, $2),
              neft_download_count = neft_download_count + 1
        WHERE id = ANY($1::bigint[])`, [issued, actor.id]);
    // The FIRST issue is routine; a re-issue is the event worth finding later,
    // so only that is audited — one row per redemption, naming the Super Admin.
    for (const r of rows) {
      if (Number(r.neft_download_count ?? 0) > 0) {
        await writeAudit(db, {
          actorId: actor.id, action: 'redemption.neft-reissued', entityType: 'redemptions', entityId: Number(r.id),
          before: { neft_download_count: Number(r.neft_download_count) },
          after: { reissued_by_role: actor.role, redemption_no: r.redemption_no },
        });
      }
    }
  }
  return sheet;
}

/** Scope predicate for redemptions, by the underlying application's owner. */
function redemptionScope(actor: AuthUser, offset = 0) {
  return scopeWhere(scopeFor(actor), { userCol: 'a.enrolled_by_user_id', agentCol: 'a.enrolled_by_agent_id', branchCol: 'c.branch_id', refCol: "COALESCE(NULLIF(btrim(a.referred_by_text), ''), c.referred_by_text)"}, offset);
}

/** Redemption report (scoped to the caller) as xlsx. */
export async function redemptionReport(db: Db, actor: AuthUser): Promise<Buffer> {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Redemptions');
  ws.addRow(['Ref', 'Customer', 'Application', 'Type', 'Principal', 'Penalty', 'Net', 'Status', 'Date']).eachCell((c) => { c.font = { bold: true }; });
  const sc = redemptionScope(actor);
  const rows = (await db.query<Record<string, unknown>>(
    `SELECT r.redemption_no, c.full_name, a.application_no, r.type, r.principal, r.penalty, r.net_payment, r.status, r.redemption_date
     FROM redemptions r JOIN applications a ON a.id = r.application_id JOIN customers c ON c.id = a.customer_id
     WHERE ${sc.sql} ORDER BY r.created_at DESC`, sc.params)).rows;
  for (const r of rows) ws.addRow([r.redemption_no, r.full_name, r.application_no, r.type, Number(r.principal), Number(r.penalty), Number(r.net_payment), r.status, r.redemption_date]);
  [5, 6, 7].forEach((i) => { ws.getColumn(i).numFmt = '#,##,##0.00'; });
  ws.columns.forEach((c) => { c.width = 16; });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export async function listRedemptions(db: Db, actor: AuthUser, filter?: 'requests' | 'all') {
  const sc = redemptionScope(actor);
  const conds = [sc.sql];
  if (filter === 'requests') conds.push("r.status = 'Requested' AND r.approval_request_id IS NULL");
  return (await db.query(
    `SELECT r.id, r.redemption_no, r.type, r.status, r.source, r.requested_by_customer, r.principal, r.penalty, r.net_payment, r.redemption_date, r.approval_request_id,
            -- Whether the payment instruction has already left the building, so
            -- the page can say "issued 14 Oct by X" instead of offering a second
            -- copy of it (owner 2026-10-16).
            r.neft_downloaded_at, r.neft_download_count, nu.full_name AS neft_downloaded_by,
            -- The reason the customer gave, and the bank reference once the
            -- money has gone (owner 2026-10-16: "i should be able to see the
            -- reson for redeemetion when i click on the customers redeemetion"
            -- + "only when i enter the utr number for the transaction").
            -- Carried on the list rather than behind a detail call: the panel
            -- opens under the row it belongs to, and a second round trip to
            -- show two fields already in hand would just be latency.
            r.reason, r.utr, r.broken_interest, r.requested_date, r.created_at,
            cb.full_name AS created_by, uu.full_name AS utr_entered_by, r.utr_entered_at,
            a.application_no, c.full_name AS customer_name
     FROM redemptions r JOIN applications a ON a.id = r.application_id JOIN customers c ON c.id = a.customer_id
     LEFT JOIN users nu ON nu.id = r.neft_downloaded_by_user_id
     LEFT JOIN users cb ON cb.id = r.created_by_user_id
     LEFT JOIN users uu ON uu.id = r.utr_entered_by_user_id
     WHERE ${conds.join(' AND ')} ORDER BY r.created_at DESC LIMIT 2000`, sc.params)).rows;
}

// On REJECT of a redemption approval, mark the redemption Rejected (terminal).
// Without this the row stayed 'Requested' with an approval_request_id set — it
// vanished from the queue, couldn't be resubmitted, and blocked any new
// redemption on the same investment. (Review 2026-07-21.)
async function rejectRedemption(tx: Db, req: ApprovalRow) {
  const redId = Number(req.metadata.redemption_id);
  if (!redId) return;
  await tx.query("UPDATE redemptions SET status = 'Rejected' WHERE id = $1 AND status = 'Requested'", [redId]);
}
registerOnReject('premature_redemption', rejectRedemption);
registerOnReject('redemption', rejectRedemption);

/**
 * Record the bank reference for a redemption that has been paid.
 *
 * Owner 2026-10-16: "only when i enter the utr number for the transaction. so
 * get me that field also." Asked and answered the same day — the UTR RECORDS
 * the transaction and nothing more. It does not move the redemption's status,
 * so the NEFT rules in redemptionNeft are untouched by it.
 *
 * That matters because the column has been on the table since 003 and nothing
 * has ever written to it: 1 of 88 settled redemptions carries a reference, and
 * that one came in with the wealth import. Until now there was no way to say
 * from inside NCD that a redemption's money actually moved.
 *
 * Anyone who handles redemptions may enter one — they are recording a fact the
 * bank gave them, not authorising anything. CHANGING one is Super Admin only
 * (owner's choice), because a payment reference that can be quietly rewritten
 * is worth less than no reference at all. Both are audited; the correction
 * keeps the old value in `before`.
 */
export async function setRedemptionUtr(db: Db, actor: AuthUser, redemptionId: number, rawUtr: string) {
  // Permissive on shape, like the NEFT sheet itself: banks hand back references
  // in several formats and a validator that guesses wrong blocks a real payment
  // from being recorded. Non-empty, sane length, no control characters.
  const utr = rawUtr.trim().toUpperCase();
  if (utr.length < 6 || utr.length > 40) throw errors.badRequest('A UTR is between 6 and 40 characters.');
  if (!/^[A-Z0-9/-]+$/.test(utr)) throw errors.badRequest('A UTR may contain only letters, digits, hyphens and slashes.');

  const sc = redemptionScope(actor, 1);
  const cur = (await db.query<{ id: string; utr: string | null; status: string; redemption_no: string }>(
    `SELECT r.id, r.utr, r.status, r.redemption_no FROM redemptions r
       JOIN applications a ON a.id = r.application_id JOIN customers c ON c.id = a.customer_id
      WHERE r.id = $1 AND ${sc.sql}`, [redemptionId, ...sc.params])).rows[0];
  if (!cur) throw errors.notFound('Redemption not found');

  if (cur.utr && cur.utr !== utr && actor.role !== 'super_admin') {
    throw errors.conflict(
      `This redemption already carries UTR ${cur.utr}. Only a Super Admin can change a payment reference once it is recorded.`);
  }
  if (cur.utr === utr) return { ok: true, utr, unchanged: true };

  await db.query(
    `UPDATE redemptions SET utr = $2, utr_entered_by_user_id = $3, utr_entered_at = now() WHERE id = $1`,
    [redemptionId, utr, actor.id]);
  await writeAudit(db, {
    actorId: actor.id, action: cur.utr ? 'redemption.utr-corrected' : 'redemption.utr-recorded',
    entityType: 'redemptions', entityId: redemptionId,
    before: { utr: cur.utr }, after: { utr, redemption_no: cur.redemption_no, status_unchanged: cur.status },
  });
  return { ok: true, utr, unchanged: false };
}
