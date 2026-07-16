import { useQuery } from '@tanstack/react-query';
import { formatINR } from '@new-wealth/shared';
import { api } from '../api/client.js';
import { useAuth } from '../auth/AuthContext.js';

/** NCD Portfolio dashboard (docs/06 §2). KPI tiles + series register +
 * district split + monthly redemptions. Read-only, scoped. */
export function Dashboard() {
  const { can } = useAuth();
  const overview = useQuery({ queryKey: ['dash-overview'], queryFn: () => api.get<any>('/api/dashboard/overview') });
  const monthly = useQuery({ queryKey: ['dash-monthly'], queryFn: () => api.get<any>('/api/dashboard/monthly-redemptions') });

  if (overview.isLoading) return <div className="text-text-muted">Loading dashboard…</div>;
  if (overview.error) return <div className="text-danger">Failed to load dashboard.</div>;
  const k = overview.data.kpis;

  return (
    <div className="max-w-5xl">
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-xl font-bold tracking-tight m-0">NCD Portfolio</h1>
          <p className="text-sm text-text-muted mt-1">Live view of the book in your scope.</p>
        </div>
        {can('reports:download') && (
          <a href="/api/reports/ncd-book.xlsx"
            className="text-sm bg-primary hover:bg-primary-hover text-white rounded px-4 py-2 font-semibold no-underline">
            ↓ Download NCD book (Excel)
          </a>
        )}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <Kpi label="Outstanding book" value={formatINR(k.outstanding_book)} primary />
        <Kpi label="Active investors" value={String(k.active_investors)} />
        <Kpi label="Interest paid" value={formatINR(k.interest_paid)} />
        <Kpi label="Interest scheduled" value={formatINR(k.interest_scheduled)} />
      </div>

      <div className="grid md:grid-cols-2 gap-5">
        <Panel title="Series register">
          <Table head={['Series', 'Investors', 'Outstanding']}
            rows={(overview.data.series ?? []).map((s: any) => [s.code, String(s.investors), formatINR(s.outstanding)])} money={[2]} />
        </Panel>
        <Panel title="District distribution">
          <Table head={['District', 'Investors', 'Amount']}
            rows={(overview.data.districts ?? []).map((d: any) => [d.district, String(d.investors), formatINR(d.amount)])} money={[2]} />
        </Panel>
      </div>

      <div className="mt-5">
        <Panel title="Monthly redemptions (money out)">
          <Table head={['Month', 'Redeemed']}
            rows={(monthly.data?.rows ?? []).map((m: any) => [m.month, formatINR(m.total)])} money={[1]} />
        </Panel>
      </div>
    </div>
  );
}

function Kpi({ label, value, primary }: { label: string; value: string; primary?: boolean }) {
  return (
    <div className={`bg-surface border rounded-lg shadow-card p-4 ${primary ? 'border-primary' : 'border-border'}`}>
      <div className="text-xs font-semibold text-text-label uppercase tracking-wide">{label}</div>
      <div className={`mt-1 text-lg font-bold mono ${primary ? 'text-primary' : ''}`}>{value}</div>
    </div>
  );
}
function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-surface border border-border rounded-lg shadow-card overflow-hidden">
      <div className="px-4 py-3 border-b border-border text-xs font-semibold text-text-label uppercase tracking-wide">{title}</div>
      {children}
    </div>
  );
}
function Table({ head, rows, money = [] }: { head: string[]; rows: string[][]; money?: number[] }) {
  if (rows.length === 0) return <div className="p-5 text-center text-text-muted text-sm">No data.</div>;
  return (
    <table className="w-full text-sm">
      <thead><tr className="text-left text-xs font-semibold text-text-label border-b border-border">
        {head.map((h, i) => <th key={i} className={`px-4 py-2 ${money.includes(i) ? 'text-right' : ''}`}>{h}</th>)}
      </tr></thead>
      <tbody className="divide-y divide-border">
        {rows.map((r, i) => (
          <tr key={i}>{r.map((c, j) => <td key={j} className={`px-4 py-1.5 ${money.includes(j) ? 'text-right mono' : ''}`}>{c}</td>)}</tr>
        ))}
      </tbody>
    </table>
  );
}
