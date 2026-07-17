import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../api/client.js';
import { useAuth } from '../auth/AuthContext.js';
import { DataTable, type Column } from '../components/DataTable.js';
import { Tabs, type TabDef } from '../components/Tabs.js';

interface Lead {
  id: number;
  full_name: string;
  phone: string | null;
  place: string | null;
  district: string | null;
  category: string | null;
  source: string | null;
  referred_by_text: string | null;
  interested_scheme: string | null;
  status: string;
  expected_amount: string | null;
  follow_up_date: string | null;
  notes: string | null;
}

interface LeadNote {
  id: number;
  note: string;
  created_at: string;
  author: string | null;
}

interface Prospect {
  id: number;
  customer_code: string;
  full_name: string;
  phone: string | null;
  district: string | null;
  kyc_status: string | null;
  created_at: string;
}

const PROSPECTS_TAB = '__prospects__';

const EMPTY_FORM = {
  full_name: '', phone: '', place: '', district: '', category: '', source: '',
  referred_by_text: '', interested_scheme: '', expected_amount: '', follow_up_date: '', notes: '',
};

const inp = 'px-2.5 py-1.5 text-sm border border-border-strong rounded outline-none focus:border-primary';

/** Follow-up notes for one lead: history + add box. */
function NotesPanel({ leadId, canUpdate }: { leadId: number; canUpdate: boolean }) {
  const qc = useQueryClient();
  const [note, setNote] = useState('');
  const { data, isLoading } = useQuery({
    queryKey: ['lead-notes', leadId],
    queryFn: () => api.get<{ rows: LeadNote[] }>(`/api/leads/${leadId}/notes`),
  });
  const add = useMutation({
    mutationFn: () => api.post(`/api/leads/${leadId}/notes`, { note: note.trim() }),
    onSuccess: () => { setNote(''); qc.invalidateQueries({ queryKey: ['lead-notes', leadId] }); },
  });
  return (
    <div className="bg-bg rounded p-3 mx-4 mb-3 text-xs">
      {canUpdate && (
        <div className="flex gap-2 mb-2">
          <input className={`${inp} flex-1 text-xs`} placeholder="Add a follow-up note…" value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && note.trim()) add.mutate(); }} autoFocus />
          <button disabled={!note.trim() || add.isPending} onClick={() => add.mutate()}
            className="text-xs bg-primary text-white rounded px-3 py-1.5 disabled:opacity-40 hover:bg-primary-hover">Add</button>
        </div>
      )}
      {isLoading ? 'Loading…' : (data?.rows ?? []).length === 0 ? <span className="text-text-muted">No notes yet.</span> : (
        <ul className="m-0 p-0 list-none space-y-1.5">
          {data!.rows.map((n) => (
            <li key={n.id}>
              <span className="text-text-muted font-mono">{String(n.created_at).slice(0, 10)}</span>
              {n.author && <span className="text-text-muted"> · {n.author}</span>} — {n.note}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function LeadsPage() {
  const qc = useQueryClient();
  const nav = useNavigate();
  const { can } = useAuth();
  const [form, setForm] = useState(EMPTY_FORM);
  const [err, setErr] = useState('');
  const [converting, setConverting] = useState<{ id: number; amount: string; seriesId: string } | null>(null);
  const [notesFor, setNotesFor] = useState<number | null>(null);
  const [edit, setEdit] = useState<{ id: number; status: string; follow_up_date: string; expected_amount: string } | null>(null);
  const [tab, setTab] = useState<string>('all');
  const [creating, setCreating] = useState(false);
  const [q, setQ] = useState('');

  const { data, isLoading } = useQuery({ queryKey: ['leads'], queryFn: () => api.get<{ rows: Lead[] }>('/api/leads') });
  const prospects = useQuery({ queryKey: ['app-prospects'], queryFn: () => api.get<{ rows: Prospect[] }>('/api/leads/app-prospects') });
  const series = useQuery({
    queryKey: ['series'],
    queryFn: () => api.get<{ rows: { id: number; code: string; status: string }[] }>('/api/series'),
    enabled: can('leads:convert'),
  });
  const openSeries = (series.data?.rows ?? []).filter((s) => s.status === 'Open');

  // Configurable vocabularies (docs/07 — no hardcoded business values).
  const uiConfig = useQuery({
    queryKey: ['ui-config'],
    queryFn: () => api.get<{ values: Record<string, string[] | null> }>('/api/settings/ui-config'),
  });
  const SOURCES = uiConfig.data?.values['customers.lead_sources'] ?? [];
  const STATUSES = uiConfig.data?.values['customers.lead_statuses'] ?? [];

  // Duplicate-phone check while typing a new lead's phone.
  const phone = form.phone.trim();
  const dup = useQuery({
    queryKey: ['lead-dup', phone],
    queryFn: () => api.get<{ duplicate: boolean; customer?: { id: number; customer_code: string; full_name: string } }>(`/api/leads/duplicate-check?phone=${encodeURIComponent(phone)}`),
    enabled: phone.length >= 10,
  });

  const create = useMutation({
    mutationFn: () => api.post('/api/leads', {
      full_name: form.full_name,
      ...(form.phone ? { phone: form.phone } : {}),
      ...(form.place ? { place: form.place } : {}),
      ...(form.district ? { district: form.district } : {}),
      ...(form.category ? { category: form.category } : {}),
      ...(form.source ? { source: form.source } : {}),
      ...(form.referred_by_text ? { referred_by_text: form.referred_by_text } : {}),
      ...(form.interested_scheme ? { interested_scheme: form.interested_scheme } : {}),
      ...(form.expected_amount ? { expected_amount: Number(form.expected_amount) } : {}),
      ...(form.follow_up_date ? { follow_up_date: form.follow_up_date } : {}),
      ...(form.notes ? { notes: form.notes } : {}),
    }),
    onSuccess: () => { setForm(EMPTY_FORM); setCreating(false); qc.invalidateQueries({ queryKey: ['leads'] }); },
    onError: (e) => setErr(e instanceof ApiError ? e.message : 'Failed'),
  });

  const update = useMutation({
    mutationFn: (e: { id: number; status: string; follow_up_date: string; expected_amount: string }) =>
      api.put(`/api/leads/${e.id}`, {
        status: e.status,
        ...(e.follow_up_date ? { follow_up_date: e.follow_up_date } : {}),
        ...(e.expected_amount ? { expected_amount: Number(e.expected_amount) } : {}),
      }),
    onSuccess: () => { setEdit(null); qc.invalidateQueries({ queryKey: ['leads'] }); },
    onError: (e) => setErr(e instanceof ApiError ? e.message : 'Failed'),
  });

  const convert = useMutation({
    mutationFn: (c: { id: number; amount: string; seriesId: string }) =>
      api.post<{ customerId: number }>(`/api/leads/${c.id}/convert`, {
        confirmed_amount: Number(c.amount),
        confirmed_series_id: Number(c.seriesId),
      }),
    onSuccess: (r) => { setConverting(null); qc.invalidateQueries({ queryKey: ['leads'] }); nav(`/app/customers/${r.customerId}`); },
    onError: (e) => setErr(e instanceof ApiError ? e.message : 'Failed'),
  });

  return (
    <div className="w-full">
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-xl font-bold tracking-tight m-0">Leads</h1>
          <p className="text-sm text-text-muted mt-1">Prospective investors you're following up.</p>
        </div>
        {can('leads:create') && !creating && (
          <button onClick={() => { setErr(''); setCreating(true); }} className="text-xs bg-primary text-white rounded px-3 py-1.5 hover:bg-primary-hover">+ Create Lead</button>
        )}
      </div>

      {can('leads:create') && creating && (
        <div className="bg-surface border border-border rounded-lg shadow-card p-4 mb-5">
          <div className="text-xs font-semibold text-text-label uppercase tracking-wide mb-2.5">New lead</div>
          <div className="flex flex-wrap gap-2">
            <input className={inp} placeholder="Full name *" value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} autoFocus />
            <input className={`${inp} w-36`} placeholder="Phone" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
            <input className={`${inp} w-32`} placeholder="Place" value={form.place} onChange={(e) => setForm({ ...form, place: e.target.value })} />
            <input className={`${inp} w-32`} placeholder="District" value={form.district} onChange={(e) => setForm({ ...form, district: e.target.value })} />
            <input className={`${inp} w-32`} placeholder="Category" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} />
            <select className={inp} value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value })}>
              <option value="">Source…</option>
              {SOURCES.map((s) => <option key={s}>{s}</option>)}
            </select>
            <input className={inp} placeholder="Referred by" value={form.referred_by_text} onChange={(e) => setForm({ ...form, referred_by_text: e.target.value })} />
            <input className={inp} placeholder="Interested scheme" value={form.interested_scheme} onChange={(e) => setForm({ ...form, interested_scheme: e.target.value })} />
            <input className={`${inp} w-36`} type="number" placeholder="Expected ₹" value={form.expected_amount} onChange={(e) => setForm({ ...form, expected_amount: e.target.value })} />
            <input className={inp} type="date" title="Follow-up date" value={form.follow_up_date} onChange={(e) => setForm({ ...form, follow_up_date: e.target.value })} />
            <input className={`${inp} w-64`} placeholder="Notes" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
            <button disabled={!form.full_name || create.isPending} onClick={() => { setErr(''); create.mutate(); }}
              className="bg-primary hover:bg-primary-hover disabled:opacity-40 text-white rounded px-4 py-1.5 text-sm font-semibold">Save lead</button>
            <button onClick={() => { setErr(''); setCreating(false); }} className="text-xs text-text-muted hover:underline px-2">Cancel</button>
          </div>
          {dup.data?.duplicate && (
            <div className="text-xs text-warn mt-2">
              ⚠ This phone belongs to existing customer <button className="font-mono underline" onClick={() => nav(`/app/customers/${dup.data!.customer!.id}`)}>{dup.data.customer!.customer_code}</button> ({dup.data.customer!.full_name}) — consider a handover request instead of a new lead.
            </div>
          )}
        </div>
      )}
      {err && <div className="text-xs text-danger mb-3">{err}</div>}

      <input
        className="w-full max-w-md px-3 py-1.5 text-sm border border-border-strong rounded outline-none focus:border-primary mb-4"
        placeholder="Search leads by name, phone, place, district…"
        value={q} onChange={(e) => setQ(e.target.value)}
      />

      {isLoading ? <div className="text-text-muted">Loading…</div> : (() => {
        const columns: Column<Lead>[] = [
          { key: 'full_name', header: 'Name', tdClassName: 'font-medium' },
          { key: 'phone', header: 'Phone', tdClassName: 'text-text-muted', value: (l) => l.phone ?? '', render: (l) => l.phone ?? '—' },
          { key: 'district', header: 'District', value: (l) => l.district ?? '', render: (l) => l.district ?? '—' },
          { key: 'source', header: 'Source', value: (l) => l.source ?? '', render: (l) => l.source ?? '—' },
          { key: 'expected_amount', header: 'Expected', align: 'right', value: (l) => Number(l.expected_amount ?? 0),
            render: (l) => l.expected_amount ? <span className="mono">₹{Number(l.expected_amount).toLocaleString('en-IN')}</span> : '—' },
          { key: 'follow_up_date', header: 'Follow-up', value: (l) => l.follow_up_date ?? '',
            render: (l) => l.follow_up_date ? <span className="mono text-xs">{String(l.follow_up_date).slice(0, 10)}</span> : '—' },
          { key: 'status', header: 'Status',
            render: (l) => edit?.id === l.id ? (
              <select className={`${inp} text-xs`} value={edit.status} onChange={(e) => setEdit({ ...edit, status: e.target.value })}>
                {[...new Set([l.status, ...STATUSES])].map((s) => <option key={s}>{s}</option>)}
              </select>
            ) : <span className="text-xs rounded px-1.5 py-0.5 bg-bg">{l.status}</span> },
          { key: 'actions', header: '', sortable: false, filterable: false, align: 'right', tdClassName: 'whitespace-nowrap',
            render: (l) => {
              if (edit?.id === l.id) {
                return (
                  <span className="inline-flex items-center gap-1.5">
                    <input className={`${inp} text-xs`} type="date" title="Follow-up date" value={edit.follow_up_date} onChange={(e) => setEdit({ ...edit, follow_up_date: e.target.value })} />
                    <input className={`${inp} text-xs w-24`} type="number" placeholder="Expected ₹" value={edit.expected_amount} onChange={(e) => setEdit({ ...edit, expected_amount: e.target.value })} />
                    <button disabled={update.isPending} onClick={() => { setErr(''); update.mutate(edit); }}
                      className="text-xs bg-primary text-white rounded px-2.5 py-1.5 disabled:opacity-40 hover:bg-primary-hover">Save</button>
                    <button onClick={() => setEdit(null)} className="text-xs text-text-muted hover:underline">Cancel</button>
                  </span>
                );
              }
              if (converting?.id === l.id) {
                return (
                  <span className="inline-flex items-center gap-1.5">
                    <input className={`${inp} w-28`} type="number" placeholder="Amount ₹" autoFocus
                      value={converting.amount} onChange={(e) => setConverting({ ...converting, amount: e.target.value })} />
                    <select className={inp} value={converting.seriesId}
                      onChange={(e) => setConverting({ ...converting, seriesId: e.target.value })}>
                      <option value="">Series…</option>
                      {openSeries.map((s) => <option key={s.id} value={s.id}>{s.code}</option>)}
                    </select>
                    <button disabled={!converting.amount || Number(converting.amount) <= 0 || !converting.seriesId || convert.isPending}
                      onClick={() => { setErr(''); convert.mutate(converting); }}
                      className="text-xs bg-primary text-white rounded px-2.5 py-1.5 disabled:opacity-40 hover:bg-primary-hover">Confirm</button>
                    <button onClick={() => setConverting(null)} className="text-xs text-text-muted hover:underline">Cancel</button>
                  </span>
                );
              }
              return (
                <span className="inline-flex items-center gap-2.5">
                  <button onClick={() => setNotesFor(notesFor === l.id ? null : l.id)} className="text-xs text-primary hover:underline">Notes</button>
                  {can('leads:update') && l.status !== 'Converted' && (
                    <button onClick={() => { setErr(''); setConverting(null); setEdit({ id: l.id, status: l.status, follow_up_date: l.follow_up_date ? String(l.follow_up_date).slice(0, 10) : '', expected_amount: l.expected_amount ?? '' }); }}
                      className="text-xs text-primary hover:underline">Edit</button>
                  )}
                  {can('leads:convert') && l.status !== 'Converted' && (
                    <button onClick={() => { setErr(''); setEdit(null); setConverting({ id: l.id, amount: l.expected_amount ?? '', seriesId: '' }); }}
                      className="text-xs text-primary hover:underline">Convert →</button>
                  )}
                </span>
              );
            } },
        ];
        const ql = q.trim().toLowerCase();
        const matches = (vals: (string | null | undefined)[]) => !ql || vals.some((v) => String(v ?? '').toLowerCase().includes(ql));
        const leadRows = data!.rows.filter((l) => matches([l.full_name, l.phone, l.place, l.district, l.source, l.interested_scheme, l.category]));
        const prospectRows = (prospects.data?.rows ?? []).filter((p) => matches([p.full_name, p.phone, p.district, p.customer_code]));
        // One tab per lead status present (statuses are config-driven), + All,
        // + the dhanamfin app-prospects pool.
        const statuses = [...new Set(leadRows.map((l) => l.status))].sort();
        const leadTabs: TabDef<string>[] = [
          { key: 'all', label: 'All', count: leadRows.length },
          ...statuses.map((s) => ({ key: s, label: s, count: leadRows.filter((l) => l.status === s).length })),
          { key: PROSPECTS_TAB, label: 'App prospects', count: prospectRows.length },
        ];
        const activeTab = leadTabs.some((t) => t.key === tab) ? tab : 'all';

        if (activeTab === PROSPECTS_TAB) {
          const pcols: Column<Prospect>[] = [
            { key: 'customer_code', header: 'Code', tdClassName: 'font-mono text-xs' },
            { key: 'full_name', header: 'Name', tdClassName: 'font-medium' },
            { key: 'phone', header: 'Phone', tdClassName: 'text-text-muted', value: (p) => p.phone ?? '', render: (p) => p.phone ?? '—' },
            { key: 'district', header: 'District', value: (p) => p.district ?? '', render: (p) => p.district ?? '—' },
            { key: 'kyc_status', header: 'KYC', render: (p) => <span className="text-xs rounded px-1.5 py-0.5 bg-bg">{p.kyc_status ?? '—'}</span> },
            { key: 'created_at', header: 'Added', value: (p) => p.created_at, render: (p) => <span className="mono text-xs">{String(p.created_at).slice(0, 10)}</span> },
            { key: 'actions', header: '', sortable: false, filterable: false, align: 'right', tdClassName: 'whitespace-nowrap',
              render: (p) => <button onClick={() => nav(`/app/customers/${p.id}`)} className="text-xs text-primary hover:underline">Enrol →</button> },
          ];
          return (
            <>
              <Tabs tabs={leadTabs} active={activeTab} onChange={setTab} />
              <p className="text-xs text-text-muted mb-3">Dhanamfin app profiles with no NCD investment yet. Open one to enrol them — once they have an application they move to Customers.</p>
              <DataTable columns={pcols} rows={prospectRows} rowKey={(p) => p.id} defaultSort={{ key: 'created_at', dir: 'desc' }} empty="No app prospects." />
            </>
          );
        }

        const shown = activeTab === 'all' ? leadRows : leadRows.filter((l) => l.status === activeTab);
        return (
          <>
            <Tabs tabs={leadTabs} active={activeTab} onChange={setTab} />
            <DataTable
              columns={columns}
              rows={shown}
              rowKey={(l) => l.id}
              empty="No leads in this view."
              renderExpanded={(l) => (notesFor === l.id ? <NotesPanel leadId={l.id} canUpdate={can('leads:update')} /> : null)}
            />
          </>
        );
      })()}
    </div>
  );
}
