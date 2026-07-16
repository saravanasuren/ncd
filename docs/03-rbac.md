# 03 — Roles, Permissions & Data Scoping

Eight roles, exactly as specified by the owner (2026-07-16). Legacy roles
(wealth_manager, finance, reports_manager, ho_admin) do not exist here; their users
are mapped to one of these at migration (doc 09).

## 1. The 8 roles

| # | Role | One-line charter |
|---|---|---|
| 1 | **Super Admin** | Everything, including **delete** and destructive ops (revert allotment, purge). |
| 2 | **Admin** | Everything Super Admin has **except delete/destructive ops**. Owns user management, settings, system config. |
| 3 | **CXO** | **Read-only data + dashboards + report downloads.** No workflow access — no create/convert/allot buttons anywhere — with **one confirmed exception: CXO is the level-2 approver for premature redemptions** (owner decision 2026-07-16). Sees: overall NCDs, current series, redemptions (overall + current), staff-wise and agent-wise NCD data, all drill-downs, the 9-tab Excel export. |
| 4 | **NCD Manager** | Full operational workflow: leads → customer → application → collection → eSign → allotment, plus series/scheme management, plus **checker** on approvals (never own submissions). Sees ALL leads and ALL applications (any stage, any creator). Their queue = everything Branch Staff/Agents hand over. |
| 5 | **Branch Manager** | Branch Staff powers + visibility over **all staff of their assigned branches** (multi-branch via `user_branches`). A branch selector filters their world to selected branch(es). |
| 6 | **Branch Staff** | Create leads, convert to customer, complete application through collection-ready, then it lands in NCD Manager's queue. Sees **only their own** customers/leads/applications. |
| 7 | **Agent** | Same powers and scope as Branch Staff but **not tied to a branch**; can self-signup via DhanamFin app (registration goes through an approval queue). Earns commission per the eligibility/matrix rules. |
| 8 | **Customer** | Portal only: own holdings, payouts, documents, service requests. |

**Admin + NCD Manager are the only roles with "full system" reach** — Admin on the
administration side (users, settings, masters), NCD Manager on the business-workflow
side (series, applications, allotments, approvals). Everyone else sees only the data
and workflows applicable to them — screens they can't use simply don't render.

## 2. Data scope (enforced in repos, mirrored in UI)

| Role | Customer/application/lead visibility |
|---|---|
| Super Admin, Admin, CXO, NCD Manager | Whole book |
| Branch Manager | Rows whose `branch_id ∈ their user_branches` (plus their own rows) |
| Branch Staff | `enrolled_by_user_id = self` |
| Agent | `enrolled_by_agent_id = self` (branch-less) |
| Customer | `customer_id = self` |

Every scoped repo function takes a `Scope` argument built by middleware from the
JWT — a repo without it fails typecheck. Scope is **also** applied to dashboards,
drill-downs, exports and search (a Branch Manager's Excel export contains only their
branches).

## 3. Permission catalog (shared/permissions.ts — seed for role_permissions)

Format `resource:action`. ✔ = granted. SA=Super Admin, A=Admin, CXO, NM=NCD Manager,
BM=Branch Manager, BS=Branch Staff, AG=Agent, CU=Customer.

