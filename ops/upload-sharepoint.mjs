#!/usr/bin/env node
/**
 * Upload file(s) → SharePoint via Microsoft Graph (client-credentials). No npm
 * dependencies — uses Node 18+ global fetch. Reuses the same Azure app as the
 * old wealth app (shared creds); uploads into its own folder so nothing mixes.
 *
 * Two callers today:
 *   backup.sh        one .sql.gz → SHAREPOINT_BACKUP_FOLDER (disaster recovery)
 *   daily-extract.sh several .csv → --folder <dashboard folder> (BI feed)
 *
 * Usage:
 *   upload-sharepoint.mjs <file> [more files…] [--folder <name>]
 *
 * Env (from SSM /dhanam/newwealth/*, exported by the calling script):
 *   SHAREPOINT_TENANT_ID, SHAREPOINT_CLIENT_ID, SHAREPOINT_CLIENT_SECRET,
 *   SHAREPOINT_BACKUP_DRIVE_ID, SHAREPOINT_BACKUP_FOLDER (default NewWealthBackups)
 *
 * Soft-fails (exit 0) when not configured, so a missing/rotated secret never
 * blocks the caller. A real upload error exits 1. Uploads every file it was
 * given even if one fails, then exits non-zero — a half-written dashboard feed
 * must be visible, not silently partial.
 */
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

const argv = process.argv.slice(2);
const fIdx = argv.indexOf('--folder');
const folderOverride = fIdx > -1 ? argv[fIdx + 1] : undefined;
const files = argv.filter((v, i) => !v.startsWith('--') && i !== fIdx + 1);
if (!files.length) { console.error('usage: upload-sharepoint.mjs <file> [more…] [--folder <name>]'); process.exit(2); }

const tenant = process.env.SHAREPOINT_TENANT_ID;
const clientId = process.env.SHAREPOINT_CLIENT_ID;
const secret = process.env.SHAREPOINT_CLIENT_SECRET;
const driveId = process.env.SHAREPOINT_BACKUP_DRIVE_ID;
const folder = folderOverride || process.env.SHAREPOINT_BACKUP_FOLDER || 'NewWealthBackups';

if (!tenant || !clientId || !secret || !driveId) {
  console.error('[sharepoint] not configured (SHAREPOINT_* missing) — skipping offsite copy');
  process.exit(0); // soft-skip; local dump is unaffected
}

async function main() {
  // 1) app-only access token
  const tok = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId, client_secret: secret,
      grant_type: 'client_credentials', scope: 'https://graph.microsoft.com/.default',
    }),
  });
  if (!tok.ok) throw new Error(`token ${tok.status}: ${(await tok.text()).slice(0, 300)}`);
  const { access_token } = await tok.json();

  // 2) simple upload (Graph PUT :/content supports up to 250 MB — ours are KB/MB)
  let failed = 0;
  for (const file of files) {
    const bytes = await readFile(file);
    const name = basename(file);
    const url = `https://graph.microsoft.com/v1.0/drives/${driveId}/root:/${encodeURIComponent(folder)}/${encodeURIComponent(name)}:/content`;
    const up = await fetch(url, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/octet-stream' },
      body: bytes,
    });
    if (!up.ok) {
      failed++;
      console.error(`[sharepoint] ${name} FAILED ${up.status}: ${(await up.text()).slice(0, 200)}`);
      continue;
    }
    const item = await up.json();
    console.log(`[sharepoint] uploaded ${name} → ${folder}/ (${item.size ?? bytes.length} bytes)`);
  }
  if (failed) throw new Error(`${failed} of ${files.length} upload(s) failed`);
}

main().catch((e) => { console.error('[sharepoint] upload FAILED:', e.message); process.exit(1); });
