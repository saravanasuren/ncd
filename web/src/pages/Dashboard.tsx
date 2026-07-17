import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { PieChart, Pie, Cell, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { formatINR } from '@new-wealth/shared';
import { api } from '../api/client.js';
import { useAuth } from '../auth/AuthContext.js';

// ── Range model ────────────────────────────────────────────────────────────
interface Range { from: string; to: string; series: number[] | null; label: string }

const iso = (d: Date) => d.toISOString().slice(0, 10);
/** Indian financial year: starts 1 April. Returns the starting calendar year. */
function fyStartYear(d: Date): number {
  return d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
}
function monthStart(d: Date): Date { return new Date(d.getFullYear(), d.getMonth(), 1); }

/** Build the default range: 1st of this month → today (MTD). */
function defaultRange(): Range {
  const now = new Date();
  return { from: iso(monthStart(now)), to: iso(now), series: null, label: 'This month' };
}

/** Date-based quick ranges (series picks are added separately once data loads). */
function dateQuickRanges(): { key: string; label: string; range: Omit<Range, 'label'> }[] {
  const now = new Date();
  const y = now.getFullYear();
  const fy = fyStartYear(now);
  const mk = (from: Date, to: Date): Omit<Range, 'label'> => ({ from: iso(from), to: iso(to), series: null });
  const lastMonthStart = new Date(y, now.getMonth() - 1, 1);
  const lastMonthEnd = new Date(y, now.getMonth(), 0);
  return [
    { key: 'today', label: 'Today', range: mk(now, now) },
    { key: 'mtd', label: 'This month', range: mk(monthStart(now), now) },
    { key: 'last-month', label: 'Last month', range: mk(lastMonthStart, lastMonthEnd) },
    { key: 'q1', label: 'Q1 (Apr–Jun)', range: mk(new Date(fy, 3, 1), new Date(fy, 6, 0)) },
    { key: 'q2', label: 'Q2 (Jul–Sep)', range: mk(new Date(fy, 6, 1), new Date(fy, 9, 0)) },
    { key: 'q3', label: 'Q3 (Oct–Dec)', range: mk(new Date(fy, 9, 1), new Date(fy, 12, 0)) },
    { key: 'q4', label: 'Q4 (Jan–Mar)', range: mk(new Date(fy + 1, 0, 1), new Date(fy + 1, 3, 0)) },
    { key: 'this-fy', label: 'This FY', range: mk(new Date(fy, 3, 1), now) },
    { key: 'last-fy', label: 'Last FY', range: mk(new Date(fy - 1, 3, 1), new Date(fy, 3, 0)) },
  ];
}

function qs(r: Range): string {
  const p = new URLSearchParams();
  if (r.from) p.set('from', r.from);
  if (r.to) p.set('to', r.to);
  if (r.series?.length) p.set('series', r.series.join(','));
  return p.toString();
}

/** NCD Portfolio dashboard — quick ranges + clickable tiles → drill-down. */
export function Dashboard() {
  const { can } = useAuth();
  const canDrill = can('dashboard:drilldown');
  const [range, setRange] = useState<Range>(defaultRange);
  const [drill, setDrill] = useState<{ widget: string; title: string } | null>(null);

  const overview = useQuery({
    queryKey: ['dash-overview', range.from, range.to, (range.series ?? []).join(',')],
    queryFn: () => api.get<any>(`/api/dashboard/overview?${qs(range)}`),
  });

  const activeSeries = overview.data?.active_series;
  const lastSeries = overview.data?.last_series;

  function pickWidget(widget: string, title: string) {
    if (!canDrill) return;
    setDrill({ widget, title });
  }

  return (
    <div className="w-full">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
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

      <RangeBar range={range} setRange={setRange} activeSeries={activeSeries} lastSeries={lastSeries} />

      {overview.isLoading ? <div className="text-text-muted mt-6">Loading dashboard…</div>
        : overview.error ? <div className="text-danger mt-6">Failed to load dashboard.</div>
          : (() => {
            const k = overview.data.kpis, f = overview.data.flow;
            return (
              <>
                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 mt-5 mb-6">
                  <Tile label="Active series" value={activeSeries ? activeSeries.code : '—'}
                    sub={activeSeries ? `${formatINR(activeSeries.outstanding)} · ${activeSeries.investments} NCDs` : 'No open series'}
                    primary onClick={() => pickWidget('series', 'Active series → series-wise book')} canDrill={canDrill} />
                  <Tile label="Outstanding book" value={formatINR(k.outstanding_book)} sub={`${k.active_investors} investors`}
                    onClick={() => pickWidget('outstanding', 'Outstanding book — by series')} canDrill={canDrill} />
                  <Tile label="New investments" value={formatINR(f.money_in)} sub={`${f.new_investments} in range`}
                    onClick={() => pickWidget('new-investments', 'New investments in range')} canDrill={canDrill} />
                  <Tile label="Locker deposits" value={formatINR(f.money_in_locker)} sub="Money in · locker"
                    onClick={() => pickWidget('locker', 'Locker deposits in range')} canDrill={canDrill} />
                  <Tile label="DhanamFin app" value={formatINR(f.money_in_app)} sub="Money in · app"
                    onClick={() => pickWidget('app', 'DhanamFin app investments in range')} canDrill={canDrill} />
                  <Tile label="Monthly interest" value={formatINR(f.interest_month)} sub={`${formatINR(f.interest_paid_month)} paid`}
                    onClick={() => pickWidget('interest-month', 'Interest due in range')} canDrill={canDrill} />
                  <Tile label="Interest accrued" value={formatINR(f.interest_accrued)} sub="Since last payout, till date"
                    onClick={() => pickWidget('interest-accrued', 'Interest accrued since last payout')} canDrill={canDrill} />
                  <Tile label="Redemptions" value={formatINR(f.redemptions_total)} sub={`${f.redemptions_count} in range`}
                    onClick={() => pickWidget('redemptions', 'Redemptions in range')} canDrill={canDrill} />
                  <Tile label="Staff-wise" value={formatINR(f.money_in)} sub="New business by staff"
                    onClick={() => pickWidget('staff', 'New business by staff (in range)')} canDrill={canDrill} />
                  <Tile label="Agent-wise" value={formatINR(f.money_in)} sub="New business by agent"
                    onClick={() => pickWidget('agent', 'New business by agent (in range)')} canDrill={canDrill} />
                </div>

                <div className="grid md:grid-cols-2 gap-5">
                  <PieCard title="Series register" rows={overview.data.series ?? []} nameKey="code" valueKey="outstanding" tab="series" canDrill={canDrill} />
                  <PieCard title="District distribution" rows={overview.data.districts ?? []} nameKey="district" valueKey="amount" tab="district" canDrill={canDrill} />
                </div>
              </>
            );
          })()}

      {drill && <DrillModal widget={drill.widget} title={drill.title} range={range} onClose={() => setDrill(null)} />}
    </div>
  );
}

// ── Range bar ──────────────────────────────────────────────────────────────
function RangeBar({ range, setRange, activeSeries, lastSeries }: {
  range: Range; setRange: (r: Range) => void; activeSeries: any; lastSeries: any;
}) {
  const ranges = useMemo(dateQuickRanges, []);
  const isActive = (key: string, label: string) => range.label === label || range.label === key;
  const chip = (active: boolean) =>
    `text-xs rounded-full px-3 py-1 border ${active ? 'bg-primary text-white border-primary' : 'bg-surface border-border hover:border-primary'}`;
  return (
    <div className="bg-surface border border-border rounded-lg shadow-card p-3">
      <div className="flex flex-wrap items-center gap-1.5">
        {ranges.map((r) => (
          <button key={r.key} className={chip(isActive(r.key, r.label))}
            onClick={() => setRange({ ...r.range, label: r.label })}>{r.label}</button>
        ))}
        {activeSeries && (
          <button className={chip(range.series?.[0] === activeSeries.series_id)}
            onClick={() => setRange({ from: '', to: '', series: [activeSeries.series_id], label: `Active series (${activeSeries.code})` })}>
            Active series
          </button>
        )}
        {lastSeries && (
          <button className={chip(range.series?.[0] === lastSeries.series_id)}
            onClick={() => setRange({ from: '', to: '', series: [lastSeries.series_id], label: `Last series (${lastSeries.code})` })}>
            Last series
          </button>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2 mt-2.5 text-xs text-text-muted">
        <span>Custom:</span>
        <input type="date" className="px-2 py-1 border border-border-strong rounded outline-none focus:border-primary"
          value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value, series: null, label: 'Custom' })} />
        <span>→</span>
        <input type="date" className="px-2 py-1 border border-border-strong rounded outline-none focus:border-primary"
          value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value, series: null, label: 'Custom' })} />
        <span className="ml-1 font-medium text-text-label">Showing: {range.label}</span>
      </div>
    </div>
  );
}

