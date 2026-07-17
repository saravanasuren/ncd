import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { formatINR } from '@new-wealth/shared';
import { api } from '../api/client.js';
import { DataTable, type Column } from '../components/DataTable.js';

type Seg = 'series' | 'customer' | 'district' | 'agent' | 'staff';
const TABS: { key: Seg; label: string }[] = [
  { key: 'series', label: 'Series-wise' },
  { key: 'customer', label: 'Customer-wise' },
  { key: 'district', label: 'District-wise' },
  { key: 'agent', label: 'Agent-wise' },
  { key: 'staff', label: 'Staff-wise' },
];
const TAB_KEYS = TABS.map((t) => t.key);

interface Child {
  application_no: string; customer: string; customer_code: string;
  series_code: string; amount: string; status: string; allotment_date: string | null;
}
interface Group {
  key: string; label: string; sublabel: string | null; district: string | null; sourced_by: string | null;
  investors: number; investments: number; outstanding: string; children: Child[];
}

export function SegmentsPage() {
  const [params, setParams] = useSearchParams();
  const paramTab = params.get('tab') as Seg | null;
  const openKey = params.get('open');
  const [tab, setTab] = useState<Seg>(paramTab && TAB_KEYS.includes(paramTab) ? paramTab : 'series');
  const [expanded, setExpanded] = useState<Set<string>>(() => (openKey ? new Set([openKey]) : new Set()));

  const { data, isLoading } = useQuery({
    queryKey: ['segment', tab],
    queryFn: () => api.get<{ by: Seg; groups: Group[] }>(`/api/reports/segments/${tab}`),
  });

  // Deep-link from the dashboard charts: expand + scroll the requested group into view.
  useEffect(() => {
    if (!openKey || isLoading) return;
    setExpanded((s) => new Set(s).add(openKey));
    const el = document.getElementById(`seg-${openKey}`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [openKey, isLoading, tab]);

  const switchTab = (t: Seg) => {
    setTab(t);
    setExpanded(new Set());
    setParams({}, { replace: true }); // drop any deep-link params on manual navigation
  };
  const toggle = (key: string) =>
    setExpanded((s) => { const n = new Set(s); n.has(key) ? n.delete(key) : n.add(key); return n; });

  return (
    <div className="max-w-4xl">
      <h1 className="text-xl font-bold tracking-tight m-0">Segments</h1>
      <p className="text-sm text-text-muted mt-1 mb-4">The book sliced by series, customer, district, agent and staff. Click a row's <span className="font-mono">+</span> to see its individual investments.</p>
      <div className="flex gap-1 mb-4 border-b border-border">
        {TABS.map((t) => (
          <button key={t.key} onClick={() => switchTab(t.key)}
            className={`px-3 py-2 text-sm border-b-2 -mb-px ${tab === t.key ? 'border-primary text-primary font-semibold' : 'border-transparent text-text-muted hover:text-text'}`}>
            {t.label}
          </button>
        ))}
      </div>
      {isLoading ? <div className="text-text-muted">Loading…</div> : (
        <DataTable
          columns={groupColumns(tab, expanded, toggle)}
          rows={data!.groups}
          rowKey={(g) => g.key}
          rowId={(g) => `seg-${g.key}`}
          defaultSort={{ key: 'outstanding', dir: 'desc' }}
          empty="No data."
          renderExpanded={(g) => (expanded.has(g.key) ? <ChildTable tab={tab} rows={g.children} /> : null)}
        />
      )}
    </div>
  );
}

function groupColumns(tab: Seg, expanded: Set<string>, toggle: (k: string) => void): Column<Group>[] {
  const expander = (g: Group) => (
    <button onClick={() => toggle(g.key)} className="inline-flex items-center gap-2 text-left hover:text-primary">
      <span className="w-4 h-4 inline-flex items-center justify-center rounded border border-border-strong text-[11px] leading-none text-text-muted">
        {expanded.has(g.key) ? '−' : '+'}
      </span>
      <span className="font-medium">{g.label}</span>
      {g.sublabel && <span className="text-xs text-text-muted">{g.sublabel}</span>}
    </button>
  );
  const investors: Column<Group> = { key: 'investors', header: 'Investors', align: 'right', value: (g) => g.investors };
  const ncds: Column<Group> = { key: 'investments', header: 'NCDs', align: 'right', value: (g) => g.investments };
  const outstanding: Column<Group> = { key: 'outstanding', header: 'Outstanding', align: 'right', value: (g) => Number(g.outstanding), render: (g) => <span className="mono">{formatINR(g.outstanding)}</span> };

  if (tab === 'customer') {
    return [
      { key: 'label', header: 'Customer', value: (g) => g.label, render: expander },
      { key: 'district', header: 'District', value: (g) => g.district ?? '', render: (g) => g.district ?? '—' },
      { key: 'sourced_by', header: 'Sourced by', value: (g) => g.sourced_by ?? '', render: (g) => g.sourced_by ?? '—' },
      ncds, outstanding,
    ];
  }
  const label = tab === 'series' ? 'Series' : tab === 'district' ? 'District' : tab === 'agent' ? 'Agent' : 'Staff';
  return [{ key: 'label', header: label, value: (g) => g.label, render: expander }, investors, ncds, outstanding];
}

function ChildTable({ tab, rows }: { tab: Seg; rows: Child[] }) {
  // Per-tab detail columns (besides Amount, always last, right-aligned).
  const cols: [string, keyof Child][] =
    tab === 'customer' ? [['Series', 'series_code'], ['App no.', 'application_no'], ['Status', 'status'], ['Allotted', 'allotment_date']]
    : tab === 'series' ? [['Customer', 'customer'], ['App no.', 'application_no'], ['Status', 'status'], ['Allotted', 'allotment_date']]
    : [['Customer', 'customer'], ['Series', 'series_code'], ['App no.', 'application_no'], ['Status', 'status']];
  return (
    <div className="bg-bg/60 px-4 py-2 border-l-2 border-primary/30">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-text-muted">
            {cols.map(([h]) => <th key={h} className="py-1 pr-4 font-medium">{h}</th>)}
            <th className="py-1 text-right font-medium">Amount</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-border/60">
              {cols.map(([, k]) => (
                <td key={k} className="py-1 pr-4">
                  {k === 'application_no' ? <span className="font-mono">{r[k]}</span> : (r[k] ?? '—')}
                </td>
              ))}
              <td className="py-1 text-right mono">{formatINR(r.amount)}</td>
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={cols.length + 1} className="py-2 text-center text-text-muted">No investments.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