| Permission | SA | A | CXO | NM | BM | BS | AG | CU |
|---|---|---|---|---|---|---|---|---|
| leads:create/read/update | ✔ | ✔ | – | ✔ | ✔ | ✔ | ✔ | – |
| leads:read-all | ✔ | ✔ | – | ✔ | – | – | – | – |
| leads:convert | ✔ | ✔ | – | ✔ | ✔ | ✔ | ✔ | – |
| customers:create/update | ✔ | ✔ | – | ✔ | ✔ | ✔ | ✔ | – |
| customers:read (scoped) | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | own |
| customers:delete / deactivate | ✔ | – | – | – | – | – | – | – |
| customers:correction-request | ✔ | ✔ | – | ✔ | ✔ | ✔ | ✔ | – |
| customers:handover-request | ✔ | ✔ | – | ✔ | ✔ | ✔ | ✔ | – |
| kyc:verify/reject | ✔ | ✔ | – | ✔ | ✔ | ✔ | ✔ | – |
| applications:create/update | ✔ | ✔ | – | ✔ | ✔ | ✔ | ✔ | – |
| applications:confirm-collection | ✔ | ✔ | – | ✔ | – | – | – | – |
| applications:mark-esigned | ✔ | ✔ | – | ✔ | – | – | – | – |
| allotments:execute (maker) | ✔ | ✔ | – | ✔ | – | – | – | – |
| allotments:revert | ✔ | – | – | – | – | – | – | – |
| series/schemes:manage | ✔ | ✔ | – | ✔ | – | – | – | – |
| redemptions:initiate (maker) | ✔ | ✔ | – | ✔ | – | – | – | – |
| payouts:generate (maker) | ✔ | ✔ | – | ✔ | – | – | – | – |
| payouts:mark-paid-manual | ✔ | ✔ | – | – | – | – | – | – |
| approvals:check (never own) | ✔ | ✔ | – | ✔ | – | – | – | – |
| approvals:check-premature (L2) | ✔ | fallback | ✔ | – | – | – | – | – |
| incentives:manage-eligibility | ✔ | ✔ | – | ✔ | – | – | – | – |
| incentives:pay | ✔ | ✔ | – | – | – | – | – | – |
| earnings:read-own | ✔ | ✔ | – | ✔ | ✔ | ✔ | ✔ | – |
| dashboard:view (scoped) | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | – |
| dashboard:drilldown | ✔ | ✔ | ✔ | ✔ | ✔ | – | – | – |
| reports:download (scoped) | ✔ | ✔ | ✔ | ✔ | ✔ | – | – | – |
| users:manage | ✔ | ✔ | – | – | – | – | – | – |
| users:delete | ✔ | – | – | – | – | – | – | – |
| settings:manage | ✔ | ✔ | – | – | – | – | – | – |
| settings:workflow-config (series rates, TDS, incentive %) | ✔ | ✔ | – | ✔ | – | – | – | – |
| audit:read | ✔ | ✔ | – | – | – | – | – | – |
| imports:run | ✔ | ✔ | – | ✔ | – | – | – | – |
| notifications:admin | ✔ | ✔ | – | – | – | – | – | – |
| portal:self-service | – | – | – | – | – | – | – | ✔ |

(Any endpoint not listed inherits the module default in doc 04; builder adds new
permissions to the catalog, never ad-hoc role checks in route code.)

## 4. Approval chains (maker-checker) ⚙

- **Rule zero (locked): the approver of any level must be a different user than the
  maker AND different from every lower level's approver.** Enforced in the approvals
  service; no role exemption (not even Super Admin).
- Chains are config (doc 07): per request-type → number of levels + eligible checker
  roles per level. Defaults, mirroring today's live behaviour:

**Old-app parity (2026-07-16): every approval is maker → a SINGLE checker** —
the old app uses a flat maker+one-checker model for every type, and the new app
matches it (no 2-checker chains). "Checker actions" below = number of approvals.

| Request type | Checker actions | Checker(s) |
|---|---|---|
| Subscription (application-creation gate — optional, off by default) | 1 | NCD Manager, Admin |
| Allotment batch | 1 | Admin, Super Admin |
| Premature redemption | 1 | **CXO** (`approvals:check-premature`; Admin fallback). CXO's single action power. |
| Maturity redemption | 1 | NCD Manager, Admin |
| Interest / payroll NEFT batch | 1 | Admin |
| Commission / incentive / referrer eligibility | 1 | Admin |
| Customer creation / correction / profile change | 1 | NCD Manager, Admin |
| Customer handover | 1 | requester's reports-to, else NCD Manager/Admin |
| Agent registration (DhanamFin signup) | 1 | NCD Manager, Admin |
| NCD transfer / transformation | 1 | NCD Manager, Admin |

The application-creation gate is a setting (`approvals.subscription_maker_checker`,
off by default). When on, a new application waits in `PendingApproval` until the
subscription approval clears, then advances to `PendingFundVerification` (the
post-approval, pre-eSign collection state — named to match the old app).

- Branch Staff/Agent submissions (completed applications) appear in the **NCD
  Manager queue** — this is the owner's explicit handoff requirement.

## 5. UI consequences (doc 05 enforces)

- Navigation is generated from permissions — CXO sees Dashboard + Reports/Segments
  + an Approvals item scoped to premature redemptions only (badge-counted);
  Customer sees only the portal; a Branch Staff never sees Approvals/Allotments/
  Payouts/Settings.
- Buttons the user can't use are **absent**, not disabled (except where an
  explanatory lock is helpful, e.g. "awaiting NCD Manager approval").
- The API is the real gate; the UI is a mirror. Both read the same permission
  catalog.