// ── Tiles ──────────────────────────────────────────────────────────────────
function Tile({ label, value, sub, primary, onClick, canDrill }: {
  label: string; value: string; sub?: string; primary?: boolean; onClick?: () => void; canDrill: boolean;
}) {
  return (
    <button type="button" onClick={canDrill ? onClick : undefined} disabled={!canDrill}
      className={`text-left bg-surface border rounded-lg shadow-card p-4 transition
        ${primary ? 'border-primary' : 'border-border'} ${canDrill ? 'hover:shadow-md hover:border-primary cursor-pointer' : 'cursor-default'}`}>
      <div className="text-xs font-semibold text-text-label uppercase tracking-wide">{label}</div>
      <div className={`mt-1 text-lg font-bold mono ${primary ? 'text-primary' : ''}`}>{value}</div>
      {sub && <div className="text-[11px] text-text-muted mt-0.5">{sub}</div>}
      {canDrill && <div className="text-[10px] text-primary mt-1">View details →</div>}
    </button>
  );
}

// ── Drill-down modal ───────────────────────────────────────────────────────
interface FlatCol { key: string; header: string; kind?: 'money' | 'date' | 'num' }
const INVESTMENT_COLS: FlatCol[] = [
  { key: 'application_no', header: 'App No' }, { key: 'customer', header: 'Customer' },
  { key: 'series_code', header: 'Series' }, { key: 'amount', header: 'Amount', kind: 'money' },
  { key: 'date_money_received', header: 'Received', kind: 'date' }, { key: 'status', header: 'Status' },
];
const FLAT_COLS: Record<string, FlatCol[]> = {
  'new-investments': INVESTMENT_COLS,
  locker: INVESTMENT_COLS,
  app: INVESTMENT_COLS,
  'interest-month': [
    { key: 'due_date', header: 'Due', kind: 'date' }, { key: 'customer', header: 'Customer' },
    { key: 'series_code', header: 'Series' }, { key: 'due_type', header: 'Type' },
    { key: 'amount', header: 'Net', kind: 'money' }, { key: 'status', header: 'Status' },
  ],
  'interest-accrued': [
    { key: 'customer', header: 'Customer' }, { key: 'series_code', header: 'Series' },
    { key: 'principal', header: 'Principal', kind: 'money' }, { key: 'coupon_rate_pct', header: 'Coupon %', kind: 'num' },
    { key: 'days', header: 'Days', kind: 'num' }, { key: 'amount', header: 'Accrued', kind: 'money' },
  ],
  redemptions: [
    { key: 'redemption_date', header: 'Date', kind: 'date' }, { key: 'customer_name', header: 'Customer' },
    { key: 'series_code', header: 'Series' }, { key: 'type', header: 'Type' },
    { key: 'net_payment', header: 'Net paid', kind: 'money' },
  ],
};

