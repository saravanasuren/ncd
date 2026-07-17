import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { formatINR } from '@new-wealth/shared';
import { api, ApiError } from '../api/client.js';
import { useAuth } from '../auth/AuthContext.js';
import { DataTable, type Column } from '../components/DataTable.js';

interface Payee { payee_type: string; payee_id: number; accrued: string; paid: string; balance: string; }
interface Referrer { id: number; display_name: string; eligibility_status: string; }

export function IncentivesPage() {
  const qc = useQueryClient();
  const { can } = useAuth();
  const [msg, setMsg] = useState('');
  const overview = useQuery({ queryKey: ['inc-overview'], queryFn: () => api.get<{ rows: Payee[] }>('/api/incentives/overview') });
  const referrers = useQuery({ queryKey: ['inc-referrers'], queryFn: () => api.get<{ rows: Referrer[] }>('/api/incentives/referrers') });

  const pay = useMutation({
    mutationFn: (v: { type: string; id: number; amount: number }) => api.post(`/api/incentives/payees/${v.type}/${v.id}/pay`, { amount: v.amount }),
    onSuccess: () => { setMsg('Payout recorded.'); qc.invalidateQueries({ queryKey: ['inc-overview'] }); },
    onError: (e) => setMsg(e instanceof ApiError ? e.message : 'Failed'),
  });
  const setRef = useMutation({
    mutationFn: (v: { id: number; status: string }) => api.post(`/api/incentives/referrers/${v.id}/eligibility`, { status: v.status }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['inc-referrers'] }),
    onError: (e) => setMsg(e instanceof ApiError ? e.message : 'Failed'),
  });

  return (
    <div className="w-full">
      <h1 className="text-xl font-bold tracking-tight m-0">Incentives & commissions</h1>
      <p className="text-sm text-text-muted mt-1 mb-5">Balances owed to staff, agents and referrers.</p>
      {msg && <div className="text-xs text-primary mb-3">{msg}</div>}

      <h2 className="text-xs font-semibold text-text-label uppercase tracking-wide mb-2">Balances</h2>
      <div className="mb-6">
        <DataTable
          columns={[
            { key: 'payee', header: 'Payee', value: (p) => `${p.payee_type} #${p.payee_id}`, render: (p) => `${p.payee_type} #${p.payee_id}` },
            { key: 'accrued', header: 'Accrued', align: 'right', value: (p) => Number(p.accrued), render: (p) => <span className="mono">{formatINR(p.accrued)}</span> },
            { key: 'paid', header: 'Paid', align: 'right', value: (p) => Number(p.paid), render: (p) => <span className="mono text-text-muted">{formatINR(p.paid)}</span> },
            { key: 'balance', header: 'Balance', align: 'right', value: (p) => Number(p.balance), render: (p) => <span className="mono font-semibold">{formatINR(p.balance)}</span> },
            { key: 'actions', header: '', sortable: false, filterable: false, align: 'right',
              render: (p) => <PayActions p={p} canPay={can('incentives:pay')} onPay={(amount) => { setMsg(''); pay.mutate({ type: p.payee_type, id: p.payee_id, amount }); }} /> },
          ] as Column<Payee>[]}
          rows={overview.data?.rows ?? []}
          rowKey={(p) => `${p.payee_type}-${p.payee_id}`}
          defaultSort={{ key: 'balance', dir: 'desc' }}
          empty="No accruals yet."
        />
      </div>

      <h2 className="text-xs font-semibold text-text-label uppercase tracking-wide mb-2">Referrers</h2>
      <div className="bg-surface border border-border rounded-lg shadow-card divide-y divide-border">
        {(referrers.data?.rows ?? []).map((r) => (
          <div key={r.id} className="p-4 flex items-center gap-3 text-sm">
            <span className="font-medium">{r.display_name}</span>
            <span className="text-xs rounded px-1.5 py-0.5 bg-bg">{r.eligibility_status}</span>
            {can('incentives:manage-eligibility') && (
              <div className="ml-auto flex gap-2">
                {r.eligibility_status !== 'Approved' && <button onClick={() => setRef.mutate({ id: r.id, status: 'Approved' })} className="text-xs bg-primary text-white rounded px-3 py-1.5">Approve</button>}
                {r.eligibility_status === 'Approved' && <button onClick={() => setRef.mutate({ id: r.id, status: 'Revoked' })} className="text-xs border border-border text-danger rounded px-3 py-1.5">Revoke</button>}
              </div>
            )}
          </div>
        ))}
        {(referrers.data?.rows ?? []).length === 0 && <div className="p-6 text-center text-text-muted">No referrers yet.</div>}
      </div>
    </div>
  );
}

function PayActions({ p, canPay, onPay }: { p: Payee; canPay: boolean; onPay: (amount: number) => void }) {
  const [amt, setAmt] = useState('');
  return (
    <div className="flex gap-1 justify-end items-center">
      <a href={`/api/incentives/payees/${p.payee_type}/${p.payee_id}/statement.pdf`} target="_blank" rel="noreferrer" className="text-xs text-text-muted hover:text-primary">PDF</a>
      {canPay && Number(p.balance) > 0 && (
        <>
          <input className="w-24 px-2 py-1 text-xs border border-border-strong rounded" placeholder="₹" value={amt} onChange={(e) => setAmt(e.target.value)} />
          <button disabled={!amt} onClick={() => { onPay(Number(amt)); setAmt(''); }} className="text-xs bg-primary text-white rounded px-2 py-1 disabled:opacity-40">Pay</button>
        </>
      )}
    </div>
  );
}
