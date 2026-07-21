import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from '../api/client.js';

/**
 * Staff locker enrollment (NCD_INTEGRATION_CONTRACT.md Part A). Drives the
 * recommended cash flow through the NCD app's own /api/lockers/* proxy (the
 * integration key stays server-side): branch → availability → customer
 * lookup/create → application → record rent + deposit → allotted.
 */
const inp = 'px-2.5 py-1.5 text-sm border border-border-strong rounded outline-none focus:border-primary';
const card = 'bg-surface border border-border rounded-lg shadow-card p-5 mb-4';
const h2 = 'text-xs font-semibold text-text-label uppercase tracking-wide mb-3';
const btn = 'bg-primary hover:bg-primary-hover disabled:opacity-40 text-white rounded px-4 py-1.5 text-sm font-semibold';
const btnGhost = 'text-xs border border-border rounded px-3 py-1.5 hover:bg-bg disabled:opacity-40';
const money = (n: unknown) => '₹' + Number(n ?? 0).toLocaleString('en-IN');

interface Size { size: string; annual_fee: number; rent_incl_gst: number; deposit: number; gst_pct: number; vacant_count: number }

export function LockerEnrollmentPage() {
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async <T,>(p: Promise<T>): Promise<T | undefined> => {
    setErr(''); setBusy(true);
    try { return await p; }
    catch (e) { setErr(e instanceof ApiError ? `${e.message}${e.detail ? ' — ' + JSON.stringify(e.detail) : ''}` : 'Failed'); }
    finally { setBusy(false); }
  };

  const branches = useQuery({ queryKey: ['locker-branches'], queryFn: () => api.get<{ branches: { id: string; name: string; address?: string }[] }>('/api/lockers/branches') });
  const [branchId, setBranchId] = useState('');
  const avail = useQuery({
    queryKey: ['locker-availability', branchId],
    queryFn: () => api.get<{ sizes: Size[] }>(`/api/lockers/availability?branch_id=${encodeURIComponent(branchId)}`),
    enabled: !!branchId,
  });
  const [size, setSize] = useState('');

  // Customer
  const [phone, setPhone] = useState('');
  const [cust, setCust] = useState<any | null>(null);      // lookup result
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');

  // Application + payments
  const [app, setApp] = useState<any | null>(null);        // created/fetched application
  const [method, setMethod] = useState<'cash' | 'cheque' | 'bank_transfer'>('cash');
  const [ref, setRef] = useState('');

  const lookup = async () => {
    const r = await run(api.get<any>(`/api/lockers/customers/${encodeURIComponent(phone)}`));
    if (r) { setCust(r); if (r.found && r.profile) { setName(r.profile.name ?? ''); setEmail(r.profile.email ?? ''); } }
  };
  const saveCustomer = async () => {
    const r = await run(api.post<any>('/api/lockers/customers', { phone, name, email: email || undefined }));
    if (r?.success) setCust({ found: true, phone, profile: { name, email } });
  };
  const createApp = async () => {
    const r = await run(api.post<any>('/api/lockers/applications', { phone, name: name || undefined, email: email || undefined, branch_id: branchId, locker_size: size }));
    if (r?.application_id) setApp(r);
  };
  const refreshApp = async () => {
    if (!app?.application_id) return;
    const r = await run(api.get<any>(`/api/lockers/applications/${encodeURIComponent(app.application_id)}`));
    if (r) setApp((a: any) => ({ ...a, ...r }));
  };
  const recordPayment = async (leg: 'rent' | 'deposit') => {
    const r = await run(api.post<any>(`/api/lockers/applications/${encodeURIComponent(app.application_id)}/record-payment`, { leg, method, reference: ref || undefined }));
    if (r) { setRef(''); await refreshApp(); }
  };
  const allocate = async () => { await run(api.post(`/api/lockers/applications/${encodeURIComponent(app.application_id)}/allocate`, {})); await refreshApp(); };

  const legState = (leg: string) => app?.legs?.[leg];
  const allotment = app?.allotment ?? (app?.pricing ? null : undefined);
  const chosen = (avail.data?.sizes ?? []).find((s) => s.size === size);

  return (
    <div className="w-full max-w-3xl">
      <h1 className="text-xl font-bold tracking-tight m-0">Locker enrollment</h1>
      <p className="text-sm text-text-muted mt-1 mb-4">Enroll a customer for a locker end-to-end. Pricing and allotment are handled by LockerHub; a locker is allotted automatically once rent and deposit are both settled.</p>
      {err && <div className="text-xs text-danger bg-[color:var(--danger-bg)] rounded px-3 py-2 mb-3">{err}</div>}

      {/* 1 — Branch + size */}
      <div className={card}>
        <h2 className={h2}>1 · Branch &amp; locker size</h2>
        <div className="flex flex-wrap gap-2 items-center">
          <select className={inp} value={branchId} onChange={(e) => { setBranchId(e.target.value); setSize(''); setApp(null); }}>
            <option value="">Branch…</option>
            {(branches.data?.branches ?? []).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
          <select className={inp} value={size} disabled={!branchId || avail.isLoading} onChange={(e) => { setSize(e.target.value); setApp(null); }}>
            <option value="">{avail.isLoading ? 'Loading…' : 'Size…'}</option>
            {(avail.data?.sizes ?? []).map((s) => <option key={s.size} value={s.size} disabled={s.vacant_count <= 0}>{s.size} · {money(s.rent_incl_gst)} rent · {money(s.deposit)} deposit · {s.vacant_count} vacant</option>)}
          </select>
        </div>
        {chosen && (
          <div className="text-xs text-text-muted mt-2">Rent (incl. GST {chosen.gst_pct}%): <b className="text-text">{money(chosen.rent_incl_gst)}</b> · Deposit: <b className="text-text">{money(chosen.deposit)}</b></div>
        )}
      </div>

      {/* 2 — Customer */}
      {branchId && size && (
        <div className={card}>
          <h2 className={h2}>2 · Customer</h2>
          <div className="flex flex-wrap gap-2 items-center">
            <input className={inp} placeholder="Phone (10 digits)" value={phone} maxLength={10} onChange={(e) => { setPhone(e.target.value.replace(/\D/g, '')); setCust(null); }} />
            <button className={btnGhost} disabled={phone.length < 10 || busy} onClick={lookup}>Look up</button>
          </div>
          {cust && (
            <div className="mt-3 grid grid-cols-2 gap-2 max-w-lg">
              <input className={inp} placeholder="Full name" value={name} onChange={(e) => setName(e.target.value)} />
              <input className={inp} placeholder="Email (optional)" value={email} onChange={(e) => setEmail(e.target.value)} />
              <div className="col-span-2 flex items-center gap-2">
                <span className={`text-xs rounded px-1.5 py-0.5 ${cust.found ? 'bg-[color:var(--success-bg)] text-success' : 'bg-bg text-text-muted'}`}>{cust.found ? 'Existing customer' : 'New — will be created'}</span>
                {!cust.found && <button className={btnGhost} disabled={!name.trim() || busy} onClick={saveCustomer}>Save customer</button>}
              </div>
            </div>
          )}
        </div>
      )}

      {/* 3 — Application */}
      {cust && (
        <div className={card}>
          <h2 className={h2}>3 · Locker application</h2>
          {!app ? (
            <button className={btn} disabled={!name.trim() || busy} onClick={createApp}>Create application</button>
          ) : (
            <div className="text-sm">
              <div className="flex items-center gap-2 mb-2">
                <span className="font-mono text-xs">{app.application_no ?? app.application_id}</span>
                <span className="text-xs rounded px-1.5 py-0.5 bg-bg">{app.status}</span>
                <button className={`${btnGhost} ml-auto`} disabled={busy} onClick={refreshApp}>Refresh</button>
              </div>
              {app.pricing && <div className="text-xs text-text-muted">Rent {money(app.pricing.rent_incl_gst)} · Deposit {money(app.pricing.deposit)}</div>}
            </div>
          )}
        </div>
      )}

      {/* 4 — Payments */}
      {app?.application_id && app.status !== 'approved' && !allotment && (
        <div className={card}>
          <h2 className={h2}>4 · Record payments (cash / cheque / transfer)</h2>
          <div className="flex flex-wrap gap-2 items-center mb-3">
            <select className={inp} value={method} onChange={(e) => setMethod(e.target.value as any)}>
              <option value="cash">Cash</option><option value="cheque">Cheque</option><option value="bank_transfer">Bank transfer</option>
            </select>
            <input className={inp} placeholder={method === 'cash' ? 'Reference (optional)' : 'Cheque no. / UTR (required)'} value={ref} onChange={(e) => setRef(e.target.value)} />
          </div>
          <div className="flex gap-2">
            {(['rent', 'deposit'] as const).map((leg) => {
              const st = legState(leg);
              const settled = st?.settled === true;
              return (
                <button key={leg} className={btnGhost} disabled={busy || settled || (method !== 'cash' && !ref.trim())} onClick={() => recordPayment(leg)}>
                  {settled ? `✓ ${leg} settled` : `Record ${leg}${st?.amount ? ' · ' + money(st.amount) : ''}`}
                </button>
              );
            })}
          </div>
          <p className="text-xs text-text-muted mt-2">The locker auto-allots once both legs are settled.</p>
        </div>
      )}

      {/* 5 — Allotment */}
      {app && (app.status === 'approved' || app.allotment) && (
        <div className={`${card} border-success`}>
          <h2 className={h2}>✓ Allotted</h2>
          {app.allotment ? (
            <div className="text-sm">Locker <b>{app.allotment.locker_number}</b> ({app.allotment.size}) · lease {String(app.allotment.lease_start).slice(0, 10)} → {String(app.allotment.lease_end).slice(0, 10)}</div>
          ) : (
            <div className="text-sm flex items-center gap-2">Payments settled — allotment pending. <button className={btnGhost} disabled={busy} onClick={allocate}>Allocate locker</button></div>
          )}
        </div>
      )}
    </div>
  );
}
