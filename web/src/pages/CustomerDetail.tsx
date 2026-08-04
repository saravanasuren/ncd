import { useEffect, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { formatINR, KYC_DOCUMENT_TYPES, CORRECTABLE_CUSTOMER_FIELDS, type CustomerField } from '@new-wealth/shared';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api/client.js';
import { useAuth } from '../auth/AuthContext.js';
import { useConfirm } from '../components/Confirm.js';

/** NCDs are issued in whole ₹1,00,000 units (owner spec 2026-07-23). */
const LAKH = 100000;

/** Human label for a stored doc_type; unknown/legacy values show as-is. */
function docLabel(t: string): string {
  return KYC_DOCUMENT_TYPES.find((d) => d.key === t)?.label ?? t;
}

/**
 * Date of birth as `dd-mm-yyyy · NN yrs` — same date style as the payout summary
 * sheet, and the age spelled out because it decides the senior-citizen TDS slab.
 * Returns null (renders as '—') when there is no DOB on record: 106 of 580
 * customers have none, mostly wealth-migrated ones.
 */
function dobLabel(dob: unknown): string | null {
  const iso = String(dob ?? '').slice(0, 10);
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const now = new Date();
  let age = now.getFullYear() - Number(m[1]);
  const md = (now.getMonth() + 1) * 100 + now.getDate();
  if (md < Number(m[2]) * 100 + Number(m[3])) age--;
  const pretty = `${m[3]}-${m[2]}-${m[1]}`;
  return age >= 0 && age < 130 ? `${pretty} · ${age} yrs` : pretty;
}

/** Field groups, in display order, derived from the shared field list. */
const CORRECTION_GROUPS = [...new Set(CORRECTABLE_CUSTOMER_FIELDS.map((f) => f.group))];

/** The customer's present value, shaped for the input that renders it —
 *  dates trimmed to YYYY-MM-DD, NULLs to '', booleans left as booleans.
 *  Also the baseline the dirty-check compares against. */
function currentValue(c: any, f: CustomerField): string | boolean {
  const raw = c[f.key];
  if (f.kind === 'boolean') return raw === true;
  if (raw == null) return '';
  if (f.kind === 'date') return String(raw).slice(0, 10);
  return String(raw);
}

/** Customer 360 (docs/05 §5) — profile + bank accounts + KYC + hand-off. */
/**
 * Two-step confirm for an irreversible purge: type DELETE, then give an audit
 * reason. Returns the reason, or null if the operator backed out. Super-admin only.
 */
async function purgeConfirm(promptText: ReturnType<typeof useConfirm>['promptText'], what: string): Promise<string | null> {
  const typed = await promptText({
    title: `⚠️ Permanently delete ${what}`,
    body: 'This erases the record and everything linked to it (schedule, collections, incentives, redemptions). It CANNOT be undone.',
    label: 'Type DELETE to confirm', placeholder: 'DELETE', minLength: 6, confirmLabel: 'Continue', danger: true,
  });
  if (typed !== 'DELETE') return null;
  return await promptText({
    title: 'Reason for the audit log', body: `Deleting ${what}.`,
    label: 'Reason (required)', confirmLabel: 'Delete permanently', danger: true,
  });
}


/**
 * What this customer holds, and what they can be sold next (owner 2026-08-01:
 * "whether it's an NCD or a locker customer, first a customer profile is
 * created"). The customer is the hub; NCDs and lockers hang off them.
 *
 * The counts are read from data already on the page — no extra call that could
 * leave the strip half-drawn. Only "waiting" is fetched, and it fails soft: an
 * unanswered worklist should not blank out the holdings beside it.
 */
function Holdings({ customerId, pan, apps, approved, onAddNcd }: {
  customerId: number; pan: string | null; apps: any[]; approved: boolean; onAddNcd: () => void;
}) {
  const { can } = useAuth();
  const DEAD = ['Rejected', 'Cancelled', 'Redeemed', 'Matured', 'RolledOver', 'PrematureWithdrawn', 'Transferred'];
  const open = apps.filter((r) => !DEAD.includes(r.status) && !r.archived_at);
  // Approval is what makes an NCD live and starts interest, so an unapproved
  // one is NOT counted here — a headline "2 live · ₹0 outstanding" reads as a
  // bug, and worse, as though money were already earning.
  const active = open.filter((r) => r.status === 'Active');
  const unapproved = open.length - active.length;
  const outstanding = active.reduce((s, r) => s + Number(r.outstanding ?? 0), 0);

  // Same queryKey as LockersCard below — react-query dedupes it to one request.
  const lockers = useQuery({
    queryKey: ['customer-lockers', customerId],
    queryFn: () => api.get<any>(`/api/lockers/customers/${customerId}/lockers`),
    retry: false, enabled: can('lockers:enroll'),
  });
  const lh = lockers.data?.lockerhub;
  const held = (lh?.lockers ?? lh?.applications ?? []) as any[];

  const waiting = useQuery({
    queryKey: ['outstanding', customerId],
    queryFn: () => api.get<{ rows: { kind: string; detail: string }[] }>(`/api/reports/outstanding?customer_id=${customerId}`),
    retry: false,
  });
  const pending = waiting.data?.rows ?? [];

  const tile = 'flex-1 min-w-[150px] px-4 py-3 rounded-lg border border-border bg-bg';
  const label = 'text-[11px] font-semibold text-text-label uppercase tracking-wide';
  return (
    <div className="bg-surface border border-border rounded-lg shadow-card p-5 mb-4">
      <div className="flex flex-wrap gap-3 items-stretch">
        <div className={tile}>
          <div className={label}>NCDs</div>
          <div className="text-lg font-semibold leading-tight mt-0.5">{active.length} active</div>
          <div className="text-xs text-text-muted mono">{formatINR(outstanding)} outstanding</div>
          {unapproved > 0 && <div className="text-xs text-warn mt-0.5">+{unapproved} not approved yet</div>}
        </div>
        {can('lockers:enroll') && (
          <div className={tile}>
            <div className={label}>Lockers</div>
            {lockers.isLoading
              ? <div className="text-sm text-text-muted mt-1">Checking…</div>
              : lockers.isError || lockers.data?.lockerhub_error
                // Never claim "0 lockers" when we simply could not ask — a wrong
                // zero here is what makes someone open a duplicate application.
                ? <div className="text-sm text-warn mt-1">Couldn’t check</div>
                : <>
                    <div className="text-lg font-semibold leading-tight mt-0.5">{held.length}</div>
                    <div className="text-xs text-text-muted truncate">
                      {held.length === 0 ? 'none yet'
                        : held.map((l) => l.locker_no ?? l.locker_number ?? l.status ?? '—').join(', ')}
                    </div>
                  </>}
          </div>
        )}
        <div className={tile}>
          <div className={label}>Waiting</div>
          {pending.length === 0
            ? <div className="text-sm text-text-muted mt-1">{waiting.isError ? '—' : 'Nothing pending'}</div>
            : <>
                <div className="text-lg font-semibold leading-tight mt-0.5 text-warn">{pending.length}</div>
                <Link to="/app/outstanding" className="text-xs text-primary hover:underline">{pending[0]!.detail.split('—')[0]!.trim()}{pending.length > 1 ? ` +${pending.length - 1}` : ''}</Link>
              </>}
        </div>
      </div>
      {/* Adding either product starts here, because this is where staff already
          are once the customer exists. */}
      {(can('applications:create') || can('lockers:enroll')) && (
        <div className="flex flex-wrap gap-2 mt-3">
          {can('applications:create') && (
            <button onClick={onAddNcd} disabled={!approved}
              title={approved ? 'Record a new NCD investment for this customer' : 'The customer profile has to be approved first'}
              className="text-xs bg-primary text-white rounded px-3 py-1.5 font-semibold disabled:opacity-40 hover:bg-primary-hover">
              + NCD investment
            </button>
          )}
          {can('lockers:enroll') && (
            pan
              ? <Link to={`/app/locker-enrollment?pan=${encodeURIComponent(pan)}`}
                  className="text-xs border border-border-strong rounded px-3 py-1.5 font-semibold hover:bg-bg">+ Locker</Link>
              // The enrolment flow finds them by PAN. Without one it would open
              // on a blank form, so say why instead of pretending to prefill.
              : <span title="This customer has no PAN on record, so the locker flow can’t look them up"
                  className="text-xs border border-border rounded px-3 py-1.5 font-semibold opacity-40 cursor-not-allowed">+ Locker</span>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Whole days from today to a 'YYYY-MM-DD' date, negative once past.
 *
 * Compared as calendar dates in UTC, not timestamps: a lease end is a date, and
 * measuring it against the current clock makes "ends today" read as expired for
 * most of the working day.
 */
function daysUntilDate(iso: string): number | null {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return null;
  const now = new Date();
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())) / 86400000);
}

/** Lockers this customer holds — LockerHub's record plus OUR pledges/cheques.
 * Fetched separately so a LockerHub outage degrades this card alone. */
function LockersCard({ customerId, customerName }: { customerId: number; customerName: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['customer-lockers', customerId],
    queryFn: () => api.get<any>(`/api/lockers/customers/${customerId}/lockers`),
    retry: false,
  });
  if (isLoading || !data) return null;
  const pledges = data.pledges ?? [];
  const cheques = data.cheques ?? [];
  const lh = data.lockerhub;
  const lockers = lh?.lockers ?? [];
  // A5 calls these `open_locker_applications`. The card used to look for
  // `applications`, a key their API does not return — so an enrolment still in
  // progress showed nowhere on the customer, and there was no way back into it.
  const openApps = lh?.open_locker_applications ?? lh?.applications ?? [];
  if (!pledges.length && !cheques.length && !lockers.length && !openApps.length && !data.lockerhub_error) return null;
  const card = 'bg-surface border border-border rounded-lg shadow-card p-5 mb-4';
  return (
    <div className={card}>
      <h2 className="text-xs font-semibold text-text-label uppercase tracking-wide mb-3">Lockers</h2>
      {data.lockerhub_error && (
        <div className="text-xs text-warn mb-2">Couldn’t reach LockerHub — showing what NCD holds. ({String(data.lockerhub_error).slice(0, 80)})</div>
      )}
      {lockers.length > 0 && (
        <div className="text-sm mb-3">
          {lockers.map((l: any, i: number) => {
            // LockerHub's customer record (A5) carries the money and the lease
            // for every locker they hold — annual_rent, deposit, lease_start,
            // lease_end. This card fetched all four and drew none of them, so
            // "what is this customer paying, and until when" could not be
            // answered from the customer's own page (owner 2026-08-03).
            const ends = String(l.lease_end ?? '').slice(0, 10) || null;
            const d = ends ? daysUntilDate(ends) : null;
            return (
              <div key={i} className="border-b border-border last:border-0 py-1.5">
                <div className="flex flex-wrap gap-x-3 gap-y-1 items-center">
                  <span className="font-medium">{l.locker_no ?? l.locker_number ?? l.application_id ?? 'Locker'}</span>
                  {l.branch_name && <span className="text-text-muted text-xs">{l.branch_name}</span>}
                  {l.locker_size && <span className="text-xs rounded px-1.5 py-0.5 bg-bg">{l.locker_size}</span>}
                  {(l.account_status ?? l.status ?? l.application_status) && (
                    <span className="text-xs rounded px-1.5 py-0.5 bg-bg">{l.account_status ?? l.status ?? l.application_status}</span>
                  )}
                  {/* Renewal state, on the customer's own page — the same fact
                      the renewals worklist is built on, so whoever opens this
                      customer for any reason still sees the lease has lapsed. */}
                  {d != null && d < 0 && (
                    <Link to="/app/locker-renewals" className="text-xs rounded px-1.5 py-0.5 bg-[color:var(--danger-bg)] text-danger font-semibold">
                      Rent overdue {Math.abs(d)}d
                    </Link>
                  )}
                  {d != null && d >= 0 && d <= 30 && (
                    <Link to="/app/locker-renewals" className="text-xs rounded px-1.5 py-0.5 bg-[color:var(--warn-bg)] text-warn font-semibold">
                      Renews in {d}d
                    </Link>
                  )}
                </div>
                {(l.annual_rent != null || l.deposit != null || ends) && (
                  <div className="text-xs text-text-muted mt-0.5 flex flex-wrap gap-x-3">
                    {l.annual_rent != null && <span>Rent <span className="mono text-text">{formatINR(l.annual_rent)}</span>/yr</span>}
                    {l.deposit != null && <span>Deposit <span className="mono text-text">{formatINR(l.deposit)}</span></span>}
                    {ends && <span>Lease {l.lease_start ? `${String(l.lease_start).slice(0, 10)} → ` : 'to '}{ends}</span>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      {openApps.length > 0 && (
        <>
          {/* An enrolment part-way through. This is the route back into it —
              to take a payment, allot, or send the agreement for e-Signing. */}
          <div className="text-xs font-semibold text-text-label uppercase tracking-wide mb-1">Locker applications in progress</div>
          <div className="text-sm mb-3">
            {openApps.map((a: any, i: number) => (
              <div key={a.id ?? i} className="flex flex-wrap gap-x-3 gap-y-1 items-center border-b border-border last:border-0 py-1.5">
                {a.id
                  ? <Link to={`/app/locker-enrollment?application_id=${encodeURIComponent(String(a.id))}`}
                      className="text-primary hover:underline font-mono text-xs"
                      title="Open this locker application — payments, allotment and the e-Sign agreement">
                      {a.application_no ?? a.id}
                    </Link>
                  : <span className="font-mono text-xs">{a.application_no ?? '—'}</span>}
                {a.status && <span className="text-xs rounded px-1.5 py-0.5 bg-[color:var(--warn-bg)] text-warn">{a.status}</span>}
                {a.locker_size && <span className="text-xs rounded px-1.5 py-0.5 bg-bg">{a.locker_size}</span>}
                {a.annual_fee != null && <span className="text-xs text-text-muted">Rent <span className="mono text-text">{formatINR(a.annual_fee)}</span></span>}
                {a.deposit != null && <span className="text-xs text-text-muted">Deposit <span className="mono text-text">{formatINR(a.deposit)}</span></span>}
              </div>
            ))}
          </div>
        </>
      )}
      {pledges.length > 0 && (
        <>
          <div className="text-xs font-semibold text-text-label uppercase tracking-wide mb-1">NCDs pledged as deposit</div>
          <div className="text-sm mb-3">
            {pledges.map((p: any) => (
              <div key={p.id} className="flex flex-wrap gap-x-3 items-center border-b border-border last:border-0 py-1.5">
                <Link to={`/app/applications/${p.application_id}`} state={{ from: { path: `/app/customers/${customerId}`, label: customerName } }} className="text-primary hover:underline font-mono text-xs">{p.application_no}</Link>
                <span className="mono">{formatINR(p.linked_amount)}</span>
                <span className="text-xs text-text-muted">locker {p.lockerhub_application_id}{p.locker_no ? ` · ${p.locker_no}` : ''}</span>
                <span className={`text-xs rounded px-1.5 py-0.5 ${p.status === 'active' ? 'bg-[color:var(--warn-bg)] text-warn' : 'bg-bg text-text-muted'}`}>{p.status}</span>
              </div>
            ))}
          </div>
        </>
      )}
      {cheques.length > 0 && (
        <>
          <div className="text-xs font-semibold text-text-label uppercase tracking-wide mb-1">Locker cheques</div>
          <div className="text-sm">
            {cheques.map((q: any) => (
              <div key={q.id} className="flex flex-wrap gap-x-3 items-center border-b border-border last:border-0 py-1.5">
                <span className="font-mono text-xs">{q.cheque_no}</span>
                <span className="mono">{formatINR(q.amount)}</span>
                <span className="text-xs text-text-muted">{q.leg} · {q.bank_name ?? '—'}</span>
                <span className={`text-xs rounded px-1.5 py-0.5 ${q.status === 'Cleared' ? 'bg-[color:var(--success-bg)] text-success' : q.status === 'Pending' ? 'bg-[color:var(--warn-bg)] text-warn' : 'bg-bg text-text-muted'}`}>{q.status}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export function CustomerDetailPage() {
  const { confirm, promptText } = useConfirm();
  const { id } = useParams();
  const qc = useQueryClient();
  const nav = useNavigate();
  const { can } = useAuth();
  const [msg, setMsg] = useState('');
  const [panel, setPanel] = useState<'correction' | 'handover' | null>(null);
  const [corr, setCorr] = useState<Record<string, string | boolean>>({});
  const [corrReason, setCorrReason] = useState('');
  const [handoverTo, setHandoverTo] = useState('');
  const [handoverReason, setHandoverReason] = useState('');

  const key = ['customer', id];
  const { data, isLoading, error } = useQuery({ queryKey: key, queryFn: () => api.get<any>(`/api/customers/${id}`) });
  const staff = useQuery({
    queryKey: ['assignable-staff'],
    queryFn: () => api.get<{ rows: { id: number; full_name: string; role: string }[] }>('/api/customers/assignable-staff'),
    enabled: can('customers:handover-request'),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: key });
  const wrap = (p: Promise<unknown>) => p.then(() => { setMsg(''); invalidate(); }).catch((e) => setMsg(e instanceof ApiError ? e.message : 'Failed'));

  if (isLoading) return <div className="text-text-muted">Loading…</div>;
  if (error) return <div className="text-danger">Customer not found or out of scope.</div>;

  const c = data.customer;
  const inp = 'px-2.5 py-1.5 text-sm border border-border-strong rounded outline-none focus:border-primary';
  const card = 'bg-surface border border-border rounded-lg shadow-card p-5 mb-4';

  return (
    <div className="w-full">
      <Link to="/app/customers" className="text-xs text-text-muted hover:text-primary">← Customers</Link>
      <div className="flex items-center gap-3 mt-1">
        <h1 className="text-xl font-bold tracking-tight m-0">{c.full_name}</h1>
        <span className="font-mono text-xs text-text-muted">{c.customer_code}</span>
        <span className="text-xs rounded px-1.5 py-0.5 bg-bg">{c.creation_status}</span>
        {c.archived_at && <span className="text-xs rounded px-1.5 py-0.5 bg-[color:var(--danger-bg)] text-danger font-semibold">Archived</span>}
        {/* Dematerialisation sign, top-right. Manually set; NULL = not marked. */}
        <div className="ml-auto flex items-center gap-1.5">
          {(() => {
            const dm = c.is_dematerialised;
            const label = dm === true ? 'Dematerialised' : dm === false ? 'Physical' : 'Demat: not marked';
            const cls = dm === true ? 'bg-[color:var(--success-bg)] text-success'
              : dm === false ? 'bg-bg text-text-muted' : 'bg-[color:var(--warn-bg)] text-warn';
            return <span className={`text-xs rounded px-2 py-0.5 font-semibold ${cls}`}>{label}</span>;
          })()}
          {can('customers:update') && (
            <select className="text-xs border border-border-strong rounded px-1.5 py-0.5 bg-surface"
              value={c.is_dematerialised === true ? 'yes' : c.is_dematerialised === false ? 'no' : ''}
              onChange={(e) => {
                const v = e.target.value === 'yes' ? true : e.target.value === 'no' ? false : null;
                wrap(api.patch(`/api/customers/${id}/dematerialised`, { value: v }));
              }}
              title="Mark whether this customer's bond is dematerialised">
              <option value="">Not marked</option>
              <option value="yes">Dematerialised</option>
              <option value="no">Physical</option>
            </select>
          )}
        </div>
      </div>
      {c.archived_at && (
        <div className="text-xs bg-[color:var(--danger-bg)] text-danger rounded px-3 py-2 mt-2">
          This customer is archived — hidden from the book, dashboard and lists. Their investments are archived too.
          {can('customers:delete') && ' Restore or permanently delete below.'}
        </div>
      )}
      {msg && <div className="text-xs text-danger mt-2">{msg}</div>}

      <div className="mt-4">
        <Holdings customerId={Number(id)} pan={c.pan ?? null} apps={data.applications ?? []}
          approved={c.creation_status === 'Approved'}
          // Instant, not smooth: the form is ~1500px down, and a smooth scroll
          // that far is both slow and silently dropped by some renderers.
          onAddNcd={() => document.getElementById('new-investment')?.scrollIntoView({ block: 'start' })} />
      </div>

      <div className={card}>
        <h2 className="text-xs font-semibold text-text-label uppercase tracking-wide mb-3">Profile</h2>
        {/* Grouped, full detail — same field set as the quick-view popup, so the
            profile page shows everything in one place, plus the profile's richer
            Referred-by link and Form-15G/15H validity. */}
        <div className="text-[11px] font-semibold text-text-label uppercase tracking-wide mb-1.5">Personal</div>
        <dl className="grid grid-cols-2 gap-y-2 text-sm mb-4">
          <Field label="Phone" value={c.phone} />
          <Field label="Alt. phone" value={c.phone_secondary} />
          <Field label="Email" value={c.email} />
          <Field label="PAN" value={c.pan} />
          {/* Aadhaar shown masked to last 4 — the same posture as the popup. */}
          <Field label="Aadhaar" value={c.aadhaar_last4 ? `XXXX XXXX ${c.aadhaar_last4}` : null} />
          {/* DOB carries the age (drives the senior-citizen TDS slab); parsed as a
              plain 'YYYY-MM-DD' string, so no timezone shift to guard against. */}
          <Field label="Date of birth" value={dobLabel(c.dob)} />
          <Field label="Gender" value={c.gender} />
          <Field label="Father / spouse" value={c.father_name} />
          <Field label="Occupation" value={c.occupation} />
          <Field label="Category" value={c.investor_category} />
          <Field label="NRI" value={c.is_nri ? 'Yes' : 'No'} />
        </dl>

        <div className="text-[11px] font-semibold text-text-label uppercase tracking-wide mb-1.5">Address</div>
        <dl className="grid grid-cols-2 gap-y-2 text-sm mb-4">
          <Field label="Address" value={c.address} />
          <Field label="City" value={c.city} />
          <Field label="District" value={c.district} />
          <Field label="State" value={c.state} />
          <Field label="Pincode" value={c.pincode} />
        </dl>

        <div className="text-[11px] font-semibold text-text-label uppercase tracking-wide mb-1.5">Status &amp; attribution</div>
        <dl className="grid grid-cols-2 gap-y-2 text-sm">
          <Field label="KYC" value={c.kyc_status} />
          <Field label="Active" value={c.is_active ? 'Yes' : 'No'} />
          <Field label="CKYC no." value={c.ckyc_number} />
          {/* Tax position — decides TDS on every payout, so it belongs here. */}
          <Field label="TDS applicable" value={c.tds_applicable === false ? 'No' : 'Yes'} />
          <Field label="Form 15G/15H" value={c.tax_form
            ? `${c.tax_form}${c.tax_form_expires_on ? ` · valid to ${String(c.tax_form_expires_on).slice(0, 10)}` : ' · no validity date (ignored)'}`
            : null} />
          {/* Who brought this customer in — staff or agent (owner 2026-07-24). */}
          <Field label="Enrolled by" value={c.enrolled_by_name
            ? `${c.enrolled_by_name}${c.enrolled_by_kind === 'agent' ? ` (agent${c.enrolled_by_agent_code ? ' ' + c.enrolled_by_agent_code : ''})` : ' (staff)'}`
            : null} />
          {/* Referred by is NOT the same as enrolled by: staff enrol, but the
              customer may have been introduced by another customer or an agent.
              Free text on the record, resolved to a person server-side. */}
          <div>
            <dt className="text-xs text-text-label uppercase tracking-wide">Referred by</dt>
            <dd className="text-sm m-0 mt-0.5">
              {!data.referredBy ? <span className="text-text-muted">—</span>
                : data.referredBy.kind === 'customer'
                  ? <Link to={`/app/customers/${data.referredBy.id}`} className="text-primary hover:underline">
                      {data.referredBy.name} <span className="text-text-muted">({data.referredBy.code})</span>
                    </Link>
                : data.referredBy.kind === 'agent'
                  ? <>{data.referredBy.name} <span className="text-text-muted">(agent {data.referredBy.code})</span></>
                : data.referredBy.kind === 'staff'
                  ? <>{data.referredBy.name} <span className="text-text-muted">(staff)</span></>
                : <span title="Recorded as free text — no matching customer, agent or staff member">
                    {data.referredBy.text} <span className="text-text-muted">(unmatched)</span>
                  </span>}
            </dd>
          </div>
        </dl>
        <div className="flex gap-2 mt-4">
          {can('kyc:verify') && c.kyc_status !== 'Verified' && (
            <button onClick={() => wrap(api.post(`/api/customers/${id}/kyc/verify`))} className="text-xs border border-border rounded px-3 py-1.5 hover:bg-bg">✓ Verify KYC</button>
          )}
          {can('kyc:reject') && c.kyc_status !== 'Rejected' && (
            <button onClick={async () => {
              const reason = await promptText({ title: 'Reject this KYC?', body: 'The customer stays on the book; their KYC is marked rejected.', label: 'Reason', confirmLabel: 'Reject KYC', danger: true });
              if (reason) wrap(api.post(`/api/customers/${id}/kyc/reject`, { reason }));
            }} className="text-xs border border-border text-danger rounded px-3 py-1.5 hover:bg-[color:var(--danger-bg)]">✗ Reject KYC</button>
          )}
          {/* Customer creation needs no approval (owner 2026-07-21) — the customer
              is live on creation; the only approval gate is the investment. */}
          {can('customers:correction-request') && c.creation_status !== 'Draft' && (
            <button onClick={() => setPanel(panel === 'correction' ? null : 'correction')} className="text-xs border border-border rounded px-3 py-1.5 hover:bg-bg">Request correction</button>
          )}
          {can('customers:update') && (
            <button onClick={async () => {
              // Both answers ACT — the two buttons are the two settings, not
              // yes/no. Declining leads to the 15G/15H details, which can still
              // be backed out of.
              const applies = await confirm({
                title: "Deduct TDS on this customer's payouts?",
                body: `Currently: ${c.tds_applicable === false ? 'NOT deducted' : 'deducted'}.`,
                confirmLabel: 'Yes, deduct TDS', cancelLabel: 'No — 15G/15H on file',
              });
              if (applies) {
                wrap(api.patch(`/api/customers/${id}/tax`, { tds_applicable: true, tax_form: null, tax_form_expires_on: null }));
                return;
              }
              const form = await promptText({ title: 'Which form is on file?', label: '15G or 15H', defaultValue: c.tax_form ?? '15G', minLength: 3, confirmLabel: 'Next' });
              if (form === null) return;
              const upper = form.trim().toUpperCase();
              if (!['15G', '15H'].includes(upper)) { setMsg('Tax form must be 15G or 15H.'); return; }
              const until = await promptText({
                title: `${upper} — valid until`, body: '15G/15H run per financial year, so a validity date is required.',
                label: 'Valid until', inputType: 'date', defaultValue: c.tax_form_expires_on ? String(c.tax_form_expires_on).slice(0, 10) : '',
                minLength: 10, confirmLabel: 'Save',
              });
              if (until === null) return;
              if (!/^\d{4}-\d{2}-\d{2}$/.test(until.trim())) { setMsg('Enter the validity date as YYYY-MM-DD — without it the form is ignored.'); return; }
              wrap(api.patch(`/api/customers/${id}/tax`, { tds_applicable: false, tax_form: upper, tax_form_expires_on: until.trim() }));
            }} className="text-xs border border-border rounded px-3 py-1.5 hover:bg-bg">Set TDS / 15G-15H</button>
          )}
          {can('customers:handover-request') && (
            <button onClick={() => setPanel(panel === 'handover' ? null : 'handover')} className="text-xs border border-border rounded px-3 py-1.5 hover:bg-bg">Request handover</button>
          )}
          {/* Super-admin-only power tools (customers:delete). */}
          {can('customers:delete') && (c.archived_at
            ? <button onClick={() => wrap(api.post(`/api/customers/${id}/unarchive`))} className="text-xs border border-border rounded px-3 py-1.5 hover:bg-bg ml-auto">♻ Restore customer</button>
            : <button onClick={async () => {
                const r = await promptText({
                  title: 'Archive this customer?',
                  body: 'It (and its investments) will be hidden from the book but stay recoverable.',
                  label: 'Reason (optional)', minLength: 0, confirmLabel: 'Archive',
                });
                if (r !== null) wrap(api.post(`/api/customers/${id}/archive`, { reason: r || undefined }));
              }} className="text-xs border border-border rounded px-3 py-1.5 hover:bg-bg ml-auto">🗄 Archive</button>
          )}
          {can('customers:delete') && (
            <button onClick={async () => { const reason = await purgeConfirm(promptText, `customer ${c.full_name} (${c.customer_code}) and ALL their investments`); if (reason) wrap(api.del(`/api/customers/${id}`, { confirm: true, reason }).then(() => nav('/app/customers'))); }}
              className="text-xs border border-danger text-danger rounded px-3 py-1.5 hover:bg-[color:var(--danger-bg)]">🗑 Delete permanently</button>
          )}
        </div>

        {panel === 'correction' && (
          <div className="mt-4 border-t border-border pt-4">
            <div className="text-xs font-semibold text-text-label uppercase tracking-wide mb-2">Correction request (needs approval)</div>
            <p className="text-xs text-text-muted mb-3">Edit anything that needs fixing — only the fields you actually change are sent for approval.</p>
            {CORRECTION_GROUPS.map((g) => (
              <div key={g} className="mb-3">
                <div className="text-xs font-semibold text-text-label mb-1">{g}</div>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-2 max-w-3xl">
                  {CORRECTABLE_CUSTOMER_FIELDS.filter((f) => f.group === g).map((f) => {
                    const cur = currentValue(c, f);
                    const val = corr[f.key] ?? cur;
                    const dirty = val !== cur;
                    const set = (v: string | boolean) => setCorr((s) => ({ ...s, [f.key]: v }));
                    return (
                      <label key={f.key} className={`text-xs ${dirty ? 'text-primary font-semibold' : 'text-text-muted'}`}>
                        {f.label}
                        {f.kind === 'boolean' ? (
                          <div className="mt-1"><input type="checkbox" checked={val === true} onChange={(e) => set(e.target.checked)} /></div>
                        ) : f.kind === 'select' ? (
                          <select className={`${inp} w-full mt-1`} value={String(val)} onChange={(e) => set(e.target.value)}>
                            <option value="">—</option>
                            {(f.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
                          </select>
                        ) : (
                          <input className={`${inp} w-full mt-1`} type={f.kind === 'date' ? 'date' : f.kind === 'email' ? 'email' : 'text'}
                            maxLength={f.maxLength} placeholder={f.hint} value={String(val)}
                            onChange={(e) => set(f.uppercase ? e.target.value.toUpperCase() : e.target.value)} />
                        )}
                      </label>
                    );
                  })}
                </div>
              </div>
            ))}
            <label className="text-xs text-text-muted block max-w-3xl">
              Reason
              <input className={`${inp} w-full mt-1`} value={corrReason} onChange={(e) => setCorrReason(e.target.value)} placeholder="Why is this correction needed?" />
            </label>
            <button
              disabled={corrReason.trim().length < 2}
              onClick={() => {
                const changes: Record<string, string | boolean> = {};
                for (const f of CORRECTABLE_CUSTOMER_FIELDS) {
                  if (!(f.key in corr)) continue;
                  const v = corr[f.key]!;
                  if (v !== currentValue(c, f)) changes[f.key] = v;
                }
                if (!Object.keys(changes).length) { setMsg('No fields changed.'); return; }
                wrap(api.post(`/api/customers/${id}/correction-request`, { changes, reason: corrReason.trim() }).then(() => { setPanel(null); setCorr({}); setCorrReason(''); }));
              }}
              className="mt-3 text-xs bg-primary text-white rounded px-4 py-1.5 disabled:opacity-40 hover:bg-primary-hover">Submit correction</button>
          </div>
        )}

        {panel === 'handover' && (
          <div className="mt-4 border-t border-border pt-4">
            <div className="text-xs font-semibold text-text-label uppercase tracking-wide mb-2">Handover request (needs approval)</div>
            <div className="flex flex-wrap gap-2 items-center">
              <select className={inp} value={handoverTo} onChange={(e) => setHandoverTo(e.target.value)}>
                <option value="">Hand over to…</option>
                {(staff.data?.rows ?? []).map((u) => <option key={u.id} value={u.id}>{u.full_name} ({u.role})</option>)}
              </select>
              <input className={`${inp} w-64`} value={handoverReason} onChange={(e) => setHandoverReason(e.target.value)} placeholder="Reason" />
              <button disabled={!handoverTo || handoverReason.trim().length < 2}
                onClick={() => wrap(api.post(`/api/customers/${id}/handover-request`, { toUserId: Number(handoverTo), reason: handoverReason.trim() }).then(() => { setPanel(null); setHandoverTo(''); setHandoverReason(''); }))}
                className="text-xs bg-primary text-white rounded px-4 py-1.5 disabled:opacity-40 hover:bg-primary-hover">Submit handover</button>
            </div>
          </div>
        )}
      </div>

      {/* Products first and together — an NCD and a locker are two things the
          same customer holds, so they read as one section rather than one card
          up here and another below the KYC paperwork. */}
      <InvestmentsCard rows={data.applications ?? []} customerId={Number(id)} customerName={c.full_name} canDelete={can('applications:delete')} onChange={invalidate} onError={setMsg} />

      <LockersCard customerId={Number(id)} customerName={c.full_name} />

      {can('applications:create') && c.creation_status === 'Approved' && <NewInvestment customerId={Number(id)} custNoTds={c.tds_applicable === false} />}

      <div className={card}>
        <h2 className="text-xs font-semibold text-text-label uppercase tracking-wide mb-3">Bank accounts</h2>
        <BankAccounts
          customerId={Number(id)}
          accounts={data.bankAccounts}
          canEdit={can('customers:update')}
          canDelete={can('customers:delete')}
          onChange={invalidate}
          onError={setMsg}
        />
      </div>

      <Demat customerId={Number(id)} customer={c} canEdit={can('customers:update')} onChange={invalidate} onError={setMsg} />

      <RelationsKyc customerId={Number(id)} data={data} onChange={invalidate} can={can} />
    </div>
  );
}

const appPill: Record<string, string> = {
  Active: 'bg-[color:var(--success-bg)] text-success',
  Redeemed: 'bg-bg text-text-muted', Matured: 'bg-bg text-text-muted',
  Rejected: 'bg-[color:var(--danger-bg)] text-danger', Cancelled: 'bg-[color:var(--danger-bg)] text-danger',
};

/** The customer's investments — every application, newest first, linking to the
 * application page. LIVE statuses total into the header line. */
function InvestmentsCard({ rows, customerId, customerName, canDelete, onChange, onError }: { rows: any[]; customerId: number; customerName: string; canDelete: boolean; onChange: () => void; onError: (m: string) => void }) {
  const { promptText } = useConfirm();
  const nav = useNavigate();
  const DEAD = ['Rejected', 'Cancelled', 'Redeemed', 'Matured', 'RolledOver', 'PrematureWithdrawn', 'Transferred'];
  const live = rows.filter((r) => !DEAD.includes(r.status) && !r.archived_at);
  const outstanding = live.reduce((s, r) => s + Number(r.outstanding ?? 0), 0);
  const th = 'py-2 px-3 text-xs font-semibold text-text-label uppercase tracking-wide text-left';
  const td = 'py-2 px-3 align-middle';
  const run = (p: Promise<unknown>) => p.then(() => { onError(''); onChange(); }).catch((e) => onError(e instanceof ApiError ? e.message : 'Failed'));
  const archiveApp = async (r: any) => {
    const reason = await promptText({
      title: `Archive investment ${r.application_no}?`,
      body: 'Hidden from the book but recoverable.',
      label: 'Reason (optional)', minLength: 0, confirmLabel: 'Archive',
    });
    if (reason !== null) run(api.post(`/api/applications/${r.id}/archive`, { reason: reason || undefined }));
  };
  const restoreApp = (r: any) => run(api.post(`/api/applications/${r.id}/unarchive`));
  const purgeApp = async (r: any) => { const reason = await purgeConfirm(promptText, `investment ${r.application_no}`); if (reason) run(api.del(`/api/applications/${r.id}`, { confirm: true, reason })); };
  return (
    <div className="bg-surface border border-border rounded-lg shadow-card p-5 mb-4">
      <h2 className="text-xs font-semibold text-text-label uppercase tracking-wide mb-1">Investments</h2>
      {rows.length === 0 ? (
        <div className="py-2 text-text-muted text-sm">No investments yet.</div>
      ) : (
        <>
          <div className="text-xs text-text-muted mb-2">
            {live.length} live · outstanding <span className="font-semibold text-text">{formatINR(outstanding)}</span>
            {rows.length > live.length ? ` · ${rows.length - live.length} closed` : ''}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="border-b border-border">
                  <th className={th}>Series</th><th className={th}>App no</th>
                  <th className={th}>Status</th><th className={th}>eSign</th><th className={th}>Received</th>
                  <th className={`${th} text-right`}>Invested</th><th className={`${th} text-right`}>Outstanding</th>
                  {canDelete && <th className={`${th} text-right`}></th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className={`border-b border-border last:border-0 hover:bg-bg cursor-pointer ${r.archived_at ? 'opacity-50' : ''}`}
                    onClick={() => nav(`/app/applications/${r.id}`, { state: { from: { path: `/app/customers/${customerId}`, label: customerName } } })}>
                    <td className={td}>{r.series_code}</td>
                    <td className={`${td} font-mono text-xs whitespace-nowrap`}>{r.application_no}</td>
                    <td className={td}>
                      <span className={`text-[11px] rounded px-1.5 py-0.5 ${appPill[r.status] ?? 'bg-[color:var(--warn-bg)] text-warn'}`}>{r.status}</span>
                      {r.archived_at && <span className="ml-1 text-[11px] rounded px-1.5 py-0.5 bg-[color:var(--danger-bg)] text-danger">Archived</span>}
                    </td>
                    <td className={`${td} whitespace-nowrap`}>
                      {r.esigned_at
                        ? <span className="text-[11px] rounded px-1.5 py-0.5 bg-[color:var(--success-bg)] text-success" title={`eSigned on ${String(r.esigned_at).slice(0, 10)}`}>✓ eSigned</span>
                        : <span className="text-[11px] rounded px-1.5 py-0.5 bg-[color:var(--warn-bg)] text-warn" title="Not eSigned yet">Not signed</span>}
                      {r.esigned_at && r.has_signed_copy && (
                        <a href={`/api/reports/esigned/${r.id}.pdf`} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}
                           className="ml-1.5 text-[11px] text-primary hover:underline">view</a>
                      )}
                    </td>
                    <td className={`${td} text-xs whitespace-nowrap`}>{r.date_money_received ? String(r.date_money_received).slice(0, 10) : '—'}</td>
                    <td className={`${td} text-right mono`}>{formatINR(r.amount)}</td>
                    <td className={`${td} text-right mono font-medium`}>{formatINR(r.outstanding ?? 0)}</td>
                    {canDelete && (
                      <td className={`${td} text-right whitespace-nowrap`} onClick={(e) => e.stopPropagation()}>
                        {r.archived_at
                          ? <button onClick={() => restoreApp(r)} className="text-xs text-primary hover:underline mr-3">Restore</button>
                          : <button onClick={() => archiveApp(r)} className="text-xs text-primary hover:underline mr-3">Archive</button>}
                        <button onClick={() => purgeApp(r)} className="text-xs text-danger hover:underline">Delete</button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function RelationsKyc({ customerId, data, onChange, can }: { customerId: number; data: any; onChange: () => void; can: (...p: any[]) => boolean }) {
  const { promptText } = useConfirm();
  const [msg, setMsg] = useState('');
  const [docType, setDocType] = useState('');
  const [uploadOpen, setUploadOpen] = useState(false);
  const wrap = (p: Promise<unknown>) => p.then(() => { setMsg(''); onChange(); }).catch((e) => setMsg(e instanceof ApiError ? e.message : 'Failed'));
  const card = 'bg-surface border border-border rounded-lg shadow-card p-5 mb-4';
  const inp = 'px-2.5 py-1.5 text-sm border border-border-strong rounded outline-none focus:border-primary';

  async function addNominee() {
    const name = await promptText({ title: 'Add a nominee', label: 'Nominee full name', confirmLabel: 'Next' }); if (!name) return;
    // Blank means "give them everything" — the server splits whatever is
    // unallocated, so a sole nominee lands at 100%. Coercing blank to 0 here is
    // what used to write 0% and say the opposite of what staff intended.
    const typed = await promptText({ title: `Share for ${name}`, body: 'Leave blank to give this nominee the whole holding.', label: 'Share %', minLength: 0, confirmLabel: 'Add nominee' });
    const share = typed != null && typed.trim() !== '' ? Number(typed) : undefined;
    if (share != null && !(share > 0)) { setMsg('Share % must be a number above 0, or blank.'); return; }
    const existing = (data.nominees ?? []).map((n: any) => ({ full_name: n.full_name, relationship: n.relationship, share_pct: Number(n.share_pct) || undefined }));
    await wrap(api.put(`/api/customers/${customerId}/nominees`, {
      nominees: [...existing, { full_name: name, ...(share != null ? { share_pct: share } : {}) }],
    }));
  }
  async function addJoint() {
    const name = await promptText({ title: 'Add a joint holder', label: 'Joint holder full name', confirmLabel: 'Add' }); if (!name) return;
    const existing = (data.jointHolders ?? []).map((h: any) => ({ full_name: h.full_name, relationship: h.relationship, pan: h.pan, phone: h.phone }));
    await wrap(api.put(`/api/customers/${customerId}/joint-holders`, { holders: [...existing, { full_name: name }] }));
  }
  /** Upload against the type the operator picked. The type is not cosmetic —
   *  background verification looks up `customer_photo`, `pan_card` etc. by
   *  name, so a photo filed as generic 'KYC' is invisible to it. */
  function uploadDoc(doc_type: string) {
    const picker = document.createElement('input'); picker.type = 'file'; picker.accept = 'image/*,.pdf';
    picker.onchange = () => {
      const file = picker.files?.[0]; if (!file) return;
      if (file.size > 4 * 1024 * 1024) { setMsg('Document must be under 4 MB.'); return; }
      const reader = new FileReader();
      reader.onload = () => {
        const data_base64 = String(reader.result).split(',')[1] ?? '';
        void wrap(api.post(`/api/customers/${customerId}/documents`, { doc_type, filename: file.name, mime: file.type || 'application/octet-stream', data_base64 })
          .then(() => { setUploadOpen(false); setDocType(''); }));
      };
      reader.readAsDataURL(file);
    };
    picker.click();
  }

  return (
    <>
      {msg && <div className="text-xs text-danger mb-2">{msg}</div>}

      {/* Relations — nominees + joint holders */}
      <div className={card}>
        <h2 className="text-xs font-semibold text-text-label uppercase tracking-wide mb-3">Relations</h2>
        <div className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <div className="flex items-center justify-between"><span className="font-semibold">Nominees</span>{can('customers:update') && <button onClick={addNominee} className="text-xs text-primary hover:underline">+ Add</button>}</div>
            <ul className="mt-1 text-text-muted">{(data.nominees ?? []).map((n: any) => <li key={n.id}>{n.full_name} — {Number(n.share_pct) || 0}%</li>)}{!(data.nominees ?? []).length && <li>None</li>}</ul>
          </div>
          <div>
            <div className="flex items-center justify-between"><span className="font-semibold">Joint holders</span>{can('customers:update') && <button onClick={addJoint} className="text-xs text-primary hover:underline">+ Add</button>}</div>
            <ul className="mt-1 text-text-muted">{(data.jointHolders ?? []).map((h: any) => <li key={h.id}>{h.full_name}</li>)}{!(data.jointHolders ?? []).length && <li>None</li>}</ul>
          </div>
        </div>
      </div>

      {/* KYC — documents + verification */}
      <div className={card}>
        <h2 className="text-xs font-semibold text-text-label uppercase tracking-wide mb-3">KYC</h2>
        <div>
          <div className="flex items-center justify-between"><span className="font-semibold text-sm">Documents</span>{can('customers:update') && <button onClick={() => setUploadOpen((o) => !o)} className="text-xs text-primary hover:underline">+ Upload</button>}</div>
          <ul className="mt-1 text-text-muted text-sm">{(data.documents ?? []).map((d: any) => <li key={d.id}><a href={`/api/customers/${customerId}/documents/${d.id}`} target="_blank" rel="noreferrer" className="text-primary hover:underline">{docLabel(d.doc_type)} — {d.original_filename ?? d.id}</a> <span className="text-xs">({d.origin})</span></li>)}{!(data.documents ?? []).length && <li>None</li>}</ul>
          {uploadOpen && (
            <div className="mt-3 border-t border-border pt-3 flex flex-wrap gap-2 items-center">
              <label className="text-xs text-text-muted">What are you uploading?</label>
              <select className={inp} value={docType} onChange={(e) => setDocType(e.target.value)}>
                <option value="">Select document type…</option>
                {KYC_DOCUMENT_TYPES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
              </select>
              <button disabled={!docType} onClick={() => uploadDoc(docType)}
                className="text-xs bg-primary text-white rounded px-4 py-1.5 disabled:opacity-40 hover:bg-primary-hover">Choose file…</button>
              <button onClick={() => { setUploadOpen(false); setDocType(''); }} className="text-xs text-text-muted hover:underline">Cancel</button>
              <span className="text-xs text-text-muted w-full">JPEG, PNG, WebP or PDF, up to 4 MB.</span>
            </div>
          )}
        </div>
        <div className="flex gap-2 mt-4">
          {can('kyc:verify') && <button onClick={() => wrap(api.post(`/api/customers/${customerId}/kyc/digilocker/start`).then(() => api.post(`/api/customers/${customerId}/kyc/digilocker/complete`)))} className="text-xs border border-border rounded px-3 py-1.5 hover:bg-bg">DigiLocker verify</button>}
          {can('customers:deactivate') && !data.customer.is_deceased && <button onClick={async () => {
            const d = await promptText({ title: 'Mark this customer deceased', body: 'Payouts stop until a transformation is processed.', label: 'Deceased date', inputType: 'date', minLength: 10, confirmLabel: 'Mark deceased', danger: true });
            if (d) wrap(api.post(`/api/customers/${customerId}/deceased`, { deceased_date: d }));
          }} className="text-xs border border-border rounded px-3 py-1.5 hover:bg-bg text-danger">Mark deceased</button>}
        </div>
      </div>
    </>
  );
}

function NewInvestment({ customerId, custNoTds }: { customerId: number; custNoTds: boolean }) {
  const nav = useNavigate();
  const [seriesId, setSeriesId] = useState('');
  const [schemeId, setSchemeId] = useState('');
  const [amount, setAmount] = useState('');
  // A No-TDS customer investing over ₹30L: the creator is asked, per investment,
  // whether TDS should apply after all. '' until they answer; the create is
  // blocked until they do. 'yes' stamps a per-line override (the customer's own
  // No-TDS status is left untouched).
  const [applyTds, setApplyTds] = useState<'' | 'yes' | 'no'>('');
  const over30L = amount !== '' && Number(amount) > 30 * LAKH;
  const tdsPrompt = custNoTds && over30L;
  // NCDs are ISSUED in whole ₹1,00,000 units, but a single credit need not be
  // one (owner 2026-08-01): money arrives in parts and is clubbed. So this is a
  // WARNING, not a block — the server accepts any positive amount, and approval
  // is what refuses a total that isn't a whole unit. Blocking here would force
  // staff to record a figure the bank statement doesn't show.
  const isWholeUnit = amount !== '' && Number(amount) >= LAKH && Math.round(Number(amount) * 100) % (LAKH * 100) === 0;
  const isPartPayment = amount !== '' && Number(amount) > 0 && !isWholeUnit;
  const [dateReceived, setDateReceived] = useState('');
  const [clubWith, setClubWith] = useState('');
  const [lockerDeposit, setLockerDeposit] = useState(false);
  const [method, setMethod] = useState('');
  const [reference, setReference] = useState('');
  const [creditedBank, setCreditedBank] = useState('');   // which Dhanam account received it (optional)
  const [receipt, setReceipt] = useState<File | null>(null);
  const [err, setErr] = useState('');
  // /api/banks, NOT /api/products/banks — productsRouter is mounted at `/api`,
  // so its /banks route is /api/banks. The old path 404'd, react-query left
  // `data` undefined, and `?? []` turned a broken request into an empty
  // dropdown that looked like "no accounts configured".
  const collectionBanks = useQuery({ queryKey: ['collection-banks'], queryFn: () => api.get<{ rows: any[] }>('/api/banks') });
  const series = useQuery({ queryKey: ['series'], queryFn: () => api.get<{ rows: any[] }>('/api/series') });
  const schemes = useQuery({ queryKey: ['schemes'], queryFn: () => api.get<{ rows: any[] }>('/api/schemes') });
  // In-flight applications in the chosen series this new line could club into
  // (append to an existing pre-allotment application instead of a new one).
  const candidates = useQuery({
    queryKey: ['clubbing', customerId, seriesId],
    queryFn: () => api.get<{ rows: any[] }>(`/api/applications/clubbing-candidates?customer_id=${customerId}&series_id=${seriesId}`),
    enabled: !!seriesId,
  });
  const readFileB64 = (file: File) => new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = reject; r.readAsDataURL(file);
  });
  const create = useMutation({
    mutationFn: async () => {
      // The payment evidence (credited date, method, reference, receipt photo)
      // is mandatory. The receipt travels WITH the create — the API stores it in
      // the same transaction, so no investment can exist without one.
      if (!receipt) throw new ApiError('VALIDATION', 400, 'Receipt photo is required');
      if (receipt.size > 4 * 1024 * 1024) throw new ApiError('too_large', 400, 'Receipt must be under 4 MB');
      return api.post<{ id: number }>('/api/applications', {
        customer_id: customerId, series_id: Number(seriesId), scheme_id: Number(schemeId), amount: Number(amount),
        date_money_received: dateReceived,
        collection_method: method.trim(),
        collection_reference: reference.trim(),
        ...(creditedBank ? { collection_bank_id: Number(creditedBank) } : {}),
        receipt: { filename: receipt.name, mime: receipt.type || 'application/octet-stream', data_base64: await readFileB64(receipt) },
        ...(clubWith ? { club_with_application_id: Number(clubWith) } : {}),
        ...(lockerDeposit ? { is_locker_deposit: true } : {}),
        // Only when the >₹30L prompt was shown AND answered "yes" — this marks
        // the WHOLE customer as TDS-applicable (all their investments), not just
        // this one.
        ...(tdsPrompt && applyTds === 'yes' ? { mark_customer_tds: true } : {}),
      });
    },
    onSuccess: (r) => nav(`/app/applications/${r.id}`),
    onError: (e) => setErr(e instanceof ApiError ? e.message : 'Failed'),
  });
  // Mandatory before Create is allowed — mirrors the API schema.
  const missingRequired = () => [
    !dateReceived && 'credited date',
    !method && 'payment method',
    !reference.trim() && 'reference / cheque no.',
    !receipt && 'receipt photo',
    tdsPrompt && applyTds === '' && 'TDS decision (over ₹30L)',
  ].filter((f): f is string => !!f);
  const sel = 'px-2.5 py-1.5 text-sm border border-border-strong rounded outline-none focus:border-primary';
  const clubOptions = candidates.data?.rows ?? [];
  return (
    <div id="new-investment" className="bg-surface border border-border rounded-lg shadow-card p-5 mb-4 scroll-mt-4">
      <h2 className="text-xs font-semibold text-text-label uppercase tracking-wide mb-3">New investment</h2>
      <div className="flex flex-wrap gap-2 items-center">
        <select className={sel} value={seriesId} onChange={(e) => { setSeriesId(e.target.value); setClubWith(''); }}>
          <option value="">Series…</option>
          {/* Only an OPEN series can take a new investment (closed/allotted are locked). */}
          {(series.data?.rows ?? []).filter((s) => s.status === 'Open').map((s) => <option key={s.id} value={s.id}>{s.code}</option>)}
        </select>
        <select className={sel} value={schemeId} onChange={(e) => setSchemeId(e.target.value)}>
          <option value="">Scheme…</option>
          {(schemes.data?.rows ?? []).map((s) => <option key={s.id} value={s.id}>{s.code} ({s.coupon_rate_pct}%)</option>)}
        </select>
        {/* NCDs are issued in whole ₹1,00,000 units — step/min make the browser
            enforce it, and the hint below states it before they submit. */}
        <input className={sel} placeholder="Amount (₹1,00,000 units)" type="number" min={LAKH} step={LAKH}
          value={amount} onChange={(e) => setAmount(e.target.value)} />
        <label className="text-xs flex items-center gap-1.5" title="Date the money was credited to Dhanam's account — interest starts from here once approved">
          Credited<span className="text-danger">*</span> <input className={sel} type="date" value={dateReceived} onChange={(e) => setDateReceived(e.target.value)} />
        </label>
        <select className={sel} value={method} onChange={(e) => setMethod(e.target.value)}>
          <option value="">Payment method… *</option>
          <option value="NEFT/RTGS">NEFT/RTGS</option>
          <option value="Cheque">Cheque</option>
        </select>
        <input className={sel} placeholder="Reference / cheque no. *" value={reference} onChange={(e) => setReference(e.target.value)} />
        {/* Which Dhanam account the money was credited to — optional, can be set later. */}
        <select className={sel} value={creditedBank} onChange={(e) => setCreditedBank(e.target.value)} title="Which Dhanam account received the money (optional)">
          <option value="">Credited to… (optional)</option>
          {/* A failed load must not look like "no accounts configured" — that is
              exactly how the 404 above hid for so long. */}
          {collectionBanks.isError && <option value="" disabled>Could not load company accounts</option>}
          {(collectionBanks.data?.rows ?? []).filter((b: any) => b.is_collection_account && b.is_active).map((b: any) => (
            <option key={b.id} value={b.id}>{(b.account_label || b.bank_name)} · {b.account_number}</option>
          ))}
        </select>
        <label className="text-xs flex items-center gap-1.5 cursor-pointer border border-border-strong rounded px-2.5 py-1.5" title="Receipt / cheque photo (image or PDF, under 4 MB)">
          {receipt ? `📎 ${receipt.name.length > 18 ? receipt.name.slice(0, 15) + '…' : receipt.name}` : <>📎 Receipt photo<span className="text-danger">*</span></>}
          <input type="file" accept="image/*,.pdf" className="hidden" onChange={(e) => setReceipt(e.target.files?.[0] ?? null)} />
        </label>
        <label className="text-xs flex items-center gap-1.5" title="Money came from a locker (LockerHub-originated deposits flag themselves automatically)">
          <input type="checkbox" checked={lockerDeposit} onChange={(e) => setLockerDeposit(e.target.checked)} /> Locker deposit
        </label>
        <button disabled={!seriesId || !schemeId || !amount || !(Number(amount) > 0) || create.isPending} onClick={() => {
          const missing = missingRequired();
          if (missing.length) {
            const list = missing.join(', ');
            setErr(`${list.charAt(0).toUpperCase()}${list.slice(1)} ${missing.length > 1 ? 'are' : 'is'} required.`);
            return;
          }
          setErr(''); create.mutate();
        }}
          className="text-xs bg-primary text-white rounded px-4 py-1.5 disabled:opacity-40 hover:bg-primary-hover">
          {clubWith ? 'Add to application' : 'Create investment'}
        </button>
      </div>
      {/* Amber, not red, and it no longer blocks: a part-payment is a normal
          thing to record. It says what happens NEXT, because the risk here is
          not a wrong number — it is a part-payment nobody ever clubs. */}
      {isPartPayment && (
        <div className="text-xs text-warn mt-2">
          Part payment — ₹{Number(amount).toLocaleString('en-IN')} is not a whole ₹1,00,000 unit.
          It will be recorded and held, earning nothing, until it is clubbed up to
          ₹{((Math.floor(Number(amount) / LAKH) + 1) * LAKH).toLocaleString('en-IN')} (or a higher multiple).
          It cannot be approved or go live before then.
        </div>
      )}
      {/* This customer is marked No-TDS, but the investment is over ₹30L — the
          creator must decide whether TDS applies to THIS investment. */}
      {tdsPrompt && (
        <div className="text-xs mt-2 border border-warn/50 bg-surface rounded px-3 py-2">
          <div className="font-medium text-warn">This customer is marked <b>No&nbsp;TDS</b>, but this investment is over ₹30,00,000. Should TDS apply?</div>
          <div className="flex gap-4 mt-1.5">
            <label className="flex items-center gap-1.5"><input type="radio" name="apply-tds" checked={applyTds === 'yes'} onChange={() => setApplyTds('yes')} /> Yes — mark this customer TDS-applicable</label>
            <label className="flex items-center gap-1.5"><input type="radio" name="apply-tds" checked={applyTds === 'no'} onChange={() => setApplyTds('no')} /> No — keep them exempt</label>
          </div>
          {applyTds === 'yes' && <div className="text-text-muted mt-1">The customer will be marked TDS-applicable — 10% is deducted on <b>all</b> their investments from now on, not just this one.</div>}
        </div>
      )}
      {clubOptions.length > 0 && (
        <label className="flex items-center gap-2 text-xs text-text-muted mt-3">
          Club into an in-flight application:
          <select className={sel} value={clubWith} onChange={(e) => setClubWith(e.target.value)}>
            <option value="">— new application —</option>
            {clubOptions.map((a) => <option key={a.id} value={a.id}>{a.application_no} (₹{Number(a.total_amount).toLocaleString('en-IN')}, {a.status})</option>)}
          </select>
        </label>
      )}
      {err && <div className="text-xs text-danger mt-2">{err}</div>}
    </div>
  );
}

function Field({ label, value }: { label: string; value: unknown }) {
  return (<><dt className="text-text-muted">{label}</dt><dd className="font-medium">{value ? String(value) : '—'}</dd></>);
}

/**
 * Demat account — the depository account the NCDs are credited to. Backed by the
 * customers table (demat_dp_id / demat_client_id / depository) via PUT /:id/demat.
 * DP ID + Client ID together form the 16-char BO ID.
 */
function Demat({ customerId, customer, canEdit, onChange, onError }: {
  customerId: number; customer: any; canEdit: boolean; onChange: () => void; onError: (m: string) => void;
}) {
  const [dpId, setDpId] = useState(customer.demat_dp_id ?? '');
  const [clientId, setClientId] = useState(customer.demat_client_id ?? '');
  const [depository, setDepository] = useState(customer.depository ?? '');
  const inp = 'px-2.5 py-1.5 text-sm border border-border-strong rounded outline-none focus:border-primary';

  const has = !!(customer.demat_dp_id || customer.demat_client_id);
  const dirty = dpId.trim() !== (customer.demat_dp_id ?? '')
    || clientId.trim() !== (customer.demat_client_id ?? '')
    || (depository || '') !== (customer.depository ?? '');

  const save = useMutation({
    mutationFn: () => api.put(`/api/customers/${customerId}/demat`, {
      dp_id: dpId.trim(), client_id: clientId.trim(), depository: depository.trim() || null,
    }),
    onSuccess: onChange,
    onError: (e) => onError(e instanceof ApiError ? e.message : 'Failed'),
  });

  return (
    <div className="bg-surface border border-border rounded-lg shadow-card p-5 mb-4">
      <h2 className="text-xs font-semibold text-text-label uppercase tracking-wide mb-3">Demat account</h2>
      {has ? (
        <dl className="grid grid-cols-2 gap-y-2 text-sm mb-3">
          <Field label="DP ID" value={customer.demat_dp_id} />
          <Field label="Client ID" value={customer.demat_client_id} />
          <Field label="Depository" value={customer.depository} />
        </dl>
      ) : (
        <div className="text-sm text-text-muted mb-3">No demat details on file.</div>
      )}
      {canEdit && (
        <div className="flex gap-2 items-center flex-wrap">
          <input className={inp} placeholder="DP ID" value={dpId} maxLength={16}
            onChange={(e) => setDpId(e.target.value.toUpperCase().replace(/\s/g, ''))} />
          <input className={inp} placeholder="Client ID" value={clientId} maxLength={16}
            onChange={(e) => setClientId(e.target.value.replace(/\s/g, ''))} />
          <select className={inp} value={depository} onChange={(e) => setDepository(e.target.value)}>
            <option value="">Depository…</option>
            <option value="NSDL">NSDL</option>
            <option value="CDSL">CDSL</option>
          </select>
          <button disabled={!dpId.trim() || !clientId.trim() || !dirty || save.isPending} onClick={() => save.mutate()}
            className="text-xs bg-primary text-white rounded px-3 py-1.5 disabled:opacity-40 hover:bg-primary-hover">
            {has ? 'Update' : '+ Save'}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Bank accounts: list + add. Name and account number are typed; entering a
 * valid IFSC auto-fills the bank and branch from the directory lookup
 * (/api/lookups/ifsc). Penny-drop verification happens on the server via
 * kycProvider() when the account is added.
 */
function BankAccounts({ customerId, accounts, canEdit, canDelete, onChange, onError }: {
  customerId: number; accounts: any[]; canEdit: boolean; canDelete: boolean; onChange: () => void; onError: (m: string) => void;
}) {
  const { confirm, promptText } = useConfirm();
  const empty = { holder_name: '', account_number: '', ifsc: '', bank_name: '', branch_name: '', branch_city: '' };
  const [f, setF] = useState(empty);
  const [ifscState, setIfscState] = useState<'idle' | 'looking' | 'found' | 'notfound'>('idle');
  const set = (k: keyof typeof f, v: string) => setF((s) => ({ ...s, [k]: v }));
  const ifscValid = /^[A-Z]{4}0[A-Z0-9]{6}$/.test(f.ifsc.trim().toUpperCase());

  // Debounced IFSC → bank/branch lookup. Non-blocking: on miss/error the user
  // can still add the account (bank/branch just stay whatever was typed/blank).
  useEffect(() => {
    const code = f.ifsc.trim().toUpperCase();
    if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(code)) { setIfscState('idle'); return; }
    let cancelled = false;
    setIfscState('looking');
    const t = setTimeout(async () => {
      try {
        const r = await api.get<any>(`/api/lookups/ifsc/${code}`);
        if (cancelled) return;
        if (r.found) {
          setF((s) => ({ ...s, bank_name: r.bank, branch_name: r.branch, branch_city: r.city }));
          setIfscState('found');
        } else {
          setF((s) => ({ ...s, bank_name: '', branch_name: '', branch_city: '' }));
          setIfscState('notfound');
        }
      } catch { if (!cancelled) setIfscState('notfound'); }
    }, 400);
    return () => { cancelled = true; clearTimeout(t); };
  }, [f.ifsc]);

  // Errors from THIS card are shown INSIDE it. The page-level banner renders up
  // by the profile header, far above the bank section — so a refused delete
  // looked like nothing happened at all.
  const [cardErr, setCardErr] = useState('');
  // Accepts a thrown error OR a plain message, so client-side validation lands
  // in the same inline slot as a server refusal rather than the page banner.
  const fail = (e: unknown) => {
    const m = typeof e === 'string' ? e : e instanceof ApiError ? e.message : 'Failed';
    setCardErr(m); onError(m);
  };

  const add = useMutation({
    mutationFn: () => api.post(`/api/customers/${customerId}/bank-accounts`, {
      ...f, ifsc: f.ifsc.trim().toUpperCase(), holder_name: f.holder_name.trim() || undefined,
      // These are optional server-side, but the zod schema (rightly) rejects an
      // EMPTY string on an .optional() field — only `undefined` is skipped. If
      // the IFSC lookup hasn't resolved yet (or came back notfound), bank_name/
      // branch_name/branch_city sit at '' in state, which used to 400 "Invalid
      // request" on every add attempt whose bank wasn't found or looked up in
      // time — exactly the account-number-typo-fix flow this broke.
      bank_name: f.bank_name.trim() || undefined,
      branch_name: f.branch_name.trim() || undefined,
      branch_city: f.branch_city.trim() || undefined,
    }),
    onSuccess: () => { setF(empty); setIfscState('idle'); onChange(); },
    onError: fail,
  });
  const wrapSet = (p: Promise<unknown>) => p.then(() => { setCardErr(''); onChange(); }).catch(fail);
  const inp = 'px-2.5 py-1.5 text-sm border border-border-strong rounded outline-none focus:border-primary';

  return (
    <>
      {cardErr && (
        <div className="text-xs text-danger bg-[color:var(--danger-bg)] border border-danger/30 rounded px-3 py-2 mb-3">{cardErr}</div>
      )}
      <div className="divide-y divide-border">
        {accounts.map((b: any) => (
          <div key={b.id} className="py-2.5 flex items-center gap-3 text-sm flex-wrap">
            <div className="min-w-0">
              {b.holder_name && <div className="font-medium truncate">{b.holder_name}</div>}
              <div className="flex items-center gap-2">
                <span className="font-mono">{b.account_number}</span>
                <span className="text-text-muted">{b.ifsc}</span>
              </div>
              {(b.bank_name || b.branch_name) && (
                <div className="text-xs text-text-muted">
                  {[b.bank_name, b.branch_name, b.branch_city].filter(Boolean).join(' · ')}
                </div>
              )}
            </div>
            <span className={`text-xs rounded px-1.5 py-0.5 ${b.penny_drop_status === 'Verified' ? 'bg-[color:var(--success-bg)] text-success' : b.penny_drop_status === 'Failed' ? 'bg-[color:var(--danger-bg)] text-danger' : 'bg-bg text-text-muted'}`}>{b.penny_drop_status}</span>
            {b.is_active && <span className="text-xs rounded px-1.5 py-0.5 bg-[color:var(--primary-ring)] text-primary">Active</span>}
            <span className="ml-auto flex items-center gap-3">
              {/* A misspelt beneficiary name is what prints on the bank file —
                  fix it in place rather than re-adding the whole account. */}
              {canEdit && (
                <button onClick={async () => {
                  const next = await promptText({ title: 'Edit beneficiary name', body: 'As it should appear on the bank file.', label: 'Beneficiary name', defaultValue: b.holder_name ?? '', confirmLabel: 'Save' });
                  if (next === null) return;
                  if (next.trim().length < 2) { fail('Beneficiary name is required.'); return; }
                  wrapSet(api.patch(`/api/customers/${customerId}/bank-accounts/${b.id}`, { holder_name: next.trim() }));
                }} className="text-xs text-primary hover:underline">Edit name</button>
              )}
              {/* A failed penny-drop must not strand the customer on the wrong
                  account: offer a retry, and allow an explicit override. */}
              {b.penny_drop_status !== 'Verified' && canEdit && (
                <button onClick={() => wrapSet(api.post(`/api/customers/${customerId}/bank-accounts/${b.id}/reverify`))}
                  className="text-xs text-primary hover:underline">Retry verification</button>
              )}
              {!b.is_active && canEdit && (
                <button onClick={async () => {
                  if (b.penny_drop_status === 'Verified') {
                    wrapSet(api.post(`/api/customers/${customerId}/bank-accounts/${b.id}/set-active`));
                    return;
                  }
                  const reason = await promptText({
                    title: `Penny-drop is ${b.penny_drop_status}, not Verified`,
                    body: 'Activate it anyway only if you have confirmed the details another way — future payouts will go here.',
                    label: 'Reason (recorded)', minLength: 3, confirmLabel: 'Activate anyway', danger: true,
                  });
                  if (!reason) return;
                  wrapSet(api.post(`/api/customers/${customerId}/bank-accounts/${b.id}/set-active`, { force: true, reason }));
                }} className="text-xs text-primary hover:underline">Make active</button>
              )}
              {/* Super-admin only. The server refuses while an NCD is pinned to
                  it or unpaid payouts point at it, and says which. */}
              {canDelete && (
                <button
                  onClick={async () => {
                    if (!await confirm({
                      title: `Delete account ${b.account_number}?`,
                      body: `${b.ifsc}. Past payments keep their record; this only removes the account from the customer's file.`,
                      confirmLabel: 'Delete', danger: true,
                    })) return;
                    wrapSet(api.del(`/api/customers/${customerId}/bank-accounts/${b.id}`));
                  }}
                  className="text-xs text-danger hover:underline">Delete</button>
              )}
            </span>
          </div>
        ))}
        {accounts.length === 0 && <div className="py-2 text-text-muted text-sm">No bank accounts yet.</div>}
      </div>

      {canEdit && (
        <div className="mt-3">
          <div className="flex gap-2 items-start flex-wrap">
            <input className={inp} placeholder="Account holder name" value={f.holder_name} onChange={(e) => set('holder_name', e.target.value)} />
            <input className={inp} placeholder="Account number" value={f.account_number} onChange={(e) => set('account_number', e.target.value.replace(/\s/g, ''))} />
            <input className={`${inp} uppercase`} placeholder="IFSC" value={f.ifsc} maxLength={11}
              onChange={(e) => set('ifsc', e.target.value.toUpperCase().replace(/\s/g, ''))} />
            <button disabled={f.account_number.length < 4 || !ifscValid || add.isPending} onClick={() => add.mutate()}
              className="text-xs bg-primary text-white rounded px-3 py-1.5 disabled:opacity-40 hover:bg-primary-hover">+ Add &amp; verify</button>
          </div>
          <div className="text-xs mt-1.5 min-h-[1rem]">
            {ifscState === 'looking' && <span className="text-text-muted">Looking up IFSC…</span>}
            {ifscState === 'found' && (
              <span className="text-success">🏦 {[f.bank_name, f.branch_name, f.branch_city].filter(Boolean).join(' · ')}</span>
            )}
            {ifscState === 'notfound' && ifscValid && <span className="text-text-muted">IFSC not found in the directory — you can still add the account.</span>}
          </div>
        </div>
      )}
    </>
  );
}
