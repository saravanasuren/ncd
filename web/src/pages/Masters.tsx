import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { validTransitions } from '@new-wealth/shared';
import { api, ApiError } from '../api/client.js';
import { DataTable, type Column } from '../components/DataTable.js';

const inp = 'px-2.5 py-1.5 text-sm border border-border-strong rounded outline-none focus:border-primary';
const btn = 'text-xs bg-primary text-white rounded px-3 py-1.5 disabled:opacity-40 hover:bg-primary-hover';

/** Section = heading + a sortable/filterable DataTable + a create-form footer card. */
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-surface border border-border rounded-lg shadow-card mb-6 overflow-hidden">
      <div className="px-4 py-3 border-b border-border text-xs font-semibold text-text-label uppercase tracking-wide">{title}</div>
      {children}
    </div>
  );
}

/** A masters block: a heading, a DataTable, then the create form below it. */
function TableBlock<T>({ title, columns, rows, rowKey, defaultSort, empty, form }: {
  title: string; columns: Column<T>[]; rows: T[]; rowKey: (r: T) => string | number;
  defaultSort?: { key: string; dir: 'asc' | 'desc' }; empty: string; form: React.ReactNode;
}) {
  return (
    <div className="mb-6">
      <h2 className="text-xs font-semibold text-text-label uppercase tracking-wide mb-2">{title}</h2>
      <DataTable columns={columns} rows={rows} rowKey={rowKey} defaultSort={defaultSort} empty={empty} />
      <div className="bg-surface border border-t-0 border-border rounded-b-lg shadow-card p-3 -mt-px flex flex-wrap gap-2 items-center">
        {form}
      </div>
    </div>
  );
}

function Schemes() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['schemes'], queryFn: () => api.get<{ rows: any[] }>('/api/schemes') });
  const tds = useQuery({ queryKey: ['tds-rules'], queryFn: () => api.get<{ rows: any[] }>('/api/tds-rules') });
  const [f, setF] = useState({ code: '', name: '', tenure_months: '', coupon_rate_pct: '', payout_frequency: 'Monthly', tds_rule_id: '' });
  const [err, setErr] = useState('');
  const create = useMutation({
    mutationFn: () => api.post('/api/schemes', {
      code: f.code, name: f.name, tenure_months: Number(f.tenure_months), coupon_rate_pct: Number(f.coupon_rate_pct),
      payout_frequency: f.payout_frequency, tds_rule_id: f.tds_rule_id ? Number(f.tds_rule_id) : null,
    }),
    onSuccess: () => { setF({ code: '', name: '', tenure_months: '', coupon_rate_pct: '', payout_frequency: 'Monthly', tds_rule_id: '' }); qc.invalidateQueries({ queryKey: ['schemes'] }); },
    onError: (e) => setErr(e instanceof ApiError ? e.message : 'Failed'),
  });
  const columns: Column<any>[] = [
    { key: 'code', header: 'Code', tdClassName: 'font-mono text-xs' },
    { key: 'name', header: 'Name' },
    { key: 'tenure_months', header: 'Tenure', align: 'right', value: (s) => Number(s.tenure_months), render: (s) => `${s.tenure_months}m` },
    { key: 'coupon_rate_pct', header: 'Rate %', align: 'right', value: (s) => Number(s.coupon_rate_pct) },
    { key: 'payout_frequency', header: 'Payout' },
    { key: 'is_active', header: 'Active', value: (s) => (s.is_active ? 'Yes' : 'No'), render: (s) => (s.is_active ? '✓' : '—') },
  ];
  return (
    <TableBlock title="Schemes" columns={columns} rows={data?.rows ?? []} rowKey={(s) => s.id} defaultSort={{ key: 'code', dir: 'asc' }} empty="No schemes yet."
      form={<>
        <input className={inp} placeholder="Code" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} />
        <input className={inp} placeholder="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        <input className={`${inp} w-24`} type="number" placeholder="Tenure (m)" value={f.tenure_months} onChange={(e) => setF({ ...f, tenure_months: e.target.value })} />
        <input className={`${inp} w-24`} type="number" step="0.01" placeholder="Rate %" value={f.coupon_rate_pct} onChange={(e) => setF({ ...f, coupon_rate_pct: e.target.value })} />
        <select className={inp} value={f.payout_frequency} onChange={(e) => setF({ ...f, payout_frequency: e.target.value })}>
          {['Monthly', 'Quarterly', 'AtMaturity'].map((o) => <option key={o}>{o}</option>)}
        </select>
        <select className={inp} value={f.tds_rule_id} onChange={(e) => setF({ ...f, tds_rule_id: e.target.value })}>
          <option value="">TDS rule…</option>
          {(tds.data?.rows ?? []).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
        <button className={btn} disabled={!f.code || !f.name || !f.tenure_months || !f.coupon_rate_pct || create.isPending}
          onClick={() => { setErr(''); create.mutate(); }}>+ Scheme</button>
        {err && <span className="text-xs text-danger">{err}</span>}
      </>} />
  );
}

