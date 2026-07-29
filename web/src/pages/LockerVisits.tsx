import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api/client.js';

/**
 * Locker Visit Log (contract §A14) — who opened which locker, when and why.
 *
 * The record lives on LockerHub; this page is a window onto it so branch staff
 * can read the history and log a walk-in without opening their app.
 *
 * Two things about the data that shape the UI:
 *  · `tenant_phone` arrives MASKED to last-4 (`******3210`), the same posture as
 *    the tenant roster. It is shown as received — there is nothing to unmask,
 *    and a search box that pretended otherwise would just fail.
 *  · Branch and locker are DERIVED from the tenancy when recording, so the form
 *    only asks for the phone. A tenant has exactly one locker; asking staff to
 *    restate the branch would only create a way to get it wrong.
 */
const card = 'bg-surface border border-border rounded-lg shadow-card p-5 mb-4';
const inp = 'px-2.5 py-1.5 text-sm border border-border-strong rounded outline-none focus:border-primary';
const h2 = 'text-xs font-semibold text-text-label uppercase tracking-wide mb-3';
const btn = 'bg-primary hover:bg-primary-hover disabled:opacity-40 text-white rounded px-4 py-1.5 text-sm font-semibold';
const th = 'text-left text-[11px] uppercase tracking-wide text-text-label font-semibold px-3 py-2';
const td = 'px-3 py-2 border-t border-border align-top';

interface Branch { id: string; name: string }
interface Visit {
  id: string;
  branch_id?: string | null; branch_name?: string | null;
  tenant_id?: string | null; tenant_name?: string | null; tenant_phone?: string | null;
  locker_number?: string | null; locker_size?: string | null;
  datetime?: string | null; visit_time?: string | null; exit_time?: string | null;
  purpose?: string | null; duration?: string | null; notes?: string | null;
  created_at?: string | null;
}

/** `2026-07-28T10:30` / `2026-07-28 05:00:00` → `28-07-2026 10:30`. Their
 *  datetime is a plain local string with no zone, so it is split rather than
 *  passed through Date(), which would shift it by the browser's offset. */
function when(v: string | null | undefined): string {
  const s = String(v ?? '').trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ]?(\d{2}:\d{2})?/);
  if (!m) return s || '—';
  return `${m[3]}-${m[2]}-${m[1]}${m[4] ? ` ${m[4]}` : ''}`;
}

/** Common reasons, so the log stays consistent enough to filter on later. */
const PURPOSES = ['Locker Access', 'Deposit', 'Withdrawal', 'Inspection', 'Maintenance', 'Other'];

