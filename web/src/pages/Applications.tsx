import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { formatINR } from '@new-wealth/shared';
import { api } from '../api/client.js';

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

export function ApplicationsPage() {
  const { data, isLoading, error } = useQuery({ queryKey: ['applications'], queryFn: () => api.get<{ rows: AppRow[] }>('/api/applications') });
  if (isLoading) return <div className="text-text-muted">Loading…</div>;
  if (error) return <div className="text-danger">Failed to load applications.</div>;
  return (
    <div className="max-w-4xl">
      <h1 className="text-xl font-bold tracking-tight m-0">Applications</h1>
      <p className="text-sm text-text-muted mt-1 mb-5">NCD investments in your scope.</p>
      <div className="bg-surface border border-border rounded-lg shadow-card overflow-hidden">
        <table className="w-full text-sm">
          <thead><tr className="text-left text-xs font-semibold text-text-label border-b border-border">
            <th className="px-4 py-2.5">App No.</th><th className="px-4 py-2.5">Customer</th><th className="px-4 py-2.5">Series</th>
            <th className="px-4 py-2.5 text-right">Amount</th><th className="px-4 py-2.5">Status</th></tr></thead>
          <tbody className="divide-y divide-border">
            {data!.rows.map((a) => (
              <tr key={a.id} className="hover:bg-bg">
                <td className="px-4 py-2.5 font-mono text-xs"><Link to={`/app/applications/${a.id}`} className="text-primary hover:underline">{a.application_no}</Link></td>
                <td className="px-4 py-2.5">{a.customer_name}</td>
                <td className="px-4 py-2.5">{a.series_code}</td>
                <td className="px-4 py-2.5 text-right mono">{formatINR(a.total_amount)}</td>
                <td className="px-4 py-2.5"><span className={`text-xs rounded px-1.5 py-0.5 ${pill[a.status] ?? 'bg-bg'}`}>{a.status}</span></td>
              </tr>
            ))}
            {data!.rows.length === 0 && <tr><td colSpan={5} className="px-4 py-6 text-center text-text-muted">No applications yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
