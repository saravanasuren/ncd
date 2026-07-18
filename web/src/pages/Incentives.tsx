import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { formatINR } from '@new-wealth/shared';
import { api, ApiError } from '../api/client.js';
import { useAuth } from '../auth/AuthContext.js';
import { DataTable, type Column } from '../components/DataTable.js';
import { Tabs, type TabDef } from '../components/Tabs.js';

interface Payee { payee_type: string; payee_id: number; payee_name: string | null; investment_amount: string; accrued: string; paid: string; balance: string; }
interface Accrual { application_id: number; application_no: string; customer: string; customer_code: string; investment_amount: string; incentive_amount: string; paid: boolean; }
interface Referrer { id: number; display_name: string; eligibility_status: string; }
interface AgentRow { id: number; full_name: string; agent_code: string; commission_status: string; commission_rate_pct: number | null; }

export function IncentivesPage() {
  const qc = useQueryClient();
  const { can, user } = useAuth();
  const canRevert = user?.role === 'super_admin';
  const [msg, setMsg] = useState('');
  const [balTab, setBalTab] = useState<'staff' | 'agent'>('staff');
  const [expanded, setExpanded] = useState<string | null>(null);
  const overview = useQuery({ queryKey: ['inc-overview'], queryFn: () => api.get<{ rows: Payee[] }>('/api/incentives/overview') });
  const referrers = useQuery({ queryKey: ['inc-referrers'], queryFn: () => api.get<{ rows: Referrer[] }>('/api/incentives/referrers') });
  const agents = useQuery({ queryKey: ['inc-agents'], queryFn: () => api.get<{ rows: AgentRow[] }>('/api/incentives/agents'), enabled: can('incentives:manage-eligibility') });
  const [rate, setRate] = useState<Record<number, string>>({});
  const grantAgent = useMutation({
    mutationFn: (v: { id: number; rate_pct: number }) => api.post(`/api/incentives/agents/${v.id}/eligibility`, { rate_pct: v.rate_pct }),
    onSuccess: () => { setMsg('Agent commission sent for approval.'); qc.invalidateQueries({ queryKey: ['inc-agents'] }); },
    onError: (e) => setMsg(e instanceof ApiError ? e.message : 'Failed'),
  });
  const revokeAgent = useMutation({
    mutationFn: (id: number) => api.post(`/api/incentives/agents/${id}/eligibility/revoke`, {}),
    onSuccess: () => { setMsg('Agent commission revoked.'); qc.invalidateQueries({ queryKey: ['inc-agents'] }); },
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
      {(() => {
        const all = overview.data?.rows ?? [];
        // Staff tab = internal staff; Agent tab = external earners (agents + referrers).
        const isStaff = (p: Payee) => p.payee_type === 'staff';
        const staffRows = all.filter(isStaff);
        const agentRows = all.filter((p) => !isStaff(p));
        const balTabs: TabDef<'staff' | 'agent'>[] = [
          { key: 'staff', label: 'Staff', count: staffRows.length },
          { key: 'agent', label: 'Agent', count: agentRows.length },
        ];
        const shown = balTab === 'staff' ? staffRows : agentRows;
        return (
        <>
        <Tabs tabs={balTabs} active={balTab} onChange={setBalTab} />
        <div className="mb-6">
        <DataTable
          columns={[
            { key: 'payee', header: 'Payee', value: (p) => p.payee_name ?? `${p.payee_type} #${p.payee_id}`,
              render: (p) => (
                <span>
                  <span className="font-medium">{p.payee_name ?? `${p.payee_type} #${p.payee_id}`}</span>{' '}
                  <span className="text-xs text-text-muted capitalize">{p.payee_type}</span>
                </span>
              ) },
            { key: 'investment_amount', header: 'Investment', align: 'right', value: (p) => Number(p.investment_amount), render: (p) => <span className="mono">{formatINR(p.investment_amount)}</span> },
            { key: 'accrued', header: 'Accrued', align: 'right', value: (p) => Number(p.accrued), render: (p) => <span className="mono">{formatINR(p.accrued)}</span> },
            { key: 'paid', header: 'Paid', align: 'right', value: (p) => Number(p.paid), render: (p) => <span className="mono text-text-muted">{formatINR(p.paid)}</span> },
            { key: 'balance', header: 'Balance', align: 'right', value: (p) => Number(p.balance), render: (p) => <span className="mono font-semibold">{formatINR(p.balance)}</span> },
            { key: 'actions', header: '', sortable: false, filterable: false, align: 'right',
              render: (p) => {
                const key = `${p.payee_type}-${p.payee_id}`;
                return (
                  <div className="flex gap-2 justify-end items-center whitespace-nowrap">
                    <a href={`/api/incentives/payees/${p.payee_type}/${p.payee_id}/statement.pdf`} target="_blank" rel="noreferrer" className="text-xs text-text-muted hover:text-primary">PDF</a>
                    <button onClick={() => setExpanded(expanded === key ? null : key)} className="text-xs text-primary hover:underline">
                      {expanded === key ? 'Hide' : 'By customer ▾'}
                    </button>
                  </div>
                );
              } },
          ] as Column<Payee>[]}
          rows={shown}
          rowKey={(p) => `${p.payee_type}-${p.payee_id}`}
          defaultSort={{ key: 'balance', dir: 'desc' }}
          empty={balTab === 'staff' ? 'No staff accruals yet.' : 'No agent/referrer accruals yet.'}
          renderExpanded={(p) => expanded === `${p.payee_type}-${p.payee_id}`
            ? <PayeeAccruals p={p} canPay={can('incentives:pay')} canRevert={canRevert}
                onPaid={() => { setMsg('Incentive paid.'); qc.invalidateQueries({ queryKey: ['inc-overview'] }); }}
                onReverted={() => { setMsg('Payment reverted.'); qc.invalidateQueries({ queryKey: ['inc-overview'] }); }} />
            : null}
        />
        </div>
        </>
        );
      })()}

      {can('incentives:manage-eligibility') && (
        <>
          <h2 className="text-xs font-semibold text-text-label uppercase tracking-wide mb-2">Agent commissions</h2>
          <div className="bg-surface border border-border rounded-lg shadow-card divide-y divide-border mb-6">
            {(agents.data?.rows ?? []).map((ag) => (
              <div key={ag.id} className="p-4 flex items-center gap-3 text-sm flex-wrap">
                <span className="font-medium">{ag.full_name}</span>
                <span className="font-mono text-xs text-text-muted">{ag.agent_code}</span>
                <span className="text-xs rounded px-1.5 py-0.5 bg-bg">{ag.commission_status}{ag.commission_rate_pct != null ? ` · ${ag.commission_rate_pct}%` : ''}</span>
                <div className="ml-auto flex gap-2 items-center">
                  {ag.commission_status !== 'Approved' && (
                    <>
                      <input className="w-20 px-2 py-1 text-xs border border-border-strong rounded" placeholder="rate %"
                        value={rate[ag.id] ?? ''} onChange={(e) => setRate((s) => ({ ...s, [ag.id]: e.target.value }))} />
                      <button disabled={!rate[ag.id] || Number(rate[ag.id]) <= 0 || grantAgent.isPending}
                        onClick={() => { setMsg(''); grantAgent.mutate({ id: ag.id, rate_pct: Number(rate[ag.id]) }); }}
                        className="text-xs bg-primary text-white rounded px-3 py-1.5 disabled:opacity-40">Grant</button>
                    </>
                  )}
                  {ag.commission_status === 'Approved' && (
                    <button onClick={() => { setMsg(''); revokeAgent.mutate(ag.id); }} className="text-xs border border-border text-danger rounded px-3 py-1.5">Revoke</button>
                  )}
                </div>
              </div>
            ))}
            {(agents.data?.rows ?? []).length === 0 && <div className="p-6 text-center text-text-muted">No agents yet.</div>}
          </div>
        </>
      )}

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

/** Per-customer incentive breakdown for one payee, with pay-in-full per customer. */
function PayeeAccruals({ p, canPay, canRevert, onPaid, onReverted }: { p: Payee; canPay: boolean; canRevert: boolean; onPaid: () => void; onReverted: () => void }) {
  const qc = useQueryClient();
  const key = ['inc-accruals', p.payee_type, p.payee_id];
  const { data, isLoading } = useQuery({ queryKey: key, queryFn: () => api.get<{ rows: Accrual[] }>(`/api/incentives/payees/${p.payee_type}/${p.payee_id}/accruals`) });
  const payOne = useMutation({
    mutationFn: (applicationId: number) => api.post(`/api/incentives/payees/${p.payee_type}/${p.payee_id}/accruals/${applicationId}/pay`, {}),
    onSuccess: () => { qc.invalidateQueries({ queryKey: key }); onPaid(); },
  });
  const revertOne = useMutation({
    mutationFn: (applicationId: number) => api.post(`/api/incentives/payees/${p.payee_type}/${p.payee_id}/accruals/${applicationId}/revert-payment`, {}),
    onSuccess: () => { qc.invalidateQueries({ queryKey: key }); onReverted(); },
  });
  const rows = data?.rows ?? [];
  const th = 'py-1.5 px-3 text-xs font-semibold text-text-label uppercase tracking-wide';
  const td = 'py-1.5 px-3 align-middle text-sm';
  return (
    <div className="bg-bg p-3">
      {isLoading ? <div className="text-xs text-text-muted px-2 py-3">Loading…</div>
        : rows.length === 0 ? <div className="text-xs text-text-muted px-2 py-3">No eligible customers.</div> : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead><tr className="text-left border-b border-border">
              <th className={th}>Customer</th><th className={th}>App no</th>
              <th className={`${th} text-right`}>Investment</th><th className={`${th} text-right`}>Incentive</th>
              <th className={`${th} text-right`}>Status</th>
            </tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.application_id} className="border-b border-border/60 last:border-0">
                  <td className={td}>{r.customer} <span className="font-mono text-xs text-text-muted">{r.customer_code}</span></td>
                  <td className={`${td} font-mono text-xs`}>{r.application_no}</td>
                  <td className={`${td} text-right mono`}>{formatINR(r.investment_amount)}</td>
                  <td className={`${td} text-right mono font-semibold`}>{formatINR(r.incentive_amount)}</td>
                  <td className={`${td} text-right whitespace-nowrap`}>
                    {r.paid ? (
                      <span className="inline-flex items-center gap-2 justify-end">
                        <span className="text-xs text-success">Paid</span>
                        {canRevert && <button disabled={revertOne.isPending} onClick={() => revertOne.mutate(r.application_id)}
                          className="text-xs border border-border text-danger rounded px-2 py-1 disabled:opacity-40 hover:bg-[color:var(--danger-bg)]">Revert</button>}
                      </span>
                    ) : canPay ? <button disabled={payOne.isPending} onClick={() => payOne.mutate(r.application_id)}
                          className="text-xs bg-primary text-white rounded px-3 py-1 disabled:opacity-40 hover:bg-primary-hover">Pay</button>
                      : <span className="text-xs text-text-muted">Unpaid</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
