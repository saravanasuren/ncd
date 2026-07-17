import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, ApiError } from '../api/client.js';
import { useAuth } from '../auth/AuthContext.js';

const currentFyQuarter = () => {
  const d = new Date();
  const m = d.getMonth(); // 0=Jan
  const fy = m >= 3 ? d.getFullYear() : d.getFullYear() - 1;
  const q = m >= 3 && m <= 5 ? 1 : m >= 6 && m <= 8 ? 2 : m >= 9 && m <= 11 ? 3 : 4;
  return `${fy}-Q${q}`;
};

/** The current FY quarter plus the previous 7, newest first. */
const recentQuarters = (): string[] => {
  const cur = currentFyQuarter();
  let fy = Number(cur.split('-Q')[0]);
  let q = Number(cur.split('-Q')[1]);
  const out: string[] = [];
  for (let i = 0; i < 8; i++) {
    out.push(`${fy}-Q${q}`);
    q -= 1;
    if (q < 1) { q = 4; fy -= 1; }
  }
  return out;
};

/** Reports hub (docs/06 §5) — SOA, TDS, 26Q, full dump, the filtered 9-tab
 * book, plus the backdated importer. */
export function ReportsPage() {
  const { can } = useAuth();
  const [cust, setCust] = useState('');
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const [quarter, setQuarter] = useState(currentFyQuarter());
  const [rows, setRows] = useState('');
  const [msg, setMsg] = useState('');

  // NCD book filters (passed as querystring to the streaming XLSX download).
  const [bookFrom, setBookFrom] = useState('');
  const [bookTo, setBookTo] = useState('');
  const [bookSeries, setBookSeries] = useState<string[]>([]);
  const [bookStatus, setBookStatus] = useState('');
  const series = useQuery({ queryKey: ['series'], queryFn: () => api.get<{ rows: { id: number; code: string }[] }>('/api/series'), enabled: can('reports:download') });
  const bookHref = (() => {
    const p = new URLSearchParams();
    if (bookFrom) p.set('from', bookFrom);
    if (bookTo) p.set('to', bookTo);
    if (bookSeries.length) p.set('series', bookSeries.join(','));
    if (bookStatus) p.set('status', bookStatus);
    const qs = p.toString();
    return `/api/reports/ncd-book.xlsx${qs ? `?${qs}` : ''}`;
  })();

  const importRun = useMutation({
    mutationFn: async () => {
      const parsed = rows.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
        const [full_name, pan, series_code, scheme_code, amount, allotment_date] = l.split(',').map((x) => x.trim());
        return { full_name: full_name!, pan: pan || undefined, series_code: series_code!, scheme_code: scheme_code!, amount: Number(amount), allotment_date: allotment_date! };
      });
      return api.post<{ created: number; skipped: number }>('/api/imports/backdated', { rows: parsed });
    },
    onSuccess: (r) => { setMsg(`Imported ${r.created}, skipped ${r.skipped}.`); setRows(''); },
    onError: (e) => setMsg(e instanceof ApiError ? e.message : 'Failed'),
  });

  const card = 'bg-surface border border-border rounded-lg shadow-card p-5';
  const dl = 'text-sm bg-primary hover:bg-primary-hover text-white rounded px-4 py-2 font-semibold no-underline inline-block';
  const inp = 'px-2.5 py-1.5 text-sm border border-border-strong rounded';

  return (
    <div className="w-full">
      <h1 className="text-xl font-bold tracking-tight m-0">Reports</h1>
      <p className="text-sm text-text-muted mt-1 mb-5">Downloads and imports.</p>
      {msg && <div className="text-xs text-primary mb-3">{msg}</div>}

      <div className="grid md:grid-cols-2 gap-4">
        <div className={card}>
          <h2 className="text-sm font-semibold mb-2">Statement of account (PDF)</h2>
          <div className="flex gap-2 items-center">
            <input className={inp} placeholder="Customer ID" value={cust} onChange={(e) => setCust(e.target.value)} />
            {cust && <a href={`/api/reports/soa/${cust}.pdf`} target="_blank" rel="noreferrer" className={dl}>↓ SOA</a>}
          </div>
        </div>
        <div className={card}>
          <h2 className="text-sm font-semibold mb-2">TDS register (monthly)</h2>
          <div className="flex gap-2 items-center">
            <input className={inp} type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
            <a href={`/api/reports/tds/${month}.xlsx`} className={dl}>↓ TDS</a>
          </div>
        </div>
        {can('reports:download') && (
          <div className={card}>
            <h2 className="text-sm font-semibold mb-2">26Q filing annexure (quarterly)</h2>
            <div className="flex gap-2 items-center">
              <select className={inp} value={quarter} onChange={(e) => setQuarter(e.target.value)}>
                {recentQuarters().map((qv) => <option key={qv} value={qv}>{qv}</option>)}
              </select>
              <a href={`/api/reports/tds-26q/${quarter}.xlsx`} className={dl}>↓ 26Q</a>
            </div>
          </div>
        )}
        {can('settings:manage') && (
          <div className={card}>
            <h2 className="text-sm font-semibold mb-2">Full database dump</h2>
            <a href="/api/reports/dump.xlsx" className={dl}>↓ Dump</a>
          </div>
        )}
      </div>

      {can('reports:download') && (
        <div className={`${card} mt-4`}>
          <h2 className="text-sm font-semibold mb-2">NCD book (9-tab Excel) — filtered</h2>
          <div className="flex flex-wrap gap-2 items-center">
            <label className="text-xs text-text-muted">From <input className={`${inp} ml-1`} type="date" value={bookFrom} onChange={(e) => setBookFrom(e.target.value)} /></label>
            <label className="text-xs text-text-muted">To <input className={`${inp} ml-1`} type="date" value={bookTo} onChange={(e) => setBookTo(e.target.value)} /></label>
            <select className={inp} value={bookStatus} onChange={(e) => setBookStatus(e.target.value)}>
              <option value="">All statuses</option>
              <option value="active">Active</option>
              <option value="redeemed">Redeemed</option>
            </select>
            <select className={inp} multiple size={1} value={bookSeries}
              onChange={(e) => setBookSeries(Array.from(e.target.selectedOptions, (o) => o.value))}>
              {(series.data?.rows ?? []).map((s) => <option key={s.id} value={s.id}>{s.code}</option>)}
            </select>
            <a href={bookHref} className={dl}>↓ NCD book</a>
          </div>
          <p className="text-xs text-text-muted mt-2">Leave filters blank for the full book. Ctrl/Cmd-click to pick multiple series.</p>
        </div>
      )}

      {can('imports:run') && (
        <div className={`${card} mt-4`}>
          <h2 className="text-sm font-semibold mb-1">Backdated import</h2>
          <p className="text-xs text-text-muted mb-2">One investment per line: <span className="mono">full_name, pan, series_code, scheme_code, amount, allotment_date</span>. Re-running is safe (idempotent).</p>
          <textarea className="w-full h-24 px-2.5 py-2 text-sm border border-border-strong rounded font-mono outline-none focus:border-primary"
            placeholder={'Ramesh Kumar, ABCDE1234F, NCD DEMO, NCD-DEMO, 500000, 2025-01-01'} value={rows} onChange={(e) => setRows(e.target.value)} />
          <button disabled={!rows.trim() || importRun.isPending} onClick={() => { setMsg(''); importRun.mutate(); }}
            className="mt-2 text-xs bg-primary text-white rounded px-4 py-1.5 disabled:opacity-40 hover:bg-primary-hover">Run import</button>
        </div>
      )}
    </div>
  );
}
