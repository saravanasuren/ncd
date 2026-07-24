import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { formatINR } from '@new-wealth/shared';
import { api, ApiError } from '../api/client.js';
import { useAuth } from '../auth/AuthContext.js';

/**
 * Locker tenants, branch-wise — every tenant, not only the ones NCD backs. The
 * roster is one call to LockerHub's /locker-tenants (all branches, or scoped to
 * one); NCD's own pledges and cheques are layered on top, and lockers of ours
 * not allotted yet are appended. The stock panel is their /locker-inventory
 * (A15) — every size including the sold-out ones, which the older
 * /locker-availability quote deliberately omits.
 *
 * Status shown is `account_status` (Active | Closure Requested) — the locker's
 * own status is always "occupied" here, since their query filters on it, and a
 * closed tenancy leaves the roster entirely rather than changing status.
 */
const card = 'bg-surface border border-border rounded-lg shadow-card p-5 mb-4';
const inp = 'px-2.5 py-1.5 text-sm border border-border-strong rounded outline-none focus:border-primary';

function Stat({ label, value, tone, hint }: { label: string; value: number | string; tone?: string; hint?: string }) {
  return (
    <div title={hint}>
      <div className={`text-lg font-semibold leading-tight ${tone ?? ''}`}>{value}</div>
      <div className="text-[11px] text-text-muted uppercase tracking-wide">{label}</div>
      {hint && <div className="text-[11px] text-text-muted">{hint}</div>}
    </div>
  );
}

interface Branch { id: string; name: string; address?: string }
interface Counts { total: number; vacant: number; occupied: number; reserved: number; other: number }
interface SizeStock extends Counts { size: string }
interface Inventory {
  as_of: string;
  totals: Counts & { occupancy_pct: number; branches: number };
  by_size: SizeStock[];
  pricing: Array<{ size: string; rent_incl_gst: number; deposit: number }>;
}
interface Tenant {
  tenant_id: string | null; lockerhub_application_id: string | null;
  application_no: string | null; branch_id: string | null; branch_name: string | null;
  locker_size: string | null; status: string | null; account_status: string | null; locker_no: string | null;
  tenant_name: string | null; tenant_phone: string | null; tenant_email: string | null;
  allotted_on: string | null; lease_expires_on: string | null;
  // From LockerHub's customer record — the tenant roster carries none of this.
  annual_rent?: number | string | null; deposit_amount?: number | string | null;
  lease_start?: string | null; lockers_held?: number | null; open_applications?: number | null;
  customer_id: number | null; customer_code: string | null;
  pledged_amount: number; cheque_pending: boolean; ncd_backed: boolean; unresolved: boolean;
  waiver_id: number | null; waiver_status: string | null; waiver_reason: string | null;
  linked_manually?: boolean; override_key?: string | null;
}

