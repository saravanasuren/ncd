#!/usr/bin/env node
/**
 * diagnose-rent-status — why does ONE customer's locker rent read Unpaid (or Paid)?
 *
 * STRICTLY READ-ONLY. It runs SELECTs against NCD's database and makes GET
 * requests to LockerHub. It writes no row, calls no settle/waive/approve
 * endpoint, and prints no key or secret.
 *
 *   cd ~/ncd/api
 *   set -a && . ./.env && set +a
 *   node ../ops/diagnose-rent-status.mjs <DHN0892 | APP-2026-01234 | lockerhub id | 10-digit phone>
 *
 * For every locker application that belongs to that customer — NCD's own index,
 * every table that points at an application, and LockerHub's roster by phone —
 * it prints, side by side:
 *   1. What LockerHub says about the rent leg: amount, original_amount, the
 *      waiver fields, settled, status. This is the ONLY thing the report trusts
 *      for "was it paid".
 *   2. What NCD recorded about the money: fee waivers (with status), cleared
 *      cheques and approved/pending transfers, and whether each was ever
 *      settled on LockerHub.
 *   3. The rent price LockerHub keeps on the customer record (the Tenants
 *      "Rent" column) against the leg amount (the Report's), so the ₹20,000 vs
 *      ₹23,600 difference is explained by numbers, not by argument.
 * and ends with one VERDICT line per application, plus DUPLICATES when the same
 * customer/locker has more than one application (a stale one reads Unpaid while
 * the live one is Paid).
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const settledLike = (leg) => leg?.settled === true || /paid|settled|success|complete/i.test(String(leg?.status ?? ''));
const last10 = (v) => String(v ?? '').replace(/\D/g, '').slice(-10);
const money = (n) => (n == null || n === '' ? '-' : `₹${Number(n).toLocaleString('en-IN')}`);

/**
 * @param {{ db: { query: Function }, lh: { get: (path: string) => Promise<any> }, ref: string }} p
 */
