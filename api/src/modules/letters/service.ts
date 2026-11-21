/**
 * Which redemption letter a date produces, and what it says.
 *
 * Owner 2026-11-21: "make these all UI config — this 3 different letter and
 * its dates when from and to all completely make it UI config". Asked which
 * three they meant and how much should be editable, they chose ALL FOUR
 * ranges and everything, body text included.
 *
 * ── Why this replaced three separate mechanisms ──────────────────────────────
 * A letter's identity used to be decided in three places that had to agree:
 *   · `redemption.letter_dhanam_from`  — a setting (Kiara → Dhanam)
 *   · COMPANY_RENAMED_ON               — a CONSTANT (Private → Limited), and
 *                                        shared with bond certificates, so it
 *                                        was never really a letter setting
 *   · `redemption.consent_letter_from` — another setting (request → consent)
 * Two of the three were a release away from being changed, and nothing made
 * the four ranges line up: the bulk tool asked "which era?" and "which
 * document?" as separate questions that could in principle disagree.
 *
 * Here they are one question. A date resolves to ONE template, which carries
 * both the kind of document and the block it prints. The four ranges tile the
 * timeline end to end with no gap and no overlap.
 *
 * ── The table holds OVERRIDES, not the letters ───────────────────────────────
 * BUILT_IN below stays the base and is what ships. A row in `letter_templates`
 * changes one of them, matched on slug. So:
 *   · an empty table is today's behaviour exactly;
 *   · the fallback runs on every request instead of being dead code;
 *   · a row deleted, disabled, or saved with a range that matches nothing
 *     prints the built-in letter rather than a blank one.
 * A letter must never fail to render because somebody mis-typed a date.
 */
import type { Db } from '../../db/types.js';
import { errors } from '../../lib/errors.js';
import { writeAudit } from '../../lib/audit.js';
import type { AuthUser } from '../../lib/authUser.js';
import { COMPANY_RENAMED_ON } from '../reports/forms/shared.js';
import { DEFAULT_DHANAM_FROM } from '../reports/forms/redemption-letter-addressee.js';
import { DEFAULT_CONSENT_FROM } from '../redemptions/letter.js';

export type LetterKind = 'request' | 'consent';

export interface LetterTemplate {
  slug: string;
  kind: LetterKind;
  label: string;
  /** Inclusive ISO date, or null for "from the beginning". */
  valid_from: string | null;
  /** Inclusive ISO date, or null for "open-ended". */
  valid_to: string | null;
  legal_name: string;
  formerly: string;
  off_address: string[];
  corp_office: string[];
  /** Wording overrides by slot; {} means the built-in text. */
  body: Record<string, string>;
  sort_order: number;
  enabled: boolean;
  /** False until somebody saves it — the UI says "built-in" vs "edited". */
  customised: boolean;
  updated_at: string | null;
  updated_by: string | null;
}

const OFF_ADDRESS = [
  'No. 22/3 2nd Street,',
  'Nehru Nagar, Behind CMS School,',
  'Ganapathy, Coimbatore TN 641006.',
];
const CORP_OFFICE = [
  '2/191 B. Mylampatty Road, Karayampalayam.',
  'Mylampatty Post, Chinniyampalayam,',
  'Coimbatore South, Tamil Nadu, India - 641062',
];

