/**
 * The document a holder signs to release their own redemption.
 *
 * WHICH DOCUMENT CHANGED HERE. This module used to build the "Request for
 * Redemption" letter from #530. The owner replaced it on 2026-11-20 with the
 * "Consent for Premature Redemption" — asked outright which one gates a
 * redemption, they chose the consent letter, and the reason holds up: it is
 * the one that protects the Company. The waiver of the 2% premium, the
 * no-further-claims clause and the Trustee authority are all in it and none of
 * them is in the request letter.
 *
 * The request letter is NOT retired. The bulk spreadsheet tool goes on
 * printing it exactly as before; what changed is only which document stands
 * between a redemption and its approver.
 *
 * WHEN IT APPLIES. From the date in `redemption.consent_letter_from`
 * (13 November 2026, movable in Settings). A redemption raised before that is
 * untouched — no letter, no gate — because those were settled under the old
 * rules and asking for consent afterwards would be inventing it. The 19
 * already raised on or after that date are a middle case: their letters can be
 * DOWNLOADED so staff can collect a signature on paper, but they are already
 * approved and are not retrospectively blocked.
 */
import type { Db } from '../../db/types.js';
import { errors } from '../../lib/errors.js';
import { getSettingsMap } from '../settings/service.js';
import { consentLetterPdf, type ConsentLetterRow } from '../reports/forms/consent-letter.js';

/** The owner-movable date the consent letter starts applying from. */
export const DEFAULT_CONSENT_FROM = '2026-11-13';

export async function consentLetterFrom(db: Db): Promise<string> {
  const map = await getSettingsMap(db);
  const v = map['redemption.consent_letter_from'];
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : DEFAULT_CONSENT_FROM;
}

/**
 * Build the consent letter's row from the redemption.
 *
 * THE BANK BLOCK IS A PAYMENT INSTRUCTION, so it is read exactly the way
 * `redemptionNeft` reads it — `customer_bank_accounts` where `is_active`, one
 * row guaranteed by `uq_cba_one_active`. Reading it any other way would let a
 * holder sign a consent naming one account while the NEFT file pays another,
 * and the standing rule is that the sheet and the money never disagree.
 *
 * Unknown particulars come back BLANK, never as a dash or a guess. This is a
 * document somebody signs: a blank invites the obvious correction, where "—"
 * reads like a settled fact. That applies above all to Mode of holding, which
 * is left to the person who was actually asked.
 */
export async function redemptionConsentRow(db: Db, redemptionId: number): Promise<ConsentLetterRow> {
  const r = (await db.query<Record<string, unknown>>(
    `SELECT r.principal, r.holding_mode, r.rollover_date, r.created_at,
            c.full_name AS customer_name, c.pan,
            a.allotment_date, a.maturity_date,
            s.name AS series_name, s.code AS series_code, s.face_value,
            l.coupon_rate_pct,
            cba.bank_name, cba.branch_name, cba.holder_name, cba.account_number, cba.ifsc
       FROM redemptions r
       JOIN applications a ON a.id = r.application_id
       JOIN customers c ON c.id = a.customer_id
       LEFT JOIN series s ON s.id = a.series_id
       LEFT JOIN LATERAL (
         SELECT coupon_rate_pct FROM application_lines
          WHERE application_id = a.id ORDER BY id LIMIT 1
       ) l ON TRUE
       LEFT JOIN customer_bank_accounts cba
              ON cba.customer_id = c.id AND cba.is_active = TRUE
      WHERE r.id = $1`, [redemptionId])).rows[0];
  if (!r) throw errors.notFound('Redemption not found');

  const text = (v: unknown): string => (v == null ? '' : String(v).trim());
  const principal = Number(r.principal ?? 0);

  // THE NUMBER BEING REDEEMED, not the whole holding (owner 2026-11-20). The
  // consent sentence reads "redeem all N NCDs held by me", and on a partial
  // withdrawal the holder is consenting to the part, not the lot. Baskaran TTS
  // redeemed 5L of a 10L holding twice in one week; each consent is for its
  // own half.
  const faceValue = Number(r.face_value ?? 0) > 0 ? Number(r.face_value) : null;
  const ncdCount = faceValue && principal > 0 ? String(Math.round(principal / faceValue)) : '';

  // "Indian Overseas Bank, Ganapathy" — the branch only when we hold one.
  const bankAndBranch = [text(r.bank_name), text(r.branch_name)].filter(Boolean).join(', ');

  return {
    letter_date: new Date().toISOString().slice(0, 10),
    holder_name: text(r.customer_name),
    pan: text(r.pan),
    series: text(r.series_name) || text(r.series_code),
    allotment_date: text(r.allotment_date).slice(0, 10),
    // Blank unless somebody was asked, like the mode of holding. Never taken
    // from the allotment date, which for a rolled-over holding IS the rollover
    // date — printing it twice would turn one fact into two.
    rollover_date: text(r.rollover_date).slice(0, 10),
    original_maturity_date: text(r.maturity_date).slice(0, 10),
    ncd_count: ncdCount,
    face_value: faceValue,
    coupon_rate_pct: r.coupon_rate_pct == null ? null : Number(r.coupon_rate_pct),
    // Blank unless somebody was asked. Never inferred from the demat columns.
    mode_of_holding: text(r.holding_mode),
    account_name: text(r.holder_name) || text(r.customer_name),
    account_no: text(r.account_number),
    bank_and_branch: bankAndBranch,
    ifsc: text(r.ifsc),
  };
}

/** The consent letter for one redemption, ready to print or hand to Digio. */
export async function redemptionLetterPdf(db: Db, redemptionId: number): Promise<Buffer> {
  return consentLetterPdf(await redemptionConsentRow(db, redemptionId));
}
