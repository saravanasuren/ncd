import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { validTransitions } from '@new-wealth/shared';
import { api, ApiError } from '../api/client.js';
import { DataTable, type Column } from '../components/DataTable.js';
import { useConfirm } from '../components/Confirm.js';

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
  const { confirm } = useConfirm();
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['series'], queryFn: () => api.get<{ rows: any[] }>('/api/series') });
  const schemes = useQuery({ queryKey: ['schemes'], queryFn: () => api.get<{ rows: any[] }>('/api/schemes') });
  const [f, setF] = useState({ code: '', name: '', deemed_date: '', scheme_ids: [] as number[] });
  const [isinFor, setIsinFor] = useState<{ id: number; isin: string } | null>(null);
  const [err, setErr] = useState('');
  const onErr = (e: unknown) => setErr(e instanceof ApiError ? e.message : 'Failed');
  const invalidate = () => qc.invalidateQueries({ queryKey: ['series'] });

  const [note, setNote] = useState('');
  const create = useMutation({
    mutationFn: () => api.post('/api/series', { code: f.code, name: f.name, deemed_date: f.deemed_date || null, scheme_ids: f.scheme_ids }),
    onSuccess: () => {
      setF({ code: '', name: '', deemed_date: '', scheme_ids: [] });
      setNote('Series created and sent for approval — it cannot take investments until a checker approves it.');
      invalidate();
    },
    onError: onErr,
  });
  // Edit → approval too (owner 2026-08-19). Only the fields that differ are
  // sent; the server refuses a no-op rather than queueing an empty request.
  const [editFor, setEditFor] = useState<{ id: number; code: string; name: string; deemed_date: string } | null>(null);
  const save = useMutation({
    mutationFn: (v: { id: number; code: string; name: string; deemed_date: string }) =>
      api.put(`/api/series/${v.id}`, { code: v.code, name: v.name, deemed_date: v.deemed_date || null }),
    onSuccess: () => { setEditFor(null); setNote('Change sent for approval — it takes effect once a checker approves it.'); invalidate(); },
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
    { key: 'code', header: 'Code', tdClassName: 'font-mono text-xs',
      render: (s) => (editFor && editFor.id === s.id
        ? <input className={`${inp} w-28`} value={editFor.code} onChange={(e) => setEditFor({ ...editFor, code: e.target.value })} />
        : s.code) },
    { key: 'name', header: 'Name',
      render: (s) => (editFor && editFor.id === s.id
        ? <input className={`${inp} w-40`} value={editFor.name} onChange={(e) => setEditFor({ ...editFor, name: e.target.value })} />
        : s.name) },
    { key: 'deemed_date', header: 'Deemed date', value: (s) => s.deemed_date ?? '',
      render: (s) => (editFor && editFor.id === s.id
        ? <input className={`${inp} w-36`} type="date" value={editFor.deemed_date} onChange={(e) => setEditFor({ ...editFor, deemed_date: e.target.value })} />
        : s.deemed_date ?? '—') },
    { key: 'isin', header: 'ISIN', tdClassName: 'font-mono text-xs', filterable: false, sortable: false,
      render: (s) => (isinFor && isinFor.id === s.id ? (
        <span className="inline-flex gap-1.5">
          <input className={`${inp} w-32`} value={isinFor.isin} autoFocus onChange={(e) => setIsinFor({ id: s.id, isin: e.target.value })} />
          <button className={btn} disabled={!isinFor.isin || setIsin.isPending} onClick={() => { setErr(''); setIsin.mutate({ id: s.id, isin: isinFor.isin }); }}>Set</button>
        </span>
      ) : (
        <button className="text-primary hover:underline" onClick={() => setIsinFor({ id: s.id, isin: s.isin ?? '' })}>{s.isin ?? 'set ISIN'}</button>
      )) },
    { key: 'status', header: 'Status',
      render: (s) => (
        <span className={`text-xs rounded px-1.5 py-0.5 ${s.status === 'PendingApproval' ? 'bg-[color:var(--warn-bg)] text-warn' : 'bg-bg'}`}
          title={s.status === 'PendingApproval' ? 'Waiting for a checker — this series cannot take investments yet' : undefined}>
          {s.status === 'PendingApproval' ? 'Awaiting approval' : s.status}
        </span>
      ) },
    { key: 'actions', header: '', align: 'right', sortable: false, filterable: false, tdClassName: 'whitespace-nowrap',
      render: (s) => (editFor && editFor.id === s.id ? (
        <>
          <button className="text-xs text-primary hover:underline ml-2" disabled={!editFor.code || !editFor.name || save.isPending}
            onClick={() => { setErr(''); save.mutate(editFor); }}>Send for approval</button>
          <button className="text-xs text-text-muted hover:underline ml-2" onClick={() => setEditFor(null)}>Cancel</button>
        </>
      ) : (
        <>
          {/* The edit option the owner asked for (2026-08-19) — it did not exist
              at all; a mistyped code or deemed date could only be fixed in the
              database. Goes through a checker like everything else here. */}
          <button className="text-xs text-primary hover:underline ml-2"
            onClick={() => { setErr(''); setEditFor({ id: s.id, code: s.code ?? '', name: s.name ?? '', deemed_date: String(s.deemed_date ?? '').slice(0, 10) }); }}>Edit</button>
          {validTransitions('series', s.status).map((to) => (
            <button key={to} className="text-xs text-primary hover:underline ml-2"
              onClick={async () => { setErr(''); if (await confirm({ title: `Move series ${s.code} to ${to}?`, confirmLabel: `Move to ${to}` })) setStatus.mutate({ id: s.id, to }); }}>→ {to}</button>
          ))}
        </>
      )) },
  ];
  return (
    <TableBlock title="Series" columns={columns} rows={data?.rows ?? []} rowKey={(s) => s.id} defaultSort={{ key: 'code', dir: 'desc' }} empty="No series yet."
      form={<>
        {note && <span className="text-xs text-warn">{note}</span>}
        <input className={inp} placeholder="Code" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} />
        <input className={inp} placeholder="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        <input className={inp} type="date" value={f.deemed_date} onChange={(e) => setF({ ...f, deemed_date: e.target.value })} />
        <select className={inp} multiple size={2} value={f.scheme_ids.map(String)}
          onChange={(e) => setF({ ...f, scheme_ids: Array.from(e.target.selectedOptions, (o) => Number(o.value)) })}>
          {(schemes.data?.rows ?? []).map((s) => <option key={s.id} value={s.id}>{s.code}</option>)}
        </select>
        <button className={btn} disabled={!f.code || !f.name || create.isPending}
          title="The series is created awaiting approval; it can take investments once a checker approves it"
          onClick={() => { setErr(''); setNote(''); create.mutate(); }}>+ Series (for approval)</button>
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
      <BondSignatures />
      <AckSignature />
    </Section>
  );
}

