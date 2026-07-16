import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../api/client.js';
import { DataTable, type Column } from '../components/DataTable.js';

interface CustomerRow {
  id: number;
  customer_code: string;
  full_name: string;
  phone: string | null;
  district: string | null;
  kyc_status: string;
  creation_status: string;
  is_active: boolean;
}

const statusPill: Record<string, string> = {
  Approved: 'bg-[color:var(--success-bg)] text-success',
  PendingApproval: 'bg-[color:var(--warn-bg)] text-warn',
  Draft: 'bg-bg text-text-muted',
};

const columns: Column<CustomerRow>[] = [
  { key: 'customer_code', header: 'Code', tdClassName: 'font-mono text-xs' },
  { key: 'full_name', header: 'Name', tdClassName: 'font-medium',
    render: (c) => <Link to={`/app/customers/${c.id}`} className="text-primary hover:underline">{c.full_name}</Link> },
  { key: 'district', header: 'District', value: (c) => c.district ?? '', render: (c) => c.district ?? '—' },
  { key: 'kyc_status', header: 'KYC', tdClassName: 'text-text-muted' },
  { key: 'creation_status', header: 'Status',
    render: (c) => <span className={`text-xs rounded px-1.5 py-0.5 ${statusPill[c.creation_status] ?? 'bg-bg'}`}>{c.creation_status}</span> },
];

export function CustomersPage() {
  const { data, isLoading, error } = useQuery({ queryKey: ['customers'], queryFn: () => api.get<{ rows: CustomerRow[] }>('/api/customers') });
  if (isLoading) return <div className="text-text-muted">Loading customers…</div>;
  if (error) return <div className="text-danger">Failed to load customers.</div>;

  return (
    <div className="max-w-4xl">
      <h1 className="text-xl font-bold tracking-tight m-0">Customers</h1>
      <p className="text-sm text-text-muted mt-1 mb-5">Enrolled investors in your scope.</p>
      <DataTable
        columns={columns}
        rows={data!.rows}
        rowKey={(c) => c.id}
        defaultSort={{ key: 'customer_code', dir: 'desc' }}
        empty="No customers yet — convert a lead to create one."
      />
    </div>
  );
}
