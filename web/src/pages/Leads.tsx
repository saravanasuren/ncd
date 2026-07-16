import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../api/client.js';
import { useAuth } from '../auth/AuthContext.js';
import { DataTable, type Column } from '../components/DataTable.js';

interface Lead {
  id: number;
  full_name: string;
  phone: string | null;
  district: string | null;
  source: string | null;
  status: string;
  expected_amount: string | null;
}

export function LeadsPage() {
  const qc = useQueryClient();
  const nav = useNavigate();
  const { can } = useAuth();
  const [form, setForm] = useState({ full_name: '', phone: '', district: '', source: '' });
  const [err, setErr] = useState('');
  const [converting, setConverting] = useState<{ id: number; amount: string; seriesId: string } | null>(null);

  const { data, isLoading } = useQuery({ queryKey: ['leads'], queryFn: () => api.get<{ rows: Lead[] }>('/api/leads') });
  const series = useQuery({
    queryKey: ['series'],
    queryFn: () => api.get<{ rows: { id: number; code: string; status: string }[] }>('/api/series'),
    enabled: can('leads:convert'),
  });
  const openSeries = (series.data?.rows ?? []).filter((s) => s.status === 'Open');

  const create = useMutation({
    mutationFn: () => api.post('/api/leads', { ...form, phone: form.phone || undefined }),
    onSuccess: () => { setForm({ full_name: '', phone: '', district: '', source: '' }); qc.invalidateQueries({ queryKey: ['leads'] }); },
    onError: (e) => setErr(e instanceof ApiError ? e.message : 'Failed'),
  });

  const convert = useMutation({
    mutationFn: (c: { id: number; amount: string; seriesId: string }) =>
      api.post<{ customerId: number }>(`/api/leads/${c.id}/convert`, {
        confirmed_amount: Number(c.amount),
        confirmed_series_id: Number(c.seriesId),
      }),
    onSuccess: (r) => { setConverting(null); qc.invalidateQueries({ queryKey: ['leads'] }); nav(`/app/customers/${r.customerId}`); },
    onError: (e) => setErr(e instanceof ApiError ? e.message : 'Failed'),
  });

  const inp = 'px-2.5 py-1.5 text-sm border border-border-strong rounded outline-none focus:border-primary';

  return (
    <div className="max-w-4xl">
      <h1 className="text-xl font-bold tracking-tight m-0">Leads</h1>
      <p className="text-sm text-text-muted mt-1 mb-5">Prospective investors you're following up.</p>

      {can('leads:create') && (
        <div className="bg-surface border border-border rounded-lg shadow-card p-4 mb-5">
          <div className="flex flex-wrap gap-2 items-end">
            <input className={inp} placeholder="Full name" value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} />
            <input className={inp} placeholder="Phone" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
            <input className={inp} placeholder="District" value={form.district} onChange={(e) => setForm({ ...form, district: e.target.value })} />
            <input className={inp} placeholder="Source" value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value })} />
            <button disabled={!form.full_name || create.isPending} onClick={() => { setErr(''); create.mutate(); }}
              className="bg-primary hover:bg-primary-hover disabled:opacity-40 text-white rounded px-4 py-1.5 text-sm font-semibold">+ Add lead</button>
          </div>
        </div>
      )}
      {err && <div className="text-xs text-danger mb-3">{err}</div>}

      {isLoading ? <div className="text-text-muted">Loading…</div> : (() => {
        const columns: Column<Lead>[] = [
          { key: 'full_name', header: 'Name', tdClassName: 'font-medium' },
          { key: 'phone', header: 'Phone', tdClassName: 'text-text-muted', value: (l) => l.phone ?? '', render: (l) => l.phone ?? '—' },
          { key: 'district', header: 'District', value: (l) => l.district ?? '', render: (l) => l.district ?? '—' },
          { key: 'source', header: 'Source', value: (l) => l.source ?? '', render: (l) => l.source ?? '—' },
          { key: 'expected_amount', header: 'Expected', align: 'right', value: (l) => Number(l.expected_amount ?? 0),
            render: (l) => l.expected_amount ? <span className="mono">₹{Number(l.expected_amount).toLocaleString('en-IN')}</span> : '—' },
          { key: 'status', header: 'Status', render: (l) => <span className="text-xs rounded px-1.5 py-0.5 bg-bg">{l.status}</span> },
          { key: 'actions', header: '', sortable: false, filterable: false, align: 'right',
            render: (l) => can('leads:convert') && l.status !== 'Converted' ? (
              converting?.id === l.id ? (
                <span className="inline-flex items-center gap-1.5">
                  <input className={`${inp} w-28`} type="number" placeholder="Amount ₹" autoFocus
                    value={converting.amount} onChange={(e) => setConverting({ ...converting, amount: e.target.value })} />
                  <select className={inp} value={converting.seriesId}
                    onChange={(e) => setConverting({ ...converting, seriesId: e.target.value })}>
                    <option value="">Series…</option>
                    {openSeries.map((s) => <option key={s.id} value={s.id}>{s.code}</option>)}
                  </select>
                  <button disabled={!converting.amount || Number(converting.amount) <= 0 || !converting.seriesId || convert.isPending}
                    onClick={() => { setErr(''); convert.mutate(converting); }}
                    className="text-xs bg-primary text-white rounded px-2.5 py-1.5 disabled:opacity-40 hover:bg-primary-hover">Confirm</button>
                  <button onClick={() => setConverting(null)} className="text-xs text-text-muted hover:underline">Cancel</button>
                </span>
              ) : (
                <button onClick={() => { setErr(''); setConverting({ id: l.id, amount: l.expected_amount ?? '', seriesId: '' }); }}
                  className="text-xs text-primary hover:underline">Convert →</button>
              )
            ) : null },
        ];
        return <DataTable columns={columns} rows={data!.rows} rowKey={(l) => l.id} empty="No leads yet." />;
      })()}
    </div>
  );
}
