/**
 * Bank-statement upload + matching (docs/00 §6). A statement line that
 * matches a batched Scheduled disbursement (by net amount) flips it to Paid
 * at the statement's value date + UTR — the authoritative Paid source. Paid
 * rows never move.
 */
import type { Db } from '../../db/types.js';
import type { AuthUser } from '../../lib/authUser.js';
import { errors } from '../../lib/errors.js';
import { writeAudit } from '../../lib/audit.js';

export interface StatementLineInput {
  value_date: string;
  amount: number;
  reference?: string;
  utr?: string;
}

export async function uploadStatement(db: Db, actor: AuthUser, sourceBank: string, lines: StatementLineInput[]) {
  return db.withTx(async (tx) => {
    const { rows } = await tx.query<{ id: string }>('INSERT INTO bank_statements (source_bank, line_count, uploaded_by_user_id) VALUES ($1,$2,$3) RETURNING id', [sourceBank, lines.length, actor.id]);
    const stmtId = Number(rows[0]!.id);
    for (const l of lines) {
      await tx.query('INSERT INTO bank_statement_lines (statement_id, value_date, amount, reference, utr) VALUES ($1,$2,$3,$4,$5)',
        [stmtId, l.value_date, l.amount, l.reference ?? null, l.utr ?? null]);
    }
    await writeAudit(tx, { actorId: actor.id, action: 'statement.upload', entityType: 'bank_statements', entityId: stmtId, after: { lines: lines.length } });
    return { statement_id: stmtId, line_count: lines.length };
  });
}

/** Auto-match unmatched lines to batched Scheduled rows by net amount. */
export async function runMatch(db: Db, actor: AuthUser, statementId: number) {
  return db.withTx(async (tx) => {
    const lines = (await tx.query<{ id: string; amount: string; value_date: string; utr: string | null }>(
      "SELECT id, amount, value_date, utr FROM bank_statement_lines WHERE statement_id = $1 AND status = 'Unmatched' ORDER BY id", [statementId])).rows;
    let matched = 0;
    for (const line of lines) {
      const row = (await tx.query<{ id: string }>(
        `SELECT id FROM disbursement_schedule WHERE status = 'Scheduled' AND batch_id IS NOT NULL AND net_amount = $1
         ORDER BY id LIMIT 1`, [line.amount])).rows[0];
      if (!row) continue;
      const dsId = Number(row.id);
      await tx.query("UPDATE disbursement_schedule SET status = 'Paid', paid_at = $1, utr = COALESCE(utr, $2) WHERE id = $3", [line.value_date, line.utr, dsId]);
      await tx.query("UPDATE bank_statement_lines SET status = 'Matched', matched_schedule_id = $1 WHERE id = $2", [dsId, Number(line.id)]);
      matched++;
    }
    await tx.query('UPDATE bank_statements SET matched_count = matched_count + $1 WHERE id = $2', [matched, statementId]);
    await writeAudit(tx, { actorId: actor.id, action: 'statement.match', entityType: 'bank_statements', entityId: statementId, after: { matched } });
    return { matched, unmatched: lines.length - matched };
  });
}

export async function listStatements(db: Db) {
  return (await db.query('SELECT id, source_bank, line_count, matched_count, created_at FROM bank_statements ORDER BY id DESC LIMIT 100')).rows;
}
