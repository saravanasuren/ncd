# 09 — Data Migration (old `dhanam_wealth` → new `dhanam_newwealth`)

Runs **after** the new app is built and verified with synthetic data. The old app
stays live and untouched throughout; migration reads the old DB (or a pg_dump
restore) **read-only**.

## 1. Strategy

- One ETL tool at `ops/migrate-from-legacy/` (TypeScript, runs on the box or a Mac
  with tunnel): `extract → transform → load → reconcile`, restartable per domain,
  every run logged to `import_batches`.
- **Dry-run first** against a restored backup; produce a reconciliation report;
  only then run against a fresh dump at cutover.
- ID strategy: new surrogate ids; every migrated row keeps `legacy_id` +
  `legacy_table` columns (dropped later) so anything can be traced back.

## 2. Mapping highlights (old → new)

| Old | New | Notes |
|---|---|---|
| `users` + `roles` (12) | `users` + 8 roles | wealth_manager → **ncd_manager**; finance / reports_manager / ho_admin → owner decides per user at migration (mapping CSV reviewed by owner before load — default admin for finance, cxo for reports_manager) |
| `agents` (+ LockerHub agent users) | `agents` + linked `users(role=agent)` | keep agent_code, lockerhub ids 🔌 |
| `customers` + flat bank cols + `customer_bank_accounts` | `customers` + `customer_bank_accounts` | district **required** in new model — backfill from city/state where derivable; unresolved → owner review list |
| `applications`/`application_lines`/`collections` | same names | statuses map 1:1 (state vocab unchanged); keep `customer_was_new_at_creation` verbatim — never re-derive |
| `disbursement_schedule` | same | **Paid rows through June 2026 are FROZEN** — copied row-for-row (TDS snapshots, UTRs, bank snapshots), never recomputed. **Future/unpaid rows are RE-MATERIALISED** on the new convention for ALL investments (existing + new) — see the cutover interest rule below. |

**🔒 Interest cutover rule (owner-confirmed 2026-07-16).** Already-paid interest up
to and including **June 2026 stays exactly as is** (frozen, copied). From **July 2026
onward, every investment — existing and new — is calculated on the new Actual365/28th
convention**, with the **July payout covering the period 29 June → 28 July 2026**, and
each subsequent 28th thereafter. Migration therefore: (1) copies all Paid rows dated
≤ June 2026; (2) drops any old-convention unpaid/future rows; (3) re-materialises each
still-Active line's schedule from the 29 Jun → 28 Jul 2026 period forward, using the
line's principal/rate/tenure and its existing `interest_start_date` only to anchor
maturity. **Seam note:** the last old-rule paid period (30th-based) may overlap the
29 Jun–28 Jul period by a day or two — flag any per-line overlap/gap in the
reconciliation report for owner review; do not silently absorb it. A settings key
`interest.cutover_from` = `2026-07-01` (⚙) marks the boundary so the re-materialiser
and any audit query share one date.
| `payout_batches`, accrual tables, `incentive_payouts`, `referrer_*` | doc 02 §5 tables | paid rows immutable; referrers re-normalised by the same name-normalisation rule |
| `approval_requests` | `approval_requests` | historical chains copied as-is (metadata JSONB) for audit continuity |
| `investor_leads`, notes | `investor_leads`, `lead_notes` | keep admin_only + source vocab |
| `audit_log`, `notifications_log` | `audit_log`, `notifications_queue` (status=sent) | history preserved |
| `app_settings` (flags + incentive keys) | settings registry keys | map old keys → new catalog keys (doc 07) |
| GL/compliance/grievance tables | **not migrated** (doc 01 §5) unless owner opts in — export to archive XLSX instead |
| Uploaded files `/var/lib/dhanam/**` | `/var/lib/dhanam-newwealth/**` | rsync + path rewrite in `customer_documents`/receipts |

## 3. Reconciliation gates (must all pass before cutover)

1. **Per-series totals** — invested / redeemed / outstanding per series equal old
   DB and the owner's master Excel pivot (the old repo's `series-totals-now.sql`
   technique).
2. Row counts per mapped table ± documented exclusions.
3. Σ Paid disbursements (gross/tds/net) identical to the paisa.
4. Incentive/commission owed balances per payee identical.
5. Spot-check N random customers end-to-end (holdings, schedule, documents) —
   owner signs off.
6. The 9-tab Excel export from the new app matches the owner's known-good numbers.

## 4. Cutover sequence (joint with LockerHub team)

1. Freeze writes on old app (announce window) → final pg_dump.
2. Run ETL + reconciliation gates on the box.
3. Rsync uploaded files.
4. Rotate integration keys into `/dhanam/newwealth/*`; LockerHub flips base URL
   (their staging already validated per doc 08 §3).
5. DNS/nginx: new subdomain live; old app remains up **read-only** (banner) for a
   2-week parallel-verify window, then decommission decision.
6. Rollback plan: LockerHub flips base URL back; old app un-freezes. (New-app
   writes during the window would be lost — keep the window short and verified.)
