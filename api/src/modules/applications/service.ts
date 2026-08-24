/**
 * Applications module (docs/04 §2). Lifecycle:
 *   create → PendingFundVerification → (confirm collection) PendingActivation
 *   → (activation approval) Active → Redeemed/Matured…
 * eSign is recorded (esigned_at) but no longer gates the flow; allotment is a
 * separate, later series step that only stamps allotment_date.
 * State changes go through the shared state machine.
 */
import type { Db } from '../../db/types.js';
import type { AuthUser } from '../../lib/authUser.js';
import { errors } from '../../lib/errors.js';
import { writeAudit } from '../../lib/audit.js';
import { nextCode } from '../../lib/sequences.js';
import { isTerminal } from '../../lib/statusMachine.js';
import { scopeFor, scopeWhere } from '../../lib/scope.js';
import { getSettingsMap } from '../settings/service.js';
import { createApprovalRequest, registerOnFinalApprove, registerOnReject } from '../approvals/service.js';
import { emitForApplication } from '../../integrations/lockerhub/customerEvents.js';
import { enqueue, drainOnce } from '../notifications/service.js';
import { signFileToken } from '../auth/tokens.js';
import { formatPhone } from '../../integrations/notify/wappcloud.js';
import { config } from '../../config.js';

const SCOPE_COLS = {
  userCol: 'a.enrolled_by_user_id',
  agentCol: 'a.enrolled_by_agent_id',
  branchCol: 'c.branch_id',
  refCol: "COALESCE(NULLIF(btrim(a.referred_by_text), ''), c.referred_by_text)",
};

export interface CreateApplicationInput {
  customer_id: number;
  /**
   * 'subordinate_bond' is NOT an NCD (owner spec 2026-08-10): it belongs to no
   * series, is priced from a sob_product instead of a scheme, and is numbered
   * SOB-. Absent means 'ncd', so every existing caller keeps its meaning.
   */
  product_type?: 'ncd' | 'subordinate_bond';
  /** NCD only — a subordinate bond must not carry either (chk_app_product_shape). */
  series_id?: number;
  scheme_id?: number;
  /** Subordinate bond only: the product carrying its rate, tenure and day-count. */
  sob_product_id?: number;
  amount: number;
  // Date the money hit Dhanam's account, entered by staff at enrolment. Stored
  // now; interest starts from it once the investment is approved (go-live).
  date_money_received: string;
  collection_method: string;
  collection_reference: string;
  club_with_application_id?: number; // append this line to an in-flight app
  collection_bank_id?: number | null; // which Dhanam account received the money
  // Set by the ">₹30L for a No-TDS customer → apply TDS?" prompt: when true, mark
  // the WHOLE CUSTOMER as TDS-applicable (customers.tds_applicable), not just this
  // investment — so every one of their investments deducts TDS from now on.
  mark_customer_tds?: boolean;
  // Receipt / cheque photo — mandatory: an investment never exists without it.
  // Same wire shape as POST /:id/receipt (the client mime is ignored — sniffed).
  receipt: { filename: string; mime: string; data_base64: string };
  is_locker_deposit?: boolean; // staff-keyed locker money; the LockerHub flow sets its own flag
}

/** Validate + persist receipt bytes; returns the stored path and SNIFFED mime
 * (the client-declared one is never trusted). Throws 400 on a bad file. */
async function storeReceiptFile(filename: string, dataBase64: string): Promise<{ file_path: string; mime: string }> {
  const { validateUpload } = await import('../../lib/uploads.js');
  const { buffer, mime } = validateUpload(dataBase64);
  const { saveBuffer } = await import('../../lib/storage.js');
  const { path } = saveBuffer('receipts', filename, buffer);
  return { file_path: path, mime };
}

/** Attach already-stored receipt bytes to an application row (audited). */
async function attachReceipt(db: Db, actor: AuthUser, appId: number, filename: string, stored: { file_path: string; mime: string }) {
  const upd = await db.query('UPDATE applications SET receipt_file_path = $1, receipt_original_filename = $2, receipt_mime = $3, receipt_uploaded_at = now() WHERE id = $4',
    [stored.file_path, filename, stored.mime, appId]);
  if (!upd.rowCount) {
    const { removeStored } = await import('../../lib/storage.js');
    removeStored(stored.file_path); // no row to own the file — don't orphan it
    throw errors.notFound('Application not found');
  }
  await writeAudit(db, { actorId: actor.id, action: 'application.receipt', entityType: 'applications', entityId: appId, after: { filename } });
}

/** One credit. `pay` is THIS part's own payment detail — a clubbed investment
 *  has several, paid on different days against different references, and the
 *  application-level columns only ever describe the first.
 *
 *  `pricing` is a scheme for an NCD, or a sob_product shaped like one for a
 *  subordinate bond (`id: null`, since a sub bond has no scheme). Either way
 *  the rate, tenure, frequency and day-count are SNAPSHOT onto the line, so a
 *  later edit to the scheme or product never rewrites a live investment. */
