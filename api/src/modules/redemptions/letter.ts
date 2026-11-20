/**
 * The redemption request letter for ONE redemption already in the system.
 *
 * WHY THIS IS A THIN ADAPTER AND NOT A RENDERER. The letter's layout, wording
 * and addressee eras live in modules/reports/forms/redemption-letter.ts, which
 * arrived with the bulk-letter feature (#530). That renderer is deliberately
 * pure — it takes a plain row and an era and gives back a PDF — because its
 * other caller builds rows from an uploaded spreadsheet and never touches the
 * database. This module is the second caller: it builds the same row from a
 * redemption we already hold.
 *
 * Two features, one letter. Reproducing the layout here instead would have
 * given Dhanam two redemption letters that drift apart the first time the
 * owner corrects a line in one of them.
 *
 * WHICH ADDRESSEE. Not a choice made here: `addresseeFor` decides from the
 * letter's own date, against the boundary the owner can move in Settings. A
 * letter raised through this path is dated today, so in practice it is always
 * the current Dhanam block — which is exactly what the owner asked for when
 * they said "just use dhanam for all the upcoming redemption requests". The
 * era logic gives that answer on its own; a separate rule here would be a
 * second place to maintain the same decision.
 */
import type { Db } from '../../db/types.js';
import { errors } from '../../lib/errors.js';
import { getSettingsMap } from '../settings/service.js';
import {
  redemptionLetterPdf as renderRedemptionLetter,
  type RedemptionLetterRow,
} from '../reports/forms/redemption-letter.js';
import { addresseeFor, DEFAULT_DHANAM_FROM } from '../reports/forms/redemption-letter-addressee.js';

/** The owner-movable boundary, read the way the bulk feature reads it. */
async function dhanamFrom(db: Db): Promise<string> {
  const map = await getSettingsMap(db);
  const v = map['redemption.letter_dhanam_from'];
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : DEFAULT_DHANAM_FROM;
}

/**
 * Build the letter's row from the redemption.
 *
 * THE BANK BLOCK IS A PAYMENT INSTRUCTION, so it is read exactly the way
 * `redemptionNeft` reads it — `customer_bank_accounts` where `is_active`, one
 * row guaranteed by `uq_cba_one_active`. Reading it any other way (most
 * recently added, penny-drop verified, first created) would let a customer
 * sign a letter naming one account while the NEFT file pays another, and the
 * standing rule is that the sheet and the money never disagree.
 *
 * A customer with no active account gets BLANK lines, not an error: the letter
 * is about to be printed and signed by hand, a blank is useful, and refusing
 * to produce it would block the redemption of somebody whose bank details
 * simply have not been captured yet.
 */
export async function redemptionLetterRow(db: Db, redemptionId: number): Promise<RedemptionLetterRow> {
  const r = (await db.query<Record<string, unknown>>(
    `SELECT r.principal,
            c.full_name AS customer_name,
            s.name AS series_name, s.code AS series_code, s.face_value,
            cba.bank_name, cba.holder_name, cba.account_number, cba.ifsc
       FROM redemptions r
       JOIN applications a ON a.id = r.application_id
       JOIN customers c ON c.id = a.customer_id
       LEFT JOIN series s ON s.id = a.series_id
       LEFT JOIN customer_bank_accounts cba
              ON cba.customer_id = c.id AND cba.is_active = TRUE
      WHERE r.id = $1`, [redemptionId])).rows[0];
  if (!r) throw errors.notFound('Redemption not found');

  // The PRINCIPAL being redeemed, not the net payment. The sentence reads
  // "redeem the NCD investment made by me ... for Rs.X" — that is the
  // investment coming back, and on a partial withdrawal it is the part being
  // withdrawn. Penalty and broken-period interest are ours to calculate and
  // the approver's to adjust; a customer must not be asked to sign for a
  // figure the approval step is still allowed to move.
  const principal = Number(r.principal ?? 0);

  // Face value governs the count, the way the certificate counts them. An
  // unknown or nonsensical face value prints nothing rather than a wrong count.
  const faceValue = Number(r.face_value ?? 0) > 0 ? Number(r.face_value) : 100000;
  const debentures = principal > 0 ? String(Math.round(principal / faceValue)) : '';

  const text = (v: unknown): string => (v == null ? '' : String(v).trim());

  return {
    letter_date: new Date().toISOString().slice(0, 10),
    holder_name: text(r.customer_name),
    series: text(r.series_name) || text(r.series_code),
    debentures,
    amount: principal,
    bank_name: text(r.bank_name),
    account_holder_name: text(r.holder_name),
    account_no: text(r.account_number),
    ifsc: text(r.ifsc),
  };
}

/** The letter for one redemption, ready to print or to hand to Digio. */
export async function redemptionLetterPdf(db: Db, redemptionId: number): Promise<Buffer> {
  const row = await redemptionLetterRow(db, redemptionId);
  return renderRedemptionLetter(row, addresseeFor(row.letter_date, await dhanamFrom(db)));
}
