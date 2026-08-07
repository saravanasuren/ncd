# DhanamFin app — locker payment & e-sign flow (requirements)

From: Dhanam NCD team · Date: 2026-08-07

Goal: a customer pays their locker **deposit** and **rent** inside the DhanamFin
mobile app, and the locker gets created + allocated after e-sign — with the
payment status reflected in NCD's staff screens too.

## Who owns what (read first)

- **LockerHub** owns the lockers, pricing, the payment collection (Easebuzz), and
  the locker-agreement e-sign. It is the **source of truth for payment**.
- **DhanamFin app** shows the customer their locker and launches payment.
- **NCD** does **not** collect money and has **no customer-app surface**. NCD's
  job is to **reflect** locker payment status/reference on staff screens.

**Recommended architecture:** the app reads locker status and launches payment
**directly against LockerHub** (as it already does for holdings). NCD mirrors the
result for staff. If instead you want the app to go *through* NCD, tell us and
we'll expose the endpoints — but direct-to-LockerHub is simpler and is the
default assumption below.

## The flow (owner's 8 steps → who does what)

| # | Step | Owner |
|---|---|---|
| 1 | Customer logs into DhanamFin with registered mobile | App (exists) |
| 2 | Under **Lockers**, sees their selected locker | App UI; locker data from LockerHub |
| 3 | Status shows **Deposit Payment Pending** / **Rent Payment Pending** | LockerHub exposes per-leg status; App renders |
| 4 | Customer pays the pending leg in-app | App launches LockerHub's Easebuzz payment link (contract A9) |
| 5 | On success: status updates in app **and** the reference (UTR) is captured | LockerHub confirms; App shows paid + ref |
| 5b | Same status/reference reflected in the NCD locker application | **NCD** reads it from LockerHub and shows it to staff |
| 6 | Once the required payment is confirmed, e-sign **auto-initiates** | LockerHub (A19) on final settlement |
| 7 | e-sign OTP goes to the **registered mobile**, not email | LockerHub Digio config |
| 8 | On e-sign complete → locker **created & allocated** to the customer | LockerHub (allocate A11 / their e-sign webhook) |

## What the app team needs to build

1. A **Lockers** section listing the customer's locker(s) with per-leg status
   (Deposit Pending / Rent Pending / Paid), read from LockerHub.
2. A **Pay** action per pending leg that launches LockerHub's payment link
   (Easebuzz) and, on return, refreshes status + shows the reference.
3. After payment, surface the **e-sign** step (LockerHub returns the signing URL;
   the OTP arrives by SMS) and the final "locker allocated" state.

## What NCD will build (our side)

- **Reflect** the per-leg payment status + reference on staff screens (the new
  Locker Profile page and Locker Tenants), read live from LockerHub. Staff will
  see "Deposit paid · UTR … · 2026-08-…" without leaving NCD.
- No payment handling, no customer screens — those are app + LockerHub.

## Dependencies on LockerHub (tracked in `LOCKERHUB-CR-LOCKER-PAYMENTS.md`)

- Per-leg status + reference exposed for the app (CR #4).
- Auto-initiate e-sign on final settlement (CR #4).
- e-sign OTP over SMS (CR #3).
- New deposit amounts live (CR #5).

## Open question for the app team

**Does the app call LockerHub directly for locker status/payment, or through
NCD?** Default assumption: **direct to LockerHub**. If you need it via NCD, we'll
add the endpoints — please confirm.
