import { useEffect, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { formatINR } from '@new-wealth/shared';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api/client.js';
import { useAuth } from '../auth/AuthContext.js';

/** NCDs are issued in whole ₹1,00,000 units (owner spec 2026-07-23). */
const LAKH = 100000;

/** Customer 360 (docs/05 §5) — profile + bank accounts + KYC + hand-off. */
/**
 * Two-step confirm for an irreversible purge: type DELETE, then give an audit
 * reason. Returns the reason, or null if the operator backed out. Super-admin only.
 */
function purgeConfirm(what: string): string | null {
  const typed = window.prompt(`⚠️ PERMANENTLY DELETE ${what}.\n\nThis erases the record and everything linked to it (schedule, collections, incentives, redemptions). It CANNOT be undone.\n\nType DELETE to confirm:`);
  if (typed !== 'DELETE') return null;
  const reason = window.prompt('Reason for the audit log (required):') ?? '';
  return reason.trim().length >= 2 ? reason.trim() : null;
}


/** Lockers this customer holds — LockerHub's record plus OUR pledges/cheques.
 * Fetched separately so a LockerHub outage degrades this card alone. */
function LockersCard({ customerId }: { customerId: number }) {
  const { data, isLoading } = useQuery({
    queryKey: ['customer-lockers', customerId],
    queryFn: () => api.get<any>(`/api/lockers/customers/${customerId}/lockers`),
    retry: false,
  });
  if (isLoading || !data) return null;
  const pledges = data.pledges ?? [];
  const cheques = data.cheques ?? [];
  const lh = data.lockerhub;
  const lockers = lh?.lockers ?? lh?.applications ?? [];
  if (!pledges.length && !cheques.length && !lockers.length && !data.lockerhub_error) return null;
  const card = 'bg-surface border border-border rounded-lg shadow-card p-5 mb-4';
  return (
    <div className={card}>
      <h2 className="text-xs font-semibold text-text-label uppercase tracking-wide mb-3">Lockers</h2>
      {data.lockerhub_error && (
        <div className="text-xs text-warn mb-2">Couldn’t reach LockerHub — showing what NCD holds. ({String(data.lockerhub_error).slice(0, 80)})</div>
      )}
      {lockers.length > 0 && (
        <div className="text-sm mb-3">
          {lockers.map((l: any, i: number) => (
            <div key={i} className="flex flex-wrap gap-x-3 gap-y-1 items-center border-b border-border last:border-0 py-1.5">
              <span className="font-medium">{l.locker_no ?? l.locker_number ?? l.application_id ?? 'Locker'}</span>
              {l.branch_name && <span className="text-text-muted text-xs">{l.branch_name}</span>}
              {l.locker_size && <span className="text-xs rounded px-1.5 py-0.5 bg-bg">{l.locker_size}</span>}
              {(l.status ?? l.application_status) && <span className="text-xs rounded px-1.5 py-0.5 bg-bg">{l.status ?? l.application_status}</span>}
            </div>
          ))}
        </div>
      )}
      {pledges.length > 0 && (
        <>
          <div className="text-xs font-semibold text-text-label uppercase tracking-wide mb-1">NCDs pledged as deposit</div>
          <div className="text-sm mb-3">
            {pledges.map((p: any) => (
              <div key={p.id} className="flex flex-wrap gap-x-3 items-center border-b border-border last:border-0 py-1.5">
                <Link to={`/app/applications/${p.application_id}`} className="text-primary hover:underline font-mono text-xs">{p.application_no}</Link>
                <span className="mono">{formatINR(p.linked_amount)}</span>
                <span className="text-xs text-text-muted">locker {p.lockerhub_application_id}{p.locker_no ? ` · ${p.locker_no}` : ''}</span>
                <span className={`text-xs rounded px-1.5 py-0.5 ${p.status === 'active' ? 'bg-[color:var(--warn-bg)] text-warn' : 'bg-bg text-text-muted'}`}>{p.status}</span>
              </div>
            ))}
          </div>
        </>
      )}
      {cheques.length > 0 && (
        <>
          <div className="text-xs font-semibold text-text-label uppercase tracking-wide mb-1">Locker cheques</div>
          <div className="text-sm">
            {cheques.map((q: any) => (
              <div key={q.id} className="flex flex-wrap gap-x-3 items-center border-b border-border last:border-0 py-1.5">
                <span className="font-mono text-xs">{q.cheque_no}</span>
                <span className="mono">{formatINR(q.amount)}</span>
                <span className="text-xs text-text-muted">{q.leg} · {q.bank_name ?? '—'}</span>
                <span className={`text-xs rounded px-1.5 py-0.5 ${q.status === 'Cleared' ? 'bg-[color:var(--success-bg)] text-success' : q.status === 'Pending' ? 'bg-[color:var(--warn-bg)] text-warn' : 'bg-bg text-text-muted'}`}>{q.status}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export function CustomerDetailPage() {
  const { id } = useParams();
  const qc = useQueryClient();
  const nav = useNavigate();
  const { can } = useAuth();
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
        {c.archived_at && <span className="text-xs rounded px-1.5 py-0.5 bg-[color:var(--danger-bg)] text-danger font-semibold">Archived</span>}
      </div>
      {c.archived_at && (
        <div className="text-xs bg-[color:var(--danger-bg)] text-danger rounded px-3 py-2 mt-2">
          This customer is archived — hidden from the book, dashboard and lists. Their investments are archived too.
          {can('customers:delete') && ' Restore or permanently delete below.'}
        </div>
      )}
      {msg && <div className="text-xs text-danger mt-2">{msg}</div>}

      <div className={`${card} mt-4`}>
        <h2 className="text-xs font-semibold text-text-label uppercase tracking-wide mb-3">Profile</h2>
        <dl className="grid grid-cols-2 gap-y-2 text-sm">
          <Field label="Phone" value={c.phone} /><Field label="District" value={c.district} />
          <Field label="KYC" value={c.kyc_status} /><Field label="Active" value={c.is_active ? 'Yes' : 'No'} />
          <Field label="PAN" value={c.pan} /><Field label="Email" value={c.email} />
          {/* Who brought this customer in — staff or agent (owner 2026-07-24). */}
          <Field label="Enrolled by" value={c.enrolled_by_name
            ? `${c.enrolled_by_name}${c.enrolled_by_kind === 'agent' ? ` (agent${c.enrolled_by_agent_code ? ' ' + c.enrolled_by_agent_code : ''})` : ' (staff)'}`
            : null} />
          {/* Referred by is NOT the same as enrolled by: staff enrol, but the
              customer may have been introduced by another customer or an agent.
              Free text on the record, resolved to a person server-side. */}
          <div>
            <dt className="text-xs text-text-label uppercase tracking-wide">Referred by</dt>
            <dd className="text-sm m-0 mt-0.5">
              {!data.referredBy ? <span className="text-text-muted">—</span>
                : data.referredBy.kind === 'customer'
                  ? <Link to={`/app/customers/${data.referredBy.id}`} className="text-primary hover:underline">
                      {data.referredBy.name} <span className="text-text-muted">({data.referredBy.code})</span>
                    </Link>
                : data.referredBy.kind === 'agent'
                  ? <>{data.referredBy.name} <span className="text-text-muted">(agent {data.referredBy.code})</span></>
                : data.referredBy.kind === 'staff'
                  ? <>{data.referredBy.name} <span className="text-text-muted">(staff)</span></>
                : <span title="Recorded as free text — no matching customer, agent or staff member">
                    {data.referredBy.text} <span className="text-text-muted">(unmatched)</span>
                  </span>}
            </dd>
          </div>
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
          {/* Customer creation needs no approval (owner 2026-07-21) — the customer
              is live on creation; the only approval gate is the investment. */}
          {can('customers:correction-request') && c.creation_status !== 'Draft' && (
            <button onClick={() => setPanel(panel === 'correction' ? null : 'correction')} className="text-xs border border-border rounded px-3 py-1.5 hover:bg-bg">Request correction</button>
          )}
          {can('customers:handover-request') && (
            <button onClick={() => setPanel(panel === 'handover' ? null : 'handover')} className="text-xs border border-border rounded px-3 py-1.5 hover:bg-bg">Request handover</button>
          )}
          {/* Super-admin-only power tools (customers:delete). */}
          {can('customers:delete') && (c.archived_at
            ? <button onClick={() => wrap(api.post(`/api/customers/${id}/unarchive`))} className="text-xs border border-border rounded px-3 py-1.5 hover:bg-bg ml-auto">♻ Restore customer</button>
            : <button onClick={() => { const r = window.prompt('Archive this customer? It (and its investments) will be hidden from the book but stay recoverable.\n\nReason (optional):'); if (r !== null) wrap(api.post(`/api/customers/${id}/archive`, { reason: r || undefined })); }} className="text-xs border border-border rounded px-3 py-1.5 hover:bg-bg ml-auto">🗄 Archive</button>
          )}
          {can('customers:delete') && (
            <button onClick={() => { const reason = purgeConfirm(`customer ${c.full_name} (${c.customer_code}) and ALL their investments`); if (reason) wrap(api.del(`/api/customers/${id}`, { confirm: true, reason }).then(() => nav('/app/customers'))); }}
              className="text-xs border border-danger text-danger rounded px-3 py-1.5 hover:bg-[color:var(--danger-bg)]">🗑 Delete permanently</button>
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

      <InvestmentsCard rows={data.applications ?? []} customerId={Number(id)} canDelete={can('applications:delete')} onChange={invalidate} onError={setMsg} />

      <div className={card}>
        <h2 className="text-xs font-semibold text-text-label uppercase tracking-wide mb-3">Bank accounts</h2>
        <BankAccounts
          customerId={Number(id)}
          accounts={data.bankAccounts}
          canEdit={can('customers:update')}
          canDelete={can('customers:delete')}
          onChange={invalidate}
          onError={setMsg}
        />
      </div>

      <Demat customerId={Number(id)} customer={c} canEdit={can('customers:update')} onChange={invalidate} onError={setMsg} />

      <RelationsKyc customerId={Number(id)} data={data} onChange={invalidate} can={can} />

      {can('applications:create') && c.creation_status === 'Approved' && <NewInvestment customerId={Number(id)} />}

      <LockersCard customerId={Number(id)} />
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
function InvestmentsCard({ rows, canDelete, onChange, onError }: { rows: any[]; customerId: number; canDelete: boolean; onChange: () => void; onError: (m: string) => void }) {
  const nav = useNavigate();
  const DEAD = ['Rejected', 'Cancelled', 'Redeemed', 'Matured', 'RolledOver', 'PrematureWithdrawn', 'Transferred'];
  const live = rows.filter((r) => !DEAD.includes(r.status) && !r.archived_at);
  const outstanding = live.reduce((s, r) => s + Number(r.outstanding ?? 0), 0);
  const th = 'py-2 px-3 text-xs font-semibold text-text-label uppercase tracking-wide text-left';
  const td = 'py-2 px-3 align-middle';
  const run = (p: Promise<unknown>) => p.then(() => { onError(''); onChange(); }).catch((e) => onError(e instanceof ApiError ? e.message : 'Failed'));
  const archiveApp = (r: any) => { const reason = window.prompt(`Archive investment ${r.application_no}? Hidden from the book but recoverable.\n\nReason (optional):`); if (reason !== null) run(api.post(`/api/applications/${r.id}/archive`, { reason: reason || undefined })); };
  const restoreApp = (r: any) => run(api.post(`/api/applications/${r.id}/unarchive`));
  const purgeApp = (r: any) => { const reason = purgeConfirm(`investment ${r.application_no}`); if (reason) run(api.del(`/api/applications/${r.id}`, { confirm: true, reason })); };
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
                  <th className={th}>Status</th><th className={th}>eSign</th><th className={th}>Received</th>
                  <th className={`${th} text-right`}>Invested</th><th className={`${th} text-right`}>Outstanding</th>
                  {canDelete && <th className={`${th} text-right`}></th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className={`border-b border-border last:border-0 hover:bg-bg cursor-pointer ${r.archived_at ? 'opacity-50' : ''}`} onClick={() => nav(`/app/applications/${r.id}`)}>
                    <td className={td}>{r.series_code}</td>
                    <td className={`${td} font-mono text-xs whitespace-nowrap`}>{r.application_no}</td>
                    <td className={td}>
                      <span className={`text-[11px] rounded px-1.5 py-0.5 ${appPill[r.status] ?? 'bg-[color:var(--warn-bg)] text-warn'}`}>{r.status}</span>
                      {r.archived_at && <span className="ml-1 text-[11px] rounded px-1.5 py-0.5 bg-[color:var(--danger-bg)] text-danger">Archived</span>}
                    </td>
                    <td className={`${td} whitespace-nowrap`}>
                      {r.esigned_at
                        ? <span className="text-[11px] rounded px-1.5 py-0.5 bg-[color:var(--success-bg)] text-success" title={`eSigned on ${String(r.esigned_at).slice(0, 10)}`}>✓ eSigned</span>
                        : <span className="text-[11px] rounded px-1.5 py-0.5 bg-[color:var(--warn-bg)] text-warn" title="Not eSigned yet">Not signed</span>}
                      {r.esigned_at && r.has_signed_copy && (
                        <a href={`/api/reports/esigned/${r.id}.pdf`} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}
                           className="ml-1.5 text-[11px] text-primary hover:underline">view</a>
                      )}
                    </td>
                    <td className={`${td} text-xs whitespace-nowrap`}>{r.date_money_received ? String(r.date_money_received).slice(0, 10) : '—'}</td>
                    <td className={`${td} text-right mono`}>{formatINR(r.amount)}</td>
                    <td className={`${td} text-right mono font-medium`}>{formatINR(r.outstanding ?? 0)}</td>
                    {canDelete && (
                      <td className={`${td} text-right whitespace-nowrap`} onClick={(e) => e.stopPropagation()}>
                        {r.archived_at
                          ? <button onClick={() => restoreApp(r)} className="text-xs text-primary hover:underline mr-3">Restore</button>
                          : <button onClick={() => archiveApp(r)} className="text-xs text-primary hover:underline mr-3">Archive</button>}
                        <button onClick={() => purgeApp(r)} className="text-xs text-danger hover:underline">Delete</button>
                      </td>
                    )}
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
    <>
      {msg && <div className="text-xs text-danger mb-2">{msg}</div>}

      {/* Relations — nominees + joint holders */}
      <div className={card}>
        <h2 className="text-xs font-semibold text-text-label uppercase tracking-wide mb-3">Relations</h2>
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
      </div>

      {/* KYC — documents + verification */}
      <div className={card}>
        <h2 className="text-xs font-semibold text-text-label uppercase tracking-wide mb-3">KYC</h2>
        <div>
          <div className="flex items-center justify-between"><span className="font-semibold text-sm">Documents</span>{can('customers:update') && <button onClick={uploadDoc} className="text-xs text-primary hover:underline">+ Upload</button>}</div>
          <ul className="mt-1 text-text-muted text-sm">{(data.documents ?? []).map((d: any) => <li key={d.id}><a href={`/api/customers/${customerId}/documents/${d.id}`} target="_blank" rel="noreferrer" className="text-primary hover:underline">{d.doc_type} — {d.original_filename ?? d.id}</a> <span className="text-xs">({d.origin})</span></li>)}{!(data.documents ?? []).length && <li>None</li>}</ul>
        </div>
        <div className="flex gap-2 mt-4">
          {can('kyc:verify') && <button onClick={() => wrap(api.post(`/api/customers/${customerId}/kyc/digilocker/start`).then(() => api.post(`/api/customers/${customerId}/kyc/digilocker/complete`)))} className="text-xs border border-border rounded px-3 py-1.5 hover:bg-bg">DigiLocker verify</button>}
          {can('customers:deactivate') && !data.customer.is_deceased && <button onClick={() => { const d = window.prompt('Deceased date (YYYY-MM-DD)'); if (d) wrap(api.post(`/api/customers/${customerId}/deceased`, { deceased_date: d })); }} className="text-xs border border-border rounded px-3 py-1.5 hover:bg-bg text-danger">Mark deceased</button>}
        </div>
      </div>
    </>
  );
}

function NewInvestment({ customerId }: { customerId: number }) {
  const nav = useNavigate();
  const [seriesId, setSeriesId] = useState('');
  const [schemeId, setSchemeId] = useState('');
  const [amount, setAmount] = useState('');
  // NCDs are issued in whole ₹1,00,000 units (the API enforces the scheme's own
  // min_ticket/multiple_of; this mirrors it so staff see it before submitting).
  const ticketOk = amount !== '' && Number(amount) >= LAKH && Math.round(Number(amount) * 100) % (LAKH * 100) === 0;
  const [dateReceived, setDateReceived] = useState('');
  const [clubWith, setClubWith] = useState('');
  const [lockerDeposit, setLockerDeposit] = useState(false);
  const [method, setMethod] = useState('');
  const [reference, setReference] = useState('');
  const [receipt, setReceipt] = useState<File | null>(null);
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
  const readFileB64 = (file: File) => new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = reject; r.readAsDataURL(file);
  });
  const create = useMutation({
    mutationFn: async () => {
      // The payment evidence (credited date, method, reference, receipt photo)
      // is mandatory. The receipt travels WITH the create — the API stores it in
      // the same transaction, so no investment can exist without one.
      if (!receipt) throw new ApiError('VALIDATION', 400, 'Receipt photo is required');
      if (receipt.size > 4 * 1024 * 1024) throw new ApiError('too_large', 400, 'Receipt must be under 4 MB');
      return api.post<{ id: number }>('/api/applications', {
        customer_id: customerId, series_id: Number(seriesId), scheme_id: Number(schemeId), amount: Number(amount),
        date_money_received: dateReceived,
        collection_method: method.trim(),
        collection_reference: reference.trim(),
        receipt: { filename: receipt.name, mime: receipt.type || 'application/octet-stream', data_base64: await readFileB64(receipt) },
        ...(clubWith ? { club_with_application_id: Number(clubWith) } : {}),
        ...(lockerDeposit ? { is_locker_deposit: true } : {}),
      });
    },
    onSuccess: (r) => nav(`/app/applications/${r.id}`),
    onError: (e) => setErr(e instanceof ApiError ? e.message : 'Failed'),
  });
  // Mandatory before Create is allowed — mirrors the API schema.
  const missingRequired = () => [
    !dateReceived && 'credited date',
    !method && 'payment method',
    !reference.trim() && 'reference / cheque no.',
    !receipt && 'receipt photo',
  ].filter((f): f is string => !!f);
  const sel = 'px-2.5 py-1.5 text-sm border border-border-strong rounded outline-none focus:border-primary';
  const clubOptions = candidates.data?.rows ?? [];
  return (
    <div className="bg-surface border border-border rounded-lg shadow-card p-5 mb-4">
      <h2 className="text-xs font-semibold text-text-label uppercase tracking-wide mb-3">New investment</h2>
      <div className="flex flex-wrap gap-2 items-center">
        <select className={sel} value={seriesId} onChange={(e) => { setSeriesId(e.target.value); setClubWith(''); }}>
          <option value="">Series…</option>
          {/* Only an OPEN series can take a new investment (closed/allotted are locked). */}
          {(series.data?.rows ?? []).filter((s) => s.status === 'Open').map((s) => <option key={s.id} value={s.id}>{s.code}</option>)}
        </select>
        <select className={sel} value={schemeId} onChange={(e) => setSchemeId(e.target.value)}>
          <option value="">Scheme…</option>
          {(schemes.data?.rows ?? []).map((s) => <option key={s.id} value={s.id}>{s.code} ({s.coupon_rate_pct}%)</option>)}
        </select>
        {/* NCDs are issued in whole ₹1,00,000 units — step/min make the browser
            enforce it, and the hint below states it before they submit. */}
        <input className={sel} placeholder="Amount (₹1,00,000 units)" type="number" min={LAKH} step={LAKH}
          value={amount} onChange={(e) => setAmount(e.target.value)} />
        <label className="text-xs flex items-center gap-1.5" title="Date the money was credited to Dhanam's account — interest starts from here once approved">
          Credited<span className="text-danger">*</span> <input className={sel} type="date" value={dateReceived} onChange={(e) => setDateReceived(e.target.value)} />
        </label>
        <select className={sel} value={method} onChange={(e) => setMethod(e.target.value)}>
          <option value="">Payment method… *</option>
          <option value="NEFT/RTGS">NEFT/RTGS</option>
          <option value="Cheque">Cheque</option>
        </select>
        <input className={sel} placeholder="Reference / cheque no. *" value={reference} onChange={(e) => setReference(e.target.value)} />
        <label className="text-xs flex items-center gap-1.5 cursor-pointer border border-border-strong rounded px-2.5 py-1.5" title="Receipt / cheque photo (image or PDF, under 4 MB)">
          {receipt ? `📎 ${receipt.name.length > 18 ? receipt.name.slice(0, 15) + '…' : receipt.name}` : <>📎 Receipt photo<span className="text-danger">*</span></>}
          <input type="file" accept="image/*,.pdf" className="hidden" onChange={(e) => setReceipt(e.target.files?.[0] ?? null)} />
        </label>
        <label className="text-xs flex items-center gap-1.5" title="Money came from a locker (LockerHub-originated deposits flag themselves automatically)">
          <input type="checkbox" checked={lockerDeposit} onChange={(e) => setLockerDeposit(e.target.checked)} /> Locker deposit
        </label>
        <button disabled={!seriesId || !schemeId || !amount || !ticketOk || create.isPending} onClick={() => {
          const missing = missingRequired();
          if (missing.length) {
            const list = missing.join(', ');
            setErr(`${list.charAt(0).toUpperCase()}${list.slice(1)} ${missing.length > 1 ? 'are' : 'is'} required.`);
            return;
          }
          setErr(''); create.mutate();
        }}
          className="text-xs bg-primary text-white rounded px-4 py-1.5 disabled:opacity-40 hover:bg-primary-hover">
          {clubWith ? 'Add to application' : 'Create investment'}
        </button>
      </div>
      {amount !== '' && !ticketOk && (
        <div className="text-xs text-danger mt-2">
          Investments are issued in units of ₹1,00,000. Nearest valid amounts: ₹{(Math.max(1, Math.floor(Number(amount) / LAKH)) * LAKH).toLocaleString('en-IN')} or ₹{((Math.floor(Number(amount) / LAKH) + 1) * LAKH).toLocaleString('en-IN')}.
        </div>
      )}
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

/**
 * Demat account — the depository account the NCDs are credited to. Backed by the
 * customers table (demat_dp_id / demat_client_id / depository) via PUT /:id/demat.
 * DP ID + Client ID together form the 16-char BO ID.
 */
function Demat({ customerId, customer, canEdit, onChange, onError }: {
  customerId: number; customer: any; canEdit: boolean; onChange: () => void; onError: (m: string) => void;
}) {
  const [dpId, setDpId] = useState(customer.demat_dp_id ?? '');
  const [clientId, setClientId] = useState(customer.demat_client_id ?? '');
  const [depository, setDepository] = useState(customer.depository ?? '');
  const inp = 'px-2.5 py-1.5 text-sm border border-border-strong rounded outline-none focus:border-primary';

  const has = !!(customer.demat_dp_id || customer.demat_client_id);
  const dirty = dpId.trim() !== (customer.demat_dp_id ?? '')
    || clientId.trim() !== (customer.demat_client_id ?? '')
    || (depository || '') !== (customer.depository ?? '');

  const save = useMutation({
    mutationFn: () => api.put(`/api/customers/${customerId}/demat`, {
      dp_id: dpId.trim(), client_id: clientId.trim(), depository: depository.trim() || null,
    }),
    onSuccess: onChange,
    onError: (e) => onError(e instanceof ApiError ? e.message : 'Failed'),
  });

  return (
    <div className="bg-surface border border-border rounded-lg shadow-card p-5 mb-4">
      <h2 className="text-xs font-semibold text-text-label uppercase tracking-wide mb-3">Demat account</h2>
      {has ? (
        <dl className="grid grid-cols-2 gap-y-2 text-sm mb-3">
          <Field label="DP ID" value={customer.demat_dp_id} />
          <Field label="Client ID" value={customer.demat_client_id} />
          <Field label="Depository" value={customer.depository} />
        </dl>
      ) : (
        <div className="text-sm text-text-muted mb-3">No demat details on file.</div>
      )}
      {canEdit && (
        <div className="flex gap-2 items-center flex-wrap">
          <input className={inp} placeholder="DP ID" value={dpId} maxLength={16}
            onChange={(e) => setDpId(e.target.value.toUpperCase().replace(/\s/g, ''))} />
          <input className={inp} placeholder="Client ID" value={clientId} maxLength={16}
            onChange={(e) => setClientId(e.target.value.replace(/\s/g, ''))} />
          <select className={inp} value={depository} onChange={(e) => setDepository(e.target.value)}>
            <option value="">Depository…</option>
            <option value="NSDL">NSDL</option>
            <option value="CDSL">CDSL</option>
          </select>
          <button disabled={!dpId.trim() || !clientId.trim() || !dirty || save.isPending} onClick={() => save.mutate()}
            className="text-xs bg-primary text-white rounded px-3 py-1.5 disabled:opacity-40 hover:bg-primary-hover">
            {has ? 'Update' : '+ Save'}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Bank accounts: list + add. Name and account number are typed; entering a
 * valid IFSC auto-fills the bank and branch from the directory lookup
 * (/api/lookups/ifsc). Penny-drop verification happens on the server via
 * kycProvider() when the account is added.
 */
function BankAccounts({ customerId, accounts, canEdit, canDelete, onChange, onError }: {
  customerId: number; accounts: any[]; canEdit: boolean; canDelete: boolean; onChange: () => void; onError: (m: string) => void;
}) {
  const empty = { holder_name: '', account_number: '', ifsc: '', bank_name: '', branch_name: '', branch_city: '' };
  const [f, setF] = useState(empty);
  const [ifscState, setIfscState] = useState<'idle' | 'looking' | 'found' | 'notfound'>('idle');
  const set = (k: keyof typeof f, v: string) => setF((s) => ({ ...s, [k]: v }));
  const ifscValid = /^[A-Z]{4}0[A-Z0-9]{6}$/.test(f.ifsc.trim().toUpperCase());

  // Debounced IFSC → bank/branch lookup. Non-blocking: on miss/error the user
  // can still add the account (bank/branch just stay whatever was typed/blank).
  useEffect(() => {
    const code = f.ifsc.trim().toUpperCase();
    if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(code)) { setIfscState('idle'); return; }
    let cancelled = false;
    setIfscState('looking');
    const t = setTimeout(async () => {
      try {
        const r = await api.get<any>(`/api/lookups/ifsc/${code}`);
        if (cancelled) return;
        if (r.found) {
          setF((s) => ({ ...s, bank_name: r.bank, branch_name: r.branch, branch_city: r.city }));
          setIfscState('found');
        } else {
          setF((s) => ({ ...s, bank_name: '', branch_name: '', branch_city: '' }));
          setIfscState('notfound');
        }
      } catch { if (!cancelled) setIfscState('notfound'); }
    }, 400);
    return () => { cancelled = true; clearTimeout(t); };
  }, [f.ifsc]);

  // Errors from THIS card are shown INSIDE it. The page-level banner renders up
  // by the profile header, far above the bank section — so a refused delete
  // looked like nothing happened at all.
  const [cardErr, setCardErr] = useState('');
  // Accepts a thrown error OR a plain message, so client-side validation lands
  // in the same inline slot as a server refusal rather than the page banner.
  const fail = (e: unknown) => {
    const m = typeof e === 'string' ? e : e instanceof ApiError ? e.message : 'Failed';
    setCardErr(m); onError(m);
  };

  const add = useMutation({
    mutationFn: () => api.post(`/api/customers/${customerId}/bank-accounts`, {
      ...f, ifsc: f.ifsc.trim().toUpperCase(), holder_name: f.holder_name.trim() || undefined,
    }),
    onSuccess: () => { setF(empty); setIfscState('idle'); onChange(); },
    onError: fail,
  });
  const wrapSet = (p: Promise<unknown>) => p.then(() => { setCardErr(''); onChange(); }).catch(fail);
  const inp = 'px-2.5 py-1.5 text-sm border border-border-strong rounded outline-none focus:border-primary';

  return (
    <>
      {cardErr && (
        <div className="text-xs text-danger bg-[color:var(--danger-bg)] border border-danger/30 rounded px-3 py-2 mb-3">{cardErr}</div>
      )}
      <div className="divide-y divide-border">
        {accounts.map((b: any) => (
          <div key={b.id} className="py-2.5 flex items-center gap-3 text-sm flex-wrap">
            <div className="min-w-0">
              {b.holder_name && <div className="font-medium truncate">{b.holder_name}</div>}
              <div className="flex items-center gap-2">
                <span className="font-mono">{b.account_number}</span>
                <span className="text-text-muted">{b.ifsc}</span>
              </div>
              {(b.bank_name || b.branch_name) && (
                <div className="text-xs text-text-muted">
                  {[b.bank_name, b.branch_name, b.branch_city].filter(Boolean).join(' · ')}
                </div>
              )}
            </div>
            <span className={`text-xs rounded px-1.5 py-0.5 ${b.penny_drop_status === 'Verified' ? 'bg-[color:var(--success-bg)] text-success' : b.penny_drop_status === 'Failed' ? 'bg-[color:var(--danger-bg)] text-danger' : 'bg-bg text-text-muted'}`}>{b.penny_drop_status}</span>
            {b.is_active && <span className="text-xs rounded px-1.5 py-0.5 bg-[color:var(--primary-ring)] text-primary">Active</span>}
            <span className="ml-auto flex items-center gap-3">
              {/* A misspelt beneficiary name is what prints on the bank file —
                  fix it in place rather than re-adding the whole account. */}
              {canEdit && (
                <button onClick={() => {
                  const next = window.prompt('Beneficiary name as it should appear on the bank file:', b.holder_name ?? '');
                  if (next === null) return;
                  if (next.trim().length < 2) { fail('Beneficiary name is required.'); return; }
                  wrapSet(api.patch(`/api/customers/${customerId}/bank-accounts/${b.id}`, { holder_name: next.trim() }));
                }} className="text-xs text-primary hover:underline">Edit name</button>
              )}
              {/* A failed penny-drop must not strand the customer on the wrong
                  account: offer a retry, and allow an explicit override. */}
              {b.penny_drop_status !== 'Verified' && canEdit && (
                <button onClick={() => wrapSet(api.post(`/api/customers/${customerId}/bank-accounts/${b.id}/reverify`))}
                  className="text-xs text-primary hover:underline">Retry verification</button>
              )}
              {!b.is_active && canEdit && (
                <button onClick={() => {
                  if (b.penny_drop_status === 'Verified') {
                    wrapSet(api.post(`/api/customers/${customerId}/bank-accounts/${b.id}/set-active`));
                    return;
                  }
                  const reason = window.prompt(
                    `This account's penny-drop is ${b.penny_drop_status}, not Verified.\n\nActivate it anyway only if you have confirmed the details another way — future payouts will go here.\n\nReason (recorded):`);
                  if (reason === null) return;
                  if (reason.trim().length < 3) { fail('A reason is required to activate an unverified account.'); return; }
                  wrapSet(api.post(`/api/customers/${customerId}/bank-accounts/${b.id}/set-active`, { force: true, reason: reason.trim() }));
                }} className="text-xs text-primary hover:underline">Make active</button>
              )}
              {/* Super-admin only. The server refuses while an NCD is pinned to
                  it or unpaid payouts point at it, and says which. */}
              {canDelete && (
                <button
                  onClick={() => {
                    if (!window.confirm(`Delete account ${b.account_number} (${b.ifsc})? Past payments keep their record; this only removes the account from the customer's file.`)) return;
                    wrapSet(api.del(`/api/customers/${customerId}/bank-accounts/${b.id}`));
                  }}
                  className="text-xs text-danger hover:underline">Delete</button>
              )}
            </span>
          </div>
        ))}
        {accounts.length === 0 && <div className="py-2 text-text-muted text-sm">No bank accounts yet.</div>}
      </div>

      {canEdit && (
        <div className="mt-3">
          <div className="flex gap-2 items-start flex-wrap">
            <input className={inp} placeholder="Account holder name" value={f.holder_name} onChange={(e) => set('holder_name', e.target.value)} />
            <input className={inp} placeholder="Account number" value={f.account_number} onChange={(e) => set('account_number', e.target.value.replace(/\s/g, ''))} />
            <input className={`${inp} uppercase`} placeholder="IFSC" value={f.ifsc} maxLength={11}
              onChange={(e) => set('ifsc', e.target.value.toUpperCase().replace(/\s/g, ''))} />
            <button disabled={f.account_number.length < 4 || !ifscValid || add.isPending} onClick={() => add.mutate()}
              className="text-xs bg-primary text-white rounded px-3 py-1.5 disabled:opacity-40 hover:bg-primary-hover">+ Add &amp; verify</button>
          </div>
          <div className="text-xs mt-1.5 min-h-[1rem]">
            {ifscState === 'looking' && <span className="text-text-muted">Looking up IFSC…</span>}
            {ifscState === 'found' && (
              <span className="text-success">🏦 {[f.bank_name, f.branch_name, f.branch_city].filter(Boolean).join(' · ')}</span>
            )}
            {ifscState === 'notfound' && ifscValid && <span className="text-text-muted">IFSC not found in the directory — you can still add the account.</span>}
          </div>
        </div>
      )}
    </>
  );
}
