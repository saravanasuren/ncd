import { useEffect, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { IFSC_RE } from '@new-wealth/shared';
import { api, ApiError } from '../api/client.js';
import { DataTable, type Column } from '../components/DataTable.js';

interface AgentRow {
  id: number;
  agent_code: string;
  full_name: string;
  phone: string | null;
  email: string | null;
  source: string;
  commission_status: string;
  commission_rate_pct: string | null;
  is_active: boolean;
  user_id: number | null;
  user_name: string | null;
  bank_name: string | null;
  branch_name: string | null;
  account_number: string | null;
  ifsc: string | null;
  account_holder_name: string | null;
}

/** The payout account. IFSC drives bank + branch; the beneficiary is who the
 *  transfer is actually made out to, which is not always the agent. */
interface BankFields {
  bank_name: string; branch_name: string; account_number: string;
  ifsc: string; account_holder_name: string;
}

interface EditState extends BankFields {
  id: number; full_name: string; phone: string; email: string;
}

const EMPTY_BANK: BankFields = { bank_name: '', branch_name: '', account_number: '', ifsc: '', account_holder_name: '' };
const EMPTY = { full_name: '', agent_code: '', phone: '', email: '', ...EMPTY_BANK };
const inp = 'px-2.5 py-1.5 text-sm border border-border-strong rounded outline-none focus:border-primary';

/**
 * IFSC → bank + branch, the same lookup the customer bank form uses
 * (`/api/lookups/ifsc/:code`). Debounced, and an unknown code is not an error —
 * it just leaves the fields for manual entry.
 *
 * It fills only when the operator TYPES an IFSC, or when bank/branch are still
 * blank. Opening the editor on an agent who already has both must not silently
 * rewrite what someone recorded by hand.
 */
function useIfscLookup(
  ifsc: string,
  touched: boolean,
  hasBankAndBranch: boolean,
  apply: (v: { bank: string; branch: string }) => void,
) {
  const [state, setState] = useState<'idle' | 'looking' | 'ok' | 'miss'>('idle');
  const applyRef = useRef(apply);
  applyRef.current = apply;

  useEffect(() => {
    const code = ifsc.trim().toUpperCase();
    if (!IFSC_RE.test(code)) { setState('idle'); return; }
    if (!touched && hasBankAndBranch) { setState('idle'); return; }
    let cancelled = false;
    setState('looking');
    const t = setTimeout(async () => {
      try {
        const r = await api.get<{ found: boolean; bank?: string; branch?: string }>(`/api/lookups/ifsc/${code}`);
        if (cancelled) return;
        if (r.found) { applyRef.current({ bank: r.bank ?? '', branch: r.branch ?? '' }); setState('ok'); }
        else setState('miss');
      } catch { if (!cancelled) setState('miss'); }
    }, 400);
    return () => { cancelled = true; clearTimeout(t); };
  }, [ifsc, touched, hasBankAndBranch]);

  return state;
}

interface StaffCandidate { id: number; code: string | null; full_name: string; email: string; role: string }

/**
 * "This agent is actually one of our people." Ticking `staff` on their user does
 * nothing to the agent record — two tables, no link — so they stay on this list
 * and, more to the point, their incentive stays on the agent side of every
 * report. This folds the record into the staff member and moves the money with
 * it, paid history included (owner 2026-08-03).
 */
function MergePanel({ agent, onClose, onDone }: {
  agent: AgentRow; onClose: () => void; onDone: (msg: string) => void;
}) {
  const [q, setQ] = useState(agent.full_name);
  const [debounced, setDebounced] = useState(agent.full_name);
  const [picked, setPicked] = useState<StaffCandidate | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => { const t = setTimeout(() => setDebounced(q), 300); return () => clearTimeout(t); }, [q]);
  const { data, isFetching } = useQuery({
    queryKey: ['staff-candidates', debounced],
    queryFn: () => api.get<{ rows: StaffCandidate[] }>(`/api/agents/staff-candidates?q=${encodeURIComponent(debounced)}`),
    enabled: debounced.trim().length >= 2,
  });

  const merge = useMutation({
    mutationFn: () => api.post<{ accruals_moved: number; payouts_moved: number; user_name: string }>(
      `/api/agents/${agent.id}/merge-into-staff`, { user_id: picked!.id }),
    onSuccess: (r) => onDone(
      `${agent.full_name} merged into ${r.user_name} — ${r.accruals_moved} incentive row(s) and ${r.payouts_moved} payout row(s) moved across.`),
    onError: (e) => setErr(e instanceof ApiError ? e.message : 'Merge failed'),
  });

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center p-6 overflow-auto" onClick={onClose}>
      <div className="bg-surface border border-border rounded-lg shadow-card p-5 w-full max-w-lg mt-16" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-base font-semibold m-0">Merge <span className="font-mono text-sm">{agent.agent_code}</span> {agent.full_name} into a staff member</h2>
        <p className="text-sm text-text-muted mt-1 mb-4">
          Everything moves — incentive already paid as well as pending, plus anything they enrolled.
          This agent record then leaves the list, and a "referred by" naming them resolves to the staff
          member from here on.
        </p>

        {!picked ? (
          <>
            <input autoFocus className={`${inp} w-full`} placeholder="Search staff by name, code or email"
              value={q} onChange={(e) => setQ(e.target.value)} />
            <div className="mt-2 max-h-64 overflow-auto border border-border rounded">
              {isFetching && <div className="p-3 text-sm text-text-muted">Searching…</div>}
              {!isFetching && (data?.rows.length ?? 0) === 0 &&
                <div className="p-3 text-sm text-text-muted">
                  No staff match. Only people marked <strong>staff</strong> on their user can be merged into —
                  tick that first if it is missing.
                </div>}
              {data?.rows.map((u) => (
                <button key={u.id} onClick={() => { setErr(''); setPicked(u); }}
                  className="w-full text-left px-3 py-2 text-sm hover:bg-bg border-b border-border last:border-0">
                  <span className="font-medium">{u.full_name}</span>
                  <span className="text-text-muted"> · {u.role}{u.code ? ` · ${u.code}` : ''}</span>
                  <div className="text-xs text-text-muted">{u.email}</div>
                </button>
              ))}
            </div>
          </>
        ) : (
          <div className="border border-border rounded p-3 text-sm">
            <div>Merging <strong>{agent.full_name}</strong> into <strong>{picked.full_name}</strong> ({picked.role}).</div>
            <div className="text-text-muted mt-1">This cannot be undone from the screen.</div>
          </div>
        )}

        {err && <div className="text-xs text-danger mt-3">{err}</div>}

        <div className="flex gap-2 justify-end mt-4">
          {picked && <button onClick={() => setPicked(null)} className="text-sm text-text-muted hover:underline px-2">Back</button>}
          <button onClick={onClose} className="text-sm text-text-muted hover:underline px-2">Cancel</button>
          <button disabled={!picked || merge.isPending} onClick={() => { setErr(''); merge.mutate(); }}
            className="bg-primary hover:bg-primary-hover disabled:opacity-40 text-white rounded px-4 py-1.5 text-sm font-semibold">
            {merge.isPending ? 'Merging…' : 'Merge'}
          </button>
        </div>
      </div>
    </div>
  );
}