/** The day before an ISO date — a range's `to` is the day before the next `from`. */
function dayBefore(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * The four letters as the code has always produced them.
 *
 * The boundaries are the three that were previously scattered, written here as
 * from/to pairs so the sequence is visible at a glance instead of being three
 * independent comparisons. `to` is derived from the next `from`, so the ranges
 * cannot drift apart as anyone edits this list.
 */
export function builtIn(): LetterTemplate[] {
  const base = {
    body: {} as Record<string, string>,
    enabled: true,
    customised: false,
    updated_at: null,
    updated_by: null,
  };
  return [
    {
      ...base, slug: 'kiara', kind: 'request', label: 'Request letter — Kiara Microcredit',
      valid_from: null, valid_to: dayBefore(DEFAULT_DHANAM_FROM),
      legal_name: 'Kiara Microcredit Private Limited', formerly: '',
      off_address: [...OFF_ADDRESS], corp_office: [], sort_order: 10,
    },
    {
      ...base, slug: 'dhanam-private', kind: 'request', label: 'Request letter — Dhanam Private Limited',
      valid_from: DEFAULT_DHANAM_FROM, valid_to: dayBefore(COMPANY_RENAMED_ON),
      legal_name: 'Dhanam Investment and Finance Private Limited',
      formerly: 'Formerly Kiara Microcredit Pvt Ltd',
      off_address: [...OFF_ADDRESS], corp_office: [...CORP_OFFICE], sort_order: 20,
    },
    {
      ...base, slug: 'dhanam-limited', kind: 'request', label: 'Request letter — Dhanam Limited',
      valid_from: COMPANY_RENAMED_ON, valid_to: dayBefore(DEFAULT_CONSENT_FROM),
      legal_name: 'Dhanam Investment and Finance Limited',
      formerly: 'Formerly Kiara Microcredit Pvt Ltd',
      off_address: [...OFF_ADDRESS], corp_office: [...CORP_OFFICE], sort_order: 30,
    },
    {
      // NO ADDRESSEE BLOCK, but it does carry a company name. The consent
      // letter is written BY the holder ("I, <name>, am the registered
      // holder…"), so there is no letterhead to address — yet its opening
      // sentence names the issuer, and that name is the one thing about the
      // company it states. Keeping it here means the preview can still say
      // which company a consent row names, as it always has, and Part 2 can
      // feed it straight into that sentence.
      ...base, slug: 'consent', kind: 'consent', label: 'Consent for Premature Redemption',
      valid_from: DEFAULT_CONSENT_FROM, valid_to: null,
      legal_name: 'Dhanam Investment and Finance Limited',
      formerly: 'Formerly Kiara Microcredit Pvt Ltd',
      // The Board block, added 2026-11-21 when the owner's revised format
      // showed one. Same addresses as the request letters, and editable on
      // the same screen.
      off_address: [...OFF_ADDRESS], corp_office: [...CORP_OFFICE], sort_order: 40,
    },
  ];
}

const str = (v: unknown, fallback = ''): string => (v == null ? fallback : String(v));
const isoOrNull = (v: unknown): string | null => {
  const s = v == null ? '' : String(v).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
};
const lines = (v: unknown, fallback: string[]): string[] =>
  Array.isArray(v) ? v.map((x) => String(x)) : fallback;

/**
 * Every letter, built-ins merged with what has been saved over them.
 *
 * A stored row for a known slug overrides field by field, so a row that sets
 * only a date keeps the built-in name and address. A stored row for an unknown
 * slug is a range the owner added and stands on its own.
 */
export async function listTemplates(db: Db): Promise<LetterTemplate[]> {
  const { rows } = await db.query<Record<string, unknown>>(
    `SELECT t.*, u.full_name AS updated_by_name
       FROM letter_templates t
       LEFT JOIN users u ON u.id = t.updated_by_user_id
      ORDER BY t.sort_order, t.id`);
  const stored = new Map(rows.map((r) => [String(r.slug), r]));
  const out: LetterTemplate[] = [];

  for (const b of builtIn()) {
    const r = stored.get(b.slug);
    if (!r) { out.push(b); continue; }
    stored.delete(b.slug);
    out.push(merge(b, r));
  }
  // Ranges the owner added themselves.
  for (const r of stored.values()) {
    const kind: LetterKind = String(r.kind) === 'consent' ? 'consent' : 'request';
    out.push(merge({
      slug: String(r.slug), kind, label: String(r.slug),
      valid_from: null, valid_to: null, legal_name: '', formerly: '',
      off_address: [], corp_office: [], body: {}, sort_order: 100,
      enabled: true, customised: true, updated_at: null, updated_by: null,
    }, r));
  }
  return out.sort((a, b) => a.sort_order - b.sort_order);
}

function merge(b: LetterTemplate, r: Record<string, unknown>): LetterTemplate {
  return {
    slug: b.slug,
    kind: String(r.kind) === 'consent' || String(r.kind) === 'request'
      ? (String(r.kind) as LetterKind) : b.kind,
    label: str(r.label, b.label) || b.label,
    valid_from: r.valid_from == null ? null : isoOrNull(r.valid_from),
    valid_to: r.valid_to == null ? null : isoOrNull(r.valid_to),
    legal_name: r.legal_name == null ? b.legal_name : str(r.legal_name),
    formerly: r.formerly == null ? b.formerly : str(r.formerly),
    off_address: r.off_address == null ? b.off_address : lines(r.off_address, b.off_address),
    corp_office: r.corp_office == null ? b.corp_office : lines(r.corp_office, b.corp_office),
    body: (r.body && typeof r.body === 'object' ? r.body : b.body) as Record<string, string>,
    sort_order: Number(r.sort_order ?? b.sort_order),
    enabled: r.enabled == null ? true : Boolean(r.enabled),
    customised: true,
    updated_at: r.updated_at ? String(r.updated_at) : null,
    updated_by: r.updated_by_name ? String(r.updated_by_name) : null,
  };
}

/**
 * The template a letter dated `date` should use.
 *
 * Returns null when nothing matches, and every caller treats that as "use the
 * built-in behaviour" rather than as an error — a misconfigured range must
 * degrade to the letter we print today, never to a blank page.
 *
 * Where ranges overlap the LAST matching one wins, which is the same rule the
 * old era list used, so an owner who sets overlapping dates gets the newer
 * letter rather than an error in the middle of a batch.
 */
export function pickFor(templates: LetterTemplate[], date: string): LetterTemplate | null {
  const d = String(date ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  let chosen: LetterTemplate | null = null;
  for (const t of templates) {
    if (!t.enabled) continue;
    if (t.valid_from && d < t.valid_from) continue;
    if (t.valid_to && d > t.valid_to) continue;
    chosen = t;
  }
  return chosen;
}

export async function templateFor(db: Db, date: string): Promise<LetterTemplate | null> {
  return pickFor(await listTemplates(db), date);
}

export interface TemplatePatch {
  kind?: LetterKind;
  label?: string;
  valid_from?: string | null;
  valid_to?: string | null;
  legal_name?: string;
  formerly?: string;
  off_address?: string[];
  corp_office?: string[];
  body?: Record<string, string>;
  sort_order?: number;
  enabled?: boolean;
}

/** Save one template. Creates the override row on first edit. */
export async function saveTemplate(
  db: Db, actor: AuthUser, slug: string, patch: TemplatePatch,
): Promise<LetterTemplate> {
  const clean = String(slug ?? '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,48}$/.test(clean)) {
    throw errors.badRequest('A letter id is lower-case letters, numbers and hyphens.');
  }
  if (patch.valid_from && patch.valid_to && patch.valid_from > patch.valid_to) {
    throw errors.badRequest('The "from" date is after the "to" date.');
  }

  const before = (await listTemplates(db)).find((t) => t.slug === clean) ?? null;
  const base = before ?? builtIn().find((b) => b.slug === clean) ?? null;

  const row = await db.withTx(async (tx) => {
    const { rows } = await tx.query<Record<string, unknown>>(
      `INSERT INTO letter_templates
         (slug, kind, label, valid_from, valid_to, legal_name, formerly,
          off_address, corp_office, body, sort_order, enabled, updated_by_user_id, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11,$12,$13, now())
       ON CONFLICT (slug) DO UPDATE SET
         kind = EXCLUDED.kind, label = EXCLUDED.label,
         valid_from = EXCLUDED.valid_from, valid_to = EXCLUDED.valid_to,
         legal_name = EXCLUDED.legal_name, formerly = EXCLUDED.formerly,
         off_address = EXCLUDED.off_address, corp_office = EXCLUDED.corp_office,
         body = EXCLUDED.body, sort_order = EXCLUDED.sort_order,
         enabled = EXCLUDED.enabled,
         updated_by_user_id = EXCLUDED.updated_by_user_id, updated_at = now()
       RETURNING *`,
      [
        clean,
        patch.kind ?? base?.kind ?? 'request',
        patch.label ?? base?.label ?? clean,
        patch.valid_from === undefined ? (base?.valid_from ?? null) : patch.valid_from,
        patch.valid_to === undefined ? (base?.valid_to ?? null) : patch.valid_to,
        patch.legal_name ?? base?.legal_name ?? '',
        patch.formerly ?? base?.formerly ?? '',
        JSON.stringify(patch.off_address ?? base?.off_address ?? []),
        JSON.stringify(patch.corp_office ?? base?.corp_office ?? []),
        JSON.stringify(patch.body ?? base?.body ?? {}),
        patch.sort_order ?? base?.sort_order ?? 100,
        patch.enabled ?? base?.enabled ?? true,
        actor.id,
      ]);
    await writeAudit(tx, {
      actorId: actor.id, action: 'letter-template.save', entityType: 'letter_templates',
      entityId: Number(rows[0]!.id), before: before ?? undefined, after: patch,
    });
    return rows[0]!;
  });
  return merge(base ?? builtIn()[0]!, row);
}

/**
 * Drop an override and go back to the built-in letter.
 *
 * For an owner-added range this removes it outright; for one of the four it is
 * an undo, which is the only safe way back once somebody has edited legal
 * wording and wants out.
 */
export async function resetTemplate(db: Db, actor: AuthUser, slug: string): Promise<void> {
  const clean = String(slug ?? '').trim().toLowerCase();
  await db.withTx(async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      'DELETE FROM letter_templates WHERE slug = $1 RETURNING id', [clean]);
    if (!rows[0]) throw errors.notFound('That letter has not been customised.');
    await writeAudit(tx, {
      actorId: actor.id, action: 'letter-template.reset', entityType: 'letter_templates',
      entityId: Number(rows[0].id), before: { slug: clean }, after: undefined,
    });
  });
}

