import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api/client.js';
import { useAuth } from '../auth/AuthContext.js';

/** Admin → System: audit trail, notification queue, cron runs (docs/05 §23). */
export function SystemPage() {
  const { can } = useAuth();
  const [tab, setTab] = useState<'audit' | 'notifications' | 'jobs'>('audit');
  const tabs: { key: typeof tab; label: string; show: boolean }[] = [
    { key: 'audit', label: 'Audit trail', show: can('audit:read') },
    { key: 'notifications', label: 'Notifications', show: can('notifications:admin') },
    { key: 'jobs', label: 'Cron runs', show: can('settings:manage') },
  ];
  const visible = tabs.filter((t) => t.show);
  const active = visible.some((t) => t.key === tab) ? tab : visible[0]?.key ?? 'audit';

  return (
    <div className="w-full">
      <h1 className="text-xl font-bold tracking-tight m-0">System</h1>
      <p className="text-sm text-text-muted mt-1 mb-4">Audit trail, notification queue and background jobs.</p>
      <div className="flex gap-1 mb-4 border-b border-border">
        {visible.map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`px-3 py-2 text-sm border-b-2 -mb-px ${active === t.key ? 'border-primary text-primary font-semibold' : 'border-transparent text-text-muted hover:text-text'}`}>
            {t.label}
          </button>
        ))}
      </div>
      {active === 'audit' && <Audit />}
      {active === 'notifications' && <Notifications />}
      {active === 'jobs' && <Jobs />}
    </div>
  );
}

function Table({ head, rows, defaultSort }: { head: string[]; rows: (string | number)[][]; defaultSort?: { col: number; dir: 'asc' | 'desc' } }) {
  const [sortCol, setSortCol] = useState<number | null>(defaultSort?.col ?? null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>(defaultSort?.dir ?? 'asc');
  const num = (v: string | number) => { const s = String(v).replace(/[₹,%\s]/g, ''); return s !== '' && !Number.isNaN(Number(s)) ? Number(s) : null; };
  const sorted = sortCol == null ? rows : [...rows].sort((a, b) => {
    const va = a[sortCol] ?? '', vb = b[sortCol] ?? '', na = num(va), nb = num(vb), d = sortDir === 'asc' ? 1 : -1;
    if (na != null && nb != null) return (na - nb) * d;
    return String(va).localeCompare(String(vb), undefined, { numeric: true }) * d;
  });
  const click = (i: number) => { if (sortCol === i) setSortDir((x) => (x === 'asc' ? 'desc' : 'asc')); else { setSortCol(i); setSortDir('asc'); } };
  return (
    <div className="bg-surface border border-border rounded-lg shadow-card overflow-hidden">
      <table className="w-full text-sm">
        <thead><tr className="text-left text-xs font-semibold text-text-label border-b border-border">
          {head.map((h, i) => (
            <th key={h} onClick={() => click(i)} className="px-4 py-2 cursor-pointer select-none hover:text-text">
              <span className="inline-flex items-center gap-1">{h}<span className={`text-[10px] ${sortCol === i ? 'text-primary' : 'text-border-strong'}`}>{sortCol === i ? (sortDir === 'asc' ? '▲' : '▼') : '↕'}</span></span>
            </th>
          ))}
        </tr></thead>
        <tbody className="divide-y divide-border">
          {sorted.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} className="px-4 py-1.5">{c}</td>)}</tr>)}
          {rows.length === 0 && <tr><td colSpan={head.length} className="px-4 py-6 text-center text-text-muted">Nothing yet.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function Audit() {
  const { data } = useQuery({ queryKey: ['audit'], queryFn: () => api.get<{ rows: any[] }>('/api/audit') });
  return <Table head={['When', 'Actor', 'Action', 'Entity']} defaultSort={{ col: 0, dir: 'desc' }} rows={(data?.rows ?? []).map((r) => [String(r.created_at).slice(0, 19).replace('T', ' '), r.actor_name ?? '—', r.action, `${r.entity_type} ${r.entity_id ?? ''}`])} />;
}
function Notifications() {
  const qc = useQueryClient();
  const [msg, setMsg] = useState('');
  const { data } = useQuery({ queryKey: ['sys-notif'], queryFn: () => api.get<{ rows: any[] }>('/api/system/notifications') });
  const drain = useMutation({
    mutationFn: () => api.post<{ sent: number; failed: number }>('/api/system/notifications/drain', {}),
    onSuccess: (r) => { setMsg(`Drained: ${r.sent ?? 0} sent, ${r.failed ?? 0} failed.`); qc.invalidateQueries({ queryKey: ['sys-notif'] }); },
    onError: (e) => setMsg(e instanceof ApiError ? e.message : 'Failed'),
  });
  return (
    <div>
      <div className="flex items-center gap-3 mb-3">
        <button onClick={() => { setMsg(''); drain.mutate(); }} disabled={drain.isPending}
          className="text-xs border border-border rounded px-3 py-1.5 hover:bg-bg disabled:opacity-40">Drain queue now</button>
        {msg && <span className="text-xs text-primary">{msg}</span>}
      </div>
      <Table head={['Channel', 'Template', 'To', 'Status']} rows={(data?.rows ?? []).map((r) => [r.channel, r.template, r.to_address, r.status])} />
    </div>
  );
}
function Jobs() {
  const { data } = useQuery({ queryKey: ['sys-jobs'], queryFn: () => api.get<{ rows: any[] }>('/api/system/jobs') });
  return <Table head={['Job', 'Started', 'Finished', 'OK']} rows={(data?.rows ?? []).map((r) => [r.job, String(r.started_at ?? ''), String(r.finished_at ?? ''), r.ok ? '✓' : '✗'])} />;
}
