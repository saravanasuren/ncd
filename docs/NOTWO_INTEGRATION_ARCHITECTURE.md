# NCD → Notwo Integration — Architecture

> **Status:** Design for review — 2026-08-11. No code has been changed.
> **Scope:** Replace the SharePoint xlsx dump feed with a one-way, read-only,
> versioned HTTP API on NCD that Notwo pulls from on a schedule and stores in
> its own database. Add a locker feed (rent-only), a read-only locker view in
> Notwo, and a combined customer view (PAN-linked). Then retire the SharePoint
> path.

**Owner decisions this design is built to (not up for re-litigation here):**

1. Both sides are built: NCD's outbound API and Notwo's consumer + DB + UI.
2. Customer linking is **PAN only**. No-PAN customers stay unlinked. Never
   auto-merge on phone or name.
3. Auth reuses NCD's existing `/api/integration` key-gated surface
   (`requireIntegrationKey`). **GET-only, no write-back from Notwo, ever.**
4. Lockers are **rent-only** going forward. Deposit-backing is historical and
   is NOT carried on the feed.
5. **Failure independence:** NCD runs fine with Notwo down; Notwo serves every
   page from its own DB with NCD down. No page-load in Notwo ever calls NCD.

---

## 1. Current state (what was inspected)

### 1.1 NCD's dump generator — every field it emits today

`/Users/eashwarram/tools/ncd/api/src/scripts/daily-extract.ts` builds CSVs + one
xlsx workbook (one tab per CSV) from the app's **own report functions**
(`modules/reports/book.ts`, `modules/incentives/service.ts`,
`modules/escrow/service.ts`) — never hand-written queries — so the feed always
agrees with what the office sees on screen. PAN and bank accounts are masked to
last-4 (`mask()`, daily-extract.ts:66–72).

| File (tab) | Fields | Built from | Source tables |
|---|---|---|---|
| `customers.csv` (Customers) — :120 | `customer_code, full_name, dob, age, pan_masked, phone, address, tds_status, total_invested, total_all_time, total_redeemed, investment_count` | `book.customerWiseReport` | `customers` + aggregates over `applications`/`application_lines`/`redemptions` |
| `investments.csv` (Investments) — :143 | `application_no, customer_code, customer, series_code, status, channel, source, amount, date_money_received, allotment_date, maturity_date, redemption_date, coupon_rate_pct, tenure_months, payout_frequency, staff_code, staff_name, agent_code, agent_name, referred_by` | `book.applicationsFlat` + enroller side-query (:134) | `applications` ⋈ `customers` ⋈ `series` ⋈ `application_lines`, `users`, `agents` |
| `interest.csv` (Interest) — :163, **~43k rows** | `due_date, application_no, customer_code, customer, series_code, due_type, gross_amount, tds_amount, net_amount, status, paid_at, utr` | `book.interestLedger` | `disbursement_schedule` ⋈ `applications` ⋈ `customers` ⋈ `series` (book.ts:546–549) |
| `redemptions.csv` (Redemptions) — :181 | `redemption_date, customer, series_code, type, net_payment` | `book.redemptions` (Approved/Paid only) | `redemptions` ⋈ `applications` ⋈ `customers` ⋈ `series` |
| `series.csv` (Series) — :189 | `series_code, status, investors, issued, redeemed, outstanding` | `book.seriesSummary` | `series` + aggregates |
| `escrow.csv` (Escrow) — :210 | `item, amount, count` (long format) | `escrowSummary` | `escrow_statements` etc. |
| `staff.csv` (Staff) — :221 | `staff_code, full_name, role, active` | inline query | `users` ⋈ `roles` |
| `agents.csv` (Agents) — :227 | `agent_code, full_name, commission_pct, active` | inline query | `agents` (incl. inactive/deleted) |
| `incentives.csv` (Incentives) — :236 | `application_no, payee_type, payee_code, payee_name, incentive_amount, paid, paid_amount, accrual_date` | `incentives.accrualsForExtract` (service.ts:125 — same NOT_SELF filter as the tiles) | `incentive_accruals` ⋈ `applications`, `users`, `agents` |
| `summary.csv` (Summary) — :260 | `as_of, outstanding_book, active_investors, interest_paid, interest_scheduled, interest_accrued, interest_monthly, interest_daily, customers, investments, series, escrow_balance, escrow_not_enrolled, escrow_as_of` | `book.kpis`, `book.interestAccrued`, `book.monthlyInterestRunRate`, `escrowSummary` | (derived) |
| `manifest.json` — :300 | `source, generated_at, files{name→rowcount}, masked_fields, note` | — | — |

