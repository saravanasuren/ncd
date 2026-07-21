import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { formatINR } from '@new-wealth/shared';
import { api } from '../api/client.js';
import { DataTable, type Column } from '../components/DataTable.js';

type Seg = 'series' | 'customer' | 'district' | 'agent' | 'staff' | 'branch' | 'lockerhub' | 'dhanamfin';
const TABS: { key: Seg; label: string }[] = [
  { key: 'series', label: 'Series-wise' },
  { key: 'customer', label: 'Customer-wise' },
  { key: 'district', label: 'District-wise' },
  { key: 'agent', label: 'Agent-wise' },
  { key: 'staff', label: 'Staff-wise' },
  { key: 'branch', label: 'Branch-wise' },
  { key: 'lockerhub', label: 'Locker Hub' },
  { key: 'dhanamfin', label: 'Dhanamfin' },
];
const TAB_KEYS = TABS.map((t) => t.key);

interface Child {
  application_no: string; customer_id: number; customer: string; customer_code: string;
  series_code: string; amount: string; status: string; allotment_date: string | null;
}
interface Group {
  key: string; label: string; sublabel: string | null; district: string | null; sourced_by: string | null;
  investors: number; investments: number; outstanding: string; children: Child[];
  window_from?: string | null; window_to?: string | null; issued?: string; redeemed?: string;
}

/** "Jun 2026 – Jul 2026" (or a single month) from the collection window dates. */
function fmtWindow(from?: string | null, to?: string | null): string {
  if (!from && !to) return '—';
  const m = (d: string) => new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { month: 'short', year: 'numeric' });
  const a = from ? m(from) : '—';
  const b = to ? m(to) : '—';
  return a === b ? a : `${a} – ${b}`;
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

  const [profile, setProfile] = useState<{ id: number; name: string } | null>(null);

  const switchTab = (t: Seg) => {
    setTab(t);
    setExpanded(new Set());
    setParams({}, { replace: true }); // drop any deep-link params on manual navigation
  };
  const toggle = (key: string) =>
    setExpanded((s) => { const n = new Set(s); n.has(key) ? n.delete(key) : n.add(key); return n; });

  return (
    <div className="w-full">
      <h1 className="text-xl font-bold tracking-tight m-0">Segments</h1>
      <p className="text-sm text-text-muted mt-1 mb-4">The book sliced by series, customer, district, agent, staff, branch, and funding channel (Locker Hub / Dhanamfin). Click a row's <span className="font-mono">+</span> to see its individual investments (including redeemed ones).</p>
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
          // Series-wise defaults to series-number descending (NCD 27 → 10);
          // the numeric-aware sort reads the embedded number in the code.
          defaultSort={tab === 'series' ? { key: 'label', dir: 'desc' } : { key: 'outstanding', dir: 'desc' }}
          empty="No data."
          renderExpanded={(g) => (expanded.has(g.key) ? <ChildTable tab={tab} rows={g.children} onPickCustomer={(c) => setProfile({ id: c.customer_id, name: c.customer })} /> : null)}
        />
      )}
      {profile && <CustomerProfileModal id={profile.id} name={profile.name} onClose={() => setProfile(null)} />}
    </div>
  );
}

