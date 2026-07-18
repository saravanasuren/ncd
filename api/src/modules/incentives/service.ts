/** Incentives payout ledger (docs/02 §5). Balance = Σaccrued − Σpaid;
 * partial payments supported. */
import type { Db } from '../../db/types.js';
import type { AuthUser } from '../../lib/authUser.js';
import { errors } from '../../lib/errors.js';
import { writeAudit } from '../../lib/audit.js';
import { round2 } from '../../lib/dates.js';

/**
 * A "self-investment": the payee is the same person as the customer, so no
 * incentive is owed (owner rule 2026-07-18). Staff/agent → phone match
 * (digits-only); referrer (free-text name) → name match. Evaluated per accrual
 * `ia`, which must be joined to application `a` and customer `c`. Wrapped in
 * COALESCE(...,false) at the call site so a NULL never mis-excludes a row.
 */
const SELF_INVESTMENT = `(
  (ia.payee_type = 'staff'    AND c.phone IS NOT NULL AND regexp_replace(c.phone,'\\D','','g') <> ''
     AND regexp_replace(c.phone,'\\D','','g') = (SELECT regexp_replace(u.phone,'\\D','','g') FROM users u WHERE u.id = ia.payee_id))
  OR (ia.payee_type = 'agent' AND c.phone IS NOT NULL AND regexp_replace(c.phone,'\\D','','g') <> ''
     AND regexp_replace(c.phone,'\\D','','g') = (SELECT regexp_replace(ag.phone,'\\D','','g') FROM agents ag WHERE ag.id = ia.payee_id))
  OR (ia.payee_type = 'referrer'
     AND lower(btrim(c.full_name)) = (SELECT lower(btrim(rf.display_name)) FROM referrers rf WHERE rf.id = ia.payee_id))
)`;
const NOT_SELF = `NOT COALESCE(${SELF_INVESTMENT}, false)`;
const ACCRUAL_FROM = `FROM incentive_accruals ia
  JOIN applications a ON a.id = ia.application_id
  JOIN customers c ON c.id = a.customer_id
  JOIN series s ON s.id = a.series_id`;

export async function payeeBalance(db: Db, payeeType: string, payeeId: number) {
  // Balance = eligible accruals not yet paid (paid = accruals with paid_at set).
  const r = (await db.query<{ accrued: string; paid: string }>(
    `SELECT COALESCE(sum(ia.amount),0) AS accrued,
            COALESCE(sum(ia.amount) FILTER (WHERE ia.paid_at IS NOT NULL),0) AS paid
     ${ACCRUAL_FROM}
     WHERE ia.payee_type = $1 AND ia.payee_id = $2 AND ${NOT_SELF}`, [payeeType, payeeId])).rows[0]!;
  const accrued = Number(r.accrued), paid = Number(r.paid);
  return { accrued: round2(accrued), paid: round2(paid), balance: round2(accrued - paid) };
}

/** Per-customer incentive breakdown for one payee (self-investments excluded). */
export async function payeeAccruals(db: Db, payeeType: string, payeeId: number) {
  const { rows } = await db.query(
    `SELECT ia.application_id, a.application_no, c.full_name AS customer, c.customer_code,
            s.code AS series_code, a.date_money_received,
            a.total_amount AS investment_amount, ia.amount AS incentive_amount,
            ia.rate_value, ia.rate_mode, ia.accrual_date, (ia.paid_at IS NOT NULL) AS paid, ia.paid_at
     ${ACCRUAL_FROM}
     WHERE ia.payee_type = $1 AND ia.payee_id = $2 AND ${NOT_SELF}
     ORDER BY (ia.paid_at IS NOT NULL), a.total_amount DESC`, [payeeType, payeeId]);
  return rows;
}

/** Pay one customer's incentive in full — marks that accrual paid + logs the
 * payout against the application. Idempotent (a paid accrual is a no-op). */