async function addLine(
  tx: Db, appId: number, scheme: Record<string, unknown>, amount: number,
  pay?: { date_money_received?: string; collection_method?: string; collection_reference?: string;
          receipt?: { file_path: string; mime: string; filename: string } },
) {
  await tx.query(
    `INSERT INTO application_lines (application_id, scheme_id, coupon_rate_pct, tenure_months, payout_frequency, day_count_convention, amount, outstanding_amount, status,
                                    date_money_received, collection_method, collection_reference, receipt_file_path, receipt_original_filename, receipt_mime)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$7,'Active',$8,$9,$10,$11,$12,$13)`,
    [appId, scheme.id, scheme.coupon_rate_pct, scheme.tenure_months, scheme.payout_frequency, scheme.day_count_convention, amount,
     pay?.date_money_received ?? null, pay?.collection_method ?? null, pay?.collection_reference ?? null,
     pay?.receipt?.file_path ?? null, pay?.receipt?.filename ?? null, pay?.receipt?.mime ?? null]);
}

export async function createApplication(db: Db, actor: AuthUser, input: CreateApplicationInput) {
  const settings = await getSettingsMap(db);
  const isSob = input.product_type === 'subordinate_bond';
  // Subordinate bonds are numbered SOB-2026-000001 on their own counter, so the
  // two products never share a number space (owner 2026-08-10).
  const appFmt = isSob
    ? String(settings['numbering.subordinate_bond_format'] ?? 'SOB-{yyyy}-{seq:6}')
    : String(settings['numbering.application_format'] ?? 'APP-{yyyy}-{seq:6}');
  // The receipt photo is mandatory and attached inside the create transaction,
  // so an application row never exists without one. Bad bytes 400 here, before
  // any row is written; if the transaction fails the stored file is removed —
  // no orphaned rows OR files either way.
  const storedReceipt = await storeReceiptFile(input.receipt.filename, input.receipt.data_base64);
  try {
    return await db.withTx(async (tx) => {
      // What prices this investment. An NCD takes it from the scheme attached
      // to its series; a subordinate bond has no series and therefore no
      // scheme, so it takes the same four figures from its product master.
      // Shaped alike so everything downstream — the line, the schedule, the
      // interest engine — needs no special case.
      let scheme: Record<string, unknown>;
      if (isSob) {
        if (!input.sob_product_id) throw errors.badRequest('Choose a subordinate bond product');
        const p = (await tx.query<Record<string, unknown>>(
          'SELECT * FROM sob_products WHERE id = $1', [input.sob_product_id])).rows[0];
        if (!p) throw errors.badRequest('Unknown subordinate bond product');
        // A retired product must not take new money; existing investments on it
        // are unaffected because the line already holds its own snapshot.
        if (p.is_active === false) throw errors.badRequest('That subordinate bond product is no longer active');
        scheme = {
          id: null, // no scheme — application_lines.scheme_id is nullable
          coupon_rate_pct: p.coupon_rate_pct, tenure_months: p.tenure_months,
          payout_frequency: p.payout_frequency, day_count_convention: p.day_count_convention,
        };
      } else {
        const s = (await tx.query<Record<string, unknown>>('SELECT * FROM schemes WHERE id = $1', [input.scheme_id])).rows[0];
        if (!s) throw errors.badRequest('Unknown scheme');
        scheme = s;
      }
      // NCDs are still ISSUED in whole ₹1,00,000 units — but a single credit
      // need not be one (owner 2026-08-01). Money arrives in parts: ₹50,000
      // today, ₹50,000 next week, clubbed into one ₹1,00,000 investment.
      // Refusing the first half at the door forced staff to either sit on the
      // receipt or record a figure the bank statement does not show.
      //
      // The denomination rule is NOT relaxed, only MOVED: approval still
      // refuses a total that is not a whole unit (approvals/service.ts), and
      // approval is what takes an investment live and starts interest. So a
      // part-payment is recorded and visible, earns nothing, and cannot go live
      // until it has been clubbed up to a whole unit. Nothing about the
      // interest calculation changes.
      if (!(input.amount > 0)) throw errors.badRequest('Investment amount must be greater than zero');

      // The ">₹30L for a No-TDS customer → apply TDS?" prompt was answered Yes:
      // mark the WHOLE customer TDS-applicable (not just this investment). Only
      // flips a customer who is currently exempt, and is audited. Placed before
      // both the clubbing and new-app branches so either path honours it.
      if (input.mark_customer_tds) {
        const upd = await tx.query(
          'UPDATE customers SET tds_applicable = TRUE, updated_at = now() WHERE id = $1 AND tds_applicable = FALSE', [input.customer_id]);
        if (upd.rowCount) {
          await writeAudit(tx, { actorId: actor.id, action: 'customer.tds.on-large-investment', entityType: 'customers', entityId: input.customer_id,
            after: { tds_applicable: true, reason: `Investment of ₹${input.amount.toLocaleString('en-IN')} (> ₹30L) for a No-TDS customer — operator confirmed TDS applies` } });
          // Flipping the flag only taxes interest FROM NOW ON. The TDS on interest
          // already paid to them while exempt still has to be collected — the same
          // recovery the nightly ₹30L scan raises. Without this, every customer who
          // came through this prompt escaped the recovery entirely (owner 2026-08-08).
          //
          // The amount is an ESTIMATE: one flat rate over all interest already paid,
          // where history may have taxed each payout differently. It goes to
          // Approvals labelled as approximate for a human to check, and nothing is
          // deducted until it is approved. Dynamic import keeps the module cycle out.
          const { raiseEnrolmentTdsRecovery } = await import('../tds/service.js');
          await raiseEnrolmentTdsRecovery(tx, input.customer_id, actor.id);
        }
      }

      // Clubbing: append this line's amount to an existing in-flight application.
      //
      // NOT offered for subordinate bonds. Clubbing exists to gather part
      // payments up to a whole ₹1,00,000 unit, and the owner confirmed sub
      // bonds have no unit rule — so what clubbing should mean for one has
      // never been specified. Refused loudly rather than guessed at.
      if (input.club_with_application_id && isSob) {
        throw errors.badRequest('Subordinate bonds cannot be clubbed — record the investment for its full amount');
      }
      // A series awaiting its own approval takes no money (owner 2026-08-19).
      // The enrolment dropdown already hides it; this is the actual gate, since
      // a dropdown filter is a courtesy and not a control.
      if (!isSob && input.series_id) {
        const { assertSeriesTakesMoney } = await import('../products/service.js');
        await assertSeriesTakesMoney(tx, input.series_id);
      }
      if (input.club_with_application_id) {
        const target = (await tx.query<{ id: string; status: string; series_id: string; total_amount: string }>(
          'SELECT id, status, series_id, total_amount FROM applications WHERE id = $1', [input.club_with_application_id])).rows[0];
        if (!target) throw errors.notFound('Clubbing target not found');
        if (Number(target.series_id) !== input.series_id) throw errors.badRequest('Can only club within the same series');
        // In-flight targets club freely. An ACTIVE target may be clubbed into
        // too (owner 2026-08-24) — but ONLY while no interest has been paid: once
        // a payout has run, the schedule can't be safely rebuilt.
        const inFlight = ['PendingFundVerification', 'PendingEsign', 'PendingApproval'].includes(target.status);
        const activeUnpaid = target.status === 'Active'
          && !(await tx.query("SELECT 1 FROM disbursement_schedule WHERE application_id = $1 AND status = 'Paid' LIMIT 1", [Number(target.id)])).rowCount;
        if (!inFlight && !activeUnpaid) {
          throw errors.conflict(target.status === 'Active'
            ? 'This investment has already had an interest payout — it can no longer be clubbed into.'
            : 'Target application is no longer in-flight');
        }
        const no = (await tx.query<{ application_no: string }>('SELECT application_no FROM applications WHERE id = $1', [Number(target.id)])).rows[0]!.application_no;

        // ACTIVE target → this is a LIVE, already-approved investment. Adding money
        // to it inflates the principal AND rebuilds the live interest schedule —
        // that is a maker/checker event, not a silent edit (owner 2026-08-24). So
        // we touch nothing now: the tranche (with its receipt) is held on an
        // Admin/CXO approval and the investment stays exactly as-is until a checker
        // approves. The apply — addLine + rematerialise + accrue — happens in the
        // 'club_into_active' final-approve handler below.
        if (activeUnpaid) {
          const clubReq = await createApprovalRequest(tx, {
            type: 'club_into_active', entityType: 'applications', entityId: Number(target.id), makerUserId: actor.id,
            metadata: {
              application_no: no,
              added_amount: input.amount,
              // Snapshot the tranche + its priced scheme so the credit the customer
              // was quoted is exactly what materialises on approval (no later drift).
              tranche: {
                amount: input.amount,
                scheme: {
                  id: scheme.id ?? null, coupon_rate_pct: scheme.coupon_rate_pct, tenure_months: scheme.tenure_months,
                  payout_frequency: scheme.payout_frequency, day_count_convention: scheme.day_count_convention,
                },
                date_money_received: input.date_money_received ?? null,
                collection_method: input.collection_method ?? null,
                collection_reference: input.collection_reference ?? null,
                receipt: { file_path: storedReceipt.file_path, filename: input.receipt.filename, mime: storedReceipt.mime },
              },
            },
          });
          await writeAudit(tx, { actorId: actor.id, action: 'application.club.pending-approval', entityType: 'applications', entityId: Number(target.id),
            after: { added: input.amount, reference: input.collection_reference, received: input.date_money_received } });
          // Receipt file is retained (referenced from the approval metadata); the
          // reject handler removes it if the clubbing is turned down.
          return { id: Number(target.id), application_no: no, clubbed: true, pending_approval: true, approval_request: clubReq };
        }

        // IN-FLIGHT target → the whole application is still awaiting its own
        // subscription approval, which takes the clubbed total live in one go.
        // Gathering the credit onto it now needs no separate gate.
        await addLine(tx, Number(target.id), scheme, input.amount, {
          date_money_received: input.date_money_received,
          collection_method: input.collection_method,
          collection_reference: input.collection_reference,
          receipt: { ...storedReceipt, filename: input.receipt.filename },
        });
        await tx.query('UPDATE applications SET total_amount = total_amount + $1, updated_at = now() WHERE id = $2', [input.amount, Number(target.id)]);
        await writeAudit(tx, { actorId: actor.id, action: 'application.club', entityType: 'applications', entityId: Number(target.id),
          after: { added: input.amount, reference: input.collection_reference, received: input.date_money_received, into_active: false } });
        // The receipt stays on the LINE. It used to overwrite the application's,
        // which meant clubbing a second credit made the FIRST credit's receipt
        // unreachable — the paper trail for money already banked, gone.
        return { id: Number(target.id), application_no: no, clubbed: true };
      }

      const customer = (await tx.query<{ referred_by_text: string | null; enrolled_by_agent_id: string | null }>(
        'SELECT referred_by_text, enrolled_by_agent_id FROM customers WHERE id = $1', [input.customer_id])).rows[0];
      if (!customer) throw errors.badRequest('Unknown customer');
      // Agent attribution of the investment: the acting agent if an agent booked
      // it themselves, else inherit the customer's agent — so an agent's own
      // customer's investment still lands in that agent's scoped book even when a
      // staff member / admin records it. Without this every staff-booked
      // application had a NULL agent and vanished from the agent's dashboard.
      const enrolledByAgentId = actor.agentId ?? (customer.enrolled_by_agent_id ? Number(customer.enrolled_by_agent_id) : null);
      const priorCount = Number((await tx.query<{ n: string }>('SELECT count(*)::int AS n FROM applications WHERE customer_id = $1', [input.customer_id])).rows[0]!.n);
      const isNew = priorCount === 0;
      const appNo = await nextCode(tx, isSob ? 'subordinate_bond' : 'application', appFmt);

      // Every staff-enrolled investment goes through one gate: it lands in
      // PendingApproval and an investment approval is raised. The admin verifies
      // the money is in Dhanam's account and approves — that approval is the
      // go-live (Active + schedule + incentives). Staff record the credit date
      // here so interest can start from it (owner spec 2026-07-19).
      // Which branch earns this (owner 2026-08-04). Stamped once, never
      // recomputed: a staff transfer must not rewrite last month's branch
      // report. Agent-sourced and unattributable business lands on HO.
      const { branchForReferrer } = await import('./branch.js');
      const branchId = await branchForReferrer(tx, customer.referred_by_text);
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO applications (application_no, customer_id, series_id, product_type, sob_product_id, status, total_amount, customer_was_new_at_creation, referred_by_text, source, enrolled_by_user_id, enrolled_by_agent_id, is_locker_deposit, date_money_received, collection_method, collection_reference, collection_bank_id, branch_id)
         VALUES ($1,$2,$3,$4,$5,'PendingApproval',$6,$7,$8,'staff',$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
        // A subordinate bond carries NO series and an NCD carries NO product —
        // chk_app_product_shape refuses anything else, so a slip here fails
        // loudly at insert rather than producing a mislabelled investment.
        [appNo, input.customer_id, isSob ? null : input.series_id, isSob ? 'subordinate_bond' : 'ncd', isSob ? input.sob_product_id : null,
         input.amount, isNew, customer.referred_by_text ?? null, actor.id, enrolledByAgentId,
         input.is_locker_deposit ?? false, input.date_money_received, input.collection_method, input.collection_reference, input.collection_bank_id ?? null,
         branchId]
      );
      const appId = Number(rows[0]!.id);
      await addLine(tx, appId, scheme, input.amount, {
        date_money_received: input.date_money_received,
        collection_method: input.collection_method,
        collection_reference: input.collection_reference,
        receipt: { ...storedReceipt, filename: input.receipt.filename },
      });
      // Tell LockerHub a subscription intent was created (contract event). No-op unless configured.
      await emitForApplication(tx, 'subscription.created', appId);
      const subscriptionRequest = await createApprovalRequest(tx, { type: 'subscription', entityType: 'applications', entityId: appId, makerUserId: actor.id, metadata: { application_no: appNo } });
      await writeAudit(tx, { actorId: actor.id, action: 'application.create', entityType: 'applications', entityId: appId, after: { appNo, amount: input.amount, isNew } });
      await attachReceipt(tx, actor, appId, input.receipt.filename, storedReceipt);
      return { id: appId, application_no: appNo, clubbed: false, subscription_request: subscriptionRequest };
    });
  } catch (e) {
    const { removeStored } = await import('../../lib/storage.js');
    removeStored(storedReceipt.file_path);
    throw e;
  }
}

