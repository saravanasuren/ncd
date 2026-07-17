#!/usr/bin/env node
/**
 * Offsite backup copy → SharePoint via Microsoft Graph (client-credentials).
 * No npm dependencies — uses Node 18+ global fetch. Reuses the same Azure app
 * as the old wealth app (shared creds); uploads into its own folder so the two
 * apps' backups don't mix.
 *
 * Env (from SSM /dhanam/newwealth/*, loaded by backup.sh):
 *   SHAREPOINT_TENANT_ID, SHAREPOINT_CLIENT_ID, SHAREPOINT_CLIENT_SECRET,
 *   SHAREPOINT_BACKUP_DRIVE_ID, SHAREPOINT_BACKUP_FOLDER (default NewWealthBackups)
 *
 * Soft-fails (exit 0) when not configured, so a missing/rotated secret never
 * blocks the local dump. A real upload error exits 1 (backup.sh treats it as a
 * warning — the local dump is already safe by then).
 */
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

const file = process.argv[2];
if (!file) { console.error('usage: upload-sharepoint.mjs <file>'); process.exit(2); }

const tenant = process.env.SHAREPOINT_TENANT_ID;
const clientId = process.env.SHAREPOINT_CLIENT_ID;
const secret = process.env.SHAREPOINT_CLIENT_SECRET;
const driveId = process.env.SHAREPOINT_BACKUP_DRIVE_ID;
const folder = process.env.SHAREPOINT_BACKUP_FOLDER || 'NewWealthBackups';

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

  // 2) simple upload (Graph PUT :/content supports up to 250 MB — our gzip dump is a few MB)
  const bytes = await readFile(file);
  const name = basename(file);
  const url = `https://graph.microsoft.com/v1.0/drives/${driveId}/root:/${encodeURIComponent(folder)}/${encodeURIComponent(name)}:/content`;
  const up = await fetch(url, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/octet-stream' },
    body: bytes,
  });
  if (!up.ok) throw new Error(`upload ${up.status}: ${(await up.text()).slice(0, 300)}`);
  const item = await up.json();
  console.log(`[sharepoint] uploaded ${name} → ${folder}/ (${item.size ?? bytes.length} bytes)`);
}

main().catch((e) => { console.error('[sharepoint] offsite copy FAILED:', e.message); process.exit(1); });
