import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from '../api/client.js';
import { useAuth } from '../auth/AuthContext.js';

/**
 * Staff locker enrollment (NCD_INTEGRATION_CONTRACT.md Part A). Drives the
 * recommended cash flow through the NCD app's own /api/lockers/* proxy (the
 * integration key stays server-side): branch → availability → customer
 * lookup/create → application → record rent + deposit → allotted.
 */
const inp = 'px-2.5 py-1.5 text-sm border border-border-strong rounded outline-none focus:border-primary';
const card = 'bg-surface border border-border rounded-lg shadow-card p-5 mb-4';
const h2 = 'text-xs font-semibold text-text-label uppercase tracking-wide mb-3';
const btn = 'bg-primary hover:bg-primary-hover disabled:opacity-40 text-white rounded px-4 py-1.5 text-sm font-semibold';
const btnGhost = 'text-xs border border-border rounded px-3 py-1.5 hover:bg-bg disabled:opacity-40';
const money = (n: unknown) => '₹' + Number(n ?? 0).toLocaleString('en-IN');

interface Size { size: string; annual_fee: number; rent_incl_gst: number; deposit: number; gst_pct: number; vacant_count: number }

export function LockerEnrollmentPage() {
  const { can } = useAuth();
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async <T,>(p: Promise<T>): Promise<T | undefined> => {
    setErr(''); setBusy(true);
    try { return await p; }
    catch (e) { setErr(e instanceof ApiError ? `${e.message}${e.detail ? ' — ' + JSON.stringify(e.detail) : ''}` : 'Failed'); }
    finally { setBusy(false); }
  };

  const branches = useQuery({ queryKey: ['locker-branches'], queryFn: () => api.get<{ branches: { id: string; name: string; address?: string }[] }>('/api/lockers/branches') });
  const [branchId, setBranchId] = useState('');
  const avail = useQuery({
    queryKey: ['locker-availability', branchId],
    queryFn: () => api.get<{ sizes: Size[] }>(`/api/lockers/availability?branch_id=${encodeURIComponent(branchId)}`),
    enabled: !!branchId,
  });
  const [size, setSize] = useState('');

  // Customer
  const [pan, setPan] = useState('');
  const [phone, setPhone] = useState('');
  const [cust, setCust] = useState<any | null>(null);      // LockerHub lookup result
  const [ncdCust, setNcdCust] = useState<any | null>(null); // matched NCD customer
  const [notFound, setNotFound] = useState(false);
  // Backing the deposit with one of the customer's existing NCDs.
  const [candidates, setCandidates] = useState<any[] | null>(null);
  const [chosenNcd, setChosenNcd] = useState('');
  // Cheque register (NCD-side only — never settles the locker on LockerHub).
  const [cheques, setCheques] = useState<any[]>([]);
  const [pendingChq, setPendingChq] = useState<any[]>([]);
  const [chqLeg, setChqLeg] = useState<'rent' | 'deposit' | null>(null);
  const [chq, setChq] = useState({ cheque_no: '', bank_name: '', amount: '', received_on: new Date().toISOString().slice(0, 10) });
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');

  // Application + payments
  const [app, setApp] = useState<any | null>(null);        // created/fetched application
  const [links, setLinks] = useState<Partial<Record<'rent' | 'deposit', { url: string; intent_no?: string; amount?: number }>>>({});

  const lookup = async () => {
    const r = await run(api.get<any>(`/api/lockers/customers/${encodeURIComponent(phone)}`));
    if (r) { setCust(r); if (r.found && r.profile) { setName(r.profile.name ?? ''); setEmail(r.profile.email ?? ''); } }
  };
  /** PAN-first: find them in NCD's book, then carry their phone into the
   * LockerHub flow (LockerHub is phone-keyed). */
  const lookupByPan = async () => {
    const r = await run(api.get<any>(`/api/lockers/customers/by-pan/${encodeURIComponent(pan)}`));
    if (!r) return;
    if (!r.found_in_ncd) { setCust(null); setNotFound(true); return; }
    setNotFound(false);
    const c = r.customer;
    setNcdCust(c);
    setPhone(String(c.phone ?? '').replace(/\D/g, '').slice(-10));
    setName(c.full_name ?? '');
    setEmail(c.email ?? '');
    // r.locker is their LockerHub record (null if unknown there yet).
    setCust(r.locker ?? { found: false });
  };
  const saveCustomer = async () => {
    const r = await run(api.post<any>('/api/lockers/customers', { phone, name, email: email || undefined }));
    if (r?.success) setCust({ found: true, phone, profile: { name, email } });
  };
  const createApp = async () => {
    const r = await run(api.post<any>('/api/lockers/applications', { phone, name: name || undefined, email: email || undefined, branch_id: branchId, locker_size: size }));
    if (r?.application_id) { setApp(r); setCheques([]); }
  };
  const refreshApp = async () => {
    if (!app?.application_id) return;
    const r = await run(api.get<any>(`/api/lockers/applications/${encodeURIComponent(app.application_id)}`));
    if (r) setApp((a: any) => ({ ...a, ...r }));
  };
  /** This customer's live NCDs and how much of each is still free to pledge. */
  const loadCandidates = async () => {
    if (!ncdCust) return;
    const r = await run(api.get<any>(`/api/lockers/deposit-links/candidates?customer_id=${ncdCust.id}`));
    if (r) setCandidates(r.candidates ?? []);
  };
  /** Pledge the chosen NCD against this locker's deposit leg. The amount is
   * LockerHub's own deposit figure — never typed here. */
  const linkNcd = async () => {
    if (!chosenNcd || !app?.application_id) return;
    const r = await run(api.post<any>('/api/lockers/deposit-links', {
      application_id: Number(chosenNcd),
      lockerhub_application_id: String(app.application_id),
    }));
    if (r) { setChosenNcd(''); setCandidates(null); await refreshApp(); }
  };
  // ── Cheque register ────────────────────────────────────────────────────
  const loadCheques = async () => {
    if (!app?.application_id) return;
    const r = await run(api.get<any>(`/api/lockers/cheques?application_id=${encodeURIComponent(app.application_id)}`));
    if (r) setCheques(r.rows ?? []);
  };
  const loadPendingCheques = async () => {
    const r = await run(api.get<any>('/api/lockers/cheques?status=Pending'));
    if (r) setPendingChq(r.rows ?? []);
  };
  const saveCheque = async () => {
    if (!chqLeg || !app?.application_id) return;
    const r = await run(api.post<any>('/api/lockers/cheques', {
      lockerhub_application_id: String(app.application_id),
      customer_id: ncdCust?.id ?? undefined,
      leg: chqLeg,
      amount: Number(chq.amount),
      cheque_no: chq.cheque_no.trim(),
      bank_name: chq.bank_name.trim() || undefined,
      received_on: chq.received_on,
    }));
    if (r) {
      setChqLeg(null);
      setChq({ cheque_no: '', bank_name: '', amount: '', received_on: new Date().toISOString().slice(0, 10) });
      await loadCheques(); await loadPendingCheques();
    }
  };
  const clearCheque = async (id: number) => {
    const on = window.prompt('Date the funds cleared in the bank (YYYY-MM-DD):', new Date().toISOString().slice(0, 10));
    if (!on) return;
    const ref = window.prompt('Bank reference (optional):') ?? '';
    const r = await run(api.post<any>(`/api/lockers/cheques/${id}/clear`, { cleared_on: on, reference: ref.trim() || undefined }));
    if (r) { await loadCheques(); await loadPendingCheques(); }
  };
  const bounceCheque = async (id: number) => {
    const reason = window.prompt('Why did it not clear? (bounced / withdrawn)');
    if (!reason || reason.trim().length < 2) return;
    const r = await run(api.post<any>(`/api/lockers/cheques/${id}/bounce`, { reason: reason.trim() }));
    if (r) { await loadCheques(); await loadPendingCheques(); }
  };
  // The register loads on mount so staff land on "what's awaiting clearance".
  useEffect(() => { void loadPendingCheques(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);
  const chequeFor = (leg: string) => cheques.find((c) => c.leg === leg && c.status === 'Pending')
    ?? cheques.find((c) => c.leg === leg && c.status === 'Cleared');
  // Lockers and NCD are ONLINE-ONLY (contract v1.2 §A10): cash/cheque/transfer
  // are refused for these products from every caller. Collect via A9
  // payment-link; settlement lands on LockerHub's Easebuzz callback and
  // advances the application, so we poll A8 rather than confirming here.
  const getPaymentLink = async (leg: 'rent' | 'deposit') => {
    const r = await run(api.post<any>(`/api/lockers/applications/${encodeURIComponent(app.application_id)}/payment-link`, { leg }));
    if (r?.checkout_url) setLinks((l) => ({ ...l, [leg]: { url: r.checkout_url, intent_no: r.intent_no, amount: r.amount } }));
  };
  const allocate = async () => { await run(api.post(`/api/lockers/applications/${encodeURIComponent(app.application_id)}/allocate`, {})); await refreshApp(); };

  const legState = (leg: string) => app?.legs?.[leg];
  const allotment = app?.allotment ?? (app?.pricing ? null : undefined);
  const chosen = (avail.data?.sizes ?? []).find((s) => s.size === size);
  /** Why "Create application" can't be pressed yet, or '' when it can.
   * LockerHub keys everything on the phone, so that's the hard requirement —
   * a PAN match fills it in, a phone lookup supplies it directly. */
  const createBlocker =
    phone.length < 10 ? 'Look the customer up by PAN or phone first — LockerHub needs their 10-digit phone.'
    : !name.trim() ? "Enter the customer's full name."
    : '';

  return (
    <div className="w-full max-w-3xl">
      <h1 className="text-xl font-bold tracking-tight m-0">Locker enrollment</h1>
      <p className="text-sm text-text-muted mt-1 mb-4">Enroll a customer for a locker end-to-end. Pricing and allotment are handled by LockerHub; a locker is allotted automatically once rent and deposit are both settled.</p>
      {err && <div className="text-xs text-danger bg-[color:var(--danger-bg)] rounded px-3 py-2 mb-3">{err}</div>}

      {/* Cheques taken but not yet cleared. NCD-side bookkeeping only — the
          locker stays unsettled until the leg is actually paid. */}
      {pendingChq.length > 0 && (
        <div className={card}>
          <h2 className={h2}>Cheques awaiting clearance</h2>
          <p className="text-xs text-text-muted -mt-2 mb-3">
            Recorded in NCD for your books. A cleared cheque does <b>not</b> settle the locker — complete it in <b>LockerHub → Tenants</b> (mark the row Paid, method = cheque).
            <b> Never open the payment link for a cheque customer</b>: it is a live payment page and would collect the money a second time.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="text-left text-xs text-text-label uppercase tracking-wide border-b border-border">
                  <th className="py-2 pr-3">Customer</th><th className="py-2 pr-3">Locker app</th><th className="py-2 pr-3">Leg</th>
                  <th className="py-2 pr-3 text-right">Amount</th><th className="py-2 pr-3">Cheque</th><th className="py-2 pr-3">Received</th><th />
                </tr>
              </thead>
              <tbody>
                {pendingChq.map((q) => (
                  <tr key={q.id} className="border-b border-border last:border-0">
                    <td className="py-2 pr-3">{q.customer_name ?? '—'} <span className="font-mono text-xs text-text-muted">{q.customer_code ?? ''}</span></td>
                    <td className="py-2 pr-3 font-mono text-xs">{q.lockerhub_application_id}</td>
                    <td className="py-2 pr-3">{q.leg}</td>
                    <td className="py-2 pr-3 text-right mono">{money(q.amount)}</td>
                    <td className="py-2 pr-3 font-mono text-xs">{q.cheque_no}{q.bank_name ? ` · ${q.bank_name}` : ''}</td>
                    <td className="py-2 pr-3 text-xs text-text-muted">{q.received_on}</td>
                    <td className="py-2 text-right whitespace-nowrap">
                      {can('applications:confirm-collection') ? (
                        <>
                          <button className="text-xs text-primary hover:underline mr-3" disabled={busy} onClick={() => clearCheque(q.id)}>Funds cleared</button>
                          <button className="text-xs text-danger hover:underline" disabled={busy} onClick={() => bounceCheque(q.id)}>Did not clear</button>
                        </>
                      ) : <span className="text-xs text-text-muted">awaiting confirmation</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 1 — Branch + size */}
      <div className={card}>
        <h2 className={h2}>1 · Branch &amp; locker size</h2>
        <div className="flex flex-wrap gap-2 items-center">
          <select className={inp} value={branchId} onChange={(e) => { setBranchId(e.target.value); setSize(''); setApp(null); }}>
            <option value="">Branch…</option>
            {(branches.data?.branches ?? []).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
          <select className={inp} value={size} disabled={!branchId || avail.isLoading} onChange={(e) => { setSize(e.target.value); setApp(null); }}>
            <option value="">{avail.isLoading ? 'Loading…' : 'Size…'}</option>
            {(avail.data?.sizes ?? []).map((s) => <option key={s.size} value={s.size} disabled={s.vacant_count <= 0}>{s.size} · {money(s.rent_incl_gst)} rent · {money(s.deposit)} deposit · {s.vacant_count} vacant</option>)}
          </select>
        </div>
        {chosen && (
          <div className="text-xs text-text-muted mt-2">Rent (incl. GST {chosen.gst_pct}%): <b className="text-text">{money(chosen.rent_incl_gst)}</b> · Deposit: <b className="text-text">{money(chosen.deposit)}</b></div>
        )}
      </div>

      {/* 2 — Customer */}
      {branchId && size && (
        <div className={card}>
          <h2 className={h2}>2 · Customer</h2>
          {/* PAN-first: staff enrol against the ID document in hand. LockerHub is
              phone-keyed, so the PAN match fills the phone in for the rest of the flow. */}
          <div className="flex flex-wrap gap-2 items-center">
            <input className={`${inp} uppercase`} placeholder="PAN (e.g. ABCDE1234F)" value={pan} maxLength={10}
              onChange={(e) => { setPan(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10)); setCust(null); setNcdCust(null); setNotFound(false); }} />
            <button className={btnGhost} disabled={pan.length !== 10 || busy} onClick={lookupByPan}>Look up</button>
            <span className="text-xs text-text-muted">or by phone</span>
            <input className={inp} placeholder="Phone (10 digits)" value={phone} maxLength={10}
              onChange={(e) => { setPhone(e.target.value.replace(/\D/g, '')); setCust(null); }} />
            <button className={btnGhost} disabled={phone.length < 10 || busy} onClick={lookup}>Look up</button>
          </div>
          {ncdCust && (
            <div className="text-xs text-text-muted mt-2">
              Matched <b className="text-text">{ncdCust.full_name}</b> <span className="font-mono">{ncdCust.customer_code}</span>
              {ncdCust.phone
                ? <> · phone <span className="font-mono">{ncdCust.phone}</span></>
                : <> · <span className="text-danger">no phone on file — enter one above before continuing</span></>}
            </div>
          )}
          {notFound && (
            <div className="text-xs text-warn mt-2">No customer with that PAN in NCD — look them up by phone, or enrol the customer first.</div>
          )}
          {cust && (
            <div className="mt-3 grid grid-cols-2 gap-2 max-w-lg">
              <input className={inp} placeholder="Full name" value={name} onChange={(e) => setName(e.target.value)} />
              <input className={inp} placeholder="Email (optional)" value={email} onChange={(e) => setEmail(e.target.value)} />
              <div className="col-span-2 flex items-center gap-2">
                <span className={`text-xs rounded px-1.5 py-0.5 ${cust.found ? 'bg-[color:var(--success-bg)] text-success' : 'bg-bg text-text-muted'}`}>{cust.found ? 'Existing customer' : 'New — will be created'}</span>
                {!cust.found && <button className={btnGhost} disabled={!name.trim() || busy} onClick={saveCustomer}>Save customer</button>}
              </div>
            </div>
          )}
        </div>
      )}

      {/* 3 — Application. Rendered as soon as a branch + size are picked, NOT
          only once a customer resolves: hiding the whole step made the submit
          invisible, and a PAN that isn't in NCD (cust stays null) left staff on
          a dead end with no button anywhere. It stays disabled with the reason
          spelled out until the prerequisites are met. */}
      {branchId && size && (
        <div className={card}>
          <h2 className={h2}>3 · Locker application</h2>
          {!app ? (
            <div className="flex flex-wrap items-center gap-2">
              <button className={btn} disabled={!!createBlocker || busy} onClick={createApp}>Create application</button>
              {createBlocker && <span className="text-xs text-text-muted">{createBlocker}</span>}
            </div>
          ) : (
            <div className="text-sm">
              <div className="flex items-center gap-2 mb-2">
                <span className="font-mono text-xs">{app.application_no ?? app.application_id}</span>
                <span className="text-xs rounded px-1.5 py-0.5 bg-bg">{app.status}</span>
                <button className={`${btnGhost} ml-auto`} disabled={busy} onClick={refreshApp}>Refresh</button>
              </div>
              {app.pricing && <div className="text-xs text-text-muted">Rent {money(app.pricing.rent_incl_gst)} · Deposit {money(app.pricing.deposit)}</div>}
            </div>
          )}
        </div>
      )}

      {/* 4 — Payments (online only) */}
      {app?.application_id && app.status !== 'approved' && !allotment && (
        <div className={card}>
          <h2 className={h2}>4 · Collect payment (online)</h2>
          <div className="flex flex-col gap-2">
            {(['rent', 'deposit'] as const).map((leg) => {
              const st = legState(leg);
              const settled = st?.settled === true;
              const link = links[leg];
              return (
                <div key={leg} className="flex flex-wrap gap-2 items-center">
                  <button className={btnGhost} disabled={busy || settled} onClick={() => getPaymentLink(leg)}>
                    {settled ? `✓ ${leg} settled` : `${link ? 'New link' : 'Payment link'} · ${leg}${st?.amount ? ' · ' + money(st.amount) : ''}`}
                  </button>
                  {!settled && link && (
                    <>
                      <input className={`${inp} flex-1 min-w-[16rem] font-mono text-xs`} readOnly value={link.url} onFocus={(e) => e.currentTarget.select()} />
                      <button className={btnGhost} onClick={() => navigator.clipboard?.writeText(link.url)}>Copy</button>
                      <a className={btnGhost} href={link.url} target="_blank" rel="noopener noreferrer">Open</a>
                    </>
                  )}
                  {/* Back the deposit with one of this customer's NCDs. The
                      amount is LockerHub's own deposit figure — staff pick the
                      investment, never the number. */}
                  {leg === 'deposit' && !settled && (
                    ncdCust ? (
                      candidates === null ? (
                        <button className={btnGhost} disabled={busy} onClick={loadCandidates}>or back it with an NCD investment…</button>
                      ) : candidates.length === 0 ? (
                        <span className="text-xs text-text-muted">No live NCD of {ncdCust.full_name} has free amount to pledge.</span>
                      ) : (
                        <>
                          <select className={inp} value={chosenNcd} onChange={(e) => setChosenNcd(e.target.value)}>
                            <option value="">Back with an NCD…</option>
                            {candidates.map((c) => (
                              <option key={c.id} value={String(c.id)} disabled={c.free <= 0}>
                                {c.application_no} · {c.series_code} · {money(c.free)} free
                              </option>
                            ))}
                          </select>
                          <button className={btnGhost} disabled={!chosenNcd || busy} onClick={linkNcd}>Link deposit</button>
                        </>
                      )
                    ) : (
                      <span className="text-xs text-text-muted">Look the customer up by PAN to back this deposit with an NCD.</span>
                    )
                  )}
                  {/* Cheque register — OUR books only. Never settles the leg on
                      LockerHub, so the payment link / NCD-backing stays required. */}
                  {!settled && (() => {
                    const q = chequeFor(leg);
                    if (q) return (
                      <span className="text-xs">
                        <span className={`rounded px-1.5 py-0.5 ${q.status === 'Cleared' ? 'bg-[color:var(--success-bg)] text-success' : 'bg-[color:var(--warn-bg)] text-warn'}`}>
                          Cheque {q.cheque_no} · {q.status === 'Cleared' ? `cleared ${q.cleared_on}` : 'awaiting clearance'}
                        </span>
                        <span className="text-text-muted ml-1">— settle in LockerHub → Tenants (method = cheque)</span>
                      </span>
                    );
                    return <button className={btnGhost} disabled={busy} onClick={() => { setChqLeg(leg); setChq((c) => ({ ...c, amount: String(st?.amount ?? '') })); }}>Record cheque…</button>;
                  })()}
                </div>
              );
            })}
            {chqLeg && (
              <div className="flex flex-wrap gap-2 items-end border-t border-border pt-3 mt-1">
                <label className="text-xs text-text-muted">Cheque no<input className={`${inp} block mt-1 w-40`} value={chq.cheque_no} onChange={(e) => setChq({ ...chq, cheque_no: e.target.value })} autoFocus /></label>
                <label className="text-xs text-text-muted">Bank<input className={`${inp} block mt-1 w-40`} value={chq.bank_name} onChange={(e) => setChq({ ...chq, bank_name: e.target.value })} /></label>
                <label className="text-xs text-text-muted">Amount<input className={`${inp} block mt-1 w-32`} type="number" value={chq.amount} onChange={(e) => setChq({ ...chq, amount: e.target.value })} /></label>
                <label className="text-xs text-text-muted">Received on<input className={`${inp} block mt-1`} type="date" value={chq.received_on} onChange={(e) => setChq({ ...chq, received_on: e.target.value })} /></label>
                <button className={btn} disabled={busy || !chq.cheque_no.trim() || !(Number(chq.amount) > 0)} onClick={saveCheque}>Record {chqLeg} cheque</button>
                <button className={btnGhost} onClick={() => setChqLeg(null)}>Cancel</button>
                <p className="text-xs text-text-muted w-full m-0">Recorded in NCD for your books. The locker is <b>not</b> settled by this. Once the cheque clears, settle it in <b>LockerHub → Tenants</b> (mark the row Paid, method = cheque). <b>Do not open the payment link</b> for a cheque customer — it is a live payment page and would take a second real payment.</p>
              </div>
            )}
          </div>
          <div className="flex items-center gap-2 mt-3">
            <button className={btnGhost} disabled={busy} onClick={refreshApp}>Check payment status</button>
            <p className="text-xs text-text-muted m-0">
              Send the link to the customer. Settlement lands automatically and the locker auto-allots once both legs are settled — cash, cheque and transfer are not accepted for lockers.
            </p>
          </div>
        </div>
      )}

      {/* 5 — Allotment */}
      {app && (app.status === 'approved' || app.allotment) && (
        <div className={`${card} border-success`}>
          <h2 className={h2}>✓ Allotted</h2>
          {app.allotment ? (
            <div className="text-sm">Locker <b>{app.allotment.locker_number}</b> ({app.allotment.size}) · lease {String(app.allotment.lease_start).slice(0, 10)} → {String(app.allotment.lease_end).slice(0, 10)}</div>
          ) : (
            <div className="text-sm flex items-center gap-2">Payments settled — allotment pending. <button className={btnGhost} disabled={busy} onClick={allocate}>Allocate locker</button></div>
          )}
        </div>
      )}
    </div>
  );
}
