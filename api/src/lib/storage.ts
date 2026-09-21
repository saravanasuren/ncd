/** Local file storage for uploads (KYC docs, receipts). In prod this is
 * /var/lib/dhanam-newwealth; in dev a ./data dir. (docs/01 §4) */
import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';

/** Where files land when FILE_STORAGE_DIR is unset. */
function defaultDir(): string {
  return resolve(process.cwd(), 'data', 'uploads');
}

function baseDir(): string {
  return process.env.FILE_STORAGE_DIR || defaultDir();
}

/**
 * For anything that runs OUTSIDE the service and saves files.
 *
 * In production FILE_STORAGE_DIR is set by the systemd unit
 * (ops/dhanam-newwealth.service) — NOT by .env. A script run from a shell,
 * following its own documented `set -a && . ./.env` procedure, therefore has it
 * unset, and storage falls back to <cwd>/data/uploads. The signature is recorded,
 * the reference is saved in the database, and the PDF sits in a directory the
 * service never reads: "signed, and the copy can't be fetched". Refuse instead.
 */
export function requireServiceStorageDir(): string {
  const dir = process.env.FILE_STORAGE_DIR;
  if (!dir) {
    throw new Error(
      'FILE_STORAGE_DIR is not set. Files this script saves would land in '
      + `${defaultDir()}, where the running service (FILE_STORAGE_DIR=/var/lib/dhanam-newwealth, `
      + 'set in its systemd unit, not in .env) will never read them. '
      + 'Run `export FILE_STORAGE_DIR=/var/lib/dhanam-newwealth` first.');
  }
  return dir;
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

/** `relativePath` under `root`, or null if it would escape it. */
function within(root: string, relativePath: string): string | null {
  const base = resolve(root);
  const full = resolve(base, relativePath);
  return full.startsWith(base + sep) ? full : null;
}

/** Best-effort delete of a stored upload — used to clean up when the DB write
 * the file belongs to fails, so a rolled-back row never leaves an orphan file. */
export function removeStored(relativePath: string): void {
  const full = within(baseDir(), relativePath);
  if (!full) return; // path-traversal guard
  try { unlinkSync(full); } catch { /* already gone */ }
}

/**
 * Read a stored file: the configured directory first, then the directory files
 * fall into when FILE_STORAGE_DIR is unset.
 *
 * The second look exists for files a shell script saved before it refused to
 * (see requireServiceStorageDir): their references are in the database and their
 * bytes are in <cwd>/data/uploads. For the service, cwd is /home/ubuntu/ncd/api
 * — the same place a script run from ~/ncd/api writes — so those files are found
 * without moving anything. Both lookups keep the path-traversal guard, and a
 * file found this way is logged so the leftovers can be found and moved.
 */
export function readStored(relativePath: string): Buffer | null {
  const roots = [baseDir()];
  if (resolve(defaultDir()) !== resolve(baseDir())) roots.push(defaultDir());
  for (const [i, root] of roots.entries()) {
    const full = within(root, relativePath);
    if (!full || !existsSync(full)) continue;
    if (i > 0) console.warn(`[storage] ${relativePath} was not in ${baseDir()} — served from ${root}. A script saved it without FILE_STORAGE_DIR; move it.`);
    return readFileSync(full);
  }
  return null;
}
