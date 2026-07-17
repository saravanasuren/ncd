import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
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
};

/** Expanded row: full request payload from GET /api/approvals/:id. */
function Detail({ id }: { id: number }) {
  const { data, isLoading } = useQuery({
    queryKey: ['approval', id],
    queryFn: () => api.get<{ request: Record<string, unknown> }>(`/api/approvals/${id}`),
  });
  if (isLoading) return <div className="text-xs text-text-muted px-4 pb-3">Loading detail…</div>;
  const r = data?.request ?? {};
  const skip = new Set(['id', 'canAct']);
  const entries = Object.entries(r).filter(([k, v]) => !skip.has(k) && v != null && v !== '');
  return (
    <div className="px-4 pb-4">
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs bg-bg rounded p-3">
        {entries.map(([k, v]) => (
          <span key={k} className="contents">
            <dt className="text-text-muted">{k}</dt>
            <dd className="m-0 font-mono break-all">{typeof v === 'object' ? JSON.stringify(v, null, 1) : String(v)}</dd>
          </span>
        ))}
      </dl>
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
                <div className="text-sm font-semibold">{TYPE_LABELS[r.request_type] ?? r.request_type}
                  {r.max_levels > 1 && <span className="text-xs text-text-muted font-normal"> · level {r.level} of {r.max_levels}</span>}
                </div>
                <div className="text-xs text-text-muted font-mono">{r.request_no}{r.metadata.customerName ? ` · ${String(r.metadata.customerName)}` : ''}</div>
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
