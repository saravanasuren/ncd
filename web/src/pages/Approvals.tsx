import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { formatINR } from '@new-wealth/shared';
import { api, ApiError } from '../api/client.js';

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
}

const TYPE_LABELS: Record<string, string> = {
  customer_creation: 'New Customer',
  customer_correction: 'Customer Correction',
  customer_reassignment: 'Customer Handover',
  subscription: 'Application',
  premature_redemption: 'Premature Redemption',
  redemption: 'Redemption',
  rollover: 'Rollover',
  ncd_transfer: 'Holder Transfer',
  ncd_transformation: 'Transformation',
  agent_registration: 'Agent Registration',
  activation_batch: 'Activation',
  allotment_batch: 'Allotment',
  user_verification: 'User Verification',
  app_investment: 'App investment (live)',
};

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

function Detail({ id }: { id: number }) {
  const { data, isLoading } = useQuery({
    queryKey: ['approval', id],
    queryFn: () => api.get<{ request: Record<string, unknown>; covered: CoveredRow[] | null }>(`/api/approvals/${id}`),
  });
  const [showRaw, setShowRaw] = useState(false);
  if (isLoading) return <div className="text-xs text-text-muted px-4 pb-3">Loading detail…</div>;
  const r = data?.request ?? {};
  const covered = data?.covered ?? null;
  const skip = new Set(['id', 'canAct']);
  const entries = Object.entries(r).filter(([k, v]) => !skip.has(k) && v != null && v !== '');
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
          <button onClick={() => setShowRaw(!showRaw)} className="text-xs text-text-muted hover:text-primary mt-2">
            {showRaw ? 'Hide request record' : 'Show request record'}
          </button>
        </div>
      )}
      {(!covered || showRaw) && (
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs bg-bg rounded p-3">
          {entries.map(([k, v]) => (
            <span key={k} className="contents">
              <dt className="text-text-muted">{k}</dt>
              <dd className="m-0 font-mono break-all">{typeof v === 'object' ? JSON.stringify(v, null, 1) : String(v)}</dd>
            </span>
          ))}
        </dl>
      )}
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
  const { data, isLoading } = useQuery({ queryKey: ['approvals'], queryFn: () => api.get<{ rows: ApprovalReq[] }>('/api/approvals/queue') });
  const uiConfig = useQuery({ queryKey: ['ui-config'], queryFn: () => api.get<{ values: Record<string, unknown> }>('/api/settings/ui-config') });
  const waiverEnabled = uiConfig.data?.values['redemption.premature_penalty_waiver_enabled'] !== false;

  const act = useMutation({
    mutationFn: (v: { id: number; action: 'approve' | 'reject'; reason?: string }) =>
      api.post(`/api/approvals/${v.id}/${v.action}`, v.action === 'reject' ? { reason: v.reason } : {}),
    onSuccess: () => { setMsg(''); qc.invalidateQueries({ queryKey: ['approvals'] }); },
    onError: (e) => setMsg(e instanceof ApiError ? e.message : 'Failed'),
  });

  if (isLoading) return <div className="text-text-muted">Loading approvals…</div>;

  return (
    <div className="w-full">
      <h1 className="text-xl font-bold tracking-tight m-0">Approvals</h1>
      <p className="text-sm text-text-muted mt-1 mb-5">Requests waiting on a checker. You can't approve your own submissions.</p>
      {msg && <div className="text-xs text-danger mb-3">{msg}</div>}
      <div className="bg-surface border border-border rounded-lg shadow-card divide-y divide-border">
        {data!.rows.map((r) => (
          <div key={r.id}>
            <div className="p-4 flex items-center gap-4">
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold">{requestTitle(r)}
                  {r.max_levels > 1 && <span className="text-xs text-text-muted font-normal"> · level {r.level} of {r.max_levels}</span>}
                </div>
                <div className="text-xs text-text-muted font-mono">{r.request_no}
                  {r.metadata.customerName ? ` · ${String(r.metadata.customerName)}` : ''}
                  {r.request_type === 'user_verification' ? ` · ${String(r.metadata.name ?? '')} (${String(r.metadata.kind ?? '')}) · ${String(r.metadata.mobile ?? '')}` : ''}
                </div>
              </div>
              <button onClick={() => setOpenId(openId === r.id ? null : r.id)} className="text-xs text-primary hover:underline">
                {openId === r.id ? 'Hide' : 'Details'}
              </button>
              {r.canAct ? (
                <div className="flex gap-2">
                  <button onClick={() => act.mutate({ id: r.id, action: 'approve' })} className="text-xs bg-primary text-white rounded px-3 py-1.5 hover:bg-primary-hover">
                    {r.request_type === 'app_investment' ? 'Acknowledge' : 'Approve'}
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
            {openId === r.id && <Detail id={r.id} />}
          </div>
        ))}
        {data!.rows.length === 0 && <div className="p-6 text-center text-text-muted">Nothing awaiting your approval.</div>}
      </div>
    </div>
  );
}