function SeriesSection() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['series'], queryFn: () => api.get<{ rows: any[] }>('/api/series') });
  const schemes = useQuery({ queryKey: ['schemes'], queryFn: () => api.get<{ rows: any[] }>('/api/schemes') });
  const [f, setF] = useState({ code: '', name: '', deemed_date: '', scheme_ids: [] as number[] });
  const [isinFor, setIsinFor] = useState<{ id: number; isin: string } | null>(null);
  const [err, setErr] = useState('');
  const onErr = (e: unknown) => setErr(e instanceof ApiError ? e.message : 'Failed');
  const invalidate = () => qc.invalidateQueries({ queryKey: ['series'] });

  const create = useMutation({
    mutationFn: () => api.post('/api/series', { code: f.code, name: f.name, deemed_date: f.deemed_date || null, scheme_ids: f.scheme_ids }),
    onSuccess: () => { setF({ code: '', name: '', deemed_date: '', scheme_ids: [] }); invalidate(); },
    onError: onErr,
  });
  const setStatus = useMutation({
    mutationFn: (v: { id: number; to: string }) => api.post(`/api/series/${v.id}/status`, { to: v.to }),
    onSuccess: invalidate, onError: onErr,
  });
  const setIsin = useMutation({
    mutationFn: (v: { id: number; isin: string }) => api.post(`/api/series/${v.id}/isin`, { isin: v.isin }),
    onSuccess: () => { setIsinFor(null); invalidate(); }, onError: onErr,
  });

  const columns: Column<any>[] = [
    { key: 'code', header: 'Code', tdClassName: 'font-mono text-xs' },
    { key: 'name', header: 'Name' },
    { key: 'deemed_date', header: 'Deemed date', value: (s) => s.deemed_date ?? '', render: (s) => s.deemed_date ?? '—' },
    { key: 'isin', header: 'ISIN', tdClassName: 'font-mono text-xs', filterable: false, sortable: false,
      render: (s) => (isinFor && isinFor.id === s.id ? (
        <span className="inline-flex gap-1.5">
          <input className={`${inp} w-32`} value={isinFor.isin} autoFocus onChange={(e) => setIsinFor({ id: s.id, isin: e.target.value })} />
          <button className={btn} disabled={!isinFor.isin || setIsin.isPending} onClick={() => { setErr(''); setIsin.mutate({ id: s.id, isin: isinFor.isin }); }}>Set</button>
        </span>
      ) : (
        <button className="text-primary hover:underline" onClick={() => setIsinFor({ id: s.id, isin: s.isin ?? '' })}>{s.isin ?? 'set ISIN'}</button>
      )) },
    { key: 'status', header: 'Status', render: (s) => <span className="text-xs rounded px-1.5 py-0.5 bg-bg">{s.status}</span> },
    { key: 'actions', header: '', align: 'right', sortable: false, filterable: false, tdClassName: 'whitespace-nowrap',
      render: (s) => validTransitions('series', s.status).map((to) => (
        <button key={to} className="text-xs text-primary hover:underline ml-2"
          onClick={() => { setErr(''); if (window.confirm(`Move series ${s.code} to ${to}?`)) setStatus.mutate({ id: s.id, to }); }}>→ {to}</button>
      )) },
  ];
  return (
    <TableBlock title="Series" columns={columns} rows={data?.rows ?? []} rowKey={(s) => s.id} defaultSort={{ key: 'code', dir: 'desc' }} empty="No series yet."
      form={<>
        <input className={inp} placeholder="Code" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} />
        <input className={inp} placeholder="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        <input className={inp} type="date" value={f.deemed_date} onChange={(e) => setF({ ...f, deemed_date: e.target.value })} />
        <select className={inp} multiple size={2} value={f.scheme_ids.map(String)}
          onChange={(e) => setF({ ...f, scheme_ids: Array.from(e.target.selectedOptions, (o) => Number(o.value)) })}>
          {(schemes.data?.rows ?? []).map((s) => <option key={s.id} value={s.id}>{s.code}</option>)}
        </select>
        <button className={btn} disabled={!f.code || !f.name || create.isPending} onClick={() => { setErr(''); create.mutate(); }}>+ Series (opens)</button>
        {err && <span className="text-xs text-danger">{err}</span>}
      </>} />
  );
}