export async function diagnose({ db, lh, ref: given }) {
  const out = [];
  const say = (s = '') => out.push(s);
  const ref = String(given).trim();
  const result = { ref, apps: [], verdicts: [] };

  // ── who is this? ────────────────────────────────────────────────────────
  const ids = new Set();
  const phones = new Set();
  const customers = [];
  const byCode = /^DHN/i.test(ref);
  const byApp = /^APP-/i.test(ref);
  const isPhone = /^\+?[\d\s-]{10,15}$/.test(ref);
  if (byCode) {
    const c = (await db.query('SELECT id, full_name, customer_code, phone FROM customers WHERE upper(customer_code) = upper($1)', [ref])).rows;
    customers.push(...c);
  } else if (byApp) {
    const r = (await db.query('SELECT lockerhub_application_id, customer_id, phone FROM locker_applications WHERE application_no = $1', [ref])).rows;
    for (const x of r) { ids.add(String(x.lockerhub_application_id)); if (x.phone) phones.add(last10(x.phone)); }
  } else if (isPhone) {
    phones.add(last10(ref));
  } else {
    ids.add(ref);
  }
  for (const c of customers) {
    if (c.phone) phones.add(last10(c.phone));
    const r = (await db.query('SELECT lockerhub_application_id FROM locker_applications WHERE customer_id = $1', [c.id])).rows;
    for (const x of r) ids.add(String(x.lockerhub_application_id));
  }
  // an id's own phone widens the search to the person's other applications
  for (const id of [...ids]) {
    const r = (await db.query('SELECT phone, customer_id FROM locker_applications WHERE lockerhub_application_id = $1', [id])).rows[0];
    if (r?.phone) phones.add(last10(r.phone));
  }
  if (phones.size) {
    const r = (await db.query(
      `SELECT lockerhub_application_id FROM locker_applications
        WHERE right(regexp_replace(COALESCE(phone,''), '\\D', '', 'g'), 10) = ANY($1)`, [[...phones]])).rows;
    for (const x of r) ids.add(String(x.lockerhub_application_id));
  }

  // ── LockerHub's roster: the tenancies this phone holds ─────────────────
  let roster = [];
  let rosterError = null;
  try { roster = (await lh.get('/locker-tenants'))?.tenants ?? []; } catch (e) { rosterError = e.message; }
  const myTenancies = roster.filter((t) => phones.has(last10(t.tenant?.phone)) || ids.has(String(t.application_id ?? '')));
  for (const t of myTenancies) if (t.application_id) ids.add(String(t.application_id));

  say(`Looking for: ${ref}${customers.length ? `  (${customers.map((c) => `${c.full_name} ${c.customer_code}`).join(', ')})` : ''}`);
  say(`Phones: ${[...phones].join(', ') || '-'}   Applications found: ${ids.size}   LockerHub roster: ${rosterError ? `UNREADABLE (${rosterError})` : `${roster.length} tenancies, ${myTenancies.length} theirs`}`);
  if (!ids.size) {
    say('');
    say('VERDICT: no locker application is linked to that reference in NCD or on the LockerHub roster.');
    return { ...result, text: out.join('\n') };
  }

  // ── the customer record LockerHub keeps (the Tenants "Rent" column) ────
  const customerRecords = new Map();
  for (const ph of phones) {
    try { const d = await lh.get(`/customers/${encodeURIComponent(ph)}`); if (d?.found) customerRecords.set(ph, d); }
    catch (e) { say(`(customer record for ${ph}: ${e.message})`); }
  }

  const rows = [];
  for (const id of [...ids].sort()) {
    say(''); say(`── application ${id} ${'─'.repeat(40)}`);
    let app = null;
    try { app = await lh.get(`/locker-applications/${encodeURIComponent(id)}`); }
    catch (e) { say(`   LockerHub: could not read it — ${e.message}`); }
    const ncd = (await db.query('SELECT application_no, customer_id, phone, locker_number, status FROM locker_applications WHERE lockerhub_application_id = $1', [id])).rows[0];
    const lockerNo = app?.allotment?.locker_number ?? app?.allotment?.locker_no ?? app?.locker_no ?? ncd?.locker_number ?? null;
    const onRoster = myTenancies.find((t) => String(t.application_id ?? '') === id);
    say(`   ${app?.application_no ?? ncd?.application_no ?? '-'}  locker=${lockerNo ?? '-'}  size=${app?.locker_size ?? '-'}  status=${app?.status ?? app?.application_status ?? ncd?.status ?? '-'}  on roster=${onRoster ? 'YES (tenant ' + onRoster.tenant_id + ')' : 'no'}`);

    const leg = app?.legs?.rent;
    if (app) {
      say(`1. LockerHub rent leg: settled=${JSON.stringify(leg?.settled)} status=${JSON.stringify(leg?.status)}`);
      say(`   amount=${money(leg?.amount)} original_amount=${money(leg?.original_amount)} waiver_pct=${leg?.waiver_pct ?? '-'} waiver_amount=${money(leg?.waiver_amount)}`);
      const extra = Object.keys(leg ?? {}).filter((k) => !['amount', 'original_amount', 'waiver_pct', 'waiver_amount', 'settled', 'status'].includes(k));
      if (extra.length) say(`   other leg fields: ${extra.map((k) => `${k}=${JSON.stringify(leg[k])}`).join(' ')}`);
      const pays = Array.isArray(app.payments) ? app.payments : [];
      say(`   payments on the application: ${pays.length}${pays.length ? ' — ' + pays.map((p) => `${p.leg ?? p.type ?? '?'} ${money(p.amount)} ${p.status ?? ''} ${p.method ?? p.mode ?? ''}`.trim()).join('; ') : ''}`);
    }

    const w = (await db.query(`SELECT id, category, waiver_pct, waiver_amount, status, lockerhub_applied_at, lockerhub_error, reason FROM locker_fee_waivers WHERE lockerhub_application_id = $1 AND leg = 'rent' ORDER BY id`, [id])).rows;
    const q = (await db.query(`SELECT cheque_no, status, amount, lockerhub_settled_at, lockerhub_error FROM locker_cheques WHERE lockerhub_application_id = $1 AND leg = 'rent' ORDER BY id`, [id])).rows;
    const o = (await db.query(`SELECT method, reference, status, amount, lockerhub_settled_at, lockerhub_error FROM locker_offline_payments WHERE lockerhub_application_id = $1 AND leg = 'rent' ORDER BY id`, [id])).rows;
    say(`2. NCD rent waivers: ${w.length || 'none'}`);
    for (const x of w) say(`   #${x.id} ${x.category} ${x.status} pct=${x.waiver_pct ?? '-'} amount=${money(x.waiver_amount)} pushed to LockerHub=${x.lockerhub_applied_at ? 'yes' : 'NO'}${x.lockerhub_error ? ' error=' + x.lockerhub_error : ''}`);
    say(`   NCD cheques (rent): ${q.length || 'none'}`);
    for (const x of q) say(`   ${x.cheque_no} ${x.status} ${money(x.amount)} settled on LockerHub=${x.lockerhub_settled_at ? 'yes' : 'NO'}${x.lockerhub_error ? ' error=' + x.lockerhub_error : ''}`);
    say(`   NCD transfers (rent): ${o.length || 'none'}`);
    for (const x of o) say(`   ${x.method} ${x.reference ?? ''} ${x.status} ${money(x.amount)} settled on LockerHub=${x.lockerhub_settled_at ? 'yes' : 'NO'}${x.lockerhub_error ? ' error=' + x.lockerhub_error : ''}`);

    // 3 — the two "rent" numbers
    const rec = customerRecords.get(last10(app?.phone ?? ncd?.phone ?? [...phones][0]));
    const mine = (rec?.lockers ?? []).find((l) => String(l.locker_number ?? '') === String(lockerNo ?? '') && lockerNo);
    const price = mine?.annual_rent ?? null;
    say(`3. Tenants "Rent" column = customer record annual_rent = ${money(price)};  Report "Rent" column = leg amount = ${money(leg?.amount ?? leg?.original_amount)}`);
    let priceNote = null;
    if (price != null && leg?.amount != null && Number(price) > 0) {
      const ratio = Number(leg.amount) / Number(price);
      priceNote = Math.abs(ratio - 1) < 0.001 ? 'leg amount equals the pre-tax price — the standard GST waiver IS applied (customer pays the round figure)'
        : Math.abs(ratio - 1.18) < 0.005 ? 'leg amount is price + 18% GST — NO standard GST waiver is applied on LockerHub for this application'
        : `leg amount is ${ratio.toFixed(4)}× the price — neither the plain price nor price+18%`;
      say(`   ${priceNote}`);
    }

    // verdict
    const okLike = settledLike(leg);
    const ncdMoney = q.find((x) => x.status === 'Cleared' && !x.lockerhub_settled_at) ?? o.find((x) => x.status === 'Approved' && !x.lockerhub_settled_at);
    const pendingPay = o.find((x) => x.status === 'PendingApproval');
    const approvedWaiver = w.find((x) => x.status === 'Approved');
    const pendingWaiver = w.find((x) => x.status === 'PendingApproval');
    let verdict;
    if (!app) verdict = 'UNREADABLE — LockerHub would not return this application; the report shows Unknown (this build) / Unpaid (old build).';
    else if (approvedWaiver && approvedWaiver.category === 'premium') verdict = 'PREMIUM — an approved premium waiver is in force.';
    else if (okLike) verdict = 'PAID — LockerHub shows the rent leg settled.';
    else if (ncdMoney) verdict = `PAID IN NCD, NOT SETTLED ON LOCKERHUB — ${ncdMoney.cheque_no ? 'cheque ' + ncdMoney.cheque_no : 'transfer ' + (ncdMoney.reference ?? '')} is recorded in NCD but LockerHub never marked the leg settled${ncdMoney.lockerhub_error ? ' (' + ncdMoney.lockerhub_error + ')' : ''}. The customer paid; the settlement call failed. Retry it from the cheque register / enrolment screen.`;
    else if (pendingPay) verdict = 'PAYMENT AWAITING APPROVAL — a transfer is recorded but no Admin/CXO has approved it, so nothing was sent to LockerHub.';
    else if (pendingWaiver) verdict = `WAIVER REQUEST AWAITING APPROVAL (${pendingWaiver.category}) — not in force; LockerHub shows the rent unsettled.`;
    else verdict = 'UNPAID ON LOCKERHUB, NO PAYMENT RECORDED IN NCD — LockerHub shows the rent unsettled and NCD holds no cheque/transfer for it. If the customer paid, it was by a route neither system recorded against THIS application (see DUPLICATES below).';
    say(`VERDICT: ${verdict}`);
    rows.push({ id, lockerNo, okLike, verdict, phone: last10(app?.phone ?? ncd?.phone), status: app?.status ?? app?.application_status ?? ncd?.status ?? null });
    result.apps.push({ id, lockerNo, settled: okLike });
    result.verdicts.push({ id, verdict });
  }

  // duplicates: same person + same locker (or several open applications) with mixed states
  const byLocker = new Map();
  for (const r of rows) { const k = r.lockerNo ?? `none:${r.id}`; if (!byLocker.has(k)) byLocker.set(k, []); byLocker.get(k).push(r); }
  const dup = [...byLocker.entries()].filter(([, v]) => v.length > 1);
  say(''); say('DUPLICATES');
  if (!dup.length) say('   none — no two applications for this customer name the same locker.');
  for (const [locker, v] of dup) {
    say(`   locker ${locker}: ${v.length} applications — ${v.map((r) => `${r.id} (${r.okLike ? 'rent settled' : 'rent NOT settled'}, status ${r.status ?? '?'})`).join('  |  ')}`);
    if (v.some((r) => r.okLike) && v.some((r) => !r.okLike)) {
      say('   → ONE HAS BEEN PAID AND ANOTHER HAS NOT. The report lists each application, so the unsettled one reads Unpaid even though the locker is paid. That is a stale/duplicate application, not an unpaid customer.');
    }
  }
  const openUnsettled = rows.filter((r) => !r.okLike);
  say('');
  say(openUnsettled.length
    ? `SUMMARY: ${openUnsettled.length} of ${rows.length} application(s) read Unpaid — ${openUnsettled.map((r) => r.id).join(', ')}.`
    : `SUMMARY: every application reads paid/premium.`);
  return { ...result, text: out.join('\n') };
}

