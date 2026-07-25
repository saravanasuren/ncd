/**
 * Escrow-statement vocabulary + the pure narration parser, shared by the API
 * (which ingests the SBI export and matches lines to customers) and the web UI
 * (which labels statuses and pay-types the same way).
 *
 * NCD subscription money lands in a single SBI current account. SBI's "download
 * as xls" is really tab-separated text; every credit line identifies its payer
 * differently depending on how they paid (RTGS/NEFT/IMPS carry a name + UTR in
 * the narration; cheque credits carry only a cheque number). This module turns
 * one raw (description, ref) pair into structured party fields WITHOUT touching
 * the database — the DB-dependent customer match lives in the API service.
 *
 * The regexes are pinned to real SBI narration seen on the DHANAM escrow
 * statement; see api/test/escrow-parse.test.ts for the exact fixtures.
 */

/** One lakh, in rupees. A genuine NCD credit is a positive multiple of this. */
export const NCD_UNIT = 100000;

/** Default floor the company itself parks in escrow (owner: ₹10L, not an
 * investment). Overridable via settings.escrow.company_floor. */
export const ESCROW_COMPANY_FLOOR_DEFAULT = 1000000;

export type EscrowPayType = 'RTGS' | 'NEFT' | 'IMPS' | 'Cheque' | 'Internal' | 'Other';

/**
 * Proposed disposition of a credit line. The system only ever PROPOSES — a
 * human confirms on the reconciliation screen (owner: "flag for human").
 *  - Company    : the company's own floor / test transfers (not an investment)
 *  - Matched    : proposed match to an enrolled customer
 *  - NotEnrolled: a real-looking investor credit whose payer isn't in the system
 *  - Unidentified: a credit (usually a bare cheque) with nothing to match on
 *  - Flagged    : amount isn't a ₹1L multiple, or otherwise needs a look
 *  - Debit      : an outgoing line (sweep/refund), tracked but not investor money
 *  - Ignored    : a human dismissed it
 */
export type EscrowMatchStatus =
  | 'Unmatched' | 'Company' | 'Matched' | 'NotEnrolled' | 'Unidentified' | 'Flagged' | 'Debit' | 'Ignored';

export const ESCROW_MATCH_METHODS = ['utr', 'account', 'name', 'cheque', 'manual'] as const;
export type EscrowMatchMethod = (typeof ESCROW_MATCH_METHODS)[number];

export interface EscrowParty {
  payType: EscrowPayType;
  /** Bank reference / UTR pulled from the narration (RTGS UTR, NEFT ref, IMPS ref, INB token). */
  utr: string | null;
  /** Counterparty account number from "TRANSFER FROM/TO <acct>". For NEFT this
   *  is SBI's clearing pool, not the real remitter — see `remitterAccountPooled`. */
  remitterAccount: string | null;
  /** True when remitterAccount is a shared clearing/suspense account (NEFT/IMPS
   *  pool), so it must NOT be used to identify the payer. */
  remitterAccountPooled: boolean;
  /** Best-effort payer name (from the ref column, else the narration). */
  remitterName: string | null;
  /** Cheque number for cheque credits. */
  chequeNo: string | null;
  /** Presenting-bank code on a cheque credit (CAB/ICI/AXS/…), informational. */
  presentingBank: string | null;
}

const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim();

/**
 * SBI pools inbound NEFT (and some IMPS) under a single clearing account, so the
 * same "remitter account" repeats across unrelated people. Those numbers can't
 * identify a payer. This is seeded with the pool seen on the DHANAM statement and
 * is extended at runtime by the service (any account paying for ≥N distinct names).
 */
export const KNOWN_POOL_ACCOUNTS = new Set<string>(['99509044300']);

