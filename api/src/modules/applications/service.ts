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

/** Who may record a bond handover, or ask for one to be corrected (owner
 *  2026-08-28: "restrict it to NCD Manager and above"). Same maker tier as an
 *  investment-date change. */
function assertBondActor(actor: AuthUser) {
  if (!['ncd_manager', 'admin', 'super_admin'].includes(actor.role)) {
    throw errors.forbidden('Only an NCD Manager or Admin can record a bond handover');
  }
}

/** A handover date must be real, and cannot be in the future — you cannot have
 *  already given a customer something tomorrow. */
function assertGivenOn(givenOn: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(givenOn)) throw errors.badRequest('A valid date (YYYY-MM-DD) is required');
  if (givenOn > new Date().toISOString().slice(0, 10)) throw errors.badRequest('The bond cannot have been given on a future date');
}

/**
 * Record that the bond certificate reached the customer (owner 2026-08-19,
 * reworked 2026-08-28).
 *
 * WRITE-ONCE. It used to be a plain checkbox that stamped now() and that anyone
 * could silently untick, wiping the record of who said the customer got their
 * bond. Now: the operator supplies the date it was actually handed over and a
 * note saying how, it is recorded immediately, and from then on the mark can
 * only be changed through maker/checker approval —
 * requestBondDistributionChange below. Un-marking here is not possible at all.
 *
 * `bond_distributed_at` stays the moment of RECORDING (and the "is it marked"
 * test the rest of the app keys on); `bond_distributed_on` is the handover.
 */
export async function setBondDistributed(
  db: Db, actor: AuthUser, appId: number, givenOn: string, note?: string | null,
) {
  assertBondActor(actor);
  assertGivenOn(givenOn);
  return db.withTx(async (tx) => {
    const cur = (await tx.query<{ bond_distributed_at: string | null }>(
      'SELECT bond_distributed_at FROM applications WHERE id = $1', [appId])).rows[0];
    if (!cur) throw errors.notFound('Application not found');
    // Already recorded → this is a CHANGE, and a change needs a checker.
    if (cur.bond_distributed_at) {
      throw errors.conflict('This bond is already marked as given — a change needs Admin/CXO approval');
    }
    const upd = await tx.query<{ bond_distributed_at: string }>(
      `UPDATE applications
          SET bond_distributed_at = now(), bond_distributed_by = $1::bigint,
              bond_distributed_on = $2::date, bond_distributed_note = NULLIF(btrim($3), ''),
              updated_at = now()
        WHERE id = $4
        RETURNING bond_distributed_at`, [actor.id, givenOn, note ?? '', appId]);
    await writeAudit(tx, {
      actorId: actor.id, action: 'application.bond-distributed', entityType: 'applications', entityId: appId,
      after: { distributed: true, given_on: givenOn, note: note ?? null },
    });
    return { ok: true, bond_distributed_at: upd.rows[0]!.bond_distributed_at, bond_distributed_on: givenOn };
  });
}

/**
 * Ask to correct or reverse a recorded handover (owner 2026-08-28: "any changes
 * to it should be going to approval only"). Maker: NCD Manager+. Checker:
 * Admin/CXO. Nothing moves until a checker approves.
 *
 * `givenOn: null` means REVERSE it — the bond was not actually given. That is
 * the only route back, which is the point: the checkbox itself cannot be
 * unticked.
 */
export async function requestBondDistributionChange(
  db: Db, actor: AuthUser, appId: number, givenOn: string | null, note: string | null, reason: string,
) {
  assertBondActor(actor);
  if (givenOn !== null) assertGivenOn(givenOn);
  if (!reason?.trim()) throw errors.badRequest('A reason is required');
  return db.withTx(async (tx) => {
    const cur = (await tx.query<Record<string, unknown>>(
      `SELECT application_no, bond_distributed_at, bond_distributed_on, bond_distributed_note
         FROM applications WHERE id = $1`, [appId])).rows[0];
    if (!cur) throw errors.notFound('Application not found');
    if (!cur.bond_distributed_at) throw errors.badRequest('This bond is not marked as given — there is nothing to change');
    const req = await createApprovalRequest(tx, {
      type: 'bond_distribution_change', entityType: 'applications', entityId: appId, makerUserId: actor.id,
      metadata: {
        application_no: cur.application_no,
        current_given_on: cur.bond_distributed_on ? String(cur.bond_distributed_on).slice(0, 10) : null,
        current_note: cur.bond_distributed_note ?? null,
        new_given_on: givenOn, new_note: note, reason,
        reversal: givenOn === null,
      },
    });
    await writeAudit(tx, {
      actorId: actor.id, action: 'application.bond-distributed.change-requested',
      entityType: 'applications', entityId: appId,
      after: { from: cur.bond_distributed_on ?? null, to: givenOn, reversal: givenOn === null, reason },
    });
    return { ok: true, pending_approval: true, approval_request: req };
  });
}

