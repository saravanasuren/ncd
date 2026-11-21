import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { formatINR, RENT_STATUS_LABEL, type RentStatus } from '@new-wealth/shared';
import { api } from '../api/client.js';
import { RentStatusBadge } from '../components/RentStatusBadge.js';

/**
 * Locker Master Report (owner 2026-11-21) — the whole locker book on one page,
 * the way the NCD book is for investments.
 *
 * One row per PHYSICAL locker, vacant ones included, which is what makes it a
 * master rather than a second rent report: Locker Tenants and the Rent Report
 * only list lockers somebody holds, so neither can tell you what is free.
 *
 * Nothing is decided here. Rent comes from the same server call the Rent Report
 * uses, so the two pages cannot disagree.
 */

interface Row {
  branch: string | null; locker_no: string | null; size: string | null;
  occupancy: 'Occupied' | 'Vacant';
  lockerhub_application_id: string | null; application_no: string | null;
  customer_name: string | null; customer_code: string | null; phone: string | null;
  joint_hirers: string | null; authorised_users: string | null;
  allotted_on: string | null; backdated: boolean;
  agreement_no: string | null; agreement_status: string | null;
  agreement_method: string | null; signed_on: string | null;
  rent_amount: number | null; rent_status: RentStatus | null;
  deposit_amount: number | null; deposit_ncd_app_no: string | null;
}
interface BranchSummary {
  branch: string; total: number; occupied: number; vacant: number;
  /** null when the vacant side could not be read — shown as a dash, not 100%. */
  occupancy_pct: number | null;
}
interface Report {
  rows: Row[];
  branches: BranchSummary[];
  totals: {
    lockers: number; occupied: number; vacant: number; occupancy_pct: number | null;
    agreement_signed: number; agreement_missing: number;
    rent_unpaid: number; deposit_linked: number;
  };
  lockerhub_error: string | null;
  vacant_unavailable: boolean;
  generated_at: string;
}

type View = 'all' | 'occupied' | 'vacant' | 'unsigned' | 'unpaid';

const fmtDate = (v: string | null) => {
  if (!v) return '—';
  const d = new Date(`${v.slice(0, 10)}T00:00:00Z`);
  if (isNaN(d.getTime())) return v;
  return `${String(d.getUTCDate()).padStart(2, '0')}-${d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })}-${d.getUTCFullYear()}`;
};
const dash = (v: string | null) => (v && v.trim() ? v : '—');

