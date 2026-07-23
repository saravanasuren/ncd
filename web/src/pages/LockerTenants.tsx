import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { formatINR } from '@new-wealth/shared';
import { api } from '../api/client.js';

/**
 * Locker tenants, branch-wise — every tenant, not only the ones NCD backs. The
 * roster is one call to LockerHub's /locker-tenants (all branches, or scoped to
 * one); NCD's own pledges and cheques are layered on top, and lockers of ours
 * not allotted yet are appended. Availability per size comes from their
 * availability endpoint.
 *
 * Status shown is `account_status` (Active | Closure Requested) — the locker's
 * own status is always "occupied" here, since their query filters on it, and a
 * closed tenancy leaves the roster entirely rather than changing status.
 */
const card = 'bg-surface border border-border rounded-lg shadow-card p-5 mb-4';
const inp = 'px-2.5 py-1.5 text-sm border border-border-strong rounded outline-none focus:border-primary';

interface Branch { id: string; name: string; address?: string }
interface Size { size: string; rent_incl_gst: number; deposit: number; vacant_count: number }
interface Tenant {
  tenant_id: string | null; lockerhub_application_id: string | null;
  application_no: string | null; branch_id: string | null; branch_name: string | null;
  locker_size: string | null; status: string | null; account_status: string | null; locker_no: string | null;
  tenant_name: string | null; tenant_phone: string | null; tenant_email: string | null;
  allotted_on: string | null; lease_expires_on: string | null;
  customer_id: number | null; customer_code: string | null;
  pledged_amount: number; cheque_pending: boolean; ncd_backed: boolean; unresolved: boolean;
}

export function LockerTenantsPage() {
  const [branchId, setBranchId] = useState('');
  const [q, setQ] = useState('');
  const [ncdOnly, setNcdOnly] = useState(false);

  const branches = useQuery({
    queryKey: ['locker-branches'],
    queryFn: () => api.get<{ branches: Branch[] }>('/api/lockers/branches'),
  });
  const avail = useQuery({
    queryKey: ['locker-availability', branchId],
    queryFn: () => api.get<{ sizes: Size[] }>(`/api/lockers/availability?branch_id=${encodeURIComponent(branchId)}`),
    enabled: !!branchId,
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
    if (!q.trim()) return true;
    const hay = `${r.tenant_name ?? ''} ${r.tenant_phone ?? ''} ${r.tenant_email ?? ''} ${r.customer_code ?? ''} ${r.locker_no ?? ''} ${r.application_no ?? ''}`.toLowerCase();
    return hay.includes(q.trim().toLowerCase());
  });
  const ncdCount = all.filter((r) => r.ncd_backed).length;

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
        {tenants.isFetching && <span className="text-xs text-text-muted">Loading…</span>}
      </div>

      {/* Occupancy for the chosen branch — this comes from LockerHub and is live. */}
      {branchId && (avail.data?.sizes ?? []).length > 0 && (
        <div className={card}>
          <h2 className="text-xs font-semibold text-text-label uppercase tracking-wide mb-3">{branchName(branchId)} · availability</h2>
          <div className="flex flex-wrap gap-2 text-xs">
            {(avail.data?.sizes ?? []).map((s) => (
              <span key={s.size} className="border border-border rounded px-3 py-1.5">
                <b>{s.size}</b> · {s.vacant_count} vacant · rent {formatINR(s.rent_incl_gst)} · deposit {formatINR(s.deposit)}
              </span>
            ))}
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
                    <div className="text-xs text-text-muted">{r.tenant_phone ?? ''} {r.customer_code ? `· ${r.customer_code}` : ''}</div>
                  </td>
                  <td className="py-2 pr-3">{r.branch_name ?? branchName(r.branch_id)}</td>
                  <td className="py-2 pr-3 font-mono text-xs">{r.locker_no ?? '—'}</td>
                  <td className="py-2 pr-3">{r.locker_size ?? '—'}</td>
                  <td className="py-2 pr-3">
                    <span className="text-xs rounded px-1.5 py-0.5 bg-bg">{r.account_status ?? r.status ?? '—'}</span>
                    {r.cheque_pending && <span className="ml-1 text-xs rounded px-1.5 py-0.5 bg-[color:var(--warn-bg)] text-warn">cheque pending</span>}
                  </td>
                  <td className="py-2 pr-3 text-xs text-text-muted whitespace-nowrap">
                    {r.allotted_on ? <>{r.allotted_on}{r.lease_expires_on ? <> → {r.lease_expires_on}</> : null}</> : '—'}
                  </td>
                  <td className="py-2 pr-3 text-right mono">{r.pledged_amount > 0 ? formatINR(r.pledged_amount) : '—'}</td>
                  <td className="py-2 pr-3 font-mono text-xs text-text-muted">{r.application_no ?? r.lockerhub_application_id ?? '—'}</td>
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
