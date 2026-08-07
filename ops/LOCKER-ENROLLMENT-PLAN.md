# Locker Enrollment & Payment — Cross-System Plan

Status: **planning** (no code yet). Owner decisions captured 2026-08-07.

This plan covers the four locker requirements plus the live `payments.wealth_ncd_id`
error. The central fact: **the locker flow spans three systems**, and NCD owns
less of it than the screens suggest. Read §0 first — it decides who can do what.

---

## 0. System boundaries (who owns what)

| Concern | Owner | Notes |
|---|---|---|
| Locker inventory, numbers, sizes, **occupied/vacant** | **LockerHub** | NCD holds no lockers table; it proxies `/api/lockers/*` and caches nothing. `/lockers` returns **vacant only**. |
| Locker **pricing** (rent, deposit amounts) | **LockerHub** | The enrollment page says so: "Pricing is handled by LockerHub." A deposit-amount change is a LockerHub change. |
| Payment **collection** (online) | **LockerHub** (Easebuzz) | Contract A9 `payment-link` returns an Easebuzz checkout URL. NCD never collects money. |
| Offline settlement (cheque/cash/transfer) | **LockerHub** | Contract A18 `settle-offline`. NCD records cheques locally, then pushes A18. |
| NCD-backed deposit (pledge an NCD) | **shared** | NCD tracks `locker_deposit_links`; LockerHub records the payment (A12 `link-ncd`). |
| Locker **agreement e-sign** + its OTP channel | **LockerHub** (their Digio config) | Contract A19. NCD only proxies status; the SMS-vs-email choice is LockerHub's. |
| DhanamFin **customer** app | **mobile team + LockerHub** | NCD has **no customer-app surface**. `/api/my` is the *agent* app only (profile/customers/earnings). |
| Cheque register, waivers, pledges, tenant links | **NCD** | `locker_cheques`, `locker_fee_waivers`, `locker_deposit_waivers`, `locker_deposit_links`, `locker_tenant_overrides`. |
| Approvals / maker-checker engine | **NCD** | Extensible; adding a cheque-clearance type is well-templated. |

**Consequence:** items 3 and 4 are NCD-only and shippable now; the wealth_ncd_id
fix is mostly LockerHub; item 2 is mostly LockerHub + the mobile team; item 1
needs a small LockerHub addition.

---

## 1. Live bug — `UNIQUE constraint failed: payments.wealth_ncd_id`

### Diagnosis
`wealth_ncd_id` does not exist anywhere in NCD. It is **LockerHub's** column
(SQLite) for the NCD application number NCD sends as `ncd_id` when an NCD backs a
locker deposit (contract **A12 `link-ncd`**, `api/src/modules/lockers/deposits.ts:183`).
LockerHub's `payments` table has a **UNIQUE index on `wealth_ncd_id`**, so a given
NCD application number can attach to **only one** locker-deposit payment row.

### Why it fires
Owner decision (2026-08-07): **one NCD investment may back several locker
deposits** (if a customer pays more than one locker's deposit, the excess can fund
another locker — staff/customer's call). NCD already models this: `locker_deposit_links`
allows the same `application_id` to link to multiple lockers, capped only by the
investment's outstanding amount (`deposits.ts:8-15`). So the second locker's
`link-ncd` call sends the **same** `ncd_id`, and LockerHub's UNIQUE index rejects it.

The contract claims A12 is "idempotent on the same ncd_id → {already:true}"
(`LOCKERHUB-INTEGRATION-CONTRACT.md`), but that idempotency is scoped per *locker
application* on their side, while the UNIQUE index is *global* — so the same NCD
linked to a **different** locker collides instead of returning `{already:true}`.

### Fix — **LockerHub change required** (NCD cannot fix alone)
LockerHub must stop treating `wealth_ncd_id` as globally unique:
- **Recommended:** replace `UNIQUE(wealth_ncd_id)` with `UNIQUE(wealth_ncd_id,
  locker_application_id)` (or drop the unique entirely). One NCD → many locker
  payments becomes legal; re-linking the *same* NCD to the *same* locker stays
  idempotent.
- Confirm A12's `{already:true}` idempotency is keyed on `(ncd_id, locker
  application)`, not `ncd_id` alone.

**NCD's part:** none schema-wise — NCD already enforces "sum of active links ≤
investment outstanding" (`deposits.ts`). Two small NCD improvements:
1. **Interim, ship now:** catch this specific upstream error in `linkDeposit` and
   surface a plain message ("LockerHub currently allows an NCD to back only one
   locker; a fix is pending") instead of the raw SQLite string on the page.
2. After LockerHub ships the fix, add a test that links one NCD to two lockers.

> ✗ Rejected workaround: sending a synthetic per-link `ncd_id` (e.g.
> `APP-…#2`). It would dodge the UNIQUE but break LockerHub↔NCD reconciliation,
> which matches on the real application number. Fix the constraint instead.

