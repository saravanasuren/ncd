/** Notification template registry (docs/08 §5). Each renders subject+body
 * from a payload. Real HTML templates can replace these later; the contract
 * is render(template, payload) → { subject, body }. */

type Renderer = (p: Record<string, unknown>) => { subject: string; body: string };

const TEMPLATES: Record<string, Renderer> = {
  portal_otp: (p) => ({
    subject: 'Your Dhanam NCD login code',
    body: `Your one-time code is ${p.otp}. It is valid for ${p.ttlMinutes} minutes. Do not share it with anyone.`,
  }),
  password_reset: (p) => ({
    subject: 'Reset your Dhanam NCD password',
    body: [
      `Hi ${p.name ?? ''}`.trim() + ',',
      ``,
      `We received a request to reset your Dhanam NCD password. Open this link to set a new one — it expires in ${p.ttlMinutes} minutes:`,
      ``,
      `${p.link}`,
      ``,
      `If you didn't request this, you can ignore this email; your password stays unchanged.`,
    ].join('\n'),
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
  book_summary: (p) => ({
    subject: `Dhanam NCD daily book — ${p.report_date}`,
    body: [
      `Book summary for ${p.report_date}`,
      ``,
      `Total outstanding: ₹${p.total_outstanding} across ${p.active_apps} live investments`,
      `New today (physical): ${p.physical}`,
      `New today (app/LockerHub): ${p.funded}`,
      `Redemptions today: ${p.redemptions}`,
      ``,
      `By series:`,
      `${p.by_series}`,
    ].join('\n'),
  }),
  crash_alert: (p) => ({
    subject: `⚠ Dhanam NCD ${p.kind}`,
    body: `An unhandled ${p.kind} occurred at ${p.at}:\n\n${p.detail}\n\nCheck: journalctl -u dhanam-newwealth -n 200`,
  }),
  backup_check: (p) => ({
    subject: `NCD backup check ${p.report_date} — ${p.ok ? 'OK' : '⚠ ATTENTION'}`,
    body: [
      `Nightly backup status for ${p.report_date}`,
      ``,
      `Local:   ${p.local}`,
      `Offsite: ${p.offsite}`,
      `Secret:  ${p.secret}`,
    ].join('\n'),
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
