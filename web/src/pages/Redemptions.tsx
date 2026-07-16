import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { formatINR } from '@new-wealth/shared';
import { api, ApiError } from '../api/client.js';
import { useAuth } from '../auth/AuthContext.js';
import { useState } from 'react';
import { DataTable, type Column } from '../components/DataTable.js';

interface Redemption {
  id: number; redemption_no: string; type: string; status: string; source: string;
  requested_by_customer: boolean; principal: string; penalty: string; net_payment: string;
  application_no: string; customer_name: string; approval_request_id: number | null;
}

const pill: Record<string, string> = {
  Approved: 'bg-[color:var(--success-bg)] text-success',
  Requested: 'bg-[color:var(--warn-bg)] text-warn',
};

const columns: Column<Redemption>[] = [
  { key: 'redemption_no', header: 'Ref', tdClassName: 'font-mono text-xs' },
  { key: 'customer_name', header: 'Customer' },
  { key: 'type', header: 'Type' },
  { key: 'net_payment', header: 'Net', align: 'right',
    value: (r) => Number(r.net_payment), render: (r) => <span className="mono">{formatINR(r.net_payment)}</span> },
  { key: 'status', header: 'Status',
    render: (r) => <span className={`text-xs rounded px-1.5 py-0.5 ${pill[r.status] ?? 'bg-bg'}`}>{r.status}</span> },
];

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
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-xl font-bold tracking-tight m-0">Redemptions</h1>
          <p className="text-sm text-text-muted mt-1">Customer/app requests waiting to be processed, plus recent redemptions. To initiate a premature or maturity redemption, open the investment under Applications and use its lifecycle actions.</p>
        </div>
        <div className="flex gap-2">
          <a href="/api/redemptions/neft.xlsx" className="text-xs border border-border rounded px-3 py-1.5 hover:bg-bg no-underline">↓ NEFT sheet</a>
          <a href="/api/redemptions/report.xlsx" className="text-xs border border-border rounded px-3 py-1.5 hover:bg-bg no-underline">↓ Report</a>
        </div>
      </div>
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
      <DataTable
        columns={columns}
        rows={rest}
        rowKey={(r) => r.id}
        defaultSort={{ key: 'redemption_no', dir: 'desc' }}
        empty="No redemptions yet."
      />
    </div>
  );
}
