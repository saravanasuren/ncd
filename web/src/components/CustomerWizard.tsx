import { useState, useEffect, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../api/client.js';
import { ReferredByPicker } from './ReferredByPicker.js';

/**
 * Staff customer-enrolment wizard (modal). Mirrors the old app's 6-section
 * flow — Personal · Demat · KYC docs · Bank · Nominee · Review. Fields are
 * persisted to the customer (create → demat → KYC docs → bank → nominee) only
 * on "Save & exit" / "Save & add investment", so Back/Next never duplicates
 * rows. The customer is created live — no separate approval (owner 2026-07-21);
 * the investment is the single approval gate.
 *
 * Google-Sheets-style safety net: as you type, the text fields autosave to the
 * browser (localStorage, debounced) and are restored if the modal is closed or
 * reopened — so a stray outside-click no longer loses your work. Clearing
 * happens on a successful save/submit or via "Start fresh". (File picks can't
 * be persisted by the browser, so only those re-attach after a full close.)
 */

const GENDERS = ['Male', 'Female', 'Other'];
const CATEGORIES = ['Individual', 'HUF', 'Corporate', 'Trust', 'NRI', 'Others'];
const DEPOSITORIES = ['NSDL', 'CDSL'];
const ACCOUNT_TYPES = ['Savings', 'Current'];
const RELATIONSHIPS = ['Spouse', 'Son', 'Daughter', 'Father', 'Mother', 'Brother', 'Sister', 'Other'];

const STEPS = ['Personal', 'Demat', 'KYC docs', 'Bank', 'Nominee', 'Review'] as const;

const inp = 'px-2.5 py-1.5 text-sm border border-border-strong rounded outline-none focus:border-primary w-full';

const EMPTY = {
  // Personal
  full_name: '', father_name: '', occupation: '', dob: '', gender: '', pan: '', aadhaar: '',
  phone: '', phone_secondary: '', email: '', investor_category: '',
  address: '', pincode: '', city: '', district: '', state: '', is_nri: false, referred_by_text: '',
  // Demat
  depository: '', dp_id: '', client_id: '',
  // KYC
  ckyc_number: '',
  // Bank
  bank_holder_name: '', account_number: '', account_type: '', tds: 'yes', ifsc: '',
  bank_name: '', branch_name: '', branch_city: '',
  // Nominee (KYC replaces the old PAN-only field: Aadhaar or PAN + a photo)
  nom_full_name: '', nom_dob: '', nom_relationship: '', nom_kyc_type: '', nom_kyc_number: '', nom_phone: '',
  nom_address: '', guardian_name: '', guardian_pan: '',
};
type Form = typeof EMPTY;
type DocKey = 'pan_card' | 'aadhaar_card' | 'customer_photo' | 'customer_signature' | 'address_proof' | 'cml' | 'bank_proof' | 'nominee_kyc';

// Autosave the in-progress enrolment to the browser so an accidental close /
// navigation never loses typed data. Files aren't serialisable, so only text
// fields survive a full close.
const DRAFT_KEY = 'ncd:enroll-draft-v1';
function loadDraft(): { f?: Partial<Form>; step?: number } | null {
  try { const s = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'); return s && s.f ? s : null; } catch { return null; }
}
function isDirty(f: Form): boolean {
  return (Object.keys(EMPTY) as Array<keyof Form>).some((k) => f[k] !== EMPTY[k]);
}

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(new Error('read failed'));
    r.readAsDataURL(file);
  });
}

/** Whole-year age from an ISO DOB, or null. Senior citizen = 60+. */
function ageFromDob(dob: string): number | null {
  if (!dob) return null;
  const d = new Date(dob + 'T00:00:00');
  if (isNaN(d.getTime())) return null;
  const now = new Date();
  let a = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) a--;
  return a >= 0 && a < 130 ? a : null;
}

/** Depository from a DP ID: NSDL DP IDs start with "IN"; CDSL are 8-digit numeric. */
function depositoryFromDpId(dp: string): string {
  const v = dp.trim().toUpperCase();
  if (v.startsWith('IN')) return 'NSDL';
  if (/^\d{8}$/.test(v)) return 'CDSL';
  return '';
}

function Field({ label, required, hint, children }: { label: string; required?: boolean; hint?: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-text-label uppercase tracking-wide">{label}{required && <span className="text-danger"> *</span>}</span>
      {children}
      {hint && <span className="text-[11px] text-text-muted">{hint}</span>}
    </label>
  );
}

