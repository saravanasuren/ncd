import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { formatINR } from '@new-wealth/shared';
import { api, ApiError } from '../api/client.js';
import { useAuth } from '../auth/AuthContext.js';

export function PayoutsPage() {
  const qc = useQueryClient();
  const { can } = useAuth();
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [msg, setMsg] = useState('');

  const preview = useQuery({ queryKey: ['payout-preview', date], queryFn: () => api.get<any>(`/api/payouts/preview?date=${date}`) });
  const batches = useQuery({ queryKey: ['payout-batches'], queryFn: () => api.get<{ rows: any[] }>('/api/payouts') });

  const create = useMutation({ mutationFn: () => api.post('/api/payouts', { payout_date: date }), onSuccess: () => { setMsg('Batch created — needs checker approval, then mark paid.'); qc.invalidateQueries({ queryKey: ['payout-batches'] }); qc.invalidateQueries({ queryKey: ['payout-preview', date] }); }, onError: (e) => setMsg(e instanceof ApiError ? e.message : 'Failed') });
  const markPaid = useMutation({ mutationFn: (batchId: number) => api.post(`/api/payouts/${batchId}/mark-paid`, {}), onSuccess: () => { setMsg('Marked paid.'); qc.invalidateQueries({ queryKey: ['payout-batches'] }); }, onError: (e) => setMsg(e instanceof ApiError ? e.message : 'Failed') });

  return (
    <div className="max-w-3xl">
      <h1 className="text-xl font-bold tracking-tight m-0">Interest payouts (NEFT)</h1>
      <p className="text-sm text-text-muted mt-1 mb-4">Batch the interest due up to a date; a checker approves, then it's marked paid.</p>
      <div className="flex items-center gap-2 mb-4">
        <label className="text-sm text-text-label">Up to date</label>
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="px-2.5 py-1.5 text-sm border border-border-strong rounded" />
        <button disabled={!preview.data || preview.data.count === 0 || create.isPending} onClick={() => { setMsg(''); create.mutate(); }}
          className="text-xs bg-primary text-white rounded px-3 py-1.5 disabled:opacity-40 hover:bg-primary-hover">Create batch</button>
      </div>
      {msg && <div className="text-xs text-primary mb-3">{msg}</div>}
      {preview.data && (
        <div className="bg-surface border border-border rounded-lg shadow-card p-4 mb-5 text-sm">
          <span className="font-semibold">{preview.data.count}</span> interest rows due · net <span className="mono font-semibold">{formatINR(preview.data.totals.net)}</span>
        </div>
      )}
      <h2 className="text-xs font-semibold text-text-label uppercase tracking-wide mb-2">Recent batches</h2>
      <div className="bg-surface border border-border rounded-lg shadow-card divide-y divide-border">
        {(batches.data?.rows ?? []).map((b) => (
          <div key={b.id} className="p-4 flex items-center gap-4 text-sm">
            <span className="font-mono text-xs">{b.batch_no}</span>
            <span className="text-text-muted">{b.payout_date}</span>
            <span className="mono">{formatINR(b.total_net)}</span>
            <span className="text-xs rounded px-1.5 py-0.5 bg-bg ml-auto">{b.status}</span>
            {can('payouts:mark-paid-manual') && b.status === 'Approved' && (
              <button onClick={() => markPaid.mutate(b.id)} className="text-xs bg-primary text-white rounded px-3 py-1.5 hover:bg-primary-hover">Mark paid</button>
            )}
          </div>
        ))}
        {(batches.data?.rows ?? []).length === 0 && <div className="p-6 text-center text-text-muted">No batches yet.</div>}
      </div>
    </div>
  );
}
