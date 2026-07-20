import { useQuery } from '@tanstack/react-query';
import { formatINR } from '@new-wealth/shared';
import { api } from '../api/client.js';
import { useAuth } from '../auth/AuthContext.js';
import { DataTable, type Column } from '../components/DataTable.js';

interface Totals { investments: number; customers: number; amount: number; incentives_paid: number }
interface SeriesRow { series_code: string; series_name: string; investments: number; customers: number; amount: string }
interface MonthRow { month: string; investments: number; customers: number; amount: string }
interface MyBook { totals: Totals; by_series: SeriesRow[]; by_month: MonthRow[] }

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function monthLabel(m: string): string {
  const [y, mm] = m.split('-');
  return `${MONTHS[Number(mm) - 1] ?? mm} ${y}`;
}

function Tile({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="bg-surface border border-border rounded-lg shadow-card p-5">
      <div className="text-xs font-semibold text-text-label uppercase tracking-wide">{label}</div>
      <div className="text-2xl font-bold mono mt-1">{value}</div>
      <div className="text-xs text-text-muted mt-1">{sub}</div>
    </div>
  );
}

export function MyDashboardPage() {
  const { user } = useAuth();
  const { data, isLoading } = useQuery({ queryKey: ['my-book'], queryFn: () => api.get<MyBook>('/api/dashboard/my') });
  if (isLoading) return <div className="text-text-muted">Loading…</div>;
  const d = data!;

  const seriesCols: Column<SeriesRow>[] = [
    { key: 'series_code', header: 'Series', tdClassName: 'font-semibold' },
    { key: 'series_name', header: 'Name' },
    { key: 'customers', header: 'Customers', align: 'right', value: (r) => r.customers },
    { key: 'investments', header: 'Investments', align: 'right', value: (r) => r.investments },
    { key: 'amount', header: 'Amount', align: 'right', value: (r) => Number(r.amount),
      render: (r) => <span className="mono">{formatINR(r.amount)}</span> },
  ];
  const monthCols: Column<MonthRow>[] = [
    { key: 'month', header: 'Month', value: (r) => r.month, render: (r) => monthLabel(r.month), tdClassName: 'font-semibold' },
    { key: 'customers', header: 'Customers', align: 'right', value: (r) => r.customers },
    { key: 'investments', header: 'Investments', align: 'right', value: (r) => r.investments },
    { key: 'amount', header: 'Amount', align: 'right', value: (r) => Number(r.amount),
      render: (r) => <span className="mono">{formatINR(r.amount)}</span> },
  ];

  return (
    <div className="w-full">
      <h1 className="text-xl font-bold tracking-tight m-0">My Dashboard</h1>
      <p className="text-sm text-text-muted mt-1 mb-5">
        Everything {user?.fullName ? `${user.fullName} has` : 'you have'} brought in — the customers you enrolled and the investments they made.
      </p>

      <div className="grid gap-4 mb-6" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
        <Tile label="Investments brought in" value={formatINR(d.totals.amount)} sub={`${d.totals.investments} application${d.totals.investments === 1 ? '' : 's'}`} />
        <Tile label="Applications" value={String(d.totals.investments)} sub="Investments you keyed in" />
        <Tile label="Customers" value={String(d.totals.customers)} sub="Investors you enrolled" />
        <Tile label="Incentive earned" value={formatINR(d.totals.incentives_paid)} sub="Paid to you till date" />
      </div>

      <h2 className="text-xs font-semibold text-text-label uppercase tracking-wide mb-2">Series-wise</h2>
      <div className="mb-6">
        <DataTable columns={seriesCols} rows={d.by_series} rowKey={(r) => r.series_code}
          defaultSort={{ key: 'series_code', dir: 'desc' }} empty="Nothing brought in yet." />
      </div>

      <h2 className="text-xs font-semibold text-text-label uppercase tracking-wide mb-2">Month-wise</h2>
      <DataTable columns={monthCols} rows={d.by_month} rowKey={(r) => r.month}
        defaultSort={{ key: 'month', dir: 'desc' }} empty="Nothing brought in yet." />
    </div>
  );
}
