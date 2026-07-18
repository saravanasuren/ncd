import { useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { formatINR } from '@new-wealth/shared';
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
  const [panel, setPanel] = useState<'correction' | 'handover' | null>(null);
  const [corr, setCorr] = useState<Record<string, string>>({});
  const [corrReason, setCorrReason] = useState('');
  const [handoverTo, setHandoverTo] = useState('');
  const [handoverReason, setHandoverReason] = useState('');

  const key = ['customer', id];
  const { data, isLoading, error } = useQuery({ queryKey: key, queryFn: () => api.get<any>(`/api/customers/${id}`) });
  const staff = useQuery({
    queryKey: ['assignable-staff'],
    queryFn: () => api.get<{ rows: { id: number; full_name: string; role: string }[] }>('/api/customers/assignable-staff'),
    enabled: can('customers:handover-request'),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: key });
  const wrap = (p: Promise<unknown>) => p.then(() => { setMsg(''); invalidate(); }).catch((e) => setMsg(e instanceof ApiError ? e.message : 'Failed'));

  const addBank = useMutation({ mutationFn: () => api.post(`/api/customers/${id}/bank-accounts`, bank), onSuccess: () => { setBank({ account_number: '', ifsc: '' }); invalidate(); }, onError: (e) => setMsg(e instanceof ApiError ? e.message : 'Failed') });

  if (isLoading) return <div className="text-text-muted">Loading…</div>;
  if (error) return <div className="text-danger">Customer not found or out of scope.</div>;

  const c = data.customer;
  const inp = 'px-2.5 py-1.5 text-sm border border-border-strong rounded outline-none focus:border-primary';
  const card = 'bg-surface border border-border rounded-lg shadow-card p-5 mb-4';

  return (
    <div className="w-full">
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
          {can('customers:correction-request') && c.creation_status !== 'Draft' && (
            <button onClick={() => setPanel(panel === 'correction' ? null : 'correction')} className="text-xs border border-border rounded px-3 py-1.5 hover:bg-bg">Request correction</button>
          )}
          {can('customers:handover-request') && (
            <button onClick={() => setPanel(panel === 'handover' ? null : 'handover')} className="text-xs border border-border rounded px-3 py-1.5 hover:bg-bg">Request handover</button>
          )}
        </div>

        {panel === 'correction' && (
          <div className="mt-4 border-t border-border pt-4">
            <div className="text-xs font-semibold text-text-label uppercase tracking-wide mb-2">Correction request (needs approval)</div>
            <div className="grid grid-cols-2 gap-2 max-w-xl">
              {(['full_name', 'phone', 'email', 'district', 'pan'] as const).map((f) => (
                <label key={f} className="text-xs text-text-muted">
                  {f}
                  <input className={`${inp} w-full mt-1`} defaultValue={c[f] ?? ''}
                    onChange={(e) => setCorr((s) => ({ ...s, [f]: e.target.value }))} />
                </label>
              ))}
              <label className="text-xs text-text-muted col-span-2">
                Reason
                <input className={`${inp} w-full mt-1`} value={corrReason} onChange={(e) => setCorrReason(e.target.value)} placeholder="Why is this correction needed?" />
              </label>
            </div>
            <button
              disabled={corrReason.trim().length < 2}
              onClick={() => {
                const changes: Record<string, string> = {};
                for (const [k, v] of Object.entries(corr)) if (v !== (c[k] ?? '')) changes[k] = v;
                if (!Object.keys(changes).length) { setMsg('No fields changed.'); return; }
                wrap(api.post(`/api/customers/${id}/correction-request`, { changes, reason: corrReason.trim() }).then(() => { setPanel(null); setCorr({}); setCorrReason(''); }));
              }}
              className="mt-3 text-xs bg-primary text-white rounded px-4 py-1.5 disabled:opacity-40 hover:bg-primary-hover">Submit correction</button>
          </div>
        )}

        {panel === 'handover' && (
          <div className="mt-4 border-t border-border pt-4">
            <div className="text-xs font-semibold text-text-label uppercase tracking-wide mb-2">Handover request (needs approval)</div>
            <div className="flex flex-wrap gap-2 items-center">
              <select className={inp} value={handoverTo} onChange={(e) => setHandoverTo(e.target.value)}>
                <option value="">Hand over to…</option>
                {(staff.data?.rows ?? []).map((u) => <option key={u.id} value={u.id}>{u.full_name} ({u.role})</option>)}
              </select>
              <input className={`${inp} w-64`} value={handoverReason} onChange={(e) => setHandoverReason(e.target.value)} placeholder="Reason" />
              <button disabled={!handoverTo || handoverReason.trim().length < 2}
                onClick={() => wrap(api.post(`/api/customers/${id}/handover-request`, { toUserId: Number(handoverTo), reason: handoverReason.trim() }).then(() => { setPanel(null); setHandoverTo(''); setHandoverReason(''); }))}
                className="text-xs bg-primary text-white rounded px-4 py-1.5 disabled:opacity-40 hover:bg-primary-hover">Submit handover</button>
            </div>
          </div>
        )}
      </div>

      <InvestmentsCard rows={data.applications ?? []} />

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

const appPill: Record<string, string> = {
  Active: 'bg-[color:var(--success-bg)] text-success',
  Redeemed: 'bg-bg text-text-muted', Matured: 'bg-bg text-text-muted',
  Rejected: 'bg-[color:var(--danger-bg)] text-danger', Cancelled: 'bg-[color:var(--danger-bg)] text-danger',
};

/** The customer's investments — every application, newest first, linking to the
 * application page. LIVE statuses total into the header line. */
function InvestmentsCard({ rows }: { rows: any[] }) {
  const nav = useNavigate();
  const DEAD = ['Rejected', 'Cancelled', 'Redeemed', 'Matured', 'RolledOver', 'PrematureWithdrawn', 'Transferred'];
  const live = rows.filter((r) => !DEAD.includes(r.status));
  const outstanding = live.reduce((s, r) => s + Number(r.outstanding ?? 0), 0);
  const th = 'py-2 px-3 text-xs font-semibold text-text-label uppercase tracking-wide text-left';
  const td = 'py-2 px-3 align-middle';
  return (
    <div className="bg-surface border border-border rounded-lg shadow-card p-5 mb-4">
      <h2 className="text-xs font-semibold text-text-label uppercase tracking-wide mb-1">Investments</h2>
      {rows.length === 0 ? (
        <div className="py-2 text-text-muted text-sm">No investments yet.</div>
      ) : (
        <>
          <div className="text-xs text-text-muted mb-2">
            {live.length} live · outstanding <span className="font-semibold text-text">{formatINR(outstanding)}</span>
            {rows.length > live.length ? ` · ${rows.length - live.length} closed` : ''}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="border-b border-border">
                  <th className={th}>Series</th><th className={th}>App no</th>
                  <th className={th}>Status</th><th className={th}>Received</th>
                  <th className={`${th} text-right`}>Invested</th><th className={`${th} text-right`}>Outstanding</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b border-border last:border-0 hover:bg-bg cursor-pointer" onClick={() => nav(`/app/applications/${r.id}`)}>
                    <td className={td}>{r.series_code}</td>
                    <td className={`${td} font-mono text-xs whitespace-nowrap`}>{r.application_no}</td>
                    <td className={td}><span className={`text-[11px] rounded px-1.5 py-0.5 ${appPill[r.status] ?? 'bg-[color:var(--warn-bg)] text-warn'}`}>{r.status}</span></td>
                    <td className={`${td} text-xs whitespace-nowrap`}>{r.date_money_received ? String(r.date_money_received).slice(0, 10) : '—'}</td>
                    <td className={`${td} text-right mono`}>{formatINR(r.amount)}</td>
                    <td className={`${td} text-right mono font-medium`}>{formatINR(r.outstanding ?? 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
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
    const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/*,.pdf';
    inp.onchange = () => {
      const file = inp.files?.[0]; if (!file) return;
      if (file.size > 4 * 1024 * 1024) { setMsg('Document must be under 4 MB.'); return; }
      const reader = new FileReader();
      reader.onload = () => {
        const data_base64 = String(reader.result).split(',')[1] ?? '';
        void wrap(api.post(`/api/customers/${customerId}/documents`, { doc_type: 'KYC', filename: file.name, mime: file.type || 'application/octet-stream', data_base64 }));
      };
      reader.readAsDataURL(file);
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
  const [clubWith, setClubWith] = useState('');
  const [lockerDeposit, setLockerDeposit] = useState(false);
  const [err, setErr] = useState('');
  const series = useQuery({ queryKey: ['series'], queryFn: () => api.get<{ rows: any[] }>('/api/series') });
  const schemes = useQuery({ queryKey: ['schemes'], queryFn: () => api.get<{ rows: any[] }>('/api/schemes') });
  // In-flight applications in the chosen series this new line could club into
  // (append to an existing pre-allotment application instead of a new one).
  const candidates = useQuery({
    queryKey: ['clubbing', customerId, seriesId],
    queryFn: () => api.get<{ rows: any[] }>(`/api/applications/clubbing-candidates?customer_id=${customerId}&series_id=${seriesId}`),
    enabled: !!seriesId,
  });
  const create = useMutation({
    mutationFn: () => api.post<{ id: number }>('/api/applications', {
      customer_id: customerId, series_id: Number(seriesId), scheme_id: Number(schemeId), amount: Number(amount),
      ...(clubWith ? { club_with_application_id: Number(clubWith) } : {}),
      ...(lockerDeposit ? { is_locker_deposit: true } : {}),
    }),
    onSuccess: (r) => nav(`/app/applications/${r.id}`),
    onError: (e) => setErr(e instanceof ApiError ? e.message : 'Failed'),
  });
  const sel = 'px-2.5 py-1.5 text-sm border border-border-strong rounded outline-none focus:border-primary';
  const clubOptions = candidates.data?.rows ?? [];
  return (
    <div className="bg-surface border border-border rounded-lg shadow-card p-5 mb-4">
      <h2 className="text-xs font-semibold text-text-label uppercase tracking-wide mb-3">New investment</h2>
      <div className="flex flex-wrap gap-2 items-center">
        <select className={sel} value={seriesId} onChange={(e) => { setSeriesId(e.target.value); setClubWith(''); }}>
          <option value="">Series…</option>
          {(series.data?.rows ?? []).map((s) => <option key={s.id} value={s.id}>{s.code}</option>)}
        </select>
        <select className={sel} value={schemeId} onChange={(e) => setSchemeId(e.target.value)}>
          <option value="">Scheme…</option>
          {(schemes.data?.rows ?? []).map((s) => <option key={s.id} value={s.id}>{s.code} ({s.coupon_rate_pct}%)</option>)}
        </select>
        <input className={sel} placeholder="Amount" type="number" value={amount} onChange={(e) => setAmount(e.target.value)} />
        <label className="text-xs flex items-center gap-1.5" title="Money came from a locker (LockerHub-originated deposits flag themselves automatically)">
          <input type="checkbox" checked={lockerDeposit} onChange={(e) => setLockerDeposit(e.target.checked)} /> Locker deposit
        </label>
        <button disabled={!seriesId || !schemeId || !amount || create.isPending} onClick={() => { setErr(''); create.mutate(); }}
          className="text-xs bg-primary text-white rounded px-4 py-1.5 disabled:opacity-40 hover:bg-primary-hover">
          {clubWith ? 'Add to application' : 'Create investment'}
        </button>
      </div>
      {clubOptions.length > 0 && (
        <label className="flex items-center gap-2 text-xs text-text-muted mt-3">
          Club into an in-flight application:
          <select className={sel} value={clubWith} onChange={(e) => setClubWith(e.target.value)}>
            <option value="">— new application —</option>
            {clubOptions.map((a) => <option key={a.id} value={a.id}>{a.application_no} (₹{Number(a.total_amount).toLocaleString('en-IN')}, {a.status})</option>)}
          </select>
        </label>
      )}
      {err && <div className="text-xs text-danger mt-2">{err}</div>}
    </div>
  );
}

function Field({ label, value }: { label: string; value: unknown }) {
  return (<><dt className="text-text-muted">{label}</dt><dd className="font-medium">{value ? String(value) : '—'}</dd></>);
}
