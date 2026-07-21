/**
 * Go-live for one application (owner spec 2026-07-19). This is the single point
 * where a funded investment becomes a live NCD — money is recorded, the app
 * turns Active, its interest schedule is materialised and incentives accrue.
 *
 * It replaces the old two-step "confirm collection → batch activation" dance:
 * now the investment approval (staff-enrolled) or the app/LockerHub ingest
 * calls this directly. Idempotent — an already-Active app is a no-op.
 */
import type { Db } from '../../db/types.js';
import { assertTransition } from '../../lib/statusMachine.js';
import { toISODate } from '../../lib/dates.js';
import { nextCode } from '../../lib/sequences.js';
import { materializeForApplication } from '../schedule/materialize.js';
import { accrueForApplication } from '../incentives/accrual.js';
import { emitForApplication } from '../../integrations/lockerhub/customerEvents.js';

export interface GoLiveInput {
  /** Date the money hit Dhanam's account (staff-entered at enrolment). Falls
   * back to the app's stored date_money_received when omitted. */
  dateMoneyReceived?: string | null;
  amountReceived?: number | null;
  method?: string | null;
  reference?: string | null;
  /** User who recorded the receipt (a collections row is logged when known). */
  confirmedByUserId?: number | null;
}

/**
 * Take an application live. Sets money fields + interest_start_date, flips to
 * Active, materialises the schedule and accrues incentives — all idempotent.
 * Returns false if the app was already Active (or missing), true otherwise.
 */
export async function activateApplication(tx: Db, appId: number, input: GoLiveInput = {}): Promise<boolean> {
  const app = (await tx.query<{ status: string; series_id: string; total_amount: string; date_money_received: string | null }>(
    'SELECT status, series_id, total_amount, date_money_received FROM applications WHERE id = $1', [appId])).rows[0];
  if (!app) return false;
  if (app.status === 'Active') return false; // already live — no-op

  assertTransition('application', app.status, 'Active');

  const series = (await tx.query<{ deemed_date: string | null }>('SELECT deemed_date FROM series WHERE id = $1', [app.series_id])).rows[0];
  const deemed = toISODate(series?.deemed_date ?? null);
  const received = toISODate(input.dateMoneyReceived ?? app.date_money_received ?? null) ?? deemed ?? toISODate(new Date().toISOString())!;
  // interest_start_date = max(receipt date, series deemed date)
  const isd = deemed && deemed > received ? deemed : received;
  const amount = input.amountReceived != null ? input.amountReceived : Number(app.total_amount);

  // Log the collection when we have a recorder (staff/app). Skipped for pure
  // backfills where no receipt actor is known.
  if (input.confirmedByUserId != null || input.method) {
    const colNo = await nextCode(tx, 'collection', 'COL-{yyyy}-{seq:6}');
    await tx.query(
      'INSERT INTO collections (collection_no, application_id, amount, method, reference, collection_date, confirmed_by_user_id) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [colNo, appId, amount, input.method ?? 'Other', input.reference ?? null, received, input.confirmedByUserId ?? null]);
  }

  await tx.query(
    `UPDATE applications SET status = 'Active', amount_received = $1, date_money_received = $2,
            collection_method = COALESCE($3, collection_method), collection_reference = COALESCE($4, collection_reference),
            interest_start_date = $5, updated_at = now() WHERE id = $6`,
    [amount, received, input.method ?? null, input.reference ?? null, isd, appId]);

  await materializeForApplication(tx, appId);
  await accrueForApplication(tx, appId);

  // Generate + store the Acknowledgement now that funds are received and the
  // investment is live (owner: "generate + store"). Defensive — a PDF hiccup
  // must never fail activation.
  try {
    const { acknowledgmentPdf } = await import('../reports/forms/acknowledgment.js');
    const { saveBuffer } = await import('../../lib/storage.js');
    const pdf = await acknowledgmentPdf(tx, appId);
    const { path } = saveBuffer('acknowledgments', `acknowledgment-${appId}.pdf`, pdf);
    await tx.query('UPDATE applications SET acknowledgment_pdf_path = $1, acknowledgment_generated_at = now() WHERE id = $2', [path, appId]);
  } catch (e) {
    console.warn(`[documents] acknowledgement generation failed for app ${appId}: ${(e as Error).message}`);
  }

  // Tell LockerHub the NCD is live (contract event). No-op unless configured.
  await emitForApplication(tx, 'subscription.activated', appId);
  return true;
}
