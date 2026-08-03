import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { formatINR } from '@new-wealth/shared';
import { api } from '../api/client.js';
import { DataTable, type Column } from '../components/DataTable.js';
import { Tabs, type TabDef } from '../components/Tabs.js';

/**
 * Whose locker rent is due (owner 2026-08-03: "there is no way at all to renew
 * a locker"). A locker is an annual-rent product; the expiry dates were already
 * coming down in the tenant roster, but sorted by branch they answered "who
 * lives where", never "who do I chase this week".
 *
 * Overdue first, because the top of this list is a locker being used without
 * being paid for.
 */
interface Row {
  tenant_id: string | null;
  lockerhub_application_id: string | null;
  locker_no: string | null;
  locker_size: string | null;
  branch_name: string | null;
  tenant_name: string | null;
  tenant_phone: string | null;
  customer_id: number | null;
  customer_code: string | null;
  lease_start: string | null;
  lease_expires_on: string | null;
  days_to_expiry: number | null;
  annual_rent: number | null;
  deposit_amount: number | null;
  pledged_amount: number;
  ncd_backed: boolean;
  state: 'expired' | 'due' | 'upcoming' | 'unknown';
}

const STATE: Record<Row['state'], { label: string; pill: string }> = {
  expired: { label: 'Expired', pill: 'bg-[color:var(--danger-bg)] text-danger' },
  due: { label: 'Due now', pill: 'bg-[color:var(--warn-bg)] text-warn' },
  upcoming: { label: 'Coming up', pill: 'bg-bg text-text-muted' },
  // Not a rounding case: LockerHub holds no expiry date for this tenancy at
  // all, so nobody can know when it lapses. Shown, never hidden.
  unknown: { label: 'No expiry on record', pill: 'bg-[color:var(--warn-bg)] text-warn' },
};

/** "12 days" / "overdue 9 days" — the number staff actually act on. */
function When({ days }: { days: number | null }) {
  if (days == null) return <span className="text-warn">unknown</span>;
  if (days < 0) return <span className="text-danger font-semibold">overdue {Math.abs(days)}d</span>;
  if (days === 0) return <span className="text-danger font-semibold">today</span>;
  return <span className={days <= 14 ? 'text-warn' : 'text-text-muted'}>{days}d</span>;
}

type Tab = 'all' | Row['state'];

