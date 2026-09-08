/**
 * Locker Applications — the list that did not exist (owner 2026-09-08:
 * "i want the lockers to work just like how ncd is working. when i create a
 * locker application it should get created and if i delete it should get
 * deleted").
 *
 * Deleting already worked. FINDING an application did not: LockerHub publishes
 * no list endpoint and NCD kept no index, so once the enrolment tab was closed
 * the application was gone — 45 of them were live and unreachable. This page is
 * the way back in, and it is deliberately shaped like the NCD Applications
 * screen: same DataTable, same tabs, same pills, click the row to open it.
 *
 * `status` is what LockerHub last told us, not live truth — they own the
 * application. The Refresh action re-asks for the visible rows; opening one
 * refreshes it as a side effect.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../api/client.js';
import { useAuth } from '../auth/AuthContext.js';
import { useConfirm } from '../components/Confirm.js';
import { DataTable, type Column } from '../components/DataTable.js';
import { Tabs, type TabDef } from '../components/Tabs.js';

interface Row {
  lockerhub_application_id: string;
  application_no: string | null;
  customer_id: number | null;
  customer_name: string | null;
  phone: string | null;
  branch_id: string | null;
  branch_name: string | null;
  locker_size: string | null;
  locker_number: string | null;
  status: string | null;
  status_checked_at: string | null;
  created_at: string;
  created_by_name: string | null;
  removed_at: string | null;
  removed_reason: string | null;
}
interface Resp {
  rows: Row[];
  scope: { restricted: boolean; branches: Array<{ id: string; name: string }> };
}

const fmtDate = (s: string | null) =>
  !s ? '—' : new Date(s).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });

/** LockerHub's own status words, shown as they say them. An unknown one is
 *  displayed verbatim rather than mapped to a guess — a wrong label on a status
 *  screen is worse than an unfamiliar one. */
const pill: Record<string, string> = {
  approved: 'bg-[color:var(--success-bg)] text-success',
  allotted: 'bg-[color:var(--success-bg)] text-success',
  active: 'bg-[color:var(--success-bg)] text-success',
  pending: 'bg-[color:var(--warn-bg)] text-warn',
  created: 'bg-[color:var(--warn-bg)] text-warn',
  cancelled: 'bg-bg text-text-muted',
};

type Tab = 'live' | 'removed' | 'all';

