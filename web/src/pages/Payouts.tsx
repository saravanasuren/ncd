import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { formatINR } from '@new-wealth/shared';
import { api, ApiError } from '../api/client.js';
import { useAuth } from '../auth/AuthContext.js';
import { DataTable, type Column } from '../components/DataTable.js';

export function PayoutsPage() {
  const qc = useQueryClient();
  const { can } = useAuth();
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [msg, setMsg] = useState('');

  const preview = useQuery({ queryKey: ['payout-preview', date], queryFn: () => api.get<any>(`/api/payouts/preview?date=${date}`) });
  const batches = useQuery({ queryKey: ['payout-batches'], queryFn: () => api.get<{ rows: any[] }>('/api/payouts') });
  const statements = useQuery({ queryKey: ['bank-statements'], queryFn: () => api.get<{ rows: any[] }>('/api/bank-statements') });

  const create = useMutation({ mutationFn: () => api.post('/api/payouts', { payout_date: date }), onSuccess: () => { setMsg('Batch created — needs checker approval, then mark paid.'); qc.invalidateQueries({ queryKey: ['payout-batches'] }); qc.invalidateQueries({ queryKey: ['payout-preview', date] }); }, onError: (e) => setMsg(e instanceof ApiError ? e.message : 'Failed') });
  const markPaid = useMutation({ mutationFn: (batchId: number) => api.post(`/api/payouts/${batchId}/mark-paid`, {}), onSuccess: () => { setMsg('Marked paid.'); qc.invalidateQueries({ queryKey: ['payout-batches'] }); }, onError: (e) => setMsg(e instanceof ApiError ? e.message : 'Failed') });

  const [stmt, setStmt] = useState('');
  const matchStmt = useMutation({
    mutationFn: async () => {
      const lines = stmt.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
        const [value_date, amount, utr] = l.split(',').map((x) => x.trim());
        return { value_date: value_date!, amount: Number(amount), utr: utr || undefined };
      });
      const up = await api.post<{ statement_id: number }>('/api/bank-statements', { source_bank: 'Federal', lines });
      return api.post<{ matched: number; unmatched: number }>(`/api/bank-statements/${up.statement_id}/run-match`, {});
    },
    onSuccess: (r) => { setMsg(`Statement matched: ${r.matched} paid, ${r.unmatched} unmatched.`); setStmt(''); qc.invalidateQueries({ queryKey: ['payout-batches'] }); qc.invalidateQueries({ queryKey: ['bank-statements'] }); },
    onError: (e) => setMsg(e instanceof ApiError ? e.message : 'Failed'),
  });

  return (
    <div className="w-full">
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
      {(() => {
        const columns: Column<any>[] = [
          { key: 'batch_no', header: 'Batch', tdClassName: 'font-mono text-xs' },
          { key: 'payout_date', header: 'Date', tdClassName: 'text-text-muted' },
          { key: 'total_net', header: 'Net', align: 'right', value: (b) => Number(b.total_net), render: (b) => <span className="mono">{formatINR(b.total_net)}</span> },
          { key: 'status', header: 'Status', render: (b) => <span className="text-xs rounded px-1.5 py-0.5 bg-bg">{b.status}</span> },
          { key: 'actions', header: '', sortable: false, filterable: false, align: 'right', tdClassName: 'whitespace-nowrap',
            render: (b) => (
              <span className="inline-flex gap-2 justify-end">
                {['Approved', 'Downloaded', 'Reconciled'].includes(b.status) && (
                  <a href={`/api/payouts/${b.id}/download.xlsx`} className="text-xs border border-border rounded px-3 py-1.5 hover:bg-bg no-underline">↓ NEFT sheet</a>
                )}
                {can('payouts:mark-paid-manual') && b.status === 'Approved' && (
                  <button onClick={() => markPaid.mutate(b.id)} className="text-xs bg-primary text-white rounded px-3 py-1.5 hover:bg-primary-hover">Mark paid</button>
                )}
              </span>
            ) },
        ];
        return <DataTable columns={columns} rows={batches.data?.rows ?? []} rowKey={(b) => b.id} defaultSort={{ key: 'batch_no', dir: 'desc' }} empty="No batches yet." />;
      })()}

      <h2 className="text-xs font-semibold text-text-label uppercase tracking-wide mt-6 mb-2">Reconcile a bank statement</h2>
      <div className="bg-surface border border-border rounded-lg shadow-card p-4">
        <p className="text-xs text-text-muted mb-2">Paste statement lines, one per line: <span className="mono">value_date, amount, utr</span> (UTR optional). Matching lines mark payouts Paid.</p>
        <textarea className="w-full h-24 px-2.5 py-2 text-sm border border-border-strong rounded font-mono outline-none focus:border-primary"
          placeholder={'2026-08-29, 4931.51, FDRLUTR001\n2026-08-29, 5095.89, FDRLUTR002'} value={stmt} onChange={(e) => setStmt(e.target.value)} />
        <button disabled={!stmt.trim() || matchStmt.isPending} onClick={() => { setMsg(''); matchStmt.mutate(); }}
          className="mt-2 text-xs bg-primary text-white rounded px-4 py-1.5 disabled:opacity-40 hover:bg-primary-hover">Upload & match</button>
      </div>

      <h2 className="text-xs font-semibold text-text-label uppercase tracking-wide mt-6 mb-2">Uploaded statements</h2>
      {(() => {
        const cols: Column<any>[] = [
          { key: 'id', header: '#', tdClassName: 'font-mono text-xs' },
          { key: 'source_bank', header: 'Bank' },
          { key: 'line_count', header: 'Lines', align: 'right' },
          { key: 'matched_count', header: 'Matched', align: 'right',
            render: (s) => <span className={Number(s.matched_count) === Number(s.line_count) ? 'text-success' : ''}>{s.matched_count}</span> },
          { key: 'created_at', header: 'Uploaded', render: (s) => <span className="mono text-xs">{String(s.created_at).slice(0, 16).replace('T', ' ')}</span> },
        ];
        return <DataTable columns={cols} rows={statements.data?.rows ?? []} rowKey={(s) => s.id} defaultSort={{ key: 'id', dir: 'desc' }} empty="No statements uploaded yet." />;
      })()}
    </div>
  );
}