const HINT = {
  idle: 'IFSC fills the bank & branch',
  looking: 'Looking up…',
  ok: '✓ Bank & branch filled from the IFSC',
  miss: 'IFSC not found — type the bank & branch yourself',
} as const;

/** The five payout fields, shared by the add form and the row editor. */
function BankInputs({ v, onChange, wide }: {
  v: BankFields; onChange: (patch: Partial<BankFields>) => void; wide?: boolean;
}) {
  const [touched, setTouched] = useState(false);
  const state = useIfscLookup(
    v.ifsc, touched, !!(v.bank_name && v.branch_name),
    ({ bank, branch }) => onChange({ bank_name: bank, branch_name: branch }),
  );
  const malformed = v.ifsc.length === 11 && !IFSC_RE.test(v.ifsc);
  const w = (n: string) => (wide ? n : '');

  return (
    // The min-width stops the table column squeezing these into five stacked
    // lines and making the row five inputs tall.
    <span className={`flex flex-col gap-1 ${wide ? '' : 'min-w-[23rem]'}`}>
      <span className="flex flex-wrap gap-1">
        <input className={`${inp} uppercase ${w('w-32')} w-28`} placeholder="IFSC" maxLength={11}
          value={v.ifsc}
          onChange={(e) => { setTouched(true); onChange({ ifsc: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 11) }); }} />
        <input className={`${inp} ${w('w-40')} w-32`} placeholder="Bank" value={v.bank_name}
          onChange={(e) => onChange({ bank_name: e.target.value })} />
        <input className={`${inp} ${w('w-40')} w-32`} placeholder="Branch" value={v.branch_name}
          onChange={(e) => onChange({ branch_name: e.target.value })} />
      </span>
      <span className="flex flex-wrap gap-1">
        <input className={`${inp} ${w('w-44')} w-36`} placeholder="Account no." value={v.account_number}
          onChange={(e) => onChange({ account_number: e.target.value.replace(/\s/g, '') })} />
        <input className={`${inp} ${w('w-48')} w-40`} placeholder="Beneficiary name" value={v.account_holder_name}
          onChange={(e) => onChange({ account_holder_name: e.target.value })} />
      </span>
      <span className={`text-[11px] ${malformed || state === 'miss' ? 'text-danger' : 'text-text-muted'}`}>
        {malformed ? 'IFSC is 4 letters, a 0, then 6 more — e.g. SBIN0001234.' : HINT[state]}
      </span>
    </span>
  );
}