function cell(v: unknown, kind?: FlatCol['kind']) {
  if (v == null || v === '') return '—';
  if (kind === 'money') return formatINR(Number(v));
  if (kind === 'date') return String(v).slice(0, 10);
  if (kind === 'num') return String(v);
  return String(v);
}

function DrillModal({ widget, title, range, onClose }: { widget: string; title: string; range: Range; onClose: () => void }) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const q = useQuery({
    queryKey: ['drill', widget, range.from, range.to, (range.series ?? []).join(',')],
    queryFn: () => api.get<any>(`/api/dashboard/drill/${widget}?${qs(range)}`),
  });
  const kind = q.data?.kind;
  const groups: any[] = q.data?.groups ?? [];
  const rows: any[] = q.data?.rows ?? [];
  const cols = FLAT_COLS[widget] ?? [];
  const toggle = (key: string) => setOpen((s) => { const n = new Set(s); n.has(key) ? n.delete(key) : n.add(key); return n; });

  return (
    <div className="fixed inset-0 z-40 bg-black/40 flex items-start justify-center overflow-y-auto py-8 px-4" onClick={onClose}>
      <div className="bg-surface border border-border rounded-lg shadow-lg w-full max-w-4xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-border sticky top-0 bg-surface">
          <div>
            <h2 className="text-base font-bold m-0">{title}</h2>
            <div className="text-xs text-text-muted mt-0.5">{range.label}</div>
          </div>
          <button onClick={onClose} className="text-text-muted hover:text-text text-lg leading-none" aria-label="Close">✕</button>
        </div>
        <div className="p-4 max-h-[70vh] overflow-y-auto">
          {q.isLoading ? <div className="text-text-muted text-sm">Loading…</div>
            : q.error ? <div className="text-danger text-sm">Failed to load.</div>
              : kind === 'groups' ? (
                groups.length === 0 ? <Empty /> : (
                  <table className="w-full text-sm border-collapse">
                    <thead><tr className="text-left text-xs text-text-label uppercase tracking-wide border-b border-border">
                      <th className="py-2 pr-3">Group</th><th className="py-2 px-3 text-right">Investors</th>
                      <th className="py-2 px-3 text-right">NCDs</th><th className="py-2 pl-3 text-right">Outstanding</th>
                    </tr></thead>
                    <tbody>
                      {groups.map((g) => (
                        <GroupRows key={g.key} g={g} open={open.has(g.key)} onToggle={() => toggle(g.key)} />
                      ))}
                    </tbody>
                  </table>
                )
              ) : (
                rows.length === 0 ? <Empty /> : (
                  <table className="w-full text-sm border-collapse">
                    <thead><tr className="text-left text-xs text-text-label uppercase tracking-wide border-b border-border">
                      {cols.map((c) => <th key={c.key} className={`py-2 px-2 ${c.kind === 'money' || c.kind === 'num' ? 'text-right' : ''}`}>{c.header}</th>)}
                    </tr></thead>
                    <tbody>
                      {rows.map((r, i) => (
                        <tr key={i} className="border-b border-border/60">
                          {cols.map((c) => (
                            <td key={c.key} className={`py-1.5 px-2 ${c.kind === 'money' || c.kind === 'num' ? 'text-right mono' : ''}`}>{cell(r[c.key], c.kind)}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                    {cols.some((c) => c.kind === 'money') && (
                      <tfoot><tr className="border-t-2 border-border font-semibold">
                        {cols.map((c, i) => (
                          <td key={c.key} className={`py-2 px-2 ${c.kind === 'money' || c.kind === 'num' ? 'text-right mono' : ''}`}>
                            {i === 0 ? `Total (${rows.length})` : c.kind === 'money'
                              ? formatINR(rows.reduce((s, r) => s + Number(r[c.key] || 0), 0)) : ''}
                          </td>
                        ))}
                      </tr></tfoot>
                    )}
                  </table>
                )
              )}
        </div>
      </div>
    </div>
  );
}

function GroupRows({ g, open, onToggle }: { g: any; open: boolean; onToggle: () => void }) {
  return (
    <>
      <tr className="border-b border-border/60 cursor-pointer hover:bg-bg" onClick={onToggle}>
        <td className="py-2 pr-3 font-medium">
          <span className="inline-block w-4 text-text-muted">{open ? '▾' : '▸'}</span>
          {g.label}{g.sublabel && <span className="text-text-muted text-xs"> · {g.sublabel}</span>}
        </td>
        <td className="py-2 px-3 text-right mono">{g.investors}</td>
        <td className="py-2 px-3 text-right mono">{g.investments}</td>
        <td className="py-2 pl-3 text-right mono font-semibold">{formatINR(g.outstanding)}</td>
      </tr>
      {open && g.children.map((ch: any) => (
        <tr key={ch.application_no} className="bg-bg/50 text-xs">
          <td className="py-1 pl-8 pr-3">{ch.customer} <span className="text-text-muted font-mono">{ch.application_no}</span></td>
          <td className="py-1 px-3 text-right text-text-muted">{ch.series_code}</td>
          <td className="py-1 px-3 text-right text-text-muted">{ch.status}</td>
          <td className="py-1 pl-3 text-right mono">{formatINR(ch.amount)}</td>
        </tr>
      ))}
    </>
  );
}

function Empty() { return <div className="text-center text-text-muted text-sm py-6">No records in this view.</div>; }

// ── Pie charts (snapshot → Segments) ───────────────────────────────────────
const PIE_COLORS = ['#0b5cab', '#1a7f4b', '#b3730d', '#7048c4', '#0e8a9e', '#c23838', '#3f7cd6', '#4a9e6b', '#d19a3a', '#9a6bd6'];
interface Slice { name: string; value: number; key: string }
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
function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-surface border border-border rounded-lg shadow-card overflow-hidden">
      <div className="px-4 py-3 border-b border-border text-xs font-semibold text-text-label uppercase tracking-wide">{title}</div>
      {children}
    </div>
  );
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
