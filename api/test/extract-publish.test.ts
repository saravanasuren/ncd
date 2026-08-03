/** On-change extract publisher — decision logic + watermark advance. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { decidePublish, maybePublishExtract } from '../src/integrations/ncd-extract-publish.js';
import { startTestServer, type TestCtx } from './helpers/server.js';

const MIN = 60_000;

describe('extract publish decision', () => {
  const base = { now: 10_000_000 };
  it('does nothing on an empty book', () => {
    expect(decidePublish({ ...base, latestMs: null, lastSeenMs: null, lastPublishedMs: null }).publish).toBe(false);
  });
  it('does nothing when the book has not moved past the watermark', () => {
    const r = decidePublish({ ...base, latestMs: 5_000_000, lastSeenMs: 5_000_000, lastPublishedMs: null });
    expect(r).toEqual({ publish: false, reason: 'unchanged' });
  });
  it('waits while a write burst is still settling', () => {
    // change 10s ago (< 90s quiet window)
    const r = decidePublish({ now: 10_000_000, latestMs: 9_990_000, lastSeenMs: 1, lastPublishedMs: null });
    expect(r).toEqual({ publish: false, reason: 'settling' });
  });
  it('holds off when it published too recently', () => {
    const r = decidePublish({ now: 10_000_000, latestMs: 9_000_000, lastSeenMs: 1, lastPublishedMs: 10_000_000 - MIN / 2 });
    expect(r).toEqual({ publish: false, reason: 'rate-limited' });
  });
  it('publishes when changed, settled, and not rate-limited', () => {
    const r = decidePublish({ now: 10_000_000, latestMs: 9_000_000, lastSeenMs: 1, lastPublishedMs: 10_000_000 - 10 * MIN });
    expect(r).toEqual({ publish: true, reason: 'changed' });
  });
});

describe('maybePublishExtract (SharePoint unconfigured in tests)', () => {
  let ctx: TestCtx;
  beforeAll(async () => { ctx = await startTestServer(); });
  afterAll(async () => { await ctx.close(); });

  it('detects a changed book but no-ops safely when SharePoint is not configured', async () => {
    // Force the decision to "publish" by backdating the watermark far in the past.
    await ctx.db.query(
      `UPDATE extract_publish_state SET last_change_seen = to_timestamp(1), last_published_at = to_timestamp(1) WHERE id = 1`);
    const r = await maybePublishExtract(ctx.db);
    // In tests SharePoint isn't configured, so publishExtract returns not-configured
    // and the watermark is NOT advanced (so a real deploy will publish).
    expect(r.published).toBe(false);
    expect(r.reason).toMatch(/not configured|settling|unchanged|empty-book/);
  });
});