/** The 3 director signatures printed on every bond/debenture certificate
 * (forms/bond.ts DIRECTORS, same order). Certificates used to ship with blank
 * signature lines forever — the code drew an image if one existed on disk,
 * but no one had ever uploaded a file there. Now they live in the DB and are
 * uploaded right here instead of needing a deploy. */
const BOND_DIRECTORS = ['Avinash Gopalakrishnan', 'Gokul Govindarajan', 'Sankar Venkataraman'];

function BondSignatures() {
  const { confirm } = useConfirm();
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['company-profile'], queryFn: () => api.get<{ profile: any }>('/api/company-profile') });
  const [err, setErr] = useState('');
  const p = data?.profile ?? {};
  const invalidate = () => qc.invalidateQueries({ queryKey: ['company-profile'] });

  const upload = useMutation({
    mutationFn: (v: { index: number; filename: string; data_base64: string }) =>
      api.post(`/api/company-profile/bond-signature/${v.index}`, { filename: v.filename, data_base64: v.data_base64 }),
    onSuccess: () => { setErr(''); invalidate(); },
    onError: (e) => setErr(e instanceof ApiError ? e.message : 'Failed'),
  });
  const remove = useMutation({
    mutationFn: (index: number) => api.del(`/api/company-profile/bond-signature/${index}`),
    onSuccess: () => { setErr(''); invalidate(); },
    onError: (e) => setErr(e instanceof ApiError ? e.message : 'Failed'),
  });

  function pick(index: number) {
    const picker = document.createElement('input'); picker.type = 'file'; picker.accept = 'image/png,image/jpeg,image/webp';
    picker.onchange = () => {
      const file = picker.files?.[0]; if (!file) return;
      if (file.size > 2 * 1024 * 1024) { setErr('Signature image must be under 2 MB.'); return; }
      const reader = new FileReader();
      reader.onload = () => {
        const data_base64 = String(reader.result).split(',')[1] ?? '';
        upload.mutate({ index, filename: file.name, data_base64 });
      };
      reader.readAsDataURL(file);
    };
    picker.click();
  }

  return (
    <div className="px-4 pb-4 pt-1 border-t border-border">
      <div className="text-xs font-semibold text-text-label uppercase tracking-wide mb-2 mt-3">Bond certificate signatures</div>
      <p className="text-xs text-text-muted mb-3">Printed on every debenture certificate. Upload a scanned signature (PNG, JPEG or WebP, transparent background works best) for each director — leave blank and the certificate just prints a line with their name, as it does today.</p>
      <div className="grid grid-cols-3 gap-3">
        {BOND_DIRECTORS.map((name, i) => {
          const path = p[`bond_signature_${i + 1}_path`];
          return (
            <div key={i} className="border border-border rounded-lg p-3 text-center">
              <div className="h-14 flex items-center justify-center mb-2">
                {path
                  ? <img src={`/api/company-profile/bond-signature/${i}?v=${encodeURIComponent(path)}`} alt={`${name} signature`} className="max-h-14 max-w-full object-contain" />
                  : <span className="text-xs text-text-muted italic">No signature on file</span>}
              </div>
              <div className="text-xs font-medium truncate">{name}</div>
              <div className="text-[11px] text-text-muted mb-2">Director</div>
              <div className="flex gap-2 justify-center">
                <button className="text-xs text-primary hover:underline" disabled={upload.isPending} onClick={() => pick(i)}>
                  {path ? 'Replace' : '+ Upload'}
                </button>
                {path && (
                  <button className="text-xs text-danger hover:underline" disabled={remove.isPending}
                    onClick={async () => { if (await confirm({ title: `Remove ${name}'s signature?`, body: 'It stops appearing on newly generated certificates.', confirmLabel: 'Remove', danger: true })) remove.mutate(i); }}>
                    Remove
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {err && <div className="text-xs text-danger mt-2">{err}</div>}
    </div>
  );
}

/** The authorised-signatory (CEO) signature printed on the receipt
 * acknowledgment. Single slot — the ack has one signatory line. Same story as
 * the bond signatures: the PDF drew a hardcoded image that was never supplied,
 * so acknowledgments printed a blank line until one is uploaded here. */
function AckSignature() {
  const { confirm } = useConfirm();
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['company-profile'], queryFn: () => api.get<{ profile: any }>('/api/company-profile') });
  const [err, setErr] = useState('');
  const path = data?.profile?.ack_signature_path;
  const invalidate = () => qc.invalidateQueries({ queryKey: ['company-profile'] });

  const upload = useMutation({
    mutationFn: (v: { filename: string; data_base64: string }) => api.post('/api/company-profile/ack-signature', v),
    onSuccess: () => { setErr(''); invalidate(); },
    onError: (e) => setErr(e instanceof ApiError ? e.message : 'Failed'),
  });
  const remove = useMutation({
    mutationFn: () => api.del('/api/company-profile/ack-signature'),
    onSuccess: () => { setErr(''); invalidate(); },
    onError: (e) => setErr(e instanceof ApiError ? e.message : 'Failed'),
  });

  function pick() {
    const picker = document.createElement('input'); picker.type = 'file'; picker.accept = 'image/png,image/jpeg,image/webp';
    picker.onchange = () => {
      const file = picker.files?.[0]; if (!file) return;
      if (file.size > 2 * 1024 * 1024) { setErr('Signature image must be under 2 MB.'); return; }
      const reader = new FileReader();
      reader.onload = () => upload.mutate({ filename: file.name, data_base64: String(reader.result).split(',')[1] ?? '' });
      reader.readAsDataURL(file);
    };
    picker.click();
  }

  return (
    <div className="px-4 pb-4 pt-1 border-t border-border">
      <div className="text-xs font-semibold text-text-label uppercase tracking-wide mb-2 mt-3">Acknowledgment signature</div>
      <p className="text-xs text-text-muted mb-3">Printed above the signatory line on every receipt acknowledgment. Upload a scanned signature (PNG, JPEG or WebP, transparent background works best) — leave blank and the acknowledgment just prints the signatory line, as it does today.</p>
      <div className="border border-border rounded-lg p-3 text-center max-w-[220px]">
        <div className="h-14 flex items-center justify-center mb-2">
          {path
            ? <img src={`/api/company-profile/ack-signature?v=${encodeURIComponent(path)}`} alt="Acknowledgment signature" className="max-h-14 max-w-full object-contain" />
            : <span className="text-xs text-text-muted italic">No signature on file</span>}
        </div>
        <div className="flex gap-2 justify-center">
          <button className="text-xs text-primary hover:underline" disabled={upload.isPending} onClick={pick}>{path ? 'Replace' : '+ Upload'}</button>
          {path && (
            <button className="text-xs text-danger hover:underline" disabled={remove.isPending}
              onClick={async () => { if (await confirm({ title: 'Remove the acknowledgment signature?', body: 'It stops appearing on newly generated acknowledgments.', confirmLabel: 'Remove', danger: true })) remove.mutate(); }}>
              Remove
            </button>
          )}
        </div>
      </div>
      {err && <div className="text-xs text-danger mt-2">{err}</div>}
    </div>
  );
}

/** Admin → Masters (docs/05): schemes, series, TDS rules, banks, holidays, company profile. */
/** NCD-owned locker deposit + rent per size (owner 2026-08-07). Editable in
 *  place; rent is blank until set. Sent to LockerHub on new locker applications. */
function LockerPricing() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['locker-pricing'], queryFn: () => api.get<{ rows: any[] }>('/api/locker-pricing') });
  const [form, setForm] = useState<Record<string, { deposit: string; rent: string }>>({});
  const [newRow, setNewRow] = useState({ size: '', deposit: '', rent: '' });
  const [err, setErr] = useState('');
  const rows = data?.rows ?? [];
  const val = (size: string, k: 'deposit' | 'rent', fallback: number | null) =>
    form[size]?.[k] ?? (fallback == null ? '' : String(fallback));
  const set = (size: string, k: 'deposit' | 'rent', v: string, r: any) =>
    setForm((s) => ({ ...s, [size]: { deposit: k === 'deposit' ? v : (s[size]?.deposit ?? (r.deposit_amount ?? '')), rent: k === 'rent' ? v : (s[size]?.rent ?? (r.annual_rent ?? '')) } }));
  const save = useMutation({
    mutationFn: (v: { size: string; deposit_amount: string | number | null; annual_rent: string | number | null }) =>
      api.put(`/api/locker-pricing/${encodeURIComponent(v.size)}`, { deposit_amount: v.deposit_amount === '' ? null : v.deposit_amount, annual_rent: v.annual_rent === '' ? null : v.annual_rent }),
    onSuccess: () => { setErr(''); setNewRow({ size: '', deposit: '', rent: '' }); qc.invalidateQueries({ queryKey: ['locker-pricing'] }); },
    onError: (e) => setErr(e instanceof ApiError ? e.message : 'Failed'),
  });
  const card = 'bg-surface border border-border rounded-lg shadow-card p-5 mb-4';
  const th = 'text-left text-xs font-semibold text-text-label uppercase tracking-wide px-3 py-2';
  const td = 'px-3 py-2';
  return (
    <div className={card}>
      <h2 className="text-sm font-semibold mb-1">Locker pricing (per size)</h2>
      <p className="text-xs text-text-muted mb-3">Deposit and yearly rent for each locker size. Sent to LockerHub on new applications. Rent is optional — leave blank to set later.</p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr className="border-b border-border"><th className={th}>Size</th><th className={th}>Deposit (₹)</th><th className={th}>Annual rent (₹)</th><th className={th}></th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.size} className="border-b border-border last:border-0">
                <td className={`${td} font-semibold`}>{r.size}</td>
                <td className={td}><input className={`${inp} w-32`} inputMode="numeric" value={val(r.size, 'deposit', r.deposit_amount)} onChange={(e) => set(r.size, 'deposit', e.target.value.replace(/[^\d.]/g, ''), r)} /></td>
                <td className={td}><input className={`${inp} w-32`} inputMode="numeric" placeholder="—" value={val(r.size, 'rent', r.annual_rent)} onChange={(e) => set(r.size, 'rent', e.target.value.replace(/[^\d.]/g, ''), r)} /></td>
                <td className={td}><button className={btn} disabled={save.isPending} onClick={() => { setErr(''); save.mutate({ size: r.size, deposit_amount: val(r.size, 'deposit', r.deposit_amount), annual_rent: val(r.size, 'rent', r.annual_rent) }); }}>Save</button></td>
              </tr>
            ))}
            <tr>
              <td className={td}><input className={`${inp} w-24`} placeholder="Size" value={newRow.size} onChange={(e) => setNewRow({ ...newRow, size: e.target.value })} /></td>
              <td className={td}><input className={`${inp} w-32`} inputMode="numeric" placeholder="Deposit" value={newRow.deposit} onChange={(e) => setNewRow({ ...newRow, deposit: e.target.value.replace(/[^\d.]/g, '') })} /></td>
              <td className={td}><input className={`${inp} w-32`} inputMode="numeric" placeholder="Rent (optional)" value={newRow.rent} onChange={(e) => setNewRow({ ...newRow, rent: e.target.value.replace(/[^\d.]/g, '') })} /></td>
              <td className={td}><button className={btn} disabled={!newRow.size || save.isPending} onClick={() => { setErr(''); save.mutate({ size: newRow.size.trim(), deposit_amount: newRow.deposit, annual_rent: newRow.rent }); }}>+ Add size</button></td>
            </tr>
          </tbody>
        </table>
      </div>
      {err && <div className="text-xs text-danger mt-2">{err}</div>}
    </div>
  );
}

export function MastersPage() {
  return (
    <div className="w-full">
      <h1 className="text-xl font-bold tracking-tight m-0">Masters</h1>
      <p className="text-sm text-text-muted mt-1 mb-5">Product and company reference data. Every change is audited.</p>
      <Schemes />
      <SeriesSection />
      <TdsRules />
      <Banks />
      <LockerPricing />
      <Holidays />
      <CompanyProfile />
    </div>
  );
}
