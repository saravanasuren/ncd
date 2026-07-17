/** Notification template registry (docs/08 §5). Each renders subject+body
 * from a payload. Real HTML templates can replace these later; the contract
 * is render(template, payload) → { subject, body }. */

type Renderer = (p: Record<string, unknown>) => { subject: string; body: string };

const TEMPLATES: Record<string, Renderer> = {
  portal_otp: (p) => ({
    subject: 'Your Dhanam NCD login code',
    body: `Your one-time code is ${p.otp}. It is valid for ${p.ttlMinutes} minutes. Do not share it with anyone.`,
  }),
  handover_approved: (p) => ({
    subject: 'Customer handover approved',
    body: `The handover of ${p.customerName} has been approved.`,
  }),
  handover_rejected: (p) => ({
    subject: 'Customer handover rejected',
    body: `The handover of ${p.customerName} was not approved.`,
  }),
  payout_disbursed: (p) => ({
    subject: 'Interest credited',
    body: `₹${p.amount} interest has been credited for ${p.applicationNo}.`,
  }),
  agent_registration_approved: (p) => ({
    subject: 'Your DhanamFin agent account is approved',
    body: `Welcome ${p.agentName}. Your agent code is ${p.agentCode}.`,
  }),
  lockerhub_daily_reconciliation: (p) => ({
    subject: `LockerHub reconciliation ${p.report_date} — ${Number(p.orphan_count) > 0 ? `⚠ ${p.orphan_count} orphan(s)` : 'clean'}`,
    body: [
      `LockerHub ↔ NCD reconciliation for ${p.report_date}`,
      ``,
      `LockerHub successful payments: ${p.lh_success_count} (Rs ${p.lh_total_amount})`,
      `NCD applications (lockerhub-funded): ${p.ncd_count} (Rs ${p.ncd_total_amount}) — ${p.ncd_status_breakdown}`,
      `Orphans (paid on LockerHub, missing here): ${p.orphan_count} (Rs ${p.orphan_total_amount})`,
      ``,
      `${p.orphan_details}`,
      p.lh_error ? `\nNOTE: LockerHub DB read failed: ${p.lh_error}` : '',
    ].join('\n'),
  }),
};

export function renderTemplate(template: string, payload: Record<string, unknown>): { subject: string; body: string } {
  const fn = TEMPLATES[template];
  if (!fn) return { subject: `[${template}]`, body: JSON.stringify(payload) };
  return fn(payload);
}
