import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../api/client.js';
import { useAuth } from '../auth/AuthContext.js';
import { DataTable, type Column } from '../components/DataTable.js';

interface CustomerRow {
  id: number;
  customer_code: string;
  full_name: string;
  phone: string | null;
  district: string | null;
  kyc_status: string;
  creation_status: string;
  is_active: boolean;
}

const statusPill: Record<string, string> = {
  Approved: 'bg-[color:var(--success-bg)] text-success',
  PendingApproval: 'bg-[color:var(--warn-bg)] text-warn',
  Draft: 'bg-bg text-text-muted',
};

const columns: Column<CustomerRow>[] = [
  { key: 'customer_code', header: 'Code', tdClassName: 'font-mono text-xs' },
  { key: 'full_name', header: 'Name', tdClassName: 'font-medium',
    render: (c) => <Link to={`/app/customers/${c.id}`} className="text-primary hover:underline">{c.full_name}</Link> },
  { key: 'district', header: 'District', value: (c) => c.district ?? '', render: (c) => c.district ?? '—' },
  { key: 'kyc_status', header: 'KYC', tdClassName: 'text-text-muted' },
  { key: 'creation_status', header: 'Status',
    render: (c) => <span className={`text-xs rounded px-1.5 py-0.5 ${statusPill[c.creation_status] ?? 'bg-bg'}`}>{c.creation_status}</span> },
];

const EMPTY = { full_name: '', pan: '', phone: '', email: '', dob: '', gender: '', address: '', city: '', district: '', state: '', referred_by_text: '', is_nri: false };

function EnrolForm({ onClose }: { onClose: () => void }) {
  const nav = useNavigate();
  const [f, setF] = useState(EMPTY);
  const [err, setErr] = useState('');
  const create = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = { full_name: f.full_name, is_nri: f.is_nri };
      for (const k of ['pan', 'phone', 'email', 'dob', 'gender', 'address', 'city', 'district', 'state', 'referred_by_text'] as const) {
        if (f[k]) body[k] = f[k];
      }
      return api.post<{ id: number }>('/api/customers', body);
    },
    onSuccess: (r) => nav(`/app/customers/${r.id}`),
    onError: (e) => setErr(e instanceof ApiError ? e.message : 'Failed'),
  });
  const inp = 'px-2.5 py-1.5 text-sm border border-border-strong rounded outline-none focus:border-primary';
  return (
    <div className="bg-surface border border-border rounded-lg shadow-card p-4 mb-5">
      <div className="text-xs font-semibold text-text-label uppercase tracking-wide mb-2.5">New customer (direct enrolment)</div>
      <div className="flex flex-wrap gap-2">
        <input className={inp} placeholder="Full name *" value={f.full_name} onChange={(e) => setF({ ...f, full_name: e.target.value })} autoFocus />
        <input className={`${inp} w-36 uppercase`} placeholder="PAN" value={f.pan} onChange={(e) => setF({ ...f, pan: e.target.value.toUpperCase() })} />
        <input className={`${inp} w-36`} placeholder="Phone" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
        <input className={inp} type="email" placeholder="Email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
        <input className={inp} type="date" title="Date of birth" value={f.dob} onChange={(e) => setF({ ...f, dob: e.target.value })} />
        <select className={inp} value={f.gender} onChange={(e) => setF({ ...f, gender: e.target.value })}>
          <option value="">Gender…</option>
          {['Male', 'Female', 'Other'].map((g) => <option key={g}>{g}</option>)}
        </select>
        <input className={`${inp} w-72`} placeholder="Address" value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} />
        <input className={`${inp} w-32`} placeholder="City" value={f.city} onChange={(e) => setF({ ...f, city: e.target.value })} />
        <input className={`${inp} w-32`} placeholder="District" value={f.district} onChange={(e) => setF({ ...f, district: e.target.value })} />
        <input className={`${inp} w-32`} placeholder="State" value={f.state} onChange={(e) => setF({ ...f, state: e.target.value })} />
        <input className={inp} placeholder="Referred by" value={f.referred_by_text} onChange={(e) => setF({ ...f, referred_by_text: e.target.value })} />
        <label className="text-xs flex items-center gap-1.5"><input type="checkbox" checked={f.is_nri} onChange={(e) => setF({ ...f, is_nri: e.target.checked })} />NRI</label>
      </div>
      <div className="flex gap-2 items-center mt-3">
        <button disabled={!f.full_name.trim() || create.isPending} onClick={() => { setErr(''); create.mutate(); }}
          className="text-xs bg-primary text-white rounded px-4 py-1.5 disabled:opacity-40 hover:bg-primary-hover">Enrol customer</button>
        <button onClick={onClose} className="text-xs text-text-muted hover:underline">Cancel</button>
        {err && <span className="text-xs text-danger">{err}</span>}
      </div>
    </div>
  );
}

export function CustomersPage() {
  const { can } = useAuth();
  const [q, setQ] = useState('');
  const [enrolling, setEnrolling] = useState(false);
  const query = q.trim();
  const { data, isLoading, error } = useQuery({
    queryKey: ['customers', query],
    queryFn: () => api.get<{ rows: CustomerRow[] }>(`/api/customers${query ? `?q=${encodeURIComponent(query)}` : ''}`),
  });
  if (error) return <div className="text-danger">Failed to load customers.</div>;

  return (
    <div className="max-w-4xl">
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-xl font-bold tracking-tight m-0">Customers</h1>
          <p className="text-sm text-text-muted mt-1">Enrolled investors in your scope.</p>
        </div>
        {can('customers:create') && !enrolling && (
          <button onClick={() => setEnrolling(true)} className="text-xs bg-primary text-white rounded px-3 py-1.5 hover:bg-primary-hover">+ New customer</button>
        )}
      </div>

      {enrolling && <EnrolForm onClose={() => setEnrolling(false)} />}

      <input
        className="w-full max-w-md px-3 py-1.5 text-sm border border-border-strong rounded outline-none focus:border-primary mb-4"
        placeholder="Search name, PAN, phone, code, email…"
        value={q} onChange={(e) => setQ(e.target.value)}
      />

      {isLoading ? <div className="text-text-muted">Loading customers…</div> : (
        <DataTable
          columns={columns}
          rows={data!.rows}
          rowKey={(c) => c.id}
          defaultSort={{ key: 'customer_code', dir: 'desc' }}
          empty={query ? 'No matches.' : 'No customers yet — enrol one or convert a lead.'}
        />
      )}
    </div>
  );
}
