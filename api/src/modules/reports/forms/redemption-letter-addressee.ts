/**
 * Who the redemption request letter is addressed to, decided by the letter's
 * own date.
 *
 * The owner supplied two Word templates whose ONLY difference is this block
 * (Format Kiara.docx, Format.docx — 2026-11-18) and set the boundary between
 * them: Kiara up to and including 17 August 2025, Dhanam from 18 August 2025.
 * That boundary is a SETTING, not a constant here, because the owner asked to
 * be able to move it without a code change.
 *
 * ── The third era, which the templates do not cover ───────────────────────────
 * The Dhanam template reads "Dhanam Investment and Finance PRIVATE Limited",
 * but the company dropped "Private" on 29 September 2026 (COMPANY_RENAMED_ON in
 * shared.ts — the same fact that decides which name a bond certificate carries).
 * A letter dated after that addressed to "Private Limited" would name a company
 * that no longer exists under that name, so there are three eras here, not two.
 *
 * This is an ASSUMPTION flagged to the owner and not yet confirmed. Collapsing
 * back to the templates' two eras means deleting the third ERAS entry — the
 * lookup needs no other change.
 *
 * ── Address text is reproduced verbatim ──────────────────────────────────────
 * The strings below are exactly as the owner's templates read, including two
 * things that look like slips and are deliberately NOT corrected here, because
 * the brief was to preserve the templates and the owner has not ruled on them:
 *   - the Kiara letter says "No. 22/2 2nd Street" where the Dhanam letter (and
 *     COMPANY.registered_office_address) say "22/3";
 *   - the Dhanam corp-office block reads "Chinntyampalayam" where the company
 *     constant has "Chinniyampalayam", and repeats Coimbatore and the pincode.
 * Both are one-line edits in this file if the owner wants them fixed.
 */
import { COMPANY_RENAMED_ON } from './shared.js';

export interface AddresseeEra {
  /** First date (inclusive, ISO) this block applies to; null = from the start. */
  from: string | null;
  legal_name: string;
  /** The "(Formerly …)" line, when the template carries one. */
  formerly?: string;
  /** Street that follows the bold "Off Address -" label. */
  off_address_line1: string;
  off_address_rest: string[];
  /** Lines after the bold "Corp Office:" label; empty when the template has none. */
  corp_office: string[];
}

/** The owner's stated boundary — Dhanam from 18 August 2025. */
export const DEFAULT_DHANAM_FROM = '2025-08-18';

const KIARA: AddresseeEra = {
  from: null,
  legal_name: 'Kiara Microcredit Private Limited',
  off_address_line1: 'No. 22/2 2nd Street,',
  off_address_rest: ['Nehru Nagar, Behind CMS School,', 'Ganapathy, Coimbatore TN 641006.'],
  corp_office: [],
};

/** Shared by both Dhanam eras: only the legal name differs between them. */
const DHANAM_ADDRESS = {
  formerly: 'Formerly Kiara Microcredit Pvt Ltd',
  off_address_line1: 'No. 22/3 2nd Street,',
  off_address_rest: ['Nehru Nagar, Behind CMS School,', 'Ganapathy, Coimbatore TN 641006.'],
  corp_office: [
    '2/191 B. Mylampatty Road, Karayampalayam.',
    'Mylampatty Post, Chinntyampalayam,Coimbatore - 641062,',
    'Coimbatore South, Tamil Nadu,India, 641062',
  ],
} as const;

/**
 * Every era, oldest first. `dhanamFrom` is the configured boundary; the second
 * boundary is the rename, which is a fact rather than a preference.
 */
export function eras(dhanamFrom: string = DEFAULT_DHANAM_FROM): AddresseeEra[] {
  return [
    KIARA,
    {
      from: dhanamFrom,
      legal_name: 'Dhanam Investment and Finance Private Limited',
      ...DHANAM_ADDRESS,
      off_address_rest: [...DHANAM_ADDRESS.off_address_rest],
      corp_office: [...DHANAM_ADDRESS.corp_office],
    },
    {
      from: COMPANY_RENAMED_ON,
      legal_name: 'Dhanam Investment and Finance Limited',
      ...DHANAM_ADDRESS,
      off_address_rest: [...DHANAM_ADDRESS.off_address_rest],
      corp_office: [...DHANAM_ADDRESS.corp_office],
    },
  ];
}

/**
 * The block for a letter dated `letterDate` (ISO).
 *
 * Picks the LAST era whose start is on or before the letter's date, so a date
 * before the first boundary falls to Kiara and a date after the last falls to
 * the newest name. A boundary date itself belongs to the era it opens: the
 * owner's "Kiara 17 Aug, Dhanam from 18 Aug" means 18 August is Dhanam.
 */
export function addresseeFor(letterDate: string, dhanamFrom: string = DEFAULT_DHANAM_FROM): AddresseeEra {
  const d = String(letterDate).slice(0, 10);
  let chosen = KIARA;
  for (const era of eras(dhanamFrom)) {
    if (era.from === null || d >= era.from) chosen = era;
  }
  return chosen;
}
