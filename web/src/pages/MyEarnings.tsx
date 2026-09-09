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
/**
 * A month or a series, on the CREDITED basis — the investments this person's
 * incentive is worked out on, which is the same basis the Incentives page uses.
 *
 * The response also carries the ENROLLED basis (what they keyed in themselves)
 * and a three-way split of the credited figure. This page deliberately shows
 * neither any more: two different totals side by side, plus a split, is what
 * made the screen unreadable (owner 2026-09-09: "i feel this screen so
 * complicated"). They stay in the payload because the Incentives page's own
 * reconciliation tests measure against them.
 */
interface CreditRow {
  month?: string; series_code?: string; series_name?: string;
  investments: number; customers: number; amount: string;
}
interface MyEarnings {
  /** Paid to date. Accrued and balance are never in this response, for any
   *  role — see the note on the tile below. */
  paid: number;
  paid_items: PaidItem[];
  credited: { by_series: CreditRow[]; by_month: CreditRow[] };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function monthLabel(m: string): string {
  const [y, mm] = m.split('-');
  return `${MONTHS[Number(mm) - 1] ?? mm} ${y}`;
}
const day = (d: string | null) => (d ? String(d).slice(0, 10) : '—');

function Tile({ label, value, sub, title }: { label: string; value: string; sub: string; title?: string }) {
  return (
    <div className="bg-surface border border-primary rounded-lg shadow-card p-4" title={title}>
      <div className="text-xs font-semibold text-text-label uppercase tracking-wide">{label}</div>
      <div className="mt-1 text-lg font-bold mono text-primary">{value}</div>
      <div className="text-xs text-text-muted mt-1">{sub}</div>
    </div>
  );
}

/**
 * Branch staff see WHICH customers they were paid for, but not how much each
 * one earned them (owner 2026-07-24) — the per-customer split isn't theirs to
 * see; their total is already on the tile above. Agents keep the breakdown,
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

/**
 * Three figures per row, in the owner's own words (2026-09-09: "month - no of
 * cust, application, investments. thats it").
 *
 * Note the vocabulary, which is a change: the count of applications used to be
 * headed "Investments", while the rupee figure was headed "Credited to you".
 * Reading a count under "Investments" and money under something else is most of
 * why the page did not parse. Now the count is Applications and the money is
 * Investments, which is how people here actually speak.
 */
const figureCols: Column<CreditRow>[] = [
  { key: 'customers', header: 'Customers', align: 'right', value: (r) => r.customers },
  { key: 'investments', header: 'Applications', align: 'right', value: (r) => r.investments },
  { key: 'amount', header: 'Investments', align: 'right',
    value: (r) => Number(r.amount),
    render: (r) => <span className="mono">{formatINR(Number(r.amount))}</span> },
];

export function MyEarningsPage() {
  const { user } = useAuth();
  const hideAmount = user?.role === 'branch_staff';
  const { data, isLoading, error } = useQuery({ queryKey: ['my-earnings'], queryFn: () => api.get<MyEarnings>('/api/incentives/my-earnings') });
  const [month, setMonth] = useState<string | null>(null);
  const [series, setSeries] = useState<string | null>(null);
  if (isLoading) return <div className="text-text-muted">Loading…</div>;
  if (error) return <div className="text-danger">Failed to load earnings.</div>;
  const d = data!;

  const monthCols: Column<CreditRow>[] = [
    { key: 'month', header: 'Month', tdClassName: 'font-semibold',
      value: (r) => r.month ?? '',
      render: (r) => (
        <button onClick={() => setMonth(month === r.month ? null : (r.month ?? null))}
          className={`hover:underline ${month === r.month ? 'text-primary font-semibold' : 'text-primary'}`}>
          {monthLabel(r.month ?? '')}
        </button>
      ) },
    ...figureCols,
  ];

  const seriesCols: Column<CreditRow>[] = [
    { key: 'series_code', header: 'Series', tdClassName: 'font-semibold',
      value: (r) => r.series_code ?? '',
      render: (r) => (
        <button onClick={() => setSeries(series === r.series_code ? null : (r.series_code ?? null))}
          className="text-primary hover:underline">{r.series_code}</button>
      ) },
    { key: 'series_name', header: 'Name', value: (r) => r.series_name ?? '' },
    ...figureCols,
  ];

  const c = d.credited;
  // The payout list, narrowed by whichever month is selected. Series is not on
  // a payout row, so selecting a series filters the table above only.
  const paidRows = month
    ? d.paid_items.filter((p) => String(p.accrual_date ?? p.paid_at).slice(0, 7) === month)
    : d.paid_items;

  return (
    <div className="w-full">
      <h1 className="text-xl font-bold tracking-tight m-0">My Earnings</h1>
      <p className="text-sm text-text-muted mt-1 mb-5">
        The business your incentive is worked out on, and what Dhanam has paid you.
      </p>

      {/* One tile, and it is PAID — never accrued, never a balance, for any
          role (owner 2026-07-20, restated 2026-09-09: "need not show how much
          we owe to them, in their login"). What is owed lives on the admin
          Incentives page, which is unchanged. */}
      <div className="mb-6" style={{ maxWidth: 320 }}>
        <Tile label="Incentive paid" value={formatINR(d.paid)} sub="Paid to you till date"
          title="What Dhanam has actually paid you" />
      </div>

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