export function LockerMasterReportPage() {
  const rep = useQuery({ queryKey: ['locker-master-report'], queryFn: () => api.get<Report>('/api/lockers/master-report') });
  const [view, setView] = useState<View>('all');
  const [branch, setBranch] = useState('');
  const [q, setQ] = useState('');

  const th = 'py-2 px-3 text-xs font-semibold text-text-label uppercase tracking-wide text-left whitespace-nowrap';
  const td = 'py-2 px-3 align-middle';

  const rows = useMemo(() => {
    const all = rep.data?.rows ?? [];
    const needle = q.trim().toLowerCase();
    return all.filter((r) => {
      if (branch && r.branch !== branch) return false;
      if (view === 'occupied' && r.occupancy !== 'Occupied') return false;
      if (view === 'vacant' && r.occupancy !== 'Vacant') return false;
      if (view === 'unsigned' && !(r.occupancy === 'Occupied' && r.agreement_status !== 'Signed')) return false;
      if (view === 'unpaid' && r.rent_status !== 'unpaid') return false;
      if (!needle) return true;
      return [r.locker_no, r.customer_name, r.customer_code, r.phone, r.branch, r.size, r.agreement_no]
        .some((v) => String(v ?? '').toLowerCase().includes(needle));
    });
  }, [rep.data, view, branch, q]);

  const t = rep.data?.totals;

  return (
    <div>
      <div className="flex items-start justify-between gap-3 flex-wrap mb-1">
        <h1 className="text-lg font-semibold">Locker master report</h1>
        <a href="/api/lockers/master-report.xlsx"
          className="text-sm px-3 py-2 rounded-md border border-border hover:bg-bg whitespace-nowrap">
          ⬇ Download Excel
        </a>
      </div>
      <p className="text-sm text-text-muted mb-4 max-w-3xl">
        Every locker in every branch — who holds it, when it was allotted, whether the agreement is
        signed, and where the rent and deposit stand. Empty lockers are listed too, so this is also
        the stock position.
      </p>

      {rep.isLoading && <div className="text-sm text-text-muted">Loading…</div>}
      {rep.error && <div className="text-sm text-danger">Failed to load the report.</div>}

      {rep.data?.lockerhub_error && (
        <div className="text-xs text-warn bg-[color:var(--warn-bg)] rounded px-3 py-2 mb-3">
          Some lockers couldn’t be read from LockerHub — their rent shows as Unknown until it can be checked.
        </div>
      )}
      {rep.data?.vacant_unavailable && (
        <div className="text-xs text-warn bg-[color:var(--warn-bg)] rounded px-3 py-2 mb-3">
          Vacant lockers couldn’t be read from LockerHub, so the vacant and occupancy figures are
          incomplete. Everything about occupied lockers is unaffected.
        </div>
      )}

      {rep.data && t && (
        <>
          <div className="flex flex-wrap gap-5 mb-4">
            <Stat label="Lockers" value={String(t.lockers)} />
            <Stat label="Occupied" value={`${t.occupied}`}
              sub={t.occupancy_pct == null ? undefined : `${t.occupancy_pct}%`} />
            <Stat label="Vacant" value={String(t.vacant)} tone={t.vacant ? 'good' : undefined} />
            <Stat label="Agreement signed" value={`${t.agreement_signed}`} sub={`of ${t.occupied}`} />
            <Stat label="Not signed" value={String(t.agreement_missing)} tone={t.agreement_missing ? 'bad' : undefined} />
            <Stat label="Rent unpaid" value={String(t.rent_unpaid)} tone={t.rent_unpaid ? 'bad' : undefined} />
            <Stat label="Deposit linked" value={formatINR(t.deposit_linked)} />
          </div>

          {/* Branch stock — the question the other locker pages cannot answer. */}
          {rep.data.branches.length > 1 && (
            <div className="overflow-x-auto rounded-lg border border-border mb-4">
              <table className="w-full text-sm">
                <thead className="bg-bg">
                  <tr>
                    <th className={th}>Branch</th><th className={th}>Lockers</th>
                    <th className={th}>Occupied</th><th className={th}>Vacant</th><th className={th}>Occupancy</th>
                  </tr>
                </thead>
                <tbody>
                  {rep.data.branches.map((b) => (
                    <tr key={b.branch} className="border-t border-border">
                      <td className={td}>
                        <button className="text-primary hover:underline"
                          onClick={() => setBranch(branch === b.branch ? '' : b.branch)}>
                          {b.branch}
                        </button>
                      </td>
                      <td className={td}>{b.total}</td>
                      <td className={td}>{b.occupied}</td>
                      <td className={td}>{b.vacant}</td>
                      <td className={td}>{b.occupancy_pct == null ? '—' : `${b.occupancy_pct}%`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2 mb-3">
            {([
              ['all', `All (${t.lockers})`],
              ['occupied', `Occupied (${t.occupied})`],
              ['vacant', `Vacant (${t.vacant})`],
              ['unsigned', `No agreement (${t.agreement_missing})`],
              ['unpaid', `Rent unpaid (${t.rent_unpaid})`],
            ] as [View, string][]).map(([k, label]) => (
              <button key={k} onClick={() => setView(k)}
                className={`text-xs rounded-full px-3 py-1 border ${view === k ? 'border-primary text-primary' : 'border-border text-text-muted'}`}>
                {label}
              </button>
            ))}
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search locker / name / code"
              className="text-sm border border-border rounded-md px-3 py-1.5 ml-auto min-w-[220px]" />
            {branch && (
              <button onClick={() => setBranch('')} className="text-xs text-primary hover:underline">
                Clear {branch}
              </button>
            )}
          </div>

          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead className="bg-bg">
                <tr>
                  <th className={th}>Branch</th>
                  <th className={th}>Locker</th>
                  <th className={th}>Size</th>
                  <th className={th}>Status</th>
                  <th className={th}>Hirer</th>
                  <th className={th}>Allotted</th>
                  <th className={th}>Agreement</th>
                  <th className={th}>Rent</th>
                  <th className={th}>Deposit</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={`${r.branch}-${r.locker_no}-${i}`} className="border-t border-border">
                    <td className={td}>{dash(r.branch)}</td>
                    <td className={`${td} font-medium`}>{dash(r.locker_no)}</td>
                    <td className={td}>{dash(r.size)}</td>
                    <td className={td}>
                      <span className={`text-xs rounded-full px-2 py-0.5 ${r.occupancy === 'Occupied'
                        ? 'bg-bg text-text-muted' : 'bg-[color:var(--success-bg)] text-success'}`}>
                        {r.occupancy}
                      </span>
                    </td>
                    <td className={td}>
                      {r.occupancy === 'Vacant' ? <span className="text-text-muted">—</span> : (
                        <>
                          <div>{dash(r.customer_name)}</div>
                          <div className="text-xs text-text-muted">
                            {[r.customer_code, r.phone].filter(Boolean).join(' · ') || '—'}
                          </div>
                          {r.joint_hirers && <div className="text-xs text-text-muted">+ {r.joint_hirers}</div>}
                        </>
                      )}
                    </td>
                    <td className={td}>
                      {fmtDate(r.allotted_on)}
                      {r.backdated && <span className="text-xs text-warn block">backdated</span>}
                    </td>
                    <td className={td}>
                      {r.occupancy === 'Vacant' ? <span className="text-text-muted">—</span>
                        : r.agreement_status === 'Signed'
                          ? <span className="text-success">Signed{r.signed_on ? ` · ${fmtDate(r.signed_on)}` : ''}</span>
                          : <span className="text-danger">{dash(r.agreement_status)}</span>}
                    </td>
                    <td className={td}>
                      {r.rent_amount != null && <div>{formatINR(r.rent_amount)}</div>}
                      {r.rent_status
                        ? <RentStatusBadge status={r.rent_status} />
                        : <span className="text-text-muted">—</span>}
                    </td>
                    <td className={td}>
                      {r.deposit_amount != null ? (
                        <>
                          <div>{formatINR(r.deposit_amount)}</div>
                          {r.deposit_ncd_app_no && <div className="text-xs text-text-muted">{r.deposit_ncd_app_no}</div>}
                        </>
                      ) : <span className="text-text-muted">—</span>}
                    </td>
                  </tr>
                ))}
                {!rows.length && (
                  <tr><td colSpan={9} className="py-6 text-center text-text-muted">Nothing in this view.</td></tr>
                )}
              </tbody>
            </table>
          </div>

          <p className="text-xs text-text-muted mt-3">
            Showing {rows.length} of {t.lockers}. Rent is decided by the same rule the rent report
            and Locker Tenants use, so the three cannot disagree.
            {' '}Statuses: {Object.values(RENT_STATUS_LABEL).join(' · ')}.
          </p>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'good' | 'bad' }) {
  const color = tone === 'good' ? 'text-success' : tone === 'bad' ? 'text-danger' : '';
  return (
    <div>
      <div className="text-xs text-text-muted">{label}</div>
      <div className={`text-lg font-semibold ${color}`}>
        {value}{sub && <span className="text-xs font-normal text-text-muted ml-1">{sub}</span>}
      </div>
    </div>
  );
}
