import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { formatINR } from '@new-wealth/shared';
import { api, ApiError } from '../api/client.js';
import { useAuth } from '../auth/AuthContext.js';
import { DataTable, type Column } from '../components/DataTable.js';
import { Tabs, type TabDef } from '../components/Tabs.js';

interface SeriesRow { series_id: number; code: string; name: string; status: string; pending_count: number; pending_amount: string; }

// A 0-pending series is still actionable if it can be formally closed (moved to
// Allotted) — i.e. it isn't already Allotted/Withdrawn.
const isCloseOnly = (s: SeriesRow) => s.pending_count === 0 && s.status !== 'Allotted' && s.status !== 'Withdrawn';
// "Needs action" = has investments to allot, or can still be closed. Fully
// allotted series (0 pending, already Allotted) are done — hidden by default,
// but reachable via "All series" so their allotment can still be reverted.
const needsAction = (s: SeriesRow) => s.pending_count > 0 || isCloseOnly(s);

export function AllotmentsPage() {
  const qc = useQueryClient();
  const { can } = useAuth();
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [view, setView] = useState<'action' | 'all'>('action');
  const [msg, setMsg] = useState('');
  const { data, isLoading } = useQuery({ queryKey: ['allot-series'], queryFn: () => api.get<{ rows: SeriesRow[] }>('/api/allotments/series') });
  const allot = useMutation({
    mutationFn: (seriesId: number) => api.post(`/api/allotments/series/${seriesId}`, { allotment_date: date }),
    onSuccess: () => { setMsg('Batch submitted — a second checker must approve it on the Approvals page.'); qc.invalidateQueries({ queryKey: ['allot-series'] }); },
    onError: (e) => setMsg(e instanceof ApiError ? e.message : 'Failed'),
  });
  const revert = useMutation({
    mutationFn: (seriesId: number) => api.post(`/api/allotments/series/${seriesId}/revert`, { reason: window.prompt('Reason for revert') ?? 'Revert' }),
    onSuccess: () => { setMsg('Allotment reverted.'); qc.invalidateQueries({ queryKey: ['allot-series'] }); },
    onError: (e) => setMsg(e instanceof ApiError ? e.message : 'Failed'),
  });
  if (isLoading) return <div className="text-text-muted">Loading…</div>;

  const allRows = data!.rows;
  const actionRows = allRows.filter(needsAction);
  const shownRows = view === 'action' ? actionRows : allRows;
  const tabs: TabDef<'action' | 'all'>[] = [
    { key: 'action', label: 'Needs action', count: actionRows.length },
    { key: 'all', label: 'All series', count: allRows.length },
  ];

  const columns: Column<SeriesRow>[] = [
    { key: 'code', header: 'Series', tdClassName: 'font-semibold' },
    { key: 'name', header: 'Name' },
    { key: 'pending_count', header: 'Ready to allot', align: 'right', value: (s) => s.pending_count },
    { key: 'pending_amount', header: 'Ready amount', align: 'right',
      value: (s) => Number(s.pending_amount), render: (s) => <span className="mono">{formatINR(s.pending_amount)}</span> },
    { key: 'status', header: 'Status' },
    { key: 'actions', header: 'Actions', sortable: false, filterable: false, align: 'right', tdClassName: 'whitespace-nowrap',
      render: (s) => {
        const closeOnly = isCloseOnly(s);
        const canAllot = s.pending_count > 0 || closeOnly;
        return (
        <span className="inline-flex gap-2 justify-end">
          {canAllot && (
            <button disabled={allot.isPending} onClick={() => { setMsg(''); allot.mutate(s.series_id); }}
              title={closeOnly ? 'No pending investments — this closes the series to new money' : undefined}
              className="text-xs bg-primary text-white rounded px-3 py-1.5 disabled:opacity-40 hover:bg-primary-hover">{closeOnly ? 'Close series' : 'Allot batch'}</button>
          )}
          {can('allotments:revert') && s.status === 'Allotted' && (
            <button onClick={() => { setMsg(''); revert.mutate(s.series_id); }} className="text-xs border border-border text-danger rounded px-3 py-1.5 hover:bg-[color:var(--danger-bg)]">↺ Revert</button>
          )}
        </span>
      );
      } },
  ];

  return (
    <div className="w-full">
      <h1 className="text-xl font-bold tracking-tight m-0">Allotments</h1>
      <p className="text-sm text-text-muted mt-1 mb-4">Formally allot a series once its investments are already active — this stamps the allotment date and closes the series to new money. It does not change the book. Submitting starts a maker-checker approval.</p>
      <div className="flex items-center gap-2 mb-4">
        <label className="text-sm text-text-label">Allotment date</label>
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="px-2.5 py-1.5 text-sm border border-border-strong rounded" />
      </div>
      {msg && <div className="text-xs text-primary mb-3">{msg}</div>}
      <Tabs tabs={tabs} active={view} onChange={setView} />
      {view === 'action' && allRows.length - actionRows.length > 0 && (
        <p className="text-xs text-text-muted -mt-2 mb-3">
          {allRows.length - actionRows.length} fully-allotted series hidden — switch to <button onClick={() => setView('all')} className="text-primary hover:underline">All series</button> to revert one.
        </p>
      )}
      <DataTable
        columns={columns}
        rows={shownRows}
        rowKey={(s) => s.series_id}
        defaultSort={{ key: 'code', dir: 'desc' }}
        empty={view === 'action' ? 'No series need allotment right now.' : 'No series configured.'}
      />
    </div>
  );
}
