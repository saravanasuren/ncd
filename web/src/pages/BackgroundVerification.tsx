import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api/client.js';
import { useAuth } from '../auth/AuthContext.js';

/**
 * Background Verification — "which customers are not ready, and what exactly is
 * missing?". Every tick is three-state (green = valid, orange = present but
 * half-done, red = missing/invalid) and clickable: fix the field or upload the
 * document without leaving the page. Status is computed server-side.
 */
const KYC_DOCS = ['PAN', 'Aadhaar', 'Photo', 'Signature', 'AddressProof'] as const;
const EXTRA_DOCS = ['BankProof', 'CML'] as const;
const DOC_SHORT: Record<string, string> = { PAN: 'PAN', Aadhaar: 'AAD', Photo: 'PHO', Signature: 'SIG', AddressProof: 'ADR', BankProof: 'BNK', CML: 'CML' };

interface Check { key: string; label: string; present: boolean; valid: boolean; partial?: boolean; optional?: boolean; value?: string | null }
interface Doc { id: number; original_filename?: string; uploaded_at?: string; origin?: string }
interface Row {
  id: number; customer_code: string; full_name: string; kyc_status: string;
  docs: Record<string, Doc | undefined>;
  data_checks: Check[];
  nominee: { id: number; full_name: string; relationship: string | null; dob: string | null } | null;
  investments: number; investments_missing_interest_start: number;
}

const TONE = {
  green: 'bg-[color:var(--success-bg,#dcfce7)] text-[color:var(--success,#15803d)] border-[color:var(--success,#15803d)]/30',
  orange: 'bg-[color:var(--warn-bg,#ffedd5)] text-[color:var(--warn,#c2410c)] border-[color:var(--warn,#c2410c)]/30',
  red: 'bg-[color:var(--danger-bg,#fee2e2)] text-danger border-danger/30',
};
const toneOf = (c: { valid: boolean; present: boolean; partial?: boolean }) => (c.valid ? 'green' : c.partial || c.present ? 'orange' : 'red');

function Tick({ label, tone, title, onClick }: { label: string; tone: keyof typeof TONE; title: string; onClick?: () => void }) {
  return (
    <button type="button" onClick={onClick} title={title}
      className={`text-[10px] leading-none font-semibold rounded border px-1.5 py-1 mr-1 mb-1 ${TONE[tone]} ${onClick ? 'hover:opacity-80 cursor-pointer' : 'cursor-default'}`}>
      {label}
    </button>
  );
}

const readBase64 = (file: File) => new Promise<string>((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
  r.onerror = reject;
  r.readAsDataURL(file);
});

