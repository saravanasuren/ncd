# Locker subsystem audit — 2026-09-15

Full read of the locker flow: 18 API modules, 69 routes, 28 migrations, 7 screens,
55 test files. Four parallel passes — money correctness, the
enrolment→allotment→agreement lifecycle, NCD↔LockerHub consistency, and
permissions/scoping/PII — then every finding below was re-checked against the
code before being written down.

**Baseline:** the locker suite is green (440 tests). The two files that fail on a
full run are `beforeAll` hook timeouts from running 250 test files at once, not
assertions.

Three fixes are already raised. Everything else is listed here with evidence so
it can be triaged rather than rediscovered.

---

## Fixed — PRs raised

| PR | Finding | Severity |
|---|---|---|
| #436 | A refused NCD deposit pledge was recorded nowhere and could not be retried | **Critical** |
| #437 | Authorised-user full Aadhaar stored/shown/printed + IDOR on all four by-id routes | **High** |
| #438 | Reconciliation `report_date` interpolated into SQL run through the sqlite3 CLI | **High** |

### #436 in one line
`linkDeposit` pledges the investment locally — which immediately blocks that money
from redemption — then tells LockerHub (§A12). If that call failed, the reason
went to the HTTP response and a `console.warn` and nowhere else: the money stayed
frozen for good, the locker never allotted, nothing knew, and `033`'s unique index
made re-linking impossible. The deposit leg was the only money path without the
"recorded, surfaced, retryable" treatment cheques (`052`) and waivers (`053`) have.

---

## Open — money

**M1. A settled leg can be collected twice.** `HIGH`
`offlinePayments.ts:132-135` and `cheques.ts:101-104` guard only the *open* state
(`PendingApproval` / `Pending`). Once a leg is settled, a second payment on the
same leg passes the guard, gets approved, and is stamped settled — LockerHub
answers `{already:true}` so nothing upstream complains. Two real receipts, one
leg, no refund record. The enrolment screen shows only the first
(`LockerEnrollment.tsx:1233` uses `.find`). Nothing guards *across* the tables
either: a cleared cheque does not block an offline payment for the same leg.
Tests pin only the "second **pending**" case.

**M2. An approved waiver LockerHub refused still reads as "waived".** `HIGH`
`feeWaivers.ts:132-136` swallows the refusal into `lockerhub_error` and leaves
`status='Approved'`. Both readers filter on status alone — `report.ts:22-24` and
`deposits.ts:678-679` — so the rent report prints WAIVED and the tenant roster
shows waived/premium while the customer still owes the rent and the locker will
not allot.

**M3. No chase list for approved-but-unsettled money.** `HIGH`
`reports/outstanding.ts:96-97` covers cheques only.
`locker_offline_payments` (`Approved` + `lockerhub_settled_at IS NULL`) and
`locker_fee_waivers` (`Approved` + `lockerhub_applied_at IS NULL`) appear on no
report and no cron — the index `idx_locker_fee_waiver_unapplied` was built for
exactly this and is queried by nobody. The only surface is a Retry link on one
application's screen. (#436 adds the deposit-leg equivalent; these two remain.)

**M4. Removing an application never releases its pledges.** `HIGH`
`removeLockerApplication` (`tenantOverrides.ts:212-240`) writes an override row
and an audit entry, and touches nothing else. The `locker_deposit_links` row stays
`active`, so the customer's money stays frozen from redemption against a locker
that no longer exists — and the row is now hidden from every screen that would
have surfaced it.

**M5. The standard rent-waiver amount is computed from request-body figures.**
`MED-HIGH` `routes.ts:1115-1126` takes `{gst_pct, annual_rent}` from the body and
writes a real `waiver_amount`; the route is checker-free by design
(`feeWaivers.ts:196-209`). The browser sends LockerHub's own quote, so the happy
path is right, but nothing server-side validates it. Deriving both from the
application's own `legs.rent` would close it.

**M6. `POST /settle-offline` leaves no NCD record at all.** `MED-HIGH`
`routes.ts:1269-1279` forwards cash/transfer to LockerHub with no row and no
audit entry. Cash taken at a branch leaves zero trace on our side, and
`assertNotAReusedApplication` — which counts `locker_offline_payments` — then
judges the application untouched. A test currently pins this as intended.

**M7. The reuse guard ignores cheques and pledges.** `MED-HIGH`
`applications.ts:141-149` counts allotments, rent waivers and offline payments.
A ₹14,160 rent cheque or a ₹3L pledge sitting on an application is exactly the
"something has happened on it" the guard exists to catch. Two lines.

**M8. `linkDeposit` capacity checks race.** `MED`
`deposits.ts:102-107` reads outstanding/linked/cap outside the transaction; the
in-tx recheck covers only the exact duplicate. Two concurrent links can pledge
₹6L against a ₹3L deposit, or push `SUM(active) > outstanding` — after which
`depositSummary` clamps at 0 and the customer can redeem nothing, permanently.
`FOR UPDATE` on the parent application closes it.