export function LockerVisitsPage() {
  const qc = useQueryClient();
  const [branchId, setBranchId] = useState('');
  const [phoneFilter, setPhoneFilter] = useState('');
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');

  // Record-a-visit form
  const [phone, setPhone] = useState('');
  const [purpose, setPurpose] = useState('Locker Access');
  const [datetime, setDatetime] = useState('');
  const [notes, setNotes] = useState('');

  const branches = useQuery({
    queryKey: ['locker-branches'],
    queryFn: () => api.get<{ branches: Branch[] }>('/api/lockers/branches'),
  });

  const visits = useQuery({
    queryKey: ['locker-visits', branchId, phoneFilter],
    queryFn: () => {
      const q = new URLSearchParams();
      if (branchId) q.set('branch_id', branchId);
      if (/^\d{10}$/.test(phoneFilter)) q.set('phone', phoneFilter);
      return api.get<{ visits: Visit[]; restricted_to?: { id: string; name: string }[] | null }>(
        `/api/lockers/visits${q.toString() ? `?${q}` : ''}`);
    },
  });

  const record = useMutation({
    mutationFn: () => api.post<{ success: boolean; tenant_name: string }>('/api/lockers/visits', {
      phone,
      purpose: purpose || undefined,
      // Their field is a plain local string; <input type="datetime-local">
      // already produces exactly `YYYY-MM-DDTHH:MM`. Blank = "Today" on their
      // side, which is the right default for a walk-in being logged as it
      // happens.
      datetime: datetime || undefined,
      notes: notes || undefined,
    }),
    onSuccess: (r) => {
      setErr('');
      setOk(`Visit recorded for ${r.tenant_name || phone}. The customer has been notified.`);
      setPhone(''); setDatetime(''); setNotes(''); setPurpose('Locker Access');
      void qc.invalidateQueries({ queryKey: ['locker-visits'] });
    },
    onError: (e) => {
      setOk('');
      // 404 is the common, actionable one: the phone has no ACTIVE tenancy.
      const msg = e instanceof ApiError
        ? (e.status === 404 ? 'No active locker tenant with that phone number.' : e.message)
        : 'Failed to record the visit.';
      setErr(msg);
    },
  });

  const rows = visits.data?.visits ?? [];
  const restricted = visits.data?.restricted_to ?? null;

  return (
    <div className="w-full">
      <h1 className="text-lg font-semibold mb-1">Locker Visit Log</h1>
      <p className="text-xs text-text-muted mb-4">
        Locker access recorded at the branch. Held by LockerHub — recording one here notifies the customer, exactly as it does in their app.
      </p>

      {/* Record a walk-in */}
      <div className={card}>
        <h2 className={h2}>Record a visit</h2>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-text-label uppercase tracking-wide">Customer phone</span>
            <input className={inp} value={phone} inputMode="numeric" maxLength={10} placeholder="10 digits"
              onChange={(e) => setPhone(e.target.value.replace(/\D/g, '').slice(0, 10))} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-text-label uppercase tracking-wide">Purpose</span>
            <select className={inp} value={purpose} onChange={(e) => setPurpose(e.target.value)}>
              {PURPOSES.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-text-label uppercase tracking-wide">Date &amp; time</span>
            <input className={inp} type="datetime-local" value={datetime} onChange={(e) => setDatetime(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1 grow min-w-[200px]">
            <span className="text-[11px] text-text-label uppercase tracking-wide">Notes</span>
            <input className={inp} value={notes} placeholder="optional" onChange={(e) => setNotes(e.target.value)} />
          </label>
          <button className={btn} disabled={!/^\d{10}$/.test(phone) || record.isPending}
            onClick={() => { setErr(''); setOk(''); record.mutate(); }}>
            {record.isPending ? 'Recording…' : 'Record visit'}
          </button>
        </div>
        <p className="text-[11px] text-text-muted mt-2 mb-0">
          Branch and locker are taken from the customer’s active tenancy — leave the time blank to log it as now.
        </p>
        {err && <div className="text-xs text-danger mt-2">{err}</div>}
        {ok && <div className="text-xs text-success mt-2">{ok}</div>}
      </div>

      {/* History */}
      <div className={card}>
        <div className="flex flex-wrap items-end gap-3 mb-3">
          <h2 className={`${h2} mb-0 mr-auto`}>Visits</h2>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-text-label uppercase tracking-wide">Branch</span>
            <select className={inp} value={branchId} onChange={(e) => setBranchId(e.target.value)}>
              <option value="">{restricted ? restricted.map((b) => b.name).join(', ') : 'All branches'}</option>
              {(branches.data?.branches ?? []).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-text-label uppercase tracking-wide">Customer phone</span>
            <input className={inp} value={phoneFilter} inputMode="numeric" maxLength={10} placeholder="all customers"
              onChange={(e) => setPhoneFilter(e.target.value.replace(/\D/g, '').slice(0, 10))} />
          </label>
        </div>

        {restricted && (
          <div className="text-[11px] text-text-muted mb-2">Showing your branch only: {restricted.map((b) => b.name).join(', ')}.</div>
        )}

        {visits.isLoading ? <div className="text-sm text-text-muted">Loading…</div>
          : visits.isError ? <div className="text-sm text-danger">Couldn’t reach LockerHub — the visit log is unavailable right now.</div>
          : !rows.length ? <div className="text-sm text-text-muted">No visits recorded{branchId || phoneFilter ? ' for this filter' : ''}.</div>
          : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr>
                    <th className={th}>When</th><th className={th}>Customer</th><th className={th}>Phone</th>
                    <th className={th}>Locker</th><th className={th}>Branch</th>
                    <th className={th}>Purpose</th><th className={th}>Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((v) => (
                    <tr key={v.id}>
                      <td className={`${td} whitespace-nowrap`}>{when(v.datetime ?? v.created_at)}</td>
                      <td className={td}>{v.tenant_name || '—'}</td>
                      {/* Masked to last-4 by LockerHub — shown as received. */}
                      <td className={`${td} font-mono text-xs`}>{v.tenant_phone || '—'}</td>
                      <td className={td}>{v.locker_number || '—'}{v.locker_size ? <span className="text-text-muted text-xs"> · {v.locker_size}</span> : null}</td>
                      <td className={td}>{v.branch_name || '—'}</td>
                      <td className={td}>{v.purpose || '—'}</td>
                      <td className={`${td} text-text-muted text-xs`}>{v.notes || ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </div>
    </div>
  );
}
