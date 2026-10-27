/**
 * The 5 PM ops digest (owner 2026-10-21: "i would like u to send me a mail
 * everyday if u have any queries like this").
 *
 * Every finding here is one somebody has to ACT on — a payment that cannot
 * leave, work that has stopped, a record that contradicts itself. It is not a
 * dashboard in an email: a number that only goes up and down belongs on a
 * screen, not in an inbox that has to be read every day to stay useful.
 *
 * SENT EVERY DAY, including when everything is clear (owner's choice). If the
 * mail only arrived when something was wrong, a broken job and a good day would
 * look identical from the outside. An "all clear" that stops arriving is itself
 * the alarm.
 *
 * Each check returns its own rows and is wrapped so one failing query cannot
 * take the digest down — a digest that silently stops is the one failure mode
 * that matters most here.
 */
import type { Db } from '../db/types.js';
import { getSettingsMap } from '../modules/settings/service.js';
import { enqueue } from '../modules/notifications/service.js';

export interface DigestItem { label: string; detail?: string }
export interface DigestSection { title: string; blurb: string; items: DigestItem[] }

const inr = (v: unknown) => 'Rs ' + Math.round(Number(v ?? 0)).toLocaleString('en-IN');
/** One check, isolated: its failure is reported in the mail, not thrown. */
async function safe(title: string, blurb: string, run: () => Promise<DigestItem[]>): Promise<DigestSection> {
  try { return { title, blurb, items: await run() }; }
  catch (e) {
    return { title, blurb, items: [{ label: `(this check could not run: ${(e as Error).message.slice(0, 120)})` }] };
  }
}

/** Money that cannot leave the building. */
async function moneyBlocked(db: Db): Promise<DigestSection[]> {
  return [
    await safe('Payouts with nowhere to go',
      'Live investments whose customer has no account the bank can be told to pay. These come out blank on the NEFT file.',
      async () => (await db.query<Record<string, unknown>>(
        `SELECT c.customer_code, c.full_name,
                count(DISTINCT a.id) AS investments,
                (SELECT count(*) FROM customer_bank_accounts b WHERE b.customer_id = c.id) AS accounts_on_file
           FROM customers c JOIN applications a ON a.customer_id = c.id
          WHERE a.status = 'Active'
            AND a.payout_bank_account_id IS NULL
            AND NOT EXISTS (SELECT 1 FROM customer_bank_accounts b
                             WHERE b.customer_id = c.id AND b.is_active AND b.account_number IS NOT NULL)
          GROUP BY c.id, c.customer_code, c.full_name
          ORDER BY (SELECT count(*) FROM customer_bank_accounts b WHERE b.customer_id = c.id) DESC, c.full_name`)).rows
        .map((r) => ({
          label: `${r.customer_code} ${r.full_name} — ${r.investments} investment(s)`,
          // The distinction that decides who fixes it: a ticked box, or a phone call.
          detail: Number(r.accounts_on_file) > 0
            ? `${r.accounts_on_file} account(s) on file, none marked active — someone just needs to tick one`
            : 'no bank account on file at all — details have to be collected',
        }))),

    // DELIBERATELY NOT HERE: "N active accounts are not penny-drop verified".
    // 285 of them are, nearly all from the wealth migration, and the owner has
    // already ruled that pinning does not require verification. A number that
    // is the same every morning teaches the reader to skip the mail, and the
    // next real finding goes with it.
  ];
}

