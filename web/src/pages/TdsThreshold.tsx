import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { formatINR } from '@new-wealth/shared';
import { api, ApiError } from '../api/client.js';

/**
 * TDS ₹30L crossings — the history the Approvals inbox can't give you, because a
 * request disappears from it the moment it's actioned. Every customer who crossed
 * the threshold, what was recovered from them, and how each one ended.
 *
 * Also the only place to REOPEN a rejected crossing: a rejection is final for the
 * nightly scan (it used to re-ask every 6 hours), so putting a customer back in
 * scope has to be a deliberate click.
 */

interface TdsEvent {
  id: number; customer_id: number; customer: string; customer_code: string | null;
  outstanding_at_crossing: number; crossed_on: string | null; interest_paid_untaxed: number;
  tds_rate_pct: number; tds_to_recover: number; status: string; source: string;
  is_estimate: boolean; request_no: string | null; payout_adjustment_id: number | null; created_at: string;
}

const STATUS_STYLES: Record<string, string> = {
  PendingApproval: 'bg-[color:var(--warn-bg)] text-warn',
  Applied: 'bg-[color:var(--success-bg)] text-success',
  Rejected: 'bg-bg text-text-muted',
  Reopened: 'bg-[color:var(--primary-bg)] text-primary',
};
const STATUS_LABEL: Record<string, string> = {
  PendingApproval: 'Waiting for approval',
  Applied: 'Collected',
  Rejected: 'Rejected',
  Reopened: 'Reopened',
};

const FILTERS: { key: string; label: string }[] = [
  { key: '', label: 'All' },
  { key: 'PendingApproval', label: 'Waiting' },
  { key: 'Applied', label: 'Collected' },
  { key: 'Rejected', label: 'Rejected' },
  { key: 'Reopened', label: 'Reopened' },
];

