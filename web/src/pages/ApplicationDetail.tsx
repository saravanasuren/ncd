import { useParams, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { formatINR } from '@new-wealth/shared';
import { api, ApiError } from '../api/client.js';
import { useAuth } from '../auth/AuthContext.js';
import { useState } from 'react';

const rowPill: Record<string, string> = {
  Paid: 'text-success', Scheduled: 'text-text-muted', Skipped: 'text-warn', Failed: 'text-danger',
};

/**
 * Which bank account THIS NCD's interest goes to.
 *
 * Only worth showing when the customer has more than one account on file —
 * with a single account there is nothing to choose. Unpinned, the NCD follows
 * whichever account is the customer's active one, so the empty option says so
 * rather than reading like a blank.
 */
function PayoutAccount({ appId, customerId, current, onChange }: { appId: number; customerId: number; current: number | null; onChange: () => void }) {
  const { data } = useQuery({ queryKey: ['cust-banks', customerId], queryFn: () => api.get<any>(`/api/customers/${customerId}`) });
  const set = useMutation({ mutationFn: (bankId: number | null) => api.post(`/api/applications/${appId}/payout-account`, { bank_account_id: bankId }), onSuccess: onChange });
  const accounts = data?.bankAccounts ?? [];
  if (accounts.length < 2) return null;

  const label = (b: any) =>
    `${b.account_number}${b.bank_name ? ` · ${b.bank_name}` : ''}${b.penny_drop_status === 'Verified' ? '' : ` (${b.penny_drop_status})`}`;
  const active = accounts.find((b: any) => b.is_active);

  return (
    <select
      className="text-xs border border-border-strong rounded px-2 py-1 max-w-[320px]"
      value={current ?? ''}
      onChange={(e) => {
        const id = e.target.value ? Number(e.target.value) : null;
        const chosen = accounts.find((b: any) => Number(b.id) === id);
        if (chosen && chosen.penny_drop_status !== 'Verified'
            && !window.confirm(`${chosen.account_number} has not been penny-drop verified (${chosen.penny_drop_status}). Send this NCD's interest there anyway?`)) return;
        set.mutate(id);
      }}
    >
      <option value="">Customer default{active ? ` (${active.account_number})` : ''}</option>
      {accounts.map((b: any) => <option key={b.id} value={b.id}>{label(b)}</option>)}
    </select>
  );
}

/** Lifecycle actions for an Active investment: premature/maturity redemption,
 * rollover, holder transfer, transformation. Each posts and lands in approvals. */
function LifecycleActions({ appId, locker, onDone, onError }: { appId: number; locker?: { redeemable: number; linked_to_lockers: number } | null; onDone: (msg: string) => void; onError: (e: unknown) => void }) {
  const [open, setOpen] = useState<'premature' | 'transfer' | 'transformation' | null>(null);
  const [reason, setReason] = useState('');
  const [amount, setAmount] = useState('');
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
    p.then(() => { setOpen(null); setReason(''); setAmount(''); setDate(''); setToCustomer(null); setCustQ(''); onDone(msg); }).catch(onError);

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
        <div className="mt-3">
          <div className="flex gap-2 flex-wrap items-center">
            <input className={`${inp} w-64`} placeholder="Reason (required)" value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
            <input className={`${inp} w-44`} type="number" min="1" placeholder="Amount (blank = all)" value={amount} onChange={(e) => setAmount(e.target.value)}
              title="Partial withdrawal — leave blank to redeem everything redeemable" />
            <input className={inp} type="date" value={date} onChange={(e) => setDate(e.target.value)} title="Redemption date (optional, default today)" />
            <button className={go} disabled={reason.trim().length < 2 || (amount !== '' && !(Number(amount) > 0))}
              onClick={() => fire(api.post('/api/redemptions/premature', {
                application_id: appId, reason,
                ...(amount ? { amount: Number(amount) } : {}),
                ...(date ? { redemption_date: date } : {}),
              }), 'Premature redemption initiated — awaiting approval.')}>Initiate</button>
          </div>
          {/* A pledged investment can only redeem its free portion — the rest secures a locker. */}
          {locker && locker.linked_to_lockers > 0 && (
            <div className="text-xs text-text-muted mt-2">
              {formatINR(locker.linked_to_lockers)} is pledged to a live locker deposit and cannot be redeemed.
              Redeemable now: <b>{formatINR(locker.redeemable)}</b>. Leave the amount blank to redeem all of it and keep the locker live.
            </div>
          )}
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
  // While a signature is out with the customer, re-check every 15s so the page
  // flips to eSigned on its own — no webhook, no manual "Mark eSigned".
  const { data, isLoading, error } = useQuery({
    queryKey: key,
    queryFn: () => api.get<any>(`/api/applications/${id}`),
    refetchInterval: (q) => (q.state.data?.esign_pending ? 15_000 : false),
  });
  const invalidate = () => qc.invalidateQueries({ queryKey: key });
  const run = (p: Promise<unknown>) => p.then(() => { setMsg(''); invalidate(); }).catch((e) => setMsg(e instanceof ApiError ? e.message : 'Failed'));

  if (isLoading) return <div className="text-text-muted">Loading…</div>;
  if (error) return <div className="text-danger">Application not found or out of scope.</div>;
  const a = data.application;

  return (
    <div className="w-full">
      <Link to="/app/applications" className="text-xs text-text-muted hover:text-primary">← Applications</Link>
      <div className="flex items-center gap-3 mt-1">
        <h1 className="text-xl font-bold tracking-tight m-0 font-mono">{a.application_no}</h1>
        <span className="text-xs rounded px-1.5 py-0.5 bg-bg">{a.status}</span>
      </div>
      <p className="text-sm text-text-muted mt-1">{a.customer_name} · {a.series_code} · {formatINR(a.total_amount)}</p>
      {msg && <div className="text-xs text-danger mt-2">{msg}</div>}
      {note && <div className="text-xs text-primary mt-2">{note}</div>}

      <div className="flex gap-2 mt-3 items-center flex-wrap">
        {a.status === 'PendingApproval' && (
          <span className="text-xs text-text-muted">Awaiting investment approval — approve in Approvals to take it live.</span>
        )}
        {can('applications:mark-esigned') && !a.esigned_at && ['PendingActivation', 'PendingEsign', 'Active'].includes(a.status) && (
          <>
            <button onClick={() => {
              run(api.post<{ sign_url: string | null; stub: boolean }>(`/api/applications/${id}/esign/initiate`).then((r) => {
                if (r.sign_url && !r.stub) window.open(r.sign_url, '_blank', 'noopener');
                else setNote(r.stub ? 'eSign is in sandbox mode (no Digio creds) — use Mark eSigned to record completion.' : 'Signing session created.');
              }));
            }} className="text-xs border border-border rounded px-3 py-1.5 hover:bg-bg">Send for eSign</button>
            <button onClick={() => run(api.post(`/api/applications/${id}/mark-esigned`))} className="text-xs bg-primary text-white rounded px-3 py-1.5 hover:bg-primary-hover">Mark eSigned</button>
          </>
        )}
        {!a.esigned_at && data.esign_pending && (
          <span className="text-xs text-warn bg-[color:var(--warn-bg)] rounded px-2 py-1" title="Digio is polled every 15s; this flips to eSigned automatically once the customer signs">
            ⏳ Waiting for signature — checking every 15s
          </span>
        )}
        {a.esigned_at && <span className="text-xs text-success">eSigned ✓</span>}
        {a.esigned_pdf_path && (
          <a href={`/api/reports/esigned/${id}.pdf`} target="_blank" rel="noreferrer" className="text-xs text-primary hover:underline">Signed application</a>
        )}
        {can('applications:update') && (
          <label className="text-xs flex items-center gap-1.5 border border-border rounded px-3 py-1.5" title="Money came from a locker (LockerHub-originated deposits flag themselves automatically)">
            <input type="checkbox" checked={!!a.is_locker_deposit}
              onChange={(e) => run(api.post(`/api/applications/${id}/locker-deposit`, { is_locker_deposit: e.target.checked }))} />
            Locker deposit
          </label>
        )}
        {a.receipt_file_path && <a href={`/api/applications/${id}/receipt`} target="_blank" rel="noreferrer" className="text-xs text-primary hover:underline">View receipt</a>}
        <a href={`/api/reports/application-form/${id}.pdf`} target="_blank" rel="noreferrer" className="text-xs text-primary hover:underline">Application form</a>
        {a.status === 'Active' && <a href={`/api/reports/acknowledgment/${id}.pdf`} target="_blank" rel="noreferrer" className="text-xs text-primary hover:underline">Acknowledgement</a>}
        {a.status === 'Active' && can('applications:update') && (
          <button
            onClick={() => run(api.post<{ ok: boolean; status: string; error: string | null; phone: string }>(`/api/applications/${id}/whatsapp-ack`)
              .then((r) => setNote(r.ok ? `Acknowledgement sent on WhatsApp to ${r.phone}.` : `WhatsApp send ${r.status}${r.error ? ' — ' + r.error : ''}.`)))}
            className="text-xs border border-border rounded px-3 py-1.5 hover:bg-bg" title="Send the acknowledgement PDF to the customer over WhatsApp (ncd_akn)">📲 Ack on WhatsApp</button>
        )}
        {a.allotment_date && (
          <>
            <a href={`/api/reports/bond/${id}.pdf`} target="_blank" rel="noreferrer" className="text-xs text-primary hover:underline">Bond certificate</a>
            <a href={`/api/reports/allotment/${id}.pdf`} target="_blank" rel="noreferrer" className="text-xs text-primary hover:underline">Allotment letter</a>
          </>
        )}
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
        {can('applications:update') && a.status === 'Active' && <PayoutAccount appId={Number(id)} customerId={a.customer_id} current={a.payout_bank_account_id ? Number(a.payout_bank_account_id) : null} onChange={invalidate} />}
      </div>

      {/* Locker pledge — ONE investment, part of it backing locker deposits. */}
      {data.locker && data.locker.linked_to_lockers > 0 && (
        <div className="bg-surface border border-border rounded-lg shadow-card p-5 mt-4">
          <h2 className="text-xs font-semibold text-text-label uppercase tracking-wide mb-3">Locker deposit pledge</h2>
          <div className="flex flex-wrap gap-6 text-sm mb-2">
            <div><div className="text-text-muted text-xs">Total investment</div><div className="font-semibold">{formatINR(data.locker.outstanding)}</div></div>
            <div><div className="text-text-muted text-xs">Linked to lockers</div><div className="font-semibold text-warn">{formatINR(data.locker.linked_to_lockers)}</div></div>
            <div><div className="text-text-muted text-xs">Free NCD</div><div className="font-semibold">{formatINR(data.locker.free_ncd)}</div></div>
            <div><div className="text-text-muted text-xs">Redeemable</div><div className="font-semibold text-success">{formatINR(data.locker.redeemable)}</div></div>
          </div>
          <p className="text-xs text-text-muted mb-3">This is a single investment — the linked amount is the locker's security and can't be redeemed until the link is released.</p>
          <table className="w-full text-sm border-collapse">
            <thead><tr className="border-b border-border">
              {['Locker', 'Size', 'Pledged', 'Status', ''].map((h) => (
                <th key={h} className="py-2 px-3 text-xs font-semibold text-text-label uppercase tracking-wide text-left">{h}</th>
              ))}
            </tr></thead>
            <tbody>
              {data.locker.links.map((l: any) => (
                <tr key={l.id} className={`border-b border-border last:border-0 ${l.status !== 'active' ? 'opacity-50' : ''}`}>
                  <td className="py-2 px-3 font-mono text-xs">{l.locker_no ?? l.lockerhub_application_id}</td>
                  <td className="py-2 px-3">{l.locker_size ?? '—'}</td>
                  <td className="py-2 px-3 font-medium">{formatINR(l.linked_amount)}</td>
                  <td className="py-2 px-3"><span className={`text-[11px] rounded px-1.5 py-0.5 ${l.status === 'active' ? 'bg-[color:var(--warn-bg)] text-warn' : 'bg-bg text-text-muted'}`}>{l.status}</span></td>
                  <td className="py-2 px-3 text-right">
                    {l.status === 'active' && can('lockers:enroll') && (
                      <button className="text-xs text-danger hover:underline"
                        onClick={() => {
                          const r = window.prompt('Release this locker link? The pledged amount becomes redeemable.\n\nReason (e.g. locker closed):');
                          if (r && r.trim().length >= 2) run(api.post(`/api/lockers/deposit-links/${l.id}/release`, { reason: r.trim() }));
                        }}>Release</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {can('redemptions:initiate') && a.status === 'Active' && (
        <LifecycleActions appId={Number(id)} locker={data.locker}
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
