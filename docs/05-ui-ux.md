# 05 — UI / UX Specification

Goal (owner's words): clean, neat, professional, elegant; not cluttered; everything
easily accessible; nothing buried inside screens. Visual reference:
**reports.dhanamfinance.com**.

## 1. Design tokens (extracted from the reference site)

```css
/* styles/tokens.css — single source; Tailwind config maps to these */
--bg:            #f7f8fa;   /* app background (light grey) */
--surface:       #ffffff;   /* cards, tables, modals */
--border:        #e4e7ec;   /* hairline borders */
--border-strong: #d0d5dd;   /* inputs */
--text:          #1a1d23;   /* primary text */
--text-muted:    #6b7380;   /* secondary text */
--text-label:    #4a5260;   /* form labels, table headers */
--primary:       #0b5cab;   /* THE accent — Dhanam blue */
--primary-hover: #0a4f95;
--primary-ring:  rgba(11, 92, 171, .15);
--success:       #1a7f4b;  --warn: #b3730d;  --danger: #c23838;
--danger-bg:     #fdecec;  --success-bg: #e8f5ee;  --warn-bg: #fdf3e3;
--radius:        8px;      --radius-lg: 12px;
--shadow:        0 1px 2px rgba(16,24,40,.05);
--font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
--font-mono:     ui-monospace, SFMono-Regular, Menlo, monospace;  /* amounts, codes */
```

Rules: **one accent colour** (blue) — status pills are the only other colour. White
cards on light-grey background, 1px `--border` hairlines, `--radius-lg` cards /
`--radius` controls, generous whitespace (24px card padding, 16px gaps). No
gradients, no shadows heavier than `--shadow`, no gold/navy carry-over from the old
app. Amounts right-aligned in mono with Indian grouping (₹12,34,567.00). Dhanam logo
top-left of the shell.

Density: tables at 13px/36px rows (data-dense but airy); forms at 14px. Every screen
must look correct at 1280×800 and remain usable at 1024 (sidebar collapses to icons).

## 2. App shell

```
┌────────┬──────────────────────────────────────────────┐
│        │  Topbar: [page title]     [Universal search]  │
│  Side  │                     [+ New ▾] [🔔] [user ▾]   │
│  bar   ├──────────────────────────────────────────────┤
│ (nav)  │  Content: cards / tables / drill popups       │
└────────┴──────────────────────────────────────────────┘
```

- **Sidebar** (permission-generated, doc 03): flat list, small group headers, badge
  counts on Approvals/Queue. Collapsible.
- **Universal search** (⌘K + topbar box): customers, applications, agents, staff,
  leads — jump anywhere in ≤ 2 keystrokes. This is the primary "nothing is buried"
  mechanism.
- **"+ New" button**: context menu of the user's creatable objects (Lead, Customer,
  Application…) from anywhere.
- **Drill-down pattern:** every dashboard number and report row opens an **in-page
  popup/side-panel** (never a page navigation) with the underlying rows + an export
  button. Popups are stackable one level and deep-linkable (`?drill=`).
- **Customer 360 page** is the hub: profile, KYC, bank accounts, nominees, all
  applications with schedules, documents, earnings-relevant referrals, timeline of
  audit events — tabs within one page, so staff never hunt across screens.

## 3. Screen inventory (~25 screens; nav per role via doc 03)

| # | Screen | Primary roles | Notes |
|---|---|---|---|
| 1 | Login / forgot-password | all staff | card style = reference site |
| 2 | **Dashboard** | SA A CXO NM BM (scoped: BS AG get "My book" variant) | doc 06 §2 |
| 3 | Leads | BS AG BM NM A SA | table + kanban-ish status filter chips; convert flow |
| 4 | Customers (list) | scoped | filters: status/series/branch/district/KYC; locked-customers panel for BS/AG with handover request |
| 5 | Customer 360 | scoped | the hub (above) |
| 6 | New customer wizard | BS AG BM NM A SA | multi-step, draft/resume, penny-drop + KYC inline |
| 7 | Applications (list) | scoped | stage chips: Draft/Collection/eSign/Allotment/Active |
| 8 | Application detail | scoped | lines, schedule (grouped by month, overdue red), receipt, PDFs, timeline |
| 9 | New application | BS AG BM NM A SA | scheme grid, clubbing prompt, receipt upload, payout-account picker |
| 10 | Series & Schemes | NM A SA | lifecycle actions, launch, ISIN, per-series face value ⚙ |
| 11 | Allotments | NM A SA | per-series pending counts → batch allot (maker) |
| 12 | **Approvals** | NM A SA (+CXO only if premature-L2 kept) | tabs per type, badges, re-confirm modals; own submissions greyed "awaiting another checker" |
| 13 | Redemptions | NM A SA | list + initiate (preview math), NEFT sheet, UTR, report |
| 14 | Payouts (NEFT) | NM(maker) A SA | preview → batch → download → reconcile; statement upload + matching |
| 15 | Incentives & Commissions | NM A SA | matrix settings link, eligibilities, referrers, balances + pay |
| 16 | Performance — Agents | CXO NM A SA (AG: own) | production table + owed drill |
| 17 | Performance — Staff | CXO NM A SA BM(branch) (BS: own) | same pattern |
| 18 | My Earnings | BS AG BM NM | own accruals, payouts, balance |
| 19 | **Reports** | CXO NM A SA BM | card per report incl. the 9-tab NCD book export with filter bar (doc 06 §3) |
| 20 | Segments | CXO NM A SA BM | customer/district/agent/staff-wise explorer (doc 06 §4) |
| 21 | Users & Branches | A SA | user CRUD, role assign, branch multi-assign, reports-to |
| 22 | Settings | A SA (workflow subset: NM) | doc 07 UI |
| 23 | System | A SA | audit browser, notification queue, cron runs, imports |
| 24 | Transfers & Transformations | NM A SA | NCD transfer, death/nominee workflow |
| 25 | Portal (customer): login/OTP, dashboard, holdings, payouts, documents, requests | CU | separate `PortalShell`, same tokens, mobile-first |

Old app's 40 pages collapse into these via tabs (Customer 360) and popups
(drill-downs) — feature parity per doc 00, but ≤ 2 clicks to anything.

## 4. UX standards (every screen)

- Loading skeletons, empty states with a next-action hint, inline error states with
  retry. No dead ends.
- Tables: sticky header, column sort, quick filter, CSV/XLSX export of *current
  filtered view*, pagination; row count + Σ amount in the footer where money.
- Forms: single-column, sectioned cards, inline validation messages, dirty-guard on
  navigate-away, keyboard submit. Destructive/irreversible actions get typed-confirm
  modals with the re-confirm details pattern (redemption date, amounts) from today.
- Status pills: one shared component mapping the state-machine vocab → colours.
- PAN/phone masked by default with reveal-on-click (permission-gated + audited).
- All times IST; all dates `DD MMM YYYY` in UI, ISO in exports.
- Accessibility: focus rings (`--primary-ring`), 4.5:1 contrast, full keyboard nav.
- Mobile: staff app is desktop-first but must degrade gracefully; the customer
  portal is mobile-first.