---

## 2. Item 1 — locker-number dropdown: grey out occupied lockers

### Reality
NCD only receives the **vacant** list (`GET /api/lockers/lockers` → LockerHub
`/lockers`, vacant only). It cannot render "all numbers with occupied greyed"
because it never sees the occupied (or out-of-service) numbers. Occupancy is a
race — the picked number is only a *preference*; real assignment happens at
allocation (A11), and LockerHub is the sole source of truth.

### Recommendation (my suggested best solution)
**Ask LockerHub for one endpoint** that returns *every* locker for a branch (+size)
with its status — e.g. `GET /lockers-all?branch_id=&size=` → `[{ id, locker_number,
status: 'vacant' | 'occupied' | 'blocked' }]`. Then NCD renders the full list,
disables non-vacant options, and still allocates by `id`.

Why this over NCD merging two lists itself:
- **Completeness:** merging `/lockers` (vacant) + `/locker-tenants` (occupied)
  misses lockers that are *neither* — under maintenance, blocked, damaged. A real
  "which numbers exist and what's their state" view needs LockerHub's own list.
- **One source of truth, no races:** vacancy changes constantly; a single
  authoritative call (read live, uncached — as `/locker-availability` already is)
  avoids NCD stitching two snapshots that can disagree mid-enrollment.
- **Small, clean LockerHub change** vs. NCD carrying merge logic that's
  structurally incomplete.

**Interim fallback if LockerHub can't add it soon:** NCD merges vacant + occupied
rosters and greys the occupied, clearly labelled "availability may exclude
out-of-service lockers." Ship the LockerHub endpoint when ready and drop the merge.

**Effort:** NCD ~0.5 day once the endpoint exists. LockerHub: one read endpoint.

---

## 3. Item 2 — pay deposit/rent in the DhanamFin app, then auto e-sign

This is the **most cross-system** requirement. Mapping each step to its owner:

| # | Step | Owner |
|---|---|---|
| 1 | Customer logs into DhanamFin app with registered mobile | **Mobile app** (auth already exists) |
| 2 | Under "Lockers", sees the selected locker | **Mobile app** UI; data from **LockerHub** (it owns the locker + the app's locker reads today, contract Part-B/B5) |
| 3 | Status shows "Deposit Payment Pending" / "Rent Payment Pending" | **LockerHub** exposes per-leg status; **app** renders. NCD can mirror for staff. |
| 4 | Customer pays in-app | **LockerHub** (Easebuzz payment link A9) inside the app webview/SDK; **app** launches it |
| 5 | On success: status updates in app **and** in the NCD/locker application, with reference number | **LockerHub** is the payment truth; **NCD** reflects status/reference for staff (see below) |
| 6 | Once paid, e-sign auto-initiates | **LockerHub** (A19) — settlement should trigger their e-sign |
| 7 | e-sign OTP to **mobile**, not email | **LockerHub** Digio config (channel is theirs; see §e-sign) |
| 8 | On e-sign complete, locker marked created & allocated | **LockerHub** (A11 allocate / their e-sign webhook) |

### NCD's realistic role in item 2
NCD is **not** the payment rail and has **no customer-app surface**. NCD's
contributions are:
- **Reflect payment status/reference for staff.** When LockerHub settles a leg,
  NCD's screens (enrollment, tenants, the new locker profile in §4) should show
  "deposit paid · ref … · date …". NCD reads this live from LockerHub's
  application `payments[]` (contract A8). Minor NCD work; no new store.
- **Optionally, staff-side status endpoints** if the app wants to read locker
  status *through* NCD rather than LockerHub directly — only if the mobile team
  asks. Default: the app reads LockerHub directly (as B5 holdings already does).

### e-sign OTP to mobile (step 7)
Two distinct e-sign flows exist; don't conflate them:
- **NCD subscription** agreement e-sign (Digio *direct* from NCD) is already
  **phone-first** — link goes by SMS (`api/src/integrations/digio/index.ts:66-78`).
- **Locker** agreement e-sign is **LockerHub's** (A19, their Digio config). NCD
  only proxies status. "OTP to mobile not email" for the *locker* agreement is a
  **LockerHub Digio configuration change**, not NCD code.

### Blockers / asks for item 2
1. **Mobile team:** does the DhanamFin customer app read locker status + launch
   payment against **LockerHub directly**, or should it go **through NCD**? (I
   recommend direct-to-LockerHub for payments; NCD mirrors for staff.)
2. **LockerHub:** expose per-leg pending/paid status + reference for the app;
   trigger e-sign automatically on final settlement; set the locker-agreement
   Digio channel to **SMS/mobile**.
3. **LockerHub:** confirm the new (lower) deposit amounts are live in pricing.

Until 1–3 are settled, NCD can only build the **staff-side status reflection**.

---

## 4. Item 3 — complete locker profile from Locker Tenants  *(NCD-buildable)*

### Today
Clicking a tenant's name opens the **generic customer page**, not a locker view.
No locker-profile page exists (`web/src/pages/LockerTenants.tsx:292-295`). Locker
data is scattered across enrollment, tenants, and the customer `LockersCard`.

### Plan
1. **Backend — one aggregation endpoint per locker/tenancy**, e.g.
   `GET /api/lockers/profile?application_id=…` (or `?tenant_id=…`), returning a
   single object that unions:
   - **LockerHub-live** (A5 customer / A8 application / A16 agreement / A19 e-sign):
     branch, locker number, size, account status, allotment date, lease
     start/expiry, rent & deposit amounts, **payments[]** (intent, purpose,
     amount, status, method, reference, date), agreement/e-sign status + signed PDF.
   - **NCD tables:** NCD backing (`locker_deposit_links` — pledged amount, linked
     NCD app), cheque details + clearance status + settlement (`locker_cheques`
     incl. `lockerhub_settled_at`), waivers (`locker_fee_waivers` +
     `locker_deposit_waivers` — amount/%, reason, status), any payment links,
     allocation, tenant-override link.
2. **Frontend — a Locker Profile page/route** (`/app/lockers/:applicationId`)
   rendering the full history as one source of truth (all fields the spec lists).
3. **Wire Locker Tenants** so the name (or a "View locker" action) opens the
   profile; keep the existing customer link too.
4. Reuse this aggregation to enrich the customer `LockersCard`.

**Boundary note:** most of the *history* (payment references, agreement) is
LockerHub-live; NCD fetches it on demand via existing proxies. NCD persists none
of it beyond what it already stores. If LockerHub's A8 `payments[]` lacks a field
the spec wants (e.g. per-payment method for older rows), that's a LockerHub ask.

**Effort:** NCD ~2–3 days. No LockerHub change for the common case.

---

## 5. Item 4 — move cheque clearance into Approvals  *(NCD-buildable)*

### Today
"Funds cleared" on the enrollment page is a **direct** permission-gated action
(`applications:confirm-collection`) that flips `locker_cheques.status` to `Cleared`
and best-effort pushes A18 settle to LockerHub. It is **not** an approval flow, and
it lives *inside* Locker Enrollment.

### Plan (template: `locker_fee_waiver`, the existing approval-backed locker flow)
1. **New approval type** `locker_cheque_clearance` in
   `api/src/modules/approvals/config.ts` + label in `web/src/labels.ts`. Checker
   permission: **`approvals:check-premature`** (Admin/CXO — matches the other
   locker money controls). Confirm with owner.
2. **Migration:** widen the `locker_cheques.status` CHECK to add an intermediate
   `PendingClearanceApproval` (and optionally `ClearanceRejected`).
3. **"Funds cleared" becomes a maker action:** instead of clearing immediately, it
   sets the cheque to `PendingClearanceApproval` and raises an approval request
   (`createApprovalRequest`), storing `approval_request_id` on the cheque row.
4. **`registerOnFinalApprove('locker_cheque_clearance', …)`** runs today's clear
   logic: set `Cleared` + `cleared_on` + approver, then settle to LockerHub via the
   **existing post-commit / retry path** (keep the HTTP call out of the approval
   transaction, per `cheques.ts:181-183`). `registerOnReject` → back to `Pending`
   or `Bounced`.
5. **`describeRequest`** gets a `locker_cheques` branch so the generic Approvals UI
   renders it (customer, locker app, leg, amount, cheque no, bank) with no React
   per-type work.
6. **Locker Enrollment:** remove the "Cheques awaiting clearance" section (or make
   it read-only, "pending in Approvals"). Cheque *recording* stays on enrollment;
   *clearance/bounce* moves to Approvals. Retry-settlement stays where owners can act.

**Effort:** NCD ~2 days. No LockerHub change.

**Design tension to honour:** existing approval handlers call LockerHub *inside*
the approval tx (fee waivers), but cheques deliberately settle *after* commit.
Keep the LockerHub settle in the post-commit/retry path, not the callback.

---

## 6. Sequencing & ownership

| Item | Owner(s) | NCD effort | Blocked by |
|---|---|---|---|
| **wealth_ncd_id** interim message | NCD | ~0.25 d | — |
| **wealth_ncd_id** real fix | **LockerHub** | test only | LockerHub drops/rescopes UNIQUE |
| **Item 4** cheque → Approvals | NCD | ~2 d | owner: checker permission |
| **Item 3** locker profile | NCD | ~2–3 d | — (LockerHub only if A8 lacks a field) |
| **Item 1** occupied greyed | LockerHub + NCD | ~0.5 d | LockerHub `lockers-all` endpoint (recommended) |
| **Item 2** app payment + auto e-sign | **Mobile + LockerHub** + NCD reflect | ~1–2 d NCD | mobile/LockerHub decisions (§3) |

**Suggested order when we start building:** (1) wealth_ncd_id interim message +
LockerHub CR, (2) item 4, (3) item 3, (4) item 1 once LockerHub adds the endpoint,
(5) item 2 NCD reflection once mobile/LockerHub scope is agreed.

---

## 7. Decisions still needed

- **LockerHub:** rescope/drop `UNIQUE(wealth_ncd_id)` → `(wealth_ncd_id,
  locker_application_id)`; confirm A12 idempotency key. (§1)
- **LockerHub:** add `lockers-all` (full per-branch list with status). (§2)
- **LockerHub:** per-leg pending/paid status + reference for the app; auto e-sign
  on settlement; **locker-agreement e-sign OTP over SMS/mobile**; confirm new
  deposit amounts live. (§3)
- **Mobile team:** does the customer app hit LockerHub directly for locker
  status/payment, or through NCD? (§3)
- **Owner (NCD):** checker permission for `locker_cheque_clearance`
  (recommend `approvals:check-premature`). (§5)