/**
 * Problems worth showing the owner, without refusing the save.
 *
 * Dates are the owner's business and a gap may be deliberate — but a gap means
 * some letter date produces nothing configured, and an overlap means two rows
 * claim the same day. Both are worth seeing on the screen rather than
 * discovering in a batch of signed documents.
 */
export function rangeWarnings(templates: LetterTemplate[]): string[] {
  const live = templates.filter((t) => t.enabled)
    .slice()
    .sort((a, b) => String(a.valid_from ?? '0000-01-01').localeCompare(String(b.valid_from ?? '0000-01-01')));
  const out: string[] = [];
  for (let i = 0; i < live.length - 1; i++) {
    const a = live[i]!, b = live[i + 1]!;
    if (!a.valid_to) {
      out.push(`"${a.label}" is open-ended, so "${b.label}" after it can never apply.`);
      continue;
    }
    if (b.valid_from && a.valid_to >= b.valid_from) {
      out.push(`"${a.label}" and "${b.label}" both cover ${b.valid_from}; the later one wins.`);
    } else if (b.valid_from && dayBefore(b.valid_from) > a.valid_to) {
      out.push(`No letter is configured between ${a.valid_to} and ${b.valid_from}; those dates fall back to the built-in letter.`);
    }
  }
  return out;
}