// Investment approval = go-live. The admin has verified the money is in
// Dhanam's account; approving takes the NCD live (Active + schedule +
// incentives) using the credit date staff recorded at enrolment.
registerOnFinalApprove('subscription', async (tx, req) => {
  if (!req.entity_id) return;
  const appId = Number(req.entity_id);
  const { activateApplication } = await import('./activate.js');
  await activateApplication(tx, appId, { confirmedByUserId: req.maker_user_id });
});

// A rejected subscription approval = the intent was cancelled. Emit-only (the
// app lifecycle is unchanged here); no-op unless the event webhook is configured.
registerOnReject('subscription', async (tx, req) => {
  if (!req.entity_id) return;
  await emitForApplication(tx, 'subscription.cancelled', Number(req.entity_id));
});

// Club a held tranche into a LIVE investment (owner 2026-08-24). The maker
// recorded a new credit against an already-Active NCD; a checker (Admin/CXO)
// has now approved it. Only here do we mutate the live investment: add the
// tranche, bump the total, and rebuild the (all-unpaid) schedule so each tranche
// earns from its own money-received date and they mature together.
registerOnFinalApprove('club_into_active', async (tx, req) => {
  if (!req.entity_id) return;
  const appId = Number(req.entity_id);
  const t = req.metadata.tranche as {
    amount: number; scheme: Record<string, unknown>;
    date_money_received: string | null; collection_method: string | null; collection_reference: string | null;
    receipt: { file_path: string; filename: string; mime: string };
  } | undefined;
  if (!t) return;

  // Re-assert the target is still Active with NO paid interest. An interest batch
  // could in principle have run between the request and this approval; rebuilding
  // a schedule that already has Paid rows would double-count, so refuse loudly
  // rather than corrupt the live schedule.
  const app = (await tx.query<{ status: string }>('SELECT status FROM applications WHERE id = $1', [appId])).rows[0];
  if (!app || app.status !== 'Active') throw errors.conflict('This investment is no longer active — the clubbing cannot be applied.');
  if ((await tx.query("SELECT 1 FROM disbursement_schedule WHERE application_id = $1 AND status = 'Paid' LIMIT 1", [appId])).rowCount) {
    throw errors.conflict('This investment has since had an interest payout — the clubbing can no longer be applied.');
  }

  await addLine(tx, appId, t.scheme, Number(t.amount), {
    date_money_received: t.date_money_received ?? undefined,
    collection_method: t.collection_method ?? undefined,
    collection_reference: t.collection_reference ?? undefined,
    receipt: t.receipt,
  });
  await tx.query('UPDATE applications SET total_amount = total_amount + $1, updated_at = now() WHERE id = $2', [Number(t.amount), appId]);
  await tx.query("DELETE FROM disbursement_schedule WHERE application_id = $1 AND status <> 'Paid'", [appId]);
  const { materializeForApplication } = await import('../schedule/materialize.js');
  await materializeForApplication(tx, appId);
  const { accrueForApplication } = await import('../incentives/accrual.js');
  await accrueForApplication(tx, appId);
  await writeAudit(tx, { actorId: req.maker_user_id, action: 'application.club.approved', entityType: 'applications', entityId: appId,
    after: { added: Number(t.amount), via: 'approval', request_id: req.id } });
});

