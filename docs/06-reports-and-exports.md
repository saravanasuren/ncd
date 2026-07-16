# 06 — Dashboard, Reports & the Owner's Excel Export

> Confidentiality: the owner's reference spreadsheet/screenshots are sensitive.
> This doc records **structure only** (groupings, columns, formats) — no real names
> or amounts. Builder must use synthetic data in all fixtures.

## 1. Data foundation

All of this reads the SQL views of doc 02 §8 with one shared filter object:

```ts
type BookFilters = {
  from?: ISODate; to?: ISODate;        // month range
  seriesIds?: number[];                // e.g. only the ongoing series
  branchIds?: number[]; districts?: string[];
  agentIds?: number[]; staffUserIds?: number[];
  status?: 'active' | 'redeemed' | 'all';
}
```

Dashboard widgets, the Segments explorer, and the Excel export all take
`BookFilters` + the caller's RBAC `Scope` — **what you export always equals what
you see.**

## 2. Dashboard (per-role variants)

**CXO / Admin / NCD Manager — "NCD Portfolio"** (parity with today's dashboard-v2):
- KPI strip: Outstanding NCD book, Active investors, Interest paid FY, Interest
  accrued, Net due this month, Overdue, DhanamFin-app investments, Locker deposits
  (excluded from NCD principal via the `is_locker_deposit` totals rule 🔌).
- **Today's book:** additions (split: DhanamFin app vs physical) + deletions, each
  with per-item lists.
- **Monthly flows:** money-in vs money-out by month; **monthly redemptions table —
  every row clickable → that month's redemptions (customer/series/amount/date/type,
  partial redemptions labelled "Partial")**.
- Series register (per series: rate min/max, outstanding, investor count, status).
- Cost-of-funds rate mix (full outstanding set). District distribution map/table.
- Universal search. Every number drills down in-page (doc 05 §2).
- CXO sees exactly this + Reports/Segments — **no action buttons anywhere**.

**Branch Manager:** same widgets, scoped to selected branches (branch switcher).
**Branch Staff / Agent — "My book":** own customers, own pipeline (stage strip),
own earnings summary, follow-ups due.

## 3. 🔒 The owner's Excel export — `GET /reports/ncd-book.xlsx`

One workbook, **9 tabs, in this order — all layouts confirmed against the owner's
reference workbook (2026-07-16)**. Generated server-side with `exceljs` (styled
headers, merged group cells, frozen panes, Indian number format `#,##,##0.00`,
subtotal rows shaded). Filters + scope applied to every tab identically; a small
"Applied filters" note goes in each tab's top-right so a printed sheet is
self-describing.

### Tab 1 — "Ongoing NCD"
Pivot of the **current open/collecting series** (default: series with status
Open/Closing; selectable via filters).
- Row axis, 3 levels: **NCD Series → Agent (code/name) → Customer name**.
- Column axis: **one column per month** in the range (e.g. Jun, Jul) under a
  "Date – Month" header, + **Grand Total**.
- Values: SUM of application amount received that month.
- Subtotal row per agent ("<Agent> Total", shaded) and grand total per series.

### Tab 2 — "NCD Summary" (confirmed layout)
Pivot over the **whole book**, one row per series (including rollover series,
e.g. "NCD 05 Rollover" … newest):
- Columns: **Trans Type → `Issue` | `Redemption` | `(blank)` | `Grand Total`**.
- Values: SUM of amount; Issue positive, **Redemption negative**; `(blank)` holds
  typeless adjustment rows (present in the reference — keep the column even when 0).
- **Grand Total row** at the bottom summing every column.

### Tab 3 — "Master Client" (confirmed layout)
Flat filterable register, one row per client, columns **in this order**:
**PAN | Sl. No | Agent Code | Name | Father Name | Address** (full single-cell
address). Header row with autofilter. PAN masked/unmasked per the caller's
permission ⚙. (The new app can append extra columns — customer code, phone,
district, KYC status — AFTER the reference columns; never before or between.)

