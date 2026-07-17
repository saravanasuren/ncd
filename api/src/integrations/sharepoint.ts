/**
 * SharePoint / Microsoft Graph adapter — ported from the wealth app's
 * sharepoint.js. Used for the nightly backup offsite copy (docs/08 §2).
 *
 * Stub-pattern: until SHAREPOINT_TENANT_ID/CLIENT_ID/CLIENT_SECRET are in SSM,
 * isConfigured() is false and callers degrade gracefully.
 *
 * Azure app registration needs the APPLICATION permission Files.ReadWrite.All
 * (admin-consented) for uploads. Client secret expires 2028-07-09 — the daily
 * backup-check email carries the renewal reminder (backup-check.ts).
 *
 * Auth: OAuth2 client-credentials; token cached until 5 min before expiry.
 */
import { config } from '../config.js';

let tokenCache: { token: string | null; expiresAt: number } = { token: null, expiresAt: 0 };

export function isConfigured(): boolean {
  return !!(config.SHAREPOINT_TENANT_ID && config.SHAREPOINT_CLIENT_ID && config.SHAREPOINT_CLIENT_SECRET);
}

async function getToken(): Promise<string> {
  const now = Date.now();
  if (tokenCache.token && now < tokenCache.expiresAt - 5 * 60 * 1000) return tokenCache.token;
  const body = new URLSearchParams({
    client_id: config.SHAREPOINT_CLIENT_ID!,
    client_secret: config.SHAREPOINT_CLIENT_SECRET!,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  });
  const r = await fetch(`https://login.microsoftonline.com/${config.SHAREPOINT_TENANT_ID}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!r.ok) throw new Error(`SharePoint token request failed (${r.status}): ${(await r.text().catch(() => '')).slice(0, 300)}`);
  const j = (await r.json()) as { access_token: string; expires_in?: number };
  tokenCache = { token: j.access_token, expiresAt: now + (Number(j.expires_in) || 3600) * 1000 };
  return tokenCache.token!;
}

/** Simple PUT upload (fine under ~250 MB; nightly dumps are ~1 MB). */
export async function uploadFile(driveId: string, pathInDrive: string, buffer: Buffer): Promise<{ id: string; name: string; size: number; webUrl: string }> {
  const token = await getToken();
  const clean = String(pathInDrive).replace(/^\/+/, '');
  const url = `https://graph.microsoft.com/v1.0/drives/${encodeURIComponent(driveId)}` +
    `/root:/${clean.split('/').map(encodeURIComponent).join('/')}:/content`;
  const r = await fetch(url, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' },
    body: new Uint8Array(buffer),
  });
  if (!r.ok) throw new Error(`SharePoint upload failed (${r.status}): ${(await r.text().catch(() => '')).slice(0, 300)}`);
  return r.json() as Promise<{ id: string; name: string; size: number; webUrl: string }>;
}

/** Newest file in a drive folder (name DESC — filenames are date-stamped, and
 * name ordering is supported on every drive). null = folder absent/empty. */
export async function newestInFolder(driveId: string, folderPath: string): Promise<{ name: string; size: number; lastModified: string } | null> {
  const token = await getToken();
  const clean = String(folderPath).replace(/^\/+|\/+$/g, '');
  const url = `https://graph.microsoft.com/v1.0/drives/${encodeURIComponent(driveId)}` +
    `/root:/${clean.split('/').map(encodeURIComponent).join('/')}:/children` +
    `?$select=name,size,lastModifiedDateTime&$orderby=name%20desc&$top=1`;
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), 8000);
  let r: Response;
  try {
    r = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: ctrl.signal });
  } finally { clearTimeout(tid); }
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`SharePoint folder list failed (${r.status}): ${(await r.text().catch(() => '')).slice(0, 200)}`);
  const j = (await r.json()) as { value?: { name: string; size: number; lastModifiedDateTime: string }[] };
  const it = j.value?.[0];
  return it ? { name: it.name, size: Number(it.size) || 0, lastModified: it.lastModifiedDateTime } : null;
}