// Apply the change only on final approval — the sole path that can move or clear
// a recorded handover.
registerOnFinalApprove('bond_distribution_change', async (tx, req) => {
  const appId = Number(req.entity_id ?? 0);
  if (!appId) return;
  const givenOn = req.metadata.new_given_on == null ? null : String(req.metadata.new_given_on);
  if (givenOn !== null && !/^\d{4}-\d{2}-\d{2}$/.test(givenOn)) throw errors.badRequest('The stored date is invalid');
  const note = req.metadata.new_note == null ? null : String(req.metadata.new_note);

  if (givenOn === null) {
    // Reversal: the handover did not happen. Clear the lot so nothing claims it did.
    await tx.query(
      `UPDATE applications SET bond_distributed_at = NULL, bond_distributed_by = NULL,
              bond_distributed_on = NULL, bond_distributed_note = NULL, updated_at = now()
        WHERE id = $1`, [appId]);
    return;
  }
  await tx.query(
    `UPDATE applications SET bond_distributed_on = $1::date,
            bond_distributed_note = NULLIF(btrim($2), ''), updated_at = now()
      WHERE id = $3`, [givenOn, note ?? '', appId]);
});

// A single-credit investment whose date can still be corrected (no interest paid
// or batched). Shared by the request and the apply, so both judge eligibility the
// same way. Returns the current date so the approval can show old → new.
async function assertDateChangeable(tx: Db, appId: number): Promise<{ current: string | null }> {
  const app = (await tx.query<{ status: string; date_money_received: string | null }>(
    'SELECT status, date_money_received FROM applications WHERE id = $1', [appId])).rows[0];
  if (!app) throw errors.notFound('Application not found');
  const lines = (await tx.query<{ id: string }>('SELECT id FROM application_lines WHERE application_id = $1', [appId])).rows;
  if (lines.length !== 1) {
    throw errors.badRequest('This investment has multiple credits, each with its own date — the investment date can only be changed on a single-credit investment.');
  }
  const locked = await tx.query(
    "SELECT 1 FROM disbursement_schedule WHERE application_id = $1 AND (status = 'Paid' OR batch_id IS NOT NULL) LIMIT 1", [appId]);
  if (locked.rowCount) {
    throw errors.conflict('Interest has already been paid or locked into a batch on this investment — its date can no longer be changed.');
  }
  return { current: app.date_money_received ? String(app.date_money_received).slice(0, 10) : null };
}

/**
 * Request a correction to an investment's date (owner 2026-08-27). It no longer
 * applies immediately — it goes through maker/checker approval, because moving the
 * money-received / interest-start date REBUILDS the schedule and shifts the first
 * period. 🔒 interest-logic-locked. Maker: NCD Manager+; Checker: Admin/CXO. The
 * change is held on the approval and applied only on final approve (below).
 * Single-credit investments only, and only while no interest is paid/batched.
 */
export async function editInvestmentDate(db: Db, actor: AuthUser, appId: number, newDate: string) {
  if (!['ncd_manager', 'admin', 'super_admin'].includes(actor.role)) {
    throw errors.forbidden('Only an NCD Manager or Admin can request an investment-date change');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(newDate)) throw errors.badRequest('A valid date (YYYY-MM-DD) is required');
  return db.withTx(async (tx) => {
    // Judge eligibility now so the maker gets immediate feedback; re-judged at approval.
    const { current } = await assertDateChangeable(tx, appId);
    const no = (await tx.query<{ application_no: string }>('SELECT application_no FROM applications WHERE id = $1', [appId])).rows[0]!.application_no;
    const req = await createApprovalRequest(tx, {
      type: 'investment_date_change', entityType: 'applications', entityId: appId, makerUserId: actor.id,
      metadata: { application_no: no, new_date: newDate, current_date: current },
    });
    await writeAudit(tx, { actorId: actor.id, action: 'application.investment-date.requested', entityType: 'applications', entityId: appId,
      after: { from: current, to: newDate } });
    return { ok: true, pending_approval: true, approval_request: req };
  });
}