export async function payCustomerAccrual(db: Db, actor: AuthUser, payeeType: string, payeeId: number, applicationId: number) {
  return db.withTx(async (tx) => {
    const acc = (await tx.query<{ id: string; amount: string; paid_at: string | null }>(
      'SELECT id, amount, paid_at FROM incentive_accruals WHERE payee_type = $1 AND payee_id = $2 AND application_id = $3',
      [payeeType, payeeId, applicationId])).rows[0];
    if (!acc) throw errors.notFound('No incentive found for this customer');
    if (acc.paid_at) return payeeBalance(tx, payeeType, payeeId); // already paid — idempotent
    await tx.query('UPDATE incentive_accruals SET paid_at = now() WHERE id = $1', [acc.id]);
    await tx.query('INSERT INTO incentive_payouts (payee_type, payee_id, amount, application_id, reference, created_by_user_id) VALUES ($1,$2,$3,$4,$5,$6)',
      [payeeType, payeeId, acc.amount, applicationId, `APP:${applicationId}`, actor.id]);
    await writeAudit(tx, { actorId: actor.id, action: 'incentive.pay-customer', entityType: 'incentive_accruals', entityId: Number(acc.id), after: { amount: acc.amount, applicationId } });
    return payeeBalance(tx, payeeType, payeeId);
  });
}

/** Revert one customer's incentive payment (Super Admin only) — un-marks the
 * accrual paid and removes its payout ledger row, so the balance owes again. */
export async function revertCustomerPayment(db: Db, actor: AuthUser, payeeType: string, payeeId: number, applicationId: number) {
  if (actor.role !== 'super_admin') throw errors.forbidden('Only a Super Admin can revert a payment');
  return db.withTx(async (tx) => {
    const acc = (await tx.query<{ id: string; paid_at: string | null }>(
      'SELECT id, paid_at FROM incentive_accruals WHERE payee_type = $1 AND payee_id = $2 AND application_id = $3',
      [payeeType, payeeId, applicationId])).rows[0];
    if (!acc) throw errors.notFound('No incentive found for this customer');
    if (!acc.paid_at) throw errors.unprocessable('This incentive is not paid');
    await tx.query('UPDATE incentive_accruals SET paid_at = NULL WHERE id = $1', [acc.id]);
    await tx.query('DELETE FROM incentive_payouts WHERE payee_type = $1 AND payee_id = $2 AND application_id = $3', [payeeType, payeeId, applicationId]);
    await writeAudit(tx, { actorId: actor.id, action: 'incentive.revert-payment', entityType: 'incentive_accruals', entityId: Number(acc.id), after: { applicationId } });
    return payeeBalance(tx, payeeType, payeeId);
  });
}

/** Dashboard incentive totals, split Staff vs Agent (agent = agents + referrers). */
export async function incentiveTotals(db: Db) {
  const rows = await overview(db);
  const agg = (pred: (r: any) => boolean) => {
    const t = rows.filter(pred).reduce((s, r: any) => ({ earned: s.earned + r.accrued, paid: s.paid + r.paid, pending: s.pending + r.balance }), { earned: 0, paid: 0, pending: 0 });
    return { earned: round2(t.earned), paid: round2(t.paid), pending: round2(t.pending) };
  };
  return { staff: agg((r) => r.payee_type === 'staff'), agent: agg((r) => r.payee_type !== 'staff') };
}

/** Dashboard drill: every Staff (or Agent) payee with earned/paid/pending and
 * their per-customer breakdown as children. Self-investments already excluded. */
export async function dashboardIncentives(db: Db, which: 'staff' | 'agent') {
  const all = await overview(db);
  const payees = all.filter((r: any) => (which === 'staff' ? r.payee_type === 'staff' : r.payee_type !== 'staff'));
  const groups = [];
  for (const p of payees as any[]) {
    const children = await payeeAccruals(db, p.payee_type, p.payee_id);
    groups.push({
      payee_type: p.payee_type, payee_id: p.payee_id, name: p.payee_name ?? `${p.payee_type} #${p.payee_id}`,
      earned: p.accrued, paid: p.paid, pending: p.balance,
      children: (children as any[]).map((c) => ({
        customer: c.customer, customer_code: c.customer_code, application_no: c.application_no,
        series_code: c.series_code, investment_amount: c.investment_amount, incentive_amount: c.incentive_amount, paid: c.paid,
      })),
    });
  }
  groups.sort((a, b) => b.earned - a.earned);
  const totals = groups.reduce((t, g) => ({ earned: round2(t.earned + g.earned), paid: round2(t.paid + g.paid), pending: round2(t.pending + g.pending) }), { earned: 0, paid: 0, pending: 0 });
  return { groups, totals };
}

