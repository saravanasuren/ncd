import { useParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { formatINR } from '@new-wealth/shared';
import { api } from '../api/client.js';
import { LockerAuthorisedUsers } from '../components/LockerAuthorisedUsers.js';

/**
 * Complete locker profile (owner 2026-08-07) — everything about one locker in
 * one place: the LockerHub-live locker/lease/rent/deposit + per-leg payment
 * status and references, layered with NCD's backing, cheques + clearance, and
 * waivers. Reached from a tenant's name on Locker Tenants.
 */

const card = 'bg-surface border border-border rounded-lg shadow-card p-5 mb-4';
const h2 = 'text-xs font-semibold text-text-label uppercase tracking-wide mb-3';
const pick = (o: any, ...keys: string[]) => { for (const k of keys) if (o?.[k] != null && o[k] !== '') return o[k]; return null; };

/** LockerHub records a leg's payment either as a `legs.<leg>` block or a row in
 *  `payments[]` (purpose = rent/deposit). Read whichever is present. */
function legPayment(lh: any, leg: 'deposit' | 'rent') {
  const legBlock = lh?.legs?.[leg] ?? {};
  const pay = (lh?.payments ?? []).find((p: any) => String(p.purpose ?? p.leg ?? '').toLowerCase() === leg) ?? {};
  const status = pick(legBlock, 'status') ?? pick(pay, 'status', 'offline_status') ?? (legBlock.settled || pay.settled ? 'paid' : null);
  return {
    amount: Number(pick(legBlock, 'amount') ?? pick(pay, 'amount') ?? 0) || null,
    status: status ? String(status) : null,
    reference: pick(pay, 'reference', 'utr', 'intent_no') ?? null,
    method: pick(pay, 'payment_method', 'method') ?? null,
    date: pick(pay, 'paid_at', 'settled_at', 'date') ?? null,
  };
}

const isPaid = (s: string | null) => !!s && /paid|settled|success|complete/i.test(s);
const badge = (ok: boolean) => `text-xs rounded px-1.5 py-0.5 ${ok ? 'bg-[color:var(--success-bg)] text-success' : 'bg-[color:var(--warn-bg)] text-warn'}`;

export function LockerProfilePage() {
  const { applicationId } = useParams();
  const { data, isLoading, error } = useQuery({
    queryKey: ['locker-profile', applicationId],
    queryFn: () => api.get<any>(`/api/lockers/profile?application_id=${encodeURIComponent(String(applicationId))}`),
  });

  if (isLoading) return <div className="text-text-muted">Loading locker…</div>;
  if (error || !data) return <div className="text-danger">Couldn’t load this locker.</div>;

  const lh = data.lockerhub;
  // NCD lockers are rent-only (owner 2026-08-22) — no deposit is ever collected,
  // so the deposit leg (and its auto-waiver) is never shown here.
  const rent = legPayment(lh, 'rent');
  const lockerNo = pick(lh, 'locker_no', 'locker_number') ?? pick(lh?.allotment, 'locker_number', 'locker_no') ?? data.pledges[0]?.locker_no ?? '—';
  const size = pick(lh, 'locker_size', 'size') ?? data.pledges[0]?.locker_size ?? '—';
  const branch = pick(lh, 'branch_name', 'branch') ?? '—';
  const status = pick(lh, 'account_status', 'status') ?? '—';
  const esignStatus = pick(data.esign, 'status', 'esign_status') ?? pick(lh, 'esign_status') ?? null;
  const esignId = pick(data.esign, 'esign_id', 'id') ?? null;

  const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
    <div className="flex gap-3 py-1.5 border-b border-border last:border-0 text-sm">
      <div className="w-40 shrink-0 text-text-muted">{label}</div>
      <div className="flex-1 break-words">{children}</div>
    </div>
  );

  return (
    <div className="w-full max-w-4xl">
      <Link to="/app/locker-tenants" className="text-xs text-text-muted hover:text-primary">← Locker tenants</Link>
      <div className="flex items-center gap-3 mt-1 mb-1 flex-wrap">
        <h1 className="text-xl font-bold tracking-tight m-0">Locker {String(lockerNo)}</h1>
        <span className="text-xs rounded px-2 py-0.5 bg-bg">{String(size)}</span>
        <span className="text-xs rounded px-2 py-0.5 bg-bg">{String(status)}</span>
        <span className="font-mono text-xs text-text-muted">{data.locker_application_id}</span>
      </div>
      {data.customer && (
        <p className="text-sm text-text-muted mb-4">
          <Link to={`/app/customers/${data.customer.id}`} className="text-primary hover:underline">{data.customer.full_name}</Link>
          {' '}<span className="font-mono">{data.customer.customer_code}</span>{data.customer.phone ? ` · ${data.customer.phone}` : ''}
        </p>
      )}

      {data.lockerhub_error && (
        <div className="text-xs text-warn mb-3 bg-[color:var(--warn-bg)] rounded px-3 py-2">
          Couldn’t reach LockerHub for the live locker + payment details ({String(data.lockerhub_error).slice(0, 100)}). NCD-side records below are still shown.
        </div>
      )}

      {/* Locker + lease */}
      <div className={card}>
        <h2 className={h2}>Locker</h2>
        <Row label="Branch">{String(branch)}</Row>
        <Row label="Locker number">{String(lockerNo)}</Row>
        <Row label="Size">{String(size)}</Row>
        <Row label="Status">{String(status)}</Row>
        {pick(lh, 'lease_start') && <Row label="Lease start">{String(pick(lh, 'lease_start'))}</Row>}
        {pick(lh, 'lease_expires_on', 'lease_end') && <Row label="Lease expires">{String(pick(lh, 'lease_expires_on', 'lease_end'))}</Row>}
        {pick(lh?.allotment, 'allotted_on', 'date') && <Row label="Allotted on">{String(pick(lh.allotment, 'allotted_on', 'date'))}</Row>}
      </div>

      {/* Payments — reflected live from LockerHub */}
      <div className={card}>
        <h2 className={h2}>Payments</h2>
        {[{ leg: 'Rent', p: rent }].map(({ leg, p }) => (
          <div key={leg} className="py-2 border-b border-border last:border-0">
            <div className="flex items-center gap-2 flex-wrap text-sm">
              <span className="w-40 shrink-0 text-text-muted">{leg}</span>
              <span className="mono font-medium">{p.amount != null ? formatINR(p.amount) : '—'}</span>
              {p.status && <span className={badge(isPaid(p.status))}>{isPaid(p.status) ? 'Paid' : `${p.status} — pending`}</span>}
              {!p.status && <span className="text-xs text-text-muted">status unknown</span>}
            </div>
            {(p.reference || p.method || p.date) && (
              <div className="text-xs text-text-muted mt-1 ml-40 pl-3">
                {p.method ? `${p.method} · ` : ''}{p.reference ? `ref ${p.reference}` : ''}{p.date ? ` · ${String(p.date).slice(0, 10)}` : ''}
              </div>
            )}
          </div>
        ))}
        {!lh && !data.lockerhub_error && <div className="text-sm text-text-muted">No live payment data.</div>}
      </div>

      {/* NCD backing */}
      {data.pledges.length > 0 && (
        <div className={card}>
          <h2 className={h2}>NCD backing</h2>
          {data.pledges.map((p: any) => (
            <div key={p.id} className="flex flex-wrap items-center gap-x-3 py-1.5 border-b border-border last:border-0 text-sm">
              <Link to={`/app/applications/${p.application_id}`} className="text-primary hover:underline font-mono text-xs">{p.application_no}</Link>
              <span className="mono">{formatINR(p.linked_amount)}</span>
              <span className={`text-xs rounded px-1.5 py-0.5 ${p.status === 'active' ? 'bg-[color:var(--warn-bg)] text-warn' : 'bg-bg text-text-muted'}`}>{p.status}</span>
              {p.released_reason && <span className="text-xs text-text-muted">released: {p.released_reason}</span>}
            </div>
          ))}
        </div>
      )}

      {/* Cheques + clearance */}
      {data.cheques.length > 0 && (
        <div className={card}>
          <h2 className={h2}>Cheques</h2>
          {data.cheques.map((q: any) => (
            <div key={q.id} className="flex flex-wrap items-center gap-x-3 py-1.5 border-b border-border last:border-0 text-sm">
              <span className="font-mono text-xs">{q.cheque_no}{q.bank_name ? ` · ${q.bank_name}` : ''}</span>
              <span className="text-xs text-text-muted">{q.leg}</span>
              <span className="mono">{formatINR(q.amount)}</span>
              <span className={`text-xs rounded px-1.5 py-0.5 ${q.status === 'Cleared' ? 'bg-[color:var(--success-bg)] text-success' : q.status === 'Bounced' ? 'bg-[color:var(--danger-bg)] text-danger' : 'bg-[color:var(--warn-bg)] text-warn'}`}>{q.status}</span>
              {q.status === 'Cleared' && !q.lockerhub_settled_at && <span className="text-xs text-danger">cleared, leg not settled on LockerHub</span>}
              {q.reference && <span className="text-xs text-text-muted">ref {q.reference}</span>}
              {q.cleared_on && <span className="text-xs text-text-muted">cleared {q.cleared_on}</span>}
            </div>
          ))}
        </div>
      )}

      {/* Waivers — rent only. The deposit is auto-waived 100% behind the scenes
          (rent-only policy) and is never surfaced: no deposit, no deposit waiver
          on screen. */}
      {data.fee_waivers.filter((w: any) => String(w.leg).toLowerCase() !== 'deposit').length > 0 && (
        <div className={card}>
          <h2 className={h2}>Fee waivers</h2>
          {data.fee_waivers.filter((w: any) => String(w.leg).toLowerCase() !== 'deposit').map((w: any) => (
            <div key={w.id} className="flex flex-wrap items-center gap-x-3 py-1.5 border-b border-border last:border-0 text-sm">
              <span className="text-xs text-text-muted">{w.leg}</span>
              <span className="mono">{w.waiver_pct != null ? `${w.waiver_pct}%` : w.waiver_amount != null ? formatINR(w.waiver_amount) : '—'}</span>
              <span className={`text-xs rounded px-1.5 py-0.5 ${w.status === 'Approved' ? 'bg-[color:var(--success-bg)] text-success' : w.status === 'Rejected' ? 'bg-[color:var(--danger-bg)] text-danger' : 'bg-[color:var(--warn-bg)] text-warn'}`}>{w.status}</span>
              {w.reason && <span className="text-xs text-text-muted">{w.reason}</span>}
              {w.status === 'Approved' && !w.lockerhub_applied_at && <span className="text-xs text-danger">approved, not yet in force on LockerHub</span>}
            </div>
          ))}
        </div>
      )}

      {/* Agreement / e-sign */}
      <div className={card}>
        <h2 className={h2}>Agreement &amp; e-sign</h2>
        <Row label="e-Sign status">{esignStatus ? String(esignStatus) : <span className="text-text-muted">not started</span>}</Row>
        {esignId && (
          <Row label="Signed agreement">
            <a href={`/api/lockers/agreements/${encodeURIComponent(String(esignId))}/pdf`} target="_blank" rel="noreferrer" className="text-primary hover:underline">Download PDF</a>
          </Row>
        )}
        <div className="mt-3">
          <Link to={`/app/locker-enrollment?application_id=${encodeURIComponent(data.locker_application_id)}`} className="text-xs text-primary hover:underline">
            Open in enrollment (payments, allotment, e-sign actions) →
          </Link>
        </div>
      </div>

      {/* Authorised users — add people the holder authorises to operate this
          locker; each needs the holder's e-signed consent (owner 2026-08-22).
          Post-allotment only: shown once the locker has a number. */}
      <div className={card}>
        {String(lockerNo) !== '—'
          ? <LockerAuthorisedUsers applicationId={String(data.locker_application_id)} customerId={data.customer?.id ?? null} />
          : <>
              <div className="text-xs font-semibold text-text-label uppercase tracking-wide mb-2">Authorised users</div>
              <p className="text-sm text-text-muted m-0">Available once the locker is allotted.</p>
            </>}
      </div>
    </div>
  );
}
