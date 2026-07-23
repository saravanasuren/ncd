import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { formatINR } from '@new-wealth/shared';
import { api } from '../api/client.js';

/**
 * Locker tenants, branch-wise.
 *
 * Honest about its source: LockerHub's per-branch locker roster (/lockers) is
 * erroring on their side, so this lists the lockers NCD is involved in (a
 * deposit pledge or a cheque), resolved against LockerHub for branch, tenant,
 * status and locker number. Occupancy per size comes from their availability
 * endpoint, which does work.
 */
const card = 'bg-surface border border-border rounded-lg shadow-card p-5 mb-4';
const inp = 'px-2.5 py-1.5 text-sm border border-border-strong rounded outline-none focus:border-primary';

interface Branch { id: string; name: string; address?: string }
interface Size { size: string; rent_incl_gst: number; deposit: number; vacant_count: number }
interface Tenant {
  lockerhub_application_id: string; application_no: string | null; branch_id: string | null;
  locker_size: string | null; status: string | null; locker_no: string | null;
  tenant_name: string | null; tenant_phone: string | null;
  customer_id: number | null; customer_code: string | null;
  pledged_amount: number; cheque_pending: boolean; unresolved: boolean;
}

export function LockerTenantsPage() {
  const [branchId, setBranchId] = useState('');
  const [q, setQ] = useState('');

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
    queryFn: () => api.get<{ rows: Tenant[]; roster_complete: boolean; lockerhub_error: string | null }>(
      `/api/lockers/tenants${branchId ? `?branch_id=${encodeURIComponent(branchId)}` : ''}`),
  });

  const branchName = (id: string | null) =>
    (branches.data?.branches ?? []).find((b) => b.id === id)?.name ?? id ?? '—';

  const rows = (tenants.data?.rows ?? []).filter((r) => {
    if (!q.trim()) return true;
    const hay = `${r.tenant_name ?? ''} ${r.tenant_phone ?? ''} ${r.customer_code ?? ''} ${r.locker_no ?? ''} ${r.application_no ?? ''}`.toLowerCase();
    return hay.includes(q.trim().toLowerCase());
  });

  return (
    <div className="w-full">
      <h1 className="text-xl font-bold tracking-tight m-0">Locker tenants</h1>
      <p className="text-sm text-text-muted mt-1 mb-4">Who holds a locker, branch by branch. Pick a branch to see its occupancy and the tenants NCD is involved with.</p>

      <div className="flex flex-wrap items-center gap-2 mb-4">
        <select className={inp} value={branchId} onChange={(e) => setBranchId(e.target.value)}>
          <option value="">All branches</option>
          {(branches.data?.branches ?? []).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
        <input className={`${inp} min-w-[220px]`} placeholder="Search tenant, phone, locker no…" value={q} onChange={(e) => setQ(e.target.value)} />
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

        {/* Never imply this is the full branch roster while their endpoint is down. */}
        {tenants.data && !tenants.data.roster_complete && (
          <div className="text-xs text-warn bg-[color:var(--warn-bg)] rounded px-3 py-2 mb-3">
            Showing lockers NCD is involved in (an NCD-backed deposit or a recorded cheque). LockerHub's full per-branch
            locker list is unavailable — their <span className="font-mono">/lockers</span> endpoint is returning an error,
            so lockers paid entirely online with no NCD involvement won't appear here yet.
            {tenants.data.lockerhub_error && <span className="block mt-1 opacity-80">Last error: {tenants.data.lockerhub_error.slice(0, 120)}</span>}
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
                <th className="py-2 pr-3 text-right">NCD pledged</th>
                <th className="py-2 pr-3">Locker app</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.lockerhub_application_id} className="border-b border-border last:border-0">
                  <td className="py-2 pr-3">
                    {r.customer_id
                      ? <Link to={`/app/customers/${r.customer_id}`} className="text-primary hover:underline">{r.tenant_name ?? '—'}</Link>
                      : (r.tenant_name ?? '—')}
                    <div className="text-xs text-text-muted">{r.tenant_phone ?? ''} {r.customer_code ? `· ${r.customer_code}` : ''}</div>
                  </td>
                  <td className="py-2 pr-3">{branchName(r.branch_id)}</td>
                  <td className="py-2 pr-3 font-mono text-xs">{r.locker_no ?? '—'}</td>
                  <td className="py-2 pr-3">{r.locker_size ?? '—'}</td>
                  <td className="py-2 pr-3">
                    <span className="text-xs rounded px-1.5 py-0.5 bg-bg">{r.status ?? (r.unresolved ? 'unresolved' : '—')}</span>
                    {r.cheque_pending && <span className="ml-1 text-xs rounded px-1.5 py-0.5 bg-[color:var(--warn-bg)] text-warn">cheque pending</span>}
                  </td>
                  <td className="py-2 pr-3 text-right mono">{r.pledged_amount > 0 ? formatINR(r.pledged_amount) : '—'}</td>
                  <td className="py-2 pr-3 font-mono text-xs text-text-muted">{r.application_no ?? r.lockerhub_application_id}</td>
                </tr>
              ))}
              {!rows.length && (
                <tr><td colSpan={7} className="py-6 text-center text-text-muted">
                  {tenants.isLoading ? 'Loading…' : branchId ? 'No tenants NCD is involved with at this branch.' : 'No locker tenants recorded yet.'}
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