/** Work that has quietly stopped. */
async function stalled(db: Db): Promise<DigestSection[]> {
  return [
    await safe('Locker agreements part-signed',
      'Signing started and stopped. Each is one signature from done.',
      async () => (await db.query<Record<string, unknown>>(
        `SELECT s.status, count(*) AS n FROM locker_agreement_signings s
          WHERE s.status IN ('CustomerSigned', 'AwaitingCEO', 'PendingApproval')
             OR (s.status = 'AwaitingSignature' AND EXISTS (
                  SELECT 1 FROM digio_signing_sessions d
                   WHERE d.locker_agreement_signing_id = s.id AND d.status = 'signed'))
          GROUP BY s.status ORDER BY count(*) DESC`)).rows
        .map((r) => ({
          label: `${r.n} × ${({
            CustomerSigned: 'customer signed — waiting on the authorised signatory',
            AwaitingCEO: 'sent to the authorised signatory',
            PendingApproval: 'scan uploaded — waiting on a checker',
            AwaitingSignature: 'one hirer signed — the joint hirer was never sent a link',
          } as Record<string, string>)[String(r.status)] ?? String(r.status)}`,
        }))),

    await safe('Redemptions waiting on approval',
      'Raised but not yet approved, so nothing can be paid.',
      async () => (await db.query<Record<string, unknown>>(
        `SELECT r.redemption_no, c.full_name, r.principal, r.requested_date,
                (CURRENT_DATE - r.requested_date) AS age_days
           FROM redemptions r JOIN applications a ON a.id = r.application_id
           JOIN customers c ON c.id = a.customer_id
          WHERE r.status = 'Requested'
          ORDER BY r.requested_date`)).rows
        .map((r) => ({
          label: `${r.redemption_no} — ${r.full_name}, ${inr(r.principal)}`,
          detail: `raised ${r.requested_date}${Number(r.age_days) > 7 ? ` — ${r.age_days} days ago` : ''}`,
        }))),
  ];
}

/** Records that contradict themselves. */
async function looksWrong(db: Db): Promise<DigestSection[]> {
  return [
    // GROUPED BY MATURITY DATE, not listed one by one. A whole series coming
    // due is ONE event — NCD 11 maturing on 2026-09-28 put 29 identical lines
    // in the first draft of this mail, and 29 lines that never change is how a
    // daily digest becomes unread. The date and the money are what decide
    // whether to act; the application numbers are a click away.
    await safe('Matured but still Active',
      'The maturity date has passed and the investment is still live.',
      async () => (await db.query<Record<string, unknown>>(
        `SELECT a.maturity_date, count(*) AS n, sum(l.outstanding_amount) AS amount,
                (CURRENT_DATE - a.maturity_date) AS days_over
           FROM applications a JOIN application_lines l ON l.application_id = a.id
          WHERE a.status = 'Active' AND a.maturity_date IS NOT NULL AND a.maturity_date < CURRENT_DATE
          GROUP BY a.maturity_date ORDER BY a.maturity_date`)).rows
        .map((r) => ({
          label: `${r.n} investment(s) worth ${inr(r.amount)} matured on ${r.maturity_date}`,
          detail: `${r.days_over} day(s) ago — still earning interest while they sit Active`,
        }))),

    // The other half of the payout allow-list (owner 2026-10-27). Excluding a
    // product from the monthly cash run is only safe if somebody is told it is
    // excluded — otherwise "does not pay monthly" quietly becomes "never pays".
    // These 8 lines had NO schedule rows at all and a NULL maturity date: the
    // engine does not know the frequency 'AtMaturity', so it generated nothing,
    // and nothing would ever have paid them.
    await safe('Products that will never pay',
      'Live money on a payout frequency the interest engine does not recognise, or with no maturity date. These are out of the monthly run by design — but nothing else pays them either.',
      async () => (await db.query<Record<string, unknown>>(
        `SELECT a.application_no, c.full_name, s.code AS series, l.payout_frequency,
                l.outstanding_amount, a.maturity_date,
                (SELECT count(*) FROM disbursement_schedule d WHERE d.line_id = l.id) AS schedule_rows
           FROM application_lines l
           JOIN applications a ON a.id = l.application_id
           JOIN customers c ON c.id = a.customer_id
           LEFT JOIN series s ON s.id = a.series_id
          WHERE l.status = 'Active' AND a.status = 'Active'
            AND (l.payout_frequency NOT IN ('Monthly','Quarterly','HalfYearly','Annual','Cumulative','LockIn')
                 OR a.maturity_date IS NULL
                 OR NOT EXISTS (SELECT 1 FROM disbursement_schedule d WHERE d.line_id = l.id))
          ORDER BY l.outstanding_amount DESC`)).rows
        .map((r) => ({
          label: `${r.application_no} — ${r.full_name}, ${inr(r.outstanding_amount)} (${r.series}, ${r.payout_frequency})`,
          detail: [
            Number(r.schedule_rows) === 0 ? 'no schedule at all' : null,
            r.maturity_date == null ? 'no maturity date' : null,
            !['Monthly', 'Quarterly', 'HalfYearly', 'Annual', 'Cumulative', 'LockIn'].includes(String(r.payout_frequency))
              ? `the engine does not know the frequency '${r.payout_frequency}'` : null,
          ].filter(Boolean).join(' · '),
        }))),

    await safe('One account number, two records',
      'The same account recorded twice for one customer — they differ only by IFSC, so the duplicate guard does not catch them.',
      async () => (await db.query<Record<string, unknown>>(
        `SELECT c.customer_code, c.full_name, b.account_number, count(*) AS n
           FROM customer_bank_accounts b JOIN customers c ON c.id = b.customer_id
          GROUP BY c.id, c.customer_code, c.full_name, b.account_number
         HAVING count(*) > 1`)).rows
        .map((r) => ({ label: `${r.customer_code} ${r.full_name} — ${r.account_number} appears ${r.n} times` }))),

    await safe('Verified account renamed',
      'The beneficiary name was edited after the bank had confirmed it, so the verification was dropped and the payout may be refused.',
      async () => (await db.query<Record<string, unknown>>(
        `SELECT count(*) AS n FROM customer_bank_accounts b
          WHERE b.is_active AND b.penny_drop_status = 'Pending' AND b.verified_at IS NOT NULL`)).rows
        .filter((r) => Number(r.n) > 0)
        .map((r) => ({ label: `${r.n} active account(s) lost their verification after a rename` }))),
  ];
}

