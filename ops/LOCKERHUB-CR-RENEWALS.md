# Change request — locker renewals (rent for year 2 onwards)

**From:** Dhanam NCD · **Date:** 2026-08-03 · **Status:** open, blocking

## What we can't do today

A locker is an annual-rent product, but the API has no concept of a second
year. Everything about rent is attached to the original application:

- **A8** returns `legs: { rent: {amount, settled}, deposit: {amount, settled} }`
  — two legs, each a bare boolean. Once `rent.settled` is `true` it stays true
  forever. There is nowhere to express "2027's rent is now due".
- **A9 payment-link** takes `leg: "rent" | "deposit"` on an *application* id. For
  an allotted tenancy the rent leg is already settled, so it has nothing to bill.
- **A18 settle-offline** is explicitly idempotent: a leg that is already settled
  returns `{ already: true, leg_settled: true }` and creates no row. So we cannot
  record a renewal payment through it either.
- **A13** gives us `lease_expires_on`, so we *can* see a lease lapsing — we just
  can't act on it.

Net effect: NCD can tell a staff member "this locker's lease ended 40 days ago"
and then has to send them to LockerHub to do anything about it. That is the one
remaining reason our staff still open your system day to day.

We have shipped the read-only half (a **Locker Renewals** worklist, overdue
first). We deliberately did **not** ship a "Collect renewal" button, because
anything we built today would either fail against A18's idempotency or create a
payment record on our side that never reaches yours — and a renewal ledger that
disagrees with the system of record is worse than no button at all.

## What we need

### 1. A renewal cycle on the tenancy, not the application

Rent needs to be addressable per period. Minimum shape:

```
GET /locker-tenants/{tenant_id}/rent-cycles
→ { "cycles": [
      { "cycle_id": "...", "period_start": "2026-09-01", "period_end": "2027-08-31",
        "annual_rent": 3000, "rent_incl_gst": 3540, "gst_pct": 18,
        "status": "due" | "paid" | "waived", "due_on": "2026-09-01",
        "settled_at": null, "payment_method": null }
  ] }
```

The current period should appear here too, so a tenancy has one consistent rent
history rather than "year 1 lives on the application, year 2+ lives elsewhere".

### 2. Collect a renewal — online and offline

Mirroring A9 and A18, keyed on the cycle rather than the application:

```
POST /locker-tenants/{tenant_id}/rent-cycles/{cycle_id}/payment-link
  { "staff": {...} } → { "checkout_url", "intent_no", "amount" }

POST /locker-tenants/{tenant_id}/rent-cycles/{cycle_id}/settle-offline
  { "method": "cheque"|"cash"|"transfer", "reference": "...",
    "received_on": "YYYY-MM-DD", "staff": {...} }
```

Please keep the two properties that make A18 good: **amount is server-derived**
(we name the cycle, never a figure), and **idempotent** on an already-settled
cycle. Same `staff_id` / `staff_role` assertion and audit logging as A11/A18.

### 3. Extend the lease when a cycle settles

`lease_expires_on` should move to the paid cycle's `period_end` automatically on
settlement — the same way A9 settlement advances an application today. We do not
want a separate "extend lease" call that could be forgotten and leave a paid
tenancy still reading as expired on our worklist.

### 4. A waiver path

You already have **A21** for application-level waivers. The equivalent for a
rent cycle (full or partial, with reason + approver) would let us handle the
"long-standing customer, rent waived this year" case without an override.

## Two questions

1. **Who generates the cycles?** Our assumption is LockerHub mints the next
   cycle automatically as the current one nears its end. If instead you expect
   NCD to call something to open a cycle, say so — it changes our worklist.
2. **What happens today when a lease lapses?** Does the tenancy keep working,
   or does access get cut at some point? We currently have no way to tell a
   customer what the consequence of not renewing is.

## Priority

This is the largest remaining hole in "run lockers from NCD". We have live
tenancies whose leases will lapse with nothing in our system able to take the
money. Happy to work to whatever shape suits your model — the four points above
are the requirement, not the design.
