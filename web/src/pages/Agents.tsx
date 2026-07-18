import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api/client.js';
import { DataTable, type Column } from '../components/DataTable.js';

interface AgentRow {
  id: number;
  agent_code: string;
  full_name: string;
  phone: string | null;
  email: string | null;
  source: string;
  commission_status: string;
  commission_rate_pct: string | null;
  is_active: boolean;
  user_id: number | null;
  user_name: string | null;
  bank_name: string | null;
  account_number: string | null;
  ifsc: string | null;
}

interface EditState {
  id: number; full_name: string; phone: string; email: string;
  bank_name: string; account_number: string; ifsc: string;
}

const EMPTY = { full_name: '', agent_code: '', phone: '', email: '', bank_name: '', account_number: '', ifsc: '' };
const inp = 'px-2.5 py-1.5 text-sm border border-border-strong rounded outline-none focus:border-primary';

export function AgentsPage() {
  const qc = useQueryClient();
  const [form, setForm] = useState(EMPTY);
  const [edit, setEdit] = useState<EditState | null>(null);
  const [err, setErr] = useState('');
  const { data, isLoading } = useQuery({ queryKey: ['agents'], queryFn: () => api.get<{ rows: AgentRow[] }>('/api/agents') });

  const create = useMutation({
    mutationFn: () => api.post('/api/agents', {
      full_name: form.full_name,
      ...(form.agent_code.trim() ? { agent_code: form.agent_code.trim() } : {}),
      ...(form.phone ? { phone: form.phone } : {}),
      ...(form.email ? { email: form.email } : {}),
      ...(form.bank_name ? { bank_name: form.bank_name } : {}),
      ...(form.account_number ? { account_number: form.account_number } : {}),
      ...(form.ifsc ? { ifsc: form.ifsc } : {}),
    }),
    onSuccess: () => { setForm(EMPTY); qc.invalidateQueries({ queryKey: ['agents'] }); },
    onError: (e) => setErr(e instanceof ApiError ? e.message : 'Failed'),
  });

  const update = useMutation({
    mutationFn: (e: EditState) => api.put(`/api/agents/${e.id}`, {
      full_name: e.full_name,
      phone: e.phone || null,
      email: e.email || null,
      bank_name: e.bank_name || null,
      account_number: e.account_number || null,
      ifsc: e.ifsc || null,
    }),
    onSuccess: () => { setEdit(null); qc.invalidateQueries({ queryKey: ['agents'] }); },
    onError: (e) => setErr(e instanceof ApiError ? e.message : 'Failed to update agent'),
  });

  const toggle = useMutation({
    mutationFn: (a: AgentRow) => api.put(`/api/agents/${a.id}`, { is_active: !a.is_active }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['agents'] }),
    onError: (e) => setErr(e instanceof ApiError ? e.message : 'Failed'),
  });

  if (isLoading) return <div className="text-text-muted">Loading…</div>;

  const columns: Column<AgentRow>[] = [
    { key: 'agent_code', header: 'Code', tdClassName: 'font-mono text-xs' },
    { key: 'full_name', header: 'Name', tdClassName: 'font-medium',
      render: (a) => edit?.id === a.id
        ? <input className={`${inp} w-44`} value={edit.full_name} onChange={(e) => setEdit({ ...edit, full_name: e.target.value })} />
        : a.full_name },
    { key: 'phone', header: 'Phone', tdClassName: 'text-text-muted', value: (a) => a.phone ?? '',
      render: (a) => edit?.id === a.id
        ? <input className={`${inp} w-32`} placeholder="Phone" value={edit.phone} onChange={(e) => setEdit({ ...edit, phone: e.target.value })} />
        : (a.phone ?? '—') },
    { key: 'bank', header: 'Bank / account', sortable: false, filterable: false,
      value: (a) => [a.bank_name, a.account_number].filter(Boolean).join(' '),
      render: (a) => edit?.id === a.id
        ? <span className="flex gap-1">
            <input className={`${inp} w-24`} placeholder="Bank" value={edit.bank_name} onChange={(e) => setEdit({ ...edit, bank_name: e.target.value })} />
            <input className={`${inp} w-32`} placeholder="Account" value={edit.account_number} onChange={(e) => setEdit({ ...edit, account_number: e.target.value })} />
            <input className={`${inp} w-24`} placeholder="IFSC" value={edit.ifsc} onChange={(e) => setEdit({ ...edit, ifsc: e.target.value.toUpperCase() })} />
          </span>
        : (a.bank_name || a.account_number
            ? <span className="text-xs">{a.bank_name ?? ''} <span className="font-mono text-text-muted">{a.account_number ?? ''}</span></span>
            : '—') },
    { key: 'source', header: 'Source' },
    { key: 'commission_status', header: 'Commission',
      render: (a) => <span className="text-xs rounded px-1.5 py-0.5 bg-bg">{a.commission_status}{a.commission_rate_pct ? ` · ${Number(a.commission_rate_pct)}%` : ''}</span> },
    { key: 'user_name', header: 'Linked user', value: (a) => a.user_name ?? '', render: (a) => a.user_name ?? '—' },
    { key: 'is_active', header: 'Status', value: (a) => (a.is_active ? 'Active' : 'Disabled'),
      render: (a) => <span className={`text-xs rounded px-1.5 py-0.5 ${a.is_active ? 'bg-[color:var(--success-bg)] text-success' : 'bg-bg text-text-muted'}`}>{a.is_active ? 'Active' : 'Disabled'}</span> },
    { key: 'actions', header: '', sortable: false, filterable: false, align: 'right', tdClassName: 'whitespace-nowrap',
      render: (a) => edit?.id === a.id ? (
        <span className="flex gap-2 justify-end">
          <button onClick={() => { setErr(''); update.mutate(edit); }} disabled={!edit.full_name.trim() || update.isPending}
            className="text-xs bg-primary text-white rounded px-3 py-1 disabled:opacity-40 hover:bg-primary-hover">Save</button>
          <button onClick={() => setEdit(null)} className="text-xs text-text-muted hover:underline">Cancel</button>
        </span>
      ) : (
        <span className="flex gap-3 justify-end">
          <button onClick={() => { setErr(''); setEdit({ id: a.id, full_name: a.full_name, phone: a.phone ?? '', email: a.email ?? '', bank_name: a.bank_name ?? '', account_number: a.account_number ?? '', ifsc: a.ifsc ?? '' }); }}
            className="text-xs text-primary hover:underline">Edit</button>
          <button onClick={() => { setErr(''); toggle.mutate(a); }} className="text-xs text-primary hover:underline">
            {a.is_active ? 'Disable' : 'Enable'}
          </button>
        </span>
      ) },
  ];

  return (
    <div className="w-full">
      <h1 className="text-xl font-bold tracking-tight m-0">Agents</h1>
      <p className="text-sm text-text-muted mt-1 mb-5">People who source business — their code goes in the customer's "referred by" and drives their incentives. Agents created from a new referred-by name appear here pending approval.</p>

      <div className="bg-surface border border-border rounded-lg shadow-card p-4 mb-5">
        <div className="flex flex-wrap gap-2">
          <input className={inp} placeholder="Full name *" value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} />
          <input className={`${inp} w-32`} placeholder="Code (auto)" value={form.agent_code} onChange={(e) => setForm({ ...form, agent_code: e.target.value.toUpperCase() })} />
          <input className={`${inp} w-36`} placeholder="Phone" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          <input className={inp} type="email" placeholder="Email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          <input className={`${inp} w-36`} placeholder="Bank" value={form.bank_name} onChange={(e) => setForm({ ...form, bank_name: e.target.value })} />
          <input className={`${inp} w-40`} placeholder="Account no." value={form.account_number} onChange={(e) => setForm({ ...form, account_number: e.target.value })} />
          <input className={`${inp} w-28`} placeholder="IFSC" value={form.ifsc} onChange={(e) => setForm({ ...form, ifsc: e.target.value.toUpperCase() })} />
          <button disabled={!form.full_name.trim() || create.isPending} onClick={() => { setErr(''); create.mutate(); }}
            className="bg-primary hover:bg-primary-hover disabled:opacity-40 text-white rounded px-4 py-1.5 text-sm font-semibold">+ Add agent</button>
        </div>
        {err && <div className="text-xs text-danger mt-2">{err}</div>}
      </div>

      <DataTable columns={columns} rows={data!.rows} rowKey={(a) => a.id} defaultSort={{ key: 'full_name', dir: 'asc' }} empty="No agents yet." />
    </div>
  );
}
