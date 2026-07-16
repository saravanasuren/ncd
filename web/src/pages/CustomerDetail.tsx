import { useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
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
          {can('kyc:reject') && c.kyc_status !== 'Rejected' && (
            <button onClick={() => {
              const reason = window.prompt('Reason for rejecting KYC:');
              if (reason && reason.trim().length >= 2) wrap(api.post(`/api/customers/${id}/kyc/reject`, { reason: reason.trim() }));
            }} className="text-xs border border-border text-danger rounded px-3 py-1.5 hover:bg-[color:var(--danger-bg)]">✗ Reject KYC</button>
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

      <RelationsKyc customerId={Number(id)} data={data} onChange={invalidate} can={can} />

      {can('applications:create') && c.creation_status === 'Approved' && <NewInvestment customerId={Number(id)} />}
    </div>
  );
}

function RelationsKyc({ customerId, data, onChange, can }: { customerId: number; data: any; onChange: () => void; can: (...p: any[]) => boolean }) {
  const [msg, setMsg] = useState('');
  const wrap = (p: Promise<unknown>) => p.then(() => { setMsg(''); onChange(); }).catch((e) => setMsg(e instanceof ApiError ? e.message : 'Failed'));
  const card = 'bg-surface border border-border rounded-lg shadow-card p-5 mb-4';

  async function addNominee() {
    const name = window.prompt('Nominee full name'); if (!name) return;
    const share = Number(window.prompt('Share % (e.g. 100)') ?? '0');
    const existing = (data.nominees ?? []).map((n: any) => ({ full_name: n.full_name, relationship: n.relationship, share_pct: Number(n.share_pct) }));
    await wrap(api.put(`/api/customers/${customerId}/nominees`, { nominees: [...existing, { full_name: name, share_pct: share }] }));
  }
  async function addJoint() {
    const name = window.prompt('Joint holder full name'); if (!name) return;
    const existing = (data.jointHolders ?? []).map((h: any) => ({ full_name: h.full_name, relationship: h.relationship, pan: h.pan, phone: h.phone }));
    await wrap(api.put(`/api/customers/${customerId}/joint-holders`, { holders: [...existing, { full_name: name }] }));
  }
  async function uploadDoc() {
    const inp = document.createElement('input'); inp.type = 'file';
    inp.onchange = async () => {
      const file = inp.files?.[0]; if (!file) return;
      const b64 = btoa(String.fromCharCode(...new Uint8Array(await file.arrayBuffer())));
      await wrap(api.post(`/api/customers/${customerId}/documents`, { doc_type: 'KYC', filename: file.name, mime: file.type || 'application/octet-stream', data_base64: b64 }));
    };
    inp.click();
  }

  return (
    <div className={card}>
      <h2 className="text-xs font-semibold text-text-label uppercase tracking-wide mb-3">Relations & KYC</h2>
      {msg && <div className="text-xs text-danger mb-2">{msg}</div>}
      <div className="grid grid-cols-2 gap-4 text-sm">
        <div>
          <div className="flex items-center justify-between"><span className="font-semibold">Nominees</span>{can('customers:update') && <button onClick={addNominee} className="text-xs text-primary hover:underline">+ Add</button>}</div>
          <ul className="mt-1 text-text-muted">{(data.nominees ?? []).map((n: any) => <li key={n.id}>{n.full_name} — {Number(n.share_pct) || 0}%</li>)}{!(data.nominees ?? []).length && <li>None</li>}</ul>
        </div>
        <div>
          <div className="flex items-center justify-between"><span className="font-semibold">Joint holders</span>{can('customers:update') && <button onClick={addJoint} className="text-xs text-primary hover:underline">+ Add</button>}</div>
          <ul className="mt-1 text-text-muted">{(data.jointHolders ?? []).map((h: any) => <li key={h.id}>{h.full_name}</li>)}{!(data.jointHolders ?? []).length && <li>None</li>}</ul>
        </div>
      </div>
      <div className="mt-3">
        <div className="flex items-center justify-between"><span className="font-semibold text-sm">Documents</span>{can('customers:update') && <button onClick={uploadDoc} className="text-xs text-primary hover:underline">+ Upload</button>}</div>
        <ul className="mt-1 text-text-muted text-sm">{(data.documents ?? []).map((d: any) => <li key={d.id}><a href={`/api/customers/${customerId}/documents/${d.id}`} target="_blank" rel="noreferrer" className="text-primary hover:underline">{d.doc_type} — {d.original_filename ?? d.id}</a> <span className="text-xs">({d.origin})</span></li>)}{!(data.documents ?? []).length && <li>None</li>}</ul>
      </div>
      <div className="flex gap-2 mt-4">
        {can('kyc:verify') && <button onClick={() => wrap(api.post(`/api/customers/${customerId}/kyc/digilocker/start`).then(() => api.post(`/api/customers/${customerId}/kyc/digilocker/complete`)))} className="text-xs border border-border rounded px-3 py-1.5 hover:bg-bg">DigiLocker verify</button>}
        {can('customers:deactivate') && !data.customer.is_deceased && <button onClick={() => { const d = window.prompt('Deceased date (YYYY-MM-DD)'); if (d) wrap(api.post(`/api/customers/${customerId}/deceased`, { deceased_date: d })); }} className="text-xs border border-border rounded px-3 py-1.5 hover:bg-bg text-danger">Mark deceased</button>}
      </div>
    </div>
  );
}

function NewInvestment({ customerId }: { customerId: number }) {
  const nav = useNavigate();
  const [seriesId, setSeriesId] = useState('');
  const [schemeId, setSchemeId] = useState('');
  const [amount, setAmount] = useState('');
  const [err, setErr] = useState('');
  const series = useQuery({ queryKey: ['series'], queryFn: () => api.get<{ rows: any[] }>('/api/series') });
  const schemes = useQuery({ queryKey: ['schemes'], queryFn: () => api.get<{ rows: any[] }>('/api/schemes') });
  const create = useMutation({
    mutationFn: () => api.post<{ id: number }>('/api/applications', { customer_id: customerId, series_id: Number(seriesId), scheme_id: Number(schemeId), amount: Number(amount) }),
    onSuccess: (r) => nav(`/app/applications/${r.id}`),
    onError: (e) => setErr(e instanceof ApiError ? e.message : 'Failed'),
  });
  const sel = 'px-2.5 py-1.5 text-sm border border-border-strong rounded outline-none focus:border-primary';
  return (
    <div className="bg-surface border border-border rounded-lg shadow-card p-5 mb-4">
      <h2 className="text-xs font-semibold text-text-label uppercase tracking-wide mb-3">New investment</h2>
      <div className="flex flex-wrap gap-2 items-center">
        <select className={sel} value={seriesId} onChange={(e) => setSeriesId(e.target.value)}>
          <option value="">Series…</option>
          {(series.data?.rows ?? []).map((s) => <option key={s.id} value={s.id}>{s.code}</option>)}
        </select>
        <select className={sel} value={schemeId} onChange={(e) => setSchemeId(e.target.value)}>
          <option value="">Scheme…</option>
          {(schemes.data?.rows ?? []).map((s) => <option key={s.id} value={s.id}>{s.code} ({s.coupon_rate_pct}%)</option>)}
        </select>
        <input className={sel} placeholder="Amount" type="number" value={amount} onChange={(e) => setAmount(e.target.value)} />
        <button disabled={!seriesId || !schemeId || !amount || create.isPending} onClick={() => { setErr(''); create.mutate(); }}
          className="text-xs bg-primary text-white rounded px-4 py-1.5 disabled:opacity-40 hover:bg-primary-hover">Create investment</button>
      </div>
      {err && <div className="text-xs text-danger mt-2">{err}</div>}
    </div>
  );
}

function Field({ label, value }: { label: string; value: unknown }) {
  return (<><dt className="text-text-muted">{label}</dt><dd className="font-medium">{value ? String(value) : '—'}</dd></>);
}