/**
 * The date from which a redemption needs the consent letter.
 *
 * The signing gate asks this, and it is deliberately NOT "is this date inside
 * a consent range?" — a redemption gate is money-adjacent, so it keeps the
 * single-boundary shape it has always had: the earliest enabled consent
 * range's start. Reconfiguring the letters moves that boundary; it cannot
 * accidentally un-gate a redemption in the middle of the timeline.
 */
export async function consentFromDate(db: Db): Promise<string> {
  const consent = (await listTemplates(db))
    .filter((t) => t.enabled && t.kind === 'consent' && t.valid_from)
    .map((t) => t.valid_from!)
    .sort();
  return consent[0] ?? DEFAULT_CONSENT_FROM;
}

/**
 * The addressee block for a request letter dated `date`.
 *
 * Falls back to the built-in era list when nothing is configured for that
 * date, or when the matching range is a consent one (which has no block).
 */
export async function addresseeBlockFor(db: Db, date: string): Promise<{
  legal_name: string; formerly?: string;
  off_address_line1: string; off_address_rest: string[]; corp_office: string[];
} | null> {
  const t = pickFor(await listTemplates(db), date);
  if (!t || t.kind !== 'request' || !t.legal_name) return null;
  return blockOf(t);
}

/** A template's Board block, whichever kind of letter it is. */
export function blockOf(t: LetterTemplate): {
  legal_name: string; formerly?: string;
  off_address_line1: string; off_address_rest: string[]; corp_office: string[];
} {
  const [first, ...rest] = t.off_address;
  return {
    legal_name: t.legal_name,
    ...(t.formerly ? { formerly: t.formerly } : {}),
    off_address_line1: first ?? '',
    off_address_rest: rest,
    corp_office: t.corp_office,
  };
}

/**
 * The Board block for a CONSENT letter dated `date`.
 *
 * Falls back to the built-in consent template when nothing is configured, so
 * the block appears even on a date no range covers.
 */
export async function consentAddresseeFor(db: Db, date: string) {
  const all = await listTemplates(db);
  const hit = pickFor(all, date);
  const t = hit && hit.kind === 'consent' ? hit
    : (all.find((x) => x.slug === 'consent' && x.enabled)
       ?? builtIn().find((x) => x.slug === 'consent')!);
  return t.legal_name ? blockOf(t) : null;
}