**Publisher:** `/Users/eashwarram/tools/ncd/api/src/integrations/ncd-extract-publish.ts`
uploads those files to SharePoint (stable "latest" + timestamped `runs/` history)
whenever the book changes — change is detected by
`bookLatestChangeMs()` (:30–41): `GREATEST(max(applications.updated_at),
max(redemptions.created_at), max(payout_batches.created_at))`, debounced 90s,
min-gap 60s. Scheduled by a 30s `setInterval` in
`api/src/index.ts` (~:132–140), watermark in `extract_publish_state`
(migration `056_extract_publish_state.sql`). The nightly CLI (`daily-extract.js
--out`) also exists.

### 1.2 How Notwo consumes it today — every field it depends on

Notwo's live consumer is **not** the old SQLite `server.js` app — it is the
TypeScript rebuild at `/Users/eashwarram/tools/notwo/nothree/` (Express API +
React web, Postgres, same migration lineage as NCD up to ~052). The consumer is
the **overlay module**, `nothree/api/src/modules/overlay/`:

- `sharepoint.ts` — app-only Graph client; GETs `manifest.json` +
  `ncd-extract.xlsx` from one drive folder.
- `autosync.ts` — polls every `OVERLAY_POLL_SECONDS` (default 120s,
  config.ts:77–83); imports only when `manifest.generated_at` is newer;
  validates workbook row counts against the manifest (`validateCounts`, :22);
  on any failure keeps the last good snapshot.
- `service.ts` — `parseWorkbook` (:104) reads sheets **Customers, Investments,
  Series, Redemptions, Staff, Agents, Incentives** plus five Summary cells;
  `replaceActiveDump` (:131) **wipes and reinserts** the `ext_*` tables in one
  transaction (one dump at a time, children cascade).
- Read models: `overlaySummary` (dashboard "A/c" tiles), `listExtCustomers`,
  `listExtInvestments`, `combinedIncentivePeople`, `personSplit`.
- `people.ts` + migration `056_cross_app_links.sql` — human decisions live
  OUTSIDE the wiped tables, keyed on **stable text the source re-sends**
  (`ext_person_links` on kind+code+name_norm; `ext_investment_dupes` on
  `ext_application_no`). This pattern is kept.

Fields Notwo actually stores/uses (migrations `053_external_overlay.sql`,
`055_overlay_staff_incentives.sql`):

| Notwo table | Fields consumed |
|---|---|
| `ext_dump` (header) | Summary: `as_of, outstanding_book, active_investors, interest_paid, interest_scheduled` + row counts + `source`, `generated_at` |
| `ext_customers` | **all 12** customers.csv fields (+ derived `phone_norm`) |
| `ext_investments` | **19 of 20** investments.csv fields (all except `channel`/`source` — it stores neither) |
| `ext_series` | all 6 |
| `ext_redemptions` | all 5 |
| `ext_staff` | all 4 (+ derived `name_norm`) |
| `ext_agents` | all 4 (+ `name_norm`) |
| `ext_incentives` | all 8 (+ `name_norm`) |

**Not consumed today:** `interest.csv` (43k rows — deliberately collapsed to the
Summary totals), `escrow.csv`, and the Summary columns beyond the five above.

### 1.3 NCD's existing integration surface (the auth we reuse)

- `api/src/middleware/integrationAuth.ts` — `requireIntegrationKey`:
  `X-Integration-Key` header, constant-time compare against
  `config.LOCKERHUB_INTEGRATION_KEY`.
- Mounted at `/api/integration` in `api/src/app.ts:88`, behind
  `integrationLimiter` (:83). Router: `api/src/modules/integration/routes.ts`
  (LockerHub/DhanamFin façade — auth, reads, writes, agents).

### 1.4 What NCD actually knows about lockers (feed reality check)

NCD does **not** own a locker/tenant table. LockerHub is the record; NCD reads
live tenancy over HTTP and owns only the overlay data:

- **Roster read model:** `modules/lockers/deposits.ts` → `lockerTenants()`
  (:388–653). Spine = LockerHub `GET /locker-tenants` (occupied lockers only;
  disappearance from the roster IS the closure signal). Per row: `tenant_id`
  (their immutable tenancy PK), `lockerhub_application_id`, `locker_no`,
  `locker_size` (`t.size`), `branch_id/branch_name`, `status`/`account_status`,
  `tenant_name/phone/email`, `allotted_on`, `lease_expires_on`. Enrichment via
  per-phone LockerHub customer lookups adds `annual_rent`, `deposit_amount`,
  `lease_start`, `lockers_held` (:502–529). Customer link = phone + FULL-name
  match (`namesMatch`, :351) or a manual override; the function returns
  `roster_complete` + `lockerhub_error` when LockerHub is unreachable.
