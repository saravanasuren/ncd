import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../api/client.js';

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

export function CustomersPage() {
  const { data, isLoading, error } = useQuery({ queryKey: ['customers'], queryFn: () => api.get<{ rows: CustomerRow[] }>('/api/customers') });
  if (isLoading) return <div className="text-text-muted">Loading customers…</div>;
  if (error) return <div className="text-danger">Failed to load customers.</div>;

  return (
    <div className="max-w-4xl">
      <h1 className="text-xl font-bold tracking-tight m-0">Customers</h1>
      <p className="text-sm text-text-muted mt-1 mb-5">Enrolled investors in your scope.</p>
      <div className="bg-surface border border-border rounded-lg shadow-card overflow-hidden">
        <table className="w-full text-sm">
          <thead><tr className="text-left text-xs font-semibold text-text-label border-b border-border">
            <th className="px-4 py-2.5">Code</th><th className="px-4 py-2.5">Name</th><th className="px-4 py-2.5">District</th>
            <th className="px-4 py-2.5">KYC</th><th className="px-4 py-2.5">Status</th></tr></thead>
          <tbody className="divide-y divide-border">
            {data!.rows.map((c) => (
              <tr key={c.id} className="hover:bg-bg">
                <td className="px-4 py-2.5 font-mono text-xs">{c.customer_code}</td>
                <td className="px-4 py-2.5 font-medium"><Link to={`/app/customers/${c.id}`} className="text-primary hover:underline">{c.full_name}</Link></td>
                <td className="px-4 py-2.5">{c.district ?? '—'}</td>
                <td className="px-4 py-2.5 text-text-muted">{c.kyc_status}</td>
                <td className="px-4 py-2.5"><span className={`text-xs rounded px-1.5 py-0.5 ${statusPill[c.creation_status] ?? 'bg-bg'}`}>{c.creation_status}</span></td>
              </tr>
            ))}
            {data!.rows.length === 0 && <tr><td colSpan={5} className="px-4 py-6 text-center text-text-muted">No customers yet — convert a lead to create one.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
