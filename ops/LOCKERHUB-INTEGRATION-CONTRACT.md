# NCD ↔ LockerHub Integration Contract

**Version 1.1 — 2026-07-22. Owner: Prem (LockerHub) ↔ Eashwar (NCD app).**
*v1.1: audited against the NCD app codebase (`ncd.dhanamfinance.com`, repo
`~/tools/ncd`) — Part B statuses marked, the real remaining-work list added,
event channels corrected, cutover runbook aligned with `ops/CUTOVER-LOCKERHUB.md`.
v1.0 shipped with LockerHub PR #710; the offline `record-payment` route was
retired same-day by PR #709 (lockers + NCD are online-only for every caller).*

Dhanam Wealth is being retired. Its replacement — the **'NCD' app** — takes over
two roles:

1. **System of record for NCD investments** (what Wealth was): LockerHub's
   customer app shows NCD holdings, statements, and documents by calling the
   NCD app server-to-server. → **Part B** lists every endpoint, with its
   verified implementation status.
2. **Staff enrollment console**: staff working in the NCD app enroll a
   customer for a **locker** (and NCD) end-to-end. → **Part A** lists the
   APIs LockerHub now exposes for that.

Both directions authenticate with a shared secret in the **`X-Integration-Key`**
header (rotate any time by coordinating an env change on both boxes).

```
┌───────────┐  Part A: locker enrollment APIs   ┌───────────────┐
│  NCD app  │ ────────────────────────────────► │   LockerHub   │
│ (Eashwar) │ ◄──────────────────────────────── │  (this repo)  │
└───────────┘  Part B: NCD data APIs + events   └───────────────┘
```

---

## Current status (2026-07-22) — audited against the NCD app

**Already built and deployed (dormant) on the NCD side — verified in code:**

- The full inbound `/api/integration/*` façade (Part B **P0 + P1 + P2**, plus
  agent endpoints B20–B22, plus `soa.pdf` / `ledger.csv` / `select-account`
  extras and even `penny-drop`), byte-compatible with what LockerHub calls on
  Wealth today, behind `X-Integration-Key`.
- Outbound **agent-event webhooks** (HMAC-signed queue + 30s dispatch cron) —
  dormant until `LOCKERHUB_WEBHOOK_URL` + `LOCKERHUB_WEBHOOK_SECRET` are set
  in their SSM.
- A daily **reconciliation** job that reads LockerHub's SQLite read-only
  (co-tenant, same box) and emails admins about orphaned payments — dormant
  behind `LOCKERHUB_RECONCILIATION_ENABLED`.
- Their own cutover runbook: `ops/CUTOVER-LOCKERHUB.md` in the NCD repo —
  consistent with this doc (§Go-live below merges the two).

**Remaining work (the actual to-do list):**

| # | Item | Side | Notes |
|---|---|---|---|
| R1 | **Part A client + "Locker enrollment" staff screen** | NCD app | The new capability. Nothing calls `/api/integration/v1/*` yet and the staff web has no locker page. Online-only flow: A5 → (A6) → A7 → A9 per leg → poll A8 → allotted. Natural home: extend the existing customer direct-enrolment wizard. |
| R2 | **Missing agent endpoints: B23 (`/api/my/*`) + B24 (`/agents/active`, `/agents/propose`)** | NCD app | Not implemented — at cutover, LockerHub's staff agent-attribution picker ("search by name or code") and the agent app's native earnings screens break. Either build them (data already exists — incentives module + `MyEarnings` page) or jointly decide the agent screens switch to the webview-session SSO (B22, already built). |
| R3 | **Pre-cutover shape diff** | Both | Their runbook's own step: same real customer, Wealth vs NCD response diff — especially holdings `totals`, `customer_status` mapping, penny-drop failure fields. |
| R4 | *(Optional)* Business-event senders (§Events channel 2), timing-safe key compare in `integrationAuth.ts` (currently `!==`), confirm `/api/integration` rate-limit headroom for LockerHub's sync-queue drain (up to 50 rows / 5 min) + reconcile bursts | NCD app | None of these block cutover. |

**LockerHub side is DONE** — surface live since PR #710 (+ #709 online-only
hardening), env-only repoint shipped, both webhook receivers live, this doc
updated. The only LockerHub actions left are ops steps in §Go-live.

---

## Environment / cutover (LockerHub side — env-only)

