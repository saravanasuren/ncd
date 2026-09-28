/**
 * How a locker's rent stands — the ONE vocabulary.
 *
 * The Locker Tenants page and the Locker Rent Report used to each decide this
 * for themselves, with different rules, and drifted: a customer whose Premium
 * request was still awaiting approval read "Paid" on one and "Unpaid" on the
 * other, and Tenants said "Paid" for anyone with no waiver whatever their
 * payment. The rule itself lives in api/src/modules/lockers/rentStatus.ts; this
 * file is what every consumer — API, Excel export and both screens — shares, so
 * the set of states and their names cannot differ between them either.
 */
export const RENT_STATUSES = ['paid', 'waived', 'premium', 'unpaid', 'unknown'] as const;
export type RentStatus = (typeof RENT_STATUSES)[number];

export const RENT_STATUS_LABEL: Record<RentStatus, string> = {
  paid: 'Paid',
  waived: 'Waived',
  premium: 'Premium',
  unpaid: 'Unpaid',
  // LockerHub could not be read, so nothing can be said about the money. Never
  // shown as Paid or Unpaid: an unanswered question is not an answer.
  unknown: 'Unknown',
};