**M9. Smaller.** `locker_offline_payments` has no unique index behind its guard
(`077`) while cheques and waivers do. `releaseLink` can double-release (no
`FOR UPDATE`) — audit noise, no money lost. Releasing never un-settles
LockerHub's leg, so the two sides can disagree in both directions. The rent
report truncates at `LIMIT 500` with no marker, and during a LockerHub outage
reports every non-waived locker as `unpaid` — with no error banner in the Excel.

---

## Open — lifecycle

**L1. `AwaitingCEO` is a trap.** `HIGH`
Set at `agreements.ts:654-657`; the queue lists `CustomerSigned` only
(`:136`) and `initiateCeoEsign` refuses anything that is not `CustomerSigned`
(`:617-620`). If the CEO loses the link or Digio expires it (7-day poll window),
the agreement is unreachable — the only escape is deleting it, which discards
every hirer signature already collected. `signingLabel` has no case for it
either, so a fully hirer-signed agreement displays as "e-Sign started".

**L2. Hirers stay mutable while signing links are live.** `HIGH`
`hirers.ts:170-179` gates on `ds.status = 'signed'`, so the window between "link
sent" and "signed" is fully open. Add a hirer after hirer 1's link goes out and
hirer 1 signs the *old* PDF while the next stage re-renders a different one —
signatures land against the wrong pagination, which `hirers.ts:18-22` names as
the worst failure. Remove one and the chain can complete with an unsigned block.

**L3. LockerHub's status can flip a mid-chain agreement to `Signed`.** `HIGH`
`agreements.ts:259-285` excludes only `method !== 'esign'`. An NCD-chain row *is*
`esign`, so a LockerHub `signed` marks it fully Signed while hirers 2/3 and the
CEO have signed nothing — and it runs on a **read** (`GET .../esign`), which the
enrolment page fires on load.

**L4. No watermark check at the CEO hop.** `HIGH`
`digio/service.ts:139-151` advances `status` even when the signed-file download
failed (`signedPath` null). Migration 092's watermark protects hirer→hirer but
the CEO stage only checks the file exists (`agreements.ts:621-622`), so the
archived "fully signed" agreement can be missing the last hirer — or the CEO.

**L5. Removal cleans up nothing, and no write path honours it.** `HIGH`
Signings stay live (a removed application can still be countersigned from the CEO
queue), Digio sessions keep polling, approvals stay Pending, and every side table
is untouched. The applications list still offers **Resume**
(`LockerApplications.tsx:236-240` guards only Delete), and for a `force_local`
removal the whole enrolment page still works.

**L6. Others.** A non-contiguous hirer position (2 or 3 with a gap) permanently
blocks the chain — API-reachable, the web form renumbers. No agreement route
checks allotment, so a binding agreement can be signed with no locker number or
lease term. The documented hirer-KYC gate is enforced nowhere. `getSignedDocument`
is not scoped to the live signing row, so a cancelled attempt's file can be
served. Cancelling a signing leaves its Digio links live, which can resurrect a
cancelled row and abort the poll batch. Migration `087`'s "still let on
LockerHub" truth is honoured on one screen and ignored by the roster and
renewals. Restore erases that truth at a weaker permission than removal.

---

## Open — NCD ↔ LockerHub

