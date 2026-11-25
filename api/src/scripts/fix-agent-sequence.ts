/**
 * fix-agent-sequence — move the AG-#### counter past the codes already in use.
 *
 * WHY THIS EXISTS. On 2026-11-25 `number_sequences.agent` stood at 30 while
 * AG-0030 already belonged to an agent, so every attempt to register a new
 * referrer hit the UNIQUE constraint on agent_code — and, because that runs
 * inside an approval's transaction, took the whole approval down with it
 * ("Internal server error" on approving a customer correction).
 *
 * The code change beside this one (nextFreeAgentCode) makes allocation skip a
 * taken code, so the drift can no longer cause an outage. This script closes
 * the existing gap in one step instead of making the next registration walk
 * past thirty taken codes.
 *
 * DRY-RUN by default; --commit applies. It only ever moves the counter
 * FORWARD, so it cannot hand out a code somebody already holds.
 *
 *   node dist/scripts/fix-agent-sequence.js
 *   node dist/scripts/fix-agent-sequence.js --commit
 */
import { loadSecretsFromSsm } from '../secrets.js';
import { createDb } from '../db/index.js';

async function main(): Promise<void> {
  const commit = process.argv.includes('--commit');
  await loadSecretsFromSsm();
  const db = createDb();

  const cur = (await db.query<{ next_value: string }>(
    "SELECT next_value FROM number_sequences WHERE key = 'agent'")).rows[0];
  const used = (await db.query<{ n: string }>(
    `SELECT COALESCE(max(substring(agent_code from 4)::int), 0) AS n
       FROM agents WHERE agent_code ~ '^AG-[0-9]+$'`)).rows[0]!;

  const current = cur ? Number(cur.next_value) : 0;
  const highest = Number(used.n);
  const target = highest + 1;

  console.log(`[agent-seq] counter stands at ${current || '(none)'}; highest AG-#### in use is ${highest}`);
  if (current > highest) {
    console.log('[agent-seq] already ahead of every code in use — nothing to do.');
    return;
  }
  console.log(`[agent-seq] would set the counter to ${target}, so the next code is AG-${String(target).padStart(4, '0')}`);
  if (!commit) { console.log('[agent-seq] dry-run only — re-run with --commit to apply.'); return; }

  await db.query(
    `INSERT INTO number_sequences (key, next_value) VALUES ('agent', $1)
     ON CONFLICT (key) DO UPDATE SET next_value = GREATEST(number_sequences.next_value, EXCLUDED.next_value)`,
    [target]);
  const after = (await db.query<{ next_value: string }>(
    "SELECT next_value FROM number_sequences WHERE key = 'agent'")).rows[0]!;
  const clash = await db.query(
    "SELECT agent_code FROM agents WHERE agent_code = 'AG-' || lpad($1::text, 4, '0')", [after.next_value]);
  console.log(`[agent-seq] done — counter is ${after.next_value}; next code collides: ${clash.rows.length ? 'YES' : 'no'}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