export function TdsThresholdPage() {
  const qc = useQueryClient();
  const [status, setStatus] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  const events = useQuery({
    queryKey: ['tds-events', status],
    queryFn: () => api.get<{ rows: TdsEvent[] }>(`/api/tds/events${status ? `?status=${status}` : ''}`),
  });

  const refresh = () => { qc.invalidateQueries({ queryKey: ['tds-events'] }); qc.invalidateQueries({ queryKey: ['nav-badges'] }); };

  const scan = useMutation({
    mutationFn: () => api.post<{ scanned: number; raised: number }>('/api/tds/scan', {}),
    onSuccess: (r) => {
      setErr('');
      setMsg(r.raised
        ? `Checked ${r.scanned} customer(s) over the threshold — raised ${r.raised} new approval(s).`
        : `Checked ${r.scanned} customer(s) over the threshold — nothing new to raise.`);
      refresh();
    },
    onError: (e) => { setMsg(''); setErr(e instanceof ApiError ? e.message : 'Check failed'); },
  });

  const reopen = useMutation({
    mutationFn: (id: number) => api.post(`/api/tds/events/${id}/reopen`, {}),
    onSuccess: () => { setErr(''); setMsg('Reopened — the next check may raise this customer again.'); refresh(); },
    onError: (e) => { setMsg(''); setErr(e instanceof ApiError ? e.message : 'Could not reopen'); },
  });

  const rows = events.data?.rows ?? [];
  const waiting = rows.filter((r) => r.status === 'PendingApproval').length;
  const collected = rows.filter((r) => r.status === 'Applied');
  const collectedTotal = collected.reduce((s, r) => s + r.tds_to_recover, 0);

  const card = 'bg-surface border border-border rounded-lg shadow-card p-5';
  const th = 'text-left text-xs font-semibold text-text-label uppercase tracking-wide px-3 py-2';
  const td = 'px-3 py-2 text-sm align-top';

  return (
    <div className="w-full">
      <h1 className="text-xl font-bold tracking-tight mb-1">TDS ₹30L crossings</h1>
      <p className="text-sm text-text-muted mb-4">
        Customers whose outstanding book crossed the threshold. Each one becomes TDS-applicable, and the TDS on the
        interest already paid to them while exempt is recovered once, in the next interest batch.
      </p>

      {msg && <div className="mb-3 text-sm bg-[color:var(--primary-bg)] text-primary border border-border rounded px-3 py-2">{msg}</div>}
      {err && <div className="mb-3 text-sm bg-[color:var(--danger-bg)] text-danger border border-border rounded px-3 py-2">{err}</div>}

      {/* Tiles */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
        <div className={card}>
          <div className="text-xs text-text-label uppercase tracking-wide">Waiting for approval</div>
          <div className="text-2xl font-bold mt-1 text-warn">{status ? '—' : waiting}</div>
          <div className="text-xs text-text-muted mt-1">{status ? 'Clear the filter to see the count' : 'Sitting in the Approvals inbox'}</div>
        </div>
        <div className={card}>
          <div className="text-xs text-text-label uppercase tracking-wide">Recovered so far</div>
          <div className="text-2xl font-bold mt-1 text-success">{status ? '—' : formatINR(collectedTotal)}</div>
          <div className="text-xs text-text-muted mt-1">{status ? '' : `from ${collected.length} customer(s)`}</div>
        </div>
        <div className={card}>
          <div className="text-xs text-text-label uppercase tracking-wide">Run the check</div>
          <button onClick={() => scan.mutate()} disabled={scan.isPending}
            className="mt-2 text-sm rounded px-3 py-1.5 bg-primary text-white disabled:opacity-50">
            {scan.isPending ? 'Checking…' : 'Check now'}
          </button>
          <div className="text-xs text-text-muted mt-2">Runs by itself every 6 hours. Safe to press — it never raises the same customer twice.</div>
        </div>
      </div>

      <div className={card}>
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <div className="text-xs font-semibold text-text-label uppercase tracking-wide mr-2">Crossings</div>
          {FILTERS.map((f) => (
            <button key={f.key} onClick={() => setStatus(f.key)}
              className={`text-xs rounded px-2.5 py-1 border ${status === f.key ? 'bg-primary text-white border-primary' : 'border-border hover:bg-bg'}`}>{f.label}</button>
          ))}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px]">
            <thead><tr className="border-b border-border">
              <th className={th}>Customer</th><th className={th}>Crossed</th><th className={th}>Book</th>
              <th className={th}>Untaxed interest</th><th className={th}>Rate</th><th className={th}>TDS</th>
              <th className={th}>Source</th><th className={th}>Status</th><th className={th}></th>
            </tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-border last:border-0">
                  <td className={td}>
                    <a href={`/app/customers/${r.customer_id}`} className="text-primary hover:underline">{r.customer}</a>
                    {r.customer_code && <span className="text-xs text-text-muted"> {r.customer_code}</span>}
                    {r.request_no && <div className="text-xs text-text-muted">{r.request_no}</div>}
                  </td>
                  <td className={td}>{r.crossed_on ?? '—'}</td>
                  <td className={`${td} mono`}>{formatINR(r.outstanding_at_crossing)}</td>
                  <td className={`${td} mono`}>{formatINR(r.interest_paid_untaxed)}</td>
                  <td className={td}>{r.tds_rate_pct}%</td>
                  <td className={`${td} mono`}>
                    {formatINR(r.tds_to_recover)}
                    {r.is_estimate && <div className="text-xs text-warn">approximate — check it</div>}
                  </td>
                  <td className={td}>
                    <span className="text-xs text-text-muted">{r.source === 'enrolment' ? 'Prompt at enrolment' : 'Nightly check'}</span>
                  </td>
                  <td className={td}>
                    <span className={`text-xs rounded px-2 py-0.5 ${STATUS_STYLES[r.status] ?? 'bg-bg text-text-muted'}`}>
                      {STATUS_LABEL[r.status] ?? r.status}
                    </span>
                  </td>
                  <td className={td}>
                    {r.status === 'Rejected' ? (
                      <button onClick={() => reopen.mutate(r.id)} disabled={reopen.isPending}
                        className="text-xs rounded px-2.5 py-1 border border-border hover:bg-bg disabled:opacity-50"
                        title="Put this customer back in scope so a later check may raise it again">Reopen</button>
                    ) : <span className="text-xs text-text-muted">—</span>}
                  </td>
                </tr>
              ))}
              {events.data && rows.length === 0 && (
                <tr><td className={td} colSpan={9}>
                  <span className="text-text-muted">No crossings{status ? ` with status “${STATUS_LABEL[status] ?? status}”` : ' yet'}.</span>
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-text-muted mt-3">
          A rejected crossing is left alone — the nightly check will not ask about that customer again until you reopen it.
        </p>
      </div>
    </div>
  );
}
