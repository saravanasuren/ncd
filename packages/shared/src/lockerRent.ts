/**
 * Standard locker rent waiver (owner 2026-08-20).
 *
 * The owner's rule: after the waiver a customer pays a ROUND figure — M 6,000,
 * L 12,000, XL 20,000 — with GST already inside it.
 *
 * The trap this exists to avoid: LockerHub applies our waiver to the PRE-TAX
 * rent and then recomputes GST on the discounted base (contract §A21, "a proper
 * tax invoice"). So sending the GST amount as the waiver does NOT produce the
 * round number — on a 6,000 + 18% locker it bills 5,805.60, not 6,000.
 *
 * Sending a PERCENTAGE does, and the algebra is why: discounting the base by a
 * factor discounts the GST-inclusive total by the same factor. To collect only
 * the base amount out of a base+GST bill, waive
 *
 *     gst / (100 + gst)
 *
 * of the rent — 18/118 = 15.2542…% at 18% GST. It is the same percentage for
 * every locker size, because GST is the same rate on each.
 */

/** Percentage of the pre-tax rent to waive so the customer pays the pre-tax
 *  figure as their GST-INCLUSIVE total. */
export function rentWaiverPctForGst(gstPct: number): number {
  const g = Number(gstPct);
  if (!Number.isFinite(g) || g <= 0) return 0;
  return (g / (100 + g)) * 100;
}

/** 18% GST — 15.2542372881%. The live rate always comes from LockerHub's
 *  `gst_pct`; this is the figure to quote when explaining the rule. */
export const STANDARD_RENT_WAIVER_PCT = rentWaiverPctForGst(18);

/**
 * What the customer ends up paying, and what is given up, for a rent priced at
 * `annualRent` before `gstPct` GST. Rounded to paise for display; LockerHub
 * remains the authority on the figure actually collected.
 */
export function rentWaiverBreakdown(annualRent: number, gstPct: number): {
  gross: number; waived: number; payable: number; waiverPct: number; baseWaiver: number;
} {
  const rent = Number(annualRent) || 0;
  const g = Number(gstPct) || 0;
  const pct = rentWaiverPctForGst(g);
  const gross = rent * (1 + g / 100);
  // Waiving `pct` of the base scales the whole GST-inclusive bill by the same
  // factor, which lands the payable exactly on the pre-tax rent.
  const payable = rent;
  const round2 = (n: number) => Math.round(n * 100) / 100;
  // What to SEND LockerHub: the reduction to the PRE-TAX base, not the
  // GST-inclusive saving. rent - rent/(1+gst) — i.e. strip the tax component
  // out of the rent so what is left, plus GST, is the rent again.
  //
  // Sent as an AMOUNT, never a percentage. LockerHub rounds a percentage to 2
  // decimals: 15.2542…% becomes 15.25%, which bills 12,000.60 on a 12,000
  // locker and shows as 12,001 (owner 2026-08-21). An exact amount has no such
  // lossy step and lands on the round figure to the paisa.
  const baseWaiver = round2(rent - rent / (1 + g / 100));
  return { gross: round2(gross), waived: round2(gross - payable), payable: round2(payable), waiverPct: pct, baseWaiver };
}
