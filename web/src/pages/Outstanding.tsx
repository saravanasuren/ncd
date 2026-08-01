import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { formatINR } from '@new-wealth/shared';
import { api } from '../api/client.js';
import { DataTable, type Column } from '../components/DataTable.js';
import { Tabs, type TabDef } from '../components/Tabs.js';

/**
 * Everything started but not finished (owner 2026-08-01).
 *
 * Each of these already appears somewhere — a part payment on the customer, a
 * cheque inside one locker application, an approval in the queue. That is the
 * problem: no single screen is wrong, and an item nobody happens to open just
 * ages. This is the list you check when you want to know what is hanging
 * without knowing where to look.
 */
interface Row {
  kind: 'part_payment' | 'awaiting_approval' | 'cheque_uncleared' | 'cheque_settle_failed';
  id: number;
  customer_id: number | null;
  customer: string | null;
  customer_code: string | null;
  reference: string;
  amount: string;
  since: string | null;
  age_days: number | null;
  detail: string;
}

const KIND: Record<Row['kind'], { label: string; pill: string }> = {
  // Red for the two that mean money is somewhere it shouldn't be: a cheque
  // sitting uncleared, or one that cleared while the locker leg never settled.
  cheque_settle_failed: { label: 'Settle failed', pill: 'bg-[color:var(--danger-bg)] text-danger' },
  cheque_uncleared: { label: 'Cheque pending', pill: 'bg-[color:var(--warn-bg)] text-warn' },
  part_payment: { label: 'Part payment', pill: 'bg-[color:var(--warn-bg)] text-warn' },
  awaiting_approval: { label: 'Awaiting approval', pill: 'bg-bg text-text-muted' },
};

/** Age is the point of this screen, so it is coloured, not just printed. A
 *  cheque taken yesterday is routine; the same one at six weeks is money
 *  nobody chased. */
function Age({ days }: { days: number | null }) {
  if (days == null) return <span className="text-text-muted">—</span>;
  const cls = days >= 30 ? 'text-danger font-semibold' : days >= 14 ? 'text-warn' : 'text-text-muted';
  return <span className={cls}>{days === 0 ? 'today' : `${days}d`}</span>;
}

type Tab = 'all' | Row['kind'];

export function OutstandingPage() {
  const [tab, setTab] = useState<Tab>('all');
  const { data, isLoading, error } = useQuery({
    queryKey: ['outstanding'],
    queryFn: () => api.get<{ rows: Row[] }>('/api/reports/outstanding'),
  });
  const rows = data?.rows ?? [];
  const shown = tab === 'all' ? rows : rows.filter((r) => r.kind === tab);

  const tabs: TabDef<Tab>[] = [
    { key: 'all', label: 'All', count: rows.length },
    ...(Object.keys(KIND) as Row['kind'][])
      .map((k) => ({ key: k as Tab, label: KIND[k].label, count: rows.filter((r) => r.kind === k).length }))
      // A category with nothing in it is noise on a worklist.
      .filter((t) => t.count > 0),
  ];

  const columns: Column<Row>[] = [
    { key: 'kind', header: 'What', value: (r) => KIND[r.kind].label,
      render: (r) => <span className={`text-xs rounded px-1.5 py-0.5 whitespace-nowrap ${KIND[r.kind].pill}`}>{KIND[r.kind].label}</span> },
    { key: 'customer', header: 'Customer', value: (r) => r.customer ?? '',
      render: (r) => (r.customer_id
        ? <Link to={`/app/customers/${r.customer_id}`} className="text-primary hover:underline">{r.customer}</Link>
        : <span className="text-text-muted">{r.customer ?? '—'}</span>) },
    { key: 'reference', header: 'Reference', tdClassName: 'font-mono text-xs' },
    { key: 'amount', header: 'Amount', align: 'right',
      value: (r) => Number(r.amount), render: (r) => <span className="mono">{formatINR(r.amount)}</span> },
    { key: 'age_days', header: 'Waiting', align: 'right',
      value: (r) => r.age_days ?? -1, render: (r) => <Age days={r.age_days} /> },
    { key: 'since', header: 'Since', value: (r) => r.since ?? '', render: (r) => r.since ?? '—' },
    { key: 'detail', header: 'What needs doing', sortable: false,
      render: (r) => <span className="text-xs text-text-muted">{r.detail}</span> },
  ];

  return (
    <div className="w-full">
      <h1 className="text-xl font-bold tracking-tight m-0">Outstanding</h1>
      <p className="text-sm text-text-muted mt-1 mb-4">
        Everything started but not finished, oldest first. Locker allotment and e-signing live with LockerHub and are shown on the enrolment screen.
      </p>
      {error ? <div className="text-danger">Couldn’t load the outstanding list.</div>
        : isLoading ? <div className="text-text-muted">Loading…</div>
        : rows.length === 0 ? (
          <div className="bg-surface border border-border rounded-lg shadow-card p-8 text-center">
            <div className="text-sm font-medium">Nothing outstanding.</div>
            <div className="text-xs text-text-muted mt-1">No part payments, uncleared cheques or investments waiting for approval.</div>
          </div>
        ) : (
          <>
            <Tabs tabs={tabs} active={tab} onChange={setTab} />
            <DataTable columns={columns} rows={shown} rowKey={(r) => `${r.kind}-${r.id}`}
              defaultSort={{ key: 'age_days', dir: 'desc' }} empty="Nothing in this category." />
          </>
        )}
    </div>
  );
}
