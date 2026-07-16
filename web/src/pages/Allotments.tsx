import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { formatINR } from '@new-wealth/shared';
import { api, ApiError } from '../api/client.js';

interface SeriesRow { series_id: number; code: string; name: string; status: string; pending_count: number; pending_amount: string; }

export function AllotmentsPage() {
  const qc = useQueryClient();
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [msg, setMsg] = useState('');
  const { data, isLoading } = useQuery({ queryKey: ['allot-series'], queryFn: () => api.get<{ rows: SeriesRow[] }>('/api/allotments/series') });
  const allot = useMutation({
    mutationFn: (seriesId: number) => api.post(`/api/allotments/series/${seriesId}`, { allotment_date: date }),
    onSuccess: () => { setMsg('Batch submitted — a second checker must approve it on the Approvals page.'); qc.invalidateQueries({ queryKey: ['allot-series'] }); },
    onError: (e) => setMsg(e instanceof ApiError ? e.message : 'Failed'),
  });
  if (isLoading) return <div className="text-text-muted">Loading…</div>;
  return (
    <div className="max-w-3xl">
      <h1 className="text-xl font-bold tracking-tight m-0">Allotments</h1>
      <p className="text-sm text-text-muted mt-1 mb-4">Allot a whole series at once. Submitting starts a maker-checker approval.</p>
      <div className="flex items-center gap-2 mb-4">
        <label className="text-sm text-text-label">Allotment date</label>
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="px-2.5 py-1.5 text-sm border border-border-strong rounded" />
      </div>
      {msg && <div className="text-xs text-primary mb-3">{msg}</div>}
      <div className="bg-surface border border-border rounded-lg shadow-card divide-y divide-border">
        {data!.rows.map((s) => (
          <div key={s.series_id} className="p-4 flex items-center gap-4">
            <div className="flex-1">
              <div className="text-sm font-semibold">{s.code} — {s.name}</div>
              <div className="text-xs text-text-muted">{s.pending_count} pending · {formatINR(s.pending_amount)} · series {s.status}</div>
            </div>
            <button disabled={s.pending_count === 0 || allot.isPending} onClick={() => { setMsg(''); allot.mutate(s.series_id); }}
              className="text-xs bg-primary text-white rounded px-3 py-1.5 disabled:opacity-40 hover:bg-primary-hover">Allot batch</button>
          </div>
        ))}
        {data!.rows.length === 0 && <div className="p-6 text-center text-text-muted">No series configured.</div>}
      </div>
    </div>
  );
}