// A rejected club — the held credit is abandoned. Remove its stored receipt
// (nothing on the live investment ever changed, so there is nothing else to undo).
registerOnReject('club_into_active', async (_tx, req) => {
  const t = req.metadata.tranche as { receipt?: { file_path?: string } } | undefined;
  if (t?.receipt?.file_path) {
    const { removeStored } = await import('../../lib/storage.js');
    removeStored(t.receipt.file_path);
  }
});

/**
 * Assign (or reassign) the referrer staff/agent on an investment and re-accrue
 * the referrer incentive. Used for app-channel investments where the customer
 * gave no referral code — the admin picks the payee from the App-investment
 * notice on the Approvals page. Idempotent per (app, payee): a clean unpaid
 * re-accrual, paid rows are never touched.
 */
export async function attributeReferrer(db: Db, actor: AuthUser, appId: number, payee: string) {
  const text = payee.trim();
  if (!text) throw errors.badRequest('Pick a staff or agent to assign');
  return db.withTx(async (tx) => {
    const app = (await tx.query<{ id: string }>('SELECT id FROM applications WHERE id = $1', [appId])).rows[0];
    if (!app) throw errors.notFound('Application not found');
    // Drop any existing UNPAID referrer accrual so a re-assignment lands cleanly.
    await tx.query("DELETE FROM incentive_accruals WHERE application_id = $1 AND matrix_cell = 'referrer' AND paid_at IS NULL", [appId]);
    await tx.query('UPDATE applications SET referred_by_text = $1, updated_at = now() WHERE id = $2', [text, appId]);
    const { accrueForApplication } = await import('../incentives/accrual.js');
    await accrueForApplication(tx, appId);
    // Mark the App-investment notice resolved so the queue reflects it.
    await tx.query(
      `UPDATE approval_requests
         SET metadata = jsonb_set(jsonb_set(metadata, '{needs_attribution}', 'false'), '{referred_by}', to_jsonb($1::text))
       WHERE request_type = 'app_investment' AND entity_type = 'applications' AND entity_id = $2 AND status = 'Pending'`,
      [text, String(appId)]);
    await writeAudit(tx, { actorId: actor.id, action: 'application.attribute-referrer', entityType: 'applications', entityId: appId, after: { referred_by_text: text } });
    return { ok: true };
  });
}