function TdsRules() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['tds-rules'], queryFn: () => api.get<{ rows: any[] }>('/api/tds-rules') });
  const [f, setF] = useState({ name: '', kind: 'standard', rate_pct: '', threshold: '' });
  const [err, setErr] = useState('');
  const create = useMutation({
    mutationFn: () => api.post('/api/tds-rules', { name: f.name, kind: f.kind, rate_pct: Number(f.rate_pct), threshold: f.threshold ? Number(f.threshold) : null }),
    onSuccess: () => { setF({ name: '', kind: 'standard', rate_pct: '', threshold: '' }); qc.invalidateQueries({ queryKey: ['tds-rules'] }); },
    onError: (e) => setErr(e instanceof ApiError ? e.message : 'Failed'),
  });
  const columns: Column<any>[] = [
    { key: 'name', header: 'Name' },
    { key: 'kind', header: 'Kind' },
    { key: 'rate_pct', header: 'Rate %', align: 'right', value: (r) => Number(r.rate_pct) },
    { key: 'threshold', header: 'Threshold', align: 'right', value: (r) => (r.threshold != null ? Number(r.threshold) : ''), render: (r) => r.threshold ?? '—' },
  ];
  return (
    <TableBlock title="TDS rules" columns={columns} rows={data?.rows ?? []} rowKey={(r) => r.id} defaultSort={{ key: 'name', dir: 'asc' }} empty="No TDS rules yet."
      form={<>
        <input className={inp} placeholder="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        <select className={inp} value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
          {['standard', '15G', '15H', 'custom', 'LDC'].map((k) => <option key={k}>{k}</option>)}
        </select>
        <input className={`${inp} w-24`} type="number" step="0.01" placeholder="Rate %" value={f.rate_pct} onChange={(e) => setF({ ...f, rate_pct: e.target.value })} />
        <input className={`${inp} w-32`} type="number" placeholder="Threshold ₹" value={f.threshold} onChange={(e) => setF({ ...f, threshold: e.target.value })} />
        <button className={btn} disabled={!f.name || !f.rate_pct || create.isPending} onClick={() => { setErr(''); create.mutate(); }}>+ TDS rule</button>
        {err && <span className="text-xs text-danger">{err}</span>}
      </>} />
  );
}

function Banks() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['banks'], queryFn: () => api.get<{ rows: any[] }>('/api/banks') });
  const [f, setF] = useState({ account_label: '', bank_name: '', account_number: '', ifsc: '', is_collection_account: false, is_disbursement_account: false });
  const [err, setErr] = useState('');
  const create = useMutation({
    mutationFn: () => api.post('/api/banks', f),
    onSuccess: () => { setF({ account_label: '', bank_name: '', account_number: '', ifsc: '', is_collection_account: false, is_disbursement_account: false }); qc.invalidateQueries({ queryKey: ['banks'] }); },
    onError: (e) => setErr(e instanceof ApiError ? e.message : 'Failed'),
  });
  const columns: Column<any>[] = [
    { key: 'account_label', header: 'Label' },
    { key: 'bank_name', header: 'Bank' },
    { key: 'account_number', header: 'Account', tdClassName: 'font-mono text-xs', value: (b) => b.account_number ?? '', render: (b) => b.account_number ?? '—' },
    { key: 'ifsc', header: 'IFSC', tdClassName: 'font-mono text-xs', value: (b) => b.ifsc ?? '', render: (b) => b.ifsc ?? '—' },
    { key: 'is_collection_account', header: 'Collection', value: (b) => (b.is_collection_account ? 'Yes' : 'No'), render: (b) => (b.is_collection_account ? '✓' : '—') },
    { key: 'is_disbursement_account', header: 'Disbursement', value: (b) => (b.is_disbursement_account ? 'Yes' : 'No'), render: (b) => (b.is_disbursement_account ? '✓' : '—') },
  ];
  return (
    <TableBlock title="Company bank accounts" columns={columns} rows={data?.rows ?? []} rowKey={(b) => b.id} defaultSort={{ key: 'account_label', dir: 'asc' }} empty="No bank accounts yet."
      form={<>
        <input className={inp} placeholder="Label" value={f.account_label} onChange={(e) => setF({ ...f, account_label: e.target.value })} />
        <input className={inp} placeholder="Bank name" value={f.bank_name} onChange={(e) => setF({ ...f, bank_name: e.target.value })} />
        <input className={inp} placeholder="Account no." value={f.account_number} onChange={(e) => setF({ ...f, account_number: e.target.value })} />
        <input className={`${inp} w-32`} placeholder="IFSC" value={f.ifsc} onChange={(e) => setF({ ...f, ifsc: e.target.value })} />
        <label className="text-xs flex items-center gap-1"><input type="checkbox" checked={f.is_collection_account} onChange={(e) => setF({ ...f, is_collection_account: e.target.checked })} />Collection</label>
        <label className="text-xs flex items-center gap-1"><input type="checkbox" checked={f.is_disbursement_account} onChange={(e) => setF({ ...f, is_disbursement_account: e.target.checked })} />Disbursement</label>
        <button className={btn} disabled={!f.account_label || !f.bank_name || create.isPending} onClick={() => { setErr(''); create.mutate(); }}>+ Bank</button>
        {err && <span className="text-xs text-danger">{err}</span>}
      </>} />
  );
}