| Var | Meaning |
|---|---|
| `NCD_API_URL` | Base URL of the NCD app (e.g. `https://ncd.dhanamfinance.com`). Takes precedence over the legacy `WEALTH_API_URL`. (The NCD repo's `ops/CUTOVER-LOCKERHUB.md` uses the `WEALTH_*` spelling — both work; `NCD_*` wins when both are set.) |
| `NCD_INTEGRATION_KEY` | Shared secret for BOTH directions. Precedence over `WEALTH_INTEGRATION_KEY`. |
| `NCD_APP_INTEGRATION_KEY` | Optional dedicated key for the inbound Part-A surface only (else the shared key above is accepted). |
| `NCD_INBOUND_KEY` | Optional dedicated key for the inbound business-event webhook only. |
| `LOCKERHUB_WEBHOOK_SECRET` | Verifies the NCD app's **agent-event** webhooks (HMAC — see §Events channel 1). Must equal the NCD side's SSM `/dhanam/newwealth/LOCKERHUB_WEBHOOK_SECRET`. Deliberately a separate secret from the integration key. |
| `PENNY_DROP_VIA_WEALTH` | Set `false` at cutover — LockerHub runs direct Decentro V3 penny-drop. (The NCD app implements `/penny-drop` too, so `true` also works as a fallback path.) |

Cutover = add `NCD_API_URL` + `NCD_INTEGRATION_KEY` to EC2 `.env` →
`pm2 restart lockerhub --update-env`. The `WEALTH_*` vars stay as fallbacks
during transition; remove them once the NCD app is fully live.

> Internal note: LockerHub's code keeps its `wealth*` function names
> (`wealthApi`, `wealth_sync_queue`, …) — they now point at the NCD app.
> Renaming ~100 call sites on a live money system is churn without benefit.

---

# Part A — APIs LockerHub EXPOSES to the NCD app

Base: `https://lockers.dhanamfinance.com/api/integration/v1`
Auth: header `X-Integration-Key: <shared secret>` on every call.
Every **mutating** call must carry the acting staff member:

```json
"staff": { "id": "<ncd-app user id>", "name": "Kavya R", "email": "kavya@dhanam.finance" }
```

Attribution is written to LockerHub's `audit_log` and payment rows as
`ncd_app:<id>`. Missing staff on a mutation → `400`.

**Design guarantees (rely on these):**
- **Pricing is server-side.** The NCD app never sends amounts. Quote what
  `GET /locker-availability` returns; the application stores the same figures.
- **Online-first, with a typed offline path.** Prefer online collection via
  `payment-link` (A9). The old untyped `record-payment` (A10) is **retired**
  (`400 online_only`). For a payment genuinely collected offline at the branch,
  use **A18 `settle-offline`** — it writes a correctly-typed offline receipt
  (never a fake online row), so reconciliation and refunds stay correct.
- **Allocation is payment-gated and staff-driven.** A locker is allotted only
  after **all** mandatory legs (rent+GST and deposit) are settled. Since
  2026-07-25 (LockerHub #769) settlement no longer auto-allots — a fully-paid
  application parks in **`pending_allocation`** and a staff user picks the
  locker number via **A11 `/allocate`** (see A4 for the vacant list). The
  attributed exception path (allot with money still outstanding) is **A20**.

## A1. `GET /ping`
Wiring check. → `{ "ok": true, "service": "lockerhub", "time": "…" }`

## A2. `GET /branches`
→ `{ "branches": [ { "id", "name", "address" } ] }`

## A3. `GET /locker-availability?branch_id=<id>`
Live pricing + vacancy. Omit `branch_id` for the full catalogue.

```json
{
  "branch_id": "br_xxx",
  "sizes": [
    { "size": "Medium", "annual_fee": 3000, "rent_incl_gst": 3540,
      "deposit": 25000, "gst_pct": 18, "vacant_count": 12 }
  ]
}
```
`rent_incl_gst` is the exact rent-leg amount collected. With a `branch_id`,
sizes with zero vacancy are omitted.

## A4. `GET /lockers?branch_id=<id>&size=<size>`
Vacant lockers for pick-a-locker. → `{ "lockers": [ { "id", "locker_number", "size", "status" } ] }`

## A15. `GET /locker-inventory?branch_id=<id>`  *(added 2026-07-24)*

**Full stock position** — totals, what's left, branch-wise and size-wise. Use
this for dashboards, stock reports and sales planning; use A3
`/locker-availability` when you need a **price quote for a sale**.

The difference matters: A3 is a sell-right-now view and **omits sizes with zero
vacancy**. A15 hides nothing — every branch and every canonical size is returned
including the zeroes, because "0 Extra Large left at Hosur" is exactly what a
sales screen needs to say. Branches with no lockers at all are returned as zeros
rather than dropped.

Omit `branch_id` for the whole network; supply it to scope everything (including
`totals`) to one branch. Unknown `branch_id` → `404 { "error": ... }`.

```json
{
  "as_of": "2026-07-24T09:15:00.000Z",
  "branch_id": null,
  "totals": { "total": 445, "vacant": 300, "occupied": 140, "reserved": 2,
              "other": 3, "by_status": { "vacant": 300, "occupied": 140,
              "reserved": 2, "maintenance": 3 },
              "occupancy_pct": 31.5, "branches": 4 },
  "by_size": [ { "size": "Medium", "total": 21, "vacant": 14, "occupied": 7,
                 "reserved": 0, "other": 0, "by_status": { "…": 0 } } ],
  "pricing": [ { "size": "Medium", "annual_fee": 3000, "rent_incl_gst": 3540,
                 "deposit": 25000, "gst_pct": 18 } ],
  "branches": [
    { "branch_id": "br_xxx", "branch_name": "Hosur", "address": "…",
      "total": 445, "vacant": 300, "occupied": 140, "reserved": 2, "other": 3,
      "by_status": { "…": 0 }, "occupancy_pct": 31.5,
      "by_size": [ { "size": "Extra Large", "total": 174, "vacant": 120,
                     "occupied": 54, "reserved": 0, "other": 0,
                     "by_status": { "…": 0 } } ] }
  ]
}
```

**Read `vacant` as "remaining / sellable".** `reserved` is a locker mid-allocation
— **do not add it to `vacant`** when promising stock to a customer. Any status
the table grows later lands in `other` and is itemised in `by_status`, so nothing
is ever silently dropped; `total` always equals the real row count.

`pricing` comes from the same server-side authority as A3 and as the obligation
stored by A5 `POST /locker-applications` — there is no second source of truth, so
a quote built from this response cannot disagree with what gets billed.

Counts are read live off the locker table — the same rows allocation reads — so
they cannot drift from what the customer actually gets. There is no caching; call
it as often as you need.

## A16. Signed locker agreements  *(added 2026-07-26)*

The e-signed **Locker Allotment cum Hiring Agreement** (one document — hiring
terms plus rent & deposit) is stored at Digio, keyed by the e-sign record. There
is **no second PDF store**: LockerHub's staff portal, the customer app, and this
surface all stream the same bytes from the same source. Agreements signed
before this endpoint existed are equally reachable — no migration, no re-sign.

### `GET /agreements?tenant_id=<id>` (also `phone=` or `branch_id=`)

Lists **signed** agreements only. A filter is mandatory — this is a lookup, not
a bulk export. Pending/unsigned requests are withheld entirely (they carry a
live signing URL, which must never cross this surface).

```json
{ "agreements": [ {
    "id": "es_xxx", "tenant_id": "t_xxx", "branch_id": "br_xxx",
    "document_type": "agreement", "file_name": "Allotment_Agreement_….pdf",
    "status": "signed", "sign_type": "aadhaar", "signer_name": "…",
    "tenant_name": "…", "tenant_phone": "…", "locker_number": "L10-4",
    "signed_at": "…", "pdf_available": true,
    "pdf_url": "/api/integration/v1/agreements/es_xxx/pdf"
} ] }
```

Loan agreements (`document_type='loan_agreement'`) are out of scope — this
surface serves the locker product only.

### `GET /agreements/:id/pdf?staff_id=&staff_name=&staff_role=`

Streams the signed PDF (`application/pdf`, attachment). **STAFF-only**, same
asserted-identity rule as A11 `/allocate`: `staff_id` is required, and an
agent-flavoured `staff_role` (`agent` / `lead_agent` / `rm` /
`relationship_manager`) is refused with `403 staff_only`. Every download is
written to LockerHub's audit log as `ncd_app:<staff_id>`. Unsigned or unknown
ids read as `404` — customers view their own agreement in the Dhanam app, never
over this channel.

## A13. `GET /locker-tenants?branch_id=<id>`  *(added 2026-07-23)*

Branch roster: **occupied** lockers + the tenant's contact details, for ops
chasing renewals / dues / access. (A4 `/lockers` is vacant-only — pick-a-locker
during enrolment — and will never show a tenant.)

```json
{ "tenants": [ {
    "locker_id": "...", "locker_number": "L10-1", "size": "Large",
    "branch_id": "br_rspuram", "status": "occupied",
    "tenant": { "name": "...", "phone": "...", "email": "" },
    "application_id": "...", "allotted_on": "YYYY-MM-DD",
    "lease_expires_on": "YYYY-MM-DD"
} ] }
```

Live tenancies only (`account_status` not Closed/Cancelled). `email` is `""`
where we hold none — about a third of tenants today. Capped at 1000 rows.

**⚠️ Bulk PII.** Unlike A5 (one record, and you must already know the phone),
one call returns every occupied locker's tenant **name, phone and email** for a
branch. Full contact was requested by the NCD team and approved by Prem
(2026-07-23) over the masked-minimum, because a masked number sends staff to
another system to dial. Conditions of that approval:

- The **`staff` identity must be sent** (the same `{id,name,email}` the other
  integration calls carry) — every roster read is audit-logged on our side with
  that identity (`integration_locker_roster_read`).
- The shared key can read **any** branch — branch scoping is enforced on the
  NCD side, so the NCD app must keep this behind `lockers:enroll` +
  staff-session-only (never the raw key from a browser) as they committed.

## A14. Visit Log — see + record locker visits  *(added 2026-07-28)*

The locker **Visit Log** (who accessed which locker, when, why) is now on the
integration channel, so NCD-app branch staff can view it and log a walk-in
without opening LockerHub. Two calls; both take the `X-Integration-Key` header.

### `GET /visits?branch_id=<id>&phone=<10-digit>&limit=<n>`

Lists visits, **newest first**. All query params optional:
- `branch_id` — one branch, or a comma-separated list (max 50). Omit for all.
- `phone` — 10 digits; narrows to one customer's visit history.
- `limit` — default 500, capped 5000.

```json
{ "visits": [ {
    "id": "...", "branch_id": "br_rspuram", "branch_name": "R.S. Puram",
    "tenant_id": "...", "tenant_name": "…", "tenant_phone": "******3210",
    "locker_id": "...", "locker_number": "L10-1", "locker_size": "Large",
    "datetime": "2026-07-28T10:30", "visit_time": "", "exit_time": "",
    "purpose": "Locker Access", "duration": "", "notes": "",
    "created_at": "2026-07-28 05:00:00"
} ] }
```

`tenant_phone` is **masked to last-4** (`******3210`). If NCD needs full phone
here it must be requested + Prem-approved, exactly like the A13 roster.

### `POST /visits`

Records a walk-in visit and pushes the customer the same "Visit Recorded"
notice the LockerHub staff route sends.

```json
{ "phone": "9876543210",            // OR "tenant_id": "..."
  "datetime": "2026-07-28T10:30",   // optional; defaults to "Today" in the push
  "purpose": "Locker Access",       // optional
  "duration": "", "notes": "",      // optional
  "visit_time": "", "exit_time": "",// optional
  "staff": { "id": "...", "name": "...",
             "branch_id": "br_rspuram" } }   // id+name REQUIRED; branch_id optional
```

Behaviour:
- The tenant is resolved from `phone` (most-recent **active** tenancy; Closed/
  Cancelled are skipped) — or pass an explicit `tenant_id`. `404` if no active
  locker tenant matches.
- **Branch and locker are derived from the tenancy** — you do not send them;
  a tenant has exactly one locker. (`400` if the tenant somehow has no branch.)
- `staff { id, name }` is required (`400` if missing) and every record is
  audit-logged on our side (`ncd_app_visit_recorded`) with that identity.
- Success → `{ "success": true, "id", "tenant_id", "tenant_name", "branch_id",
  "locker_id" }`.

Recording a visit is **not** a privileged action like allocation, so there is
no agent-role block here — but the write is still attributed and audited.

**Branch scoping — send `staff.branch_id` and we enforce it** *(added 2026-07-31,
Eashwar's ask).* You cannot scope this write on your side: the branch is only known
after we resolve the tenancy, and the roster masks phones. So assert the operator's
own branch and we hold the line — the tenancy branch is the authority, which makes
this a real guarantee rather than a convention your UI has to keep.

- Mismatch → `403 { "error": "This customer belongs to a different branch.",
  "code": "branch_scope", "tenant_branch_id": "…" }`, audit-logged as
  `ncd_app_visit_branch_scope_denied`.
- **Optional by design** — omit it and behaviour is exactly as before, so nothing
  breaks before you adopt it. Head-office operators should simply omit it.

If you would rather resolve the branch yourself before writing — e.g. to grey out
the control instead of failing the call — **§A5 `GET /customers/:phone` already
returns it**: `lockers[].branch_id` / `branch_name`. No new endpoint is needed;
the operator types the full phone at that point, so masking is not in the way.

## A5. `GET /customers/:phone`
10-digit phone. → `{ "found": false }` or:

```json
{
  "found": true, "phone": "9876543210",
  "profile": {
    "name": "…", "email": "…", "dob": "…", "gender": "…",
    "address_line1": "…", "address_line2": "…", "city": "…", "state": "…", "pincode": "…",
    "kyc": { "pan_verified": true, "pan_masked": "AB****4R",
             "aadhaar_verified": true, "aadhaar_last4": "1234" }
  },
  "lockers": [ { "id", "name", "branch_id", "branch_name", "locker_id", "locker_number",
                 "locker_size", "lease_start", "lease_end", "annual_rent", "deposit", "account_status" } ],
  "open_locker_applications": [ { "id", "application_no", "status", "branch_id",
                                  "locker_size", "annual_fee", "deposit", "created_at" } ]
}
```
Raw PAN/Aadhaar are **never** returned (never stored — Aadhaar Act §29).

## A6. `POST /customers`
Create/update a customer profile. Only fields present in the body are written.
KYC fields are not writable from here (KYC runs through LockerHub's Digitap
flows or the customer app).

```json
{ "phone": "9876543210", "name": "…", "email": "…", "dob": "1990-01-01",
  "address_line1": "…", "city": "…", "state": "…", "pincode": "641001",
  "staff": { "id": "u12", "name": "Kavya R" } }
```
→ `{ "success": true, "phone": "…", "created": true|false }`

## A7. `POST /locker-applications`
```json
{ "phone": "9876543210", "name": "…", "email": "…",
  "branch_id": "br_xxx", "locker_size": "Medium",
  "staff": { "id": "u12", "name": "Kavya R" } }
```
→
```json
{ "success": true, "application_id": "…", "application_no": "APP-2026-…",
  "status": "payment_pending" | "kyc_pending",
  "pricing": { "locker_size": "Medium", "annual_fee": 3000,
               "rent_incl_gst": 3540, "deposit": 25000, "gst_pct": 18 } }
```
- `kyc_pending` only means the profile isn't PAN+Aadhaar verified yet —
  payments and allotment still proceed (flag-don't-gate); the customer
  completes KYC in the Dhanamfin app.
- Idempotent: an already-open locker application for the same phone+branch is
  returned with `"duplicate": true` instead of creating a second one.
- The customer receives the standard "application received" email.

## A8. `GET /locker-applications/:id`
Full status — poll this after payments to watch the application advance.

```json
{
  "application_id": "…", "application_no": "…", "status": "payment_pending",
  "phone": "…", "name": "…", "branch_id": "…", "locker_size": "Medium",
  "legs": { "rent":    { "amount": 3540,  "settled": false },
            "deposit": { "amount": 25000, "settled": true  } },
  "payments": [ { "intent_no", "purpose", "amount", "status", "payment_method",
                  "offline_status", "settled_at", "created_at" } ],
  "allotment": null | { "tenant_id", "locker_id", "locker_number", "size",
                        "lease_start", "lease_end" }
}
```
`status` lifecycle:

```
kyc_pending / payment_pending → under_review → pending_allocation → approved (allotted)
```

**⚠️ Do NOT gate your allotment UI on `approved`.** An application only reaches
`approved` *because* a locker was allocated, so gating the allocate control on it
makes that control unreachable and a fully-paid locker can never be allotted. This
is a real bug that was built from an earlier version of this section (Eashwar,
2026-07-31) — the section previously read `under_review → approved` and omitted
`pending_allocation` entirely.

**`pending_allocation` is the state you act on.** A fully-paid application parks
there until a staff user allocates a locker; auto-allocation on payment settlement
was removed platform-wide on 2026-07-25. See **§A11** for the allocate call, the
`staff_role` requirement and the 403/400 semantics.

`allotment` stays `null` until allocation succeeds; it is populated only in
`approved`. Full status set: `submitted`, `under_review`, `kyc_pending`,
`esign_pending`, `payment_pending`, `pending_allocation`, `approved`, `rejected`.

The detail response also carries a **`kyc`** block:
```json
"kyc": {
  "pending": true,                       // still at kyc_pending
  "external": {                          // null until you assert KYC
    "verified": true, "accepted": false, // accepted = are we honouring it (flag)
    "method": "digilocker", "pan_present": true,
    "aadhaar_last4": "9012", "at": "2026-07-29T…"
  }
}
```

## A17. KYC — accept NCD's verification  *(added 2026-07-29)*

**The problem this fixes:** a locker application used to park at `kyc_pending`
with nothing in Part A to move it on, and the applicant block you sent was
stored against the application, not the customer profile — so
`GET /customers/{phone}` came back empty. Both are fixed.

**How KYC now clears.** You already send the applicant block on **A7 create**,
including `applicant.kyc = { pan, aadhaar_last4, verified }`. When
`verified: true` (and a valid PAN is present), the application **leaves
`kyc_pending` on create** and goes straight to `payment_pending`. The applicant
demographics are also written to the customer profile on create, so
`GET /customers/{phone}` is no longer empty.

- **`verified: false` (or no `applicant.kyc`) → the application PARKS at
  `kyc_pending`** and waits. This is intended — we never wave an application
  through without your verification. (You told us most of your customers sit at
  "Pending"; those will correctly keep parking until `verified: true` arrives.)
- **We record your assertion as evidence, not as our own verification.** We
  store `kyc_external` (source, method, PAN, Aadhaar-last-4, your staff, time)
  and surface it on the A8 detail. We **never** set our own DigiLocker
  `pan_verified` / `aadhaar_verified` flags from an assertion — those mean our
  own verification and stay separate.
- **Aadhaar:** last-4 only, both directions. A full 12-digit value is rejected
  (`400`, Aadhaar Act 2016 s.29).

### A17.1 — `POST /locker-applications/{id}/kyc`  (for already-stuck apps)

For applications created **before** their applicant block carried verified KYC
(e.g. the bare phone+name rows), hand us the verification directly:

```json
{ "pan": "AAHPV1828L", "aadhaar_last4": "9012",
  "method": "digilocker", "verified_on": "2026-07-29", "verifier": "…",
  "staff": { "id": "…", "name": "…" } }
```
(fields also accepted nested under `kyc` or `applicant.kyc`.) We record the
evidence and, when acceptance is enabled, move `kyc_pending → payment_pending`.
Response: `{ success, kyc_recorded, kyc_accepted, status, moved }`. `409` if the
application is already `approved`/`rejected`/`cancelled`.

### ⚠️ Compliance gate — `NCD_ACCEPT_ASSERTED_KYC`

Accepting an asserted KYC (rather than our own DigiLocker step) is a compliance
decision, so it lives behind an **env flag on our side, OFF until sign-off**.
While OFF, create/`/kyc` **record** your assertion but do **not** move the
status — behaviour is unchanged. Once signed off we flip the flag (env only, no
deploy) and `verified: true` starts clearing applications immediately. We'll
give you a date. This is the only item in this batch with that gate.

## A9. `POST /locker-applications/:id/payment-link`
Online collection. `{ "leg": "rent" | "deposit", "staff": {…} }` →

```json
{ "success": true, "leg": "rent", "amount": 3540,
  "checkout_url": "https://pay.easebuzz.in/…", "intent_no": "LOCK-…" }
```
Show/send the URL to the customer. Settlement lands via the Easebuzz callback
and advances the application automatically (rent → Federal sub-merchant,
deposit → NCD sub-merchant — existing routing preserved).

## A10. `POST /locker-applications/:id/record-payment` — **RETIRED**

Always returns:

```json
{ "error": "Lockers and NCD are online-only. …", "code": "online_only" }
```
with HTTP `400`. Every call is audit-logged as `ncd_app_offline_payment_rejected`.

**Why:** lockers and NCD are online-only products, and that is a property of the
*product*, not of the caller. This route used to create **and** verify an offline
intent in one step, which auto-fired allocation — so a locker could be allotted
against cash/cheque with no online payment ever received.

**Use `A9 payment-link`** to collect online; once it settles, `A11 allocate`
behaves as before. For a payment genuinely collected **offline at the branch**
(cheque / cash / bank transfer), use **A18 `settle-offline`** below — the
typed, reconciliation-safe replacement for what A10 used to do badly.

## A18. `POST /locker-applications/:id/settle-offline`  *(added 2026-07-29)*

Record a payment that arrived **outside** the online link — a cheque, cash or
bank transfer collected at your branch. Unlike the retired A10, this writes a
**correctly-typed offline receipt** (`provider=offline`,
`payment_method=<method>`, `offline_status=verified`) — never a fake online row
— so our reconciliation and deposit-refund flows treat it correctly.

```json
{ "leg": "rent" | "deposit",
  "method": "cheque" | "cash" | "transfer",
  "reference": "CHQ-001234",        // cheque no / UTR (optional)
  "received_on": "2026-07-29",      // optional, defaults to today
  "reason": "Cheque collected at branch, clears 02-Aug",  // optional
  "staff": { "id": "…", "name": "…" } }
```

- **Amount is server-derived** — you name the `leg`, we settle the exact
  rent-incl-GST or deposit figure. You never send an amount.
- **Works before AND after allotment.** Before: the leg settles and the
  application reaches `pending_allocation` once **both** legs clear (then pick a
  locker via A11). After: a late payment on a tenancy already allotted (e.g. via
  the A20 override) marks the outstanding leg Paid and issues its receipt.
- **Idempotent.** If the leg is already settled (a prior payment, an NCD-linked
  deposit, or a zero-amount leg), you get `{ already: true, leg_settled: true }`
  and no duplicate row is created.
- Response: `{ success, leg, amount, method, leg_settled: true,
  obligations_settled, status, allotted }`. `409` if the application is already
  `rejected`/`cancelled`. Audited as `ncd_app_settle_offline`.

## A19. Locker-agreement e-Sign  *(added 2026-07-29)*

Start the locker rental-agreement e-Sign from NCD and poll its state. (You had
no locker-agreement e-Sign before — neither initiate nor download. Signed-PDF
download is A16; this is the missing **initiate**.)

The agreement is tenancy-specific (locker number, rent/deposit, agreement no),
so it can only be signed **after allotment** (A11). Call it before, and you get
`409 { code: "not_allotted" }`.

### A19.1 — `POST /locker-applications/{id}/esign/initiate`

Body: `{ staff: { id, name } }`. Builds the agreement PDF, uploads it to Digio,
and returns the **signing URL** for you to show / send to the customer:

```json
{ "success": true, "esign_id": "…", "digio_doc_id": "…",
  "auth_url": "https://…digio…", "status": "requested" }
```

- Digio also notifies the customer directly on their email + SMS.
- **Completion is automatic** — the signed status flows through our existing
  Digio webhook; you don't post anything back. Poll A19.2 to see it land.
- Nominee must be complete (it arrives on the applicant block at A7 and is
  applied to the profile at allotment). If it's missing: `400
  { code: "nominee_incomplete", missing: [...] }`. `no_channel` (`400`) if the
  customer has neither email nor phone. Audited `ncd_app_esign_initiate`.

### A19.2 — `GET /locker-applications/{id}/esign/status`

```json
{ "found": true, "esign_id": "…", "status": "signed",
  "digio_doc_id": "…", "auth_url": "…", "signed_file_url": "…", "updated_at": "…" }
```
`{ "found": false, "status": null }` before an e-Sign has been started. Once
`status` is `signed`, fetch the PDF via **A16**:
**`GET /agreements/{esign_id}/pdf?staff_id=<id>&staff_name=<name>`** — the `{id}`
is exactly the **`esign_id`** returned above. **`staff_id` is REQUIRED** (query
param) — without it the endpoint returns `400 {"error":"staff_id attribution
required."}`. Returns the **PDF body** (not JSON), streamed from Digio. The
`signed_file_url` field above is an internal SharePoint link — don't use it;
use A16 for the bytes.

## A11. `POST /locker-applications/:id/allocate`
`{ "locker_id": "<optional specific locker>", "lease_months": 12, "staff": {…} }` →
`{ "success": true, "tenant_id": "…", "locker_number": "L10-4", "lease_start": "…", "lease_end": "…" }`

`409` with `{ "missing": ["rent", …] }` if any mandatory payment is
outstanding. `400` if the chosen locker is no longer vacant.

**⚠️ Allocation is STAFF-ONLY (2026-07-25).** Auto-allocation on payment
settlement has been REMOVED platform-wide: a fully-paid application now parks
in **`pending_allocation`** until a staff user allocates it — this call is how
your side does that. Consequences for you:

- **Send `staff.staff_role` on every allocate call.** An asserted role of
  `agent` / `lead_agent` / `rm` / `relationship_manager` is refused with `403
  { code: "staff_only" }` — agents book applications; they do not pick locker
  numbers. Calls without `staff_role` are accepted for backward compatibility,
  but your UI must only surface the allocate action to staff.
- **Money settling no longer allocates.** After your payment webhook (or A12
  link-ncd) settles the last leg, `application_status` comes back
  `pending_allocation`, not `approved`. Your flow must follow up with THIS
  call (staff-driven) to assign the locker; LockerHub branch staff can also
  allocate it from their own portal — first one wins atomically.
- The customer is notified automatically when the allocation succeeds.

## A20. Allocate override — allot with money outstanding  *(added 2026-07-29)*

The A11 gate rejects allocation while any mandatory leg is unpaid
(`409 obligations_pending`). For the case where the business has **knowingly
accepted the risk** (e.g. a deposit waived and approved by a CXO), add an
`override` block to the **same A11 call**:

```json
{ "locker_id": "…", "lease_months": 12,
  "override": { "reason": "Deposit waived — approved by CXO, ref WVR-2026-014",
                "approved_by": "…" },
  "staff": { "id": "…", "name": "…" } }
```

- **Both fields required** when the money is outstanding: `reason` (≥5 chars)
  and `approved_by` (name the approver). Missing either → `400`.
- Allots despite the outstanding leg, and is **loudly audited**
  (`ncd_app_allocate_override`, with the reason + approver + what was missing).
  Response carries `"forced": true`.
- **Restrict this to a senior role on your side** — we don't gate the role here
  beyond the standing agent block, so the control is yours (as you proposed).
- If **A18 settle-offline** / a waiver already cleared the legs, obligations
  pass and no override is needed — a spurious `override` on a settled
  application is simply ignored (`forced: false`). This is the fallback; prefer
  clearing the obligation properly.

## A21. `POST /locker-applications/{id}/waiver`  *(added 2026-07-29)*

Apply a rent or deposit waiver to an application. You do maker-checker on your
side, so we accept it approved-on-arrival, attributed to the approver.

```json
{ "leg": "rent" | "deposit",
  "waiver_pct": 100,                 // OR "waiver_amount": 3000
  "reason": "Relationship waiver approved by CXO",
  "approved_by": "…",                // the approver (defaults to staff.name)
  "staff": { "id": "…", "name": "…" } }
```

- **Amount is server-derived from the leg** — send `waiver_pct` **or**
  `waiver_amount`; we cap it at the amount actually owed (a `waiver_amount`
  above the base becomes a 100% waiver).
- **A 100% waiver settles the leg** — `leg_settled: true`, no payment needed.
  A partial waiver **reduces the payable**; for rent, GST is recomputed on the
  discounted base (a proper tax invoice), and the reduced figure is what
  `A9 payment-link` / `A18 settle-offline` then collect.
- When the waiver clears **every** obligation, the application advances to
  `pending_allocation` (allot via A11), exactly as a final payment would.
- **Pre-allotment only** — `409` if the application is already
  `approved`/`rejected`/`cancelled` (a waiver on a live tenancy is a
  refund/adjustment, out of scope here). `409` too if the leg is already
  settled by a **payment** (waive before it's paid).
- Response: `{ success, leg, waiver_amount, waiver_pct, fully_waived,
  leg_settled, remaining_payable, obligations_settled, status }`. Audited
  `ncd_app_waiver`.

## A12. `POST /locker-applications/{id}/link-ncd`  *(added 2026-07-22)*

**The correct call for NCD-backed deposits — replaces the `record-payment`
workaround** (that route is retired and 400s; and a fake `bank_transfer` row
would break reconciliation, double-count AUM and poison the deposit-refund
workflow with never-received "cash").

Body: `{ "ncd_id": "NCD-2026-000123", "staff": { "id": 7, "name": "…" } }`
— `ncd_id` is your application number, the same id as B17/B18/B19a.

Behaviour: stamps the application `deposit_satisfied_via='ncd_link'`; the
deposit leg settles with **no cash row**; if rent is also settled the
application moves to **`pending_allocation`** (response carries
`application_status`) — a staff user then assigns the locker via A11.
*(Until 2026-07-25 this auto-allocated in the same call; see the A11 note.)*
Idempotent on the same `ncd_id` (→ `{already:true}`); a different NCD already
linked → 409; deposit already paid in cash → 409; no deposit → 400.

**Do NOT flip `is_locker_deposit` yourselves in this flow** — LockerHub's
durable queue calls your `POST /ncd/{id}/link-locker` (B19a) after allocation;
that push is the single writer of the pledge flag. The amount is always ours:
the leg settles at the application's priced deposit regardless of the NCD size.

**Release (you asked for this):** expose `POST /ncd/{id}/release-locker`
`{ deposit_reference, refund_no, released_at, reason }` — idempotent, same
auth. LockerHub calls it (durable-queued, kind `ncd_locker_release`) when a
deposit refund is settled at locker closure, so the pledge lifts and the money
becomes redeemable NCD on your books.

### Recommended staff flows

**Cash enrollment — NO LONGER SUPPORTED.** Lockers and NCD are online-only;
`A10` returns `400 online_only`. Use the online flow below.

**Online-payment enrollment:**
`A7 application → A9 payment-link per leg → customer pays → poll A8 until approved`.

---

# Part B — APIs the NCD app implements (LockerHub calls these)

These are the endpoints LockerHub called on Wealth. Same shapes, same
`X-Integration-Key` auth. All paths are under `<NCD_API_URL>/api/integration`
unless noted. Shapes are what LockerHub's live code sends/expects today.

**Audit result (2026-07-22): P0, P1 and P2 are ALL IMPLEMENTED in the NCD app**
(`api/src/modules/integration/` — `auth.ts`, `reads.ts`, `writes.ts`,
`agents.ts`), deployed dormant behind their `LOCKERHUB_INTEGRATION_KEY`.
Only **B23 + B24** in P3 are missing (see R2 in §Current status). The tables
below stay as the reference contract; per-block status is marked.

## P0 — customer login + NCD portal (blocks the customer app) — ✅ IMPLEMENTED

| # | Endpoint | LockerHub uses it for |
|---|---|---|
| B1 | `POST /auth/customer/lookup` `{ phone }` → `{ found, customer_id, customer_code, name, … }` | Login resolution: an NCD-only investor logs into the Dhanamfin app; multi-account picker |
| B2 | `POST /auth/otp/request` `{ phone }` → `{ success, masked_destination, expires_in_seconds }` | Staff-assisted NCD onboarding OTP |
| B3 | `POST /auth/otp/verify` `{ phone, otp }` → `{ success }` | Verifying that OTP |
| B4 | `POST /auth/token/validate` `{ token }` → `{ valid, customer_id }` | Session validation (rarely used) |
| B5 | `GET /customers/{id}/holdings` → `{ holdings: [ { application_no, scheme_name, series_name, principal, rate, maturity_date, next_payout, status, nominee, payout_account_masked, … } ] }` | My NCD portal + dashboard tiles + SOA PDF |
| B6 | `GET /customers/{id}/transactions` → interest ledger rows | Interest ledger + SOA PDF |
| B7 | `GET /customers/{id}/documents` → doc list; `GET /customers/{id}/documents/{docId}` → binary download | Customer documents (24h staff-granted exposure model on our side) |
| B8 | `GET /customers/{id}/requests` → request status list | "My requests" status |
| B9 | `GET /series/active` → `{ series: [ { series_id, scheme_id, coupon_rate_pct, min_amount, open/close dates, … } ] }` | Product-hub live rate ("Up to X% p.a."), series cards |
| B10 | `GET /customer-by-phone/{phone}` and `GET /customers-by-phone/{phone}` (list form) | Phone→customer resolution incl. multi-account |

*(NCD app also implements extras beyond this contract: `POST /auth/select-account`
— matches LockerHub's multi-account picker — plus `GET /customers/{id}/soa.pdf`
and `GET /customers/{id}/ledger.csv`.)*

## P1 — enrollment + money sync (blocks NCD sales through LockerHub) — ✅ IMPLEMENTED

| # | Endpoint | Notes |
|---|---|---|
| B11 | `POST /customers/from-lockerhub` `{ phone, name, email, pan, aadhaar_last4, address…, nominee…, bank…, source }` → `{ customer_id, customer_code, created }` | Create-if-missing with the rich profile. **Idempotent by phone.** |
| B12 | `POST /subscription-request` `{ customer_id, series_id, scheme_id, amount, lockerhub_application_no }` → `{ subscription_id }` | NCD subscription intent |
| B13 | `POST /subscription-payments/from-lockerhub` `{ lockerhub_application_no, amount, intent_no, paid_at, … }` | **Critical-path**: payment settled on LockerHub → posts to the NCD books. Delivered via LockerHub's durable retry queue (10 attempts, exponential backoff) — **must be idempotent on `intent_no`.** |
| B14 | `POST /leads` | NCD lead push from the prospect hub |
| B15 | `POST /redemption-request` `{ customer_id, application_no, … }` → `{ reference_id }` | Matured-NCD redemption |
| B16 | `GET /stats/ncd-aum` → `{ aum, investors, … }` | HO dashboard tile |

## P2 — locker-deposit ↔ NCD link ("a locker deposit IS an NCD") — ✅ IMPLEMENTED

| # | Endpoint | Notes |
|---|---|---|
| B17 | `GET /ncd/match?pan=…&amount=…` → `{ found, ncd_id, holder_name, amount, … }` | Link an EXISTING NCD as a locker deposit (PAN + exact amount match) |
| B18 | `POST /locker-deposits` `{ deposit_reference, phone, pan, amount, application_no, … }` | Fresh locker deposit → NCD approval queue (durable-queued) |
| B19 | `GET /ncd/locker-deposit-status?deposit_reference=…` → `{ status }` | Poll cron checks approval state |
| B19a | `POST /ncd/{ncd_id}/link-locker` `{ deposit_reference, tenant_id, phone, application_no, … }` | **Was missing from this doc (added 2026-07-21 after a code audit).** Fired (durable-queued) when an EXISTING NCD is linked as a locker deposit — both the staff link flow and self-signup allocation call it. Tells the NCD app "this NCD is now pledged as a locker deposit". Idempotent on (ncd_id, deposit_reference). |

## P3 — agents (blocks agent app features, not customer app) — 🟡 PARTIAL

Header `X-Acting-As-Agent: <ncd-side agent id>` on the `/api/my/*` calls.

| # | Endpoint | Status |
|---|---|---|
| B20 | `POST /api/integration/agents/from-lockerhub` (mirror agent, idempotent) | ✅ implemented |
| B21 | `POST /api/integration/agents/authenticate` + `POST /api/integration/agents/email-check` | ✅ implemented |
| B22 | `POST /api/integration/agents/issue-webview-session` (one-time webview SSO code) | ✅ implemented |
| B23 | `GET/PUT /api/my/profile` · `GET /api/my/customers` · `GET /api/my/earnings/summary` · `GET /api/my/earnings/breakdown` · `GET /api/investor-leads?mine=1` | ❌ **missing** — agent app's native earnings/customers screens break at cutover without these (or a joint switch to webview SSO) |
| B24 | `GET /agents/active?limit=…` · `POST /agents/propose` | ❌ **missing** — LockerHub's staff NCD agent-attribution picker ("search by name or code") + "Add someone not listed" depend on these |

## Penny-drop — both paths available

`POST /penny-drop` was listed as not-needed in v1.0; the NCD app implemented it
anyway (backed by Decentro BAV-v3). LockerHub's primary is **direct Decentro V3**
(`PENNY_DROP_VIA_WEALTH=false`); the proxy path through the NCD app remains a
working fallback (`=true`).

## Events the NCD app SENDS LockerHub — two channels

**Channel 1 — agent events (✅ IMPLEMENTED in the NCD app, dormant).**
`POST https://lockers.dhanamfinance.com/api/webhooks/wealth-agent`
HMAC-signed, NOT key-authed:

- Headers: `X-Dhanam-Signature: sha256=<HMAC-SHA256(secret, "<ts>.<rawBody>")>`,
  `X-Dhanam-Timestamp: <unix seconds>` (LockerHub rejects skew > 300 s),
  `X-Dhanam-Event: <type>`. **Sign the RAW request bytes — do not
  re-serialise the JSON.**
- Secret: NCD SSM `/dhanam/newwealth/LOCKERHUB_WEBHOOK_SECRET` ==
  LockerHub `.env` `LOCKERHUB_WEBHOOK_SECRET` (separate from the integration
  key; exchanged out-of-band).
- Events (each with its own dedup key on both sides; re-delivery safe;
  retry backoff 60s→24h; 4xx = permanent failure). Every payload also carries
  `event`, `agent_id`, `lockerhub_user_id`, `fired_at`:
  - `customer_activated` — `{ customer_id, activated_at }` (agent's referred customer went live)
  - `incentive_accrued` — `{ application_id, application_line_id, accrual_date, amount, … }`
  - `incentive_paid` — `{ payout_id, paid_at, amount, … }`
- These power the agent app's earnings screens.

**Channel 2 — business events (LockerHub receiver LIVE; NCD sender NOT built — optional).**
`POST https://lockers.dhanamfinance.com/api/integration/wealth/webhook`
(key-authed: `NCD_INBOUND_KEY` / shared key). Envelope:

```json
{ "event_id": "evt_…",            // unique — idempotency key, re-delivery safe
  "event_type": "subscription.activated",
  "occurred_at": "2026-07-21T10:24:00Z",
  "phone": "9876543210",
  "data": { "lockerhub_application_no": "APP-…", "customer_code": "…" } }
```

Recognised `event_type`s: `customer.synced` · `subscription.created` ·
`subscription.activated` · `subscription.cancelled` · `payment.acknowledged` ·
`interest.paid` · `redemption.completed`. Unknown types are stored, never
rejected. **Not blocking**: LockerHub's reconcile route + the NCD app's daily
SQLite reconciliation cover the same ground; build the senders when convenient
(they enable real-time application-status sync + customer push on interest paid).

---

## Go-live checklist (updated 2026-07-22 — LockerHub Phase 1 EXECUTED)

**Scope confirmed by Prem: the NCD app replaces Wealth for EVERYTHING — agents
(login / SSO / earnings / referral attribution) included, not just customer NCD.**

### Phase 1 — enrollment live (LockerHub side DONE 2026-07-22)
1. ✅ Fresh integration key `K` minted and live on LockerHub — inbound
   `/api/integration/v1/*` now requires it (verified: 401 without, `ping` +
   `branches` respond with it). **Prem reads `K` to the NCD team out-of-band**
   (it lives only in the EC2 `.env`, `NCD_APP_INTEGRATION_KEY`).
2. ✅ Fresh agent-webhook HMAC secret minted and live
   (`LOCKERHUB_WEBHOOK_SECRET`) — sign `POST /api/webhooks/wealth-agent` with
   it (`X-Dhanam-Signature: sha256=HMAC(secret, "<ts>.<rawBody>")`). Also
   exchanged out-of-band. Neither secret is the old Wealth key — that value
   dies with Wealth.
3. ☐ NCD app: write SSM `LOCKERHUB_API_URL =
   https://lockers.dhanamfinance.com/api/integration/v1` + set your
   `LOCKERHUB_INTEGRATION_KEY` param to `K`; redeploy. Branch dropdown fills.
4. ☐ NCD app: switch deposit linking to **A12 `link-ncd`** (record-payment is
   retired and 400s) and build **`POST /ncd/{id}/release-locker`**.
5. ☐ Joint: one end-to-end enrollment (rent via payment-link → link-ncd →
   auto-allot).
   ⚠️ Until Phase 2, LockerHub's outbound pledge pushes (`ncd_locker_link`)
   still target Wealth and will sit failed in the queue — expected; they
   re-drive at Phase 2 via reconcile. Keep the gap short.

### Phase 2 — full cutover (after the checks below)
6. ☐ R3 shape diff on real customers (holdings totals, customer_status,
   penny-drop failure fields) **+ ID continuity: customer_code / ncd ids /
   subscription ids preserved from the Wealth import**.
7. ☐ **Agent parity check**: one agent end-to-end against the NCD app —
   mirror → login → webview SSO → earnings screens; agent_code +
   wealth_user_id continuity.
8. ☐ LockerHub EC2, TOGETHER in one edit: `NCD_API_URL=<NCD app root>` +
   `NCD_INTEGRATION_KEY=K` + `PENNY_DROP_VIA_WEALTH=false` →
   `pm2 restart lockerhub --update-env`. (Never the key without the URL.)
9. ☐ NCD app: SSM `LOCKERHUB_WEBHOOK_URL` + `LOCKERHUB_RECONCILIATION_ENABLED=true`.
10. ☐ LockerHub: drain + `reconcile-ncd`; verify customer NCD portal, agent
    login, one webhook event. Watch the first hour.
11. Rollback at any point = remove the three Phase-2 env lines + restart.

### Phase 3 — sunset (a week stable)
12. ☐ Remove `WEALTH_*` env from LockerHub; retire the hardcoded
    wealth.dhanamfinance.com fallback URLs in server.js; decommission Wealth
    per `ops/CUTOVER-LOCKERHUB.md`.

**Standing constraint:** the NCD app must stay on a `dhanamfinance.com`
subdomain — both native shells' WebView allowlists suffix-match that domain;
moving off it needs native rebuilds on two stores.