- **NCD-owned locker tables:**
  - `locker_tenant_overrides` (038) — manual tenant→customer links + removals,
    keyed on `lockerhub_tenant_id`. **This is the tenant/customer relationship
    of record.**
  - `locker_cheques` (032, 052, 061) — cheque register per
    (`lockerhub_application_id`, `leg` rent|deposit): amount, cheque_no, bank,
    received/cleared, status, `lockerhub_settled_at`.
  - `locker_pricing` (062) — per-size `deposit_amount` (seeded) and
    `annual_rent` (**currently NULL — never set in the UI**).
  - `locker_fee_waivers` (053) — rent/deposit waivers on an application.
  - `locker_deposit_links` (031) + `locker_deposit_waivers` (036) — the
    **deposit-backing concept, now historical**; excluded from the feed.
- **Renewals:** `modules/lockers/renewals.ts` derives due/overdue purely from
  `lease_expires_on` — there is **no rent ledger** and no renewal write path.

---

## 2. Data ownership

| Data | Owner (writes) | NCD's role | Notwo's role |
|---|---|---|---|
| NCD customers, KYC | **NCD** | master | receives read-only copy (`ncd_customers`) |
| NCD investments (applications/lines/schedule/redemptions) | **NCD** | master | receives read-only copy |
| Series, staff, agents, incentives (NCD book) | **NCD** | master | receives read-only copy |
| Locker tenancy (allotment, lease, closure) | **LockerHub** | reads live; owns overrides/cheques/pricing/waivers | receives NCD's consolidated view, read-only. **No locker enrolment in Notwo.** |
| Locker tenant ↔ NCD customer link | **NCD** (`locker_tenant_overrides` + auto match) | master | receives resolved link |
| Notwo customers + Notwo NCD enrolments | **Notwo** | none — NCD never sees them | master |
| Cross-app person links / investment-dupe verdicts | **Notwo** (`ext_person_links`, `ext_investment_dupes`) | none | master (human decisions, kept) |
| PAN customer linkage (derived) | nobody — computed at read time by PAN equality | — | computes and displays |

One-way is absolute: NCD exposes GETs; Notwo holds a key and a puller. Notwo
has no NCD credentials for anything else, and NCD gains **no** knowledge of
Notwo's book. There is no callback, no webhook from Notwo, no write-back.

---

## 3. NCD API surface — `/api/integration/export/v1`

New router file `api/src/modules/integration/export.ts`, mounted from
`modules/integration/routes.ts` (so it sits behind `requireIntegrationKey` and
`integrationLimiter` exactly like the LockerHub façade). Versioned by path
segment; breaking changes mint `/export/v2` and keep v1 alive until consumers
move.

**Rules for the whole surface:**

- **GET-only.** The router registers no POST/PUT/PATCH/DELETE. There is no
  endpoint that mutates NCD state; a re-sent request returns the same answer
  for the same book (idempotent by construction).
- Figures come from the **same report functions the dump uses** (`book.*`,
  `incentives.accrualsForExtract`, `lockerTenants`) — the API can never
  disagree with the app or with the dump during the parallel run.
- Every row carries its **stable source identifier** (the NCD primary key) so
  the consumer upserts instead of duplicating. Business codes
  (`customer_code`, `application_no`, `series_code`) ride along.
- Response envelope:
  ```json
  { "source_system": "ncd", "as_of": "<ISO>", "data": [ ... ],
    "next_cursor": "<opaque or null>" }
  ```
- **Pagination:** keyset on the source id — `?cursor=<last id>&limit=` (default
  500, max 2000). Small resources (series/staff/agents) will fit one page;
  the shape is uniform anyway.
- **Incremental:** `?updated_since=<ISO>` on the resources whose source rows
  carry `updated_at` (customers — 002_customers.sql:69; applications —
  003_investments.sql:28). Others are full-snapshot by design (see §5).
