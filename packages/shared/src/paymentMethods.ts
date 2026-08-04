/**
 * How money arrived for an investment.
 *
 * This was free text everywhere until 2026-08-04, and production shows exactly
 * what free text does to a field: NEFT (41), NEFT/RTGS (25), RTGS (22) and
 * neft (1) are four spellings of one payment method, plus 3 rows left blank.
 * Nothing can group, filter or reconcile on a column written four ways.
 *
 * Deliberately SHARED rather than repeated per screen — the enrolment form and
 * the approval screen disagreeing about the allowed values is how the mess
 * restarts.
 */
export const PAYMENT_METHODS = ['NEFT/RTGS', 'IMPS', 'Cheque', 'Other'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/**
 * The options to show for a record whose stored method may predate this list.
 *
 * 638 live rows say "Other", 41 say "NEFT", 2 say "Easebuzz" (written by the
 * payment-link integration, never typed by staff). A dropdown offering only
 * the canonical four would quietly re-point every one of those to the first
 * option the moment a checker approved it — silent data loss inside the one
 * screen whose entire job is catching mistakes.
 *
 * So an unrecognised current value is kept, and offered as its own option. The
 * approver can leave it exactly as it is, or consciously normalise it.
 */
export function paymentMethodOptions(current: string | null | undefined): string[] {
  const c = String(current ?? '').trim();
  if (!c) return [...PAYMENT_METHODS];
  const known = PAYMENT_METHODS.some((m) => m.toLowerCase() === c.toLowerCase());
  // Matched apart from case ("neft" vs "NEFT/RTGS" does NOT match; "cheque"
  // vs "Cheque" does) — keep the stored spelling so approving changes nothing.
  return known ? PAYMENT_METHODS.map((m) => (m.toLowerCase() === c.toLowerCase() ? c : m)) : [c, ...PAYMENT_METHODS];
}
