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

export function ApprovalsPage() {
  const qc = useQueryClient();
  const [msg, setMsg] = useState('');
  const [openId, setOpenId] = useState<number | null>(null);
  const { data, isLoading } = useQuery({ queryKey: ['approvals'], queryFn: () => api.get<{ rows: ApprovalReq[] }>('/api/approvals/queue') });

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
                  <button onClick={() => act.mutate({ id: r.id, action: 'approve' })} className="text-xs bg-primary text-white rounded px-3 py-1.5 hover:bg-primary-hover">Approve</button>
                  <button onClick={() => {
                    const reason = window.prompt('Reason for rejection:');
                    if (reason && reason.trim().length >= 2) act.mutate({ id: r.id, action: 'reject', reason: reason.trim() });
                  }} className="text-xs border border-border text-danger rounded px-3 py-1.5 hover:bg-[color:var(--danger-bg)]">Reject</button>
                </div>
              ) : (
                <span className="text-xs text-text-muted italic">awaiting another checker</span>
              )}
            </div>
            {openId === r.id && <Detail id={r.id} />}
          </div>
        ))}
        {data!.rows.length === 0 && <div className="p-6 text-center text-text-muted">Nothing awaiting your approval.</div>}
      </div>
    </div>
  );
}