// Apply the date correction on final approval. Only here does it touch the
// investment: move the money-received / interest-start date + rebuild the
// (all-unpaid) schedule + re-accrue. Re-asserts eligibility first, so a payout
// that landed between request and approval can't corrupt the schedule.
registerOnFinalApprove('investment_date_change', async (tx, req) => {
  if (!req.entity_id) return;
  const appId = Number(req.entity_id);
  const newDate = String(req.metadata.new_date ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(newDate)) throw errors.badRequest('The stored date is invalid');
  await assertDateChangeable(tx, appId);
  // The money-received date IS the interest-start date (owner rule 2026-07-27).
  await tx.query('UPDATE applications SET date_money_received = $1, interest_start_date = $1, updated_at = now() WHERE id = $2', [newDate, appId]);
  await tx.query('UPDATE application_lines SET date_money_received = $1 WHERE application_id = $2', [newDate, appId]);
  await tx.query("DELETE FROM disbursement_schedule WHERE application_id = $1 AND status <> 'Paid'", [appId]);
  const { materializeForApplication } = await import('../schedule/materialize.js');
  await materializeForApplication(tx, appId);
  const { accrueForApplication } = await import('../incentives/accrual.js');
  await accrueForApplication(tx, appId);
  await writeAudit(tx, { actorId: req.maker_user_id, action: 'application.investment-date.edit', entityType: 'applications', entityId: appId,
    after: { date_money_received: newDate, via: 'approval', request_id: req.id } });
});

// ONE credit on a clubbed investment whose date can still be corrected. Shared
// by the request and the apply, so both judge eligibility identically — the
// mirror of assertDateChangeable above. Returns the credit's current date so the
// approval can show old → new.
async function assertCreditDateChangeable(tx: Db, appId: number, lineId: number): Promise<{ current: string | null }> {
  const line = (await tx.query<{ application_id: string; date_money_received: string | null }>(
    'SELECT application_id, date_money_received FROM application_lines WHERE id = $1', [lineId])).rows[0];
  if (!line || Number(line.application_id) !== appId) throw errors.notFound('Credit not found on this investment');
  const count = Number((await tx.query<{ n: string }>(
    'SELECT count(*) AS n FROM application_lines WHERE application_id = $1', [appId])).rows[0]!.n);
  if (count < 2) {
    throw errors.badRequest('This investment has a single credit — change the investment date instead, so the credit and the investment stay in step.');
  }
  const locked = await tx.query(
    "SELECT 1 FROM disbursement_schedule WHERE application_id = $1 AND (status = 'Paid' OR batch_id IS NOT NULL) LIMIT 1", [appId]);
  if (locked.rowCount) {
    throw errors.conflict('Interest has already been paid or locked into a batch on this investment — its dates can no longer be changed.');
  }
  return { current: line.date_money_received ? String(line.date_money_received).slice(0, 10) : null };
}

/**
 * Request a correction to ONE credit's money-received date on a clubbed
 * investment (owner 2026-08-27). Like the investment-date change it does NOT
 * apply immediately — it goes through maker/checker, because moving a credit's
 * date rebuilds the schedule and shifts that credit's first period.
 * 🔒 interest-logic-locked. Maker: NCD Manager+; Checker: Admin/CXO.
 *
 * Why this exists alongside editInvestmentDate: a clubbed investment is ONE
 * debenture paid for on several days — the owner's example, 50,000 today,
 * 50,000 tomorrow, 1,00,000 the day after — and each credit earns from ITS OWN
 * date. There is no single "investment date" to move, so editInvestmentDate
 * refuses it outright. Until now that left NO way to fix a mistyped credit date
 * on screen at all; it took a hand-written database repair (8 of those on
 * 2026-08-26).
 *
 * Refused on a SINGLE-credit investment. There the credit's date and the
 * application's must stay equal, and moving only the credit creates precisely
 * the mismatch the payout health check reports — editInvestmentDate is the tool
 * for those, and it moves both.
 */
