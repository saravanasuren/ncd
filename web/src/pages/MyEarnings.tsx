import { useQuery } from '@tanstack/react-query';
import { formatINR } from '@new-wealth/shared';
import { api } from '../api/client.js';
import { DataTable, type Column } from '../components/DataTable.js';
import { useAuth } from '../auth/AuthContext.js';

interface PaidItem { application_no: string; customer_name: string | null; customer_code: string | null; accrual_date: string; paid_at: string; amount: string }
interface SeriesRow { series_code: string; series_name: string; investments: number; customers: number; amount: string }
interface MonthRow { month: string; investments: number; customers: number; amount: string }
interface MyEarnings {
  paid: number;
  paid_items: PaidItem[];
  totals: { investments: number; customers: number; amount: number };
  by_series: SeriesRow[];
  by_month: MonthRow[];
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function monthLabel(m: string): string {
  const [y, mm] = m.split('-');
  return `${MONTHS[Number(mm) - 1] ?? mm} ${y}`;
}
const day = (d: string | null) => (d ? String(d).slice(0, 10) : '—');

function Tile({ label, value, sub, highlight }: { label: string; value: string; sub: string; highlight?: boolean }) {
  return (
    <div className={`bg-surface border rounded-lg shadow-card p-4 ${highlight ? 'border-primary' : 'border-border'}`}>
      <div className="text-xs font-semibold text-text-label uppercase tracking-wide">{label}</div>
      <div className={`mt-1 text-lg font-bold mono ${highlight ? 'text-primary' : ''}`}>{value}</div>
      <div className="text-xs text-text-muted mt-1">{sub}</div>
    </div>
  );
}

/**
 * Branch staff see WHICH customers they were paid for, but not how much each
 * one earned them (owner 2026-07-24) — the per-customer split isn't theirs to
 * see; their total is already on the tiles above. Agents keep the breakdown,
 * since it's how they reconcile their own commission.
 */
function paidColumnsFor(hideAmount: boolean): Column<PaidItem>[] {
  const cols: Column<PaidItem>[] = [
    { key: 'customer_name', header: 'Customer', tdClassName: 'font-medium',
      value: (r) => r.customer_name ?? '',
      render: (r) => <span>{r.customer_name ?? '—'}{r.customer_code && <span className="text-text-muted font-mono text-xs"> · {r.customer_code}</span>}</span> },
    { key: 'application_no', header: 'Application', tdClassName: 'font-mono text-xs' },
    { key: 'paid_at', header: 'Paid on', value: (r) => day(r.paid_at), render: (r) => <span className="mono">{day(r.paid_at)}</span> },
  ];
  if (!hideAmount) {
    cols.push({ key: 'amount', header: 'Amount', align: 'right', value: (r) => Number(r.amount), render: (r) => <span className="mono">{formatINR(r.amount)}</span> });
  }
  return cols;
}

export function MyEarningsPage() {
  const { user } = useAuth();
  const hideAmount = user?.role === 'branch_staff';
  const { data, isLoading, error } = useQuery({ queryKey: ['my-earnings'], queryFn: () => api.get<MyEarnings>('/api/incentives/my-earnings') });
  if (isLoading) return <div className="text-text-muted">Loading…</div>;
  if (error) return <div className="text-danger">Failed to load earnings.</div>;
  const d = data!;

  const seriesCols: Column<SeriesRow>[] = [
    { key: 'series_code', header: 'Series', tdClassName: 'font-semibold' },
    { key: 'series_name', header: 'Name' },
    { key: 'customers', header: 'Customers', align: 'right', value: (r) => r.customers },
    { key: 'investments', header: 'Investments', align: 'right', value: (r) => r.investments },
    { key: 'amount', header: 'Amount', align: 'right', value: (r) => Number(r.amount), render: (r) => <span className="mono">{formatINR(r.amount)}</span> },
  ];
  const monthCols: Column<MonthRow>[] = [
    { key: 'month', header: 'Month', value: (r) => r.month, render: (r) => monthLabel(r.month), tdClassName: 'font-semibold' },
    { key: 'customers', header: 'Customers', align: 'right', value: (r) => r.customers },
    { key: 'investments', header: 'Investments', align: 'right', value: (r) => r.investments },
    { key: 'amount', header: 'Amount', align: 'right', value: (r) => Number(r.amount), render: (r) => <span className="mono">{formatINR(r.amount)}</span> },
  ];

  return (
    <div className="w-full">
      <h1 className="text-xl font-bold tracking-tight m-0">My Earnings</h1>
      <p className="text-sm text-text-muted mt-1 mb-5">What you have brought in, and the incentive Dhanam has paid you.</p>

      <div className="grid gap-3 mb-6" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
        <Tile label="Incentive paid" value={formatINR(d.paid)} sub="Paid to you till date" highlight />
        <Tile label="Investments brought in" value={formatINR(d.totals.amount)} sub={`${d.totals.investments} application${d.totals.investments === 1 ? '' : 's'}`} />
        <Tile label="Applications" value={String(d.totals.investments)} sub="Investments you brought in" />
        <Tile label="Customers" value={String(d.totals.customers)} sub="Investors you brought in" />
      </div>

      <h2 className="text-xs font-semibold text-text-label uppercase tracking-wide mb-2">Series-wise</h2>
      <div className="mb-6">
        <DataTable columns={seriesCols} rows={d.by_series} rowKey={(r) => r.series_code}
          defaultSort={{ key: 'series_code', dir: 'desc' }} empty="Nothing brought in yet." />
      </div>

      <h2 className="text-xs font-semibold text-text-label uppercase tracking-wide mb-2">Month-wise</h2>
      <div className="mb-6">
        <DataTable columns={monthCols} rows={d.by_month} rowKey={(r) => r.month}
          defaultSort={{ key: 'month', dir: 'desc' }} empty="Nothing brought in yet." />
      </div>

      <h2 className="text-xs font-semibold text-text-label uppercase tracking-wide mb-2">Incentive payouts received</h2>
      <DataTable
        columns={paidColumnsFor(hideAmount)}
        rows={d.paid_items}
        rowKey={(r) => `${r.application_no}-${r.paid_at}`}
        defaultSort={{ key: 'paid_at', dir: 'desc' }}
        empty="No incentive paid yet."
      />
    </div>
  );
}
