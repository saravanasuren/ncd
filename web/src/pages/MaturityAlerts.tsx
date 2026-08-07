import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { formatINR } from '@new-wealth/shared';
import { api } from '../api/client.js';

/** NCDs approaching maturity (owner 2026-08-07 — parity with the wealth app).
 *  A scoped list within a chosen window, with 30/60-day totals up top. */

const WINDOWS = [30, 60, 90, 180, 365];

export function MaturityAlertsPage() {
  const [days, setDays] = useState(90);
  const { data, isLoading, error } = useQuery({
    queryKey: ['maturity-alerts', days],
    queryFn: () => api.get<any>(`/api/dashboard/maturity-alerts?days=${days}`),
  });

  const card = 'bg-surface border border-border rounded-lg shadow-card p-4';
  const th = 'text-left text-xs font-semibold text-text-label uppercase tracking-wide px-3 py-2';
  const td = 'px-3 py-2 text-sm';
  const t = data?.totals;

  return (
    <div className="w-full">
      <h1 className="text-xl font-bold tracking-tight m-0">Maturity Alerts</h1>
      <p className="text-sm text-text-muted mt-1 mb-4">NCDs maturing within the selected window, in your scope.</p>

      <div className="flex flex-wrap items-center gap-2 mb-4">
        <span className="text-xs text-text-muted mr-1">Window:</span>
        {WINDOWS.map((w) => (
          <button key={w} onClick={() => setDays(w)}
            className={`text-xs rounded px-2.5 py-1 border ${days === w ? 'bg-primary text-white border-primary' : 'border-border hover:bg-bg'}`}>{w} days</button>
        ))}
      </div>

      {t && (
        <div className="grid grid-cols-3 gap-3 mb-4">
          <div className={card}><div className="text-xs text-text-label uppercase tracking-wide">Next 30 days</div><div className="text-lg font-bold mono mt-1">{formatINR(t.amount_30d)}</div><div className="text-xs text-text-muted">{t.count_30d} NCD(s)</div></div>
          <div className={card}><div className="text-xs text-text-label uppercase tracking-wide">Next 60 days</div><div className="text-lg font-bold mono mt-1">{formatINR(t.amount_60d)}</div><div className="text-xs text-text-muted">{t.count_60d} NCD(s)</div></div>
          <div className={card}><div className="text-xs text-text-label uppercase tracking-wide">Within {data.days} days</div><div className="text-lg font-bold mono mt-1">{formatINR(t.amount_all)}</div><div className="text-xs text-text-muted">{t.count_all} NCD(s)</div></div>
        </div>
      )}

      {isLoading ? <div className="text-text-muted">Loading…</div>
        : error ? <div className="text-danger">Failed to load maturity alerts.</div>
        : (
          <div className={`${card} overflow-x-auto`}>
            <table className="w-full min-w-[820px]">
              <thead><tr className="border-b border-border">
                <th className={th}>Matures</th><th className={th}>In</th><th className={th}>Customer</th>
                <th className={th}>Series / scheme</th><th className={`${th} text-right`}>Principal</th>
                <th className={`${th} text-right`}>Net payout</th><th className={th}>App</th>
              </tr></thead>
              <tbody>
                {(data.alerts ?? []).map((a: any) => (
                  <tr key={a.application_id} className="border-b border-border last:border-0">
                    <td className={td}>{a.maturity_date}</td>
                    <td className={td}>
                      <span className={`text-xs rounded px-1.5 py-0.5 ${a.days_remaining <= 30 ? 'bg-[color:var(--danger-bg)] text-danger' : a.days_remaining <= 60 ? 'bg-[color:var(--warn-bg)] text-warn' : 'bg-bg text-text-muted'}`}>{a.days_remaining}d</span>
                    </td>
                    <td className={td}><Link to={`/app/customers/${a.customer_id}`} className="text-primary hover:underline">{a.customer_name}</Link> <span className="font-mono text-xs text-text-muted">{a.customer_code}</span></td>
                    <td className={td}>{a.series_code}{a.scheme_code ? ` · ${a.scheme_code}` : ''}{a.tenure_months ? ` · ${a.tenure_months}m` : ''}</td>
                    <td className={`${td} text-right mono`}>{formatINR(a.outstanding_amount)}</td>
                    <td className={`${td} text-right mono`}>{a.net_amount != null ? formatINR(a.net_amount) : <span className="text-text-muted">—</span>}</td>
                    <td className={td}><Link to={`/app/applications/${a.application_id}`} className="text-primary hover:underline font-mono text-xs">{a.application_no}</Link></td>
                  </tr>
                ))}
                {data.alerts && data.alerts.length === 0 && (
                  <tr><td className={td} colSpan={7}><span className="text-text-muted">No NCDs maturing within {data.days} days.</span></td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}
    </div>
  );
}
