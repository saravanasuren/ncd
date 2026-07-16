import { useParams, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { formatINR } from '@new-wealth/shared';
import { api, ApiError } from '../api/client.js';
import { useAuth } from '../auth/AuthContext.js';
import { useState } from 'react';

const rowPill: Record<string, string> = {
  Paid: 'text-success', Scheduled: 'text-text-muted', Skipped: 'text-warn', Failed: 'text-danger',
};

export function ApplicationDetailPage() {
  const { id } = useParams();
  const qc = useQueryClient();
  const { can } = useAuth();
  const [msg, setMsg] = useState('');
  const key = ['application', id];
  const { data, isLoading, error } = useQuery({ queryKey: key, queryFn: () => api.get<any>(`/api/applications/${id}`) });
  const invalidate = () => qc.invalidateQueries({ queryKey: key });
  const run = (p: Promise<unknown>) => p.then(() => { setMsg(''); invalidate(); }).catch((e) => setMsg(e instanceof ApiError ? e.message : 'Failed'));

  const confirm = useMutation({ mutationFn: () => api.post(`/api/applications/${id}/confirm-collection`, { amount_received: Number(data.application.total_amount), date_money_received: new Date().toISOString().slice(0, 10), method: 'NEFT' }), onSuccess: () => { setMsg(''); invalidate(); }, onError: (e) => setMsg(e instanceof ApiError ? e.message : 'Failed') });

  if (isLoading) return <div className="text-text-muted">Loading…</div>;
  if (error) return <div className="text-danger">Application not found or out of scope.</div>;
  const a = data.application;

  return (
    <div className="max-w-4xl">
      <Link to="/app/applications" className="text-xs text-text-muted hover:text-primary">← Applications</Link>
      <div className="flex items-center gap-3 mt-1">
        <h1 className="text-xl font-bold tracking-tight m-0 font-mono">{a.application_no}</h1>
        <span className="text-xs rounded px-1.5 py-0.5 bg-bg">{a.status}</span>
      </div>
      <p className="text-sm text-text-muted mt-1">{a.customer_name} · {a.series_code} · {formatINR(a.total_amount)}</p>
      {msg && <div className="text-xs text-danger mt-2">{msg}</div>}

      <div className="flex gap-2 mt-3">
        {can('applications:confirm-collection') && a.status === 'PendingCollection' && (
          <button onClick={() => confirm.mutate()} className="text-xs bg-primary text-white rounded px-3 py-1.5 hover:bg-primary-hover">Confirm collection</button>
        )}
        {can('applications:mark-esigned') && a.status === 'PendingEsign' && (
          <button onClick={() => run(api.post(`/api/applications/${id}/mark-esigned`))} className="text-xs bg-primary text-white rounded px-3 py-1.5 hover:bg-primary-hover">Mark eSigned</button>
        )}
      </div>

      <div className="bg-surface border border-border rounded-lg shadow-card mt-4 overflow-hidden">
        <div className="px-4 py-3 border-b border-border text-xs font-semibold text-text-label uppercase tracking-wide">Interest & redemption schedule</div>
        {data.schedule.length === 0 ? (
          <div className="p-6 text-center text-text-muted text-sm">Schedule is generated at allotment.</div>
        ) : (
          <table className="w-full text-sm">
            <thead><tr className="text-left text-xs font-semibold text-text-label border-b border-border">
              <th className="px-4 py-2">Due date</th><th className="px-4 py-2">Type</th>
              <th className="px-4 py-2 text-right">Gross</th><th className="px-4 py-2 text-right">TDS</th>
              <th className="px-4 py-2 text-right">Net</th><th className="px-4 py-2">Status</th></tr></thead>
            <tbody className="divide-y divide-border">
              {data.schedule.map((r: any) => (
                <tr key={r.id}>
                  <td className="px-4 py-1.5 mono">{r.due_date}</td>
                  <td className="px-4 py-1.5">{r.due_type}</td>
                  <td className="px-4 py-1.5 text-right mono">{formatINR(r.gross_amount)}</td>
                  <td className="px-4 py-1.5 text-right mono text-text-muted">{formatINR(r.tds_amount)}</td>
                  <td className="px-4 py-1.5 text-right mono">{formatINR(r.net_amount)}</td>
                  <td className={`px-4 py-1.5 text-xs ${rowPill[r.status] ?? ''}`}>{r.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