export function AgentsPage() {
  const qc = useQueryClient();
  const [form, setForm] = useState(EMPTY);
  const [edit, setEdit] = useState<EditState | null>(null);
  const [merging, setMerging] = useState<AgentRow | null>(null);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const { data, isLoading, error } = useQuery({ queryKey: ['agents'], queryFn: () => api.get<{ rows: AgentRow[] }>('/api/agents') });

  const create = useMutation({
    mutationFn: () => api.post('/api/agents', {
      full_name: form.full_name,
      ...(form.agent_code.trim() ? { agent_code: form.agent_code.trim() } : {}),
      ...(form.phone ? { phone: form.phone } : {}),
      ...(form.email ? { email: form.email } : {}),
      ...(form.bank_name ? { bank_name: form.bank_name } : {}),
      ...(form.branch_name ? { branch_name: form.branch_name } : {}),
      ...(form.account_number ? { account_number: form.account_number } : {}),
      ...(form.ifsc ? { ifsc: form.ifsc } : {}),
      ...(form.account_holder_name ? { account_holder_name: form.account_holder_name } : {}),
    }),
    onSuccess: () => { setForm(EMPTY); qc.invalidateQueries({ queryKey: ['agents'] }); },
    onError: (e) => setErr(e instanceof ApiError ? e.message : 'Failed'),
  });

  const update = useMutation({
    mutationFn: (e: EditState) => api.put(`/api/agents/${e.id}`, {
      full_name: e.full_name,
      phone: e.phone || null,
      email: e.email || null,
      bank_name: e.bank_name || null,
      branch_name: e.branch_name || null,
      account_number: e.account_number || null,
      ifsc: e.ifsc || null,
      account_holder_name: e.account_holder_name || null,
    }),
    onSuccess: () => { setEdit(null); qc.invalidateQueries({ queryKey: ['agents'] }); },
    onError: (e) => setErr(e instanceof ApiError ? e.message : 'Failed to update agent'),
  });

  const toggle = useMutation({
    mutationFn: (a: AgentRow) => api.put(`/api/agents/${a.id}`, { is_active: !a.is_active }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['agents'] }),
    onError: (e) => setErr(e instanceof ApiError ? e.message : 'Failed'),
  });

  // A half-typed IFSC would be saved as-is and the money would bounce.
  const badIfsc = (ifsc: string) => !!ifsc.trim() && !IFSC_RE.test(ifsc.trim().toUpperCase());

  if (isLoading) return <div className="text-text-muted">Loading…</div>;
  if (error) return <div className="text-danger">Failed to load agents.</div>;

  const columns: Column<AgentRow>[] = [
    { key: 'agent_code', header: 'Code', tdClassName: 'font-mono text-xs' },
    { key: 'full_name', header: 'Name', tdClassName: 'font-medium',
      render: (a) => edit?.id === a.id
        ? <input className={`${inp} w-44`} value={edit.full_name} onChange={(e) => setEdit({ ...edit, full_name: e.target.value })} />
        : a.full_name },
    { key: 'phone', header: 'Phone', tdClassName: 'text-text-muted', value: (a) => a.phone ?? '',
      render: (a) => edit?.id === a.id
        ? <input className={`${inp} w-32`} placeholder="Phone" value={edit.phone} onChange={(e) => setEdit({ ...edit, phone: e.target.value })} />
        : (a.phone ?? '—') },
    { key: 'bank', header: 'Payout account', sortable: false, filterable: false,
      value: (a) => [a.bank_name, a.branch_name, a.account_number, a.account_holder_name].filter(Boolean).join(' '),
      render: (a) => edit?.id === a.id
        ? <BankInputs v={edit} onChange={(patch) => setEdit({ ...edit, ...patch })} />
        : (a.bank_name || a.account_number
            ? <span className="text-xs flex flex-col leading-tight">
                <span>{[a.bank_name, a.branch_name].filter(Boolean).join(' · ') || '—'}</span>
                <span className="font-mono text-text-muted">{a.account_number ?? ''}{a.ifsc ? ` · ${a.ifsc}` : ''}</span>
                {a.account_holder_name && a.account_holder_name !== a.full_name
                  && <span className="text-text-muted">in the name of {a.account_holder_name}</span>}
              </span>
            : '—') },
    { key: 'source', header: 'Source' },
    { key: 'commission_status', header: 'Commission',
      render: (a) => <span className="text-xs rounded px-1.5 py-0.5 bg-bg">{a.commission_status}{a.commission_rate_pct ? ` · ${Number(a.commission_rate_pct)}%` : ''}</span> },
    { key: 'user_name', header: 'Linked user', value: (a) => a.user_name ?? '', render: (a) => a.user_name ?? '—' },
    { key: 'is_active', header: 'Status', value: (a) => (a.is_active ? 'Active' : 'Disabled'),
      render: (a) => <span className={`text-xs rounded px-1.5 py-0.5 ${a.is_active ? 'bg-[color:var(--success-bg)] text-success' : 'bg-bg text-text-muted'}`}>{a.is_active ? 'Active' : 'Disabled'}</span> },
    { key: 'actions', header: '', sortable: false, filterable: false, align: 'right', tdClassName: 'whitespace-nowrap align-top',
      render: (a) => edit?.id === a.id ? (
        <span className="flex gap-2 justify-end">
          <button onClick={() => { setErr(''); update.mutate(edit); }}
            disabled={!edit.full_name.trim() || badIfsc(edit.ifsc) || update.isPending}
            className="text-xs bg-primary text-white rounded px-3 py-1 disabled:opacity-40 hover:bg-primary-hover">Save</button>
          <button onClick={() => setEdit(null)} className="text-xs text-text-muted hover:underline">Cancel</button>
        </span>
      ) : (
        <span className="flex gap-3 justify-end">
          <button onClick={() => { setErr(''); setEdit({
              id: a.id, full_name: a.full_name, phone: a.phone ?? '', email: a.email ?? '',
              bank_name: a.bank_name ?? '', branch_name: a.branch_name ?? '',
              account_number: a.account_number ?? '', ifsc: a.ifsc ?? '',
              account_holder_name: a.account_holder_name ?? '',
            }); }}
            className="text-xs text-primary hover:underline">Edit</button>
          <button onClick={() => { setErr(''); setMsg(''); setMerging(a); }} className="text-xs text-primary hover:underline"
            title="This agent is really one of our staff — fold the record and its incentive into their user">Merge into staff</button>
          <button onClick={() => { setErr(''); toggle.mutate(a); }} className="text-xs text-primary hover:underline">
            {a.is_active ? 'Disable' : 'Enable'}
          </button>
        </span>
      ) },
  ];

  return (
    <div className="w-full">
      <h1 className="text-xl font-bold tracking-tight m-0">Agents</h1>
      <p className="text-sm text-text-muted mt-1 mb-5">People who source business — their code goes in the customer's "referred by" and drives their incentives. Agents created from a new referred-by name appear here pending approval.</p>

      <div className="bg-surface border border-border rounded-lg shadow-card p-4 mb-5">
        <div className="flex flex-wrap gap-2 items-start">
          <input className={inp} placeholder="Full name *" value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} />
          <input className={`${inp} w-32`} placeholder="Code (auto)" value={form.agent_code} onChange={(e) => setForm({ ...form, agent_code: e.target.value.toUpperCase() })} />
          <input className={`${inp} w-36`} placeholder="Phone" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          <input className={inp} type="email" placeholder="Email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          <BankInputs wide v={form} onChange={(patch) => setForm({ ...form, ...patch })} />
          <button disabled={!form.full_name.trim() || badIfsc(form.ifsc) || create.isPending} onClick={() => { setErr(''); create.mutate(); }}
            className="bg-primary hover:bg-primary-hover disabled:opacity-40 text-white rounded px-4 py-1.5 text-sm font-semibold">+ Add agent</button>
        </div>
        {err && <div className="text-xs text-danger mt-2">{err}</div>}
      </div>

      {msg && <div className="text-sm text-success bg-[color:var(--success-bg)] border border-border rounded px-3 py-2 mb-3">{msg}</div>}

      <DataTable columns={columns} rows={data!.rows} rowKey={(a) => a.id} defaultSort={{ key: 'full_name', dir: 'asc' }} empty="No agents yet." />

      {merging && (
        <MergePanel agent={merging} onClose={() => setMerging(null)}
          onDone={(m) => { setMerging(null); setMsg(m); qc.invalidateQueries({ queryKey: ['agents'] }); }} />
      )}
    </div>
  );
}
