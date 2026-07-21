import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { formatINR } from '@new-wealth/shared';
import { api, ApiError } from '../api/client.js';
import { ReferredByPicker } from '../components/ReferredByPicker.js';
import { APPROVAL_TYPE_LABELS as TYPE_LABELS } from '../labels.js';

interface ApprovalReq {
  id: number;
  request_no: string;
  request_type: string;
  entity_type: string | null;
  entity_id: string | null;
  level: number;
  max_levels: number;
  status: string;
  metadata: Record<string, unknown>;
  canAct: boolean;
  selfApproval?: boolean;
  subject?: string;
  amount?: number | null;
}

/** Human title for a request card, e.g. "NCD_27 · Activation" for a batch. */
function requestTitle(r: ApprovalReq): string {
  const label = TYPE_LABELS[r.request_type] ?? r.request_type;
  const series = r.metadata.series_code ? String(r.metadata.series_code) : null;
  return series ? `${series} · ${label}` : label;
}

/** Expanded row: full request payload from GET /api/approvals/:id. */
interface CoveredRow {
  application_no: string; customer: string; customer_code: string;
  amount: string; date_money_received: string | null; series_code: string;
}

function Detail({ id, canAct, selfApproval, actionLabel, onDone }: { id: number; canAct: boolean; selfApproval?: boolean; actionLabel: string; onDone: () => void }) {
  const { data, isLoading } = useQuery({
    queryKey: ['approval', id],
    queryFn: () => api.get<{ request: Record<string, unknown>; covered: CoveredRow[] | null;
      detail: { subject: string; amount: number | null; facts: Array<{ label: string; value: string }> };
      editable: Editable | null }>(`/api/approvals/${id}`),
  });
  if (isLoading) return <div className="text-xs text-text-muted px-4 pb-3">Loading detail…</div>;
  const r = data?.request ?? {};
  const covered = data?.covered ?? null;
  const facts = data?.detail?.facts ?? [];
  const total = (covered ?? []).reduce((s, c) => s + Number(c.amount), 0);
  return (
    <div className="px-4 pb-4">
      {covered && (
        <div className="bg-bg rounded p-3 mb-2">
          <div className="text-xs font-semibold text-text-label uppercase tracking-wide mb-2">
            {covered.length} investment{covered.length === 1 ? '' : 's'} in this batch · {formatINR(total)}
          </div>
          {covered.length === 0 ? (
            <div className="text-xs text-text-muted">Nothing left in this batch — the covered investments were already processed.</div>
          ) : (
            <div className="max-h-72 overflow-y-auto">
              <table className="w-full text-xs border-collapse">
                <thead>
                  <tr className="border-b border-border text-left">
                    <th className="py-1.5 pr-3 font-semibold text-text-label">Customer</th>
                    <th className="py-1.5 pr-3 font-semibold text-text-label">App no</th>
                    <th className="py-1.5 pr-3 font-semibold text-text-label">Received</th>
                    <th className="py-1.5 font-semibold text-text-label text-right">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {covered.map((c) => (
                    <tr key={c.application_no} className="border-b border-border last:border-0">
                      <td className="py-1.5 pr-3">{c.customer} <span className="text-text-muted font-mono">{c.customer_code}</span></td>
                      <td className="py-1.5 pr-3 font-mono whitespace-nowrap">{c.application_no}</td>
                      <td className="py-1.5 pr-3 whitespace-nowrap">{c.date_money_received ? String(c.date_money_received).slice(0, 10) : '—'}</td>
                      <td className="py-1.5 text-right mono">{formatINR(c.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
      {facts.length > 0 && (
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-xs bg-bg rounded p-3 mb-2">
          {facts.map((f) => (
            <span key={f.label} className="contents">
              <dt className="text-text-muted">{f.label}</dt>
              <dd className="m-0 font-medium break-words">{f.value}</dd>
            </span>
          ))}
        </dl>
      )}
      {data?.editable
        ? <EditableInvestment ed={data.editable} id={id} canAct={canAct} selfApproval={selfApproval} actionLabel={actionLabel} onDone={onDone} />
        : canAct && <ConfirmApproval id={id} label={actionLabel} selfApproval={selfApproval} onDone={onDone} />}
    </div>
  );
}

/** CXO waive/discount of a pending premature penalty, shown on the approval card. */
function PrematureWaive({ redemptionId, penalty, netPayment, waived, onDone }: {
  redemptionId: number; penalty: number; netPayment: number; waived: boolean; onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [amt, setAmt] = useState('');
  const [reason, setReason] = useState('');
  const [err, setErr] = useState('');
  const apply = useMutation({
    mutationFn: (newPenalty: number) => api.post(`/api/redemptions/${redemptionId}/waive-penalty`, { new_penalty: newPenalty, reason: reason.trim() }),
    onSuccess: () => { setOpen(false); setAmt(''); setReason(''); setErr(''); onDone(); },
    onError: (e) => setErr(e instanceof ApiError ? e.message : 'Failed'),
  });
  const inr = (n: number) => formatINR(n);
  return (
    <div className="px-4 pb-3 -mt-1">
      <div className="text-xs text-text-muted">
        Penalty <span className="font-semibold text-text mono">{inr(penalty)}</span> · Net payable <span className="font-semibold text-text mono">{inr(netPayment)}</span>
        {waived && <span className="ml-2 text-success">· penalty adjusted</span>}
        {' '}<button onClick={() => setOpen((s) => !s)} className="text-primary hover:underline">{open ? 'Cancel' : 'Waive / discount penalty'}</button>
      </div>
      {open && (
        <div className="mt-2 flex flex-wrap items-center gap-2 bg-bg rounded p-2.5">
          <button disabled={apply.isPending || !reason.trim()} onClick={() => apply.mutate(0)}
            className="text-xs bg-primary text-white rounded px-3 py-1.5 disabled:opacity-40 hover:bg-primary-hover">Waive fully (₹0)</button>
          <span className="text-xs text-text-muted">or set to</span>
          <input className="w-28 px-2 py-1 text-xs border border-border-strong rounded" type="number" placeholder="₹ penalty" value={amt} onChange={(e) => setAmt(e.target.value)} />
          <input className="flex-1 min-w-[10rem] px-2 py-1 text-xs border border-border-strong rounded" placeholder="Reason (required)" value={reason} onChange={(e) => setReason(e.target.value)} />
          <button disabled={apply.isPending || !amt || !reason.trim() || Number(amt) > penalty} onClick={() => apply.mutate(Number(amt))}
            className="text-xs border border-border-strong rounded px-3 py-1.5 disabled:opacity-40 hover:border-primary">Apply discount</button>
          {err && <span className="text-xs text-danger w-full">{err}</span>}
        </div>
      )}
    </div>
  );
}

/** App/LockerHub investment notice: already live — lets the admin assign a
 * staff/agent when the customer gave no referral code. */
function AppInvestmentNotice({ appId, amount, needsAttribution, referredBy, onDone }: {
  appId: number; amount: number | null; needsAttribution: boolean; referredBy: string | null; onDone: () => void;
}) {
  const [q, setQ] = useState('');
  const [err, setErr] = useState('');
  const [assigned, setAssigned] = useState<string | null>(null);
  const search = useQuery({
    queryKey: ['payee-search', q],
    queryFn: () => api.get<{ rows: Array<{ kind: string; id: number; code: string; full_name: string }> }>(`/api/agents/payee-search?q=${encodeURIComponent(q.trim())}`),
    enabled: q.trim().length >= 2,
  });
  const assign = useMutation({
    mutationFn: (payee: string) => api.post(`/api/applications/${appId}/attribute-referrer`, { payee }),
    onSuccess: (_r, payee) => { setAssigned(payee); setQ(''); setErr(''); onDone(); },
    onError: (e) => setErr(e instanceof ApiError ? e.message : 'Failed'),
  });
  const showAssign = (needsAttribution || !referredBy) && !assigned;
  return (
    <div className="px-4 pb-3 -mt-1">
      <div className="text-xs text-text-muted">
        {amount != null && <span>Live for the customer · <span className="font-semibold text-text mono">{formatINR(amount)}</span>. </span>}
        {assigned ? <span className="text-success">Assigned to {assigned}.</span>
          : referredBy ? <span>Referred by <span className="font-mono">{referredBy}</span>.</span>
          : <span className="text-danger">No referral code — assign a staff/agent, then acknowledge.</span>}
      </div>
      {showAssign && (
        <div className="mt-2 bg-bg rounded p-2.5">
          <input className="w-full px-2 py-1 text-xs border border-border-strong rounded" placeholder="Search staff or agent by name / code…"
            value={q} onChange={(e) => setQ(e.target.value)} />
          {q.trim().length >= 2 && (search.data?.rows.length ?? 0) > 0 && (
            <div className="mt-1.5 flex flex-col gap-1 max-h-40 overflow-y-auto">
              {search.data!.rows.map((p) => (
                <button key={`${p.kind}-${p.id}`} disabled={assign.isPending} onClick={() => assign.mutate(p.code)}
                  className="text-left text-xs px-2 py-1 rounded hover:bg-surface border border-transparent hover:border-border">
                  {p.full_name} <span className="font-mono text-text-muted">{p.code}</span> <span className="text-text-muted">· {p.kind}</span>
                </button>
              ))}
            </div>
          )}
          {q.trim().length >= 2 && (search.data?.rows.length ?? 0) === 0 && !search.isLoading && (
            <div className="text-xs text-text-muted mt-1">No staff or agent matches “{q.trim()}”.</div>
          )}
          {err && <div className="text-xs text-danger mt-1">{err}</div>}
        </div>
      )}
    </div>
  );
}

export function ApprovalsPage() {
  const qc = useQueryClient();
  const [msg, setMsg] = useState('');
  const [openId, setOpenId] = useState<number | null>(null);
  const { data, isLoading, error } = useQuery({ queryKey: ['approvals'], queryFn: () => api.get<{ rows: ApprovalReq[] }>('/api/approvals/queue') });
  const uiConfig = useQuery({ queryKey: ['ui-config'], queryFn: () => api.get<{ values: Record<string, unknown> }>('/api/settings/ui-config') });
  const waiverEnabled = uiConfig.data?.values['redemption.premature_penalty_waiver_enabled'] !== false;

  const act = useMutation({
    mutationFn: (v: { id: number; action: 'approve' | 'reject'; reason?: string }) =>
      api.post(`/api/approvals/${v.id}/${v.action}`, v.action === 'reject' ? { reason: v.reason } : {}),
    onSuccess: () => { setMsg(''); qc.invalidateQueries({ queryKey: ['approvals'] }); },
    onError: (e) => setMsg(e instanceof ApiError ? e.message : 'Failed'),
  });

  if (isLoading) return <div className="text-text-muted">Loading approvals…</div>;
  if (error) return <div className="text-danger">Failed to load approvals.</div>;

  return (
    <div className="w-full">
      <h1 className="text-xl font-bold tracking-tight m-0">Approvals</h1>
      <p className="text-sm text-text-muted mt-1 mb-5">Requests waiting on a checker. You can't approve your own submissions.</p>
      {msg && <div className="text-xs text-danger mb-3">{msg}</div>}
      {groupsOf(data!.rows).map(([type, rows]) => (
      <div key={type} className="mb-5">
        <h2 className="text-xs font-semibold text-text-label uppercase tracking-wide mb-2">
          {TYPE_LABELS[type] ?? type} <span className="text-text-muted">({rows.length})</span>
        </h2>
        <div className="bg-surface border border-border rounded-lg shadow-card divide-y divide-border">
        {rows.map((r) => (
          <div key={r.id}>
            <div className="p-4 flex items-center gap-4">
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold flex items-center gap-2 flex-wrap">
                  <span>{requestTitle(r)}</span>
                  {r.amount != null && <span className="mono text-primary">{formatINR(r.amount)}</span>}
                  {r.max_levels > 1 && <span className="text-xs text-text-muted font-normal">level {r.level} of {r.max_levels}</span>}
                </div>
                {r.subject && <div className="text-sm text-text mt-0.5 truncate">{r.subject}</div>}
                <div className="text-xs text-text-muted font-mono mt-0.5">{r.request_no}</div>
              </div>
              {!r.canAct && (
                <button onClick={() => setOpenId(openId === r.id ? null : r.id)} className="text-xs text-primary hover:underline">
                  {openId === r.id ? 'Hide' : 'Details'}
                </button>
              )}
              {r.canAct ? (
                <div className="flex gap-2">
                  <button onClick={() => setOpenId(openId === r.id ? null : r.id)}
                    className="text-xs bg-primary text-white rounded px-3 py-1.5 hover:bg-primary-hover">
                    {openId === r.id ? 'Close' : (r.request_type === 'app_investment' ? 'Review & acknowledge' : 'Review & approve')}
                  </button>
                  {r.request_type !== 'app_investment' && (
                    <button onClick={() => {
                      const reason = window.prompt('Reason for rejection:');
                      if (reason && reason.trim().length >= 2) act.mutate({ id: r.id, action: 'reject', reason: reason.trim() });
                    }} className="text-xs border border-border text-danger rounded px-3 py-1.5 hover:bg-[color:var(--danger-bg)]">Reject</button>
                  )}
                </div>
              ) : (
                <span className="text-xs text-text-muted italic">awaiting another checker</span>
              )}
            </div>
            {r.canAct && r.request_type === 'premature_redemption' && waiverEnabled && (
              <PrematureWaive
                redemptionId={Number(r.metadata.redemption_id)}
                penalty={Number(r.metadata.penalty ?? 0)}
                netPayment={Number(r.metadata.net_payment ?? 0)}
                waived={r.metadata.penalty_waived === true}
                onDone={() => qc.invalidateQueries({ queryKey: ['approvals'] })}
              />
            )}
            {r.canAct && r.request_type === 'app_investment' && r.entity_id && (
              <AppInvestmentNotice
                appId={Number(r.entity_id)}
                amount={r.metadata.amount != null ? Number(r.metadata.amount) : null}
                needsAttribution={r.metadata.needs_attribution === true}
                referredBy={r.metadata.referred_by ? String(r.metadata.referred_by) : null}
                onDone={() => qc.invalidateQueries({ queryKey: ['approvals'] })}
              />
            )}
            {openId === r.id && (
              <Detail id={r.id} canAct={r.canAct} selfApproval={r.selfApproval}
                actionLabel={r.request_type === 'app_investment' ? 'Confirm acknowledgement' : 'Confirm approval'}
                onDone={() => { setOpenId(null); qc.invalidateQueries({ queryKey: ['approvals'] }); }} />
            )}
          </div>
        ))}
        </div>
      </div>
      ))}
      {data!.rows.length === 0 && (
        <div className="bg-surface border border-border rounded-lg shadow-card p-6 text-center text-text-muted">
          Nothing awaiting your approval.
        </div>
      )}
    </div>
  );
}

/** Queue grouped by request type so it's obvious what kinds of approval are
 * pending and how many of each. Order follows the queue (newest first). */
function groupsOf(rows: ApprovalReq[]): Array<[string, ApprovalReq[]]> {
  const by = new Map<string, ApprovalReq[]>();
  for (const r of rows) {
    const g = by.get(r.request_type) ?? [];
    g.push(r);
    by.set(r.request_type, g);
  }
  return [...by.entries()];
}

interface Editable {
  application_id: number;
  has_receipt: boolean;
  readonly: Record<string, string>;
  fields: {
    total_amount: number; date_money_received: string; collection_method: string;
    collection_reference: string; referred_by_text: string;
  };
}

const RO_LABELS: Array<[string, string]> = [
  ['customer', 'Customer'], ['pan', 'PAN'], ['application_no', 'Reference no.'],
  ['series', 'Series'], ['scheme', 'Scheme'], ['rate', 'Rate'], ['tenure', 'Tenure'],
  ['created_at', 'Entered on'], ['interest_start', 'Interest starts'], ['status', 'Current status'],
];
const FIELD_LABELS: Array<[keyof Editable['fields'], string, string]> = [
  ['total_amount', 'Investment amount', 'number'],
  ['date_money_received', 'Money received on', 'date'],
  ['collection_method', 'Payment method', 'text'],
  ['collection_reference', 'Payment reference / UTR', 'text'],
  ['referred_by_text', 'Referred by (code or name)', 'text'],
];

/** The maker's input, pre-filled and correctable by the approver. Approving with
 * corrections applies them to the investment first, then approves. */
function EditableInvestment({ ed, id, canAct, selfApproval, actionLabel, onDone }: { ed: Editable; id: number; canAct: boolean; selfApproval?: boolean; actionLabel: string; onDone: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState(ed.fields);
  const [err, setErr] = useState('');
  const [selfReason, setSelfReason] = useState('');
  const blocked = !!selfApproval && selfReason.trim().length < 3;
  const dirty = (Object.keys(ed.fields) as Array<keyof Editable['fields']>).some((k) => String(f[k] ?? '') !== String(ed.fields[k] ?? ''));
  const approveWithEdits = useMutation({
    mutationFn: () => api.post(`/api/approvals/${id}/approve`, { extra: { edits: f, ...(selfApproval ? { self_approval_reason: selfReason.trim() } : {}) } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['approval', id] }); onDone(); },
    onError: (e) => setErr(e instanceof ApiError ? e.message : 'Failed to approve'),
  });
  const inp = 'px-2.5 py-1.5 text-xs border border-border-strong rounded outline-none focus:border-primary w-full';
  return (
    <div className="bg-bg rounded p-3">
      <div className="text-xs font-semibold text-text-label uppercase tracking-wide mb-2">Investment details</div>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-xs mb-3">
        {RO_LABELS.filter(([k]) => ed.readonly[k]).map(([k, label]) => (
          <span key={k} className="contents">
            <dt className="text-text-muted">{label}</dt>
            <dd className="m-0 font-medium break-words">{ed.readonly[k]}</dd>
          </span>
        ))}
      </dl>
      <div className="mb-2 text-xs">
        {ed.has_receipt
          ? <a href={`/api/applications/${ed.application_id}/receipt`} target="_blank" rel="noreferrer" className="text-primary hover:underline">📎 View receipt / cheque photo</a>
          : <span className="text-text-muted">No receipt attached.</span>}
      </div>
      <div className="text-xs text-text-muted mb-2">
        Entered by the maker — correct anything that's wrong before approving.
        Interest starts from the money-received date (or the series deemed date, whichever is later).
      </div>
      <div className="grid grid-cols-2 gap-2">
        {FIELD_LABELS.map(([key, label, type]) => (
          <label key={key} className="text-xs">
            <span className="block text-text-muted mb-0.5">{label}</span>
            {key === 'referred_by_text' ? (
              <ReferredByPicker className={inp} value={String(f.referred_by_text ?? '')}
                onChange={(v) => setF({ ...f, referred_by_text: v })} />
            ) : (
              <input className={inp} type={type} value={String(f[key] ?? '')}
                onChange={(e) => setF({ ...f, [key]: type === 'number' ? Number(e.target.value) : e.target.value })} />
            )}
          </label>
        ))}
      </div>
      {err && <div className="text-xs text-danger mt-2">{err}</div>}
      {canAct && selfApproval && <SelfApprovalReason value={selfReason} onChange={setSelfReason} />}
      {canAct && (
        <div className="flex gap-2 items-center mt-3 border-t border-border pt-3">
          <button onClick={() => approveWithEdits.mutate()} disabled={approveWithEdits.isPending || blocked}
            className="text-xs bg-primary text-white rounded px-4 py-1.5 disabled:opacity-40 hover:bg-primary-hover">
            {dirty ? `${actionLabel} (with corrections)` : actionLabel}
          </button>
          {dirty && <button onClick={() => { setErr(''); setF(ed.fields); }} className="text-xs text-text-muted hover:underline">Undo changes</button>}
          <span className="text-xs text-text-muted">Check the details above before confirming.</span>
        </div>
      )}
    </div>
  );
}

/** Super Admin overriding the two-person rule on their own submission: the
 * reason is mandatory and is stored on the request + audit trail. */
function SelfApprovalReason({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="mt-2 bg-[color:var(--danger-bg)] border border-danger/40 rounded p-2.5">
      <div className="text-xs text-danger font-semibold mb-1">You submitted this request</div>
      <div className="text-xs text-text-muted mb-1.5">
        Approving your own submission bypasses the two-person rule. A reason is required and is recorded in the audit trail.
      </div>
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder="Reason for self-approval (required)"
        className="w-full px-2.5 py-1.5 text-xs border border-border-strong rounded outline-none focus:border-primary" />
    </div>
  );
}

/** Two-step confirm for requests that have no editable investment form. */
function ConfirmApproval({ id, label, selfApproval, onDone }: { id: number; label: string; selfApproval?: boolean; onDone: () => void }) {
  const qc = useQueryClient();
  const [err, setErr] = useState('');
  const [selfReason, setSelfReason] = useState('');
  const blocked = !!selfApproval && selfReason.trim().length < 3;
  const go = useMutation({
    mutationFn: () => api.post(`/api/approvals/${id}/approve`, selfApproval ? { extra: { self_approval_reason: selfReason.trim() } } : {}),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['approval', id] }); onDone(); },
    onError: (e) => setErr(e instanceof ApiError ? e.message : 'Failed to approve'),
  });
  return (
    <div className="mt-2 border-t border-border pt-3">
      {selfApproval && <SelfApprovalReason value={selfReason} onChange={setSelfReason} />}
      <div className="flex gap-2 items-center mt-2">
      <button onClick={() => go.mutate()} disabled={go.isPending || blocked}
        className="text-xs bg-primary text-white rounded px-4 py-1.5 disabled:opacity-40 hover:bg-primary-hover">{label}</button>
      <span className="text-xs text-text-muted">Check the details above before confirming.</span>
      {err && <span className="text-xs text-danger">{err}</span>}
      </div>
    </div>
  );
}
