/** Upload validation (lib/uploads): magic-byte sniffing, size cap, safe serving. */
import { describe, it, expect } from 'vitest';
import { validateUpload, serveHeaders, MAX_UPLOAD_BYTES } from '../src/lib/uploads.js';

const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64');

describe('validateUpload', () => {
  it('accepts a PDF and returns the sniffed mime regardless of client claims', () => {
    const r = validateUpload(b64('%PDF-1.7 fake body'));
    expect(r.mime).toBe('application/pdf');
  });

  it('accepts JPEG/PNG/WebP magic bytes', () => {
    expect(validateUpload(b64(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]))).mime).toBe('image/jpeg');
    expect(validateUpload(b64(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]))).mime).toBe('image/png');
    expect(validateUpload(b64(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]))).mime).toBe('image/webp');
  });

  it('rejects HTML masquerading as an image (stored-XSS vector)', () => {
    expect(() => validateUpload(b64('<html><script>alert(1)</script></html>'))).toThrow(/Only JPEG, PNG, WebP or PDF/);
  });

  it('rejects empty and oversized payloads', () => {
    expect(() => validateUpload('')).toThrow(/Empty/);
    const big = Buffer.alloc(MAX_UPLOAD_BYTES + 1, 0x41);
    big.set(Buffer.from('%PDF-'), 0);
    expect(() => validateUpload(big.toString('base64'))).toThrow(/too large/);
  });
});

describe('serveHeaders', () => {
  it('serves allow-listed mimes inline with a sanitized filename', () => {
    const h = serveHeaders('application/pdf', 'state"ment\r\n.pdf', 'receipt');
    expect(h.type).toBe('application/pdf');
    expect(h.disposition).toBe('inline; filename="state_ment__.pdf"');
  });

  it('forces unknown/legacy mimes to a plain download', () => {
    const h = serveHeaders('text/html', null, 'receipt');
    expect(h.type).toBe('application/octet-stream');
    expect(h.disposition.startsWith('attachment;')).toBe(true);
  });
});