export async function myEarnings(db: Db, actor: AuthUser) {
  const payeeType = actor.agentId ? 'agent' : 'staff';
  const payeeId = actor.agentId ?? actor.id;
  const bal = await payeeBalance(db, payeeType, payeeId);
  const accruals = (await db.query(
    `SELECT ia.amount, ia.rate_mode, ia.rate_value, ia.accrual_date, ia.paid_at, a.application_no
     ${ACCRUAL_FROM}
     WHERE ia.payee_type = $1 AND ia.payee_id = $2 AND ${NOT_SELF} ORDER BY ia.accrual_date DESC`, [payeeType, payeeId])).rows;
  const payouts = (await db.query('SELECT amount, reference, paid_at FROM incentive_payouts WHERE payee_type = $1 AND payee_id = $2 ORDER BY paid_at DESC', [payeeType, payeeId])).rows;
  return { ...bal, accruals, payouts };
}

// ── Agent commission eligibility (maker-checker) ──
import { createApprovalRequest, registerOnFinalApprove } from '../approvals/service.js';
import { getSettingsMap } from '../settings/service.js';

export async function listAgentsForEligibility(db: Db): Promise<{ id: number; full_name: string; agent_code: string; commission_status: string; commission_rate_pct: number | null }[]> {
  const { rows } = await db.query<{ id: string; full_name: string; agent_code: string; commission_status: string; commission_rate_pct: string | null }>(
    `SELECT id, full_name, agent_code, commission_status, commission_rate_pct FROM agents WHERE is_active = TRUE ORDER BY full_name`);
  return rows.map((r) => ({ ...r, id: Number(r.id), commission_rate_pct: r.commission_rate_pct != null ? Number(r.commission_rate_pct) : null }));
}

export async function requestAgentEligibility(db: Db, actor: AuthUser, agentId: number, input: { rate_pct: number; payout_mode?: string; bank_name?: string; account_number?: string; ifsc?: string }) {
  const settings = await getSettingsMap(db);
  const cap = Number(settings['incentive.agent_commission_cap_pct'] ?? 2.0);
  if (input.rate_pct <= 0 || input.rate_pct > cap) throw errors.badRequest(`Rate must be between 0 and ${cap}%`);
  return db.withTx(async (tx) => {
    const agent = (await tx.query<{ id: string }>('SELECT id FROM agents WHERE id = $1', [agentId])).rows[0];
    if (!agent) throw errors.notFound('Agent not found');
    await tx.query("UPDATE agents SET commission_status = 'PendingApproval', payout_mode = $1, bank_name = $2, account_number = $3, ifsc = $4 WHERE id = $5",
      [input.payout_mode ?? null, input.bank_name ?? null, input.account_number ?? null, input.ifsc ?? null, agentId]);
    const req = await createApprovalRequest(tx, { type: 'commission_eligibility', entityType: 'agents', entityId: agentId, makerUserId: actor.id, metadata: { agent_id: agentId, rate_pct: input.rate_pct, payout_mode: input.payout_mode ?? null } });
    await writeAudit(tx, { actorId: actor.id, action: 'commission.eligibility.request', entityType: 'agents', entityId: agentId, after: { rate_pct: input.rate_pct } });
    return req;
  });
}

registerOnFinalApprove('commission_eligibility', async (tx, req) => {
  const agentId = Number(req.metadata.agent_id);
  await tx.query("UPDATE agents SET commission_status = 'Approved', commission_rate_pct = $1 WHERE id = $2", [Number(req.metadata.rate_pct), agentId]);
});

export async function revokeAgentEligibility(db: Db, actor: AuthUser, agentId: number) {
  await db.query("UPDATE agents SET commission_status = 'Revoked' WHERE id = $1", [agentId]);
  await writeAudit(db, { actorId: actor.id, action: 'commission.eligibility.revoke', entityType: 'agents', entityId: agentId });
}

// ── Referrer eligibility (direct approve by CXO+) ──
export async function listReferrers(db: Db) {
  return (await db.query('SELECT id, display_name, eligibility_status FROM referrers ORDER BY display_name')).rows;
}
export async function setReferrerEligibility(db: Db, actor: AuthUser, referrerId: number, status: 'Approved' | 'Revoked') {
  const upd = await db.query('UPDATE referrers SET eligibility_status = $1 WHERE id = $2', [status, referrerId]);
  if (!upd.rowCount) throw errors.notFound('Referrer not found');
  await writeAudit(db, { actorId: actor.id, action: 'referrer.eligibility', entityType: 'referrers', entityId: referrerId, after: { status } });
  return { ok: true };
}