/** Clubbing candidates — in-flight apps in a series for a customer. */
export async function clubbingCandidates(db: Db, customerId: number, seriesId: number) {
  // In-flight applications, PLUS Active ones whose interest has NOT yet been
  // paid (owner 2026-08-24): a new credit can club into an already-live
  // investment as long as no payout has run, so the first batch carries a broken
  // period per tranche and the rest combine. The series must still take money
  // (not Pending) — enforced at create too.
  return (await db.query(
    `SELECT a.id, a.application_no, a.total_amount, a.status
       FROM applications a JOIN series s ON s.id = a.series_id
      WHERE a.customer_id = $1 AND a.series_id = $2 AND s.status <> 'PendingApproval'
        AND (
          a.status IN ('PendingFundVerification','PendingEsign','PendingApproval')
          OR (a.status = 'Active'
              AND NOT EXISTS (SELECT 1 FROM disbursement_schedule d WHERE d.application_id = a.id AND d.status = 'Paid'))
        )
      ORDER BY a.id`,
    [customerId, seriesId])).rows;
}

/** Set/change the interest payout bank account for an application (re-snapshots
 * only future unpaid schedule rows). */
export async function setPayoutAccount(db: Db, actor: AuthUser, appId: number, bankAccountId: number | null) {
  return db.withTx(async (tx) => {
    const app = (await tx.query<{ customer_id: string }>('SELECT customer_id FROM applications WHERE id = $1', [appId])).rows[0];
    if (!app) throw errors.notFound('Application not found');

    // null clears the pin: this NCD goes back to following the customer's
    // default account, and its future unpaid rows move there with it.
    if (bankAccountId === null) {
      await tx.query('UPDATE applications SET payout_bank_account_id = NULL, updated_at = now() WHERE id = $1', [appId]);
      const { resnapshotPayeeBank } = await import('../schedule/materialize.js');
      await resnapshotPayeeBank(tx, Number(app.customer_id));
      await writeAudit(tx, { actorId: actor.id, action: 'application.payout-account', entityType: 'applications', entityId: appId, after: { bankAccountId: null } });
      return { ok: true };
    }

    // Any account ON FILE for this customer may be chosen — the check that
    // matters is that it belongs to them. Requiring penny-drop 'Verified' here
    // was inconsistent as well as unusable: interest already pays out to
    // whichever account is active, verified or not (403 of 433 live accounts
    // are 'Pending' — never penny-dropped, mostly migrated from wealth), so
    // gating only the per-NCD pin blocked the feature for everyone without
    // making a single payment safer.
    const bank = (await tx.query<{ account_number: string; ifsc: string }>(
      'SELECT account_number, ifsc FROM customer_bank_accounts WHERE id = $1 AND customer_id = $2',
      [bankAccountId, app.customer_id])).rows[0];
    if (!bank) throw errors.badRequest('Bank account not found for this customer');
    await tx.query('UPDATE applications SET payout_bank_account_id = $1, updated_at = now() WHERE id = $2', [bankAccountId, appId]);
    // Re-snapshot future unpaid (Scheduled, no batch) rows to the new account.
    await tx.query(
      "UPDATE disbursement_schedule SET payee_account = $1, payee_ifsc = $2 WHERE application_id = $3 AND status = 'Scheduled' AND batch_id IS NULL",
      [bank.account_number, bank.ifsc, appId]);
    await writeAudit(tx, { actorId: actor.id, action: 'application.payout-account', entityType: 'applications', entityId: appId, after: { bankAccountId } });
    return { ok: true };
  });
}

