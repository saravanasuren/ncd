import { useParams, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { formatINR } from '@new-wealth/shared';
import { api, ApiError } from '../api/client.js';
import { useAuth } from '../auth/AuthContext.js';
import { useState } from 'react';

const rowPill: Record<string, string> = {
  Paid: 'text-success', Scheduled: 'text-text-muted', Skipped: 'text-warn', Failed: 'text-danger',
};

function PayoutAccount({ appId, customerId, onChange }: { appId: number; customerId: number; onChange: () => void }) {
  const { data } = useQuery({ queryKey: ['cust-banks', customerId], queryFn: () => api.get<any>(`/api/customers/${customerId}`) });
  const set = useMutation({ mutationFn: (bankId: number) => api.post(`/api/applications/${appId}/payout-account`, { bank_account_id: bankId }), onSuccess: onChange });
  const verified = (data?.bankAccounts ?? []).filter((b: any) => b.penny_drop_status === 'Verified');
  if (verified.length < 2) return null;
  return (
    <select className="text-xs border border-border-strong rounded px-2 py-1" defaultValue="" onChange={(e) => e.target.value && set.mutate(Number(e.target.value))}>
      <option value="">Interest account…</option>
      {verified.map((b: any) => <option key={b.id} value={b.id}>{b.account_number}</option>)}
    </select>
  );
}

/** Lifecycle actions for an Active investment: premature/maturity redemption,
 * rollover, holder transfer, transformation. Each posts and lands in approvals. */
function LifecycleActions({ appId, onDone, onError }: { appId: number; onDone: (msg: string) => void; onError: (e: unknown) => void }) {
  const [open, setOpen] = useState<'premature' | 'transfer' | 'transformation' | null>(null);
  const [reason, setReason] = useState('');
  const [date, setDate] = useState('');
  const [custQ, setCustQ] = useState('');
  const [toCustomer, setToCustomer] = useState<{ id: number; name: string } | null>(null);
  const [nominee, setNominee] = useState({ nominee_name: '', nominee_bank_name: '', nominee_account: '', nominee_ifsc: '' });

  const search = useQuery({
    queryKey: ['cust-search', custQ],
    queryFn: () => api.get<{ customers: { id: number; full_name: string; customer_code: string }[] }>(`/api/dashboard/search?q=${encodeURIComponent(custQ)}`),
    enabled: open === 'transfer' && custQ.trim().length >= 2 && !toCustomer,
  });

  const fire = (p: Promise<unknown>, msg: string) =>
    p.then(() => { setOpen(null); setReason(''); setDate(''); setToCustomer(null); setCustQ(''); onDone(msg); }).catch(onError);

  const inp = 'px-2.5 py-1.5 text-xs border border-border-strong rounded outline-none focus:border-primary';
  const act = 'text-xs border border-border rounded px-3 py-1.5 hover:bg-bg';
  const go = 'text-xs bg-primary text-white rounded px-3 py-1.5 disabled:opacity-40 hover:bg-primary-hover';

  return (
    <div className="bg-surface border border-border rounded-lg shadow-card mt-4 p-4">
      <div className="text-xs font-semibold text-text-label uppercase tracking-wide mb-2.5">Lifecycle actions</div>
      <div className="flex gap-2 flex-wrap">
        <button className={act} onClick={() => setOpen(open === 'premature' ? null : 'premature')}>Redeem early…</button>
        <button className={act} onClick={() => { if (window.confirm('Initiate maturity redemption for this investment?')) fire(api.post('/api/redemptions/maturity', { application_id: appId }), 'Maturity redemption initiated — awaiting approval.'); }}>Redeem at maturity</button>
        <button className={act} onClick={() => { if (window.confirm('Roll this investment over into a fresh one?')) fire(api.post('/api/ncd-events/rollover', { application_id: appId }), 'Rollover initiated — awaiting approval.'); }}>Rollover</button>
        <button className={act} onClick={() => setOpen(open === 'transfer' ? null : 'transfer')}>Transfer holder…</button>
        <button className={act} onClick={() => setOpen(open === 'transformation' ? null : 'transformation')}>Transformation (deceased)…</button>
      </div>

      {open === 'premature' && (
        <div className="flex gap-2 flex-wrap items-center mt-3">
          <input className={`${inp} w-64`} placeholder="Reason (required)" value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
          <input className={inp} type="date" value={date} onChange={(e) => setDate(e.target.value)} title="Redemption date (optional, default today)" />
          <button className={go} disabled={reason.trim().length < 2}
            onClick={() => fire(api.post('/api/redemptions/premature', { application_id: appId, reason, ...(date ? { redemption_date: date } : {}) }), 'Premature redemption initiated — awaiting approval.')}>Initiate</button>
        </div>
      )}

      {open === 'transfer' && (
        <div className="flex gap-2 flex-wrap items-center mt-3">
          {toCustomer ? (
            <span className="text-xs bg-bg rounded px-2 py-1.5">→ {toCustomer.name} <button className="text-text-muted hover:text-danger ml-1" onClick={() => setToCustomer(null)}>×</button></span>
          ) : (
            <span className="relative">
              <input className={`${inp} w-64`} placeholder="Search new holder (name/PAN/phone)…" value={custQ} onChange={(e) => setCustQ(e.target.value)} autoFocus />
              {(search.data?.customers ?? []).length > 0 && (
                <span className="absolute top-full left-0 right-0 mt-1 bg-surface border border-border rounded shadow-card z-10 block max-h-48 overflow-auto">
                  {search.data!.customers.map((c) => (
                    <button key={c.id} className="w-full text-left px-3 py-1.5 text-xs hover:bg-bg block" onClick={() => setToCustomer({ id: c.id, name: c.full_name })}>
                      {c.full_name} <span className="font-mono text-text-muted">{c.customer_code}</span>
                    </button>
                  ))}
                </span>
              )}
            </span>
          )}
          <input className={`${inp} w-56`} placeholder="Reason (required)" value={reason} onChange={(e) => setReason(e.target.value)} />
          <button className={go} disabled={!toCustomer || reason.trim().length < 2}
            onClick={() => fire(api.post('/api/ncd-events/transfer', { application_id: appId, to_customer_id: toCustomer!.id, reason }), 'Holder transfer initiated — awaiting approval.')}>Initiate</button>
        </div>
      )}

      {open === 'transformation' && (
        <div className="flex gap-2 flex-wrap items-center mt-3">
          <input className={`${inp} w-48`} placeholder="Nominee name (required)" value={nominee.nominee_name} onChange={(e) => setNominee({ ...nominee, nominee_name: e.target.value })} autoFocus />
          <input className={`${inp} w-36`} placeholder="Nominee bank" value={nominee.nominee_bank_name} onChange={(e) => setNominee({ ...nominee, nominee_bank_name: e.target.value })} />
          <input className={`${inp} w-40`} placeholder="Account no." value={nominee.nominee_account} onChange={(e) => setNominee({ ...nominee, nominee_account: e.target.value })} />
          <input className={`${inp} w-28`} placeholder="IFSC" value={nominee.nominee_ifsc} onChange={(e) => setNominee({ ...nominee, nominee_ifsc: e.target.value })} />
          <button className={go} disabled={!nominee.nominee_name.trim()}
            onClick={() => fire(api.post('/api/ncd-events/transformation', {
              application_id: appId,
              nominee_name: nominee.nominee_name,
              ...(nominee.nominee_bank_name ? { nominee_bank_name: nominee.nominee_bank_name } : {}),
              ...(nominee.nominee_account ? { nominee_account: nominee.nominee_account } : {}),
              ...(nominee.nominee_ifsc ? { nominee_ifsc: nominee.nominee_ifsc } : {}),
            }), 'Transformation initiated — awaiting approval.')}>Initiate</button>
        </div>
      )}
    </div>
  );
}

export function ApplicationDetailPage() {
  const { id } = useParams();
  const qc = useQueryClient();
  const { can } = useAuth();
  const [msg, setMsg] = useState('');
  const [note, setNote] = useState('');
  const key = ['application', id];
  const { data, isLoading, error } = useQuery({ queryKey: key, queryFn: () => api.get<any>(`/api/applications/${id}`) });
  const invalidate = () => qc.invalidateQueries({ queryKey: key });
  const run = (p: Promise<unknown>) => p.then(() => { setMsg(''); invalidate(); }).catch((e) => setMsg(e instanceof ApiError ? e.message : 'Failed'));

  const confirm = useMutation({ mutationFn: () => api.post(`/api/applications/${id}/confirm-collection`, { amount_received: Number(data.application.total_amount), date_money_received: new Date().toISOString().slice(0, 10), method: 'NEFT' }), onSuccess: () => { setMsg(''); invalidate(); }, onError: (e) => setMsg(e instanceof ApiError ? e.message : 'Failed') });

  if (isLoading) return <div className="text-text-muted">Loading…</div>;
  if (error) return <div className="text-danger">Application not found or out of scope.</div>;
  const a = data.application;

  return (
    <div className="max-w-4xl">
      <Link to="/app/applications" className="text-xs text-text-muted hover:text-primary">← Applications</Link>
      <div className="flex items-center gap-3 mt-1">
        <h1 className="text-xl font-bold tracking-tight m-0 font-mono">{a.application_no}</h1>
        <span className="text-xs rounded px-1.5 py-0.5 bg-bg">{a.status}</span>
      </div>
      <p className="text-sm text-text-muted mt-1">{a.customer_name} · {a.series_code} · {formatINR(a.total_amount)}</p>
      {msg && <div className="text-xs text-danger mt-2">{msg}</div>}
      {note && <div className="text-xs text-primary mt-2">{note}</div>}

      <div className="flex gap-2 mt-3 items-center flex-wrap">
        {can('applications:confirm-collection') && a.status === 'PendingFundVerification' && (
          <button onClick={() => confirm.mutate()} className="text-xs bg-primary text-white rounded px-3 py-1.5 hover:bg-primary-hover">Confirm collection</button>
        )}
        {can('applications:mark-esigned') && a.status === 'PendingEsign' && (
          <button onClick={() => run(api.post(`/api/applications/${id}/mark-esigned`))} className="text-xs bg-primary text-white rounded px-3 py-1.5 hover:bg-primary-hover">Mark eSigned</button>
        )}
        {a.receipt_file_path && <a href={`/api/applications/${id}/receipt`} target="_blank" rel="noreferrer" className="text-xs text-primary hover:underline">View receipt</a>}
        {can('applications:update') && (
          <label className="text-xs border border-border rounded px-3 py-1.5 hover:bg-bg cursor-pointer">
            {a.receipt_file_path ? 'Replace receipt…' : 'Upload receipt…'}
            <input type="file" accept="image/*,.pdf" className="hidden" onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (!file) return;
              if (file.size > 4 * 1024 * 1024) { setNote(''); setMsg('Receipt must be under 4 MB.'); return; }
              const reader = new FileReader();
              reader.onload = () => {
                const data_base64 = String(reader.result).split(',')[1] ?? '';
                run(api.post(`/api/applications/${id}/receipt`, { filename: file.name, mime: file.type || 'application/octet-stream', data_base64 }));
              };
              reader.readAsDataURL(file);
            }} />
          </label>
        )}
        {can('applications:update') && a.status === 'Active' && <PayoutAccount appId={Number(id)} customerId={a.customer_id} onChange={invalidate} />}
      </div>

      {can('redemptions:initiate') && a.status === 'Active' && (
        <LifecycleActions appId={Number(id)}
          onDone={(m) => { setMsg(''); setNote(m); invalidate(); }}
          onError={(e) => { setNote(''); setMsg(e instanceof ApiError ? e.message : 'Failed'); }} />
      )}

      <div className="bg-surface border border-border rounded-lg shadow-card mt-4 overflow-hidden">
        <div className="px-4 py-3 border-b border-border text-xs font-semibold text-text-label uppercase tracking-wide">Interest & redemption schedule</div>
        {data.schedule.length === 0 ? (
          <div className="p-6 text-center text-text-muted text-sm">Schedule is generated at allotment.</div>
        ) : (
          <table className="w-full text-sm">
            <thead><tr className="text-left text-xs font-semibold text-text-label border-b border-border">
              <th className="px-4 py-2">Due date</th><th className="px-4 py-2">Type</th>
              <th className="px-4 py-2 text-right">Gross</th><th className="px-4 py-2 text-right">TDS</th>
              <th className="px-4 py-2 text-right">Net</th><th className="px-4 py-2">Status</th></tr></thead>
            <tbody className="divide-y divide-border">
              {data.schedule.map((r: any) => (
                <tr key={r.id}>
                  <td className="px-4 py-1.5 mono">{r.due_date}</td>
                  <td className="px-4 py-1.5">{r.due_type}</td>
                  <td className="px-4 py-1.5 text-right mono">{formatINR(r.gross_amount)}</td>
                  <td className="px-4 py-1.5 text-right mono text-text-muted">{formatINR(r.tds_amount)}</td>
                  <td className="px-4 py-1.5 text-right mono">{formatINR(r.net_amount)}</td>
                  <td className={`px-4 py-1.5 text-xs ${rowPill[r.status] ?? ''}`}>
                    {r.status}
                    {can('payouts:mark-paid-manual') && r.status === 'Scheduled' && (
                      <button className="ml-2 text-danger hover:underline" title="Mark this row failed (e.g. NEFT bounce)"
                        onClick={() => {
                          const reason = window.prompt('Reason for marking this payout row failed:');
                          if (reason && reason.trim().length >= 2) run(api.post(`/api/payouts/rows/${r.id}/mark-failed`, { reason: reason.trim() }));
                        }}>mark failed</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
