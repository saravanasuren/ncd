import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api, ApiError } from '../api/client.js';
import { useAuth } from '../auth/AuthContext.js';

/** Reports hub (docs/06 §5) — SOA, TDS, full dump, and the 9-tab book, plus
 * the backdated importer. */
export function ReportsPage() {
  const { can } = useAuth();
  const [cust, setCust] = useState('');
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const [rows, setRows] = useState('');
  const [msg, setMsg] = useState('');

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
          <h2 className="text-sm font-semibold mb-2">NCD book (9 tabs)</h2>
          <a href="/api/reports/ncd-book.xlsx" className={dl}>↓ Download Excel</a>
        </div>
        <div className={card}>
          <h2 className="text-sm font-semibold mb-2">Statement of account (PDF)</h2>
          <div className="flex gap-2 items-center">
            <input className={inp} placeholder="Customer ID" value={cust} onChange={(e) => setCust(e.target.value)} />
            {cust && <a href={`/api/reports/soa/${cust}.pdf`} target="_blank" rel="noreferrer" className={dl}>↓ SOA</a>}
          </div>
        </div>
        <div className={card}>
          <h2 className="text-sm font-semibold mb-2">TDS register</h2>
          <div className="flex gap-2 items-center">
            <input className={inp} type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
            <a href={`/api/reports/tds/${month}.xlsx`} className={dl}>↓ TDS</a>
          </div>
        </div>
        {can('settings:manage') && (
          <div className={card}>
            <h2 className="text-sm font-semibold mb-2">Full database dump</h2>
            <a href="/api/reports/dump.xlsx" className={dl}>↓ Dump</a>
          </div>
        )}
      </div>

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