/** Customer profile popup — opened by clicking a customer in an expanded row. */
function CustomerProfileModal({ id, name, onClose }: { id: number; name: string; onClose: () => void }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['customer-profile', id],
    queryFn: () => api.get<any>(`/api/customers/${id}`),
  });
  const c = data?.customer;
  const apps: any[] = data?.applications ?? [];
  const invested = apps.reduce((s, a) => s + Number(a.amount ?? 0), 0);
  const live = apps.reduce((s, a) => s + Number(a.outstanding ?? 0), 0);
  const Field = ({ label, value }: { label: string; value: unknown }) => (
    <span className="contents">
      <dt className="text-text-muted">{label}</dt>
      <dd className="m-0 font-medium break-words">{value == null || value === '' ? '—' : String(value)}</dd>
    </span>
  );

  return (
    <div className="fixed inset-0 z-40 bg-black/40 flex items-start justify-center overflow-y-auto py-8 px-4" onClick={onClose}>
      <div className="bg-surface border border-border rounded-lg shadow-lg w-full max-w-3xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-border sticky top-0 bg-surface">
          <div>
            <h2 className="text-base font-bold m-0">{c?.full_name ?? name}</h2>
            <div className="text-xs text-text-muted mt-0.5 font-mono">{c?.customer_code ?? ''}</div>
          </div>
          <button onClick={onClose} className="text-text-muted hover:text-text text-lg leading-none" aria-label="Close">✕</button>
        </div>
        <div className="p-4 max-h-[70vh] overflow-y-auto">
          {isLoading ? <div className="text-sm text-text-muted">Loading…</div>
            : error ? <div className="text-sm text-danger">Couldn't load this customer (they may be outside your scope).</div>
            : (
            <>
              <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-sm bg-bg rounded p-3 mb-4">
                <Field label="Phone" value={c?.phone} />
                <Field label="Email" value={c?.email} />
                <Field label="PAN" value={c?.pan} />
                <Field label="District" value={c?.district} />
                <Field label="KYC" value={c?.kyc_status} />
                <Field label="Referred by" value={c?.referred_by_text} />
              </dl>
              <div className="flex gap-3 mb-3 text-sm">
                <div className="flex-1 bg-bg rounded p-3">
                  <div className="text-xs text-text-muted uppercase tracking-wide">Invested</div>
                  <div className="mono font-bold">{formatINR(invested)}</div>
                </div>
                <div className="flex-1 bg-bg rounded p-3">
                  <div className="text-xs text-text-muted uppercase tracking-wide">Outstanding</div>
                  <div className="mono font-bold text-primary">{formatINR(live)}</div>
                </div>
                <div className="flex-1 bg-bg rounded p-3">
                  <div className="text-xs text-text-muted uppercase tracking-wide">Investments</div>
                  <div className="mono font-bold">{apps.length}</div>
                </div>
              </div>
              <h3 className="text-xs font-semibold text-text-label uppercase tracking-wide mb-2">Investments</h3>
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-text-muted border-b border-border">
                    <th className="py-1 pr-3 font-medium">App no.</th>
                    <th className="py-1 pr-3 font-medium">Series</th>
                    <th className="py-1 pr-3 font-medium">Status</th>
                    <th className="py-1 pr-3 font-medium">Received</th>
                    <th className="py-1 text-right font-medium">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {apps.map((a) => (
                    <tr key={a.id} className="border-b border-border/60 last:border-0">
                      <td className="py-1 pr-3 font-mono">{a.application_no}</td>
                      <td className="py-1 pr-3">{a.series_code}</td>
                      <td className="py-1 pr-3">{a.status}</td>
                      <td className="py-1 pr-3">{a.date_money_received ? String(a.date_money_received).slice(0, 10) : '—'}</td>
                      <td className="py-1 text-right mono">{formatINR(a.amount)}</td>
                    </tr>
                  ))}
                  {apps.length === 0 && <tr><td colSpan={5} className="py-2 text-center text-text-muted">No investments.</td></tr>}
                </tbody>
              </table>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function groupColumns(tab: Seg, expanded: Set<string>, toggle: (k: string) => void): Column<Group>[] {
  // Expander shows only the label; tab-specific fields (status / customer id)
  // get their own columns below so they're independently sortable/filterable.
  const expander = (g: Group) => (
    <button onClick={() => toggle(g.key)} className="inline-flex items-center gap-2 text-left hover:text-primary">
      <span className="w-4 h-4 inline-flex items-center justify-center rounded border border-border-strong text-[11px] leading-none text-text-muted">
        {expanded.has(g.key) ? '−' : '+'}
      </span>
      <span className="font-medium">{g.label}</span>
    </button>
  );
  const investors: Column<Group> = { key: 'investors', header: 'Investors', align: 'right', value: (g) => g.investors };
  const ncds: Column<Group> = { key: 'investments', header: 'NCDs', align: 'right', value: (g) => g.investments };
  const outstanding: Column<Group> = { key: 'outstanding', header: 'Outstanding', align: 'right', value: (g) => Number(g.outstanding), render: (g) => <span className="mono">{formatINR(g.outstanding)}</span> };

  if (tab === 'series') {
    return [
      { key: 'label', header: 'Series', value: (g) => g.label, render: expander },
      { key: 'status', header: 'Allotment status', value: (g) => g.sublabel ?? '',
        render: (g) => <span className="text-xs rounded px-1.5 py-0.5 bg-bg">{g.sublabel ?? '—'}</span> },
      { key: 'window', header: 'Window', sortable: false, value: (g) => g.window_from ?? '',
        render: (g) => <span className="text-xs whitespace-nowrap">{fmtWindow(g.window_from, g.window_to)}</span> },
      investors, ncds,
      { key: 'issued', header: 'Issued', align: 'right', value: (g) => Number(g.issued ?? 0), render: (g) => <span className="mono">{formatINR(g.issued ?? 0)}</span> },
      { key: 'redeemed', header: 'Redeemed', align: 'right', value: (g) => Number(g.redeemed ?? 0),
        render: (g) => Number(g.redeemed ?? 0) > 0 ? <span className="mono text-danger">{formatINR(g.redeemed ?? 0)}</span> : <span className="text-text-muted">—</span> },
      outstanding,
    ];
  }
  if (tab === 'customer') {
    return [
      { key: 'label', header: 'Customer', value: (g) => g.label, render: expander },
      { key: 'code', header: 'Customer ID', value: (g) => g.sublabel ?? '', tdClassName: 'font-mono text-xs', render: (g) => g.sublabel ?? '—' },
      { key: 'district', header: 'District', value: (g) => g.district ?? '', render: (g) => g.district ?? '—' },
      { key: 'sourced_by', header: 'Sourced by', value: (g) => g.sourced_by ?? '', render: (g) => g.sourced_by ?? '—' },
      ncds, outstanding,
    ];
  }
  if (tab === 'lockerhub' || tab === 'dhanamfin') {
    // Funding-channel views group by series (only that channel's investments).
    return [
      { key: 'label', header: 'Series', value: (g) => g.label, render: expander },
      { key: 'status', header: 'Allotment status', value: (g) => g.sublabel ?? '',
        render: (g) => <span className="text-xs rounded px-1.5 py-0.5 bg-bg">{g.sublabel ?? '—'}</span> },
      investors, ncds, outstanding,
    ];
  }
  const label = tab === 'district' ? 'District' : tab === 'branch' ? 'Branch' : tab === 'agent' ? 'Agent' : 'Staff';
  return [{ key: 'label', header: label, value: (g) => g.label, render: expander }, investors, ncds, outstanding];
}

function ChildTable({ tab, rows, onPickCustomer }: { tab: Seg; rows: Child[]; onPickCustomer: (c: Child) => void }) {
  // Per-tab detail columns (besides Amount, always last, right-aligned).
  const cols: [string, keyof Child][] =
    tab === 'customer' ? [['Series', 'series_code'], ['App no.', 'application_no'], ['Status', 'status'], ['Allotted', 'allotment_date']]
    : (tab === 'series' || tab === 'lockerhub' || tab === 'dhanamfin') ? [['Customer', 'customer'], ['App no.', 'application_no'], ['Status', 'status'], ['Allotted', 'allotment_date']]
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
                  {k === 'application_no' ? <span className="font-mono">{r[k]}</span>
                    : k === 'customer' ? (
                      <button onClick={() => onPickCustomer(r)} className="text-primary hover:underline text-left">
                        {r.customer}
                      </button>
                    )
                    : k === 'allotment_date' ? (r[k] ? String(r[k]).slice(0, 10) : '—')
                    : (r[k] ?? '—')}
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
