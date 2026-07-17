import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { formatINR } from '@new-wealth/shared';
import { api, ApiError } from '../api/client.js';
import { DataTable, type Column } from '../components/DataTable.js';

interface SeriesRow { series_id: number; code: string; name: string; status: string; pending_count: number; pending_amount: string; }

export function ActivationsPage() {
  const qc = useQueryClient();
  const [msg, setMsg] = useState('');
  const { data, isLoading } = useQuery({ queryKey: ['activate-series'], queryFn: () => api.get<{ rows: SeriesRow[] }>('/api/activations/series') });
  const activate = useMutation({
    mutationFn: (seriesId: number) => api.post(`/api/activations/series/${seriesId}`, {}),
    onSuccess: () => { setMsg('Batch submitted — a second checker must approve it on the Approvals page.'); qc.invalidateQueries({ queryKey: ['activate-series'] }); },
    onError: (e) => setMsg(e instanceof ApiError ? e.message : 'Failed'),
  });
  if (isLoading) return <div className="text-text-muted">Loading…</div>;

  const columns: Column<SeriesRow>[] = [
    { key: 'code', header: 'Series', tdClassName: 'font-semibold' },
    { key: 'name', header: 'Name' },
    { key: 'pending_count', header: 'Funded, pending', align: 'right', value: (s) => s.pending_count },
    { key: 'pending_amount', header: 'Pending amount', align: 'right',
      value: (s) => Number(s.pending_amount), render: (s) => <span className="mono">{formatINR(s.pending_amount)}</span> },
    { key: 'status', header: 'Series status' },
    { key: 'actions', header: 'Actions', sortable: false, filterable: false, align: 'right', tdClassName: 'whitespace-nowrap',
      render: (s) => (
        <button disabled={s.pending_count === 0 || activate.isPending} onClick={() => { setMsg(''); activate.mutate(s.series_id); }}
          className="text-xs bg-primary text-white rounded px-3 py-1.5 disabled:opacity-40 hover:bg-primary-hover">Activate batch</button>
      ) },
  ];

  return (
    <div className="max-w-4xl">
      <h1 className="text-xl font-bold tracking-tight m-0">Activations</h1>
      <p className="text-sm text-text-muted mt-1 mb-4">Activate funded investments — money is in the account and awaiting approval. On approval the NCD goes live: interest starts and incentives accrue. Allotment is a separate, later step. Submitting starts a maker-checker approval.</p>
      {msg && <div className="text-xs text-primary mb-3">{msg}</div>}
      <DataTable
        columns={columns}
        rows={data!.rows}
        rowKey={(s) => s.series_id}
        defaultSort={{ key: 'code', dir: 'desc' }}
        empty="No series configured."
      />
    </div>
  );
}
