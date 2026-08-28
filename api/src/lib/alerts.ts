/**
 * Ops alerts — email the people who need to know when the server breaks
 * (owner 2026-07-29: "any errors or problems should mail eashwar.ram@ and
 * prem.karnan@").
 *
 * THROTTLING IS THE POINT, not a nicety. An alerter with no brake is worse
 * than no alerter: one bad deploy throwing on every request would send
 * thousands of identical mails, the inbox gets muted, and the next REAL alert
 * is invisible. We had a live rehearsal of exactly that on 2026-07-27, when a
 * junk figure in LockerHub's AUM monitor filled the management inbox overnight.
 *
 * So three brakes, all deliberate:
 *   1. Identical errors collapse — same signature within COOLDOWN_MS sends
 *      once, and the repeats are counted and reported in the next mail rather
 *      than sent.
 *   2. A hard ceiling of MAX_PER_HOUR mails an hour across ALL signatures, so
 *      a storm of *different* errors cannot flood either.
 *   3. Sending is fire-and-forget and never throws. An alert that breaks the
 *      request it is reporting on would be a spectacular own goal.
 *
 * Client mistakes (4xx) are NOT alerts — a staff member typing a bad PAN is
 * not an incident. Only 5xx and process-level crashes come through here.
 */
import { config } from '../config.js';
import { emailProvider } from '../integrations/notify/index.js';

const COOLDOWN_MS = 30 * 60 * 1000;   // same error: at most one mail per 30 min
const MAX_PER_HOUR = 12;              // across every signature
const HOUR_MS = 60 * 60 * 1000;

interface Seen { firstAt: number; lastSentAt: number; suppressed: number }
const seen = new Map<string, Seen>();
let windowStartedAt = 0;
let sentThisWindow = 0;

// Super-admin-managed override (Settings → reports.error_alert_recipients),
// held in-process so the crash/5xx path stays synchronous with no DB round-trip.
// Hydrated on boot and refreshed whenever the setting is saved; falls back to
// the OPS_ALERT_EMAILS env when unset/empty so alerts never silently go nowhere.
let opsAlertOverride: string[] | null = null;

/** Set (or clear, with null/empty) the settings-managed ops-alert recipients. */
export function setOpsAlertRecipients(emails: string[] | null | undefined): void {
  const clean = Array.isArray(emails) ? emails.map((e) => String(e).trim()).filter(Boolean) : [];
  opsAlertOverride = clean.length ? clean : null;
}

/** Recipients, or [] when the owner has deliberately silenced alerts. */
export function alertRecipients(): string[] {
  if (opsAlertOverride && opsAlertOverride.length) return opsAlertOverride;
  return String(config.OPS_ALERT_EMAILS ?? '')
    .split(',').map((s) => s.trim()).filter(Boolean);
}

/** Test seam — the throttle is process-global state. */
export function _resetAlertThrottle(): void {
  seen.clear(); windowStartedAt = 0; sentThisWindow = 0; opsAlertOverride = null;
}

/**
 * Collapse an error to a stable key, so "the same thing happening again" is
 * recognisable. Digits are stripped because ids and amounts vary per request
 * while the fault does not — without that, one broken route with a thousand
 * customer ids reads as a thousand distinct problems.
 */
function signatureOf(subject: string, detail: string): string {
  return `${subject}|${detail.split('\n')[0] ?? ''}`.replace(/\d+/g, '#').slice(0, 300);
}

/**
 * Turn a raw error into something the owner can act on without asking an
 * engineer (owner 2026-08-28: "explain it in the mail itself clearly so that i
 * understand it and will not ask u again").
 *
 * Two rules keep this honest:
 *  · Only claim a diagnosis when the signature is genuinely recognised. A
 *    confident-sounding guess about the wrong thing is worse than "unknown",
 *    because it invites the wrong action — so the fallback says plainly that we
 *    do not know, rather than inventing a reassurance.
 *  · Never say "no action needed" for anything that touches money. Interest,
 *    payouts and redemptions always route to a human.
 */
