import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { validTransitions } from '@new-wealth/shared';
import { api, ApiError } from '../api/client.js';

const inp = 'px-2.5 py-1.5 text-sm border border-border-strong rounded outline-none focus:border-primary';
const btn = 'text-xs bg-primary text-white rounded px-3 py-1.5 disabled:opacity-40 hover:bg-primary-hover';
const th = 'px-3 py-2 text-left text-xs font-semibold text-text-label';
const td = 'px-3 py-1.5';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-surface border border-border rounded-lg shadow-card mb-6 overflow-hidden">
      <div className="px-4 py-3 border-b border-border text-xs font-semibold text-text-label uppercase tracking-wide">{title}</div>
      {children}
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
  return (
    <Section title="Schemes">
      <table className="w-full text-sm">
        <thead><tr className="border-b border-border"><th className={th}>Code</th><th className={th}>Name</th><th className={th}>Tenure</th><th className={th}>Rate %</th><th className={th}>Payout</th><th className={th}>Active</th></tr></thead>
        <tbody className="divide-y divide-border">
          {(data?.rows ?? []).map((s) => (
            <tr key={s.id}><td className={`${td} font-mono text-xs`}>{s.code}</td><td className={td}>{s.name}</td><td className={td}>{s.tenure_months}m</td><td className={td}>{s.coupon_rate_pct}</td><td className={td}>{s.payout_frequency}</td><td className={td}>{s.is_active ? '✓' : '—'}</td></tr>
          ))}
        </tbody>
      </table>
      <div className="p-3 border-t border-border flex flex-wrap gap-2 items-center">
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
      </div>
    </Section>
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

  // Default: series-number descending (NCD 27 → NCD 10), numeric-aware on the code.
  const seriesRows = [...(data?.rows ?? [])].sort((a, b) => String(b.code).localeCompare(String(a.code), undefined, { numeric: true }));

  return (
    <Section title="Series">
      <table className="w-full text-sm">
        <thead><tr className="border-b border-border"><th className={th}>Code</th><th className={th}>Name</th><th className={th}>Deemed date</th><th className={th}>ISIN</th><th className={th}>Status</th><th className={th}></th></tr></thead>
        <tbody className="divide-y divide-border">
          {seriesRows.map((s) => (
            <tr key={s.id}>
              <td className={`${td} font-mono text-xs`}>{s.code}</td><td className={td}>{s.name}</td>
              <td className={`${td} mono`}>{s.deemed_date ?? '—'}</td>
              <td className={`${td} font-mono text-xs`}>
                {isinFor && isinFor.id === s.id ? (
                  <span className="inline-flex gap-1.5">
                    <input className={`${inp} w-32`} value={isinFor.isin} autoFocus onChange={(e) => setIsinFor({ id: s.id, isin: e.target.value })} />
                    <button className={btn} disabled={!isinFor.isin || setIsin.isPending} onClick={() => { setErr(''); setIsin.mutate({ id: s.id, isin: isinFor.isin }); }}>Set</button>
                  </span>
                ) : (
                  <button className="text-primary hover:underline" onClick={() => setIsinFor({ id: s.id, isin: s.isin ?? '' })}>{s.isin ?? 'set ISIN'}</button>
                )}
              </td>
              <td className={td}><span className="text-xs rounded px-1.5 py-0.5 bg-bg">{s.status}</span></td>
              <td className={`${td} text-right`}>
                {validTransitions('series', s.status).map((to) => (
                  <button key={to} className="text-xs text-primary hover:underline ml-2"
                    onClick={() => { setErr(''); if (window.confirm(`Move series ${s.code} to ${to}?`)) setStatus.mutate({ id: s.id, to }); }}>→ {to}</button>
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="p-3 border-t border-border flex flex-wrap gap-2 items-center">
        <input className={inp} placeholder="Code" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} />
        <input className={inp} placeholder="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        <input className={inp} type="date" value={f.deemed_date} onChange={(e) => setF({ ...f, deemed_date: e.target.value })} />
        <select className={inp} multiple size={2} value={f.scheme_ids.map(String)}
          onChange={(e) => setF({ ...f, scheme_ids: Array.from(e.target.selectedOptions, (o) => Number(o.value)) })}>
          {(schemes.data?.rows ?? []).map((s) => <option key={s.id} value={s.id}>{s.code}</option>)}
        </select>
        <button className={btn} disabled={!f.code || !f.name || create.isPending} onClick={() => { setErr(''); create.mutate(); }}>+ Series (opens)</button>
        {err && <span className="text-xs text-danger">{err}</span>}
      </div>
    </Section>
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
  return (
    <Section title="TDS rules">
      <table className="w-full text-sm">
        <thead><tr className="border-b border-border"><th className={th}>Name</th><th className={th}>Kind</th><th className={th}>Rate %</th><th className={th}>Threshold</th></tr></thead>
        <tbody className="divide-y divide-border">
          {(data?.rows ?? []).map((r) => (
            <tr key={r.id}><td className={td}>{r.name}</td><td className={td}>{r.kind}</td><td className={td}>{r.rate_pct}</td><td className={`${td} mono`}>{r.threshold ?? '—'}</td></tr>
          ))}
        </tbody>
      </table>
      <div className="p-3 border-t border-border flex flex-wrap gap-2 items-center">
        <input className={inp} placeholder="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        <select className={inp} value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
          {['standard', '15G', '15H', 'custom', 'LDC'].map((k) => <option key={k}>{k}</option>)}
        </select>
        <input className={`${inp} w-24`} type="number" step="0.01" placeholder="Rate %" value={f.rate_pct} onChange={(e) => setF({ ...f, rate_pct: e.target.value })} />
        <input className={`${inp} w-32`} type="number" placeholder="Threshold ₹" value={f.threshold} onChange={(e) => setF({ ...f, threshold: e.target.value })} />
        <button className={btn} disabled={!f.name || !f.rate_pct || create.isPending} onClick={() => { setErr(''); create.mutate(); }}>+ TDS rule</button>
        {err && <span className="text-xs text-danger">{err}</span>}
      </div>
    </Section>
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
  return (
    <Section title="Company bank accounts">
      <table className="w-full text-sm">
        <thead><tr className="border-b border-border"><th className={th}>Label</th><th className={th}>Bank</th><th className={th}>Account</th><th className={th}>IFSC</th><th className={th}>Collection</th><th className={th}>Disbursement</th></tr></thead>
        <tbody className="divide-y divide-border">
          {(data?.rows ?? []).map((b) => (
            <tr key={b.id}><td className={td}>{b.account_label}</td><td className={td}>{b.bank_name}</td><td className={`${td} font-mono text-xs`}>{b.account_number ?? '—'}</td><td className={`${td} font-mono text-xs`}>{b.ifsc ?? '—'}</td><td className={td}>{b.is_collection_account ? '✓' : '—'}</td><td className={td}>{b.is_disbursement_account ? '✓' : '—'}</td></tr>
          ))}
        </tbody>
      </table>
      <div className="p-3 border-t border-border flex flex-wrap gap-2 items-center">
        <input className={inp} placeholder="Label" value={f.account_label} onChange={(e) => setF({ ...f, account_label: e.target.value })} />
        <input className={inp} placeholder="Bank name" value={f.bank_name} onChange={(e) => setF({ ...f, bank_name: e.target.value })} />
        <input className={inp} placeholder="Account no." value={f.account_number} onChange={(e) => setF({ ...f, account_number: e.target.value })} />
        <input className={`${inp} w-32`} placeholder="IFSC" value={f.ifsc} onChange={(e) => setF({ ...f, ifsc: e.target.value })} />
        <label className="text-xs flex items-center gap-1"><input type="checkbox" checked={f.is_collection_account} onChange={(e) => setF({ ...f, is_collection_account: e.target.checked })} />Collection</label>
        <label className="text-xs flex items-center gap-1"><input type="checkbox" checked={f.is_disbursement_account} onChange={(e) => setF({ ...f, is_disbursement_account: e.target.checked })} />Disbursement</label>
        <button className={btn} disabled={!f.account_label || !f.bank_name || create.isPending} onClick={() => { setErr(''); create.mutate(); }}>+ Bank</button>
        {err && <span className="text-xs text-danger">{err}</span>}
      </div>
    </Section>
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