### Tab 4 — "Redemption" (confirmed layout)
Chronological redemption register:
- Columns: **Date | Trans Type | NCD Series | Name | SUM of Amount**.
- Rows grouped by **redemption date** (DD/MM/YYYY); a date group may hold several
  series/customer rows; **"Redemption Total" subtotal row per date group**.
- Amounts **negative** (money out).
- Covers maturity + premature + partial (typed), matching the dashboard monthly
  redemptions.

### Tab 5 — "Depositorwise" (confirmed layout)
One row per depositor: **Name | SUM of Amount** (net position per the filter set),
alphabetical, grand total. Zero-balance depositors included (they show 0.00).

### Tab 6 — "Districtwise" (owner request 2026-07-16)
Same grouped-pivot pattern as Agent wise: **District → customer Name → SUM of
Amount**, subtotal row per district ("<District> Total", shaded), grand total.
Customers with no district land under an "Unassigned" group (visible, so data gaps
get fixed).

### Tab 7 — "Agent wise" (confirmed layout)
Pivot with a **series filter header row** ("NCD Series: (Multiple Items / All)"
reflecting the applied filter):
- Rows: **Agent Code → customer Name**; value **SUM of Amount**.
- Subtotal per agent ("<Agent> Total"), grand total at bottom.
- Direct (agent-less) business appears under a "Direct" group.

### Tab 8 — "Staff wise" (owner request 2026-07-16)
Identical pattern to Agent wise but grouped by **enrolling Branch Staff**:
**Staff (branch) → customer Name → SUM of Amount**, subtotal per staff, grand
total. Respects the caller's scope (a Branch Manager gets only their branches).

### Tab 9 — "Leads" (owner request 2026-07-16)
All leads **grouped by lead status** (status vocab ⚙):
- Group header per status; rows: lead name, phone (masked ⚙), place/district,
  source, interested series/scheme, expected amount, created by (staff/agent),
  follow-up date, created date.
- Subtotal per status group: **count + Σ expected amount**; grand-total row.
- Scope-filtered like everything else (staff/agent exports contain own leads only).

**Acceptance test:** for a synthetic fixture book, tab totals must reconcile with
each other (Σ Depositorwise = Σ Districtwise = Σ Agent wise + Staff wise overlap
rule documented in the test = NCD Summary grand total; Redemption tab Σ = NCD
Summary redemption column) and with the dashboard KPIs under the same filters.
Note Agent-wise and Staff-wise cover the same book from two lenses — an
application enrolled by an agent appears in Agent wise, one enrolled by staff in
Staff wise; the union equals the book, and the acceptance test asserts exactly that.

## 4. Segments explorer (+ segment exports)

Owner requirement: *data segregated customer-wise, district-wise, agent-wise,
staff-wise.* One screen, four tabs — each is a grouped table over the same views:

| Segment | Columns (rows expand → underlying customers/applications) |
|---|---|
| **Customer-wise** | customer, district, agent/staff, invested, redeemed, outstanding, # NCDs, next payout |
| **District-wise** | district, investors, invested, redeemed, outstanding, % of book |
| **Agent-wise** | agent, investors, production (range-filtered), outstanding, commission owed |
| **Staff-wise** | staff (branch), investors, production, outstanding, incentive owed |

Each tab: filter bar (`BookFilters`), drill-down rows, and **Download XLSX** of the
current tab + filters. The 9-tab book export is also downloadable from here with
the same filter bar.

## 5. Other reports (parity)

SOA per customer (PDF, staff = full history; customer-facing lists respect the
display-cutoff setting ⚙ while aggregates stay full) · Interest & TDS Register XLSX
(17-column filing layout, from/to range, one row per holder per due month, single
active bank account per row) · TDS month XLSX + 26Q support (Form 16A: deliberately
not issued — screen points to TRACES; deductor prints TAN-holder legal name ⚙) ·
series-wise rollup XLSX · full DB dump XLSX (Admin) · redemption report XLSX ·
staff-incentive PDF statement · Federal-Bank NEFT sheet + redemption NEFT sheet
(formats preserved byte-compatible — banks parse them).
