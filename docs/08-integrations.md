# 08 — External Integrations (contracts preserved)

Owner requirement: **keep the API integrations intact** — the new app must serve the
same external consumers with zero changes on their side. The authoritative legacy
specs live in the old repo: `LockerHub-Integration-API.md`, `LockerHub-PennyDrop-V3.md`,
`DhanamFin-KYC-Integration.md`, `Integrations-Reference.md` (read-only reference —
port, don't link).

## 1. LockerHub / DhanamFin app 🔌 (the big one)

- **Auth model unchanged:** shared integration key (SSM `LOCKERHUB_INTEGRATION_KEY`)
  via the same header; same rate-limiting posture.
- **Mount the identical paths** under `/api/integration/*`. These routes are a
  compatibility façade in the `integration` module — thin adapters mapping the
  legacy request/response shapes onto the new services. **Response shapes are
  byte-compatible** (same field names, same status vocabulary), verified by contract
  tests recorded from the legacy spec docs.
- Surface to preserve (from the legacy spec):
  - **Customer reads L1–L10:** customer-by-phone, holdings (L2 — incl.
    `is_locker_deposit` flag + `totals` block: `ncd_principal`,
    `ncd_principal_excluding_locker_deposits`, `locker_deposit_via_ncd`),
    transactions (L7, statement-cutoff filtered ⚙, aggregates full), documents list
    + stream (L8), requests (L9), SOA pdf, ledger.csv, NCD-AUM stats, active series.
  - **Customer writes:** penny-drop (BAV v3 shape incl. failure reason + error
    code), customers/from-lockerhub, profile-update-request, subscription-request,
    subscription-payments/from-lockerhub (funded → PendingApproval; **customer-facing
    `customer_status` maps every pre-Active live state to "Active"**),
    redemption-request, leads (dedup on lockerhub_application_no).
  - **Customer auth LA1–LA4:** lookup, otp/request, otp/verify, select-account,
    token/validate.
  - **Agent endpoints:** from-lockerhub (self-signup → approval queue),
    email-check (route existing agents to Sign-In), authenticate,
    issue-webview-session (returns BOTH shapes: `session_code`+`establish_url` and
    legacy `token`+`bridge_url`, per the roll-forward/back design).
  - **KYC mirror:** DhanamFin-captured KYC docs pushed into Wealth.
- **Outbound:** agent-event webhook dispatcher (queue table + 30s drain cron) to
  LockerHub, same event payloads.
- Idempotency keys preserved: `lockerhub_intent_no`, `lockerhub_application_no`.

## 2. Provider adapters (same pattern as old app: interface + stub default)

| Provider | Purpose | Notes |
|---|---|---|
| **Decentro** | PAN verify, penny-drop (BAV **v3** — legacy endpoint is dead), DigiLocker | Port `decentro.js` incl. error-detail surfacing. `KYC_PRIMARY_PROVIDER` routes; `stub` for dev. |
| **Digio** | eSign | uploadpdf flow, HTTP Basic; **webhook** `/api/webhooks/digio/esign-complete` (secret-verified) + **poller** cron + manual fallback endpoint. Flip PendingEsign → PendingAllotment. |
| **Cashfree / Easebuzz** | payments | adapter interface, stub default, `PAYMENT_PRIMARY_PROVIDER` + per-bank override. Easebuzz path is what LockerHub-funded flow relies on. |
| **AWS SES** | transactional email | queue-drain worker (60s + boot), templates as files (`api/src/integrations/email/templates/`), throttled crash alerts. |
| **WappCloud** | WhatsApp | acknowledgment (live) + interest-credit templates ⚙; PDF attachments must carry `documentName`. Shares the notifications queue. |
| **SharePoint (Graph)** | offsite backup + KYC doc viewer | port `sharepoint.js`; **client secret expires 2028-07-09** — carry the expiry-warning check into this app's daily backup email too. |
| **AWS SSM** | secrets at boot | same loader pattern; **new namespace `/dhanam/newwealth/*`** (own DB URL, JWT secret, and a copy of the shared provider keys). Never a secret on disk. |

## 3. Contract-safety measures (builder must implement)

1. **Contract test suite** (`api/test/integration-contract/`): for every legacy
   endpoint, a golden-file test asserting URL, auth header, and response JSON shape
   (synthetic data). These are written from the legacy spec docs *before* the façade
   is coded.
2. A staging cutover checklist: LockerHub pointed at the new base URL in their
   staging first; run their Postman collection (`app/postman/` in old repo has one
   for agent integration) against the new app.
3. Webhook secrets and integration keys are **new values** in the new SSM namespace
   at cutover (rotation moment), coordinated with the LockerHub team.