export async function buildDigest(db: Db): Promise<{ sections: DigestSection[]; total: number }> {
  const sections = [...await moneyBlocked(db), ...await stalled(db), ...await looksWrong(db)]
    .filter((s) => s.items.length > 0);
  return { sections, total: sections.reduce((n, s) => n + s.items.length, 0) };
}

/** The mail body. Plain text: it has to be readable on a phone at 5 PM. */
export function renderDigest(d: { sections: DigestSection[]; total: number }, dateIst: string): string {
  if (!d.sections.length) {
    return [
      `Nothing needs your attention today (${dateIst}).`,
      '',
      'No payout is blocked, no signing has stalled, and nothing in the data contradicts itself.',
      '',
      'This mail is sent every day on purpose. If it stops arriving, the check itself has broken —',
      'that is the one thing silence would otherwise hide.',
    ].join('\n');
  }
  const out: string[] = [
    `${d.total} thing(s) need a decision today (${dateIst}).`,
    '',
  ];
  for (const s of d.sections) {
    out.push(`${s.title.toUpperCase()}  (${s.items.length})`, s.blurb, '');
    for (const i of s.items) out.push(`  · ${i.label}${i.detail ? `\n      ${i.detail}` : ''}`);
    out.push('');
  }
  out.push('—', 'Sent daily at 5 PM IST. Recipients: Settings → Reports → Daily ops digest recipients.');
  return out.join('\n');
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const ist = (d: Date) => new Date(d.getTime() + 5.5 * 3600 * 1000);

async function recipients(db: Db): Promise<string[]> {
  const settings = await getSettingsMap(db);
  const configured = settings['reports.digest_recipients'];
  if (Array.isArray(configured) && configured.length) return configured.map((e) => String(e).trim()).filter(Boolean);
  const { rows } = await db.query<{ email: string }>(
    `SELECT u.email FROM users u JOIN roles r ON r.id = u.role_id
      WHERE u.is_active = TRUE AND u.email IS NOT NULL AND u.email <> '' AND r.name = 'super_admin'`);
  return rows.map((r) => r.email);
}

/** Build and queue it. Idempotent per IST day, like the backup check. */
export async function runOpsDigest(db: Db, reportDate?: string): Promise<{ report_date: string; findings: number; emails_queued: number }> {
  const date = reportDate || ymd(ist(new Date()));
  const settings = await getSettingsMap(db);
  if (settings['reports.digest_enabled'] === false) return { report_date: date, findings: 0, emails_queued: 0 };

  const digest = await buildDigest(db);
  const body = renderDigest(digest, date);
  let queued = 0;
  for (const email of await recipients(db)) {
    const dup = await db.query(
      `SELECT 1 FROM notifications_queue WHERE template = 'ops_digest' AND to_address = $1 AND payload->>'report_date' = $2`,
      [email, date]);
    if (dup.rowCount) continue;
    await enqueue(db, { channel: 'email', template: 'ops_digest', to: email, payload: { report_date: date, findings: digest.total, body } });
    queued++;
  }
  return { report_date: date, findings: digest.total, emails_queued: queued };
}
