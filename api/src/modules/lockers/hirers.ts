/**
 * Joint hirers on a locker — holders 2 and 3 (owner 2026-09-09: "yes build it").
 *
 * The approved agreement's Schedule has three hirer blocks and three signature
 * columns. Until now NCD recorded one holder, so a jointly-held locker existed
 * on paper and nowhere else: the extra holders were written in by hand at the
 * branch and appeared on no screen, report or roster we have.
 *
 * ─── Three rules that are NOT ours, and must not be relaxed here ────────────
 *
 * 1. EVERY HIRER IS FULLY KYC'd, or the agreement does not generate.
 *    A joint hirer holds the locker on the same terms and with the same access
 *    as the first, so they carry the same KYC obligation. LockerHub gates A19
 *    and A27 on it and returns `hirer_incomplete` naming the position and the
 *    fields. We check the same set BEFORE sending, so a branch is told at the
 *    counter rather than at signing time.
 *
 * 2. EVERY HIRER NEEDS A DISTINCT PHONE.
 *    Digio keys signature PLACEMENT by signer identifier. Two hirers sharing a
 *    number collide and one signature lands in the wrong column of a signed
 *    contract. This is the rule most likely to look like fussiness and is the
 *    one with the worst failure.
 *
 * 3. AADHAAR IS LAST FOUR, NEVER TWELVE.
 *    Refused outright rather than silently truncated: a caller who sends a full
 *    number has made a mistake we should surface, and quietly storing its tail
 *    would hide that the number was transmitted at all (Aadhaar Act 2016 s.29).
 */
import type { Db } from '../../db/types.js';
import type { AuthUser } from '../../lib/authUser.js';
import { errors } from '../../lib/errors.js';
import { writeAudit } from '../../lib/audit.js';

/** Positions on the agreement. 1 is the applicant and is never stored here. */
export const HIRER_POSITIONS = [2, 3] as const;

export interface HirerInput {
  position: number;
  full_name: string;
  phone?: string | null;
  email?: string | null;
  dob?: string | null;
  pan?: string | null;
  /** Full 12 digits, as captured. Mirrors customers.aadhaar (026): held so the
   *  agreement this hirer now eSigns can carry it. NEVER pushed onward —
   *  hirersForLockerHub sends last-4 alone. */
  aadhaar?: string | null;
  /** Derived from `aadhaar` when that is given; otherwise taken as supplied. */
  aadhaar_last4?: string | null;
  address?: string | null;
}

export interface HirerRow extends HirerInput {
  position: number;
  full_name: string;
  created_at: string;
}

/** What LockerHub requires of every hirer before an agreement will generate. */
const REQUIRED: Array<{ key: keyof HirerInput; label: string }> = [
  { key: 'full_name', label: 'name' },
  { key: 'phone', label: 'phone' },
  { key: 'address', label: 'address' },
  { key: 'pan', label: 'pan' },
  { key: 'aadhaar_last4', label: 'aadhaar_last4' },
  { key: 'dob', label: 'dob' },
];

const clean = (v: unknown): string => String(v ?? '').trim();
const digits = (v: unknown): string => clean(v).replace(/\D/g, '');

/**
 * Which required fields a hirer is missing. Same shape as LockerHub's
 * `hirer_incomplete`, deliberately — one vocabulary for the same condition,
 * whether it is caught here or there.
 */
export function missingFor(h: HirerInput): string[] {
  return REQUIRED.filter(({ key }) => clean(h[key]) === '').map(({ label }) => label);
}

/**
 * Split a captured Aadhaar into what we store: the full twelve and the last
 * four. Mirrors the customer path (customers/service.ts) so one person's number
 * is not handled two different ways depending on which form took it.
 *
 * Anything that is not exactly twelve digits yields NO full number — a partial
 * Aadhaar reads as captured while being unusable, and a last-4 derived from it
 * would be wrong. The operator's own last-4 entry is used in that case.
 */
export function splitAadhaar(h: HirerInput): { full: string | null; last4: string | null } {
  const d = digits(h.aadhaar);
  if (d.length === 12) return { full: d, last4: d.slice(-4) };
  const four = digits(h.aadhaar_last4).slice(-4);
  return { full: null, last4: four.length === 4 ? four : null };
}

/**
 * Validate the SET, not just each row. The cross-row rules (distinct phones,
 * no clash with the applicant) are the ones that put a signature in the wrong
 * column, and they cannot be seen from a single hirer.
 */
export function validateHirers(hirers: HirerInput[], applicantPhone?: string | null): void {
  if (hirers.length > HIRER_POSITIONS.length) {
    throw errors.badRequest(
      `A locker agreement has ${HIRER_POSITIONS.length + 1} hirer blocks — one applicant and ${HIRER_POSITIONS.length} joint hirers. `
      + 'A fourth could be captured but never printed or signed.');
  }
  const seenPositions = new Set<number>();
  const phones = new Map<string, string>();
  const appPhone = digits(applicantPhone).slice(-10);
  if (appPhone) phones.set(appPhone, 'the applicant');

  for (const h of hirers) {
    if (!HIRER_POSITIONS.includes(h.position as 2 | 3)) {
      throw errors.badRequest(`Hirer position must be ${HIRER_POSITIONS.join(' or ')} — position 1 is the applicant.`);
    }
    if (seenPositions.has(h.position)) throw errors.badRequest(`Two hirers were given position ${h.position}.`);
    seenPositions.add(h.position);

    if (!clean(h.full_name)) throw errors.badRequest(`Hirer ${h.position} needs a name.`);

    // Aadhaar: refuse a full number rather than truncating it (see header).
    const aad = digits(h.aadhaar_last4);
    if (aad && aad.length !== 4) {
      throw errors.badRequest(
        `Hirer ${h.position}: send the LAST FOUR digits of the Aadhaar, not the full number.`);
    }

    const ph = digits(h.phone).slice(-10);
    if (ph) {
      const clash = phones.get(ph);
      if (clash) {
        throw errors.badRequest(
          `Hirer ${h.position} has the same phone as ${clash}. Each hirer signs their own column of the `
          + 'agreement and is identified by their phone, so two holders sharing one number would put a '
          + 'signature in the wrong column.');
      }
      phones.set(ph, `hirer ${h.position}`);
    }
  }
}