export async function editCreditDate(db: Db, actor: AuthUser, appId: number, lineId: number, newDate: string) {
  if (!['ncd_manager', 'admin', 'super_admin'].includes(actor.role)) {
    throw errors.forbidden('Only an NCD Manager or Admin can request a credit-date change');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(newDate)) throw errors.badRequest('A valid date (YYYY-MM-DD) is required');
  return db.withTx(async (tx) => {
    // Judge eligibility now so the maker gets immediate feedback; re-judged at approval.
    const { current } = await assertCreditDateChangeable(tx, appId, lineId);
    const no = (await tx.query<{ application_no: string }>('SELECT application_no FROM applications WHERE id = $1', [appId])).rows[0]!.application_no;
    const amount = (await tx.query<{ amount: string }>('SELECT amount FROM application_lines WHERE id = $1', [lineId])).rows[0]!.amount;
    const req = await createApprovalRequest(tx, {
      type: 'credit_date_change', entityType: 'application_lines', entityId: lineId, makerUserId: actor.id,
      // application_id travels on the request: the entity is the LINE, so the
      // handler cannot infer which investment to rebuild without it.
      metadata: { application_no: no, application_id: appId, line_id: lineId, amount: Number(amount), new_date: newDate, current_date: current },
    });
    await writeAudit(tx, { actorId: actor.id, action: 'application.credit-date.requested', entityType: 'application_lines', entityId: lineId,
      after: { application_id: appId, from: current, to: newDate } });
    return { ok: true, pending_approval: true, approval_request: req };
  });
}

// Apply the credit-date correction on final approval. Only here does it touch
// the investment. Re-asserts eligibility first, so a payout that landed between
// request and approval can't corrupt the schedule.
registerOnFinalApprove('credit_date_change', async (tx, req) => {
  const lineId = Number(req.metadata.line_id ?? req.entity_id ?? 0);
  const appId = Number(req.metadata.application_id ?? 0);
  if (!lineId || !appId) return;
  const newDate = String(req.metadata.new_date ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(newDate)) throw errors.badRequest('The stored date is invalid');
  const { current } = await assertCreditDateChangeable(tx, appId, lineId);

  await tx.query('UPDATE application_lines SET date_money_received = $1 WHERE id = $2', [newDate, lineId]);
  // Rebuild only if a schedule already EXISTS. An investment still awaiting its
  // own approval has none — it is generated at go-live, from these very dates —
  // and materialising one here would hand an unapproved investment a live
  // schedule as a side effect of a typo fix. Where one does exist, tear down the
  // unpaid rows and rebuild so this credit's first (broken) period moves with
  // it; nothing is Paid (guarded above), so the delete satisfies materialize's
  // "skip if already materialised" check.
  const existing = await tx.query('SELECT 1 FROM disbursement_schedule WHERE application_id = $1 LIMIT 1', [appId]);
  if (existing.rowCount) {
    await tx.query("DELETE FROM disbursement_schedule WHERE application_id = $1 AND status <> 'Paid'", [appId]);
    const { materializeForApplication } = await import('../schedule/materialize.js');
    await materializeForApplication(tx, appId);
    const { accrueForApplication } = await import('../incentives/accrual.js');
    await accrueForApplication(tx, appId);
  }
  await writeAudit(tx, {
    actorId: req.maker_user_id, action: 'application.credit-date.edit', entityType: 'application_lines', entityId: lineId,
    before: { date_money_received: current },
    after: { date_money_received: newDate, application_id: appId, via: 'approval', request_id: req.id },
  });
});

// markESigned() was removed on 2026-08-29. It stamped a signature date because a
// person clicked a button — no document, no evidence, no approval — which is the
// one thing an e-signature record must never be able to say.
//
// It was already obsolete: the owner's 2026-07-22 spec put a poller in place that
// asks Digio every 15 seconds and completes the signature itself, "with no
// webhook and no manual Mark eSigned". The poller shipped; the button did not get
// deleted with it. In the whole life of the system it was pressed once, and all
// 7 signed investments carry a real signed PDF — so nothing was ever recorded
// falsely. Removing it closes the possibility rather than fixing damage.
//
// Its honest replacement is digio.checkOneApplication(), which asks Digio instead
// of asking a human, and can only ever confirm what actually happened.

// A signature made ON PAPER is recorded by uploadSignedApplication() below
// (owner 2026-09-03). It sits on the RIGHT side of the same line: it demands an
// actual signed document, the date written on it and who uploaded it, where the
// deleted button demanded nothing at all.

/**
 * The signed application form, scanned back in (owner 2026-09-03).
 *
 * The investment form is ALREADY pre-filled and already carries signature boxes
 * — it is the document Digio signs — so the physical path prints that same form
 * from /api/reports/application-form/:id.pdf. All that was missing was anywhere
 * to put the signed copy.
 *
 * Unlike the locker agreement this does NOT go to a checker: marking an
 * investment signed has never been an approval step here, eSign is off the
 * critical path, and adding a gate to a daily flow nobody asked to slow down
 * would be a change to an existing process rather than the missing capability.
 * The uploader, the date on the paper and the document itself are all recorded,
 * so it is evidenced and auditable — which is what was actually absent.
 */