export async function uploadReceipt(db: Db, actor: AuthUser, appId: number, filename: string, _clientMime: string, dataBase64: string) {
  const stored = await storeReceiptFile(filename, dataBase64); // sniffed mime — client's is ignored
  await attachReceipt(db, actor, appId, filename, stored);
  return { ok: true };
}

export async function getReceipt(db: Db, appId: number): Promise<{ buffer: Buffer; mime: string; filename: string } | null> {
  const app = (await db.query<{ receipt_file_path: string | null; receipt_mime: string | null; receipt_original_filename: string | null }>(
    'SELECT receipt_file_path, receipt_mime, receipt_original_filename FROM applications WHERE id = $1', [appId])).rows[0];
  if (!app?.receipt_file_path) return null;
  const { readStored } = await import('../../lib/storage.js');
  const buffer = readStored(app.receipt_file_path);
  if (!buffer) return null;
  return { buffer, mime: app.receipt_mime ?? 'application/octet-stream', filename: app.receipt_original_filename ?? 'receipt' };
}

/**
 * The receipt for ONE credit of a clubbed investment. The application-level
 * receipt only ever shows one part; this reaches the rest, so every part of the
 * money has its own paper trail. Scoped by application_id as well as line id so
 * a line from another application cannot be fetched by guessing an id.
 */
export async function getLineReceipt(db: Db, appId: number, lineId: number): Promise<{ buffer: Buffer; mime: string; filename: string } | null> {
  const l = (await db.query<{ receipt_file_path: string | null; receipt_mime: string | null; receipt_original_filename: string | null }>(
    'SELECT receipt_file_path, receipt_mime, receipt_original_filename FROM application_lines WHERE id = $1 AND application_id = $2',
    [lineId, appId])).rows[0];
  if (!l?.receipt_file_path) return null;
  const { readStored } = await import('../../lib/storage.js');
  const buffer = readStored(l.receipt_file_path);
  if (!buffer) return null;
  return { buffer, mime: l.receipt_mime ?? 'application/octet-stream', filename: l.receipt_original_filename ?? 'receipt' };
}