// ── CLI ──────────────────────────────────────────────────────────────────
async function main() {
  const ref = process.argv[2];
  if (!ref) { console.error('usage: node ../ops/diagnose-rent-status.mjs <DHN code | APP- number | lockerhub id | phone>   (run from ~/ncd/api)'); process.exit(2); }
  const dist = (p) => import(pathToFileURL(resolve('dist', p)).href);
  const { loadSecretsFromSsm } = await dist('secrets.js');
  await loadSecretsFromSsm();
  const { config } = await dist('config.js');
  const { createDb } = await dist('db/index.js');
  if (!config.LOCKERHUB_API_URL) { console.error('LOCKERHUB_API_URL is not set in this environment.'); process.exit(2); }
  const key = config.LOCKERHUB_API_KEY || config.LOCKERHUB_INTEGRATION_KEY;
  const base = String(config.LOCKERHUB_API_URL).replace(/\/+$/, '');
  const lh = {
    get: async (path) => {
      const r = await fetch(base + path, { headers: { 'X-Integration-Key': key }, signal: AbortSignal.timeout(20000) });
      if (!r.ok) throw new Error(`LockerHub ${r.status} on GET ${path}`);
      return r.json();
    },
  };
  const db = createDb();
  try { console.log((await diagnose({ db, lh, ref })).text); }
  finally { await db.close?.(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
}