**I1. A revoked authorised user is never revoked upstream.** `HIGH`
`authorisedUsers.ts:231-238` updates NCD only, and the client exposes no revoke
(`client.ts:357-363` is an upsert). NCD shows revoked; LockerHub still lists them
as able to open the locker. Needs a LockerHub endpoint — **CR material** — plus a
truth column and an on-screen warning here, the same shape `087` gave removals.
(#437 stops the *enumeration*; it cannot make the revoke travel.)

**I2. Nothing chases a failed push.** `MED-HIGH` See M3. Note the asymmetry: the
two *event* channels (`dispatcher.ts`, `customerEvents.ts`) have durable queues
with backoff, attempts and an `abandoned` state. The *money* legs have none.

**I3. LockerHub mutations run inside the approval transaction.** `MED-HIGH`
`approvals/service.ts:282-283` calls the hook inside `db.withTx`, and
`cheques.ts:201-228`, `feeWaivers.ts:288-310`, `offlinePayments.ts:181-200` each
settle upstream from in there. If a later statement fails, Postgres rolls back a
settlement that **actually landed**: the cheque reads Pending, no error is
recorded, and `retrySettlement` refuses it. The one half-state with no breadcrumb.
It also holds row locks across a 12s network call.

**I4. NCD's own B19a blocks the CR it is waiting for.** `MED`
`integration/writes.ts:1254-1256` 409s a second locker deposit on the same NCD,
because it stores the pledge on the scalar `applications.lockerhub_intent_no` —
while `deposits.ts` models one-NCD-many-lockers and
`LOCKERHUB-CR-LOCKER-PAYMENTS.md` asks LockerHub to allow exactly that. The day
they ship CR#1, this side still refuses it.

**I5. e-Sign initiate is not idempotent.** `MED` `routes.ts:859-868` has no
"already sent" guard, so a double click or a retry after the 12s timeout creates
two Digio documents and two customer SMS/emails, and `recordEsignSent` overwrites
the reference — orphaning the first signed document.

**I6. Reconciliation covers none of the locker legs.** `MED-HIGH`
`reconciliation.ts:58-83` matches LockerHub `payment_intents` against NCD
subscription applications only, with **no `purpose` filter** — so every locker
rent/deposit payment finds no match and is reported as an orphan. The headline
number is structurally wrong and a genuine orphan is buried in the noise. The
date windows also compare `settled_at`/`updated_at` against NCD `created_at`, and
`lh_error` is reported in the body rather than alerted, so a broken job reads as
"all clear".

**I7. Contract drift.** `MED` A22 (authorised users) and A23 (cancel) are called
in code but absent from `LOCKERHUB-INTEGRATION-CONTRACT.md`, and the CR doc
numbers cancel as A22 while the client calls it A23. A7's documented
`duplicate: true` is never read — NCD reinvented it as a DB heuristic after a
real incident. `allocate`'s `already:true` is undocumented. Open CRs #1, #2 and
#6 are all still outstanding in code.

---

## Open — permissions / scoping

**P1. Branch-scope holes on the reads.** `MED-HIGH`
`branchScope.ts` is applied to `/inventory`, `/tenants`, `/renewals`, `/visits`
and the applications list. It is **not** applied to `/rent-report` +
`/rent-report.xlsx` (network-wide, and no `reports:download` gate — branch staff
get a company-wide XLSX of the whole locker book), `/cheques` (500 rows of the
register), `/agreements/awaiting-ceo`, or `/profile`. The first three hand out
application ids; `/profile` then returns full detail for any of them, so the
scoping on `/tenants` is bypassed by going one level down.

**P2. Any enroller can push the CEO to counter-sign.** `MED`
`routes.ts:917` → `initiateCeoEsign` checks the *document* state, never the
actor's role, and `LockerAgreements.tsx:24` shows the button to anyone who can
open the page. Every comparable "the company binds itself" action sits with
Admin/CXO.

**P3. `lockers:allot-override` is enforced nowhere.** `MED` — documentation, not
capability. The owner deliberately opened allotment up on 2026-08-22 and a test
pins it. But the permission still exists, is still granted to CXO, and
`client.ts:435` tells the reader `routes.ts` gates it — which it does not.
LockerHub was told the control is ours (contract A20). Either re-gate or delete
the permission and the grant so the matrix stops asserting a control that is not
there.

**P4. Aadhaar posture elsewhere is correct.** Hirers (`091`), the agreement PDF
and the applicant block all handle Aadhaar properly. Authorised users were the
exception — fixed in #437.

---

## Verified NOT defects

Worth recording, because they look wrong and are not:

- **`/deposit-links/candidates` and `/customers/by-pan` are unscoped on purpose.**
  I wrote the scoping fix and the existing tests refused it: `locker-pan-lookup`
  pins a branch staffer resolving an admin-created customer, and pins the same
  staffer listing candidates for a customer they did not enrol. Locker work is
  done by whoever is at the counter, against the ID document in front of them.
  Scoping these would break the product. **The narrower question worth an owner
  decision is whether customer A's NCD should be pledgeable against customer B's
  locker — `linkDeposit` does not check that today.**
- **Failed pushes never roll back an internal decision** (`cheques.ts`,
  `feeWaivers.ts`, `offlinePayments.ts`). Deliberate and right; the gap is only
  that nothing chases them (M3).
- **Taking a cheque settles nothing** — only clearing does. Correct and tested.
- **Hirer signing order, double-sign refusal, the per-signer supersede (`092`),
  the mid-chain watermark, the sole-hirer nominee rule, the one-application-one-
  locker guard, and the renewals classifier** are all sound as built.
- **`branchScope` fails open by design** (no branch, no name match, or LockerHub
  down → unrestricted). That is deliberate — but it means branch scope is a
  convenience, **not a security boundary**, and nothing security-critical should
  be built on it. #437's guard uses customer scope for this reason.

---

## Themes

1. **The money legs never got the queue treatment the event channels have.** Local
   write + best-effort push, error recorded on the row, chased only if a human
   reopens that screen. #436 closes the worst instance; M3/I2 are the pattern.
2. **Guards check the open state, not the settled state** (M1, and the reuse guard
   M7). "Is one in flight?" is asked; "has this already happened?" is not.
3. **Removal is a label, not an operation** (M4, L5). One override row is written
   and eleven tables, a Digio poller and an approvals queue carry on.
4. **The multi-signer chain is well built in the middle and thin at both ends** —
   entry (L2, L6) and exit (L1, L4) are where it breaks.
5. **Several comments now describe controls that were removed** (P3, I7). Worth a
   pass on its own: a wrong comment about a security control is worse than none.

## Suggested order

1. #436, #437, #438 (raised).
2. M1 + M7 — cheap, and both are double-collection.
3. L1 + L4 — an unrecoverable agreement and a countersigned document missing a
   signatory.
4. M4 + L5 — make removal an operation.
5. I3 — move the LockerHub call out of the approval transaction.
6. I6 + M3 — make the chase lists real.
7. P1 — branch-scope the four reads.
8. I1, I4, I7 — LockerHub CRs.
9. P3 — decide, then make the code and the docs agree.