export async function uploadSignedApplication(
  db: Db, actor: AuthUser, appId: number,
  input: { data_base64: string; filename?: string | null; signed_on: string },
) {
  const signedOn = String(input.signed_on ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(signedOn)) throw errors.badRequest('Enter the date the customer signed, as it appears on the form.');
  if (signedOn > new Date().toISOString().slice(0, 10)) throw errors.badRequest('The signing date cannot be in the future.');

  const app = (await db.query<{ status: string }>('SELECT status FROM applications WHERE id = $1', [appId])).rows[0];
  if (!app) throw errors.notFound('Application not found');
  if (isTerminal('application', app.status)) throw errors.conflict('Application is closed');

  const { validateUpload, MAX_SIGNED_DOC_BYTES } = await import('../../lib/uploads.js');
  const { saveBuffer, removeStored } = await import('../../lib/storage.js');
  const { buffer, mime } = validateUpload(input.data_base64, MAX_SIGNED_DOC_BYTES);
  const filename = String(input.filename ?? '').trim() || `signed-application-${appId}.pdf`;
  const pages = mime === 'application/pdf'
    ? ((buffer.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length || null)
    : null;
  const stored = saveBuffer('signed-applications', filename, buffer);

  try {
    return await db.withTx(async (tx) => {
      await tx.query(
        `UPDATE applications
            SET signing_method = 'physical', esigned_at = COALESCE(esigned_at, now()),
                signed_on = $2::date, signed_doc_path = $3, signed_doc_filename = $4,
                signed_doc_mime = $5, signed_doc_pages = $6,
                signed_doc_uploaded_by_user_id = $7, updated_at = now()
          WHERE id = $1`,
        [appId, signedOn, stored.path, filename, mime, pages, actor.id]);
      await writeAudit(tx, {
        actorId: actor.id, action: 'application.signed.upload', entityType: 'applications', entityId: appId,
        after: { method: 'physical', signed_on: signedOn, pages, bytes: buffer.length },
      });
      return { ok: true, signing_method: 'physical', signed_on: signedOn, pages };
    });
  } catch (e) {
    // The row never landed, so the file must not survive it.
    removeStored(stored.path);
    throw e;
  }
}

/** The stored scan. For a physically signed investment THIS is the signed form. */
export async function getSignedApplication(db: Db, appId: number) {
  const r = (await db.query<Record<string, unknown>>(
    'SELECT signed_doc_path, signed_doc_mime, signed_doc_filename FROM applications WHERE id = $1', [appId])).rows[0];
  if (!r?.signed_doc_path) return null;
  const { readStored } = await import('../../lib/storage.js');
  const buffer = readStored(String(r.signed_doc_path));
  if (!buffer) return null;
  return { buffer, mime: (r.signed_doc_mime as string) ?? null, filename: (r.signed_doc_filename as string) ?? null };
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

/**
 * Consolidate a clubbed investment's projected schedule for display (owner
 * 2026-08-24, [[payout-tranche-consolidation]]). Each tranche's BROKEN first
 * period (its earliest Interest row) stays its own line; from the next date on,
 * a multi-tranche investment shows ONE combined row per date — the same view the
 * payout run and NEFT file produce. Summing the per-tranche rows also absorbs the
 * ₹0 sibling rows a settled batch leaves behind (the combined ₹ already sits on
 * the representative row). A single-tranche investment is a group of one, so its
 * schedule is unchanged.
 */
function consolidateSchedule(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  // Each line's earliest Interest date = that tranche's broken period → stays separate.
  const brokenDate = new Map<number, string>();
  for (const r of rows) {
    if (r.due_type !== 'Interest') continue;
    const line = Number(r.line_id), d = String(r.due_date);
    const cur = brokenDate.get(line);
    if (cur === undefined || d < cur) brokenDate.set(line, d);
  }
  const passthrough = (r: Record<string, unknown>) => ({
    id: r.id, due_date: r.due_date, due_type: r.due_type, gross_amount: r.gross_amount,
    tds_amount: r.tds_amount, net_amount: r.net_amount, status: r.status, paid_at: r.paid_at ?? null,
  });
  const out: Record<string, unknown>[] = [];
  const combined = new Map<string, Record<string, unknown> & { _statuses: Set<string>; _n: number; _minLine: number }>();
  for (const r of rows) {
    const isBroken = r.due_type === 'Interest' && brokenDate.get(Number(r.line_id)) === String(r.due_date);
    if (r.due_type !== 'Interest' || isBroken) { out.push(passthrough(r)); continue; }
    const k = String(r.due_date);
    const c = combined.get(k);
    if (!c) {
      combined.set(k, { id: r.id, due_date: r.due_date, due_type: 'Interest',
        gross_amount: Number(r.gross_amount), tds_amount: Number(r.tds_amount), net_amount: Number(r.net_amount),
        status: String(r.status), paid_at: (r.paid_at as unknown) ?? null,
        _statuses: new Set([String(r.status)]), _n: 1, _minLine: Number(r.line_id) });
    } else {
      c.gross_amount = Number(c.gross_amount) + Number(r.gross_amount);
      c.tds_amount = Number(c.tds_amount) + Number(r.tds_amount);
      c.net_amount = Number(c.net_amount) + Number(r.net_amount);
      c._statuses.add(String(r.status)); c._n += 1;
      if (Number(r.line_id) < c._minLine) { c._minLine = Number(r.line_id); c.id = r.id; }  // stable key = lowest tranche's row
      if (r.paid_at && (!c.paid_at || String(r.paid_at) > String(c.paid_at))) c.paid_at = r.paid_at;
    }
  }
  for (const c of combined.values()) {
    // Uniform status when the tranches agree; otherwise the least-settled wins so
    // a part-settled date never reads as fully Paid.
    const s = c._statuses;
    c.status = s.size === 1 ? [...s][0]! : s.has('Scheduled') ? 'Scheduled' : s.has('Failed') ? 'Failed' : [...s][0]!;
    c.combined = c._n > 1;          // the row is a real merge (used to label it + hide per-tranche mark-failed)
    c.tranche_count = c._n;
    delete (c as Partial<typeof c>)._statuses; delete (c as Partial<typeof c>)._n; delete (c as Partial<typeof c>)._minLine;
    out.push(c);
  }
  out.sort((a, b) => String(a.due_date).localeCompare(String(b.due_date)));
  return out;
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
  const schedule = consolidateSchedule((await db.query(
    'SELECT id, line_id, due_date, due_type, gross_amount, tds_amount, net_amount, status, paid_at FROM disbursement_schedule WHERE application_id = $1 ORDER BY due_date, line_id',
    [appId])).rows as Record<string, unknown>[]);
  // Where the signature actually stands. Staff could previously see only "signed"
  // or "not signed", with no way to tell a signature sitting with the customer
  // from one that was never sent — which is part of why a manual "Mark eSigned"
  // button felt necessary at all (owner 2026-08-29).
  //
  //   signed   — Digio confirmed it and the signed document is on file
  //   awaiting — sent, inside the poll window; the 15s poller is chasing it
  //   stalled  — sent, past the window; the poller has stopped, so a human may
  //              want to ask Digio once more
  //   not_sent — nothing has been sent
  //
  // The window comes from the poller itself, so the UI cannot offer a re-check
  // at a moment the cron is still handling.
  const { POLL_WINDOW_DAYS } = await import('../../integrations/digio/service.js');
  const session = (await db.query<{ created_at: string; days_old: number }>(
    `SELECT created_at, EXTRACT(EPOCH FROM (now() - created_at)) / 86400 AS days_old
       FROM digio_signing_sessions
      WHERE application_id = $1 AND status = 'requested'
      ORDER BY created_at DESC LIMIT 1`, [appId])).rows[0];
  const esignPending = !!session && !app.esigned_at;
  const esignStalled = esignPending && Number(session!.days_old) > POLL_WINDOW_DAYS;
  const esignState: 'signed' | 'awaiting' | 'stalled' | 'not_sent' =
    app.esigned_at ? 'signed' : esignStalled ? 'stalled' : esignPending ? 'awaiting' : 'not_sent';
  const esign = {
    state: esignState,
    sent_at: session?.created_at ?? null,
    days_waiting: session ? Math.floor(Number(session.days_old)) : null,
    poll_window_days: POLL_WINDOW_DAYS,
  };
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
  // esign_pending kept as-is so the existing auto-refresh keeps working; `esign`
  // carries the detail the screen now shows.
  return { application: app, lines, schedule, esign_pending: esignPending, esign, locker, adjustments };
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
