import { useQuery } from '@tanstack/react-query';
import { formatINR } from '@new-wealth/shared';
import { api } from '../api/client.js';
import { DataTable, type Column } from '../components/DataTable.js';

interface Accrual { application_no: string; accrual_date: string; amount: string; paid_at: string | null }
const accrualColumns: Column<Accrual>[] = [
  { key: 'application_no', header: 'Application', tdClassName: 'font-mono text-xs' },
  { key: 'accrual_date', header: 'Date', tdClassName: 'mono' },
  { key: 'amount', header: 'Amount', align: 'right', value: (r) => Number(r.amount), render: (r) => <span className="mono">{formatINR(r.amount)}</span> },
  { key: 'status', header: 'Status', value: (r) => (r.paid_at ? 'Paid' : 'Unpaid'), render: (r) => <span className="text-xs">{r.paid_at ? 'Paid' : 'Unpaid'}</span> },
];

export function MyEarningsPage() {
  const { data, isLoading, error } = useQuery({ queryKey: ['my-earnings'], queryFn: () => api.get<any>('/api/incentives/my-earnings') });
  if (isLoading) return <div className="text-text-muted">Loading…</div>;
  if (error) return <div className="text-danger">Failed to load earnings.</div>;
  return (
    <div className="max-w-2xl">
      <h1 className="text-xl font-bold tracking-tight m-0">My Earnings</h1>
      <p className="text-sm text-text-muted mt-1 mb-5">Your incentive accruals and payouts.</p>
      <div className="grid grid-cols-3 gap-3 mb-5">
        <Stat label="Accrued" value={data.accrued} />
        <Stat label="Paid" value={data.paid} />
        <Stat label="Balance" value={data.balance} highlight />
      </div>
      <h2 className="text-xs font-semibold text-text-label uppercase tracking-wide mb-2">Accruals</h2>
      <DataTable
        columns={accrualColumns}
        rows={data.accruals as Accrual[]}
        rowKey={(r) => `${r.application_no}-${r.accrual_date}`}
        defaultSort={{ key: 'accrual_date', dir: 'desc' }}
        empty="No accruals yet."
      />
    </div>
  );
}

function Stat({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className={`bg-surface border rounded-lg shadow-card p-4 ${highlight ? 'border-primary' : 'border-border'}`}>
      <div className="text-xs font-semibold text-text-label uppercase tracking-wide">{label}</div>
      <div className={`mt-1 text-lg font-bold mono ${highlight ? 'text-primary' : ''}`}>{formatINR(value)}</div>
    </div>
  );
}