export function LockerTenantsPage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const [branchId, setBranchId] = useState('');
  const [q, setQ] = useState('');
  const [ncdOnly, setNcdOnly] = useState(false);
  const [waivedOnly, setWaivedOnly] = useState(false);
  const [msg, setMsg] = useState('');

  const refetchTenants = () => qc.invalidateQueries({ queryKey: ['locker-tenants'] });
  const recordWaiver = useMutation({
    mutationFn: (input: Record<string, unknown>) => api.post('/api/lockers/waivers', input),
    onSuccess: (r: any) => { setMsg(`Waiver sent for approval (${r.request_no}) — an Admin/CXO confirms it, then the row is tagged.`); refetchTenants(); },
    onError: (e) => setMsg(e instanceof ApiError ? e.message : 'Failed'),
  });
  // Link a tenant to an NCD customer by hand. LockerHub gives us no PAN to match
  // on (their profile is null for these tenants; where present the PAN is
  // masked), so an explicit human choice is the honest mechanism.
  const [linkFor, setLinkFor] = useState<Tenant | null>(null);
  const [custQ, setCustQ] = useState('');
  const custSearch = useQuery({
    queryKey: ['tenant-cust-search', custQ],
    queryFn: () => api.get<{ customers: { id: number; full_name: string; customer_code: string }[] }>(`/api/dashboard/search?q=${encodeURIComponent(custQ)}`),
    enabled: !!linkFor && custQ.trim().length >= 2,
  });
  const linkTenant = useMutation({
    mutationFn: (v: { t: Tenant; customer_id: number | null }) => api.post(`/api/lockers/tenants/${encodeURIComponent(String(v.t.override_key || v.t.tenant_id))}/link`, {
      customer_id: v.customer_id, tenant_name: v.t.tenant_name, locker_no: v.t.locker_no, branch_id: v.t.branch_id,
    }),
    onSuccess: (_r, v) => { setMsg(v.customer_id ? 'Tenant linked to the customer.' : 'Link removed.'); setLinkFor(null); setCustQ(''); refetchTenants(); },
    onError: (e) => setMsg(e instanceof ApiError ? e.message : 'Failed'),
  });
  const removeTenant = useMutation({
    mutationFn: (v: { t: Tenant; reason: string }) => api.post(`/api/lockers/tenants/${encodeURIComponent(String(v.t.override_key || v.t.tenant_id))}/remove`, {
      reason: v.reason, tenant_name: v.t.tenant_name, locker_no: v.t.locker_no, branch_id: v.t.branch_id,
    }),
    onSuccess: () => { setMsg('Removed from the NCD roster. The locker is still allotted on LockerHub — close it there too if it has actually ended.'); refetchTenants(); },
    onError: (e) => setMsg(e instanceof ApiError ? e.message : 'Failed'),
  });

  const cancelWaiver = useMutation({
    mutationFn: (id: number) => api.post(`/api/lockers/waivers/${id}/cancel`, {}),
    onSuccess: () => { setMsg('Waiver cancelled.'); refetchTenants(); },
    onError: (e) => setMsg(e instanceof ApiError ? e.message : 'Failed'),
  });

  const branches = useQuery({
    queryKey: ['locker-branches'],
    queryFn: () => api.get<{ branches: Branch[] }>('/api/lockers/branches'),
  });
  // Stock comes from LockerHub's /locker-inventory (A15), NOT /locker-availability
  // (A3): A3 is a price quote for a sale and drops sizes with zero vacancy, so
  // "Extra Large sold out" used to vanish from this panel instead of being
  // stated. A15 also answers with no branch chosen, so the network total shows.
  const stock = useQuery({
    queryKey: ['locker-inventory', branchId],
    queryFn: () => api.get<Inventory>(`/api/lockers/inventory${branchId ? `?branch_id=${encodeURIComponent(branchId)}` : ''}`),
  });
  const tenants = useQuery({
    queryKey: ['locker-tenants', branchId],
    queryFn: () => api.get<{
      rows: Tenant[]; roster_complete: boolean; lockerhub_error: string | null;
    }>(`/api/lockers/tenants${branchId ? `?branch_id=${encodeURIComponent(branchId)}` : ''}`),
  });

  const branchName = (id: string | null) =>
    (branches.data?.branches ?? []).find((b) => b.id === id)?.name ?? id ?? '—';

  const all = tenants.data?.rows ?? [];
  const rows = all.filter((r) => {
    if (ncdOnly && !r.ncd_backed) return false;
    if (waivedOnly && !r.waiver_status) return false;
    if (!q.trim()) return true;
    const hay = `${r.tenant_name ?? ''} ${r.tenant_phone ?? ''} ${r.tenant_email ?? ''} ${r.customer_code ?? ''} ${r.locker_no ?? ''} ${r.application_no ?? ''}`.toLowerCase();
    return hay.includes(q.trim().toLowerCase());
  });
  const ncdCount = all.filter((r) => r.ncd_backed).length;
  const waivedCount = all.filter((r) => r.waiver_status).length;

  return (
    <div className="w-full">
      <h1 className="text-xl font-bold tracking-tight m-0">Locker tenants</h1>
      <p className="text-sm text-text-muted mt-1 mb-4">Every locker holder, branch by branch. Pick a branch to see its occupancy and its full tenant list.</p>

      <div className="flex flex-wrap items-center gap-2 mb-4">
        <select className={inp} value={branchId} onChange={(e) => setBranchId(e.target.value)}>
          <option value="">All branches</option>
          {(branches.data?.branches ?? []).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
        <input className={`${inp} min-w-[220px]`} placeholder="Search tenant, phone, email, locker no…" value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="flex items-center gap-1.5 text-sm text-text-muted select-none">
          <input type="checkbox" checked={ncdOnly} onChange={(e) => setNcdOnly(e.target.checked)} />
          NCD-backed only ({ncdCount})
        </label>
        <label className="flex items-center gap-1.5 text-sm text-text-muted select-none">
          <input type="checkbox" checked={waivedOnly} onChange={(e) => setWaivedOnly(e.target.checked)} />
          Waived only ({waivedCount})
        </label>
        {tenants.isFetching && <span className="text-xs text-text-muted">Loading…</span>}
      </div>
      {msg && <div className="text-xs text-primary mb-3">{msg}</div>}

      {/* Stock position — live from LockerHub, zeroes included. `vacant` is what
          is actually sellable; `reserved` is a locker mid-allocation and is kept
          in its own tile on purpose — it must never be counted as available. */}
      {stock.data && (
        <div className={card}>
          <div className="flex items-baseline justify-between gap-3 flex-wrap mb-3">
            <h2 className="text-xs font-semibold text-text-label uppercase tracking-wide m-0">
              {branchId ? branchName(branchId) : 'All branches'} · stock
            </h2>
            <span className="text-[11px] text-text-muted">
              {stock.isFetching ? 'Refreshing…' : `Live from LockerHub · ${stock.data.totals.branches} branch${stock.data.totals.branches === 1 ? '' : 'es'}`}
            </span>
          </div>
          <div className="flex flex-wrap gap-x-6 gap-y-3 mb-4">
            <Stat label="Total" value={stock.data.totals.total} />
            <Stat label="Vacant" value={stock.data.totals.vacant} tone="text-success" hint="Sellable right now" />
            <Stat label="Occupied" value={stock.data.totals.occupied} />
            {stock.data.totals.reserved > 0 && (
              <Stat label="Reserved" value={stock.data.totals.reserved} hint="Mid-allocation — do not promise these" />
            )}
            {stock.data.totals.other > 0 && (
              <Stat label="Other" value={stock.data.totals.other} hint="Maintenance and any status added since" />
            )}
            <Stat label="Occupancy" value={`${stock.data.totals.occupancy_pct}%`} />
          </div>
          <div className="flex flex-wrap gap-2 text-xs">
            {stock.data.by_size.map((s) => {
              const p = stock.data!.pricing.find((x) => x.size === s.size);
              const out = s.vacant === 0;
              return (
                <span key={s.size} className={`border border-border rounded px-3 py-1.5 ${out ? 'text-text-muted bg-bg' : ''}`}>
                  <b>{s.size}</b> · {out ? <span className="text-danger">none left</span> : <>{s.vacant} of {s.total} vacant</>}
                  {s.reserved > 0 && <> · {s.reserved} reserved</>}
                  {p && <> · rent {formatINR(p.rent_incl_gst)} · deposit {formatINR(p.deposit)}</>}
                </span>
              );
            })}
          </div>
        </div>
      )}
      {stock.isError && (
        <div className={`${card} text-xs text-text-muted`}>
          Stock position unavailable — LockerHub could not be reached. The tenant list below is unaffected.
        </div>
      )}

      {linkFor && (
        <div className="fixed inset-0 bg-black/30 flex items-start justify-center pt-24 z-20" onClick={() => setLinkFor(null)}>
          <div className="bg-surface border border-border rounded-lg shadow-card p-5 w-[460px]" onClick={(e) => e.stopPropagation()}>
            <div className="text-sm font-semibold mb-1">Link “{linkFor.tenant_name}” to an NCD customer</div>
            <p className="text-xs text-text-muted mb-3">
              Automatic matching needs the phone AND the full name to agree, so a tenant recorded as
              “SEENU RAJAPPA” never matches a customer saved as “SEENU”. LockerHub gives us no PAN to
              settle it, so pick the customer yourself.
            </p>
            <input className={`${inp} w-full mb-2`} autoFocus placeholder="Search name, PAN or phone…"
              value={custQ} onChange={(e) => setCustQ(e.target.value)} />
            <div className="max-h-56 overflow-auto">
              {(custSearch.data?.customers ?? []).map((c) => (
                <button key={c.id} className="block w-full text-left px-2.5 py-1.5 text-sm hover:bg-bg rounded"
                  onClick={() => linkTenant.mutate({ t: linkFor, customer_id: c.id })}>
                  {c.full_name} <span className="text-text-muted">({c.customer_code})</span>
                </button>
              ))}
              {custQ.trim().length >= 2 && (custSearch.data?.customers ?? []).length === 0 && (
                <div className="text-xs text-text-muted px-2.5 py-2">No customer matches “{custQ}”.</div>
              )}
            </div>
            <div className="flex justify-between items-center mt-3">
              {linkFor.customer_id
                ? <button className="text-xs text-danger hover:underline" onClick={() => linkTenant.mutate({ t: linkFor, customer_id: null })}>Remove existing link</button>
                : <span />}
              <button className="text-xs border border-border rounded px-3 py-1.5" onClick={() => setLinkFor(null)}>Close</button>
            </div>
          </div>
        </div>
      )}

      <div className={card}>
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="text-xs font-semibold text-text-label uppercase tracking-wide">
            Tenants {branchId ? `· ${branchName(branchId)}` : '· all branches'} ({rows.length})
          </h2>
        </div>

        {/* Only warn when we genuinely couldn't read the roster. A successful
            read says nothing, because nothing is missing. */}
        {tenants.data && !tenants.data.roster_complete && (
          <div className="text-xs text-warn bg-[color:var(--warn-bg)] rounded px-3 py-2 mb-3">
            <b>LockerHub roster unavailable.</b> Showing only the lockers NCD is involved in — every other tenant is missing
            from this list until their API responds again.
            {tenants.data.lockerhub_error && <span className="block mt-1 opacity-80">Last LockerHub error: {tenants.data.lockerhub_error.slice(0, 160)}</span>}
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-sm border-collapse min-w-[900px]">
            <thead>
              <tr className="text-left text-xs text-text-label uppercase tracking-wide border-b border-border">
                <th className="py-2 pr-3">Tenant</th>
                <th className="py-2 pr-3">Branch</th>
                <th className="py-2 pr-3">Locker</th>
                <th className="py-2 pr-3">Size</th>
                <th className="py-2 pr-3">Status</th>
                <th className="py-2 pr-3 text-right">Rent</th>
                <th className="py-2 pr-3 text-right">Deposit</th>
                <th className="py-2 pr-3">Lease</th>
                <th className="py-2 pr-3 text-right">NCD pledged</th>
                <th className="py-2 pr-3">Locker app</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.tenant_id || r.lockerhub_application_id || r.application_no} className="border-b border-border last:border-0">
                  <td className="py-2 pr-3">
                    {r.customer_id
                      ? <Link to={`/app/customers/${r.customer_id}`} className="text-primary hover:underline">{r.tenant_name ?? '—'}</Link>
                      : (r.tenant_name ?? '—')}
                    {r.ncd_backed && <span className="ml-1.5 text-[10px] rounded px-1 py-0.5 bg-primary/10 text-primary align-middle">NCD</span>}
                    <div className="text-xs text-text-muted">
                      {r.tenant_phone ?? ''} {r.customer_code ? `· ${r.customer_code}` : ''}
                      {r.linked_manually && <span className="ml-1 text-[10px] text-text-muted" title="Linked by hand, not by automatic matching">(linked)</span>}
                      {can('lockers:waive') && (r.override_key || r.tenant_id) && (
                        <button className="ml-1.5 text-primary hover:underline"
                          onClick={() => { setLinkFor(r); setCustQ(''); }}>{r.customer_id ? 'change link' : 'link customer…'}</button>
                      )}
                    </div>
                  </td>
                  <td className="py-2 pr-3">{r.branch_name ?? branchName(r.branch_id)}</td>
                  <td className="py-2 pr-3 font-mono text-xs">{r.locker_no ?? '—'}</td>
                  <td className="py-2 pr-3">{r.locker_size ?? '—'}</td>
                  <td className="py-2 pr-3">
                    <span className="text-xs rounded px-1.5 py-0.5 bg-bg">{r.account_status ?? r.status ?? '—'}</span>
                    {r.cheque_pending && <span className="ml-1 text-xs rounded px-1.5 py-0.5 bg-[color:var(--warn-bg)] text-warn">cheque pending</span>}
                    {/* Exception/waiver cases: locker held with NO NCD backing, deliberately. */}
                    {r.waiver_status === 'Approved' && (
                      <span className="ml-1 text-xs rounded px-1.5 py-0.5 bg-[color:var(--warn-bg)] text-warn" title={r.waiver_reason ?? ''}>deposit waived</span>
                    )}
                    {r.waiver_status === 'PendingApproval' && (
                      <span className="ml-1 text-xs rounded px-1.5 py-0.5 bg-bg text-text-muted" title={r.waiver_reason ?? ''}>waiver pending</span>
                    )}
                    {can('lockers:waive') && r.waiver_id && (r.waiver_status === 'Approved' || r.waiver_status === 'PendingApproval') && (
                      <button className="ml-1 text-xs text-text-muted hover:text-danger align-middle" title="Cancel this waiver"
                        onClick={() => { if (window.confirm(`Cancel the deposit waiver for ${r.tenant_name ?? 'this tenant'}?`)) cancelWaiver.mutate(r.waiver_id!); }}>×</button>
                    )}
                    {can('lockers:waive') && r.tenant_id && !r.ncd_backed && !r.waiver_status && (
                      <button className="ml-1 text-xs text-primary hover:underline"
                        onClick={() => {
                          const reason = window.prompt(`Waive the NCD deposit requirement for ${r.tenant_name ?? 'this tenant'} (locker ${r.locker_no ?? '—'})?\n\nReason (required):`);
                          if (reason && reason.trim().length >= 3) {
                            recordWaiver.mutate({
                              lockerhub_tenant_id: r.tenant_id, reason: reason.trim(),
                              locker_no: r.locker_no, branch_id: r.branch_id,
                              tenant_name: r.tenant_name, tenant_phone: r.tenant_phone,
                              ...(r.customer_id ? { customer_id: r.customer_id } : {}),
                            });
                          } else if (reason !== null) {
                            setMsg('Waiver not sent — a reason is required.');
                          }
                        }}>waive…</button>
                    )}
                  </td>
                  <td className="py-2 pr-3 text-right mono">{r.annual_rent != null ? formatINR(r.annual_rent) : '—'}</td>
                  <td className="py-2 pr-3 text-right mono">{r.deposit_amount != null ? formatINR(r.deposit_amount) : '—'}</td>
                  <td className="py-2 pr-3 text-xs text-text-muted whitespace-nowrap">
                    {(r.lease_start ?? r.allotted_on) ? <>{r.lease_start ?? r.allotted_on}{r.lease_expires_on ? <> → {r.lease_expires_on}</> : null}</> : '—'}
                  </td>
                  <td className="py-2 pr-3 text-right mono">{r.pledged_amount > 0 ? formatINR(r.pledged_amount) : '—'}</td>
                  <td className="py-2 pr-3 font-mono text-xs text-text-muted">
                    {r.application_no ?? r.lockerhub_application_id ?? '—'}
                    {can('lockers:remove-tenant') && (r.override_key || r.tenant_id) && (
                      <button className="ml-2 text-danger hover:underline font-sans"
                        title="Remove from NCD's roster. The locker stays allotted on LockerHub."
                        onClick={() => {
                          const reason = window.prompt(`Remove ${r.tenant_name ?? 'this tenant'} (locker ${r.locker_no ?? '—'}) from the NCD roster?\n\nThis hides OUR row only — the locker remains allotted on LockerHub, which owns it. Close it there too if the tenancy has actually ended.\n\nReason (required):`);
                          if (reason && reason.trim().length >= 3) removeTenant.mutate({ t: r, reason: reason.trim() });
                          else if (reason !== null) setMsg('Not removed — a reason is required.');
                        }}>remove</button>
                    )}
                  </td>
                </tr>
              ))}
              {!rows.length && (
                <tr><td colSpan={8} className="py-6 text-center text-text-muted">
                  {tenants.isLoading ? 'Loading…' : ncdOnly ? 'No NCD-backed lockers match.' : branchId ? 'No tenants at this branch yet.' : 'No locker tenants found.'}
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
