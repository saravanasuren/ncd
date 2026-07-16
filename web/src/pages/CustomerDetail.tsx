import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api/client.js';
import { useAuth } from '../auth/AuthContext.js';

/** Customer 360 (docs/05 §5) — profile + bank accounts + KYC + hand-off. */
export function CustomerDetailPage() {
  const { id } = useParams();
  const qc = useQueryClient();
  const { can } = useAuth();
  const [bank, setBank] = useState({ account_number: '', ifsc: '' });
  const [msg, setMsg] = useState('');

  const key = ['customer', id];
  const { data, isLoading, error } = useQuery({ queryKey: key, queryFn: () => api.get<any>(`/api/customers/${id}`) });

  const invalidate = () => qc.invalidateQueries({ queryKey: key });
  const wrap = (p: Promise<unknown>) => p.then(() => { setMsg(''); invalidate(); }).catch((e) => setMsg(e instanceof ApiError ? e.message : 'Failed'));

  const addBank = useMutation({ mutationFn: () => api.post(`/api/customers/${id}/bank-accounts`, bank), onSuccess: () => { setBank({ account_number: '', ifsc: '' }); invalidate(); }, onError: (e) => setMsg(e instanceof ApiError ? e.message : 'Failed') });

  if (isLoading) return <div className="text-text-muted">Loading…</div>;
  if (error) return <div className="text-danger">Customer not found or out of scope.</div>;

  const c = data.customer;
  const inp = 'px-2.5 py-1.5 text-sm border border-border-strong rounded outline-none focus:border-primary';
  const card = 'bg-surface border border-border rounded-lg shadow-card p-5 mb-4';

  return (
    <div className="max-w-3xl">
      <Link to="/app/customers" className="text-xs text-text-muted hover:text-primary">← Customers</Link>
      <div className="flex items-center gap-3 mt-1">
        <h1 className="text-xl font-bold tracking-tight m-0">{c.full_name}</h1>
        <span className="font-mono text-xs text-text-muted">{c.customer_code}</span>
        <span className="text-xs rounded px-1.5 py-0.5 bg-bg">{c.creation_status}</span>
      </div>
      {msg && <div className="text-xs text-danger mt-2">{msg}</div>}

      <div className={`${card} mt-4`}>
        <h2 className="text-xs font-semibold text-text-label uppercase tracking-wide mb-3">Profile</h2>
        <dl className="grid grid-cols-2 gap-y-2 text-sm">
          <Field label="Phone" value={c.phone} /><Field label="District" value={c.district} />
          <Field label="KYC" value={c.kyc_status} /><Field label="Active" value={c.is_active ? 'Yes' : 'No'} />
          <Field label="PAN" value={c.pan} /><Field label="Email" value={c.email} />
        </dl>
        <div className="flex gap-2 mt-4">
          {can('kyc:verify') && c.kyc_status !== 'Verified' && (
            <button onClick={() => wrap(api.post(`/api/customers/${id}/kyc/verify`))} className="text-xs border border-border rounded px-3 py-1.5 hover:bg-bg">✓ Verify KYC</button>
          )}
          {can('customers:create') && c.creation_status === 'Draft' && (
            <button onClick={() => wrap(api.post(`/api/customers/${id}/submit-for-approval`))} className="text-xs bg-primary text-white rounded px-3 py-1.5 hover:bg-primary-hover">Submit for approval →</button>
          )}
        </div>
      </div>

      <div className={card}>
        <h2 className="text-xs font-semibold text-text-label uppercase tracking-wide mb-3">Bank accounts</h2>
        <div className="divide-y divide-border">
          {data.bankAccounts.map((b: any) => (
            <div key={b.id} className="py-2 flex items-center gap-3 text-sm">
              <span className="font-mono">{b.account_number}</span>
              <span className="text-text-muted">{b.ifsc}</span>
              <span className={`text-xs rounded px-1.5 py-0.5 ${b.penny_drop_status === 'Verified' ? 'bg-[color:var(--success-bg)] text-success' : 'bg-[color:var(--danger-bg)] text-danger'}`}>{b.penny_drop_status}</span>
              {b.is_active && <span className="text-xs rounded px-1.5 py-0.5 bg-[color:var(--primary-ring)] text-primary">Active</span>}
              {!b.is_active && b.penny_drop_status === 'Verified' && can('customers:update') && (
                <button onClick={() => wrap(api.post(`/api/customers/${id}/bank-accounts/${b.id}/set-active`))} className="text-xs text-primary hover:underline ml-auto">Make active</button>
              )}
            </div>
          ))}
          {data.bankAccounts.length === 0 && <div className="py-2 text-text-muted text-sm">No bank accounts yet.</div>}
        </div>
        {can('customers:update') && (
          <div className="flex gap-2 items-center mt-3">
            <input className={inp} placeholder="Account number" value={bank.account_number} onChange={(e) => setBank({ ...bank, account_number: e.target.value })} />
            <input className={inp} placeholder="IFSC" value={bank.ifsc} onChange={(e) => setBank({ ...bank, ifsc: e.target.value })} />
            <button disabled={bank.account_number.length < 4 || bank.ifsc.length < 4 || addBank.isPending} onClick={() => addBank.mutate()}
              className="text-xs bg-primary text-white rounded px-3 py-1.5 disabled:opacity-40 hover:bg-primary-hover">+ Add & verify</button>
          </div>
        )}
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: unknown }) {
  return (<><dt className="text-text-muted">{label}</dt><dd className="font-medium">{value ? String(value) : '—'}</dd></>);
}