export async function listHirers(db: Db, applicationId: string): Promise<HirerRow[]> {
  const { rows } = await db.query<HirerRow>(
    `SELECT position, full_name, phone, email, dob::text AS dob, pan, aadhaar_last4, address, created_at
       FROM locker_application_hirers
      WHERE lockerhub_application_id = $1
      ORDER BY position`, [applicationId]);
  return rows;
}

/**
 * Replace the joint hirers on an application. A PUT rather than a POST: the
 * agreement shows a fixed set of blocks, so "these are the hirers" is the only
 * coherent statement — an add-only API would leave no way to remove a hirer
 * entered by mistake, and a removed hirer must stop being sent.
 */
export async function setHirers(
  db: Db, actor: AuthUser, applicationId: string, hirers: HirerInput[], applicantPhone?: string | null,
): Promise<HirerRow[]> {
  const appId = clean(applicationId);
  if (!appId) throw errors.badRequest('application id required');
  validateHirers(hirers, applicantPhone);

  return db.withTx(async (tx) => {
    // Carry a full Aadhaar we already hold across the delete-and-reinsert.
    //
    // listHirers deliberately does NOT return it — the same structural
    // protection applicant.ts gives customers.aadhaar — so the screen re-sends
    // the hirer WITHOUT it. Without this, editing a hirer's phone would erase
    // their Aadhaar, silently, and nothing on the page would show it had gone.
    // An incoming twelve digits still wins; this only fills the gap.
    const kept = new Map<number, string | null>(
      (await tx.query<{ position: number; aadhaar: string | null }>(
        'SELECT position, aadhaar FROM locker_application_hirers WHERE lockerhub_application_id = $1',
        [appId])).rows.map((r) => [Number(r.position), r.aadhaar]));
    await tx.query('DELETE FROM locker_application_hirers WHERE lockerhub_application_id = $1', [appId]);
    for (const h of hirers) {
      const split = splitAadhaar(h);
      const full = split.full ?? kept.get(Number(h.position)) ?? null;
      // Keep last-4 answering to whichever full number we end up storing.
      const last4 = split.full ? split.last4 : (full ? full.slice(-4) : split.last4);
      await tx.query(
        `INSERT INTO locker_application_hirers
           (lockerhub_application_id, position, full_name, phone, email, dob, pan, aadhaar, aadhaar_last4, address, created_by_user_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [appId, h.position, clean(h.full_name), clean(h.phone) || null, clean(h.email) || null,
         clean(h.dob) || null, clean(h.pan).toUpperCase() || null,
         // Both, from one source, so they can never disagree.
         full, last4,
         clean(h.address) || null, actor.id]);
    }
    await writeAudit(tx, {
      actorId: actor.id, action: 'locker.hirers.set',
      entityType: 'locker_application_hirers', entityId: null,
      // NAMES and positions only. No PAN, no Aadhaar tail, no phone — the audit
      // says who was recorded, not what their identity documents are.
      after: {
        application: appId,
        hirers: hirers.map((h) => ({ position: h.position, name: clean(h.full_name), missing: missingFor(h) })),
      },
    });
    return listHirers(tx, appId);
  });
}

/**
 * The `hirers[]` array for the A7 applicant block, in LockerHub's shape.
 *
 * Returns undefined when there are none, so the key is OMITTED rather than sent
 * empty — an empty array reads as "we checked and there are no joint hirers",
 * which is a different statement from "this is a single-holder locker".
 */
export async function hirersForLockerHub(db: Db, applicationId: string): Promise<Array<Record<string, unknown>> | undefined> {
  const rows = await listHirers(db, applicationId);
  if (!rows.length) return undefined;
  return rows.map((h) => ({
    name: h.full_name,
    phone: clean(h.phone),
    email: clean(h.email),
    dob: clean(h.dob),
    pan: clean(h.pan),
    aadhaar_last4: clean(h.aadhaar_last4),
    // One free-text line into road_name, exactly as the applicant's own address
    // and the nominee's are. Consistency matters more than filling boxes.
    address: {
      flat_building: '', road_name: clean(h.address), landmark: '',
      city: '', state: '', pincode: '',
    },
  }));
}

/**
 * Who is not ready to sign. Returned to the screen so a branch is sent to the
 * exact gap — "hirer 2 is missing PAN and date of birth" — rather than to a
 * generic refusal at signing time, which is what LockerHub's own advice asked
 * us to wire in.
 */
export async function incompleteHirers(
  db: Db, applicationId: string,
): Promise<Array<{ position: number; name: string; missing: string[] }>> {
  const rows = await listHirers(db, applicationId);
  return rows
    .map((h) => ({ position: h.position, name: h.full_name, missing: missingFor(h) }))
    .filter((h) => h.missing.length > 0);
}
