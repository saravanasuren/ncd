import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { PieChart, Pie, Cell, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { formatINR } from '@new-wealth/shared';
import { api } from '../api/client.js';
import { useAuth } from '../auth/AuthContext.js';

/** NCD Portfolio dashboard (docs/06 §2). KPI tiles + series/district pie charts
 * (click a slice → Segments) + monthly redemptions. */
export function Dashboard() {
  const { can } = useAuth();
  const overview = useQuery({ queryKey: ['dash-overview'], queryFn: () => api.get<any>('/api/dashboard/overview') });
  const monthly = useQuery({ queryKey: ['dash-monthly'], queryFn: () => api.get<any>('/api/dashboard/monthly-redemptions') });

  if (overview.isLoading) return <div className="text-text-muted">Loading dashboard…</div>;
  if (overview.error) return <div className="text-danger">Failed to load dashboard.</div>;
  const k = overview.data.kpis;
  const canDrill = can('dashboard:drilldown');

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
        <PieCard title="Series register" rows={overview.data.series ?? []} nameKey="code" valueKey="outstanding" tab="series" canDrill={canDrill} />
        <PieCard title="District distribution" rows={overview.data.districts ?? []} nameKey="district" valueKey="amount" tab="district" canDrill={canDrill} />
      </div>

      <div className="mt-5">
        <Panel title="Monthly redemptions (money out)">
          <Table head={['Month', 'Redeemed']} money={[1]} defaultSort={{ col: 0, dir: 'desc' }}
            rows={(monthly.data?.rows ?? []).map((m: any) => ({ cells: [m.month, formatINR(m.total)] }))} />
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

interface TableRow { cells: string[]; onClick?: () => void }
function Table({ head, rows, money = [], defaultSort }: { head: string[]; rows: TableRow[]; money?: number[]; defaultSort?: { col: number; dir: 'asc' | 'desc' } }) {
  const [sortCol, setSortCol] = useState<number | null>(defaultSort?.col ?? null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>(defaultSort?.dir ?? 'asc');
  if (rows.length === 0) return <div className="p-5 text-center text-text-muted text-sm">No data.</div>;
  const num = (v: string) => { const s = v.replace(/[₹,%\s]/g, ''); return s !== '' && !Number.isNaN(Number(s)) ? Number(s) : null; };
  const sorted = sortCol == null ? rows : [...rows].sort((a, b) => {
    const va = a.cells[sortCol] ?? '', vb = b.cells[sortCol] ?? '';
    const na = num(va), nb = num(vb), d = sortDir === 'asc' ? 1 : -1;
    if (na != null && nb != null) return (na - nb) * d;
    return va.localeCompare(vb, undefined, { numeric: true }) * d;
  });
  const click = (i: number) => { if (sortCol === i) setSortDir((x) => (x === 'asc' ? 'desc' : 'asc')); else { setSortCol(i); setSortDir('asc'); } };
  return (
    <table className="w-full text-sm">
      <thead><tr className="text-left text-xs font-semibold text-text-label border-b border-border">
        {head.map((h, i) => (
          <th key={i} onClick={() => click(i)} className={`px-4 py-2 cursor-pointer select-none hover:text-text ${money.includes(i) ? 'text-right' : ''}`}>
            <span className="inline-flex items-center gap-1">{h}<span className={`text-[10px] ${sortCol === i ? 'text-primary' : 'text-border-strong'}`}>{sortCol === i ? (sortDir === 'asc' ? '▲' : '▼') : '↕'}</span></span>
          </th>
        ))}
      </tr></thead>
      <tbody className="divide-y divide-border">
        {sorted.map((r, i) => (
          <tr key={i} onClick={r.onClick} className={r.onClick ? 'cursor-pointer hover:bg-bg' : ''}>
            {r.cells.map((c, j) => <td key={j} className={`px-4 py-1.5 ${money.includes(j) ? 'text-right mono' : ''}`}>{c}</td>)}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
