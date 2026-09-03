import { useState, useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../api/client.js';
import { useAuth } from '../auth/AuthContext.js';
import { useConfirm } from '../components/Confirm.js';
import { LockerAuthorisedUsers } from '../components/LockerAuthorisedUsers.js';
import { rentWaiverBreakdown } from '@new-wealth/shared';

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

// rent_waiver_pct / rent_waiver_amount / rent_payable are the rent-only waiver
// breakdown from the LockerHub pricing CR (owner 2026-07-24). OPTIONAL: until
// LockerHub ships them, the UI shows the plain rent — NCD never computes the
// waiver itself, because LockerHub's payment link collects THEIR figure and a
// locally-invented discount would contradict the amount actually charged.
interface Size {
  size: string; annual_fee: number; rent_incl_gst: number; deposit: number; gst_pct: number; vacant_count: number;
  rent_waiver_pct?: number; rent_waiver_amount?: number; rent_payable?: number;
}

export function LockerEnrollmentPage() {
  const { confirm, promptText } = useConfirm();
  const { can, user } = useAuth();
  // Allocation is STAFF-ONLY on LockerHub's side (§A11): an asserted role of
  // agent/lead_agent/rm/relationship_manager is refused with 403 staff_only.
  // We send our role verbatim, so our 'agent' is the one that gets blocked —
  // don't offer them the button in the first place.
  const canAllocate = user?.role !== 'agent';
  const [err, setErr] = useState('');
  // Positive feedback, separate from the red error line — a waiver that went
  // through is news worth showing, not an error.
  const [note, setNote] = useState('');
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
  // Cheque register (NCD-side only — never settles the locker on LockerHub).
  const [cheques, setCheques] = useState<any[]>([]);
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

  // Arriving from a customer's page with ?pan=… — they have already picked the
  // person, so run the lookup for them rather than making them key the PAN of
  // someone they were just looking at. Once only: a ref, not a state flag, so a
  // staff member who then searches for somebody else is not yanked back.
  const [params] = useSearchParams();
  const prefilled = useRef(false);
  useEffect(() => {
    const p = (params.get('pan') ?? '').trim().toUpperCase();
    if (!p || prefilled.current) return;
    prefilled.current = true;
    setPan(p);
    void run(api.get<any>(`/api/lockers/customers/by-pan/${encodeURIComponent(p)}`)).then((r) => {
      if (!r) return;
      if (!r.found_in_ncd) { setNotFound(true); return; }
      const c = r.customer;
      setNcdCust(c);
      setPhone(String(c.phone ?? '').replace(/\D/g, '').slice(-10));
      setName(c.full_name ?? '');
      setEmail(c.email ?? '');
      setCust(r.locker ?? { found: false });
    });
  }, [params]);

  /**
   * Re-open an EXISTING locker application: /app/locker-enrollment?application_id=…
   *
   * Without this the page could only ever hold an application it had just
   * created, so everything downstream of creation — record a payment, allot,
   * send the agreement for e-Signing, download the signed copy — survived only
   * until the staff member navigated away. A locker allotted yesterday, or by
   * a colleague, could never be e-Signed at all: the button was rendered, but
   * nothing could put an application on the page for it to act on (owner
   * 2026-08-03: "im not finding the esign").
   *
   * Loads through the same GET the refresh button uses, so a resumed
   * application is the identical shape as a freshly created one — legs,
   * allotment, KYC and all — and the rest of the page needs no special case.
   */
  const resumed = useRef(false);
  useEffect(() => {
    const id = (params.get('application_id') ?? '').trim();
    if (!id || resumed.current) return;
    resumed.current = true;
    void run(api.get<any>(`/api/lockers/applications/${encodeURIComponent(id)}`)).then((r) => {
      if (!r?.application_id) return;
      setApp(r);
      // Carry the identity across too, so step 2 shows who this is rather than
      // an empty form sitting above a live application.
      if (r.phone) setPhone(String(r.phone).replace(/\D/g, '').slice(-10));
      if (r.name) setName(String(r.name));
      if (r.email) setEmail(String(r.email));
      if (r.branch_id) setBranchId(String(r.branch_id));
      if (r.locker_size) setSize(String(r.locker_size));
      // Restore the locker chosen at enrolment (owner 2026-08-22) so allotment
      // uses it instead of re-asking. If it was since taken, `preferred` won't
      // resolve and the picker appears — the one case a re-pick is warranted.
      if (r.intended_locker?.locker_id) setLockerId(String(r.intended_locker.locker_id));
      setCust({ found: true, phone: r.phone, profile: { name: r.name, email: r.email } });
    });
  }, [params]);

  const saveCustomer = async () => {
    // customer_id makes the server attach the full profile from our own book —
    // address, DOB, the lot. LockerHub does not backfill customers whose
    // applications predate their fix, so without this their record stays a
    // bare name and phone (2026-07-31).
    const r = await run(api.post<any>('/api/lockers/customers', {
      phone, name, email: email || undefined,
      ...(ncdCust?.id ? { customer_id: Number(ncdCust.id) } : {}),
    }));
    if (r?.success) setCust({ found: true, phone, profile: { name, email } });
  };
  const createApp = async () => {
    // customer_id is what makes the server attach the applicant block — the
    // address, KYC, nominee and bank it assembles from our own book. Without
    // it LockerHub receives a bare phone + name, the tenancy sits at
    // kyc_pending, and a staff member has to open LockerHub and key the
    // profile in by hand: the exact thing the applicant block exists to avoid
    // (owner, 29 Jul 2026). We already know who they are — send it.
    const chosen = (vacant.data?.lockers ?? []).find((l) => l.id === lockerId);
    const r = await run(api.post<any>('/api/lockers/applications', {
      phone, name: name || undefined, email: email || undefined,
      branch_id: branchId, locker_size: size,
      ...(ncdCust?.id ? { customer_id: Number(ncdCust.id) } : {}),
      // The chosen locker (now mandatory) — persisted so a resume allots it.
      ...(lockerId ? { locker_id: lockerId, locker_number: chosen?.locker_number } : {}),
    }));
    if (r?.application_id) { setApp(r); setCheques([]); setFeeWaivers([]); }
  };
  const refreshApp = async () => {
    if (!app?.application_id) return;
    const r = await run(api.get<any>(`/api/lockers/applications/${encodeURIComponent(app.application_id)}`));
    // Never let a refresh REMOVE the allotment — LockerHub's GET for an
    // esign_pending application does not echo the allotment block, so a plain
    // merge would blank it and the whole allotment + e-Sign card would vanish
    // mid-signing (owner 2026-08-22). Keep the allotment we already have.
    if (r) setApp((a: any) => ({ ...a, ...r, allotment: r.allotment ?? a.allotment }));
  };
  /**
   * Discard an application entered by mistake (owner 2026-08-20). Super-Admin
   * only, and it mirrors the honest scope of the endpoint: it HIDES the
   * application from NCD — from this page, the customer's profile note and the
   * tenants roster — but does not delete it on LockerHub, which exposes no
   * delete for an application at all. Offered only before allotment: an
   * allotted locker is a live tenancy and is removed from the Tenants page.
   */
  const submitRemove = (reason: string, forceLocal: boolean) =>
    api.post<any>(`/api/lockers/applications/${encodeURIComponent(app.application_id)}/remove`, {
      reason,
      ...(forceLocal ? { force_local: true } : {}),
      tenant_name: name.trim() || undefined,
      locker_no: app.allotment?.locker_number || undefined,
      branch_id: String(app.branch_id ?? branchId) || undefined,
    });
  const afterRemoved = (r: any) => {
    setApp(null); setLinks({}); setCheques([]); setFeeWaivers([]); setErr('');
    setNote(r?.lockerhub_kept
      ? 'Removed from NCD’s view. LockerHub STILL holds this application — any money collected on it must be settled with LockerHub separately.'
      : r?.locker_released
        ? `Cancelled on LockerHub — locker ${r.locker_released} released back to vacant.`
        : 'Cancelled on LockerHub. You can enrol this customer again from scratch.');
  };
  const removeApp = async () => {
    if (!app?.application_id) return;
    const ok = await confirm({
      title: `Delete application ${app.application_no ?? app.application_id}?`,
      body: 'Cancels it on LockerHub too and releases any locker it was holding, so a fresh enrolment for this customer starts clean. Refused if money has already been collected, or if it is already a live tenancy. Use this for one entered by mistake.',
      confirmLabel: 'Delete', danger: true,
    });
    if (!ok) return;
    const reason = await promptText({
      title: 'Why is it being deleted?', body: 'Recorded on the audit trail.',
      label: 'Reason', minLength: 3, confirmLabel: 'Delete', danger: true,
    });
    if (!reason) return;
    setErr(''); setBusy(true);
    try {
      afterRemoved(await submitRemove(reason, false));
    } catch (e) {
      // LockerHub won't cancel a paid / live-tenancy application (409). A Super
      // Admin can still remove it from NCD's view only — LockerHub keeps it.
      if (e instanceof ApiError && e.status === 409 && user?.role === 'super_admin') {
        setBusy(false);
        const force = await confirm({
          title: 'LockerHub won’t cancel this application',
          body: `${e.message}\n\nAs Super Admin you can remove it from NCD’s view only. LockerHub will KEEP the record, and any money collected on it must be settled with LockerHub separately. Continue?`,
          confirmLabel: 'Remove from NCD only', danger: true,
        });
        if (!force) return;
        setBusy(true);
        try { afterRemoved(await submitRemove(reason, true)); }
        catch (e2) { setErr(e2 instanceof ApiError ? e2.message : 'Failed'); }
        finally { setBusy(false); }
      } else {
        setErr(e instanceof ApiError ? e.message : 'Failed');
      }
    } finally {
      setBusy(false);
    }
  };
  // ── Cheque register ────────────────────────────────────────────────────
  const loadCheques = async () => {
    if (!app?.application_id) return;
    const r = await run(api.get<any>(`/api/lockers/cheques?application_id=${encodeURIComponent(app.application_id)}`));
    if (r) setCheques(r.rows ?? []);
  };
  /** Push a cleared-but-unsettled cheque to LockerHub again. Safe to repeat.
   *  (Clearing a cheque now goes through Approvals — see the Approvals page.) */
  const retrySettlement = async (id: number) => {
    const r = await run(api.post<any>(`/api/lockers/cheques/${id}/settle-retry`, {}));
    if (r) {
      setErr(r.settled ? '' : (r.note ?? 'LockerHub still did not accept it.'));
      await loadCheques(); await refreshApp();
    }
  };
  // ── Offline rent payment via approval (owner 2026-08-22) ──────────────────
  // Pick a method (cheque/transfer) + reference; the rent is marked paid only
  // when an Admin/CXO approves. Until then it reads "yet to be paid".
  const [payForm, setPayForm] = useState<{ method: 'cheque' | 'transfer'; reference: string; amount: string } | null>(null);
  const [offlinePayments, setOfflinePayments] = useState<any[]>([]);
  const loadOfflinePayments = async () => {
    if (!app?.application_id) return;
    const r = await run(api.get<any>(`/api/lockers/applications/${encodeURIComponent(app.application_id)}/offline-payments`));
    if (r) setOfflinePayments(r.rows ?? []);
  };
  const recordPayment = async () => {
    if (!payForm || !app?.application_id) return;
    const r = await run(api.post<any>(`/api/lockers/applications/${encodeURIComponent(app.application_id)}/offline-payment`, {
      leg: 'rent', method: payForm.method, reference: payForm.reference.trim(),
      ...(Number(payForm.amount) > 0 ? { amount: Number(payForm.amount) } : {}),
    }));
    if (r) {
      setNote(`Payment sent for approval${r.request_no ? ` (${r.request_no})` : ''} — the rent is marked paid once an Admin/CXO approves it.`);
      setPayForm(null);
      await loadOfflinePayments();
    }
  };
  /**
   * Allot with rent or deposit still outstanding (§A20). Senior-only, and it
   * hands over an asset against money not received — so it asks twice and
   * records who authorised it, not just who clicked.
   */
  /**
   * Hand our KYC over for an application that reached LockerHub bare (§A17.1).
   * Only ever needed for ones created before the screen started sending the
   * customer id — new applications carry the KYC with the create.
   */
  const pushKyc = async () => {
    if (!app?.application_id || !ncdCust?.id) return;
    const r = await run(api.post<any>(`/api/lockers/applications/${encodeURIComponent(app.application_id)}/kyc`, {
      customer_id: Number(ncdCust.id),
    }));
    if (r) { setErr(''); await refreshApp(); }
  };
  /** Locker-agreement e-Sign (§A19). Only exists after allotment. */
  const [esign, setEsign] = useState<any>(null);
  const loadEsign = async () => {
    if (!app?.application_id || !app?.allotment) return;
    const r = await run(api.get<any>(`/api/lockers/applications/${encodeURIComponent(app.application_id)}/esign`));
    if (r) setEsign(r);
  };
  /**
   * Start the signing. Digio emails and SMSes the customer, so this genuinely
   * contacts them — a deliberate click, never automatic.
   */
  const startEsign = async () => {
    if (!app?.application_id) return;
    const ok = await confirm({
      title: 'Send the locker agreement for signing?',
      body: 'The customer is emailed and texted a signing link by Digio. You can also hand them the link on screen if they are at the branch.',
      confirmLabel: 'Send for signing',
    });
    if (!ok) return;
    const r = await run(api.post<any>(`/api/lockers/applications/${encodeURIComponent(app.application_id)}/esign/initiate`, {}));
    if (r) { setEsign(r); await loadEsign(); await loadSigning(); }
  };

  /**
   * How the agreement gets signed (owner 2026-09-03). Two paths that differ ONLY
   * in how the signature is captured — Digio, or a printed pre-filled agreement
   * the customer signs by hand. Printing and uploading arrive in the next two
   * PRs; this records the choice and shows which way a locker went.
   */
  const [signing, setSigning] = useState<any>(null);
  const loadSigning = async () => {
    if (!app?.application_id) return;
    const r = await run(api.get<any>(`/api/lockers/applications/${encodeURIComponent(app.application_id)}/agreement`));
    if (r) setSigning(r.signing ?? null);
  };
  const chooseMethod = async (method: 'esign' | 'physical') => {
    if (!app?.application_id) return;
    const r = await run(api.post<any>(`/api/lockers/applications/${encodeURIComponent(app.application_id)}/agreement/method`,
      { method, ...(ncdCust?.id ? { customer_id: Number(ncdCust.id) } : {}) }));
    if (r) { setSigning(r); setErr(''); }
  };

  /**
   * The signed paper comes back. Asks for the date ON THE DOCUMENT rather than
   * assuming today: the customer signs at the branch on Tuesday and the scan is
   * uploaded on Friday, and the agreement date is Tuesday.
   *
   * This does NOT mark it signed — it goes to a checker, who has to be able to
   * open the scan before deciding.
   */
  const uploadSigned = async (file: File) => {
    if (!app?.application_id) return;
    const signedOn = await promptText({
      title: 'When did the customer sign?',
      body: 'The date written on the agreement, not today — the scan often comes back days later.',
      label: 'Date signed', inputType: 'date', confirmLabel: 'Next',
    });
    if (!signedOn) return;
    const branch = await promptText({
      title: 'Where was it signed?', label: 'Branch', minLength: 0, confirmLabel: 'Upload signed agreement',
    });
    if (branch === null) return;

    const data_base64 = await new Promise<string>((resolve, reject) => {
      const fr = new FileReader();
      fr.onerror = () => reject(new Error('Could not read the file'));
      fr.onload = () => resolve(String(fr.result).split(',')[1] ?? '');
      fr.readAsDataURL(file);
    }).catch(() => null);
    if (!data_base64) { setErr('Could not read that file.'); return; }

    const r = await run(api.post<any>(`/api/lockers/applications/${encodeURIComponent(app.application_id)}/agreement/signed-upload`, {
      data_base64, filename: file.name, signed_on: signedOn,
      signed_at_branch: branch.trim() || null,
    }));
    if (r) {
      setSigning(r);
      setErr('');
      setNote('Signed agreement uploaded — it takes effect once a checker approves it.');
    }
  };
  /** Waivers on this application (pending + approved). */
  const [feeWaivers, setFeeWaivers] = useState<any[]>([]);
  const loadFeeWaivers = async () => {
    if (!app?.application_id) return;
    const r = await run(api.get<any>(`/api/lockers/applications/${encodeURIComponent(app.application_id)}/fee-waivers`));
    if (r) setFeeWaivers(r.rows ?? []);
  };
  /**
   * Ask for a waiver. This does NOT waive anything yet — LockerHub applies our
   * call approved-on-arrival, so it only reaches them once a checker approves.
   */
  /**
   * The size this application is priced on — the source of the GST rate, and of
   * the figures shown on the button. Falls back to the page's selected size for
   * a brand-new application that has not been re-fetched yet.
   */
  const pricedSize = (avail.data?.sizes ?? []).find(
    (s: Size) => String(s.size) === String(app?.locker_size ?? size));
  const rentWaiverPreview = pricedSize && Number(pricedSize.gst_pct) > 0
    ? rentWaiverBreakdown(Number(pricedSize.annual_fee), Number(pricedSize.gst_pct))
    : null;

  /**
   * Apply the standard rent waiver. Unlike `requestWaiver` below — and unlike
   * `premiumCustomer` — this is POLICY with no discretion in it, so it needs no
   * checker (owner 2026-08-20, re-confirmed 2026-08-25) and reaches LockerHub
   * at once.
   *
   * Confirms with the actual rupees first, because it writes off real money and
   * "Apply waiver" alone does not say how much.
   */
  const applyStandardRentWaiver = async () => {
    if (!app?.application_id || !rentWaiverPreview || !pricedSize) return;
    const p = rentWaiverPreview;
    if (!await confirm({
      title: 'Apply the standard rent waiver?',
      body: `Bill now ${money(p.gross)} · waive ${money(p.waived)} (${p.waiverPct.toFixed(4)}% of the pre-tax rent) · customer pays ${money(p.payable)}.\n\n`
        + 'This is policy, so it goes to LockerHub immediately — there is no approval step.',
      confirmLabel: `Waive ${money(p.waived)}`,
    })) return;
    setErr('');
    const r = await api.post<{ applied?: boolean; already?: boolean; error?: string }>(
      `/api/lockers/applications/${app.application_id}/apply-rent-waiver`,
      { gst_pct: Number(pricedSize.gst_pct), annual_rent: Number(pricedSize.annual_fee) },
    ).catch((e) => { setErr(e instanceof ApiError ? e.message : 'Failed'); return null; });
    if (!r) return;
    if (r.already) setNote('This application already has a rent waiver — nothing changed.');
    else if (r.applied === false) setNote(`Recorded, but LockerHub did not accept it yet${r.error ? ` — ${r.error}` : ''}. It can be retried.`);
    else setNote(`Waived ${money(p.waived)} — the customer now pays ${money(p.payable)}.`);
    // BOTH: refreshApp reloads the legs, but the button hides on the WAIVER
    // list, so without this it stays on screen offering to waive again on an
    // application that is already waived.
    await loadFeeWaivers();
    await refreshApp();
  };

  /**
   * Premium customer — make the rent complimentary (owner 2026-08-22). Zeroes the
   * rent, recorded as its OWN category 'premium' (not a waiver), so the rent
   * report keeps the two apart. Goes to Admin/CXO for approval — as all rent
   * waivers do now (owner 2026-08-22).
   */
  const premiumCustomer = async () => {
    if (!app?.application_id) return;
    if (!await confirm({
      title: 'Premium customer — make the rent free?',
      body: 'Marks this a PREMIUM customer and zeroes the rent (₹0), kept separate from a waiver in the reports. This goes to Admin/CXO for approval — the rent is marked premium only once approved.',
      confirmLabel: 'Send for approval',
    })) return;
    const r = await run(api.post<any>(`/api/lockers/applications/${encodeURIComponent(app.application_id)}/premium-rent`, {}));
    if (r) {
      setNote(r.already ? 'This locker already has a rent waiver — nothing changed.' : `Premium request sent for approval${r.request_no ? ` (${r.request_no})` : ''} — the rent is marked premium once an Admin/CXO approves it.`);
      await loadFeeWaivers();
      await refreshApp();
    }
  };

  const requestWaiver = async (leg: 'rent' | 'deposit') => {
    if (!app?.application_id) return;
    const pct = await promptText({
      title: `Waive the ${leg}?`,
      body: 'Percentage of the amount to waive. 100 clears the leg entirely. Goes to Admin/CXO for approval — nothing is waived until they approve it.',
      label: 'Percentage to waive', placeholder: '100', minLength: 1, confirmLabel: 'Next',
    });
    if (!pct) return;
    const n = Number(pct.trim());
    if (!(n > 0 && n <= 100)) { setErr('Enter a percentage above 0 and at most 100.'); return; }
    const reason = await promptText({
      title: 'Why is this being waived?', body: 'The approver sees this, and it goes to LockerHub with the waiver.',
      label: 'Reason', minLength: 3, confirmLabel: 'Send for approval',
    });
    if (!reason) return;
    const r = await run(api.post<any>(`/api/lockers/applications/${encodeURIComponent(app.application_id)}/fee-waivers`, {
      leg, waiver_pct: n, reason,
      ...(ncdCust?.id ? { customer_id: Number(ncdCust.id) } : {}),
      applicant_name: name.trim() || undefined,
    }));
    if (r) { setErr(''); await loadFeeWaivers(); }
  };
  /** Re-send an approved waiver LockerHub refused. Safe to repeat. */
  const retryWaiver = async (id: number) => {
    const r = await run(api.post<any>(`/api/lockers/fee-waivers/${id}/retry`, {}));
    if (r) { setErr(r.applied ? '' : (r.error ?? 'LockerHub still did not accept it.')); await loadFeeWaivers(); await refreshApp(); }
  };
  // Waivers belong to an application, so they follow it rather than the mount.
  useEffect(() => { void loadFeeWaivers(); void loadOfflinePayments(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [app?.application_id]);
  // There is no agreement until there is a locker — §A19 is post-allotment.
  useEffect(() => { void loadEsign(); void loadSigning(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [app?.application_id, app?.allotment?.locker_number]);
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
  // ── Allotment: pick the actual locker number (contract §A4 + §A11) ────────
  // LockerHub stopped auto-allocating on settlement, so the branch chooses the
  // physical locker. Prefer the application's own branch/size over the page
  // pickers above: staff often land here by resuming an application rather than
  // walking the wizard, in which case those selects are empty.
  const allotBranch = String(app?.branch_id ?? branchId ?? '');
  const allotSize = String(app?.locker_size ?? size ?? '');
  const [picking, setPicking] = useState(false);
  const [lockerId, setLockerId] = useState('');
  const vacant = useQuery({
    queryKey: ['locker-vacant', allotBranch, allotSize],
    queryFn: () => api.get<{ lockers: { id: string; locker_number: string; size: string; status?: string }[] }>(
      `/api/lockers/lockers?branch_id=${encodeURIComponent(allotBranch)}${allotSize ? `&size=${encodeURIComponent(allotSize)}` : ''}`),
    // Loaded as soon as a branch and size exist, because the locker number is
    // now chosen up front in step 1 (owner 2026-07-29) — not only when the
    // allotment step opens the picker.
    enabled: (!!allotBranch && !!allotSize) || (picking && !!allotBranch),
    staleTime: 0,   // vacancy is a race; never serve this from cache
  });
  /** The locker number chosen in step 1, if it is still in the vacant list. */
  const preferred = (vacant.data?.lockers ?? []).find((l) => l.id === lockerId) ?? null;
  /**
   * Allot. `chosen` is the locker's `id` from A4 — NOT the visible
   * locker_number, which their API does not accept. Omitting it lets LockerHub
   * auto-pick the lowest vacant locker of the size, which is the old behaviour
   * and still the right default when nobody cares which box it is.
   */
  const allocate = async (chosen?: string) => {
    setErr(''); setBusy(true);
    try {
      // Rent still outstanding? Any enrolling staff may allot regardless (owner
      // 2026-08-22) — send the §A20 override automatically, recorded against
      // them. When the rent is settled, no override is sent (the normal path).
      const outstanding = app?.obligations_settled === false;
      await api.post(`/api/lockers/applications/${encodeURIComponent(app.application_id)}/allocate`, {
        ...(chosen ? { locker_id: chosen } : {}),
        ...(outstanding ? { override: { reason: 'Rent yet to be paid — allotted per policy (owner 2026-08-22)', approved_by: user?.fullName ?? 'staff' } } : {}),
      });
      setPicking(false); setLockerId('');
      await refreshApp();
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : 'Failed';
      // Someone allotted this locker between us listing it and pressing allot —
      // LockerHub resolves that race atomically and the loser gets this 400.
      // Re-fetch so the operator picks from what is actually left instead of
      // retrying a number that is already gone.
      if (/no longer vacant/i.test(msg)) {
        setErr('That locker was just taken by someone else. The list has been refreshed — pick another.');
        setLockerId(''); setPicking(true); await vacant.refetch();
      } else setErr(msg);
    } finally { setBusy(false); }
  };

  const legState = (leg: string) => app?.legs?.[leg];
  const allotment = app?.allotment ?? (app?.pricing ? null : undefined);
  const chosen = (avail.data?.sizes ?? []).find((s) => s.size === size);
  /** Why "Create application" can't be pressed yet, or '' when it can.
   * LockerHub keys everything on the phone, so that's the hard requirement —
   * a PAN match fills it in, a phone lookup supplies it directly. */
  const createBlocker =
    phone.length < 10 ? 'Look the customer up by PAN or phone first — LockerHub needs their 10-digit phone.'
    : !name.trim() ? "Enter the customer's full name."
    // Locker number is now MANDATORY (owner 2026-08-22) — the customer is told
    // their box at the counter, so it is chosen up front, not at allotment.
    : !lockerId ? 'Pick a locker number in step 1 — it is required.'
    : '';

  return (
    <div className="w-full max-w-3xl">
      <h1 className="text-xl font-bold tracking-tight m-0">Locker enrollment</h1>
      {/* Was "a locker is allotted automatically once rent and deposit are both
          settled" — untrue since LockerHub removed auto-allocation (§A11,
          2026-07-25). Staff reading that would wait for something that is never
          coming. */}
      <p className="text-sm text-text-muted mt-1 mb-4">Enroll a customer for a locker end-to-end. Pricing is handled by LockerHub. Pick the locker number below; it is allotted once the rent is settled and a staff member confirms.</p>
      {err && <div className="text-xs text-danger bg-[color:var(--danger-bg)] rounded px-3 py-2 mb-3">{err}</div>}
      {note && <div className="text-xs text-success bg-[color:var(--success-bg)] rounded px-3 py-2 mb-3">{note}</div>}

      {/* Arrived from a customer's page. The flow is branch-first, so the
          customer step is still collapsed and a staff member would otherwise
          see no sign that the person came across with them — say so, and name
          them, because enrolling the wrong customer is not a cheap mistake. */}
      {prefilled.current && ncdCust && !branchId && (
        <div className="text-xs bg-[color:var(--success-bg)] text-success rounded px-3 py-2 mb-3">
          Enrolling <span className="font-semibold">{ncdCust.full_name}</span>
          {ncdCust.customer_code ? <span className="font-mono"> · {ncdCust.customer_code}</span> : null} — pick the branch and size to continue.
        </div>
      )}
      {prefilled.current && notFound && (
        <div className="text-xs bg-[color:var(--warn-bg)] text-warn rounded px-3 py-2 mb-3">
          Couldn’t find that customer by PAN — search for them in step 2.
        </div>
      )}

      {/* Cheque clearance moved to the Approvals page (owner 2026-08-07): a maker
          marks "funds cleared" there, an Admin/CXO approves, and only then does
          the leg settle on LockerHub. Enrollment just records the cheque. */}

      {/* 1 — Branch + size */}
      <div className={card}>
        <h2 className={h2}>1 · Branch &amp; locker size</h2>
        <div className="flex flex-wrap gap-2 items-center">
          <select className={inp} value={branchId} onChange={(e) => { setBranchId(e.target.value); setSize(''); setApp(null); }}>
            <option value="">Branch…</option>
            {(branches.data?.branches ?? []).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
          <select className={inp} value={size} disabled={!branchId || avail.isLoading} onChange={(e) => { setSize(e.target.value); setApp(null); setLockerId(''); }}>
            <option value="">{avail.isLoading ? 'Loading…' : 'Size…'}</option>
            {(avail.data?.sizes ?? []).map((s) => <option key={s.size} value={s.size} disabled={s.vacant_count <= 0}>{s.size} · {money(s.rent_payable ?? s.rent_incl_gst)} rent · {s.vacant_count} vacant</option>)}
          </select>
          {/* Locker number, chosen here rather than at allotment (owner
              2026-07-29): the customer is standing at the counter now, and
              "which box do I get?" is part of choosing branch and size.
              MANDATORY (owner 2026-08-22) — no more blank/auto-pick. The list is
              LockerHub's vacant-only roster, so only available numbers appear. */}
          {branchId && size && (
            <select className={`${inp} ${!lockerId ? 'border-primary' : ''}`} value={lockerId} disabled={vacant.isLoading} onChange={(e) => setLockerId(e.target.value)}>
              <option value="">{vacant.isLoading ? 'Loading lockers…' : 'Locker number… (required)'}</option>
              {(vacant.data?.lockers ?? []).map((l) => (
                <option key={l.id} value={l.id}>{l.locker_number}</option>
              ))}
            </select>
          )}
        </div>
        {/* Their API has no reserve call — A7 takes branch + size only, and a
            locker is not assigned until A11 at allotment. So this is a
            PREFERENCE we hold and use later, and saying so here is the
            difference between a clear handover and an argument at the counter. */}
        {branchId && size && (
          vacant.isError ? <div className="text-xs text-warn mt-2">Couldn’t load the locker list — you can still continue and pick at allotment.</div>
          : preferred ? <div className="text-xs text-text-muted mt-2">Locker <b className="text-text">{preferred.locker_number}</b> will be allotted once both payments settle. It is <b>not held</b> until then — if someone else takes it first, you’ll be asked to pick again.</div>
          // Chosen, then taken by someone else before we got here. Never let
          // this fall through quietly: staff have told the customer a number.
          : lockerId && !vacant.isLoading ? <div className="text-xs text-danger mt-2">The locker you picked is no longer vacant — choose another.</div>
          : !vacant.isLoading && !(vacant.data?.lockers ?? []).length ? <div className="text-xs text-warn mt-2">No vacant {size} lockers listed at this branch.</div>
          : <div className="text-xs text-text-muted mt-2">Choose the locker number — it is required before you can create the application.</div>
        )}
        {chosen && (
          chosen.rent_payable != null ? (
            <div className="text-xs text-text-muted mt-2">
              Rent (incl. GST {chosen.gst_pct}%): <s>{money(chosen.rent_incl_gst)}</s>
              {' '}· Waiver{chosen.rent_waiver_pct != null ? ` (${chosen.rent_waiver_pct}%)` : ''}: −{money(chosen.rent_waiver_amount ?? chosen.rent_incl_gst - chosen.rent_payable)}
              {' '}· Payable: <b className="text-text">{money(chosen.rent_payable)}</b>
            </div>
          ) : (
            <div className="text-xs text-text-muted mt-2">Rent (incl. GST {chosen.gst_pct}%): <b className="text-text">{money(chosen.rent_incl_gst)}</b></div>
          )
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
                {/* "Existing" / "New" is about LOCKERHUB, not NCD — a customer
                    can be in our book and unknown to them. */}
                <span className={`text-xs rounded px-1.5 py-0.5 ${cust.found ? 'bg-[color:var(--success-bg)] text-success' : 'bg-bg text-text-muted'}`}>{cust.found ? 'Known to LockerHub' : 'New to LockerHub — will be created'}</span>
                {!cust.found
                  ? <button className={btnGhost} disabled={!name.trim() || busy} onClick={saveCustomer}>Save customer</button>
                  // Known to LockerHub but the profile is bare (they write it on
                  // create and never backfill). No manual "send to LockerHub"
                  // button any more (owner 2026-08-22): the full profile —
                  // address and all — is sent AUTOMATICALLY with the applicant
                  // block when the application is created below, so it fills
                  // itself with no extra click.
                  : !String(cust.profile?.address_line1 ?? cust.profile?.city ?? '').trim() && (
                      <span className="text-xs text-text-muted">Their details are sent to LockerHub automatically when you create the application.</span>
                    )}
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
                {/* Discard a mistaken entry — Super Admin only, before allotment
                    (an allotted locker is removed from the Tenants page instead). */}
                {user?.role === 'super_admin' && !app.allotment && (
                  <button className={`${btnGhost} text-danger`} disabled={busy} onClick={removeApp}>Delete</button>
                )}
              </div>
              {/* An application stuck on KYC is one created before the screen
                  started sending the customer id, so no profile went with it.
                  Hand it over rather than making someone open LockerHub.
                  Needs a PAN match — the phone lookup does not identify an NCD
                  customer, and we will not assert KYC we cannot attribute. */}
              {(app.status === 'kyc_pending' || app.kyc?.pending) && (
                <div className="mb-2 flex items-center gap-2 flex-wrap">
                  <span className="text-xs text-warn">LockerHub is waiting on this customer's KYC.</span>
                  {ncdCust?.id
                    ? <button className={btnGhost} disabled={busy} onClick={pushKyc}>Send their KYC to LockerHub</button>
                    : <span className="text-xs text-text-muted">Look the customer up by PAN to send it.</span>}
                </div>
              )}
              {app.pricing && (
                app.pricing.rent_payable != null ? (
                  <div className="text-xs text-text-muted">
                    Rent <s>{money(app.pricing.rent_incl_gst)}</s>
                    {' '}− waiver{app.pricing.rent_waiver_pct != null ? ` ${app.pricing.rent_waiver_pct}%` : ''} = <b className="text-text">{money(app.pricing.rent_payable)}</b>
                  </div>
                ) : (
                  <div className="text-xs text-text-muted">Rent {money(app.pricing.rent_incl_gst)}</div>
                )
              )}
            </div>
          )}
        </div>
      )}

      {/* 4 — Payments (online only) */}
      {app?.application_id && app.status !== 'approved' && !allotment && (
        <div className={card}>
          <h2 className={h2}>4 · Collect payment (online)</h2>
          <div className="flex flex-col gap-2">
            {/* RENT-ONLY (owner 2026-08-12): NCD lockers collect rent only; the
                deposit is auto-waived at enrolment, so no deposit leg is shown. */}
            {(['rent'] as const).map((leg) => {
              const st = legState(leg);
              const settled = st?.settled === true;
              const link = links[leg];
              return (
                <div key={leg} className="flex flex-wrap gap-2 items-center">
                  <button className={btnGhost} disabled={busy || settled} onClick={() => getPaymentLink(leg)}>
                    {settled ? `✓ ${leg} settled` : `${link ? 'New link' : 'Payment link'} · ${leg}${st?.amount ? ' · ' + money(st.amount) : ''}`}
                  </button>
                  {/* Rent settlement status (owner 2026-08-22): an offline
                      payment awaiting approval, or "yet to be paid". Once
                      approved it settles on LockerHub and reads settled above. */}
                  {leg === 'rent' && !settled && (() => {
                    const p = offlinePayments.find((x) => x.leg === 'rent');
                    if (p && p.status === 'PendingApproval') return <span className="text-xs rounded px-1.5 py-0.5 bg-[color:var(--warn-bg)] text-warn" title={p.reference}>{p.method} payment · awaiting Admin/CXO approval</span>;
                    if (p && p.status === 'Approved' && !p.lockerhub_settled) return (
                      <span className="text-xs"><span className="rounded px-1.5 py-0.5 bg-[color:var(--danger-bg)] text-danger">approved, not yet settled on LockerHub</span>
                        <button className="ml-1 text-primary hover:underline" disabled={busy} onClick={async () => { await run(api.post(`/api/lockers/offline-payments/${p.id}/settle-retry`, {})); await loadOfflinePayments(); await refreshApp(); }}>Retry</button></span>
                    );
                    if (!feeWaivers.some((w) => w.leg === 'rent')) return <span className="text-xs rounded px-1.5 py-0.5 bg-[color:var(--warn-bg)] text-warn">rent yet to be paid</span>;
                    return null;
                  })()}
                  {/* Rent-only waiver breakdown (LockerHub CR): legs.rent.amount IS the
                      payable; the original + waiver ride along for transparency. */}
                  {leg === 'rent' && !settled && st?.original_amount != null && (
                    <span className="text-xs text-text-muted">
                      original {money(st.original_amount)} − waiver{st.waiver_pct != null ? ` ${st.waiver_pct}%` : ''} ({money(st.waiver_amount ?? st.original_amount - (st.amount ?? 0))})
                    </span>
                  )}
                  {!settled && link && (
                    <>
                      <input className={`${inp} flex-1 min-w-[16rem] font-mono text-xs`} readOnly value={link.url} onFocus={(e) => e.currentTarget.select()} />
                      <button className={btnGhost} onClick={() => navigator.clipboard?.writeText(link.url)}>Copy</button>
                      <a className={btnGhost} href={link.url} target="_blank" rel="noopener noreferrer">Open</a>
                    </>
                  )}
                  {/* A waiver in flight, or approved and stuck. Money is only
                      actually waived once LockerHub has it. */}
                  {(() => {
                    const w = feeWaivers.find((x) => x.leg === leg);
                    if (!w) return null;
                    const isPremium = w.category === 'premium';
                    const amount = w.waiver_pct != null ? `${w.waiver_pct}%` : money(w.waiver_amount);
                    if (w.status === 'PendingApproval') return (
                      <span className="text-xs rounded px-1.5 py-0.5 bg-bg text-text-muted" title={w.reason}>
                        {amount} waiver — awaiting Admin/CXO approval
                      </span>
                    );
                    return w.lockerhub_applied_at ? (
                      <span className="text-xs rounded px-1.5 py-0.5 bg-[color:var(--success-bg)] text-success" title={w.reason}>
                        {isPremium ? '★ Premium — rent free' : `${amount} waived`}
                      </span>
                    ) : (
                      <span className="text-xs">
                        <span className="rounded px-1.5 py-0.5 bg-[color:var(--danger-bg)] text-danger" title={w.lockerhub_error ?? ''}>
                          {amount} waiver approved, but LockerHub has NOT applied it
                        </span>
                        <button className="ml-1 text-primary hover:underline" disabled={busy} onClick={() => retryWaiver(w.id)}>Retry</button>
                      </span>
                    );
                  })()}
                  {/* Cheque register — OUR books only. Never settles the leg on
                      LockerHub, so the payment link / NCD-backing stays required. */}
                  {!settled && (() => {
                    const q = chequeFor(leg);
                    if (q) return (
                      <span className="text-xs">
                        <span className={`rounded px-1.5 py-0.5 ${q.status === 'Cleared' ? 'bg-[color:var(--success-bg)] text-success' : 'bg-[color:var(--warn-bg)] text-warn'}`}>
                          Cheque {q.cheque_no} · {q.status === 'Cleared' ? `cleared ${q.cleared_on}` : 'awaiting clearance'}
                        </span>
                        {/* A cheque that cleared but whose leg never settled is
                            the one that otherwise goes unnoticed — money in, no
                            locker. Say so, and offer the retry. */}
                        {q.status === 'Cleared' && !q.lockerhub_settled_at ? (
                          <>
                            <span className="text-danger ml-1">— cleared here, but the leg is NOT settled on LockerHub</span>
                            <button className="ml-1 text-primary hover:underline" disabled={busy}
                              onClick={() => retrySettlement(q.id)}>Retry settlement</button>
                          </>
                        ) : q.status === 'Cleared' ? (
                          <span className="text-text-muted ml-1">— leg settled on LockerHub</span>
                        ) : (
                          <span className="text-text-muted ml-1">— settles when you mark it cleared</span>
                        )}
                      </span>
                    );
                    return (
                      <>
                        {/* Unified offline rent payment (owner 2026-08-22): pick
                            a method + reference; the rent is marked paid only on
                            Admin/CXO approval. Replaces the old immediate
                            cheque/transfer buttons. Rent leg only. */}
                        {leg === 'rent' && !offlinePayments.some((p) => p.leg === 'rent') && (
                          <button className={btnGhost} disabled={busy} onClick={() => setPayForm({ method: 'transfer', reference: '', amount: String(st?.amount ?? '') })}>Record payment…</button>
                        )}
                        {/* Premium customer — makes the rent free, recorded as
                            its own category (not a waiver). Goes to Admin/CXO
                            first (#333): a 100% write-off is a judgement call,
                            unlike the formula-driven standard waiver below.
                            Mutually exclusive with the waiver buttons: all three
                            vanish once a rent waiver exists. */}
                        {can('lockers:waive') && leg === 'rent' && !feeWaivers.some((w) => w.leg === 'rent') && (
                          <button className="text-xs border border-primary text-primary rounded px-3 py-1.5 hover:bg-bg disabled:opacity-40"
                            disabled={busy} onClick={premiumCustomer}
                            title="Sends a request to Admin/CXO to make the rent complimentary (₹0) and mark this a premium customer">
                            Premium customer
                          </button>
                        )}
                        {/* The standard rent waiver (owner 2026-08-20) — one
                            click, no checker, so the customer pays the rent
                            inclusive of GST. Rent only: there is nothing
                            standard about a deposit waiver. */}
                        {can('lockers:waive') && leg === 'rent' && !feeWaivers.some((w) => w.leg === 'rent') && (
                          <button className="text-xs border border-primary text-primary rounded px-3 py-1.5 hover:bg-bg disabled:opacity-40"
                            disabled={busy} onClick={applyStandardRentWaiver}
                            title="Waives the GST portion so the customer pays the round rent figure">
                            Apply waiver{rentWaiverPreview ? ` — ${money(rentWaiverPreview.waived)}` : ''}
                          </button>
                        )}
                        {can('lockers:waive') && !feeWaivers.some((w) => w.leg === leg) && (
                          <button className={btnGhost} disabled={busy} onClick={() => requestWaiver(leg)}>Waive…</button>
                        )}
                      </>
                    );
                  })()}
                </div>
              );
            })}
            {payForm && (
              <div className="flex flex-wrap gap-2 items-end border-t border-border pt-3 mt-1">
                <label className="text-xs text-text-muted">Method
                  <select className={`${inp} block mt-1 w-32`} value={payForm.method} onChange={(e) => setPayForm({ ...payForm, method: e.target.value as 'cheque' | 'transfer' })}>
                    <option value="transfer">Transfer</option>
                    <option value="cheque">Cheque</option>
                  </select>
                </label>
                <label className="text-xs text-text-muted">Reference<input className={`${inp} block mt-1 w-56`} placeholder={payForm.method === 'cheque' ? 'Cheque number' : 'UTR / bank reference'} value={payForm.reference} onChange={(e) => setPayForm({ ...payForm, reference: e.target.value })} autoFocus /></label>
                <label className="text-xs text-text-muted">Amount<input className={`${inp} block mt-1 w-32`} type="number" value={payForm.amount} onChange={(e) => setPayForm({ ...payForm, amount: e.target.value })} /></label>
                <button className={btn} disabled={busy || payForm.reference.trim().length < 2} onClick={recordPayment}>Send for approval</button>
                <button className={btnGhost} onClick={() => setPayForm(null)}>Cancel</button>
                <p className="text-xs text-text-muted w-full m-0">The rent is marked <b>paid</b> only once an Admin/CXO approves this — then it settles on LockerHub. The locker can still be allotted below while it is pending.</p>
              </div>
            )}
          </div>
          <div className="flex items-center gap-2 mt-3">
            <button className={btnGhost} disabled={busy} onClick={() => { void refreshApp(); void loadOfflinePayments(); }}>Check payment status</button>
            <p className="text-xs text-text-muted m-0">
              Send the link to the customer and settlement lands automatically. Money taken at the branch is recorded via <b>Record payment</b> (cheque or transfer + reference) and the rent is marked paid once an Admin/CXO approves it. The locker can be allotted below regardless of the rent clearance.
            </p>
          </div>
        </div>
      )}

      {/* 5 — Allotment.
          `pending_allocation` is the status a fully-paid application now parks
          in: LockerHub removed auto-allocation on settlement platform-wide
          (contract §A11, 2026-07-25), so somebody has to press this. Gating the
          card on 'approved' alone made the button unreachable the moment they
          shipped that — the application never reaches 'approved' until AFTER
          allocation. Their §A8 still documents the old lifecycle. */}
      {app && (app.status === 'approved' || app.status === 'pending_allocation'
               // `esign_pending` is post-allotment (allotted, awaiting the
               // agreement signature) — the card MUST stay up so the e-Sign is
               // reachable; leaving it out made a Refresh hide the e-Sign
               // (owner 2026-08-22).
               || app.status === 'esign_pending' || app.allotment
               // Unpaid — ANY enrolling staff can allot regardless of the rent
               // clearance now (owner 2026-08-22), so the panel appears BEFORE
               // the obligations clear for everyone, not just seniors.
               || (!app.allotment && app.obligations_settled === false)) && (
        <div className={`${card} ${app.allotment ? 'border-success' : 'border-warn'}`}>
          <h2 className={h2}>{app.allotment ? '✓ Allotted' : 'Awaiting allotment'}</h2>
          {app.allotment ? (
            <>
              <div className="text-sm">Locker <b>{app.allotment.locker_number}</b> ({app.allotment.size}) · lease {String(app.allotment.lease_start).slice(0, 10)} → {String(app.allotment.lease_end).slice(0, 10)}</div>
              {/* Agreement e-Sign. `found: false` is a normal answer meaning
                  nobody has started one — not an error. */}
              <div className="mt-3 pt-3 border-t border-border text-sm">
                <span className="text-xs font-semibold text-text-label uppercase tracking-wide">Locker agreement</span>
                {(() => {
                  const st = String(esign?.status ?? '').toLowerCase();
                  const url = esign?.auth_url || esign?.signing_url || esign?.url;
                  // A16 is keyed on the AGREEMENT id, which is the esign_id
                  // from the status — not the application id. Deliberately NOT
                  // esign.signed_file_url: that is an internal SharePoint link
                  // and 404s for staff (LockerHub, 2026-07-31).
                  const esignId = esign?.esign_id || esign?.id;
                  const doc = esignId ? `/api/lockers/agreements/${encodeURIComponent(String(esignId))}/pdf` : null;
                  const physical = signing?.method === 'physical';

                  // Signed, either way. The method is always named — a bare
                  // "signed" that hides which way it happened is the thing this
                  // whole change exists to stop (owner 2026-09-03).
                  if (signing?.is_signed || st === 'signed' || st === 'completed') return (
                    <div className="mt-1 flex items-center gap-2 flex-wrap">
                      <span className="text-xs rounded px-1.5 py-0.5 bg-[color:var(--success-bg)] text-success">
                        ✓ {signing?.label ?? 'e-Signed'}{signing?.signed_on ? ` · ${signing.signed_on}` : ''}
                      </span>
                      {physical
                        ? <span className="text-xs text-text-muted">Signed on paper — the scan is the agreement on file.</span>
                        : doc
                          ? <a className={btnGhost} href={doc} target="_blank" rel="noopener noreferrer">↓ Signed agreement</a>
                          : <span className="text-xs text-text-muted">Signed, but LockerHub did not return an agreement id — ask them for the copy.</span>}
                    </div>
                  );

                  // Physical path chosen. Printing the pre-filled agreement and
                  // uploading the scan land in the next two PRs; until then the
                  // choice is recorded and visible rather than silently lost.
                  if (physical) {
                    const waiting = signing.status === 'PendingApproval';
                    return (
                      <div className="mt-1 flex flex-col gap-1.5">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className={`text-xs rounded px-1.5 py-0.5 ${waiting ? 'bg-bg text-text-muted' : 'bg-[color:var(--warn-bg)] text-warn'}`}>{signing.label}</span>
                          {/* Opens in the browser's PDF viewer so staff can print
                              straight from it. Everything we hold is already on
                              it — the customer signs, they do not fill it in. */}
                          <a className={btnGhost} href={`/api/lockers/applications/${encodeURIComponent(app.application_id)}/agreement/form.pdf`}
                             target="_blank" rel="noopener noreferrer" onClick={() => { window.setTimeout(loadSigning, 1500); }}>
                            ↓ Print filled agreement
                          </a>
                          {waiting ? (
                            <a className={btnGhost} href={`/api/lockers/applications/${encodeURIComponent(app.application_id)}/agreement/signed.pdf`}
                               target="_blank" rel="noopener noreferrer">View uploaded scan</a>
                          ) : (
                            <label className={`${btn} cursor-pointer`}>
                              Upload signed copy
                              <input type="file" className="hidden" accept="application/pdf,image/jpeg,image/png"
                                onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void uploadSigned(f); }} />
                            </label>
                          )}
                          {!waiting && <button className={btnGhost} disabled={busy} onClick={() => chooseMethod('esign')}>Switch to e-Sign</button>}
                        </div>
                        <span className="text-xs text-text-muted">
                          {waiting
                            ? `Waiting for a checker to approve the scan${signing.signed_doc_pages ? ` · ${signing.signed_doc_pages} page${signing.signed_doc_pages > 1 ? 's' : ''}` : ''}.`
                            : 'Print it, have the customer sign, then scan and upload the signed copy here. PDF or photo, up to 20 MB.'}
                        </span>
                      </div>
                    );
                  }

                  if (esign?.found) return (
                    <div className="mt-1 flex items-center gap-2 flex-wrap">
                      <span className="text-xs rounded px-1.5 py-0.5 bg-bg text-text-muted">awaiting signature{st ? ` · ${st}` : ''}</span>
                      {url && <a className={btnGhost} href={url} target="_blank" rel="noopener noreferrer">Open signing link</a>}
                      <button className={btnGhost} disabled={busy} onClick={loadEsign}>Check again</button>
                    </div>
                  );

                  // Nothing started. The two paths are offered side by side, and
                  // the choice is made BEFORE either action rather than inferred
                  // from which button gets pressed.
                  return (
                    <div className="mt-1 flex items-center gap-2 flex-wrap">
                      <button className={btn} disabled={busy} onClick={startEsign}>Send agreement for signing</button>
                      <button className={btnGhost} disabled={busy} onClick={() => chooseMethod('physical')}>Sign on paper instead</button>
                      <span className="text-xs text-text-muted">e-Sign texts the customer a link. On paper, you print the filled agreement and scan it back.</span>
                    </div>
                  );
                })()}
              </div>
            </>
          ) : canAllocate ? (
            <div className="text-sm">
              <div className="flex items-center gap-2 flex-wrap">
                {/* Rent may still be outstanding — any staff can allot regardless
                    (owner 2026-08-22); allocate() sends the §A20 override for
                    them. When settled, it's the normal path. */}
                {app.obligations_settled === false
                  ? <span className="text-warn">Rent yet to be paid — you can still allot now (the rent is collected and approved separately).</span>
                  : <span>Payments settled — allotment pending.</span>}
                {!picking && (<>
                  {/* The number was already chosen in step 1, so the primary
                      action here is to confirm it, not to ask again. It can
                      still have been taken in the meantime — allocate() handles
                      that 400 by reopening the picker. */}
                  {preferred
                    ? <button className={btn} disabled={busy} onClick={() => allocate(preferred.id)}>Allot {preferred.locker_number}</button>
                    // No preference, or the one chosen at enrolment is gone.
                    // In the second case auto-allotting would hand over a
                    // DIFFERENT box than the customer was promised, so the
                    // picker is the only offer — see the warning below.
                    : lockerId ? null
                    : <button className={btnGhost} disabled={busy} onClick={() => allocate()}>Auto-allot</button>}
                  <button className={btnGhost} disabled={busy} onClick={() => setPicking(true)}>
                    {preferred ? 'Choose a different locker' : 'Pick locker number'}
                  </button>
                </>)}
              </div>
              {!picking && (preferred
                ? <div className="text-xs text-text-muted mt-1">Chosen at enrolment.</div>
                : lockerId && !vacant.isLoading
                  ? <div className="text-xs text-danger mt-1">The locker chosen at enrolment is no longer vacant. Pick another — allotting automatically would give this customer a different locker than they were told.</div>
                  : null)}
              {picking && (
                <div className="mt-3 flex items-center gap-2 flex-wrap">
                  {vacant.isLoading ? <span className="text-text-muted">Loading vacant lockers…</span>
                    : vacant.isError ? <span className="text-danger">Couldn’t load the locker list.</span>
                    : !(vacant.data?.lockers ?? []).length
                      ? <span className="text-warn">No vacant {allotSize || ''} lockers at this branch — nothing to pick from.</span>
                      : (<>
                          {/* value is the locker's id, never locker_number:
                              their allocate call only accepts the id (§A11). */}
                          <select className={inp} value={lockerId} onChange={(e) => setLockerId(e.target.value)}>
                            <option value="">Select a locker…</option>
                            {(vacant.data?.lockers ?? []).map((l) => (
                              <option key={l.id} value={l.id}>{l.locker_number}{l.size ? ` · ${l.size}` : ''}</option>
                            ))}
                          </select>
                          <button className={btn} disabled={busy || !lockerId} onClick={() => allocate(lockerId)}>Allot this locker</button>
                        </>)}
                  <button className={btnGhost} disabled={busy} onClick={() => { setPicking(false); setLockerId(''); }}>Cancel</button>
                </div>
              )}
            </div>
          ) : (
            // Allocation is staff-only on their side; an agent pressing this
            // would just collect a 403. Say who can, rather than showing a
            // button that cannot work.
            <div className="text-sm text-text-muted">Payments settled — allotment pending. A branch staff member needs to allot the locker.</div>
          )}
        </div>
      )}

      {/* 6 — Authorised users (owner 2026-08-22). Add people the holder authorises
          to operate the locker; each needs the holder's e-signed consent.
          POST-ALLOTMENT ONLY: an authorised person attaches to a physical locker,
          so LockerHub (and this) only allow it once the locker is allotted. */}
      {app?.application_id && (
        <div className={card}>
          <h2 className={h2}>6 · Authorised users</h2>
          {app.allotment
            ? <LockerAuthorisedUsers applicationId={String(app.application_id)} customerId={ncdCust?.id ?? null} />
            : <p className="text-sm text-text-muted m-0">Available once the locker is allotted — an authorised user attaches to a physical locker.</p>}
        </div>
      )}
    </div>
  );
}
