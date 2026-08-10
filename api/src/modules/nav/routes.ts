/**
 * Sidebar badge counts (owner 2026-08-10). One cheap, authenticated endpoint
 * the shell polls so each menu item can show how many items are waiting on the
 * current user — e.g. "Approvals (10)". Counts are scoped to what the user can
 * actually act on; a section they cannot see simply comes back 0 (and the item
 * is already hidden for them client-side). Keyed by the nav route so the shell
 * maps them straight onto NAV items.
 */
import { Router } from 'express';
import { asyncHandler } from '../../middleware/error.js';
import { requireAuth } from '../../middleware/auth.js';
import { getDb } from '../../db/index.js';
import { pendingApprovalsCount } from '../approvals/service.js';

export const navRouter = Router();

navRouter.get('/badges', requireAuth, asyncHandler(async (req, res) => {
  const user = req.user!;
  const db = getDb();
  const counts: Record<string, number> = {};

  counts['/app/approvals'] = await pendingApprovalsCount(db, user);

  // TDS ₹30L crossings waiting for approval — same gate as the sidebar item.
  if (user.permissions.includes('approvals:check-premature')) {
    counts['/app/tds-threshold'] = Number((await db.query<{ c: string }>(
      "SELECT count(*)::int AS c FROM tds_threshold_events WHERE status = 'PendingApproval'")).rows[0]!.c);
  }

  res.json({ counts });
}));
