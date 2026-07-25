import { useMemo, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { formatINR, ESCROW_STATUS_LABEL, type EscrowMatchStatus } from '@new-wealth/shared';
import { api, ApiError } from '../api/client.js';

/** Escrow reconciliation (inbound NCD subscription money). Upload the SBI
 *  statement, review the proposed matches, confirm / assign / ignore each line.
 *  The parser only proposes — nothing here touches the investment approval flow. */

const STATUS_STYLES: Record<EscrowMatchStatus, string> = {
  Matched: 'bg-[color:var(--success-bg)] text-success',
  Company: 'bg-bg text-text-muted',
  NotEnrolled: 'bg-[color:var(--warn-bg)] text-warn',
  Unidentified: 'bg-[color:var(--warn-bg)] text-warn',
  Flagged: 'bg-[color:var(--danger-bg)] text-danger',
  Debit: 'bg-bg text-text-muted',
  Ignored: 'bg-bg text-text-muted line-through',
  Unmatched: 'bg-bg text-text-muted',
};

const FILTERS: { key: string; label: string }[] = [
  { key: '', label: 'All' },
  { key: 'NotEnrolled', label: 'Not enrolled' },
  { key: 'Unidentified', label: 'Unidentified' },
  { key: 'Flagged', label: 'Flagged' },
  { key: 'Matched', label: 'Matched' },
  { key: 'Company', label: 'Company' },
  { key: 'Ignored', label: 'Ignored' },
];

export function EscrowPage() {
  const qc = useQueryClient();
  const [msg, setMsg] = useState('');
  const [status, setStatus] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const summary = useQuery({ queryKey: ['escrow-summary'], queryFn: () => api.get<any>('/api/escrow/summary') });
  const statements = useQuery({ queryKey: ['escrow-statements'], queryFn: () => api.get<{ rows: any[] }>('/api/escrow/statements') });
  const lines = useQuery({ queryKey: ['escrow-lines', status], queryFn: () => api.get<{ rows: any[] }>(`/api/escrow/lines${status ? `?status=${status}` : ''}`) });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['escrow-summary'] });
    qc.invalidateQueries({ queryKey: ['escrow-statements'] });
    qc.invalidateQueries({ queryKey: ['escrow-lines'] });
  };

  const upload = useMutation({
    mutationFn: async (file: File) => {
      const data_base64 = await new Promise<string>((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(String(r.result).split(',')[1] ?? '');
        r.onerror = () => rej(new Error('Could not read the file'));
        r.readAsDataURL(file);
      });
      return api.post<any>('/api/escrow/statements', { filename: file.name, data_base64 });
    },
    onSuccess: (r) => {
      setMsg(`Statement processed: ${r.inserted} new line(s) — ${r.matched} matched, ${r.not_enrolled} not enrolled, ${r.flagged} flagged${r.duplicates ? `, ${r.duplicates} already seen` : ''}.`);
      if (fileRef.current) fileRef.current.value = '';
      refresh();
    },
    onError: (e) => setMsg(e instanceof ApiError ? e.message : 'Upload failed'),
  });

  const act = useMutation({
    mutationFn: ({ id, action, body }: { id: number; action: string; body?: unknown }) => api.post(`/api/escrow/lines/${id}/${action}`, body ?? {}),
    onSuccess: () => { setMsg(''); refresh(); },
    onError: (e) => setMsg(e instanceof ApiError ? e.message : 'Failed'),
  });

  const s = summary.data;
  const card = 'bg-surface border border-border rounded-lg shadow-card p-5';
  const th = 'text-left text-xs font-semibold text-text-label uppercase tracking-wide px-3 py-2';
  const td = 'px-3 py-2 text-sm align-top';

  return (
    <div className="w-full">
      <h1 className="text-xl font-bold tracking-tight mb-1">Escrow reconciliation</h1>
      <p className="text-sm text-text-muted mb-4">Inbound NCD subscription money in the SBI escrow account. Upload the statement, then confirm who paid.</p>

      {msg && <div className="mb-3 text-sm bg-[color:var(--primary-bg)] text-primary border border-border rounded px-3 py-2">{msg}</div>}

      {/* Tiles */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
        <div className={card}>
          <div className="text-xs text-text-label uppercase tracking-wide">Escrow balance</div>
          <div className="text-2xl font-bold mt-1">{s?.escrow_balance != null ? formatINR(s.escrow_balance) : '—'}</div>
          <div className="text-xs text-text-muted mt-1">{s?.escrow_account ? `A/c …${String(s.escrow_account).slice(-4)}` : 'No statement yet'}{s?.as_of ? ` · as on ${s.as_of}` : ''}</div>
        </div>
        <div className={card}>
          <div className="text-xs text-text-label uppercase tracking-wide">Received — not enrolled</div>
          <div className="text-2xl font-bold mt-1 text-warn">{s ? formatINR(s.not_enrolled_total) : '—'}</div>
          <div className="text-xs text-text-muted mt-1">{s ? `${s.not_enrolled_count} payment(s) from people not in the system` : ''}</div>
        </div>
        <div className={card}>
          <div className="text-xs text-text-label uppercase tracking-wide">Enrolled investors</div>
          <div className="text-2xl font-bold mt-1 text-success">{s ? formatINR(s.breakup.enrolled_total) : '—'}</div>
          <div className="text-xs text-text-muted mt-1">{s ? `${s.breakup.enrolled_investors.length} investor(s) · company floor ${formatINR(s.breakup.company)}` : ''}</div>
        </div>
      </div>

      {/* Upload */}
      <div className={`${card} mb-4`}>
        <div className="text-xs font-semibold text-text-label uppercase tracking-wide mb-2">Upload SBI statement</div>
        <div className="flex flex-wrap items-center gap-3">
          <input ref={fileRef} type="file" accept=".xls,.xlsx,.csv,text/csv,application/vnd.ms-excel"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) upload.mutate(f); }}
            className="text-sm" disabled={upload.isPending} />
          {upload.isPending && <span className="text-xs text-text-muted">Processing…</span>}
        </div>
        <p className="text-xs text-text-muted mt-2">SBI "download as xls" (tab-separated), .xlsx or .csv. Re-uploading an overlapping period is safe — duplicate lines are skipped.</p>
      </div>

      {/* Breakup drill-down */}
      {s && s.breakup.enrolled_investors.length > 0 && (
        <div className={`${card} mb-4`}>
          <div className="text-xs font-semibold text-text-label uppercase tracking-wide mb-2">Escrow breakup — who's in the system</div>
          <table className="w-full">
            <tbody>
              <tr className="border-b border-border"><td className={td}>Company floor (not an investment)</td><td className={`${td} text-right mono`}>{formatINR(s.breakup.company)}</td></tr>
              {s.breakup.enrolled_investors.map((r: any) => (
                <tr key={r.customer_id} className="border-b border-border last:border-0">
                  <td className={td}><a href={`/app/customers/${r.customer_id}`} className="text-primary hover:underline">{r.full_name}</a> <span className="text-xs text-text-muted">{r.customer_code} · {r.count} payment(s)</span></td>
                  <td className={`${td} text-right mono`}>{formatINR(r.total)}</td>
                </tr>
              ))}
              <tr className="border-t border-border-strong"><td className={`${td} text-warn`}>Received — not enrolled</td><td className={`${td} text-right mono text-warn`}>{formatINR(s.breakup.not_enrolled_total)}</td></tr>
              {s.breakup.flagged_total > 0 && <tr><td className={`${td} text-danger`}>Flagged ({s.breakup.flagged_count})</td><td className={`${td} text-right mono text-danger`}>{formatINR(s.breakup.flagged_total)}</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {/* Lines */}
      <div className={card}>
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <div className="text-xs font-semibold text-text-label uppercase tracking-wide mr-2">Statement lines</div>
          {FILTERS.map((f) => (
            <button key={f.key} onClick={() => setStatus(f.key)}
              className={`text-xs rounded px-2.5 py-1 border ${status === f.key ? 'bg-primary text-white border-primary' : 'border-border hover:bg-bg'}`}>{f.label}</button>
          ))}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px]">
            <thead><tr className="border-b border-border">
              <th className={th}>Date</th><th className={th}>Amount</th><th className={th}>Type</th>
              <th className={th}>Payer</th><th className={th}>Reference</th><th className={th}>Status</th><th className={th}>Action</th>
            </tr></thead>
            <tbody>
              {(lines.data?.rows ?? []).map((l: any) => (
                <LineRow key={l.id} line={l} onAct={(action, body) => act.mutate({ id: l.id, action, body })} td={td} />
              ))}
              {lines.data && lines.data.rows.length === 0 && (
                <tr><td className={td} colSpan={7}><span className="text-text-muted">No lines{status ? ` with status “${ESCROW_STATUS_LABEL[status as EscrowMatchStatus] ?? status}”` : ''}. Upload a statement to begin.</span></td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Uploads history */}
      {(statements.data?.rows?.length ?? 0) > 0 && (
        <div className={`${card} mt-4`}>
          <div className="text-xs font-semibold text-text-label uppercase tracking-wide mb-2">Uploads</div>
          <table className="w-full text-sm">
            <thead><tr className="border-b border-border"><th className={th}>Period</th><th className={th}>Account</th><th className={th}>Lines</th><th className={th}>Closing</th><th className={th}>By</th><th className={th}>When</th></tr></thead>
            <tbody>
              {statements.data!.rows.map((r: any) => (
                <tr key={r.id} className="border-b border-border last:border-0">
                  <td className={td}>{r.period_from} → {r.period_to}</td>
                  <td className={td}>…{String(r.account_number ?? '').slice(-4)}</td>
                  <td className={td}>{r.credit_count}/{r.line_count}</td>
                  <td className={`${td} mono`}>{r.closing_balance != null ? formatINR(r.closing_balance) : '—'}</td>
                  <td className={td}>{r.uploaded_by ?? '—'}</td>
                  <td className={td}>{String(r.created_at).slice(0, 10)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** One statement line, with inline confirm / assign / ignore controls. */
function LineRow({ line: l, onAct, td }: { line: any; onAct: (action: string, body?: unknown) => void; td: string }) {
  const [assigning, setAssigning] = useState(false);
  const badge = STATUS_STYLES[l.match_status as EscrowMatchStatus] ?? STATUS_STYLES.Unmatched;
  const reviewed = !!l.reviewed_at;
  return (
    <tr className="border-b border-border last:border-0">
      <td className={td}>{l.value_date ?? l.txn_date}</td>
      <td className={`${td} mono whitespace-nowrap ${l.direction === 'debit' ? 'text-text-muted' : ''}`}>{l.direction === 'debit' ? '−' : ''}{formatINR(Math.abs(Number(l.amount)))}</td>
      <td className={td}>{l.pay_type}</td>
      <td className={td}>
        {l.matched_customer_name
          ? <a href={`/app/customers/${l.matched_customer_id}`} className="text-primary hover:underline">{l.matched_customer_name}</a>
          : <span>{l.remitter_name ?? <span className="text-text-muted">—</span>}</span>}
        {l.remitter_account && <div className="text-xs text-text-muted">a/c …{String(l.remitter_account).slice(-4)}{l.remitter_account_pooled ? ' (pooled)' : ''}</div>}
        {l.flag_reason && <div className="text-xs text-danger mt-0.5">{l.flag_reason}</div>}
      </td>
      <td className={td}>
        <div className="text-xs">{l.utr ? `UTR ${l.utr}` : l.cheque_no ? `Chq ${l.cheque_no}${l.presenting_bank ? ` (${l.presenting_bank})` : ''}` : '—'}</div>
        {l.match_method && <div className="text-xs text-text-muted">via {l.match_method}{l.match_confidence ? ` · ${l.match_confidence}` : ''}</div>}
      </td>
      <td className={td}>
        <span className={`text-xs rounded px-1.5 py-0.5 ${badge}`}>{ESCROW_STATUS_LABEL[l.match_status as EscrowMatchStatus] ?? l.match_status}</span>
        {reviewed && <span className="text-xs text-success ml-1">✓</span>}
      </td>
      <td className={td}>
        {assigning
          ? <AssignPicker onPick={(customerId) => { onAct('assign', { customer_id: customerId }); setAssigning(false); }} onCancel={() => setAssigning(false)} />
          : (
            <div className="flex flex-wrap gap-1.5">
              {l.match_status === 'Matched' && !reviewed && <button onClick={() => onAct('confirm')} className="text-xs bg-success text-white rounded px-2 py-1 hover:opacity-90">Confirm</button>}
              {l.match_status !== 'Ignored' && l.direction !== 'debit' && <button onClick={() => setAssigning(true)} className="text-xs border border-border rounded px-2 py-1 hover:bg-bg">{l.matched_customer_name ? 'Reassign' : 'Assign'}</button>}
              {l.match_status !== 'Ignored' && <button onClick={() => { if (confirm('Ignore this line? It will be left out of reconciliation.')) onAct('ignore'); }} className="text-xs border border-border text-text-muted rounded px-2 py-1 hover:bg-bg">Ignore</button>}
            </div>
          )}
      </td>
    </tr>
  );
}

/** Type-ahead customer picker for manual assignment. */
function AssignPicker({ onPick, onCancel }: { onPick: (customerId: number) => void; onCancel: () => void }) {
  const [q, setQ] = useState('');
  const results = useQuery({
    queryKey: ['escrow-assign-search', q],
    queryFn: () => api.get<{ rows: any[] }>(`/api/customers?q=${encodeURIComponent(q)}`),
    enabled: q.trim().length >= 2,
  });
  const rows = useMemo(() => (results.data?.rows ?? []).slice(0, 6), [results.data]);
  return (
    <div className="min-w-[220px]">
      <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name / code / phone"
        className="px-2 py-1 text-xs border border-border-strong rounded w-full outline-none focus:border-primary" />
      <div className="mt-1">
        {rows.map((c: any) => (
          <button key={c.id} onClick={() => onPick(c.id)} className="block w-full text-left text-xs px-2 py-1 hover:bg-bg rounded">
            {c.full_name} <span className="text-text-muted">{c.customer_code}</span>
          </button>
        ))}
        {q.trim().length >= 2 && !rows.length && <div className="text-xs text-text-muted px-2 py-1">No matches</div>}
      </div>
      <button onClick={onCancel} className="text-xs text-text-muted hover:underline mt-1">Cancel</button>
    </div>
  );
}