function FilePick({ label, hint, file, onPick }: { label: string; hint?: string; file: File | null; onPick: (f: File | null) => void }) {
  return (
    <div className="bg-bg border border-border rounded p-3">
      <div className="text-sm font-semibold">{label}</div>
      {hint && <div className="text-xs text-text-muted mb-2">{hint}</div>}
      <input type="file" accept="image/*,application/pdf" className="text-xs w-full"
        onChange={(e) => onPick(e.target.files?.[0] ?? null)} />
      {file && <div className="text-[11px] text-success mt-1">✓ {file.name}</div>}
    </div>
  );
}


export function CustomerWizard(
  { onClose, prefill, onCreated }: {
    onClose: () => void;
    // Seed the form (e.g. converting a lead — name/phone already known).
    prefill?: Partial<Form>;
    // Called with the new customer id after a successful save (e.g. to mark the
    // originating lead Converted). Awaited so its failure surfaces in the wizard.
    onCreated?: (customerId: number) => Promise<void> | void;
  }
) {
  const nav = useNavigate();
  const qc = useQueryClient();
  // A prefill (lead conversion) starts a FRESH form — it must not resurrect an
  // unrelated autosaved enrolment draft, and it isn't the resumable draft.
  const [step, setStep] = useState<number>(() => (prefill ? 0 : loadDraft()?.step ?? 0));
  const [f, setF] = useState<Form>(() => {
    if (prefill) return { ...EMPTY, ...prefill };
    const d = loadDraft(); return d?.f ? { ...EMPTY, ...d.f } : EMPTY;
  });
  const [restored, setRestored] = useState<boolean>(() => !prefill && !!loadDraft());
  const [files, setFiles] = useState<Record<DocKey, File | null>>({
    pan_card: null, aadhaar_card: null, customer_photo: null, customer_signature: null, address_proof: null, cml: null, bank_proof: null, nominee_kyc: null,
  });
  const [err, setErr] = useState('');
  const [dup, setDup] = useState<{ id: number; customer_code: string; full_name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [pinState, setPinState] = useState<'idle' | 'looking' | 'ok' | 'miss'>('idle');
  const [ifscState, setIfscState] = useState<'idle' | 'looking' | 'ok' | 'miss'>('idle');
  const [penny, setPenny] = useState<{ status: string; name?: string | null; detail?: string } | null>(null);
  const [pennyBusy, setPennyBusy] = useState(false);
  const set = (patch: Partial<Form>) => setF((prev) => ({ ...prev, ...patch }));
  const setFile = (k: DocKey, file: File | null) => setFiles((prev) => ({ ...prev, [k]: file }));

  // PIN → city/state autofill (India Post). Non-blocking: a miss leaves the
  // fields editable. Fires when the PIN reaches 6 digits.
  async function onPincode(v: string) {
    const pin = v.replace(/\D/g, '').slice(0, 6);
    set({ pincode: pin });
    if (pin.length !== 6) { setPinState('idle'); return; }
    setPinState('looking');
    try {
      const r = await api.get<{ found: boolean; state?: string; city?: string }>(`/api/lookups/pincode/${pin}`);
      if (r.found) { set({ state: r.state ?? '', city: r.city ?? '', district: r.city ?? '' }); setPinState('ok'); }
      else setPinState('miss');
    } catch { setPinState('miss'); }
  }

  // IFSC → bank/branch autofill (debounced), mirroring the bank-account form.
  useEffect(() => {
    const code = f.ifsc.trim().toUpperCase();
    if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(code)) { setIfscState('idle'); return; }
    let cancelled = false;
    setIfscState('looking');
    const t = setTimeout(async () => {
      try {
        const r = await api.get<{ found: boolean; bank?: string; branch?: string; city?: string }>(`/api/lookups/ifsc/${code}`);
        if (cancelled) return;
        if (r.found) { set({ bank_name: r.bank ?? '', branch_name: r.branch ?? '', branch_city: r.city ?? '' }); setIfscState('ok'); }
        else setIfscState('miss');
      } catch { if (!cancelled) setIfscState('miss'); }
    }, 400);
    return () => { cancelled = true; clearTimeout(t); };
  }, [f.ifsc]);

  async function runPennyDrop() {
    setPenny(null); setPennyBusy(true);
    try {
      const r = await api.post<{ status: string; name_on_record: string | null; detail: string }>('/api/lookups/penny-drop', {
        account_number: f.account_number.trim(), ifsc: f.ifsc.trim().toUpperCase(), name: f.bank_holder_name.trim() || undefined,
      });
      setPenny({ status: r.status, name: r.name_on_record, detail: r.detail });
      if (r.status === 'Verified' && r.name_on_record && !f.bank_holder_name.trim()) set({ bank_holder_name: r.name_on_record });
    } catch (e) { setPenny({ status: 'Failed', detail: e instanceof ApiError ? e.message : 'Verification failed' }); }
    finally { setPennyBusy(false); }
  }

  // Debounced autosave of the text fields (Google-Sheets-style) so an accidental
  // close never loses typed data; cleared on a successful save or "Start fresh".
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        if (isDirty(f)) localStorage.setItem(DRAFT_KEY, JSON.stringify({ f, step }));
        else localStorage.removeItem(DRAFT_KEY);
      } catch { /* storage disabled / quota — best-effort */ }
    }, 500);
    return () => clearTimeout(t);
  }, [f, step]);

  const clearDraft = () => { try { localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ } };
  const startFresh = () => {
    clearDraft();
    setF(EMPTY); setStep(0); setRestored(false); setErr(''); setDup(null);
    setFiles({ pan_card: null, aadhaar_card: null, customer_photo: null, customer_signature: null, address_proof: null, cml: null, bank_proof: null, nominee_kyc: null });
  };

  async function persist(): Promise<number> {
    const personal: Record<string, unknown> = { full_name: f.full_name.trim(), is_nri: f.is_nri, tds_applicable: f.tds !== 'no' };
    const put = (k: string, v: string) => { if (v.trim()) personal[k] = v.trim(); };
    put('pan', f.pan); put('dob', f.dob); put('gender', f.gender); put('phone', f.phone);
    put('email', f.email); put('address', f.address); put('pincode', f.pincode); put('city', f.city); put('district', f.district); put('state', f.state);
    put('referred_by_text', f.referred_by_text); put('father_name', f.father_name); put('occupation', f.occupation);
    put('phone_secondary', f.phone_secondary); put('investor_category', f.investor_category); put('ckyc_number', f.ckyc_number);
    // Send the FULL Aadhaar when all 12 are entered (owner 2026-07-21: stored and
    // printed on the application form) — the backend derives last-4 from it.
    // Previously this only ever sent the last 4, so the full number the operator
    // typed was thrown away and the form printed blanks.
    const aadhaarDigits = f.aadhaar.replace(/\D/g, '');
    if (aadhaarDigits.length === 12) personal.aadhaar = aadhaarDigits;
    else if (aadhaarDigits.length >= 4) personal.aadhaar_last4 = aadhaarDigits.slice(-4);

    const { id } = await api.post<{ id: number }>('/api/customers', personal);

    if (f.dp_id.trim() || f.client_id.trim() || f.depository)
      await api.put(`/api/customers/${id}/demat`, { dp_id: f.dp_id.trim(), client_id: f.client_id.trim(), depository: f.depository || null });

    for (const [doc_type, file] of Object.entries(files)) {
      if (!file) continue;
      const data_base64 = await readBase64(file);
      if (data_base64) await api.post(`/api/customers/${id}/documents`, { doc_type, filename: file.name, mime: file.type || 'application/octet-stream', data_base64 });
    }

    if (f.account_number.trim() && f.ifsc.trim())
      await api.post(`/api/customers/${id}/bank-accounts`, {
        account_number: f.account_number.trim(), ifsc: f.ifsc.trim().toUpperCase(),
        bank_name: f.bank_name.trim() || undefined, branch_name: f.branch_name.trim() || undefined, branch_city: f.branch_city.trim() || undefined,
        account_type: f.account_type || undefined, holder_name: f.bank_holder_name.trim() || undefined, tds_applicable: f.tds !== 'no',
      });

    if (f.nom_full_name.trim())
      await api.put(`/api/customers/${id}/nominees`, { nominees: [{
        full_name: f.nom_full_name.trim(), dob: f.nom_dob || null, relationship: f.nom_relationship || null,
        kyc_id_type: f.nom_kyc_type || null, kyc_id_number: f.nom_kyc_number.trim() || null,
        phone: f.nom_phone.trim() || null, address: f.nom_address.trim() || null,
        guardian_name: f.guardian_name.trim() || null, guardian_pan: f.guardian_pan.trim() || null,
      }] });

    return id;
  }

  // Customer is created live (no approval — owner 2026-07-21). goInvest → open
  // their profile, where the "Add investment" form is ready; else just close.
  async function finish(goInvest: boolean) {
    if (!f.full_name.trim()) { setErr('Full name is required.'); setStep(0); return; }
    setErr(''); setDup(null); setBusy(true);
    try {
      const id = await persist();
      clearDraft(); // saved server-side now — drop the local autosave
      // Link the originating lead (if any) BEFORE we navigate away, so a link
      // failure is shown here rather than lost.
      if (onCreated) await onCreated(id);
      qc.invalidateQueries({ queryKey: ['customers'] });
      onClose();
      if (goInvest) nav(`/app/customers/${id}`);
    } catch (e) {
      const d = e instanceof ApiError ? (e.detail as { existing_customer?: { id: number; customer_code: string; full_name: string } } | undefined) : undefined;
      if (d?.existing_customer) setDup(d.existing_customer);
      setErr(e instanceof ApiError ? e.message : 'Save failed');
    } finally { setBusy(false); }
  }

  // Backdrop does NOT close on click — a stray outside-click must never discard
  // an in-progress enrolment. Close via ✕ / Cancel (the draft autosaves anyway).
  return (
    <div className="fixed inset-0 z-40 bg-black/40 flex items-start justify-center overflow-y-auto py-6 px-4">
      <div className="bg-surface border border-border rounded-lg shadow-lg w-full max-w-3xl">
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-border sticky top-0 bg-surface z-10">
          <h2 className="text-base font-bold m-0">Enroll customer</h2>
          <button onClick={onClose} className="text-text-muted hover:text-text text-lg leading-none" aria-label="Close">✕</button>
        </div>

        {restored && (
          <div className="flex items-center justify-between gap-2 px-5 py-2 border-b border-border bg-[color:var(--success-bg,#f0fdf4)] text-xs">
            <span className="text-text-muted">↩ Resumed your unsaved draft — it autosaves as you type.</span>
            <button onClick={startFresh} className="text-primary hover:underline font-medium whitespace-nowrap">Start fresh</button>
          </div>
        )}

        {/* Step strip */}
        <div className="flex flex-wrap gap-1 px-5 py-3 border-b border-border bg-bg/50">
          {STEPS.map((label, i) => (
            <button key={label} onClick={() => setStep(i)}
              className={`text-xs rounded-full px-3 py-1 flex items-center gap-1.5 ${i === step ? 'bg-primary text-white' : i < step ? 'text-success' : 'text-text-muted'}`}>
              <span className={`inline-flex items-center justify-center w-4 h-4 rounded-full text-[10px] ${i === step ? 'bg-white/20' : i < step ? 'bg-[color:var(--success-bg)]' : 'bg-border'}`}>{i < step ? '✓' : i + 1}</span>
              {label}
            </button>
          ))}
        </div>

        <div className="p-5 max-h-[65vh] overflow-y-auto">
          {step === 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3">
              <div className="sm:col-span-2"><Field label="Full name" required><input className={inp} value={f.full_name} onChange={(e) => set({ full_name: e.target.value })} autoFocus /></Field></div>
              <Field label="Father's name"><input className={inp} value={f.father_name} onChange={(e) => set({ father_name: e.target.value })} /></Field>
              <Field label="Occupation" hint="e.g. Salaried, Business, Retired"><input className={inp} value={f.occupation} onChange={(e) => set({ occupation: e.target.value })} /></Field>
              <Field label="Date of birth"><input className={inp} type="date" value={f.dob} onChange={(e) => set({ dob: e.target.value })} /></Field>
              <Field label="Age / category" hint="Auto from DOB; senior citizen = 60+ (drives TDS filing category)">
                <div className={`${inp} flex items-center gap-2 bg-bg`}>
                  {ageFromDob(f.dob) != null ? (<>
                    <span className="font-semibold">{ageFromDob(f.dob)} yrs</span>
                    <span className={`text-[11px] rounded px-1.5 py-0.5 ${ageFromDob(f.dob)! >= 60 ? 'bg-[color:var(--warn-bg)] text-warn' : 'bg-border text-text-muted'}`}>{ageFromDob(f.dob)! >= 60 ? 'Senior citizen' : 'General'}</span>
                  </>) : <span className="text-text-muted">—</span>}
                </div>
              </Field>
              <Field label="Gender"><select className={inp} value={f.gender} onChange={(e) => set({ gender: e.target.value })}><option value="">—</option>{GENDERS.map((g) => <option key={g}>{g}</option>)}</select></Field>
              <Field label="PAN"><input className={`${inp} uppercase`} placeholder="ABCDE1234F" maxLength={10} value={f.pan} onChange={(e) => set({ pan: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10) })} /></Field>
              <Field label="Aadhaar (12 digits)" hint="Enter all 12 digits — the full Aadhaar is stored and printed on the application form."><input className={inp} inputMode="numeric" maxLength={12} placeholder="Full 12-digit Aadhaar" value={f.aadhaar} onChange={(e) => set({ aadhaar: e.target.value.replace(/\D/g, '') })} /></Field>
              <Field label="Phone (primary)"><input className={inp} inputMode="numeric" maxLength={10} value={f.phone} onChange={(e) => set({ phone: e.target.value.replace(/\D/g, '') })} /></Field>
              <Field label="Phone (secondary)"><input className={inp} inputMode="numeric" maxLength={10} value={f.phone_secondary} onChange={(e) => set({ phone_secondary: e.target.value.replace(/\D/g, '') })} /></Field>
              <Field label="Email"><input className={inp} type="email" value={f.email} onChange={(e) => set({ email: e.target.value })} /></Field>
              <Field label="Investor category"><select className={inp} value={f.investor_category} onChange={(e) => set({ investor_category: e.target.value })}><option value="">—</option>{CATEGORIES.map((c) => <option key={c}>{c}</option>)}</select></Field>
              <div className="sm:col-span-2"><Field label="Address"><input className={inp} value={f.address} onChange={(e) => set({ address: e.target.value })} /></Field></div>
              <Field label="Pincode" hint={pinState === 'looking' ? 'Looking up…' : pinState === 'ok' ? '✓ City/State filled — edit if needed' : pinState === 'miss' ? 'Not found — enter city/state manually' : 'Auto-fills city & state'}>
                <input className={inp} inputMode="numeric" maxLength={6} placeholder="6-digit PIN" value={f.pincode} onChange={(e) => onPincode(e.target.value)} />
              </Field>
              <Field label="City"><input className={inp} value={f.city} onChange={(e) => set({ city: e.target.value })} /></Field>
              <Field label="District"><input className={inp} value={f.district} onChange={(e) => set({ district: e.target.value })} /></Field>
              <Field label="State"><input className={inp} value={f.state} onChange={(e) => set({ state: e.target.value })} /></Field>
              <Field label="Referred by" hint="Pick an agent/staff code — or type a new name (becomes an agent after approval)"><ReferredByPicker value={f.referred_by_text} onChange={(v) => set({ referred_by_text: v })} /></Field>
              <label className="text-xs flex items-center gap-1.5 mt-1"><input type="checkbox" checked={f.is_nri} onChange={(e) => set({ is_nri: e.target.checked })} />NRI</label>
            </div>
          )}

          {step === 1 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3">
              <p className="sm:col-span-2 text-xs text-text-muted -mb-1">DP ID and Client ID are 8 characters each (NSDL/CDSL standard). Optional at this stage.</p>
              <Field label="Depository"><select className={inp} value={f.depository} onChange={(e) => set({ depository: e.target.value })}><option value="">—</option>{DEPOSITORIES.map((d) => <option key={d}>{d}</option>)}</select></Field>
              <div />
              <Field label="DP ID (8 chars)" hint="NSDL starts with IN; 8-digit numeric = CDSL — depository auto-fills"><input className={`${inp} uppercase`} placeholder="e.g. IN300456" maxLength={8} value={f.dp_id} onChange={(e) => { const v = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8); const dep = depositoryFromDpId(v); set(dep ? { dp_id: v, depository: dep } : { dp_id: v }); }} /></Field>
              <Field label="Client ID (8 digits)"><input className={inp} inputMode="numeric" placeholder="e.g. 12345678" maxLength={8} value={f.client_id} onChange={(e) => set({ client_id: e.target.value.replace(/\D/g, '').slice(0, 8) })} /></Field>
              <div className="sm:col-span-2"><FilePick label="CML copy" hint="Client Master List from depository — PDF or image scan" file={files.cml} onPick={(x) => setFile('cml', x)} /></div>
            </div>
          )}

          {step === 2 && (
            <div>
              <p className="text-xs text-text-muted mb-3">Upload PDF or image scans (max 10 MB each). All documents are optional at this stage — they can be collected later.</p>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <FilePick label="PAN card" hint="Front side, clear scan" file={files.pan_card} onPick={(x) => setFile('pan_card', x)} />
                <FilePick label="Aadhaar card" hint="Both sides / e-Aadhaar PDF" file={files.aadhaar_card} onPick={(x) => setFile('aadhaar_card', x)} />
                <FilePick label="Customer photo" hint="Passport-size, clear face" file={files.customer_photo} onPick={(x) => setFile('customer_photo', x)} />
                <FilePick label="Customer signature" hint="On white paper, scanned" file={files.customer_signature} onPick={(x) => setFile('customer_signature', x)} />
                <FilePick label="Address proof" hint="Aadhaar / Voter ID / utility bill" file={files.address_proof} onPick={(x) => setFile('address_proof', x)} />
              </div>
              <div className="mt-3 max-w-sm"><Field label="CKYC number (optional)"><input className={inp} value={f.ckyc_number} onChange={(e) => set({ ckyc_number: e.target.value })} /></Field></div>
            </div>
          )}

          {step === 3 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3">
              <p className="sm:col-span-2 text-xs text-text-muted -mb-1">Where monthly interest lands. Enter an account + IFSC to save it now, or add it later.</p>
              <div className="sm:col-span-2"><Field label="Beneficiary name (as on passbook)"><input className={inp} value={f.bank_holder_name} onChange={(e) => set({ bank_holder_name: e.target.value })} /></Field></div>
              <Field label="Account number"><input className={inp} value={f.account_number} onChange={(e) => set({ account_number: e.target.value.replace(/\s/g, '') })} /></Field>
              <Field label="Account type"><select className={inp} value={f.account_type} onChange={(e) => set({ account_type: e.target.value })}><option value="">—</option>{ACCOUNT_TYPES.map((t) => <option key={t}>{t}</option>)}</select></Field>
              <div className="sm:col-span-2">
                <Field label="TDS applicable on interest payouts?">
                  <div className="flex gap-4 text-sm">
                    <label className="flex items-center gap-1.5"><input type="radio" name="tds" checked={f.tds === 'yes'} onChange={() => set({ tds: 'yes' })} /> Yes — deduct 10% TDS</label>
                    <label className="flex items-center gap-1.5"><input type="radio" name="tds" checked={f.tds === 'no'} onChange={() => set({ tds: 'no' })} /> No — exempt (15G / 15H / Form 12BB filer)</label>
                  </div>
                </Field>
              </div>
              <Field label="IFSC" hint={ifscState === 'looking' ? 'Looking up…' : ifscState === 'ok' ? '✓ Bank/branch filled' : ifscState === 'miss' ? 'Not found — enter bank/branch manually' : 'Auto-fills bank & branch'}><input className={`${inp} uppercase`} placeholder="e.g. SBIN0001234" value={f.ifsc} onChange={(e) => set({ ifsc: e.target.value.toUpperCase() })} /></Field>
              <Field label="Bank name"><input className={inp} value={f.bank_name} onChange={(e) => set({ bank_name: e.target.value })} /></Field>
              <Field label="Branch name"><input className={inp} value={f.branch_name} onChange={(e) => set({ branch_name: e.target.value })} /></Field>
              <Field label="Branch city"><input className={inp} value={f.branch_city} onChange={(e) => set({ branch_city: e.target.value })} /></Field>
              <div className="sm:col-span-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <button type="button" disabled={pennyBusy || f.account_number.trim().length < 4 || !/^[A-Za-z]{4}0[A-Za-z0-9]{6}$/.test(f.ifsc.trim())}
                    onClick={runPennyDrop} className="text-xs border border-border-strong rounded px-3 py-1.5 hover:bg-bg disabled:opacity-40">
                    {pennyBusy ? 'Verifying…' : '⛃ Penny-drop verify'}
                  </button>
                  {penny && (
                    <span className={`text-xs rounded px-2 py-0.5 ${penny.status === 'Verified' ? 'bg-[color:var(--success-bg)] text-success' : 'bg-[color:var(--danger-bg)] text-danger'}`}>
                      {penny.status === 'Verified' ? `✓ Verified${penny.name ? ' — ' + penny.name : ''}` : `✗ ${penny.detail ?? 'Not verified'}`}
                    </span>
                  )}
                </div>
              </div>
              <div className="sm:col-span-2"><FilePick label="Cheque / passbook image" hint="Shows account number + IFSC + name" file={files.bank_proof} onPick={(x) => setFile('bank_proof', x)} /></div>
            </div>
          )}

          {step === 4 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3">
              <p className="sm:col-span-2 text-xs text-text-muted -mb-1">Optional. Only the nominee's name is required if a nominee is being added.</p>
              <div className="sm:col-span-2"><Field label="Full name" hint="Required only if a nominee is being added"><input className={inp} value={f.nom_full_name} onChange={(e) => set({ nom_full_name: e.target.value })} /></Field></div>
              <Field label="Date of birth"><input className={inp} type="date" value={f.nom_dob} onChange={(e) => set({ nom_dob: e.target.value })} /></Field>
              <Field label="Relationship"><select className={inp} value={f.nom_relationship} onChange={(e) => set({ nom_relationship: e.target.value })}><option value="">—</option>{RELATIONSHIPS.map((r) => <option key={r}>{r}</option>)}</select></Field>
              <Field label="Nominee phone"><input className={inp} inputMode="numeric" maxLength={10} value={f.nom_phone} onChange={(e) => set({ nom_phone: e.target.value.replace(/\D/g, '') })} /></Field>
              <Field label="Nominee KYC" hint="Aadhaar or PAN of the nominee">
                <div className="flex gap-2">
                  <select className={`${inp} w-28`} value={f.nom_kyc_type} onChange={(e) => set({ nom_kyc_type: e.target.value })}><option value="">Type…</option><option value="Aadhaar">Aadhaar</option><option value="PAN">PAN</option></select>
                  <input className={inp} placeholder={f.nom_kyc_type === 'PAN' ? 'ABCDE1234F' : f.nom_kyc_type === 'Aadhaar' ? '12-digit Aadhaar' : 'ID number'}
                    value={f.nom_kyc_number} onChange={(e) => set({ nom_kyc_number: f.nom_kyc_type === 'PAN' ? e.target.value.toUpperCase() : e.target.value })} />
                </div>
              </Field>
              <div className="sm:col-span-2"><FilePick label="Nominee KYC photo" hint="Aadhaar / PAN scan of the nominee (image or PDF)" file={files.nominee_kyc} onPick={(x) => setFile('nominee_kyc', x)} /></div>
              <div className="sm:col-span-2"><Field label="Nominee address"><textarea className={inp} rows={2} value={f.nom_address} onChange={(e) => set({ nom_address: e.target.value })} /></Field></div>
              <Field label="Guardian name (if minor)"><input className={inp} value={f.guardian_name} onChange={(e) => set({ guardian_name: e.target.value })} /></Field>
              <Field label="Guardian PAN (if minor)"><input className={`${inp} uppercase`} value={f.guardian_pan} onChange={(e) => set({ guardian_pan: e.target.value.toUpperCase() })} /></Field>
            </div>
          )}

          {step === 5 && <Review f={f} files={files} />}
        </div>

        {err && <div className="text-xs text-danger px-5 pb-1">{err}</div>}
        {dup && (
          <div className="text-xs px-5 pb-2">
            Existing customer: <button className="font-mono text-primary underline" onClick={() => { onClose(); nav(`/app/customers/${dup.id}`); }}>{dup.customer_code}</button> ({dup.full_name}) — open them to book the new investment and use <b>Request handover</b> there (Admin/CXO/BM approve).
          </div>
        )}
        <div className="flex items-center justify-between gap-2 px-5 py-3.5 border-t border-border">
          <button onClick={() => (step === 0 ? onClose() : setStep(step - 1))} className="text-sm text-text-muted hover:underline px-3 py-1.5">
            {step === 0 ? 'Cancel' : '← Back'}
          </button>
          <div className="flex items-center gap-2">
            <button disabled={busy} onClick={() => finish(false)} className="text-sm border border-border-strong rounded px-4 py-1.5 hover:border-primary disabled:opacity-40">Save &amp; exit</button>
            {step < 5
              ? <button onClick={() => setStep(step + 1)} className="text-sm bg-primary hover:bg-primary-hover text-white rounded px-5 py-1.5 font-semibold">Next →</button>
              : <button disabled={busy} onClick={() => finish(true)} className="text-sm bg-primary hover:bg-primary-hover text-white rounded px-5 py-1.5 font-semibold disabled:opacity-40">Save &amp; add investment →</button>}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Review ─────────────────────────────────────────────────────────────────