export function BackgroundVerificationPage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [kyc, setKyc] = useState('');
  const [msg, setMsg] = useState('');
  const [edit, setEdit] = useState<{ cid: number; key: string; label: string; value: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const params = new URLSearchParams();
  if (q.trim().length >= 2) params.set('q', q.trim());
  if (kyc) params.set('kyc_status', kyc);
  const key = ['bgv', params.toString()];
  const { data, isLoading, error } = useQuery({
    queryKey: key,
    queryFn: () => api.get<{ rows: Row[]; counters: Record<string, number> }>(`/api/background-verification?${params.toString()}`),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['bgv'] });
  const fail = (e: unknown) => setMsg(e instanceof ApiError ? e.message : 'Failed');

  async function saveField() {
    if (!edit) return;
    setBusy(true); setMsg('');
    try {
      await api.patch(`/api/background-verification/${edit.cid}/fix-field`, { field: edit.key, value: edit.value });
      setEdit(null); refresh();
    } catch (e) { fail(e); } finally { setBusy(false); }
  }

  async function uploadDoc(cid: number, docType: string, file: File) {
    setMsg('');
    if (file.size > 5 * 1024 * 1024) { setMsg('File must be under 5 MB.'); return; }
    if (!['application/pdf', 'image/jpeg', 'image/png'].includes(file.type)) { setMsg('Only PDF, JPEG or PNG are accepted.'); return; }
    try {
      const data_base64 = await readBase64(file);
      await api.post(`/api/customers/${cid}/documents`, { doc_type: docType, filename: file.name, mime: file.type, data_base64 });
      refresh();
    } catch (e) { fail(e); }
  }

  async function verify(cid: number) {
    setMsg('');
    try { await api.post(`/api/background-verification/${cid}/mark-verified`); refresh(); } catch (e) { fail(e); }
  }

  if (isLoading) return <div className="text-text-muted">Loading…</div>;
  if (error) return <div className="text-danger">Could not load background verification.</div>;
  const rows = data?.rows ?? [];
  const c = data?.counters ?? {};

  return (
    <div className="w-full">
      <h1 className="text-xl font-bold tracking-tight m-0">Background verification</h1>
      <p className="text-sm text-text-muted mt-1 mb-4">Which customers are not ready, and exactly what is missing. Every red or orange tick is clickable — fix it here, no need to open the profile.</p>

      <div className="flex flex-wrap items-center gap-2 mb-3">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, code or PAN…"
          className="px-2.5 py-1.5 text-sm border border-border-strong rounded outline-none focus:border-primary min-w-[220px]" />
        <select value={kyc} onChange={(e) => setKyc(e.target.value)} className="px-2.5 py-1.5 text-sm border border-border-strong rounded">
          <option value="">All KYC statuses</option>
          <option value="Pending">Pending</option>
          <option value="Verified">Verified</option>
          <option value="Rejected">Rejected</option>
        </select>
      </div>

      <div className="flex flex-wrap gap-2 mb-3 text-xs">
        {[['Customers', c.customers], ['KYC verified', c.kyc_verified], ['KYC pending', c.kyc_pending], ['Data complete', c.data_complete], ['Needs attention', c.needs_attention]].map(([label, v]) => (
          <span key={String(label)} className="bg-surface border border-border rounded px-3 py-1.5">
            <span className="text-text-muted">{label}: </span><span className="font-semibold">{Number(v ?? 0)}</span>
          </span>
        ))}
      </div>
      {msg && <div className="text-xs text-danger mb-2">{msg}</div>}

      {/* Wide table: scrolls inside its own container so the page never scrolls sideways. */}
      <div className="overflow-x-auto bg-surface border border-border rounded-lg shadow-card">
        <table className="w-full text-sm border-collapse min-w-[1100px]">
          <thead>
            <tr className="text-left text-xs text-text-label uppercase tracking-wide border-b border-border">
              <th className="px-3 py-2">Customer</th>
              <th className="px-3 py-2">Documents</th>
              <th className="px-3 py-2">Required data</th>
              <th className="px-3 py-2">KYC</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-border align-top">
                <td className="px-3 py-2 whitespace-nowrap">
                  <a href={`/app/customers/${r.id}`} className="font-medium text-primary hover:underline">{r.full_name}</a>
                  <div className="text-xs text-text-muted font-mono">{r.customer_code}</div>
                  {r.investments_missing_interest_start > 0 && (
                    <div className="text-[10px] text-danger mt-0.5" title="Investment(s) with no interest start date — fails downstream processing">
                      ⚠ {r.investments_missing_interest_start} investment(s) missing interest start
                    </div>
                  )}
                </td>
                <td className="px-3 py-2 min-w-[240px]">
                  {[...KYC_DOCS, ...EXTRA_DOCS].map((t) => {
                    const doc = r.docs?.[t];
                    const optional = (EXTRA_DOCS as readonly string[]).includes(t);
                    return (
                      <label key={t} className="inline-block">
                        <Tick label={DOC_SHORT[t] ?? t} tone={doc ? 'green' : optional ? 'orange' : 'red'}
                          title={doc ? `${t}: ${doc.original_filename ?? 'on file'}` : `${t}: missing${optional ? ' (optional)' : ''} — click to upload`} />
                        <input type="file" accept="application/pdf,image/jpeg,image/png" className="hidden"
                          onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) uploadDoc(r.id, t, f); }} />
                      </label>
                    );
                  })}
                </td>
                <td className="px-3 py-2 min-w-[380px]">
                  {r.data_checks.map((k) => (
                    <Tick key={k.key} label={k.label} tone={toneOf(k)}
                      title={`${k.label}: ${k.valid ? (k.value ?? 'ok') : k.partial ? `incomplete (${k.value ?? ''})` : 'missing'}${k.optional ? ' — optional' : ''}`}
                      onClick={k.key === 'nominee'
                        ? undefined
                        : () => { setMsg(''); setEdit({ cid: r.id, key: k.key, label: k.label, value: '' }); }} />
                  ))}
                  {r.nominee && !r.data_checks.find((k) => k.key === 'nominee')?.valid && (
                    <div className="text-[10px] text-text-muted mt-0.5">Nominee “{r.nominee.full_name}” — add relationship/DOB on the profile</div>
                  )}
                </td>
                <td className="px-3 py-2 whitespace-nowrap">
                  <span className={`text-xs rounded px-1.5 py-0.5 ${r.kyc_status === 'Verified' ? TONE.green : r.kyc_status === 'Rejected' ? TONE.red : 'bg-bg'}`}>{r.kyc_status}</span>
                </td>
                <td className="px-3 py-2 whitespace-nowrap">
                  {can('kyc:verify') && r.kyc_status !== 'Verified' && (
                    <button onClick={() => verify(r.id)} className="text-xs border border-border rounded px-3 py-1.5 hover:bg-bg">✓ Verify</button>
                  )}
                </td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={5} className="px-3 py-6 text-center text-text-muted">No customers match.</td></tr>}
          </tbody>
        </table>
      </div>

      {edit && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={() => setEdit(null)}>
          <div className="bg-surface border border-border rounded-lg shadow-lg p-5 w-full max-w-[360px]" onClick={(e) => e.stopPropagation()}>
            <div className="text-sm font-semibold mb-2">Fix {edit.label}</div>
            <input autoFocus value={edit.value} onChange={(e) => setEdit({ ...edit, value: e.target.value })}
              onKeyDown={(e) => { if (e.key === 'Enter') saveField(); }}
              placeholder={edit.key === 'aadhaar' ? 'Full 12-digit Aadhaar' : edit.key === 'depository' ? 'NSDL or CDSL' : ''}
              className="w-full px-2.5 py-1.5 text-sm border border-border-strong rounded outline-none focus:border-primary" />
            <div className="flex justify-end gap-2 mt-3">
              <button onClick={() => setEdit(null)} className="text-xs text-text-muted hover:underline px-2">Cancel</button>
              <button onClick={saveField} disabled={busy || !edit.value.trim()}
                className="text-xs bg-primary text-white rounded px-4 py-1.5 disabled:opacity-40 hover:bg-primary-hover">Save</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