export function LockerRenewalsPage() {
  const [tab, setTab] = useState<Tab>('all');
  const [days, setDays] = useState(60);
  const { data, isLoading, error } = useQuery({
    queryKey: ['locker-renewals', days],
    queryFn: () => api.get<{ rows: Row[]; lockerhub_error: string | null; window_days: number }>(
      `/api/lockers/renewals?days=${days}`),
    retry: false,
  });
  const rows = data?.rows ?? [];
  const shown = tab === 'all' ? rows : rows.filter((r) => r.state === tab);

  const tabs: TabDef<Tab>[] = [
    { key: 'all', label: 'All', count: rows.length },
    ...(['expired', 'due', 'upcoming', 'unknown'] as Row['state'][])
      .map((s) => ({ key: s as Tab, label: STATE[s].label, count: rows.filter((r) => r.state === s).length }))
      .filter((t) => t.count > 0),
  ];

  // Overdue rent is the number worth putting in front of someone: it is money
  // already owed, not money that will be owed.
  const overdue = rows.filter((r) => r.state === 'expired');
  const overdueRent = overdue.reduce((s, r) => s + Number(r.annual_rent ?? 0), 0);

  const columns: Column<Row>[] = [
    { key: 'state', header: 'Status', value: (r) => STATE[r.state].label,
      render: (r) => <span className={`text-xs rounded px-1.5 py-0.5 whitespace-nowrap ${STATE[r.state].pill}`}>{STATE[r.state].label}</span> },
    { key: 'days_to_expiry', header: 'Expiry', align: 'right',
      // Nulls sort last, matching the server: an unknown expiry is a gap to
      // close, not the most urgent thing on the page.
      value: (r) => r.days_to_expiry ?? 99999, render: (r) => <When days={r.days_to_expiry} /> },
    { key: 'lease_expires_on', header: 'Lease ends', value: (r) => r.lease_expires_on ?? '',
      render: (r) => r.lease_expires_on ?? <span className="text-text-muted">—</span> },
    { key: 'tenant_name', header: 'Tenant', value: (r) => r.tenant_name ?? '',
      render: (r) => (r.customer_id
        ? <Link to={`/app/customers/${r.customer_id}`} className="text-primary hover:underline">{r.tenant_name}</Link>
        // Not one of our customers, or the name did not agree well enough to be
        // sure it is the same person. Either way, do not fake a link.
        : <span>{r.tenant_name ?? '—'}</span>) },
    { key: 'tenant_phone', header: 'Phone', tdClassName: 'font-mono text-xs' },
    { key: 'locker_no', header: 'Locker', value: (r) => r.locker_no ?? '',
      // Links into the application so the tenancy can actually be worked on —
      // payments, allotment, the e-Sign agreement. Without it this list can
      // only tell you a problem exists.
      render: (r) => <span className="whitespace-nowrap">
        {r.lockerhub_application_id
          ? <Link to={`/app/locker-enrollment?application_id=${encodeURIComponent(r.lockerhub_application_id)}`}
              className="text-primary hover:underline" title="Open this locker application">{r.locker_no ?? 'Open'}</Link>
          : (r.locker_no ?? '—')}
        {r.locker_size ? <span className="text-text-muted text-xs"> · {r.locker_size}</span> : null}
      </span> },
    { key: 'branch_name', header: 'Branch', value: (r) => r.branch_name ?? '' },
    { key: 'annual_rent', header: 'Annual rent', align: 'right',
      value: (r) => Number(r.annual_rent ?? 0),
      render: (r) => r.annual_rent != null ? <span className="mono">{formatINR(r.annual_rent)}</span> : <span className="text-text-muted">—</span> },
    { key: 'ncd_backed', header: 'Deposit', sortable: false,
      render: (r) => (r.pledged_amount > 0
        ? <span className="text-xs" title="An NCD investment is pledged against this locker's deposit">NCD {formatINR(r.pledged_amount)}</span>
        : <span className="text-text-muted text-xs">—</span>) },
  ];

  return (
    <div className="w-full">
      <h1 className="text-xl font-bold tracking-tight m-0">Locker renewals</h1>
      <p className="text-sm text-text-muted mt-1 mb-3">
        Leases ending, most overdue first. Collect the renewal in LockerHub — they hold the rent cycle, and NCD has no way to take a second year’s rent yet.
      </p>

      {data?.lockerhub_error && (
        <div className="text-xs text-warn bg-[color:var(--warn-bg)] rounded px-3 py-2 mb-3">
          Couldn’t reach LockerHub — this list may be incomplete. ({String(data.lockerhub_error).slice(0, 120)})
        </div>
      )}

      {overdue.length > 0 && (
        <div className="text-sm bg-[color:var(--danger-bg)] text-danger rounded px-3 py-2 mb-3">
          <b>{overdue.length}</b> locker{overdue.length === 1 ? '' : 's'} past their lease end
          {overdueRent > 0 && <> — <b>{formatINR(overdueRent)}</b> of annual rent uncollected</>}.
        </div>
      )}

      <div className="flex items-center gap-2 mb-3 text-xs">
        <span className="text-text-label uppercase tracking-wide font-semibold">Looking ahead</span>
        {[30, 60, 90, 180].map((d) => (
          <button key={d} onClick={() => setDays(d)}
            className={`rounded px-2 py-1 border ${days === d ? 'border-primary text-primary font-semibold' : 'border-border text-text-muted hover:bg-bg'}`}>
            {d} days
          </button>
        ))}
        <span className="text-text-muted">Expired leases always show, however far back.</span>
      </div>

      {error ? <div className="text-danger">Couldn’t load locker renewals.</div>
        : isLoading ? <div className="text-text-muted">Loading…</div>
        : rows.length === 0 ? (
          <div className="bg-surface border border-border rounded-lg shadow-card p-8 text-center">
            <div className="text-sm font-medium">Nothing due.</div>
            <div className="text-xs text-text-muted mt-1">No locker lease has expired or ends within {days} days.</div>
          </div>
        ) : (
          <>
            <Tabs tabs={tabs} active={tab} onChange={setTab} />
            {/* Keyed on tenancy, falling back to locker+branch: a tenancy NCD
                contributed has no tenant_id until LockerHub allots it. */}
            <DataTable columns={columns} rows={shown}
              rowKey={(r) => r.tenant_id || `${r.branch_name ?? ''}:${r.locker_no ?? ''}:${r.tenant_phone ?? ''}`}
              defaultSort={{ key: 'days_to_expiry', dir: 'asc' }} empty="Nothing in this category." />
          </>
        )}
    </div>
  );
}
