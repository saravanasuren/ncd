/** Incentives payout ledger (docs/02 §5). Balance = Σaccrued − Σpaid;
 * partial payments supported. */
import type { Db } from '../../db/types.js';
import type { AuthUser } from '../../lib/authUser.js';
import { errors } from '../../lib/errors.js';
import { writeAudit } from '../../lib/audit.js';
import { round2 } from '../../lib/dates.js';

export async function payeeBalance(db: Db, payeeType: string, payeeId: number) {
  const accrued = Number((await db.query<{ s: string }>('SELECT COALESCE(sum(amount),0) AS s FROM incentive_accruals WHERE payee_type = $1 AND payee_id = $2', [payeeType, payeeId])).rows[0]!.s);
  const paid = Number((await db.query<{ s: string }>('SELECT COALESCE(sum(amount),0) AS s FROM incentive_payouts WHERE payee_type = $1 AND payee_id = $2', [payeeType, payeeId])).rows[0]!.s);
  return { accrued: round2(accrued), paid: round2(paid), balance: round2(accrued - paid) };
}

export async function pay(db: Db, actor: AuthUser, payeeType: string, payeeId: number, amount: number, reference?: string) {
  if (amount <= 0) throw errors.badRequest('Amount must be positive');
  return db.withTx(async (tx) => {
    await tx.query('INSERT INTO incentive_payouts (payee_type, payee_id, amount, reference, created_by_user_id) VALUES ($1,$2,$3,$4,$5)',
      [payeeType, payeeId, amount, reference ?? null, actor.id]);
    await writeAudit(tx, { actorId: actor.id, action: 'incentive.pay', entityType: 'incentive_payouts', entityId: `${payeeType}:${payeeId}`, after: { amount, reference } });
    return payeeBalance(tx, payeeType, payeeId);
  });
}

export async function myEarnings(db: Db, actor: AuthUser) {
  const payeeType = actor.agentId ? 'agent' : 'staff';
  const payeeId = actor.agentId ?? actor.id;
  const bal = await payeeBalance(db, payeeType, payeeId);
  const accruals = (await db.query(
    `SELECT ia.amount, ia.rate_mode, ia.rate_value, ia.accrual_date, ia.paid_at, a.application_no
     FROM incentive_accruals ia JOIN applications a ON a.id = ia.application_id
     WHERE ia.payee_type = $1 AND ia.payee_id = $2 ORDER BY ia.accrual_date DESC`, [payeeType, payeeId])).rows;
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

/** Overview for managers: every staff/agent/referrer with a nonzero balance. */
export async function overview(db: Db) {
  const { rows } = await db.query(
    `SELECT ia.payee_type, ia.payee_id, COALESCE(sum(ia.amount),0) AS accrued,
            COALESCE((SELECT sum(p.amount) FROM incentive_payouts p WHERE p.payee_type = ia.payee_type AND p.payee_id = ia.payee_id),0) AS paid
     FROM incentive_accruals ia GROUP BY ia.payee_type, ia.payee_id`
  );
  return rows.map((r) => {
    const accrued = Number((r as any).accrued); const paid = Number((r as any).paid);
    return { payee_type: (r as any).payee_type, payee_id: Number((r as any).payee_id), accrued: round2(accrued), paid: round2(paid), balance: round2(accrued - paid) };
  });
}
