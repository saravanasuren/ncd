import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { formatINR } from '@new-wealth/shared';
import { api } from '../api/client.js';
import { useAuth } from '../auth/AuthContext.js';

/** NCD Portfolio dashboard (docs/06 §2). KPI tiles + series register +
 * district split + monthly redemptions, with in-page drill popups. */
export function Dashboard() {
  const { can } = useAuth();
  const overview = useQuery({ queryKey: ['dash-overview'], queryFn: () => api.get<any>('/api/dashboard/overview') });
  const monthly = useQuery({ queryKey: ['dash-monthly'], queryFn: () => api.get<any>('/api/dashboard/monthly-redemptions') });
  const [drill, setDrill] = useState<{ title: string; widget: string; param: string } | null>(null);

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
        <Panel title="Series register">
          <Table head={['Series', 'Investors', 'Outstanding']}
            rows={(overview.data.series ?? []).map((s: any) => [s.code, String(s.investors), formatINR(s.outstanding)])} money={[2]}
            onRow={canDrill ? (i) => { const s = overview.data.series[i]; setDrill({ title: `${s.code} — investors`, widget: 'series', param: String(s.series_id) }); } : undefined} />
        </Panel>
        <Panel title="District distribution">
          <Table head={['District', 'Investors', 'Amount']}
            rows={(overview.data.districts ?? []).map((d: any) => [d.district, String(d.investors), formatINR(d.amount)])} money={[2]}
            onRow={canDrill ? (i) => { const d = overview.data.districts[i]; setDrill({ title: `${d.district} — investors`, widget: 'district', param: d.district }); } : undefined} />
        </Panel>
      </div>

      {drill && <DrillModal title={drill.title} widget={drill.widget} param={drill.param} onClose={() => setDrill(null)} />}

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
function Table({ head, rows, money = [], onRow }: { head: string[]; rows: string[][]; money?: number[]; onRow?: (i: number) => void }) {
  if (rows.length === 0) return <div className="p-5 text-center text-text-muted text-sm">No data.</div>;
  return (
    <table className="w-full text-sm">
      <thead><tr className="text-left text-xs font-semibold text-text-label border-b border-border">
        {head.map((h, i) => <th key={i} className={`px-4 py-2 ${money.includes(i) ? 'text-right' : ''}`}>{h}</th>)}
      </tr></thead>
      <tbody className="divide-y divide-border">
        {rows.map((r, i) => (
          <tr key={i} onClick={onRow ? () => onRow(i) : undefined} className={onRow ? 'cursor-pointer hover:bg-bg' : ''}>
            {r.map((c, j) => <td key={j} className={`px-4 py-1.5 ${money.includes(j) ? 'text-right mono' : ''}`}>{c}</td>)}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function DrillModal({ title, widget, param, onClose }: { title: string; widget: string; param: string; onClose: () => void }) {
  const { data, isLoading } = useQuery({ queryKey: ['drill', widget, param], queryFn: () => api.get<{ rows: any[] }>(`/api/dashboard/drill/${widget}?param=${encodeURIComponent(param)}`) });
  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-20 p-4" onClick={onClose}>
      <div className="bg-surface rounded-lg shadow-card w-full max-w-lg max-h-[80vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-border flex items-center">
          <span className="font-semibold text-sm">{title}</span>
          <button onClick={onClose} className="ml-auto text-text-muted hover:text-text">✕</button>
        </div>
        <div className="p-5">
          {isLoading ? <div className="text-text-muted text-sm">Loading…</div> : (
            <table className="w-full text-sm">
              <tbody className="divide-y divide-border">
                {(data?.rows ?? []).map((r, i) => (
                  <tr key={i}>
                    <td className="py-1.5">{r.customer ?? r.customer_name}</td>
                    <td className="py-1.5 text-text-muted">{r.application_no ?? r.series ?? ''}</td>
                    <td className="py-1.5 text-right mono">{formatINR(r.total_amount ?? r.net_payment ?? 0)}</td>
                  </tr>
                ))}
                {!(data?.rows ?? []).length && <tr><td className="py-4 text-center text-text-muted">No rows.</td></tr>}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
