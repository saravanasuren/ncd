import { RENT_STATUS_LABEL, type RentStatus } from '@new-wealth/shared';

/**
 * How a locker's rent stands, as a pill. Locker Tenants and the Locker Rent
 * Report both render it, so a status looks the same wherever it appears; the
 * words come from @new-wealth/shared (also used by the Excel export).
 */
const CLS: Record<RentStatus, string> = {
  paid: 'bg-[color:var(--success-bg)] text-success',
  premium: 'bg-[color:var(--success-bg)] text-success',
  waived: 'bg-[color:var(--warn-bg)] text-warn',
  unpaid: 'bg-[color:var(--danger-bg)] text-danger',
  unknown: 'bg-[color:var(--warn-bg)] text-warn',
};

export function RentStatusBadge({ status, reason }: { status: RentStatus | null | undefined; reason?: string | null }) {
  if (!status) return <span className="text-text-muted text-xs">—</span>;
  const label = status === 'premium' ? `★ ${RENT_STATUS_LABEL[status]}` : RENT_STATUS_LABEL[status];
  return <span title={reason ?? undefined} className={`text-xs rounded px-1.5 py-0.5 ${CLS[status]}`}>{label}</span>;
}
