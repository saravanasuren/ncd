import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { formatINR } from '@new-wealth/shared';
import { api } from '../api/client.js';
import { DataTable, type Column } from '../components/DataTable.js';
import { useAuth } from '../auth/AuthContext.js';

interface PaidItem {
  application_no: string; application_id: number; customer_id: number | null;
  customer_name: string | null; customer_code: string | null;
  accrual_date: string; paid_at: string; amount: string;
}
interface SeriesRow { series_code: string; series_name: string; investments: number; customers: number; amount: string }
interface MonthRow { month: string; investments: number; customers: number; amount: string }
/** A row on the CREDITED basis — what the incentive is actually paid on. */
interface CreditRow {
  month?: string; series_code?: string; series_name?: string;
  investments: number; customers: number; amount: string; incentive_paid: string;
  enrolled_amount: string; referred_amount: string;
  enrolled_investments?: number; referred_investments?: number;
}
interface MyEarnings {
  paid: number;
  paid_items: PaidItem[];
  totals: { investments: number; customers: number; amount: number };
  by_series: SeriesRow[];
  by_month: MonthRow[];
  /** The same basis the Incentives page uses, so the two reconcile. */
  credited: {
    totals: {
      investments: number; customers: number; amount: number; incentive_paid: number;
      referred_investments: number; referred_amount: number;
      enrolled_investments: number; enrolled_amount: number;
    };
    by_series: CreditRow[];
    by_month: CreditRow[];
  };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function monthLabel(m: string): string {
  const [y, mm] = m.split('-');
  return `${MONTHS[Number(mm) - 1] ?? mm} ${y}`;
}
const day = (d: string | null) => (d ? String(d).slice(0, 10) : '—');

function Tile({ label, value, sub, highlight, title }: { label: string; value: string; sub: string; highlight?: boolean; title?: string }) {
  return (
    <div className={`bg-surface border rounded-lg shadow-card p-4 ${highlight ? 'border-primary' : 'border-border'}`} title={title}>
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
    // Clickable through to the customer and the investment (owner 2026-09-07:
    // "make everything in my earnings clickable"). A staff member reconciling
    // their own pay needs the record behind each line, not just its number.
    { key: 'customer_name', header: 'Customer', tdClassName: 'font-medium',
      value: (r) => r.customer_name ?? '',
      render: (r) => (
        <span>
          {r.customer_id
            ? <Link to={`/app/customers/${r.customer_id}`} className="text-primary hover:underline">{r.customer_name ?? '—'}</Link>
            : (r.customer_name ?? '—')}
          {r.customer_code && <span className="text-text-muted font-mono text-xs"> · {r.customer_code}</span>}
        </span>
      ) },
    { key: 'application_no', header: 'Application', tdClassName: 'font-mono text-xs',
      value: (r) => r.application_no,
      render: (r) => (
        <Link to={`/app/applications/${r.application_id}`} className="text-primary hover:underline">{r.application_no}</Link>
      ) },
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

  /** Clicking a month or a series filters the payout list below (owner
   *  2026-09-07). Null = show everything. */
  const [month, setMonth] = useState<string | null>(null);
  const [series, setSeries] = useState<string | null>(null);

  const money = (v: unknown) => <span className="mono">{formatINR(Number(v ?? 0))}</span>;

  /**
   * Both bases, side by side, because they are DIFFERENT sets of investments
   * and the difference is what confused people (owner 2026-09-07: "show both
   * lines in my earnings so it reconciles").
   *
   *   Enrolled by you  — investments you keyed in
   *   Credited to you  — investments your incentive is actually paid on
   *
   * They are not subsets of each other. One branch staff member's August was 8
   * enrolled (₹34L) against 10 credited (₹38L), with only ONE investment on
   * both lists — the rest credited to her as the REFERRER on colleagues' work.
   */
  const creditCols: Column<CreditRow>[] = [
    { key: 'amount', header: 'Credited to you', align: 'right',
      value: (r) => Number(r.amount), render: (r) => money(r.amount) },
    { key: 'enrolled_amount', header: '— you enrolled', align: 'right',
      value: (r) => Number(r.enrolled_amount),
      render: (r) => <span className="mono text-text-muted">{formatINR(Number(r.enrolled_amount))}</span> },
    { key: 'referred_amount', header: '— you referred', align: 'right',
      value: (r) => Number(r.referred_amount),
      render: (r) => <span className="mono text-text-muted">{formatINR(Number(r.referred_amount))}</span> },
  ];

  const monthCols: Column<CreditRow>[] = [
    { key: 'month', header: 'Month', tdClassName: 'font-semibold',
      value: (r) => r.month ?? '',
      render: (r) => (
        <button onClick={() => setMonth(month === r.month ? null : (r.month ?? null))}
          className={`hover:underline ${month === r.month ? 'text-primary font-semibold' : 'text-primary'}`}>
          {monthLabel(r.month ?? '')}
        </button>
      ) },
    { key: 'investments', header: 'Investments', align: 'right', value: (r) => r.investments },
    { key: 'customers', header: 'Customers', align: 'right', value: (r) => r.customers },
    ...creditCols,
    // PAID, never accrued: a staff member sees what they have been paid, not
    // what is owed (owner 2026-07-20).
    ...(hideAmount ? [] : [{
      key: 'incentive_paid', header: 'Incentive paid', align: 'right' as const,
      value: (r: CreditRow) => Number(r.incentive_paid),
      render: (r: CreditRow) => <span className="mono text-primary">{formatINR(Number(r.incentive_paid))}</span>,
    }]),
  ];

  const seriesCols: Column<CreditRow>[] = [
    { key: 'series_code', header: 'Series', tdClassName: 'font-semibold',
      value: (r) => r.series_code ?? '',
      render: (r) => (
        <button onClick={() => setSeries(series === r.series_code ? null : (r.series_code ?? null))}
          className="text-primary hover:underline">{r.series_code}</button>
      ) },
    { key: 'series_name', header: 'Name', value: (r) => r.series_name ?? '' },
    { key: 'investments', header: 'Investments', align: 'right', value: (r) => r.investments },
    { key: 'customers', header: 'Customers', align: 'right', value: (r) => r.customers },
    ...creditCols,
    ...(hideAmount ? [] : [{
      key: 'incentive_paid', header: 'Incentive paid', align: 'right' as const,
      value: (r: CreditRow) => Number(r.incentive_paid),
      render: (r: CreditRow) => <span className="mono text-primary">{formatINR(Number(r.incentive_paid))}</span>,
    }]),
  ];

  const c = d.credited;
  // The payout list, narrowed by whichever month is selected. Series is not on
  // a payout row, so selecting a series filters the tables above only and says
  // so rather than silently doing nothing.
  const paidRows = month
    ? d.paid_items.filter((p) => String(p.accrual_date ?? p.paid_at).slice(0, 7) === month)
    : d.paid_items;

  return (
    <div className="w-full">
      <h1 className="text-xl font-bold tracking-tight m-0">My Earnings</h1>
      <p className="text-sm text-text-muted mt-1 mb-5">
        What you brought in, what your incentive is paid on, and what Dhanam has paid you.
      </p>

      <div className="grid gap-3 mb-4" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
        <Tile label="Incentive paid" value={formatINR(d.paid)} sub="Paid to you till date" highlight />
        <Tile label="Credited to you" value={formatINR(c.totals.amount)}
          sub={`${c.totals.investments} investment${c.totals.investments === 1 ? '' : 's'} your incentive is paid on`}
          title="The same basis the Incentives page uses" />
        <Tile label="Enrolled by you" value={formatINR(d.totals.amount)}
          sub={`${d.totals.investments} you keyed in · ${d.totals.customers} investor${d.totals.customers === 1 ? '' : 's'}`}
          title="Investments you entered — not the same list as what you are paid on" />
      </div>

      {/* Said plainly, because the two tiles above will not match for most
          people and the reason is not guessable. */}
      {c.totals.referred_amount > 0 && (
        <div className="text-xs text-text-muted bg-surface border border-border rounded p-3 mb-6">
          Of the {formatINR(c.totals.amount)} you are paid on, {formatINR(c.totals.enrolled_amount)} is
          from investments you enrolled and {formatINR(c.totals.referred_amount)} from investments you
          referred that a colleague keyed in. That is why this differs from what you enrolled.
        </div>
      )}

      <h2 className="text-xs font-semibold text-text-label uppercase tracking-wide mb-2">
        Month-wise {month && <button onClick={() => setMonth(null)} className="ml-2 font-normal normal-case text-primary hover:underline">clear {monthLabel(month)}</button>}
      </h2>
      <div className="mb-6">
        <DataTable columns={monthCols} rows={c.by_month} rowKey={(r) => r.month ?? ''}
          defaultSort={{ key: 'month', dir: 'desc' }} empty="Nothing credited yet." />
      </div>

      <h2 className="text-xs font-semibold text-text-label uppercase tracking-wide mb-2">
        Series-wise {series && <button onClick={() => setSeries(null)} className="ml-2 font-normal normal-case text-primary hover:underline">clear {series}</button>}
      </h2>
      <div className="mb-6">
        <DataTable columns={seriesCols} rows={series ? c.by_series.filter((r) => r.series_code === series) : c.by_series}
          rowKey={(r) => r.series_code ?? ''} defaultSort={{ key: 'series_code', dir: 'desc' }}
          empty="Nothing credited yet." />
      </div>

      <h2 className="text-xs font-semibold text-text-label uppercase tracking-wide mb-2">
        Incentive payouts received{month ? ` · ${monthLabel(month)}` : ''}
      </h2>
      <DataTable
        columns={paidColumnsFor(hideAmount)}
        rows={paidRows}
        rowKey={(r) => `${r.application_no}-${r.paid_at}`}
        defaultSort={{ key: 'paid_at', dir: 'desc' }}
        empty={month ? `Nothing paid for ${monthLabel(month)}.` : 'No incentive paid yet.'}
      />
    </div>
  );
}
