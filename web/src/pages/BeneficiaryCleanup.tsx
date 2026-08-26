import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../api/client.js';

/**
 * Beneficiary-name cleanup (owner 2026-08-26). Lists every bank account whose
 * beneficiary (holder) name carries a character banks reject/mangle on NEFT —
 * dot, comma, hyphen, slash — with a field to type the corrected name. Each save
 * reuses the ordinary rename, so it is audited like any other.
 */
interface Row {
  id: number; customer_id: number; customer_name: string; customer_code: string | null;
  account_number: string; ifsc: string; holder_name: string; is_active: boolean;
}
const BAD = /[.,\/-]/;

export function BeneficiaryCleanupPage() {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ['beneficiary-cleanup'],
    queryFn: () => api.get<{ rows: Row[]; count: number }>('/api/customers/beneficiary-cleanup'),
  });
  if (isLoading) return <div className="text-text-muted">Loading…</div>;
  if (error) return <div className="text-danger">Failed to load.</div>;
  const rows = data?.rows ?? [];
  return (
    <div className="w-full">
      <h1 className="text-xl font-bold tracking-tight m-0">Beneficiary name cleanup</h1>
      <p className="text-sm text-text-muted mt-1 mb-4">
        Bank beneficiary names containing <span className="font-mono">. , - /</span> — characters banks reject or mangle
        on the NEFT sheet. Type the corrected name and Save; each save is audited. <span className="font-medium text-text">{rows.length}</span> to fix.
      </p>
      {rows.length === 0 ? (
        <div className="bg-surface border border-border rounded-lg shadow-card p-6 text-center text-text-muted text-sm">
          All clean — no beneficiary name has those characters.
        </div>
      ) : (
        <div className="bg-surface border border-border rounded-lg shadow-card divide-y divide-border">
          {rows.map((r) => (
            <EditRow key={r.id} r={r} onSaved={() => qc.invalidateQueries({ queryKey: ['beneficiary-cleanup'] })} />
          ))}
        </div>
      )}
    </div>
  );
}

function EditRow({ r, onSaved }: { r: Row; onSaved: () => void }) {
  const [val, setVal] = useState(r.holder_name);
  const [err, setErr] = useState('');
  const [done, setDone] = useState(false);
  const save = useMutation({
    mutationFn: () => api.patch(`/api/customers/${r.customer_id}/bank-accounts/${r.id}`, { holder_name: val.trim() }),
    onSuccess: () => { setErr(''); setDone(true); setTimeout(onSaved, 600); },
    onError: (e) => setErr(e instanceof ApiError ? e.message : 'Failed'),
  });
  const dirty = val.trim() !== r.holder_name && val.trim().length >= 2;
  const stillBad = BAD.test(val);
  return (
    <div className="p-3 flex flex-wrap items-center gap-x-3 gap-y-1.5">
      <div className="min-w-0 flex-1">
        <Link to={`/app/customers/${r.customer_id}`} className="text-sm text-primary hover:underline">{r.customer_name}</Link>
        {r.customer_code && <span className="text-[11px] text-text-muted ml-1">{r.customer_code}</span>}
        <div className="text-[11px] text-text-muted font-mono">{r.account_number} · {r.ifsc}{r.is_active ? '' : ' · inactive'}</div>
        <div className="text-xs text-text-muted mt-0.5">Current: <span className="font-mono text-warn">{r.holder_name}</span></div>
      </div>
      <input className="px-2 py-1 text-sm border border-border-strong rounded outline-none focus:border-primary w-64"
        value={val} onChange={(e) => { setVal(e.target.value); setDone(false); }} placeholder="Corrected beneficiary name" />
      <button disabled={!dirty || save.isPending || done} onClick={() => save.mutate()}
        className="text-xs bg-primary hover:bg-primary-hover disabled:opacity-40 text-white rounded px-3 py-1.5 whitespace-nowrap">
        {done ? 'Saved ✓' : save.isPending ? 'Saving…' : 'Save'}
      </button>
      {stillBad && !done && <span className="text-[11px] text-warn">still has . , - /</span>}
      {err && <span className="text-xs text-danger">{err}</span>}
    </div>
  );
}
