/**
 * TDS computation — ported verbatim from the old app's `computeTds`.
 * Branch behaviour locked in `test/tds.test.ts` (docs/02 §6).
 *
 * The resolved rate is snapshotted onto each schedule row at materialisation;
 * this function is pure and never reads live rules at payout time.
 */
import { round2, type ISODate } from './dates.js';

export interface TdsRule {
  rate_pct: number;
}

export interface TdsCustomer {
  is_nri?: boolean;
  tds_applicable?: boolean; // defaults TRUE in DB
  tax_form?: string | null; // '15G' | '15H' | null
  tax_form_expires_on?: ISODate | null;
}

export interface TdsLine {
  payout_frequency?: string;
  amount?: number;
  tds_applicable?: boolean | null; // per-line override
}

export interface TdsDue {
  due_type: string; // 'Interest' | 'Redemption' | 'BrokenInterest' | ...
  gross_amount: number;
  due_date: ISODate;
}

export interface LowerDeductionCert {
  is_active: boolean;
  rate_pct: number;
  valid_from: ISODate;
  valid_to: ISODate;
}

function isFormValid(
  form: string | null | undefined,
  expiresOn: ISODate | null | undefined,
  today = new Date()
): boolean {
  if (!form) return false;
  if (!expiresOn) return true;
  return new Date(expiresOn) >= today;
}

export function computeTds(
  tdsRule: TdsRule | null,
  customer: TdsCustomer,
  line: TdsLine,
  dueRec: TdsDue,
  ldc?: LowerDeductionCert | null
): number {
  if (!tdsRule) return 0;

  const isCumulative =
    line.payout_frequency === 'Cumulative' || line.payout_frequency === 'LockIn';

  // Pure principal redemption (non-cumulative) → no TDS.
  if (dueRec.due_type === 'Redemption' && !isCumulative) return 0;

  // Per-line override wins; else customer-level flag.
  const lineFlag = line && typeof line.tds_applicable === 'boolean' ? line.tds_applicable : null;
  const custFlag = customer && customer.tds_applicable;
  const effective = lineFlag !== null ? lineFlag : custFlag;
  if (effective === false) return 0;

  // 15G/15H exemption (residents only), judged AS OF THE PAYOUT DATE — not the
  // day the schedule was materialised. A form valid today but expiring before a
  // future payout must NOT exempt that later payout (it would under-deduct TDS).
  if (!customer.is_nri && isFormValid(customer.tax_form, customer.tax_form_expires_on, new Date(dueRec.due_date))) {
    return 0;
  }

  // Cumulative redemption: TDS on interest portion only.
  let taxable = Number(dueRec.gross_amount);
  if (dueRec.due_type === 'Redemption' && isCumulative) {
    taxable = Math.max(0, Number(dueRec.gross_amount) - Number(line.amount));
  }

  // Lower Deduction Certificate: cert rate if the payout date is in its window.
  if (ldc && ldc.is_active) {
    const dueDate = new Date(dueRec.due_date);
    if (dueDate >= new Date(ldc.valid_from) && dueDate <= new Date(ldc.valid_to)) {
      return round2((taxable * Number(ldc.rate_pct)) / 100);
    }
  }

  return round2((taxable * Number(tdsRule.rate_pct)) / 100);
}
