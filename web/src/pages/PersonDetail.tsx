import { useParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { formatINR } from '@new-wealth/shared';
import { api } from '../api/client.js';
import { useAuth } from '../auth/AuthContext.js';
import { DataTable, type Column } from '../components/DataTable.js';

interface Investment {
  id: number; application_no: string; customer: string; series_code: string;
  total_amount: number; status: string; date_money_received: string | null;
}
interface Perf {
  person: { id: number; type: 'staff' | 'agent'; full_name: string; code: string; phone: string | null; email: string | null };
  kpis: { customers: number; investments: number; live_investments: number; invested: number; outstanding: number };
  incentives: { accrued: number; paid: number; balance: number };
  investments: Investment[];
}

const card = 'bg-surface border border-border rounded-lg shadow-card p-5';

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className={card}>
      <div className="text-xs font-semibold text-text-label uppercase tracking-wide">{label}</div>
      <div className="text-2xl font-bold mt-1 mono">{value}</div>
      {sub && <div className="text-xs text-text-muted mt-0.5">{sub}</div>}
    </div>
  );
}

/** Enroller (branch-staff or agent) performance — reached from universal search. */
export function PersonDetailPage() {
  const { type, id } = useParams();
  const { can } = useAuth();
  const kind = type === 'agent' ? 'agent' : 'staff';
  const { data, isLoading, error } = useQuery({
    queryKey: ['person', kind, id],
    queryFn: () => api.get<Perf>(`/api/dashboard/person/${kind}/${id}`),
  });

  if (isLoading) return <div className="text-text-muted">Loading…</div>;
  if (error || !data) return <div className="text-danger">Not found or out of scope.</div>;
  const p = data.person;

  const columns: Column<Investment>[] = [
    { key: 'application_no', header: 'App no', tdClassName: 'font-mono text-xs',
      render: (r) => <Link to={`/app/applications/${r.id}`} className="text-primary hover:underline">{r.application_no}</Link> },
    { key: 'customer', header: 'Customer' },
    { key: 'series_code', header: 'Series', tdClassName: 'text-text-muted' },
    { key: 'total_amount', header: 'Amount', align: 'right', value: (r) => Number(r.total_amount), render: (r) => <span className="mono">{formatINR(r.total_amount)}</span> },
    { key: 'status', header: 'Status', render: (r) => <span className="text-xs rounded px-1.5 py-0.5 bg-bg">{r.status}</span> },
    { key: 'date_money_received', header: 'Received', tdClassName: 'text-text-muted', render: (r) => r.date_money_received ?? '—' },
  ];

  return (
    <div className="w-full">
      <Link to="/app/dashboard" className="text-xs text-text-muted hover:text-primary">← Dashboard</Link>
      <div className="flex items-center gap-3 mt-1">
        <h1 className="text-xl font-bold tracking-tight m-0">{p.full_name}</h1>
        <span className="text-xs rounded px-1.5 py-0.5 bg-bg">{p.type === 'agent' ? `Agent · ${p.code}` : `Staff · ${p.code}`}</span>
      </div>
      <p className="text-sm text-text-muted mt-1">{[p.phone, p.email].filter(Boolean).join(' · ') || '—'}</p>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-4">
        <Kpi label="Customers" value={String(data.kpis.customers)} />
        <Kpi label="Investments" value={String(data.kpis.investments)} sub={`${data.kpis.live_investments} live`} />
        <Kpi label="Money brought in" value={formatINR(data.kpis.invested)} sub={`${formatINR(data.kpis.outstanding)} outstanding`} />
        <Kpi label="Incentives" value={formatINR(data.incentives.balance)} sub={`${formatINR(data.incentives.accrued)} earned · ${formatINR(data.incentives.paid)} paid`} />
      </div>

      <div className="flex items-center justify-between mt-6 mb-2">
        <h2 className="text-xs font-semibold text-text-label uppercase tracking-wide">Investments sourced</h2>
        {can('incentives:manage-eligibility') && (
          <a href={`/api/incentives/payees/${p.type}/${p.id}/statement.pdf`} target="_blank" rel="noreferrer" className="text-xs text-primary hover:underline">↓ Incentive statement</a>
        )}
      </div>
      <DataTable columns={columns} rows={data.investments} rowKey={(r) => r.id} defaultSort={{ key: 'application_no', dir: 'desc' }} empty="No investments sourced yet." />
    </div>
  );
}
