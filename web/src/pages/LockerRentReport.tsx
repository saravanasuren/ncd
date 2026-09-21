import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { formatINR, RENT_STATUS_LABEL, type RentStatus } from '@new-wealth/shared';
import { api } from '../api/client.js';
import { RentStatusBadge } from '../components/RentStatusBadge.js';

/**
 * Locker rent report (owner 2026-08-22) — every NCD locker as PAID, WAIVED,
 * PREMIUM or UNPAID. The status is decided on the server by the same rule
 * Locker Tenants uses; this page only displays and filters it.
 */
interface Row {
  lockerhub_application_id: string; locker_no: string | null; branch: string | null; size: string | null;
  customer_name: string | null; customer_code: string | null; phone: string | null;
  rent_amount: number | null; rent_status: RentStatus; reason: string | null;
}
interface Report { rows: Row[]; totals: Record<RentStatus, number>; lockerhub_error: string | null }

export function LockerRentReportPage() {
  const rep = useQuery({ queryKey: ['locker-rent-report'], queryFn: () => api.get<Report>('/api/lockers/rent-report') });
  const [filter, setFilter] = useState<RentStatus | ''>('');
  const th = 'py-2 px-3 text-xs font-semibold text-text-label uppercase tracking-wide text-left';
  const td = 'py-2 px-3 align-middle';
  const rows = (rep.data?.rows ?? []).filter((r) => !filter || r.rent_status === filter);

  return (
    <div className="max-w-6xl">
      <h1 className="text-lg font-semibold mb-1">Locker rent report</h1>
      <p className="text-sm text-text-muted mb-4">Every NCD locker and how its rent stands — paid by the customer, waived, or complimentary for a premium customer.</p>

      {rep.isLoading && <div className="text-sm text-text-muted">Loading…</div>}
      {rep.error && <div className="text-sm text-danger">Failed to load the report.</div>}
      {rep.data?.lockerhub_error && (
        <div className="text-xs text-warn bg-[color:var(--warn-bg)] rounded px-3 py-2 mb-3">Some lockers couldn’t be read from LockerHub — their rent status shows as Unknown until it can be checked.</div>
      )}

      {rep.data && (
        <>
          <div className="flex flex-wrap items-center gap-2 mb-3">
            {(['', 'paid', 'waived', 'premium', 'unpaid', ...(rep.data.totals.unknown > 0 ? ['unknown' as const] : [])] as const).map((s) => (
              <button key={s || 'all'} onClick={() => setFilter(s)}
                className={`text-xs rounded-full px-3 py-1 border ${filter === s ? 'border-primary text-primary' : 'border-border text-text-muted'}`}>
                {s === '' ? `All (${rep.data!.rows.length})` : `${RENT_STATUS_LABEL[s]} (${rep.data!.totals[s]})`}
              </button>
            ))}
            <a href="/api/lockers/rent-report.xlsx"
              className="ml-auto text-sm bg-primary hover:bg-primary-hover text-white rounded px-4 py-2 font-semibold no-underline inline-block">↓ Excel</a>
          </div>

          <div className="overflow-x-auto bg-surface border border-border rounded-lg shadow-card">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="border-b border-border">
                  <th className={th}>#</th><th className={th}>Locker</th><th className={th}>Branch</th><th className={th}>Size</th>
                  <th className={th}>Customer</th><th className={`${th} text-right`}>Rent</th><th className={th}>Rent status</th><th className={th}>Reason</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={r.lockerhub_application_id} className="border-b border-border last:border-0 hover:bg-bg">
                    <td className={`${td} text-text-muted`}>{i + 1}</td>
                    <td className={`${td} font-mono text-xs`}>{r.locker_no ?? '—'}</td>
                    <td className={td}>{r.branch ?? '—'}</td>
                    <td className={td}>{r.size ?? '—'}</td>
                    <td className={td}>
                      {r.customer_name ?? '—'}{r.customer_code ? <span className="font-mono text-xs text-text-muted"> · {r.customer_code}</span> : null}
                    </td>
                    <td className={`${td} text-right mono`}>{r.rent_amount != null ? formatINR(r.rent_amount) : '—'}</td>
                    <td className={td}><RentStatusBadge status={r.rent_status} reason={r.reason} /></td>
                    <td className={`${td} text-xs text-text-muted`}>{r.reason ?? ''}</td>
                  </tr>
                ))}
                {rows.length === 0 && <tr><td className={`${td} text-text-muted`} colSpan={8}>No lockers.</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