- **Privacy:** No bank account numbers, no Aadhaar, no password/OTP material,
  no internal approval state — the field lists below are exhaustive. **PAN is
  sent in full** (it is the linking key; see Open decision #1). The transport
  is HTTPS + key auth server-to-server — unlike the dump, the payload never
  sits as a file in a SharePoint folder.

### 3.1 Endpoints

| Endpoint | Params | Purpose |
|---|---|---|
| `GET /export/v1/manifest` | — | `{ api_version: 1, book_version, resources: {name → row count}, generated_at }`. `book_version` = ISO of `bookLatestChangeMs()` (reused from ncd-extract-publish.ts:30) ⊕ `max(customers.updated_at)`. The cheap freshness probe — the API twin of `manifest.json`. |
| `GET /export/v1/summary` | — | One object: all 14 `summary.csv` fields, same computations. |
| `GET /export/v1/customers` | `updated_since, cursor, limit` | Rows below. |
| `GET /export/v1/investments` | `updated_since, cursor, limit` | Rows below. |
| `GET /export/v1/series` | — | 6 series.csv fields + `external_series_id`. |
| `GET /export/v1/redemptions` | `cursor, limit` | 5 redemptions.csv fields + `external_redemption_id` (`redemptions.id`), `application_no`, `customer_code` (both free from the same join — fixes the dump's name-only rows). |
| `GET /export/v1/staff` | — | 4 staff.csv fields + `external_staff_id` (`users.id`). |
| `GET /export/v1/agents` | — | 4 agents.csv fields + `external_agent_id` (`agents.id`). |
| `GET /export/v1/incentives` | `cursor, limit` | 8 incentives.csv fields + `external_accrual_id` (`incentive_accruals.id` — added to `accrualsForExtract`'s SELECT, a one-column change). |
| `GET /export/v1/interest` | `application_no, from, to, status, cursor, limit` | The 12 interest.csv fields. **Served, not synced** (v1 — Notwo keeps using Summary totals; see Open decision #5). Schedule rows are regenerated on rematerialisation so their ids are NOT stable — this endpoint is for drill-down queries, not replication. |
| `GET /export/v1/lockers` | — | §3.2. |
| `GET /export/v1/locker-cheques` | `leg=rent` (default), `cursor, limit` | §3.2. |

**Customers row** (superset of customers.csv):

```
external_customer_id   customers.id
customer_code, full_name, dob, age, phone, address, tds_status,
total_invested, total_all_time, total_redeemed, investment_count
pan                    customers.pan — FULL, replaces pan_masked
kyc_status             customers.kyc_status  (new — LockerHub CR already leans on it)
is_active              customers.is_active   (new — lets Notwo mark source-deactivated rows)
updated_at             customers.updated_at  (the watermark)
```

**Investments row** (superset of investments.csv):

```
external_application_id  applications.id
application_no, customer_code, customer, series_code, status, channel, source,
amount, date_money_received, allotment_date, maturity_date, redemption_date,
coupon_rate_pct, tenure_months, payout_frequency,
staff_code, staff_name, agent_code, agent_name, referred_by
external_customer_id     applications.customer_id (join key without code lookup)
updated_at               applications.updated_at (the watermark)
```

### 3.2 The locker feed (rent-only)

`GET /export/v1/lockers` serves the **existing** `lockerTenants()` read model
(deposits.ts:388) filtered to rent/tenancy/relationship fields — one
consolidated view that already folds in the roster, manual overrides, removals
and pledge/cheque joins. Envelope adds two flags the consumer must honour:

```json
{ "source_system": "ncd", "as_of": "...",
  "roster_complete": true, "lockerhub_error": null,
  "data": [ {
    "external_locker_key": "<tenant_id, else lockerhub_application_id>",
    "lockerhub_tenant_id": "…",           // null until allotted
    "lockerhub_application_id": "…",      // null for staff-created tenancies
    "locker_no": "…", "locker_size": "XL",
    "branch_id": "…", "branch_name": "…",
    "status": "occupied | payment_pending | …",
    "account_status": "Active | Closure Requested | null",
    "allotted_on": "…", "lease_start": "…", "lease_expires_on": "…",
    "tenant_name": "…", "tenant_phone": "…",
    "customer": { "external_customer_id": 123, "customer_code": "…",
                  "pan": "…" } ,          // null when unlinked
    "linked_manually": false,
    "annual_rent": 6000.0,                // LockerHub figure, else locker_pricing.annual_rent by size, else null
    "rent_cheque_pending": false,
    "rent_fee_waiver": { "status": "Approved", "pct": 100, "amount": null } // open rent waiver, else null
  } ] }
```

**Deliberately excluded (owner decision #4):** `deposit_amount`,
`pledged_amount`, `ncd_backed`, deposit cheques, `locker_deposit_links`,
`locker_deposit_waivers`. Deposit history stays inside NCD.

`GET /export/v1/locker-cheques?leg=rent` — the rent-cheque register rows
(`external_cheque_id` = `locker_cheques.id`, `lockerhub_application_id`,
`amount`, `cheque_no`, `bank_name`, `received_on`, `status`, `cleared_on`,
`lockerhub_settled_at`, `customer_code`). This is the closest thing NCD has to
rent *payments*.

**Flagged gaps — fields Notwo may want that NCD cannot reliably supply:**

| Gap | Why | Consequence / mitigation |
|---|---|---|
| **No rent ledger.** Rent paid *online on LockerHub* is invisible to NCD (NCD sees only a per-application leg settled flag, and only for application-born tenancies). | LockerHub owns payments; contract has no payments-history read. Renewals module is explicitly read-only (renewals.ts:17–22). | Notwo's locker view shows *expected* rent + NCD-recorded rent cheques + waivers, labelled as such — never a paid/unpaid rent statement. A LockerHub CR would be needed for true rent history. |
| `annual_rent` is per-tenant via fragile per-phone LockerHub lookups; NCD's own `locker_pricing.annual_rent` is NULL today (062 seeds deposits only). | Owner hasn't set rents in Masters; LockerHub omits rent from the roster call. | Feed sends best-available and may send null. Owner should fill `locker_pricing.annual_rent` (Open decision #4). |
| Tenant→customer link coverage is partial; LockerHub exposes **no PAN** (profile null or masked — 038 header). | Identity = phone+full-name auto-match or human override only. | Unlinked lockers appear in Notwo with name/phone only and can never join the PAN-linked customer view. Correct by design — never guessed. |
| Roster is a live LockerHub fetch; when LockerHub is down NCD serves a partial set (`roster_complete:false`). | NCD keeps no roster snapshot. | Notwo's puller **skips replacing** locker rows on `roster_complete:false` and keeps the last good set (same keep-last-good rule the autosync already uses for a bad manifest). |
| Lease/rent fields are null for not-yet-allotted applications. | LockerHub mints tenancy data at allotment. | Rows still sent (keyed on application id) so pipeline lockers are visible. |

---

## 4. Field mapping — dump → API → NCD source

Everything Notwo consumes today maps 1:1; deltas are **bold**.

| Current dump field | New API resource.field | NCD source |
|---|---|---|
| Summary.as_of / outstanding_book / active_investors / interest_paid / interest_scheduled (+9 unconsumed cols) | `summary.*` (all 14) | `book.kpis`, `book.interestAccrued`, `book.monthlyInterestRunRate`, `escrowSummary` |
| manifest.generated_at / files counts | `manifest.book_version` / `resources` | `bookLatestChangeMs()` + counts |
| customers.customer_code…investment_count (12) | `customers.*` same names | `customers` + `book.customerWiseReport` aggregates |
| customers.pan_masked | **`customers.pan` (full)** | `customers.pan` |
| — | **`customers.external_customer_id`, `kyc_status`, `is_active`, `updated_at`** | `customers.id / kyc_status / is_active / updated_at` |
| investments.* (all 20) | `investments.*` same names | `applications` ⋈ `application_lines` ⋈ `customers` ⋈ `series`; enroller via `users`/`agents` (daily-extract.ts:134–141) |
| — | **`investments.external_application_id`, `external_customer_id`, `updated_at`** | `applications.id / customer_id / updated_at` |
| interest.* (12) | `interest.*` same names (query endpoint, not synced) | `disbursement_schedule` ⋈ … (book.ts:546) |
| redemptions.* (5) | `redemptions.*` same names | `redemptions` ⋈ … (book.ts:493) |
| — | **`redemptions.external_redemption_id`, `application_no`, `customer_code`** | `redemptions.id`, joins |
| series.* (6) | `series.*` same names | `series` + `book.seriesSummary` |
| staff.* (4) | `staff.*` + **`external_staff_id`** | `users` ⋈ `roles`; `users.id` |
| agents.* (4) | `agents.*` + **`external_agent_id`** | `agents`; `agents.id` |
| incentives.* (8) | `incentives.*` + **`external_accrual_id`** | `incentive_accruals` via `accrualsForExtract` (+`ia.id`) |
| escrow.csv | *dropped* — Notwo never consumed it; totals live in `summary` | — |
| *(nothing — NEW)* | `lockers.*`, `locker-cheques.*` (§3.2) | `lockerTenants()`, `locker_tenant_overrides`, `locker_cheques`, `locker_pricing`, `locker_fee_waivers`, LockerHub live |

---

## 5. Incremental sync design

**Cycle (Notwo side, every `NCD_PULL_SECONDS`, default 120s — same cadence the
autosync uses today):**

1. `GET /export/v1/manifest`. If `book_version` equals the stored one and the
   last cycle succeeded → done (the "unchanged" fast path, exactly like the
   autosync's `generated_at` check, autosync.ts:60).
2. Pull `summary` (replace the single row).
3. Pull `customers` and `investments` with
   `updated_since = stored watermark − 5 minutes` (overlap window: `updated_at`
   is set app-side with no trigger, so a clock skew or a write that commits
   after a longer transaction must not be missed; re-upserting an already-seen
   row is a no-op by design). Upsert page by page; new watermark = max
   `updated_at` seen, committed **only after** the resource completes.
4. Pull `series`, `staff`, `agents`, `redemptions`, `incentives` in full
   (hundreds to ~2k rows — cheaper than building delta plumbing for tables the
   dump already ships whole) and upsert.
5. Pull `lockers` + `locker-cheques`. If `roster_complete:false`, **skip** the
   locker replace and record the error; otherwise replace the locker set
   wholesale (roster disappearance = closure, so full-set replace is the
   correct delete semantics).
6. Record per-resource outcome in `ncd_sync_state`.

**Nightly full reconcile** (or every Nth cycle, e.g. 02:00 IST): pull
`customers` and `investments` **without** `updated_since`; any stored row whose
external id is absent from the full set gets `deleted_in_source_at = now()`
(NCD super-admin hard-deletes and archives are otherwise invisible to a
watermark feed). Nothing is ever physically deleted in Notwo; UI filters on
`deleted_in_source_at IS NULL`.

**Idempotent upserts.** Every table keys on the NCD primary key
(`external_*_id`), with the business code unique alongside:

```sql
INSERT INTO ncd_customers (external_customer_id, …, last_synced_at)
VALUES (…, now())
ON CONFLICT (external_customer_id) DO UPDATE SET …, last_synced_at = now(),
  deleted_in_source_at = NULL;   -- a re-sent record un-deletes itself
```

A re-sent record therefore **updates in place**; a duplicate is structurally
impossible. Resources with no per-row watermark are upserted the same way, so
even the "full pull" path never wipes-and-reinserts — a mid-cycle crash leaves
yesterday's rows standing, never an empty table.

**Failure handling:** any HTTP/parse error aborts that resource's step, keeps
its previous data and watermark, records `last_error` in `ncd_sync_state`, and
the next cycle retries. This is the exact posture `autosync.ts` has today
(keep last good, never blank the dashboard).

**Failure independence recap:** the puller is the only thing that talks to
NCD; every Notwo page reads `ncd_*` tables. NCD's only exposure to Notwo is a
rate-limited GET. Either side can be down for a week and the other keeps
working, just with a "data as of …" staleness stamp (already a UI pattern —
`overlaySummary.auto`).

---

## 6. Notwo side

### 6.1 New tables (migration `057_ncd_sync.sql`)

Mechanical restatement of today's `ext_*` columns plus sync metadata — every
table gets `source_system TEXT NOT NULL DEFAULT 'ncd'`, `source_updated_at
TIMESTAMPTZ`, `last_synced_at TIMESTAMPTZ NOT NULL`, `deleted_in_source_at
TIMESTAMPTZ`:

| Table | PK / unique | Payload columns (from §3/§4) |
|---|---|---|
| `ncd_sync_state` | `resource` PK | `watermark, last_synced_at, last_full_sync_at, last_status, last_error, rows_upserted, book_version` |
| `ncd_summary` | single row (`id=1` check) | the 14 summary fields |
| `ncd_customers` | `external_customer_id` PK, `customer_code` UNIQUE | 12 dump fields + `pan`, `kyc_status`, `is_active`, `phone_norm` (derived) |
| `ncd_investments` | `external_application_id` PK, `application_no` UNIQUE | the 20 dump fields + `external_customer_id` |
| `ncd_series` | `external_series_id` PK, `series_code` UNIQUE | 6 fields |
| `ncd_redemptions` | `external_redemption_id` PK | 5 fields + `application_no`, `customer_code` |
| `ncd_staff` | `external_staff_id` PK | 4 fields + `name_norm` |
| `ncd_agents` | `external_agent_id` PK | 4 fields + `name_norm` |
| `ncd_incentives` | `external_accrual_id` PK | 8 fields + `name_norm` |
| `ncd_lockers` | `external_locker_key` PK | §3.2 fields, customer link flattened to `ncd_customer_code` / `ncd_customer_pan` |
| `ncd_locker_cheques` | `external_cheque_id` PK | §3.2 cheque fields |

**Kept unchanged:** `ext_person_links` and `ext_investment_dupes` — already
keyed on stable text (`kind+code+name_norm`, `ext_application_no`), so every
human decision survives the source swap untouched. **Retired at the end:**
`ext_dump/ext_customers/ext_investments/ext_series/ext_redemptions/ext_staff/
ext_agents/ext_incentives` (dropped in the final cleanup PR, after the
parallel run).

### 6.2 Consumer layer

New module `nothree/api/src/modules/ncdsync/` mirroring the autosync shape:

- `client.ts` — thin fetch wrapper: base URL + `X-Integration-Key` from config
  (`NCD_API_BASE_URL`, `NCD_INTEGRATION_KEY`, `NCD_PULL_SECONDS`), pagination
  helper. **GET only — the module contains no other verb.**
- `puller.ts` — the §5 cycle; started from `index.ts` like `startAutosync`;
  inert unless configured. Also exposes `pullOnce()` for an admin "Sync now".
- `routes.ts` — admin-gated status endpoint (sync state per resource, last
  errors) + `POST /sync-now` (local trigger; not an NCD call path) + the
  §7 comparison report during the parallel run.

The existing overlay **read models keep their response shapes** and swap their
FROMs: `ext_customers` → `ncd_customers` (drop the `dump_id` filter),
`ext_investments` → `ncd_investments`, incentive/person queries likewise. The
dashboard's "A/c" tiles read `ncd_summary` + `ncd_sync_state`. Frontend pages
(`Dashboard.tsx`, `Customers.tsx`, `Incentives.tsx`, `PersonDetail.tsx`)
change minimally or not at all.

### 6.3 Combined customer view (PAN-linked)

`Customers.tsx` gains a segment control: **All / NCD / Notwo / Linked.**

Read model (new query in `customers` or `ncdsync` module):

- **Linked** = `customers.pan = ncd_customers.pan` (both non-null, non-empty;
  both PANs are already uppercase-normalised in their sources — enforce
  `upper(trim())` in the join anyway). One display row per PAN carrying **both**
  source records — never merged, never copied: name/code per source shown side
  by side, `source_system` badges on every field group, combined
  `total_invested` = Notwo book + NCD book.
- **NCD** = `ncd_customers` rows with no PAN match (or no PAN) — badge "NCD".
- **Notwo** = own `customers` rows with no PAN match — badge "Notwo".
- **All** = union of the above (linked pairs counted once).
- No-PAN rows can never link (owner decision #2) — they simply live in their
  source segment. Phone/name similarity is **display-only context** at most,
  never a join.

Customer detail for a linked pair: two source cards + own deposits (Notwo) +
NCD investments (`ncd_investments` by `customer_code`) + NCD lockers
(`ncd_lockers` by customer code/PAN) — each section labelled with its source.
Both underlying records remain independently visible and exportable.

### 6.4 Read-only locker view

New page `Lockers.tsx` (nav-gated like Reports): table over `ncd_lockers` —
search (tenant name / phone / locker_no / customer code), filters (branch,
size, status/account_status, lease state: active / expiring ≤60d / expired /
unknown, linked vs unlinked), columns incl. `annual_rent`,
`rent_cheque_pending`, waiver tag, and the customer relationship (linked NCD
customer → click through to the combined customer). Freshness banner from
`ncd_sync_state` (incl. "locker roster incomplete since …" when NCD reported
`roster_complete:false`). Excel export. **No create, no edit, no enrol** — the
page states that locker enrolment happens in NCD.

---

## 7. SharePoint deprecation + parallel-run validation

**Phase P (parallel run, 5–7 business days incl. month-end payout events):**

1. Both feeds live: SharePoint autosync keeps filling `ext_*`; the new puller
   fills `ncd_*`. Zero UI change yet.
2. Comparison report (admin endpoint in `ncdsync/routes.ts`): per resource —
   row counts, `sum(amount)`, `outstanding_book`, incentive earned/paid totals,
   customer `total_invested` sum — `ext_*` vs `ncd_*`, with a per-key diff list
   for any mismatch. Acceptance: zero diffs beyond timing skew (the two feeds
   trigger at different moments; compare only when both carry the same
   `generated_at`/`book_version` era).
3. Flip the overlay read models to `ncd_*` (§6.2 PR). Watch a further 2–3 days.

**Phase R (retirement):**

- **Notwo:** delete `overlay/sharepoint.ts`, `autosync.ts`, `autosync-state.ts`,
  the manual-upload route + `SHAREPOINT_*`/`OVERLAY_AUTOSYNC_*` config; drop the
  `ext_*` snapshot tables (migration). Keep `ext_person_links`,
  `ext_investment_dupes`, `people.ts`.
- **NCD:** delete `api/src/integrations/ncd-extract-publish.ts`, its 30s cron
  block in `api/src/index.ts` (~:132–140), and the `extract_publish_state`
  usage (table can stay or be dropped in the same migration).
  `api/src/scripts/daily-extract.ts` is removed **only if** Notwo was its sole
  consumer — its header says the workbook also serves a Power BI / Excel
  dashboard (Open decision #3). If another consumer exists, the nightly CLI
  stays and only the on-change publisher goes.
- Rotate/retire the SharePoint app registration's client secret once nothing
  reads the folder.

---

## 8. Phasing — reviewable PRs, in order

Each PR is independently shippable, CI-green, and per the house rule stops for
the owner's batch-merge. Reuse over rewrite throughout: the export router
wraps existing report functions; the puller copies the autosync's shape; the
UI edits existing pages.

| # | Repo | PR | Contents |
|---|---|---|---|
| 1 | NCD | `feat(export-api): versioned read-only export surface (stage 1)` | `modules/integration/export.ts` — manifest, summary, customers, investments; keyset pagination + `updated_since`; contract tests (incl. "router has no non-GET routes" and a field-allowlist test that fails if a new column leaks). |
| 2 | NCD | `feat(export-api): book resources (stage 2)` | series, redemptions, staff, agents, incentives (+`ia.id` in `accrualsForExtract`), interest query endpoint. |
| 3 | NCD | `feat(export-api): locker feed, rent-only (stage 3)` | `/lockers` + `/locker-cheques` over `lockerTenants()`; `roster_complete` semantics; tests with a stubbed LockerHub. |
| 4 | Notwo | `feat(ncd-sync): tables + puller` | Migration 057, `ncdsync` module (client/puller/status routes), comparison report, config. No UI change; runs alongside SharePoint autosync. |
| 5 | Notwo | `feat(ncd-sync): overlay reads from synced tables` | Swap `ext_*` reads → `ncd_*`; response shapes unchanged; dashboard freshness from `ncd_sync_state`. |
| 6 | Notwo | `feat(customers): combined PAN-linked view` | Segments All/NCD/Notwo/Linked; linked customer detail. |
| 7 | Notwo | `feat(lockers): read-only locker view` | `Lockers.tsx` + list endpoint + export. |
| 8 | both | `chore: retire the SharePoint dump path` | Phase R deletions (gated on the parallel-run sign-off + Open decision #3). |

PRs 1–3 and 4 can proceed in parallel once PR 1's response shapes are agreed
(they are specified in §3, so PR 4 can be built against fixtures).

---

## 9. Open decisions (owner's call)

1. **Full PAN over the export API.** PAN-only linking requires it (the dump
   deliberately masks PAN — daily-extract.ts:15–18 — but that decision was
   about a file at rest in SharePoint; this is key-gated server-to-server
   HTTPS). Alternative if full PAN must not travel: both sides exchange
   `HMAC(shared_secret, pan)` and link on the hash — costs a small amount of
   complexity and makes eyeball-debugging links harder. **Recommended: full
   PAN. Needs an explicit yes.**
2. **Own key for Notwo.** `requireIntegrationKey` currently checks the single
   `LOCKERHUB_INTEGRATION_KEY`. Sharing it means revoking LockerHub also cuts
   off Notwo (and vice versa). Recommended: add `NOTWO_INTEGRATION_KEY` and
   have the middleware accept either (a 5-line change), so keys rotate
   independently.
3. **Fate of the workbook/CSV extract.** Is Notwo the only consumer of the
   SharePoint folder, or does the owner's Power BI / Excel dashboard read it
   too? Determines whether PR 8 deletes `daily-extract.ts` outright or keeps
   the nightly CLI and deletes only the on-change publisher.
4. **Rent figure of record.** Fill `locker_pricing.annual_rent` per size in
   Masters (making NCD the rent authority on the feed), or accept the
   LockerHub-sourced per-tenant figure with nulls where their lookup fails?
5. **Interest ledger replication.** v1 serves `/export/v1/interest` for
   queries but Notwo does not store the ~43k rows (matches today's behaviour —
   totals come from `summary`). Confirm that stays acceptable, or schedule a
   later phase for per-payout drill-down in Notwo.
6. **UI label.** Keep Notwo's "A/c" label for NCD-sourced data, or rename to
   "NCD" while touching those pages anyway?
7. **Cadence.** Puller every 120s + nightly 02:00 IST full reconcile — confirm
   or adjust.

---

*Plain-English summary:* Today NCD writes an Excel dump to SharePoint and
Notwo polls the folder and copies it into shadow tables. This design replaces
that with NCD answering a small set of password-protected, read-only web
addresses — the same numbers, straight from the same report code — and Notwo
fetching them every couple of minutes into its own tables, updating rows in
place instead of wiping. Lockers join the feed (rent and tenancy only, no
deposits), Notwo gets a view-only lockers page, and customers who share a PAN
across the two apps are shown side by side as one linked person. If either app
goes down, the other keeps working from its own data. After both pipes run in
parallel and match for a week, the SharePoint pieces are deleted.