/** Correct the locker-deposit flag on an application (staff-keyed entries;
 * the LockerHub integration path sets its own flag automatically). */
export async function setLockerDeposit(db: Db, actor: AuthUser, appId: number, value: boolean) {
  const upd = await db.query('UPDATE applications SET is_locker_deposit = $1, updated_at = now() WHERE id = $2', [value, appId]);
  if (!upd.rowCount) throw errors.notFound('Application not found');
  await writeAudit(db, { actorId: actor.id, action: 'application.locker-deposit', entityType: 'applications', entityId: appId, after: { is_locker_deposit: value } });
  return { ok: true };
}

/** Mark whether the bond certificate has been handed to the customer (owner
 * 2026-08-19). Records WHO marked it and WHEN, because the question this
 * answers months later is "who says this customer got their bond".
 *
 * Un-marking clears both, so the record never claims a handover happened at a
 * time nobody stands behind. Deliberately not gated on status: a bond can be
 * handed over late, and refusing to record a fact that already happened would
 * just leave the book wrong. */
export async function setBondDistributed(db: Db, actor: AuthUser, appId: number, value: boolean) {
  const upd = await db.query(
    `UPDATE applications
        SET bond_distributed_at = CASE WHEN $1 THEN now() ELSE NULL END,
            bond_distributed_by = CASE WHEN $1 THEN $2::bigint ELSE NULL END,
            updated_at = now()
      WHERE id = $3
      RETURNING bond_distributed_at`, [value, actor.id, appId]);
  if (!upd.rowCount) throw errors.notFound('Application not found');
  await writeAudit(db, {
    actorId: actor.id, action: 'application.bond-distributed', entityType: 'applications', entityId: appId,
    after: { distributed: value, at: upd.rows[0]?.bond_distributed_at ?? null },
  });
  return { ok: true, bond_distributed_at: upd.rows[0]?.bond_distributed_at ?? null };
}

/** Record eSign completion. Non-gating: it stamps esigned_at and does not
 * change the lifecycle status (eSign no longer sits on the critical path). */
export async function markESigned(db: Db, actor: AuthUser, appId: number) {
  await db.withTx(async (tx) => {
    const app = (await tx.query<{ status: string }>('SELECT status FROM applications WHERE id = $1', [appId])).rows[0];
    if (!app) throw errors.notFound('Application not found');
    if (isTerminal('application', app.status)) throw errors.conflict('Application is closed');
    await tx.query('UPDATE applications SET esigned_at = now(), updated_at = now() WHERE id = $1', [appId]);
    await writeAudit(tx, { actorId: actor.id, action: 'application.esigned', entityType: 'applications', entityId: appId });
  });
}

export async function listApplications(db: Db, actor: AuthUser, filters: { status?: string; series_id?: number; showArchived?: boolean } = {}) {
  const conds: string[] = [];
  const params: unknown[] = [];
  const sc = scopeWhere(scopeFor(actor), SCOPE_COLS, 0);
  conds.push(sc.sql); params.push(...sc.params);
  // Archived investments are hidden unless a super-admin (applications:delete)
  // explicitly asks to see them (to restore or purge).
  const showArchived = filters.showArchived && actor.permissions.includes('applications:delete');
  if (!showArchived) conds.push('a.archived_at IS NULL');
  if (filters.status) { params.push(filters.status); conds.push(`a.status = $${params.length}`); }
  if (filters.series_id) { params.push(filters.series_id); conds.push(`a.series_id = $${params.length}`); }
  const base = `FROM applications a JOIN customers c ON c.id = a.customer_id JOIN series s ON s.id = a.series_id
     WHERE ${conds.join(' AND ')}`;
  const total = Number((await db.query<{ n: number }>(`SELECT count(*)::int AS n ${base}`, params)).rows[0]!.n);
  const { rows } = await db.query(
    `SELECT a.id, a.application_no, a.status, a.total_amount, a.allotment_date, a.maturity_date, a.archived_at,
            c.full_name AS customer_name, c.customer_code, s.code AS series_code
     ${base} ORDER BY a.created_at DESC LIMIT 2000`,
    params
  );
  return { rows, total, truncated: total > rows.length };
}

