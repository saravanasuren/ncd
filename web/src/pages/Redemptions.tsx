import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { formatINR } from '@new-wealth/shared';
import { api, ApiError } from '../api/client.js';
import { useAuth } from '../auth/AuthContext.js';
import { useState } from 'react';

interface Redemption {
  id: number; redemption_no: string; type: string; status: string; source: string;
  requested_by_customer: boolean; principal: string; penalty: string; net_payment: string;
  application_no: string; customer_name: string; approval_request_id: number | null;
}

const pill: Record<string, string> = {
  Approved: 'bg-[color:var(--success-bg)] text-success',
  Requested: 'bg-[color:var(--warn-bg)] text-warn',
};

export function RedemptionsPage() {
  const qc = useQueryClient();
  const { can } = useAuth();
  const [msg, setMsg] = useState('');
  const { data, isLoading } = useQuery({ queryKey: ['redemptions'], queryFn: () => api.get<{ rows: Redemption[] }>('/api/redemptions') });

  const submit = useMutation({
    mutationFn: (id: number) => api.post(`/api/redemptions/${id}/submit-for-approval`),
    onSuccess: () => { setMsg('Sent to the approvals queue (needs two checkers).'); qc.invalidateQueries({ queryKey: ['redemptions'] }); },
    onError: (e) => setMsg(e instanceof ApiError ? e.message : 'Failed'),
  });

  if (isLoading) return <div className="text-text-muted">Loading…</div>;
  const requests = data!.rows.filter((r) => r.status === 'Requested' && !r.approval_request_id);
  const rest = data!.rows.filter((r) => !(r.status === 'Requested' && !r.approval_request_id));

  return (
    <div className="max-w-4xl">
      <h1 className="text-xl font-bold tracking-tight m-0">Redemptions</h1>
      <p className="text-sm text-text-muted mt-1 mb-5">Customer/app requests waiting to be processed, plus recent redemptions.</p>
      {msg && <div className="text-xs text-primary mb-3">{msg}</div>}

      {requests.length > 0 && (
        <>
          <h2 className="text-xs font-semibold text-text-label uppercase tracking-wide mb-2">Requests awaiting processing</h2>
          <div className="bg-surface border border-border rounded-lg shadow-card divide-y divide-border mb-6">
            {requests.map((r) => (
              <div key={r.id} className="p-4 flex items-center gap-4 text-sm">
                <div className="flex-1">
                  <div className="font-semibold">{r.customer_name} <span className="font-mono text-xs text-text-muted">{r.application_no}</span></div>
                  <div className="text-xs text-text-muted">Net {formatINR(r.net_payment)} · penalty {formatINR(r.penalty)} · from {r.source}{r.requested_by_customer ? ' (customer)' : ''}</div>
                </div>
                {can('redemptions:initiate') && (
                  <button onClick={() => { setMsg(''); submit.mutate(r.id); }} className="text-xs bg-primary text-white rounded px-3 py-1.5 hover:bg-primary-hover">Send for approval</button>
                )}
              </div>
            ))}
          </div>
        </>
      )}

      <h2 className="text-xs font-semibold text-text-label uppercase tracking-wide mb-2">All redemptions</h2>
      <div className="bg-surface border border-border rounded-lg shadow-card overflow-hidden">
        <table className="w-full text-sm">
          <thead><tr className="text-left text-xs font-semibold text-text-label border-b border-border">
            <th className="px-4 py-2">Ref</th><th className="px-4 py-2">Customer</th><th className="px-4 py-2">Type</th>
            <th className="px-4 py-2 text-right">Net</th><th className="px-4 py-2">Status</th></tr></thead>
          <tbody className="divide-y divide-border">
            {rest.map((r) => (
              <tr key={r.id}>
                <td className="px-4 py-1.5 font-mono text-xs">{r.redemption_no}</td>
                <td className="px-4 py-1.5">{r.customer_name}</td>
                <td className="px-4 py-1.5">{r.type}</td>
                <td className="px-4 py-1.5 text-right mono">{formatINR(r.net_payment)}</td>
                <td className="px-4 py-1.5"><span className={`text-xs rounded px-1.5 py-0.5 ${pill[r.status] ?? 'bg-bg'}`}>{r.status}</span></td>
              </tr>
            ))}
            {rest.length === 0 && <tr><td colSpan={5} className="px-4 py-6 text-center text-text-muted">No redemptions yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
