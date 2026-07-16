/** Local file storage for uploads (KYC docs, receipts). In prod this is
 * /var/lib/dhanam-newwealth; in dev a ./data dir. (docs/01 §4) */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

function baseDir(): string {
  return process.env.FILE_STORAGE_DIR || resolve(process.cwd(), 'data', 'uploads');
}

/** Save a validated buffer under subdir; returns the relative stored path.
 * Callers must run lib/uploads.ts validateUpload() first — this only stores. */
export function saveBuffer(subdir: string, originalName: string, buffer: Buffer): { path: string } {
  const dir = join(baseDir(), subdir);
  mkdirSync(dir, { recursive: true });
  const safe = originalName.replace(/[^\w.-]/g, '_').slice(-60);
  const name = `${randomBytes(8).toString('hex')}-${safe}`;
  const full = join(dir, name);
  writeFileSync(full, buffer);
  return { path: join(subdir, name) };
}

export function readStored(relativePath: string): Buffer | null {
  const full = join(baseDir(), relativePath);
  if (!full.startsWith(baseDir())) return null; // path-traversal guard
  if (!existsSync(full)) return null;
  return readFileSync(full);
}