function Holidays() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['holidays'], queryFn: () => api.get<{ rows: any[] }>('/api/holidays') });
  const [f, setF] = useState({ d: '', label: '' });
  const [err, setErr] = useState('');
  const create = useMutation({
    mutationFn: () => api.post('/api/holidays', f),
    onSuccess: () => { setF({ d: '', label: '' }); qc.invalidateQueries({ queryKey: ['holidays'] }); },
    onError: (e) => setErr(e instanceof ApiError ? e.message : 'Failed'),
  });
  return (
    <Section title="Holidays (payout-date shifting)">
      <div className="p-3 flex flex-wrap gap-1.5">
        {(data?.rows ?? []).map((h) => (
          <span key={h.d} className="text-xs rounded px-2 py-1 bg-bg font-mono">{h.d}{h.label ? ` · ${h.label}` : ''}</span>
        ))}
        {(data?.rows ?? []).length === 0 && <span className="text-sm text-text-muted">No holidays configured.</span>}
      </div>
      <div className="p-3 border-t border-border flex flex-wrap gap-2 items-center">
        <input className={inp} type="date" value={f.d} onChange={(e) => setF({ ...f, d: e.target.value })} />
        <input className={inp} placeholder="Label" value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} />
        <button className={btn} disabled={!f.d || create.isPending} onClick={() => { setErr(''); create.mutate(); }}>+ Holiday</button>
        {err && <span className="text-xs text-danger">{err}</span>}
      </div>
    </Section>
  );
}

function CompanyProfile() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['company-profile'], queryFn: () => api.get<{ profile: any }>('/api/company-profile') });
  const [f, setF] = useState<Record<string, string> | null>(null);
  const [err, setErr] = useState('');
  const save = useMutation({
    mutationFn: () => api.put('/api/company-profile', { ...f, tan_amendment_pending: f!.tan_amendment_pending === 'true' }),
    onSuccess: () => { setF(null); qc.invalidateQueries({ queryKey: ['company-profile'] }); },
    onError: (e) => setErr(e instanceof ApiError ? e.message : 'Failed'),
  });
  const p = data?.profile ?? {};
  const FIELDS: [string, string][] = [
    ['legal_name', 'Legal name'], ['former_legal_name', 'Former legal name'], ['short_name', 'Short name'],
    ['tan', 'TAN'], ['tan_holder_name', 'TAN holder name'], ['signatory_name', 'Signatory'], ['signatory_designation', 'Signatory designation'],
  ];
  return (
    <Section title="Company profile">
      <div className="p-4 grid grid-cols-2 gap-3 w-full">
        {FIELDS.map(([k, label]) => (
          <label key={k} className="text-xs text-text-label">
            {label}
            <input className={`${inp} w-full mt-1`} value={f ? (f[k] ?? '') : (p[k] ?? '')} disabled={!f}
              onChange={(e) => setF({ ...f!, [k]: e.target.value })} />
          </label>
        ))}
        <label className="text-xs flex items-end gap-1.5 pb-2">
          <input type="checkbox" disabled={!f}
            checked={f ? f.tan_amendment_pending === 'true' : !!p.tan_amendment_pending}
            onChange={(e) => setF({ ...f!, tan_amendment_pending: String(e.target.checked) })} />
          TAN amendment pending
        </label>
      </div>
      <div className="px-4 pb-4 flex gap-2 items-center">
        {f ? (
          <>
            <button className={btn} disabled={save.isPending} onClick={() => { setErr(''); save.mutate(); }}>Save</button>
            <button className="text-xs text-text-muted hover:underline" onClick={() => setF(null)}>Cancel</button>
          </>
        ) : (
          <button className="text-xs border border-border rounded px-3 py-1.5 hover:bg-bg"
            onClick={() => setF(Object.fromEntries([...FIELDS.map(([k]) => [k, p[k] ?? '']), ['tan_amendment_pending', String(!!p.tan_amendment_pending)]]))}>Edit</button>
        )}
        {err && <span className="text-xs text-danger">{err}</span>}
      </div>
    </Section>
  );
}

/** Admin → Masters (docs/05): schemes, series, TDS rules, banks, holidays, company profile. */
export function MastersPage() {
  return (
    <div className="w-full">
      <h1 className="text-xl font-bold tracking-tight m-0">Masters</h1>
      <p className="text-sm text-text-muted mt-1 mb-5">Product and company reference data. Every change is audited.</p>
      <Schemes />
      <SeriesSection />
      <TdsRules />
      <Banks />
      <Holidays />
      <CompanyProfile />
    </div>
  );
}