export function explainInPlainWords(detail: string): { what: string; action: string } {
  const d = detail.toLowerCase();

  // Postgres kicked our connections. Overwhelmingly this is the nightly
  // unattended-upgrades restarting the database (2026-08-28 06:21 UTC was
  // exactly this), not a fault in the book.
  if (d.includes('terminating connection due to administrator command')) {
    return {
      what: 'The database was restarted underneath the app, so its open connections were cut. '
        + 'This is almost always the server installing its routine overnight security updates — '
        + 'not a problem with your data, and nothing to do with any customer or investment.',
      action: 'Normally nothing. The app reconnects on its own, and no saved data is affected. '
        + 'Only worth chasing if the site was actually unreachable for more than a minute or so, '
        + 'or if you get this many times in one day.',
    };
  }
  // Database unreachable — different, and more serious.
  if (d.includes('econnrefused') || d.includes('connection terminated unexpectedly')
      || d.includes('could not connect') || d.includes('etimedout')) {
    return {
      what: 'The app could not reach the database at all. Until it reconnects, pages that need '
        + 'data will fail to load.',
      action: 'Check whether the site is loading. If it is not, this needs someone to look at the '
        + 'server now — it will not fix itself if the database is down.',
    };
  }
  if (d.includes('too many clients') || d.includes('remaining connection slots')) {
    return {
      what: 'The app ran out of database connections — too many things were happening at once, '
        + 'or connections were not being released.',
      action: 'If the site is slow or erroring, it needs an engineer. If everything looks normal, '
        + 'it was a brief spike, but tell your engineer it happened.',
    };
  }
  if (d.includes('enospc') || d.includes('no space left')) {
    return {
      what: 'The server has run out of disk space. Saving files, backups and possibly the database '
        + 'itself will start failing.',
      action: 'This needs an engineer today. It does not recover on its own and it gets worse.',
    };
  }
  if (d.includes('heap out of memory') || d.includes('javascript heap')) {
    return {
      what: 'The app ran out of memory and stopped. It restarts automatically, but whatever it was '
        + 'doing at that moment did not finish.',
      action: 'If it happened while a payout or report was running, check that job actually '
        + 'completed. If it repeats, it needs an engineer.',
    };
  }

  // Not recognised. Say so — do not invent a reassurance.
  return {
    what: 'An unexpected error stopped something the app was doing. This one is not a pattern the '
      + 'system recognises, so there is no plain-English explanation for it yet.',
    action: 'Send this email to your engineer. Include what you were doing at the time, if you know '
      + '— that is usually the fastest way to find the cause.',
  };
}

/**
 * Email ops about a server-side failure. Never throws, never blocks the caller:
 * returns a promise you are free to ignore.
 */
export async function alertOps(subject: string, detail: string): Promise<void> {
  try {
    const to = alertRecipients();
    if (!to.length) return;

    const now = Date.now();
    if (now - windowStartedAt > HOUR_MS) { windowStartedAt = now; sentThisWindow = 0; }

    const sig = signatureOf(subject, detail);
    const prior = seen.get(sig);
    if (prior && now - prior.lastSentAt < COOLDOWN_MS) {
      prior.suppressed++;                       // counted, reported next time
      return;
    }
    if (sentThisWindow >= MAX_PER_HOUR) {
      // Ceiling hit. Record it so the count is not lost, but send nothing —
      // the alert that would tell you the ceiling was hit is itself an alert.
      if (prior) prior.suppressed++;
      else seen.set(sig, { firstAt: now, lastSentAt: 0, suppressed: 1 });
      return;
    }

    const repeats = prior?.suppressed ?? 0;
    seen.set(sig, { firstAt: prior?.firstAt ?? now, lastSentAt: now, suppressed: 0 });
    sentThisWindow++;

    const plain = explainInPlainWords(detail);
    const lines = [
      'WHAT HAPPENED',
      plain.what,
      '',
      'DOES IT NEED YOU?',
      plain.action,
      '',
      `Time (IST):  ${new Date(now).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`,
      `Environment: ${config.NODE_ENV}`,
    ];
    if (repeats > 0) {
      lines.push(`Repeats:     this error also occurred ${repeats} more time(s) in the last 30 minutes (not mailed separately).`);
    }
    if (sentThisWindow >= MAX_PER_HOUR) {
      lines.push(`NOTE:        the ${MAX_PER_HOUR}-alerts-per-hour ceiling has been reached. Further errors this hour are being counted, not mailed. Check the server logs.`);
    }
    // The raw error goes LAST. The owner reads the top of the mail and decides
    // whether to act; the stack is for whoever debugs it afterwards (owner
    // 2026-08-28: "explain it in the mail itself clearly so that i understand it
    // and will not ask u again").
    lines.push('', '─────────────────────────────────', 'TECHNICAL DETAIL (for whoever fixes it)', '', detail);
    lines.push('', 'You are receiving this because you are on the error-alert recipients (Settings → Reports) or OPS_ALERT_EMAILS.');

    const provider = emailProvider();
    const body = lines.join('\n');
    // Sequential on purpose: SES per-second limits, and two recipients is not
    // worth a batch. One failing address must not stop the other.
    for (const addr of to) {
      const r = await provider.send(addr, `[NCD] ${subject}`, body);
      if (!r.ok) console.error('[alert] could not mail', addr, r.error);
    }
  } catch (e) {
    // An alerter that throws would take down the very handler reporting the
    // fault. Log and swallow.
    console.error('[alert] failed:', (e as Error).message);
  }
}

/**
 * Process-level crashes. These are the ones nobody sees until a customer
 * complains, so they matter more than any single failed request.
 *
 * This handler only MAILS — it does not exit. Note that index.ts installs its
 * own uncaughtException handler which DOES `process.exit(1)` (systemd then
 * restarts the service), so in production the process does go down; this file's
 * job is purely to get the mail out first. Said plainly here because the comment
 * used to claim the process stays up, which misread the 2026-08-28 crash.
 */
export function installCrashAlerts(): void {
  process.on('unhandledRejection', (reason) => {
    const e = reason instanceof Error ? reason : new Error(String(reason));
    console.error('[crash] unhandled rejection:', e);
    void alertOps('Unhandled promise rejection', `${e.message}\n\n${e.stack ?? ''}`);
  });
  process.on('uncaughtException', (e) => {
    console.error('[crash] uncaught exception:', e);
    void alertOps('Uncaught exception', `${e.message}\n\n${e.stack ?? ''}`);
  });
}
