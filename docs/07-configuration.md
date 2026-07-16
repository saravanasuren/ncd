# 07 — Configuration: the Settings Registry

Owner requirement (verbatim intent): *the entire application should be data-driven;
any business value should be configurable and customizable in the UI under Admin
settings — interest rates for new series, incentive percentages for staff/agents
(flat value or percentage), etc. No hardcoded values and no hardcoded data across
the application.*

## 1. Two kinds of "configurable"

1. **Master data** — has its own tables + CRUD screens: schemes (rates, tenures,
   face values), series, TDS rules, banks, branches, holidays, company profile,
   districts list. Rates for a *new series* are entered when creating the
   scheme/series — never in code.
2. **The settings registry** (`app_settings` table) — scalar/structured knobs that
   would otherwise be constants. Everything below ships as a **seeded default** and
   is editable at Admin → Settings.

## 2. Settings registry design

```ts
// packages/shared/settings.ts — the typed catalog (single source of truth)
type SettingDef<T> = {
  key: string;            // 'incentive.staff_self_sourced'
  group: string;          // 'Incentives' — drives the UI grouping
  label: string; description: string;
  schema: ZodType<T>;     // validated on write
  default: T;
  editableBy: 'admin' | 'workflow';  // workflow = NCD Manager may edit too (doc 03)
}
```

- DB stores `{key, value JSONB}`; the catalog supplies type/validation/UI metadata.
- API: `GET /settings` (grouped), `PUT /settings/:key` (zod-validated, audited with
  before/after). Server caches with a short TTL + bust-on-write.
- **Rate values that can be flat-or-percent use one shape everywhere:**
  `{ mode: 'pct' | 'flat', value: number }` — the incentive engine resolves
  `pct → amount × value/100`, `flat → value`.
- Changing a setting affects **future computations only** — anything money-related
  is snapshotted onto rows at creation (TDS rate, incentive rate, matrix cell), so
  history never silently rewrites. This rule is contract.

## 3. Seeded settings catalog (initial groups/keys — defaults mirror today's live behaviour)

| Group | Key | Default | Notes |
|---|---|---|---|
| Interest engine | `interest.payout_day_of_month` | **28** | owner-confirmed 2026-07-16; holiday-adjusted backward |
| | `interest.day_count_convention` | **'Actual365'** | actual days/365 every period (29th→28th); enum: Actual365 \| Thirty360 \| Actual360 \| ActualActual. Overridable per-scheme via `schemes.day_count_convention` |
| | `interest.broken_first_period` | 'actual-days receipt→28th' | first partial period from money-received date to next 28th ÷ 365 |
| Incentives | `incentive.staff_new_no_referrer` | {pct, 2.0} | matrix cell 1 |
| | `incentive.referrer_new_with_referrer` | {pct, 2.0} | cell 2 |
| | `incentive.staff_existing_no_referrer` | {pct, 2.0} | cell 3 |
| | `incentive.staff_existing_with_referrer` | {pct, 0.25} | cell 4 |
| | `incentive.agent_commission_cap_pct` | 2.0 | eligibility cap |
| | `incentive.payout_modes` | [OneTime, Monthly12, Monthly24] | |
| Redemptions | `redemption.premature_penalty` | {pct, 1.0} | |
| | `redemption.broken_interest_separate` | true | pay next cycle, not in Net |
| Approvals | `approvals.chains` | per-type levels + checker roles (doc 03 §4 defaults) | |
| | `approvals.premature_l2_role` | 'cxo' | **confirmed by owner 2026-07-16** — CXO approves premature redemptions at L2 (admin remains fallback when no active CXO) |
| Numbering | `numbering.customer_format` | 'DHN{seq:6}' | + one key per entity (APP/DSB/COL/ROL/TRF/MCR) |
| Customers | `customers.max_joint_holders` | 2 | |
| | `customers.districts` | seeded TN list | editable list |
| | `customers.lead_sources` / `lead_statuses` | today's vocab | editable lists |
| | `customers.collection_methods` | NEFT/IMPS/RTGS/Cheque/Cash/Other | |
| Portal | `portal.statement_display_cutoff` | 2026-06-19 | customer-facing lists |
| | `portal.otp_ttl_minutes` / `otp_max_attempts` / `otp_rate_limit` | 10 / 5 / 3-per-5min | |
| Documents | `documents.bond_serial_format` | 'BC-{yyyy}-{seq:6}' | |
| | `documents.soa_footer`, `pdf.toll_free`, `pdf.whatsapp_number`, `pdf.corporate_address` | today's values | all PDF strings |
| Notifications | `notifications.from_email` / `reply_to` | contact@dhanam.finance | |
| | `notifications.whatsapp_templates` | {acknowledgment: 'ncd_akn', interest: 'ncd_interest_final'} | |
| | `notifications.daily_summary_recipients` | role-based list | |
| System | `system.api_page_limit_max` | 500 | |
| | `system.rate_limits` | per-endpoint-class table | |
| | `system.backup_alert_recipients` | admins | |
| Branding | `brand.legal_name` etc. | via company_profile (link from Settings UI) | |

(Catalog grows during the build — the rule is: **any literal business value in code
must be a catalog key.** Code review checklist item.)

## 4. Admin → Settings UI

- Left: group list. Right: settings as cards — label, description, current value,
  typed editor (number, pct/flat toggle+number, enum, list editor, JSON editor for
  chains with a guided form), Save per card.
- Every change shows "was X → now Y" confirm + writes audit.
- `editableBy: workflow` settings (series-adjacent, incentive rates, penalty) are
  also visible to NCD Manager under a slimmer "Workflow settings" screen; system/
  security groups are Admin-only; destructive/format changes (numbering) Super
  Admin-only with typed confirm.
- A "Restore default" affordance per setting (defaults come from the catalog).
