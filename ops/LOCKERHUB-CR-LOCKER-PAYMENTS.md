# Change Request → LockerHub — locker payments & availability

From: Dhanam NCD team · Date: 2026-08-07 · Priority: P1 (item 1 is a live prod error)

Five asks, ordered by urgency. #1 is causing a visible error in NCD production
today. Contract section numbers reference `ops/LOCKERHUB-INTEGRATION-CONTRACT.md`.

---

## 1. **[BUG, urgent]** Drop / rescope `UNIQUE(payments.wealth_ncd_id)`

**Symptom in NCD prod:** the Locker Enrollment page shows
`UNIQUE constraint failed: payments.wealth_ncd_id` when staff back a locker
deposit with an NCD investment.

**Cause:** your `payments` table has a UNIQUE index on `wealth_ncd_id` (the NCD
application number we send as `ncd_id` in **A12 `link-ncd`**). That makes an NCD
application number usable on only **one** locker payment row, ever.

**Business rule (owner-confirmed 2026-08-07):** one NCD investment may back
**several** locker deposits. If a customer's investment exceeds one locker's
deposit, the surplus can secure another locker — staff/customer's discretion.
NCD already models and caps this (sum of pledges ≤ the investment's outstanding).

**Requested change:**
- Replace `UNIQUE(wealth_ncd_id)` with **`UNIQUE(wealth_ncd_id, locker_application_id)`**
  (or drop the unique entirely). One NCD → many locker payments becomes legal.
- Keep **A12 idempotency keyed on `(ncd_id, locker_application)`** — re-linking the
  *same* NCD to the *same* locker still returns `{already:true}`; linking to a
  *different* locker now succeeds instead of erroring.

**NCD side:** no schema change; we already enforce the outstanding cap. We've
shipped an interim friendly message, but the real fix is this constraint.

---

## 2. Full locker list per branch, with status (`GET /lockers-all`)

**Why:** NCD wants to show staff every locker number in the branch/size and
**grey out the occupied ones** during enrollment. Today `/lockers` returns
**vacant only**, so NCD can't render occupied (or out-of-service) numbers at all.

**Requested endpoint:**
```
GET /lockers-all?branch_id=<id>&size=<size>
→ [ { id, locker_number, status: 'vacant' | 'occupied' | 'blocked' } ]
```
Read live (uncached), same as `/locker-availability`. NCD keeps allocating by the
opaque `id`; `status` drives the disabled state. This avoids NCD stitching
`/lockers` (vacant) + `/locker-tenants` (occupied), which would miss
maintenance/blocked lockers and can race mid-enrollment.

---

## 3. Locker-agreement e-sign OTP over **SMS / mobile**, not email

The locker agreement e-sign runs on **your** Digio configuration (contract **A19**);
NCD only proxies status. Owner wants the e-sign OTP/link delivered to the
customer's **registered mobile**, not their email. Please set your Digio signer
config to phone-first (SMS) for the locker agreement. (NCD's own subscription
e-sign is already SMS-first; this is only the locker agreement, which is yours.)

---

## 4. Per-leg payment status + reference for the app, and auto-initiate e-sign

For the in-app payment flow (customer pays locker deposit/rent inside the
DhanamFin app), NCD and the app need, per locker application:
- **Per-leg status** — `deposit: pending|paid`, `rent: pending|paid` — and the
  **payment reference** (UTR / intent no.) once paid. If A8's `payments[]` already
  carries this per leg, just confirm the fields; if not, please expose them.
- **Auto-initiate the locker e-sign (A19) on final settlement** — once both legs
  are settled, start the agreement e-sign without a manual step, then allocate
  (A11) on e-sign completion.

NCD will **reflect** this status/reference on its staff screens (locker profile,
tenants) by reading it from you — we don't store it.

---

## 5. Confirm the new (lower) deposit amounts are live in pricing

Owner mentioned the locker **deposit amount changed**. Pricing is yours (the
enrollment screen says so). Please confirm the updated deposit amounts are live in
`/locker-availability` / the application legs, so NCD and the app show the right
figures.

## 6. **[pricing ownership change]** Accept NCD-supplied deposit/rent on create

Owner decision (2026-08-07): **NCD now owns locker pricing** — deposit + rent per
size are configured in NCD (Masters → Locker pricing) and NCD sends them on
**A7 create-locker-application** as `deposit_amount` and `annual_rent`.

Please have A7 **honour these when present** (fall back to your own figures when
omitted), so the amount on the locker legs is the one NCD configured. Until this
ships, NCD sends the fields but they're ignored — the figures diverge, which is
the gap this closes.

---

### Summary

| # | Ask | Type | Blocks |
|---|---|---|---|
| 1 | Rescope `UNIQUE(wealth_ncd_id)` | schema | live prod error; multi-locker NCD backing |
| 2 | `GET /lockers-all` with status | new endpoint | NCD item 1 (grey out occupied) |
| 3 | Locker e-sign OTP via SMS | Digio config | NCD item 2 step 7 |
| 4 | Per-leg status+ref; auto e-sign | API + flow | NCD item 2 steps 3–6 |
| 5 | Confirm new deposit amounts | pricing | correct figures everywhere |
