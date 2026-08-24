import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api/client.js';
import { useConfirm } from './Confirm.js';

/**
 * Authorised users on a locker (owner 2026-08-22). Staff add a person (name /
 * PAN / Aadhaar / phone); the locker holder then e-signs a consent letter
 * (Digio), and only THEN is the person authorised. Shown both in Locker
 * Enrollment and on the locker profile. `customerId` is the holder giving
 * consent — passed so the server knows who signs.
 */
interface AuthUser {
  id: number; name: string; pan: string | null; aadhaar: string | null; phone: string | null;
  status: string; consent_sign_url: string | null; consent_signed_at: string | null; consent_signed: boolean;
  lockerhub_synced: boolean; lockerhub_error: string | null; has_consent_pdf: boolean;
}

const inp = 'px-2.5 py-1.5 text-sm border border-border-strong rounded outline-none focus:border-primary';
const btnGhost = 'text-xs border border-border rounded px-3 py-1.5 hover:bg-bg disabled:opacity-40';

export function LockerAuthorisedUsers({ applicationId, customerId }: { applicationId: string; customerId?: number | null }) {
  const qc = useQueryClient();
  const { confirm, promptText } = useConfirm();
  const [f, setF] = useState({ name: '', pan: '', aadhaar: '', phone: '' });
  const [err, setErr] = useState('');
  const [signUrl, setSignUrl] = useState<string | null>(null);
  const key = ['locker-auth-users', applicationId];
  const q = useQuery({
    queryKey: key,
    queryFn: () => api.get<{ rows: AuthUser[] }>(`/api/lockers/applications/${encodeURIComponent(applicationId)}/authorised-users`),
    enabled: !!applicationId,
  });
  const recheck = useMutation({
    mutationFn: (id: number) => api.post<AuthUser>(`/api/lockers/authorised-users/${id}/consent/refresh`, {}),
    onSuccess: (row) => { setErr(row.consent_signed ? '' : 'Still not signed on Digio — the customer hasn’t completed signing yet.'); qc.invalidateQueries({ queryKey: key }); },
    onError: (e) => setErr(e instanceof ApiError ? e.message : 'Recheck failed'),
  });
  const add = useMutation({
    mutationFn: () => api.post<{ id: number; sign_url: string | null; stub: boolean }>(
      `/api/lockers/applications/${encodeURIComponent(applicationId)}/authorised-users`,
      { name: f.name.trim(), pan: f.pan.trim() || undefined, aadhaar: f.aadhaar.trim() || undefined, phone: f.phone.trim() || undefined, ...(customerId ? { customer_id: customerId } : {}) }),
    onSuccess: (r) => { setErr(''); setSignUrl(r.sign_url); setF({ name: '', pan: '', aadhaar: '', phone: '' }); qc.invalidateQueries({ queryKey: key }); },
    onError: (e) => setErr(e instanceof ApiError ? e.message : 'Failed to add'),
  });
  const revoke = useMutation({
    mutationFn: (v: { id: number; reason: string }) => api.post(`/api/lockers/authorised-users/${v.id}/revoke`, { reason: v.reason }),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
    onError: (e) => setErr(e instanceof ApiError ? e.message : 'Failed to revoke'),
  });
  const retrySync = useMutation({
    mutationFn: (id: number) => api.post(`/api/lockers/authorised-users/${id}/sync-retry`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
    onError: (e) => setErr(e instanceof ApiError ? e.message : 'Retry failed'),
  });
  const rows = q.data?.rows ?? [];

  return (
    <div>
      <div className="text-xs font-semibold text-text-label uppercase tracking-wide mb-2">Authorised users</div>
      {err && <div className="text-xs text-danger mb-2">{err}</div>}
      {rows.length > 0 && (
        <div className="mb-3">
          {rows.map((r) => (
            <div key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5 border-b border-border last:border-0 text-sm">
              <span className="font-medium">{r.name}</span>
              {r.pan && <span className="font-mono text-xs text-text-muted">PAN {r.pan}</span>}
              {r.aadhaar && <span className="font-mono text-xs text-text-muted">Aadhaar {r.aadhaar}</span>}
              {r.phone && <span className="font-mono text-xs text-text-muted">{r.phone}</span>}
              {r.consent_signed
                ? <span className="text-xs rounded px-1.5 py-0.5 bg-[color:var(--success-bg)] text-success">✓ authorised</span>
                : <span className="text-xs rounded px-1.5 py-0.5 bg-[color:var(--warn-bg)] text-warn">consent pending</span>}
              {!r.consent_signed && r.consent_sign_url && (
                <a className="text-xs text-primary hover:underline" href={r.consent_sign_url} target="_blank" rel="noopener noreferrer">Open signing link</a>
              )}
              {/* Recheck: pull the live Digio status if the webhook hasn't landed. */}
              {!r.consent_signed && (
                <button className="text-xs text-primary hover:underline disabled:opacity-40" disabled={recheck.isPending} onClick={() => { setErr(''); recheck.mutate(r.id); }}>Recheck</button>
              )}
              {/* Download the signed consent letter once it's signed. */}
              {r.consent_signed && r.has_consent_pdf && (
                <a className="text-xs text-primary hover:underline" href={`/api/lockers/authorised-users/${r.id}/consent.pdf`} target="_blank" rel="noopener noreferrer">↓ Signed consent</a>
              )}
              {/* LockerHub sync (A22) — only relevant once authorised. */}
              {r.consent_signed && r.lockerhub_synced && <span className="text-xs text-text-muted">· synced to LockerHub</span>}
              {r.consent_signed && !r.lockerhub_synced && r.lockerhub_error && (
                <span className="text-xs">
                  <span className="text-danger" title={r.lockerhub_error}>· not synced to LockerHub</span>
                  <button className="ml-1 text-primary hover:underline" disabled={retrySync.isPending} onClick={() => { setErr(''); retrySync.mutate(r.id); }}>Retry</button>
                </span>
              )}
              <button className="ml-auto text-xs text-text-muted hover:text-danger" title="Remove this authorised user"
                onClick={async () => {
                  setErr('');
                  const reason = await promptText({ title: `Remove ${r.name} as an authorised user?`, body: 'Records who removed them and why.', label: 'Reason', minLength: 3, confirmLabel: 'Remove', danger: true });
                  if (reason) revoke.mutate({ id: r.id, reason });
                }}>Remove</button>
            </div>
          ))}
        </div>
      )}
      {rows.length === 0 && !q.isLoading && <div className="text-xs text-text-muted mb-2">No authorised users yet.</div>}

      {/* The consent link for a just-added person — hand it over or send it. */}
      {signUrl && (
        <div className="text-xs bg-[color:var(--success-bg)] text-success rounded px-3 py-2 mb-2 flex flex-wrap items-center gap-2">
          <span>Added — the locker holder must e-sign the consent to authorise them.</span>
          <a className="underline" href={signUrl} target="_blank" rel="noopener noreferrer">Open signing link</a>
          <button className="underline" onClick={() => navigator.clipboard?.writeText(signUrl)}>Copy</button>
        </div>
      )}

      <div className="flex flex-wrap gap-2 items-center">
        <input className={`${inp} w-44`} placeholder="Full name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        <input className={`${inp} w-36 uppercase`} placeholder="PAN" value={f.pan} maxLength={10} onChange={(e) => setF({ ...f, pan: e.target.value.toUpperCase() })} />
        <input className={`${inp} w-40`} placeholder="Aadhaar" value={f.aadhaar} maxLength={12} onChange={(e) => setF({ ...f, aadhaar: e.target.value.replace(/\D/g, '') })} />
        <input className={`${inp} w-32`} placeholder="Phone" value={f.phone} maxLength={10} onChange={(e) => setF({ ...f, phone: e.target.value.replace(/\D/g, '') })} />
        <button className={btnGhost} disabled={f.name.trim().length < 2 || add.isPending} onClick={() => { setErr(''); setSignUrl(null); add.mutate(); }}>
          Add &amp; send consent
        </button>
      </div>
      <p className="text-xs text-text-muted mt-1.5 m-0">A consent letter is generated and sent to the locker holder to e-sign. The person is authorised only once it is signed.</p>
    </div>
  );
}
