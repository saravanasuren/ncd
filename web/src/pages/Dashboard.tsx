import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { PieChart, Pie, Cell, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { formatINR } from '@new-wealth/shared';
import { api } from '../api/client.js';
import { useAuth } from '../auth/AuthContext.js';

/** NCD Portfolio dashboard (docs/06 §2). KPI tiles + series/district pie charts
 * (click a slice → Segments). */
export function Dashboard() {
  const { can } = useAuth();
  const overview = useQuery({ queryKey: ['dash-overview'], queryFn: () => api.get<any>('/api/dashboard/overview') });

  if (overview.isLoading) return <div className="text-text-muted">Loading dashboard…</div>;
  if (overview.error) return <div className="text-danger">Failed to load dashboard.</div>;
  const k = overview.data.kpis;
  const canDrill = can('dashboard:drilldown');

  return (
    <div className="w-full">
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
        <PieCard title="Series register" rows={overview.data.series ?? []} nameKey="code" valueKey="outstanding" tab="series" canDrill={canDrill} />
        <PieCard title="District distribution" rows={overview.data.districts ?? []} nameKey="district" valueKey="amount" tab="district" canDrill={canDrill} />
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

const PIE_COLORS = ['#0b5cab', '#1a7f4b', '#b3730d', '#7048c4', '#0e8a9e', '#c23838', '#3f7cd6', '#4a9e6b', '#d19a3a', '#9a6bd6'];

interface Slice { name: string; value: number; key: string }
/** Top-N slices by value, with the rest folded into an "Others" slice. */
function topSlices(rows: any[], nameKey: string, valueKey: string, n = 8): Slice[] {
  const cleaned = (rows ?? [])
    .map((r) => ({ name: String(r[nameKey] ?? '—'), value: Number(r[valueKey]) || 0 }))
    .filter((r) => r.value > 0)
    .sort((a, b) => b.value - a.value);
  const top: Slice[] = cleaned.slice(0, n).map((r) => ({ ...r, key: r.name }));
  const rest = cleaned.slice(n);
  if (rest.length) top.push({ name: `Others (${rest.length})`, value: rest.reduce((s, r) => s + r.value, 0), key: '__others__' });
  return top;
}

function PieCard({ title, rows, nameKey, valueKey, tab, canDrill }: {
  title: string; rows: any[]; nameKey: string; valueKey: string; tab: string; canDrill: boolean;
}) {
  const nav = useNavigate();
  const slices = topSlices(rows, nameKey, valueKey, 8);
  const onSlice = (i: number) => {
    if (!canDrill) return;
    const s = slices[i];
    if (!s) return;
    nav(s.key === '__others__' ? `/app/segments?tab=${tab}` : `/app/segments?tab=${tab}&open=${encodeURIComponent(s.key)}`);
  };
  return (
    <Panel title={title}>
      {slices.length === 0 ? (
        <div className="p-5 text-center text-text-muted text-sm">No data.</div>
      ) : (
        <div className="p-3">
          <div style={{ height: 280 }}>
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={slices} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={48} outerRadius={92}
                  onClick={(_d: any, i: number) => onSlice(i)} cursor={canDrill ? 'pointer' : 'default'}>
                  {slices.map((_s, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                </Pie>
                <Tooltip formatter={(v: any) => formatINR(Number(v))} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
              </PieChart>
            </ResponsiveContainer>
          </div>
          {canDrill && <div className="text-center text-xs text-text-muted -mt-1">Click a slice to open it in Segments →</div>}
        </div>
      )}
    </Panel>
  );
}

