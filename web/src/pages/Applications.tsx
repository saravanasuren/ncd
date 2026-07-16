import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { formatINR } from '@new-wealth/shared';
import { api } from '../api/client.js';
import { DataTable, type Column } from '../components/DataTable.js';

interface AppRow {
  id: number; application_no: string; status: string; total_amount: string;
  customer_name: string; customer_code: string; series_code: string; maturity_date: string | null;
}

const pill: Record<string, string> = {
  Active: 'bg-[color:var(--success-bg)] text-success',
  Redeemed: 'bg-bg text-text-muted',
  PendingAllotment: 'bg-[color:var(--warn-bg)] text-warn',
  PendingFundVerification: 'bg-[color:var(--warn-bg)] text-warn',
  PendingEsign: 'bg-[color:var(--warn-bg)] text-warn',
};

const columns: Column<AppRow>[] = [
  { key: 'application_no', header: 'App No.', tdClassName: 'font-mono text-xs',
    render: (a) => <Link to={`/app/applications/${a.id}`} className="text-primary hover:underline">{a.application_no}</Link> },
  { key: 'customer_name', header: 'Customer' },
  { key: 'series_code', header: 'Series' },
  { key: 'total_amount', header: 'Amount', align: 'right',
    value: (a) => Number(a.total_amount), render: (a) => <span className="mono">{formatINR(a.total_amount)}</span> },
  { key: 'status', header: 'Status',
    render: (a) => <span className={`text-xs rounded px-1.5 py-0.5 ${pill[a.status] ?? 'bg-bg'}`}>{a.status}</span> },
];

export function ApplicationsPage() {
  const { data, isLoading, error } = useQuery({ queryKey: ['applications'], queryFn: () => api.get<{ rows: AppRow[] }>('/api/applications') });
  if (isLoading) return <div className="text-text-muted">Loading…</div>;
  if (error) return <div className="text-danger">Failed to load applications.</div>;
  return (
    <div className="max-w-4xl">
      <h1 className="text-xl font-bold tracking-tight m-0">Applications</h1>
      <p className="text-sm text-text-muted mt-1 mb-5">NCD investments in your scope.</p>
      <DataTable
        columns={columns}
        rows={data!.rows}
        rowKey={(a) => a.id}
        defaultSort={{ key: 'application_no', dir: 'desc' }}
        empty="No applications yet."
      />
    </div>
  );
}