function Review({ f, files }: { f: Form; files: Record<DocKey, File | null> }) {
  const dash = (v: string) => (v && v.trim() ? v : '—');
  const docCount = Object.values(files).filter(Boolean).length;
  const Row = ({ k, v }: { k: string; v: string }) => (
    <div className="flex justify-between gap-4 py-1 border-b border-border/40 text-sm"><span className="text-text-muted">{k}</span><span className="text-right font-medium">{v}</span></div>
  );
  const Section = ({ title, children }: { title: string; children: ReactNode }) => (
    <div className="bg-bg rounded-lg p-4 mb-3">
      <div className="text-xs font-bold text-text-label uppercase tracking-wide mb-2">{title}</div>
      {children}
    </div>
  );
  return (
    <div>
      <p className="text-sm text-text-muted mb-3">Verify everything below. The customer is created <strong>live immediately</strong> — no separate approval. <strong>Save &amp; add investment</strong> opens their profile so you can add the investment straight away; the investment is what goes to the Approvals queue, where the approver reviews the customer profile and the investment together.</p>
      <Section title="Personal">
        <Row k="Name" v={dash(f.full_name)} /><Row k="Father's name" v={dash(f.father_name)} /><Row k="Occupation" v={dash(f.occupation)} />
        <Row k="DOB" v={dash(f.dob)} /><Row k="Gender" v={dash(f.gender)} /><Row k="PAN" v={dash(f.pan)} />
        <Row k="Aadhaar" v={dash(f.aadhaar)} /><Row k="Phone" v={dash(f.phone)} /><Row k="Alt phone" v={dash(f.phone_secondary)} />
        <Row k="Email" v={dash(f.email)} /><Row k="Category" v={dash(f.investor_category)} />
        <Row k="Address" v={[f.address, f.city, f.district, f.state].filter(Boolean).join(', ') || '—'} /><Row k="NRI" v={f.is_nri ? 'Yes' : 'No'} />
      </Section>
      <Section title="Demat">
        <Row k="Depository" v={dash(f.depository)} /><Row k="DP ID" v={dash(f.dp_id)} /><Row k="Client ID" v={dash(f.client_id)} />
      </Section>
      <Section title={`KYC docs (${docCount})`}>
        {docCount === 0 ? <div className="text-sm text-text-muted">No documents uploaded.</div>
          : Object.entries(files).filter(([, x]) => x).map(([k, x]) => <Row key={k} k={k.replace(/_/g, ' ')} v={x!.name} />)}
        <Row k="CKYC number" v={dash(f.ckyc_number)} />
      </Section>
      <Section title="Bank">
        <Row k="Beneficiary" v={dash(f.bank_holder_name)} /><Row k="Account" v={dash(f.account_number)} /><Row k="Type" v={dash(f.account_type)} />
        <Row k="TDS" v={f.tds === 'no' ? 'Exempt' : 'Deduct 10%'} /><Row k="IFSC" v={dash(f.ifsc)} />
        <Row k="Bank" v={dash(f.bank_name)} /><Row k="Branch" v={[f.branch_name, f.branch_city].filter(Boolean).join(', ') || '—'} />
      </Section>
      <Section title="Nominee">
        {f.nom_full_name.trim()
          ? <><Row k="Name" v={dash(f.nom_full_name)} /><Row k="Relationship" v={dash(f.nom_relationship)} /><Row k="DOB" v={dash(f.nom_dob)} /><Row k="KYC" v={f.nom_kyc_type ? `${f.nom_kyc_type} ${f.nom_kyc_number}`.trim() : '—'} /><Row k="Phone" v={dash(f.nom_phone)} /></>
          : <div className="text-sm text-text-muted">No nominee added.</div>}
      </Section>
    </div>
  );
}
