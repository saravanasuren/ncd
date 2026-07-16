/**
 * Upload validation & safe serving (docs/10 §3 hardening). Uploaded bytes are
 * staff/customer-supplied and served back from our own origin, so the client's
 * mime and filename are never trusted: the type is sniffed from magic bytes,
 * capped in size, and anything outside the allow-list is refused at upload —
 * and served as a download, never inline, if a legacy row slips through.
 */
import { errors } from './errors.js';

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024; // decoded bytes

const SNIFF: [string, (b: Buffer) => boolean][] = [
  ['application/pdf', (b) => b.subarray(0, 5).toString('latin1') === '%PDF-'],
  ['image/png', (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))],
  ['image/jpeg', (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ['image/webp', (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP'],
];

export const ALLOWED_MIMES = new Set(SNIFF.map(([m]) => m));

/** Decode + validate an upload; returns the buffer and the SNIFFED mime (the
 * client-declared one is ignored). Throws 400 on empty/oversized/unknown types. */
export function validateUpload(dataBase64: string): { buffer: Buffer; mime: string } {
  const buffer = Buffer.from(dataBase64, 'base64');
  if (!buffer.length) throw errors.badRequest('Empty file');
  if (buffer.length > MAX_UPLOAD_BYTES) throw errors.badRequest('File too large (max 5 MB)');
  const hit = SNIFF.find(([, test]) => test(buffer));
  if (!hit) throw errors.badRequest('Only JPEG, PNG, WebP or PDF files are accepted');
  return { buffer, mime: hit[0] };
}

/** Headers for serving a stored upload. Only allow-listed types render inline;
 * anything else (legacy rows predating validation) downloads as a plain file. */
export function serveHeaders(storedMime: string | null | undefined, filename: string | null | undefined, fallback: string): { type: string; disposition: string } {
  const inline = !!storedMime && ALLOWED_MIMES.has(storedMime);
  const safe = String(filename ?? fallback).replace(/[^\w.\- ]/g, '_').slice(0, 80) || fallback;
  return {
    type: inline ? storedMime! : 'application/octet-stream',
    disposition: `${inline ? 'inline' : 'attachment'}; filename="${safe}"`,
  };
}
