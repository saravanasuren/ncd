# LockerHub contract change request — finish a locker tenancy from NCD

**From:** Dhanam Investment and Finance (NCD platform)
**Date:** 29 July 2026
**Contract:** Part A (NCD → LockerHub), current v1.2

---

## What we are asking for

Branch staff must be able to complete a locker enrolment **end to end inside NCD**,
including the cases where rent or deposit is **waived** or **arrives late**. Today
they cannot: the flow reaches a point where the only way forward is to open
LockerHub and finish it by hand.

That is not a preference. Our branch staff do not have LockerHub logins, so an
enrolment that needs a waiver or an offline settlement simply stops.

Four gaps, in the order they bite. §1 is the one blocking us today.

---

## §1 — Accept our KYC, or give us a way to complete yours

**Today:** a locker application created via `POST /locker-applications` sits at
`status: kyc_pending` indefinitely. Nothing in Part A moves it on.

We already send you the full applicant profile on create, as agreed in the
2026-07-24 contract note: date of birth, gender, guardian, occupation, full
address, nominee, PAN, Aadhaar last-four, and bank details. Example of a live
payload we send:

```json
{ "phone": "…", "name": "…", "branch_id": "br_rspuram", "locker_size": "Large",
  "applicant": {
    "dob": "1985-06-02", "gender": "…", "occupation": "…",
    "address": { "road_name": "…", "city": "Coimbatore", "state": "Tamil Nadu", "pincode": "641001" },
    "nominee": { "name": "…", "relation": "…", "phone": "…", "pan": "…", "aadhaar_last4": "9012" },
    "kyc":     { "pan": "AAHPV1828L", "aadhaar_last4": "9012", "verified": true },
    "bank":    { "name": "…", "account_last4": "0099", "ifsc": "…" } },
  "staff": { … } }
```

Yet `GET /customers/{phone}` still returns, for that same customer:

```json
"profile": { "name": "", "email": "", "address_line1": "", … },
"kyc": { "pan_verified": false, "aadhaar_verified": false }
```

**Please confirm which of these you intend:**

- **(a)** `applicant.kyc.verified: true` satisfies your KYC gate, and the
  application should leave `kyc_pending` on create. If this is already the
  intent, it is not working — the profile above came back empty.
- **(b)** You need an explicit call. Then please expose
  `POST /locker-applications/{id}/kyc` accepting our verification evidence
  (method, verified-on date, verifier, PAN/Aadhaar-last4) and moving the
  application out of `kyc_pending`.

We are a regulated NBFC and complete full KYC before any investment. We are not
asking you to skip verification — we are asking you to accept ours, or tell us
how to hand it to you.

> **Note on Aadhaar:** we send **last four digits only** and will not send more.
> We hold the full number; the Aadhaar Act 2016 s.29 does not permit us to pass
> it to you, and your API rejects it. Please do not design any endpoint that
> requires a full Aadhaar.

---

## §2 — A way to record a payment that did not come through the payment link

**Today:** `POST /locker-applications/{id}/payment` (A10) is retired and returns
`400 online_only` for every caller.

We understand why: a synthetic payment row broke your reconciliation and made
your deposit-refund flow treat a pledge as refundable cash (your #709). We are
not asking for that endpoint back as it was.

**We are asking for an explicit, clearly-typed offline settlement:**

```
POST /locker-applications/{id}/settle-offline
{ "leg": "rent" | "deposit",
  "method": "cheque" | "cash" | "transfer",
  "amount": 14160,
  "reference": "CHQ-001234",         // cheque no / UTR
  "received_on": "2026-07-29",
  "reason": "Cheque collected at branch, clears 02-Aug",
  "staff": { … } }
```

It must be **distinguishable in your books from an online receipt** — a
different payment type, not a fake Easebuzz row — so your reconciliation and
refund flows can treat it correctly.

Without this, a customer who pays by cheque at the branch cannot be enrolled
from NCD at all.

---

## §3 — A way to apply a rent or deposit waiver

**Today:** we can *read* a waiver — `legs.rent.original_amount`,
`waiver_pct`, `waiver_amount` come back on the application — but there is no
way to *apply* one. So a waiver has to be keyed into LockerHub by someone with
a LockerHub login.

**Please expose:**

```
POST /locker-applications/{id}/waiver
{ "leg": "rent" | "deposit",
  "waiver_pct": 100,                  // or "waiver_amount"
  "reason": "Relationship waiver approved by CXO",
  "staff": { … } }
```

Our side already has maker–checker on waivers (NCD Manager requests, Admin/CXO
approves), so the call would only ever be made post-approval, and `staff` will
carry the approver.

If a 100% waiver should also settle the leg, please say so explicitly in the
response — we would rather not infer it.

---

## §4 — Allocate: an auditable exception path

**Today:** `POST /locker-applications/{id}/allocate` refuses with
`409 obligations_pending { missing: ["rent"] }` when money is unsettled, and —
quoting our own integration notes from your contract — *"there is no override
over this channel."*

We are **not** asking you to weaken that gate. It is the right default and we
want it kept.

We are asking for a **narrow, attributed exception** for the case where the
business has knowingly accepted the risk:

```
POST /locker-applications/{id}/allocate
{ "locker_id": "…",
  "override": { "reason": "Deposit waived — approved by CXO, ref WVR-2026-014",
                "approved_by": "…" },
  "staff": { … } }
```

Refuse it for any role you like — restrict it to a senior role on your side if
that helps. Log it loudly. But if §2 and §3 are delivered, this may not be
needed at all: settle-offline and waiver would clear the obligations properly
and allocate would pass on its own merits. **§4 is the fallback, not the
preference.**

---

## Also outstanding

Carried over from earlier discussions, unrelated to the above:

- **B7** — still open.
- **B23 / B24** — still open.
- **Part A locker console** — still open.

---

## What we would like back

1. Confirmation on **§1(a) or §1(b)** — this is blocking live enrolments now.
2. Yes/no plus a rough timeline on **§2** and **§3**.
3. Whether **§4** is acceptable if §2 and §3 land.

Happy to test against staging as soon as any of these are available; our
integration is already built against Part A and we have contract tests we can
extend the same day.