/** Staff/agent incentive statement PDF (docs/00 §7). */
export async function statementPdf(db: Db, payeeType: string, payeeId: number): Promise<Buffer> {
  const bal = await payeeBalance(db, payeeType, payeeId);
  const name = payeeType === 'agent'
    ? (await db.query<{ full_name: string }>('SELECT full_name FROM agents WHERE id = $1', [payeeId])).rows[0]?.full_name
    : (await db.query<{ full_name: string }>('SELECT full_name FROM users WHERE id = $1', [payeeId])).rows[0]?.full_name;
  const accruals = (await db.query<Record<string, unknown>>(
    `SELECT ia.accrual_date, ia.amount, ia.rate_mode, ia.rate_value, a.application_no
     FROM incentive_accruals ia JOIN applications a ON a.id = ia.application_id
     WHERE ia.payee_type = $1 AND ia.payee_id = $2 ORDER BY ia.accrual_date`, [payeeType, payeeId])).rows;
  const payouts = (await db.query<Record<string, unknown>>('SELECT paid_at, amount, reference FROM incentive_payouts WHERE payee_type = $1 AND payee_id = $2 ORDER BY paid_at', [payeeType, payeeId])).rows;

  const { renderPdf, letterhead } = await import('../../lib/pdf.js');
  const { formatINR } = await import('@new-wealth/shared');
  return renderPdf((doc) => {
    letterhead(doc, 'Incentive Statement', `${name ?? `${payeeType} #${payeeId}`}`);
    doc.fontSize(10).font('Helvetica');
    doc.text(`Accrued: ${formatINR(bal.accrued)}     Paid: ${formatINR(bal.paid)}     Balance: ${formatINR(bal.balance)}`);
    doc.moveDown(0.8);
    doc.font('Helvetica-Bold').text('Accruals'); doc.font('Helvetica').fontSize(9);
    for (const r of accruals) doc.text(`${r.accrual_date}   ${r.application_no}   ${r.rate_value}${r.rate_mode === 'pct' ? '%' : ' flat'}   ${formatINR(Number(r.amount))}`);
    if (!accruals.length) doc.fillColor('#6b7380').text('None').fillColor('#1a1d23');
    doc.moveDown(0.8).fontSize(10);
    doc.font('Helvetica-Bold').text('Payouts'); doc.font('Helvetica').fontSize(9);
    for (const p of payouts) doc.text(`${String(p.paid_at).slice(0, 10)}   ${p.reference ?? ''}   ${formatINR(Number(p.amount))}`);
    if (!payouts.length) doc.fillColor('#6b7380').text('None');
  });
}

/** Overview for managers: every staff/agent/referrer, self-investments excluded.
 * `investment_amount` = the investments underlying their eligible incentive. */
export async function overview(db: Db) {
  const { rows } = await db.query(
    `SELECT ia.payee_type, ia.payee_id,
            COALESCE(sum(ia.amount),0) AS accrued,
            COALESCE(sum(ia.amount) FILTER (WHERE ia.paid_at IS NOT NULL),0) AS paid,
            COALESCE(sum(a.total_amount),0) AS investment_amount,
            CASE ia.payee_type
              WHEN 'staff' THEN (SELECT u.full_name FROM users u WHERE u.id = ia.payee_id)
              WHEN 'agent' THEN (SELECT ag.full_name FROM agents ag WHERE ag.id = ia.payee_id)
              WHEN 'referrer' THEN (SELECT rf.display_name FROM referrers rf WHERE rf.id = ia.payee_id)
            END AS payee_name
     ${ACCRUAL_FROM}
     WHERE ${NOT_SELF}
     GROUP BY ia.payee_type, ia.payee_id`
  );
  return rows.map((r) => {
    const accrued = Number((r as any).accrued); const paid = Number((r as any).paid);
    return {
      payee_type: (r as any).payee_type, payee_id: Number((r as any).payee_id),
      payee_name: (r as any).payee_name ?? null,
      investment_amount: round2(Number((r as any).investment_amount)),
      accrued: round2(accrued), paid: round2(paid), balance: round2(accrued - paid),
    };
  });
}
