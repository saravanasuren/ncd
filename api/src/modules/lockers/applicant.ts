/**
 * Builds the LockerHub `applicant` block (contract Part A, POST
 * /locker-applications) from an NCD customer. Sending it with the create makes
 * the tenancy complete on their side, so nobody has to open LockerHub to finish
 * a locker off.
 *
 * ─── AADHAAR: last four ONLY, and never by accident ──────────────────────────
 * LockerHub rejects a full 12-digit Aadhaar with a 400 and is not permitted to
 * store one (Aadhaar Act 2016 s.29). We DO hold the full number — `customers.
 * aadhaar` sits directly beside `customers.aadhaar_last4`, and the nominee's
 * `kyc_id_number` can be a full Aadhaar too. A single wrong column here would
 * push a full Aadhaar out of our system into theirs; their 400 would reject the
 * request, but the number would already have left.
 *
 * So the rule is enforced structurally, not by remembering it: the SELECT below
 * never reads `customers.aadhaar` at all, and every value that reaches the
 * payload goes through `last4()`. Applying last4 to an already-4-char column is
 * a no-op, so it is safe on both, and it means no future edit can widen the
 * field without deleting a visible guard. Tests pin this.
 */
import type { Db } from '../../db/index.js';

/** Last four digits of an identifier, or null. Digits only — a masked value
 *  like "XXXX1234" must not leak its mask into the payload. */
function last4(v: unknown): string | null {
  const digits = String(v ?? '').replace(/\D/g, '');
  return digits.length >= 4 ? digits.slice(-4) : null;
}

const clean = (v: unknown): string => {
  const s = String(v ?? '').trim();
  return s === 'null' || s === 'undefined' ? '' : s;
};
const iso = (v: unknown): string => (v instanceof Date ? v.toISOString().slice(0, 10) : clean(v));

// A `type`, not an `interface`, on purpose: only a type alias gets an implicit
// index signature, and the client sends this as a JSON body typed
// Record<string, unknown>. An interface here fails to typecheck at the call site.
export type ApplicantBlock = {
  dob?: string; gender?: string; guardian_name?: string; occupation?: string;
  address: { flat_building: string; road_name: string; landmark: string; city: string; state: string; pincode: string };
  nominee?: { name: string; phone: string; relation: string; dob: string; pan: string; aadhaar_last4: string };
  kyc: { pan: string; aadhaar_last4: string; verified: boolean; method?: string };
  bank?: { name: string; account_last4: string; ifsc: string; branch: string };
}

/**
 * Assemble the block for one customer. Returns null when the customer is
 * unknown — the caller then creates the application without it rather than
 * failing the enrolment, since the applicant block is enrichment, not a
 * precondition (LockerHub accepts a create without it).
 */
export async function buildApplicantBlock(db: Db, customerId: number): Promise<ApplicantBlock | null> {
  // NOTE: `customers.aadhaar` (the full 12 digits) is deliberately NOT selected.
  const c = (await db.query<Record<string, unknown>>(
    `SELECT dob, gender, father_name, occupation, address, city, state, pincode,
            pan, aadhaar_last4, kyc_status
       FROM customers WHERE id = $1 AND archived_at IS NULL`, [customerId])).rows[0];
  if (!c) return null;

  // Highest-share nominee — the one a locker tenancy would name. share_pct can
  // be NULL (see the "no stated share" rule), so NULLs sort last, not first.
  const n = (await db.query<Record<string, unknown>>(
    `SELECT full_name, relationship, dob, pan, phone, kyc_id_type, kyc_id_number
       FROM nominees WHERE customer_id = $1
      ORDER BY share_pct DESC NULLS LAST, id ASC LIMIT 1`, [customerId])).rows[0];

  const b = (await db.query<Record<string, unknown>>(
    `SELECT bank_name, account_number, ifsc, branch_name
       FROM customer_bank_accounts WHERE customer_id = $1 AND is_active = TRUE
      ORDER BY id ASC LIMIT 1`, [customerId])).rows[0];

  // A nominee's Aadhaar only exists when the KYC id they gave IS an Aadhaar —
  // a PAN or passport number's last four is not an Aadhaar and must not be sent
  // as one.
  const nomineeAadhaar = /aadhaar/i.test(clean(n?.kyc_id_type)) ? last4(n?.kyc_id_number) : null;

  return {
    ...(iso(c.dob) ? { dob: iso(c.dob) } : {}),
    ...(clean(c.gender) ? { gender: clean(c.gender) } : {}),
    ...(clean(c.father_name) ? { guardian_name: clean(c.father_name) } : {}),
    ...(clean(c.occupation) ? { occupation: clean(c.occupation) } : {}),
    // We hold one free-text address line, not their four parts. It goes in
    // road_name — the field that carries the street in their form — rather than
    // being chopped on commas, which would invent structure we do not have.
    address: {
      flat_building: '', road_name: clean(c.address), landmark: '',
      city: clean(c.city), state: clean(c.state), pincode: clean(c.pincode),
    },
    ...(n ? {
      nominee: {
        name: clean(n.full_name), phone: clean(n.phone), relation: clean(n.relationship),
        dob: iso(n.dob), pan: clean(n.pan), aadhaar_last4: nomineeAadhaar ?? '',
      },
    } : {}),
    kyc: {
      pan: clean(c.pan),
      aadhaar_last4: last4(c.aadhaar_last4) ?? '',
      verified: clean(c.kyc_status) === 'Verified',
      // `method` is deliberately omitted: we do not record HOW kyc was done, and
      // guessing "digilocker" would put a false provenance claim in their book.
    },
    ...(b ? {
      bank: {
        name: clean(b.bank_name), account_last4: last4(b.account_number) ?? '',
        ifsc: clean(b.ifsc), branch: clean(b.branch_name),
      },
    } : {}),
  };
}
