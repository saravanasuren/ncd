/**
 * On-change SharePoint extract publisher (owner 2026-08-03).
 *
 * Keeps the SharePoint dashboard feed fresh within ~1–2 minutes of any money
 * event (new investment, redemption, allotment, interest payout) — not just the
 * nightly cron. Change is detected by the book's newest `updated_at`/`created_at`
 * across applications / redemptions / application_lines (a pull-based fingerprint,
 * so there are no hooks to add at every write site and nothing can be missed).
 *
 * Each publish uploads the SAME files the nightly extract produces, to two places:
 *   · <folder>/                       — stable "latest" (overwritten; keeps the
 *                                       existing dashboard's fixed path working)
 *   · <folder>/runs/<timestamp>/      — a kept, timestamped snapshot (history)
 *
 * Debounced: publish only once the book has been quiet for QUIET_MS, and never
 * more than once per MIN_GAP_MS, so a burst of writes becomes one upload.
 */
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Db } from '../db/types.js';
import { config } from '../config.js';
import { isConfigured, uploadFile } from './sharepoint.js';
import { buildExtract } from '../scripts/daily-extract.js';

const QUIET_MS = 90_000;    // wait for a write burst to settle before publishing
const MIN_GAP_MS = 60_000;  // never publish more than ~once a minute

/** The book's newest change instant (ms epoch), or null if the book is empty. */
export async function bookLatestChangeMs(db: Db): Promise<number | null> {
  // Money events: applications.updated_at (new investment / activation / allotment /
  // status), redemptions.created_at, payout_batches.created_at (interest payouts).
  const r = (await db.query<{ ms: string | null }>(
    `SELECT (EXTRACT(EPOCH FROM GREATEST(
        COALESCE((SELECT max(updated_at) FROM applications),     to_timestamp(0)),
        COALESCE((SELECT max(created_at) FROM redemptions),      to_timestamp(0)),
        COALESCE((SELECT max(created_at) FROM payout_batches),   to_timestamp(0))
      )) * 1000)::bigint::text AS ms`)).rows[0];
  const ms = r?.ms ? Number(r.ms) : 0;
  return ms > 0 ? ms : null;
}

/** Pure decision: given the current fingerprint + stored state, publish now? */
export function decidePublish(input: {
  latestMs: number | null;
  lastSeenMs: number | null;
  lastPublishedMs: number | null;
  now: number;
}): { publish: boolean; reason: string } {
  const { latestMs, lastSeenMs, lastPublishedMs, now } = input;
  if (latestMs == null) return { publish: false, reason: 'empty-book' };
  if (lastSeenMs != null && latestMs <= lastSeenMs) return { publish: false, reason: 'unchanged' };
  if (now - latestMs < QUIET_MS) return { publish: false, reason: 'settling' };
  if (lastPublishedMs != null && now - lastPublishedMs < MIN_GAP_MS) return { publish: false, reason: 'rate-limited' };
  return { publish: true, reason: 'changed' };
}

/** Build the extract and upload it to SharePoint (stable latest + history). */
export async function publishExtract(db: Db): Promise<{ ok: boolean; files: number; stamp: string; note?: string }> {
  if (!isConfigured() || !config.SHAREPOINT_BACKUP_DRIVE_ID) {
    return { ok: false, files: 0, stamp: '', note: 'SharePoint not configured' };
  }
  const driveId = config.SHAREPOINT_BACKUP_DRIVE_ID;
  const folder = config.SHAREPOINT_EXTRACT_FOLDER;
  const dir = mkdtempSync(join(tmpdir(), 'ncd-extract-'));
  try {
    const { generatedAt, files } = await buildExtract(db, dir);
    const stamp = generatedAt.replace(/[:.]/g, '-'); // safe as a folder segment
    let n = 0;
    for (const f of files) {
      const full = join(dir, f);
      if (!existsSync(full)) continue;
      const buf = readFileSync(full);
      await uploadFile(driveId, `${folder}/${f}`, buf);                // stable latest
      await uploadFile(driveId, `${folder}/runs/${stamp}/${f}`, buf);  // kept history
      n++;
    }
    return { ok: true, files: n, stamp };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The cron worker entry point. Reads the fingerprint + state, decides, and — only
 * when it should — publishes and advances the state. Never throws; a publish
 * failure leaves last_change_seen unchanged so the next tick retries.
 */
export async function maybePublishExtract(db: Db, now = Date.now()): Promise<{ published: boolean; reason: string }> {
  const state = (await db.query<{ last_change_seen: string | null; last_published_at: string | null }>(
    `SELECT last_change_seen, last_published_at FROM extract_publish_state WHERE id = 1`)).rows[0] ?? { last_change_seen: null, last_published_at: null };
  const latestMs = await bookLatestChangeMs(db);
  const lastSeenMs = state.last_change_seen ? new Date(state.last_change_seen).getTime() : null;
  const lastPublishedMs = state.last_published_at ? new Date(state.last_published_at).getTime() : null;

  const decision = decidePublish({ latestMs, lastSeenMs, lastPublishedMs, now });
  if (!decision.publish) return { published: false, reason: decision.reason };

  const r = await publishExtract(db);
  if (!r.ok) return { published: false, reason: r.note ?? 'publish-failed' };

  // Advance the watermark only after a successful publish.
  await db.query(
    `UPDATE extract_publish_state SET last_change_seen = to_timestamp($1 / 1000.0), last_published_at = now() WHERE id = 1`,
    [latestMs]);
  return { published: true, reason: `published ${r.files} files @ ${r.stamp}` };
}
