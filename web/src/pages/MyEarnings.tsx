import { useQuery } from '@tanstack/react-query';
import { formatINR } from '@new-wealth/shared';
import { api } from '../api/client.js';

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
      <div className="bg-surface border border-border rounded-lg shadow-card overflow-hidden">
        <table className="w-full text-sm">
          <thead><tr className="text-left text-xs font-semibold text-text-label border-b border-border">
            <th className="px-4 py-2">Application</th><th className="px-4 py-2">Date</th><th className="px-4 py-2 text-right">Amount</th><th className="px-4 py-2">Status</th></tr></thead>
          <tbody className="divide-y divide-border">
            {data.accruals.map((r: any, i: number) => (
              <tr key={i}><td className="px-4 py-1.5 font-mono text-xs">{r.application_no}</td><td className="px-4 py-1.5 mono">{r.accrual_date}</td>
                <td className="px-4 py-1.5 text-right mono">{formatINR(r.amount)}</td><td className="px-4 py-1.5 text-xs">{r.paid_at ? 'Paid' : 'Unpaid'}</td></tr>
            ))}
            {data.accruals.length === 0 && <tr><td colSpan={4} className="px-4 py-6 text-center text-text-muted">No accruals yet.</td></tr>}
          </tbody>
        </table>
      </div>
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
