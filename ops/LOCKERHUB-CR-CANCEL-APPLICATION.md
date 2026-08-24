# CR — cancel a locker application (A22)

**Raised:** 2026-08-22 · **From:** Dhanam NCD · **Priority:** blocking a live staff workflow

## The problem, from the branch

A staff member starts a locker enrolment, gets it wrong — wrong size, wrong
customer, a waiver applied that shouldn't have been — and wants to start again.

They press **Delete** in NCD. Nothing happens on your side, because **A1–A21
contains no cancel or delete for a locker application**. The best NCD can do is
hide the row locally. The staff member then re-looks-up the same customer, and
the old application comes straight back — same number, same `esign_pending`
status, same waiver — because NCD reads customer state from you.

Owner, 2026-08-22:

> "if i delete in here it should get deleted so that while i make a new
> enrollement the old traces doesnt affect in there"

Today the only way out is to leave an abandoned application sitting in your
system forever, or to ask you to clear it by hand — which does not scale.

## What we are asking for

```
POST /locker-applications/{id}/cancel

{ "reason": "Wrong locker size — re-enrolling",
  "staff": { "id": "...", "name": "..." } }
```

**Behaviour we need**

- Moves the application to **`cancelled`**. It stops being the customer's
  "current" application, so `GET /customers/:phone` no longer surfaces it as
  live and a fresh `POST /locker-applications` (A7) for that customer starts
  clean.
- **Releases any locker held** for it, back to vacant.
- **Idempotent** — cancelling an already-cancelled application returns
  `{ already: true }`, not an error. NCD retries.
- Response: `{ success, status, locker_released }`.

**Refuse it, with a clear code, when:**

| Situation | Why |
|---|---|
| any leg **settled by payment** | money has been collected — that is a refund, not a cancel |
| already `approved` (a live tenancy) | out of scope; that is a closure/surrender |

A **waived** leg should NOT block cancellation — nothing was collected, and an
abandoned application with a waiver on it is exactly the case that prompted this.

## Why not just hide it on our side

We could filter cancelled applications out of NCD's own screens, and we may do
that as a stopgap. But your copy would still hold the application and the locker
it points at, so:

- a second application for the same customer risks a duplicate or a conflict on
  your side;
- the locker stays unavailable to anyone else;
- your tenant roster and ours drift apart, which is the thing the whole
  integration exists to prevent.

The record has to be cancelled where it lives.

## Volume

Low — this is exception handling, not a hot path. A handful a week at most.

## Contact

tech@dhanam.finance