export async function getApplicationDetail(db: Db, actor: AuthUser, appId: number) {
  const sc = scopeWhere(scopeFor(actor), SCOPE_COLS, 1);
  const app = (await db.query(
    `SELECT a.*, c.full_name AS customer_name, c.customer_code, s.code AS series_code,
            -- Which Dhanam account received the money (label for display).
            cb.account_label AS collection_bank_label, cb.bank_name AS collection_bank_name, cb.account_number AS collection_bank_account,
            -- Who marked the bond as handed to the customer; the page shows the
            -- name rather than a user id nobody can read.
            bd.full_name AS bond_distributed_by_name
     FROM applications a JOIN customers c ON c.id = a.customer_id JOIN series s ON s.id = a.series_id
     LEFT JOIN banks cb ON cb.id = a.collection_bank_id
     LEFT JOIN users bd ON bd.id = a.bond_distributed_by
     WHERE a.id = $1 AND ${sc.sql}`, [appId, ...sc.params])).rows[0];
  if (!app) throw errors.notFound('Application not found');
  const lines = (await db.query('SELECT * FROM application_lines WHERE application_id = $1', [appId])).rows;
  const schedule = (await db.query('SELECT id, due_date, due_type, gross_amount, tds_amount, net_amount, status, paid_at FROM disbursement_schedule WHERE application_id = $1 ORDER BY due_date', [appId])).rows;
  // A signature is out with the customer — the UI polls while this is true so the
  // page flips to eSigned on its own once the Digio poller completes it.
  const pendingSessions = Number((await db.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM digio_signing_sessions WHERE application_id = $1 AND status = 'requested'", [appId]
  )).rows[0]?.n ?? 0);
  const esignPending = pendingSessions > 0 && !app.esigned_at;
  // Locker pledge breakdown: total / linked to lockers / free NCD / redeemable.
  // The investment is never split — links are claims against it.
  const { depositSummary } = await import('../lockers/deposits.js');
  const locker = await depositSummary(db, appId);
  // One-off deductions and additions applied to this investment's payouts
  // (owner 2026-08-20). Without these the schedule cannot be reconciled: a
  // consumed deduction makes net < gross - TDS, and the page gave no reason
  // why. Three July payouts looked like a Rs 7,231 shortfall until the
  // adjustment rows were read — the answer existed, just nowhere a person
  // handling the customer would see it.
  const adjustments = (await db.query(
    `SELECT pa.id, pa.kind, pa.amount, pa.narration, pa.status, pa.batch_id,
            pa.created_at, u.full_name AS created_by
       FROM payout_adjustments pa
       LEFT JOIN users u ON u.id = pa.created_by_user_id
      WHERE pa.application_id = $1
      ORDER BY pa.created_at`, [appId])).rows;
  return { application: app, lines, schedule, esign_pending: esignPending, locker, adjustments };
}

/**
 * Mark which Dhanam account an investment's money was credited to. bankId null
 * clears it. Audited. Money-adjacent record, so it's traceable.
 */
export async function setCollectionBank(db: Db, actor: AuthUser, appId: number, bankId: number | null) {
  const sc = scopeWhere(scopeFor(actor), SCOPE_COLS, 2);
  const before = (await db.query<{ collection_bank_id: string | null }>(
    `SELECT a.collection_bank_id FROM applications a JOIN customers c ON c.id = a.customer_id
      WHERE a.id = $1 AND ${sc.sql}`, [appId, ...sc.params])).rows[0];
  if (!before) throw errors.notFound('Application not found');
  if (bankId != null) {
    const bank = (await db.query('SELECT 1 FROM banks WHERE id = $1', [bankId])).rows[0];
    if (!bank) throw errors.badRequest('Unknown Dhanam account');
  }
  await db.query('UPDATE applications SET collection_bank_id = $1, updated_at = now() WHERE id = $2', [bankId, appId]);
  await writeAudit(db, {
    actorId: actor.id, action: 'application.collection-bank', entityType: 'applications', entityId: appId,
    before: { collection_bank_id: before.collection_bank_id }, after: { collection_bank_id: bankId },
  });
  return { ok: true, collection_bank_id: bankId };
}

/**
 * Send the acknowledgement PDF to the customer on WhatsApp (approved `ncd_akn`
 * template, which carries a Document header). The PDF is handed to WappCloud as
 * a short-lived, path-scoped `?vt=` URL its servers fetch — never a public
 * link. Queued through the shared notifications queue then drained now (one
 * click), so the caller gets the real send status back.
 */
export async function sendWhatsappAck(db: Db, appId: number): Promise<{ ok: boolean; status: string; error: string | null; phone: string }> {
  const row = (await db.query<{ full_name: string; phone: string | null }>(
    'SELECT c.full_name, c.phone FROM applications a JOIN customers c ON c.id = a.customer_id WHERE a.id = $1', [appId])).rows[0];
  if (!row) throw errors.notFound('Application not found');
  const phone = formatPhone(row.phone ?? '');
  if (!phone) throw errors.badRequest("Customer has no valid phone number on file — can't send on WhatsApp.");
  if (!config.PUBLIC_BASE_URL) throw errors.badRequest('PUBLIC_BASE_URL is not set — add it to SSM so WappCloud can fetch the ack PDF.');

  const path = `/api/reports/acknowledgment/${appId}.pdf`;
  const documentUrl = `${config.PUBLIC_BASE_URL.replace(/\/$/, '')}${path}?vt=${encodeURIComponent(signFileToken('acknowledgment', appId))}`;
  const documentName = `${(row.full_name || 'Customer').trim()} - NCD Acknowledgment.pdf`;

  const id = await enqueue(db, {
    channel: 'whatsapp', template: 'acknowledgment', to: phone,
    payload: { name: row.full_name ?? '', documentUrl, documentName },
  });
  await drainOnce(db, 5); // send now (one click) rather than waiting for the cron
  const st = (await db.query<{ status: string; error: string | null }>('SELECT status, error FROM notifications_queue WHERE id = $1', [id])).rows[0];
  return { ok: st?.status === 'Sent', status: st?.status ?? 'Pending', error: st?.error ?? null, phone };
}