export function LockerApplicationsPage() {
  const [tab, setTab] = useState<Tab>('live');
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');
  const { confirm, promptText } = useConfirm();
  const { user } = useAuth();
  const nav = useNavigate();

  const list = useQuery({
    queryKey: ['locker-applications', tab, q],
    queryFn: () => api.get<Resp>(
      `/api/lockers/applications?show=${tab}${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ''}`),
  });

  const open = (r: Row) => nav(`/app/locker-enrollment?id=${encodeURIComponent(r.lockerhub_application_id)}`);

  /** Same three-outcome delete the enrolment screen has: cancel on LockerHub
   *  where they allow it, and a Super-Admin-only NCD-view removal where they
   *  refuse (money collected / live tenancy). Wording is the enrolment page's,
   *  deliberately — two screens describing the same act differently is how
   *  staff end up believing the record is gone when it is not. */
  const remove = async (r: Row) => {
    const who = r.customer_name ?? r.lockerhub_application_id;
    const ok = await confirm({
      title: `Delete the locker application for ${who}?`,
      body: 'Cancels it on LockerHub too and releases any locker it was holding, so a fresh enrolment starts clean. Refused if money has already been collected, or if it is already a live tenancy.',
      confirmLabel: 'Delete', danger: true,
    });
    if (!ok) return;
    const reason = await promptText({
      title: 'Why is it being deleted?', body: 'Recorded on the audit trail.',
      label: 'Reason', minLength: 3, confirmLabel: 'Delete', danger: true,
    });
    if (!reason) return;

    const send = (forceLocal: boolean) => api.post<any>(
      `/api/lockers/applications/${encodeURIComponent(r.lockerhub_application_id)}/remove`,
      {
        reason,
        ...(forceLocal ? { force_local: true } : {}),
        tenant_name: r.customer_name ?? undefined,
        locker_no: r.locker_number ?? undefined,
        branch_id: r.branch_id ?? undefined,
      });
    const done = (res: any) => {
      setErr('');
      setNote(res?.lockerhub_kept
        ? 'Removed from NCD’s view. LockerHub STILL holds this application — any money collected on it must be settled with LockerHub separately.'
        : res?.locker_released
          ? `Cancelled on LockerHub — locker ${res.locker_released} released back to vacant.`
          : 'Cancelled on LockerHub. This customer can be enrolled again from scratch.');
      void list.refetch();
    };

    setBusy(true); setErr(''); setNote('');
    try {
      done(await send(false));
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && user?.role === 'super_admin') {
        setBusy(false);
        const force = await confirm({
          title: 'LockerHub won’t cancel this application',
          body: `${e.message}\n\nAs Super Admin you can remove it from NCD’s view only. LockerHub will KEEP the record, and any money collected on it must be settled with LockerHub separately. Continue?`,
          confirmLabel: 'Remove from NCD only', danger: true,
        });
        if (!force) return;
        setBusy(true);
        try { done(await send(true)); }
        catch (e2) { setErr(e2 instanceof ApiError ? e2.message : 'Failed'); }
        finally { setBusy(false); }
        return;
      }
      setErr(e instanceof ApiError ? e.message : 'Failed to delete');
    } finally { setBusy(false); }
  };

  /** Re-ask LockerHub about everything on screen. One call per row, so it is a
   *  button rather than something the page does on every load — 45 upstream
   *  calls to render a table would be rude to them and slow for us. */
  const refreshAll = async () => {
    const rows = list.data?.rows ?? [];
    if (!rows.length) return;
    setBusy(true); setErr(''); setNote('');
    let failed = 0;
    for (const r of rows) {
      try {
        const res = await api.post<{ ok: boolean }>(
          `/api/lockers/applications/${encodeURIComponent(r.lockerhub_application_id)}/refresh`, {});
        if (!res?.ok) failed++;
      } catch { failed++; }
    }
    setBusy(false);
    setNote(failed
      ? `Refreshed ${rows.length - failed} of ${rows.length}. ${failed} could not be read from LockerHub — those may have been cancelled on their side.`
      : `Refreshed all ${rows.length}.`);
    void list.refetch();
  };

  const columns: Column<Row>[] = [
    {
      // LockerHub's own reference. Their internal id (mts88mk6d0a6l7h) is what
      // the API needs; this is what a person recognises, so it leads.
      key: 'application_no', header: 'App No.', tdClassName: 'font-mono text-xs',
      value: (r) => r.application_no ?? '',
      render: (r) => (
        <button className="text-primary hover:underline" onClick={() => open(r)}>
          {r.application_no ?? <span className="text-text-muted">—</span>}
        </button>
      ),
    },
    {
      key: 'customer_name', header: 'Customer',
      value: (r) => r.customer_name ?? '',
      render: (r) => (
        <button className="text-primary hover:underline text-left" onClick={() => open(r)}>
          {r.customer_name ?? <span className="text-text-muted italic">not yet linked</span>}
        </button>
      ),
    },
    { key: 'phone', header: 'Phone', tdClassName: 'mono text-xs', render: (r) => r.phone ?? '—' },
    { key: 'branch_name', header: 'Branch', render: (r) => r.branch_name ?? '—' },
    { key: 'locker_size', header: 'Size', render: (r) => r.locker_size ?? '—' },
    { key: 'locker_number', header: 'Locker', tdClassName: 'mono text-xs', render: (r) => r.locker_number ?? '—' },
    {
      key: 'status', header: 'Status',
      value: (r) => r.removed_at ? 'deleted' : (r.status ?? ''),
      render: (r) => {
        if (r.removed_at) {
          return <span className="text-xs rounded px-1.5 py-0.5 bg-bg text-text-muted"
                       title={r.removed_reason ?? undefined}>deleted</span>;
        }
        if (!r.status) {
          return <span className="text-xs text-text-muted italic" title="Never read from LockerHub — use Refresh">not checked</span>;
        }
        return <span className={`text-xs rounded px-1.5 py-0.5 ${pill[r.status.toLowerCase()] ?? 'bg-bg'}`}>{r.status}</span>;
      },
    },
    { key: 'created_at', header: 'Created', value: (r) => r.created_at, render: (r) => fmtDate(r.created_at) },
    {
      key: 'actions', header: '', sortable: false, filterable: false, align: 'right',
      render: (r) => (
        <span className="whitespace-nowrap">
          <button className="text-xs text-primary hover:underline" onClick={() => open(r)}>Open</button>
          {!r.removed_at && (
            <button className="text-xs text-danger hover:underline ml-3" disabled={busy}
                    onClick={() => remove(r)}>Delete</button>
          )}
        </span>
      ),
    },
  ];

  const rows = list.data?.rows ?? [];
  const tabs: TabDef<Tab>[] = [
    { key: 'live', label: 'Live' },
    { key: 'removed', label: 'Deleted' },
    { key: 'all', label: 'All' },
  ];

  return (
    <div className="w-full">
      <h1 className="text-xl font-bold tracking-tight m-0">Locker Applications</h1>
      <p className="text-sm text-text-muted mt-1 mb-4">
        Every locker application created in NCD. Open one to resume its enrolment, or delete one entered by mistake.
      </p>

      {note && <div className="text-xs text-success bg-[color:var(--success-bg)] rounded px-3 py-2 mb-3">{note}</div>}
      {err && <div className="text-xs text-danger bg-[color:var(--danger-bg)] rounded px-3 py-2 mb-3">{err}</div>}
      {list.data?.scope.restricted && (
        <div className="text-xs text-text-muted bg-bg rounded px-3 py-2 mb-3">
          Showing your branch{list.data.scope.branches.length === 1 ? '' : 'es'}:{' '}
          {list.data.scope.branches.map((b) => b.name).join(', ') || '—'}.
        </div>
      )}

      <div className="flex items-center gap-2 mb-3">
        <input
          className="px-2.5 py-1.5 text-sm border border-border-strong rounded outline-none focus:border-primary w-72"
          placeholder="Search name, phone, locker or app no…"
          value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="text-xs border border-border rounded px-3 py-1.5 hover:bg-bg disabled:opacity-40"
                onClick={refreshAll} disabled={busy || !rows.length}>
          {busy ? 'Working…' : 'Refresh from LockerHub'}
        </button>
      </div>

      <Tabs tabs={tabs} active={tab} onChange={setTab} />

      {list.isLoading ? <div className="text-text-muted">Loading…</div>
        : list.error ? <div className="text-danger">Failed to load locker applications.</div>
        : (
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(r) => r.lockerhub_application_id}
            defaultSort={{ key: 'created_at', dir: 'desc' }}
            empty={tab === 'removed' ? 'Nothing has been deleted.' : 'No locker applications yet.'}
          />
        )}
    </div>
  );
}