/** Pull the payer/reference fields out of one SBI credit's (description, ref). */
export function parseEscrowNarration(description: string, ref: string): EscrowParty {
  const desc = (description ?? '').trim();
  const refRaw = (ref ?? '').trim();
  const party: EscrowParty = {
    payType: 'Other', utr: null, remitterAccount: null, remitterAccountPooled: false,
    remitterName: null, chequeNo: null, presentingBank: null,
  };

  // --- Counterparty account + name from the Ref column -----------------------
  // "TRANSFER FROM <acct>  <name?> / <name?|chequeNo?>" (FROM for credits, TO for
  // cheque deposits). A token may precede it (INB internal ref, e.g. CIAANRBVL2).
  const xfer = /TRANSFER\s+(?:FROM|TO)\s+(\d+)\s*(.*)$/i.exec(refRaw);
  if (xfer) {
    party.remitterAccount = xfer[1]!;
    const rest = xfer[2] ?? '';
    const [before, after] = rest.split('/').map((s) => collapse(s));
    // Name sits before the slash ("… DHANAM INVESTMENT AND / ") or after it
    // ("/ S GUNASEKARAN"); the other side is blank or a cheque number.
    const name = before || after || '';
    if (name && !/^\d+$/.test(name)) party.remitterName = name;
    if (after && /^\d+$/.test(after)) party.chequeNo = after;
    // A token before "TRANSFER" is the INB/internal reference.
    const lead = refRaw.slice(0, xfer.index).trim();
    if (lead) party.utr = lead;
  }

  // --- Pay type + UTR/cheque from the Description ----------------------------
  if (/BY TRANSFER-RTGS/i.test(desc)) {
    party.payType = 'RTGS';
    const m = /UTR\s*NO:\s*(\S+?)--\s*(.*)$/i.exec(desc);
    if (m) { party.utr = m[1]!; if (!party.remitterName && m[2]) party.remitterName = collapse(m[2]); }
  } else if (/BY TRANSFER-NEFT/i.test(desc)) {
    party.payType = 'NEFT';
    // NEFT*<ifsc>*<ref>*<name>*<trailer?>--
    const m = /NEFT\*([^*]*)\*([^*]*)\*([^*]*)/i.exec(desc);
    if (m) {
      party.utr = m[2]?.trim() || party.utr;
      const nm = collapse(m[3] ?? '');
      if (!party.remitterName && nm && !/^BATCHID/i.test(nm)) party.remitterName = nm;
    }
  } else if (/BY TRANSFER-IMPS/i.test(desc)) {
    party.payType = 'IMPS';
    // IMPS/<ref>/<bank>-XX<nnn>-<name>/<trailer>--
    const m = /IMPS\/(\d+)\/[^-]*-[^-]*-([^/]*)\//i.exec(desc);
    if (m) {
      party.utr = m[1]!;
      const nm = collapse(m[2] ?? '');
      if (!party.remitterName && nm && !/^Accountva/i.test(nm)) party.remitterName = nm;
    }
  } else if (/CREDIT-Chq|CHEQUE DEPOSIT/i.test(desc)) {
    party.payType = 'Cheque';
    const c = /Chq\s+(\d+)\s+([A-Z]{2,4})\b/i.exec(desc);
    if (c) { party.chequeNo = c[1]!; party.presentingBank = c[2]!.toUpperCase(); }
    else {
      // "CHEQUE DEPOSIT---282403" / "CHEQUE DEPOSIT-TRF--763763"
      const d = /CHEQUE DEPOSIT[^\d]*(\d+)\s*$/i.exec(desc);
      if (d && !party.chequeNo) party.chequeNo = d[1]!;
    }
  } else if (/BY TRANSFER-INB/i.test(desc)) {
    party.payType = 'Internal';
  } else if (/BY TRANSFER-/i.test(desc) && !party.utr) {
    // Other SBI internal rail (e.g. "BY TRANSFER-SBIY…/P/Deposit or Investment--").
    // Still a matchable credit; grab the leading token as the reference.
    const m = /BY TRANSFER-([A-Za-z0-9]+)/i.exec(desc);
    if (m) party.utr = m[1]!;
  }

  if (party.remitterAccount && KNOWN_POOL_ACCOUNTS.has(party.remitterAccount)) {
    party.remitterAccountPooled = true;
  }
  // SBI narration ends names with a "--" cell terminator and RTGS occasionally
  // with a stray " ." — strip trailing separators so the name matches cleanly.
  if (party.remitterName) party.remitterName = collapse(party.remitterName).replace(/[-.\s]+$/, '');
  return party;
}

/** A genuine NCD credit: a positive whole multiple of ₹1,00,000 (paise-exact). */
export function isNcdUnitMultiple(amountRupees: number): boolean {
  const paise = Math.round(amountRupees * 100);
  const unit = NCD_UNIT * 100;
  return paise > 0 && paise % unit === 0;
}

/** Is this the company funding its own escrow floor (not an investment)? */
export function isCompanySelfPayment(party: EscrowParty, companyAccounts: Set<string>): boolean {
  if (party.remitterAccount && companyAccounts.has(party.remitterAccount)) return true;
  if (party.remitterName && /DHANAM\s+INVESTMENT/i.test(party.remitterName)) return true;
  return false;
}

/** Normalise a name for fuzzy comparison: drop honorifics/punctuation, upper,
 *  collapse spaces. "Mrs. P  VIJAYANIRMALA" → "P VIJAYANIRMALA". */
export function normaliseName(name: string): string {
  return collapse(
    (name ?? '')
      .replace(/\b(mr|mrs|ms|m\/s|dr|shri|smt|kum|sri)\.?\b/gi, ' ')
      .replace(/[^A-Za-z0-9 ]/g, ' ')
      .toUpperCase(),
  );
}

export const ESCROW_STATUS_LABEL: Record<EscrowMatchStatus, string> = {
  Unmatched: 'Unmatched',
  Company: 'Company floor',
  Matched: 'Matched to investor',
  NotEnrolled: 'Received — not enrolled',
  Unidentified: 'Unidentified',
  Flagged: 'Flagged',
  Debit: 'Outgoing',
  Ignored: 'Ignored',
};
