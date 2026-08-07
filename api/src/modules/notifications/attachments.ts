/**
 * Files a queued notification carries, built at SEND time.
 *
 * Deliberately a registry rather than an `if` in the drain: the queue should not
 * grow a reports import, and a future report that wants attaching adds a line
 * here instead of another branch in the sender.
 *
 * Built at send time, never stored on the queue row — an Excel workbook has no
 * business inside a JSONB payload, and a retry three hours later should carry
 * the book as it stands then rather than a stale copy.
 */
import type { Db } from '../../db/types.js';
import type { Attachment } from '../../integrations/notify/index.js';

type Builder = (db: Db, payload: Record<string, unknown>) => Promise<Attachment | null>;

const BUILDERS: Record<string, Builder> = {
  /** The daily transaction register (owner 2026-08-05). */
  transactions_daily: async (db, payload) => {
    const { transactionsWorkbookBuffer } = await import('../reports/export.js');
    // Whole-book scope on purpose: this is a management report going to an
    // explicitly configured address list, not something a scoped user asked
    // for. A super-admin actor is what makes it the whole register.
    const actor = { id: 0, role: 'super_admin', branchIds: [], agentId: null, customerId: null, permissions: [] };
    const content = await transactionsWorkbookBuffer(db, actor as never, {});
    const date = String(payload.report_date ?? '').slice(0, 10) || 'latest';
    return {
      filename: `dhanam-transactions-${date}.xlsx`,
      content,
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    };
  },
};

/** The attachment for a queued row, or null when that template carries none. */
export async function attachmentFor(db: Db, template: string, payload: Record<string, unknown>): Promise<Attachment | null> {
  const build = BUILDERS[template];
  if (!build) return null;
  return build(db, payload);
}
