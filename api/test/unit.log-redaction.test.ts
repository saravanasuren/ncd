/**
 * The access log was recording customer identifiers because several routes
 * carry them in the URL. These are the shapes actually found in one week of
 * production logs, plus the ones that must survive so the log stays useful.
 */
import { describe, it, expect } from 'vitest';
import { redactPiiInUrl, installRedactedUrlToken } from '../src/lib/logRedaction.js';

describe('identifiers are stripped from a logged URL', () => {
  it('the route that logged ~2,100 phone numbers in a week', () => {
    const out = redactPiiInUrl('/api/integration/customers-by-phone/9876543210');
    expect(out).toBe('/api/integration/customers-by-phone/<phone>');
    expect(out).not.toMatch(/\d{10}/);
  });

  it('the singular variant of it, and the locker lookup by phone', () => {
    expect(redactPiiInUrl('/api/integration/customer-by-phone/9876543210'))
      .toBe('/api/integration/customer-by-phone/<phone>');
    expect(redactPiiInUrl('/api/lockers/customers/9123456789'))
      .toBe('/api/lockers/customers/<phone>');
  });

  it('a PAN in the path', () => {
    expect(redactPiiInUrl('/api/lockers/customers/by-pan/ABCDE1234F'))
      .toBe('/api/lockers/customers/by-pan/<pan>');
  });

  it('a search term, which is a NAME as often as a number', () => {
    // No pattern can recognise "Ramasamy Krishnan" as personal data, so the
    // whole value goes — this is why free-text parameters are handled by name.
    expect(redactPiiInUrl('/api/dashboard/search?q=Ramasamy%20Krishnan'))
      .toBe('/api/dashboard/search?q=<redacted>');
    expect(redactPiiInUrl('/api/dashboard/search?q=ABCDE1234F'))
      .toBe('/api/dashboard/search?q=<redacted>');
  });

  it('identifiers passed as query parameters', () => {
    expect(redactPiiInUrl('/api/customers?phone=9876543210&page=2'))
      .toBe('/api/customers?phone=<redacted>&page=2');
    expect(redactPiiInUrl('/api/customers?pan=ABCDE1234F'))
      .toBe('/api/customers?pan=<redacted>');
  });

  it('an email address and an Aadhaar-shaped run', () => {
    expect(redactPiiInUrl('/api/portal/verify/someone@example.com')).toBe('/api/portal/verify/<email>');
    expect(redactPiiInUrl('/api/kyc/123456789012')).toBe('/api/kyc/<aadhaar>');
  });

  it('several identifiers in one URL all go', () => {
    const out = redactPiiInUrl('/api/x/9876543210/y/ABCDE1234F');
    expect(out).toBe('/api/x/<phone>/y/<pan>');
  });
});

describe('the log stays worth reading', () => {
  it('ordinary paging and filter parameters are untouched', () => {
    expect(redactPiiInUrl('/api/customers?page=2&limit=50')).toBe('/api/customers?page=2&limit=50');
    expect(redactPiiInUrl('/api/reports/book?from=2026-04-01&to=2026-09-30'))
      .toBe('/api/reports/book?from=2026-04-01&to=2026-09-30');
  });

  it('record ids are not mistaken for identifiers', () => {
    // Ids are nowhere near ten digits, and a date or an amount must not be
    // eaten either — over-redacting would make the log useless.
    expect(redactPiiInUrl('/api/applications/1249/lines')).toBe('/api/applications/1249/lines');
    expect(redactPiiInUrl('/api/customers/563')).toBe('/api/customers/563');
    expect(redactPiiInUrl('/api/payouts?amount=427.50')).toBe('/api/payouts?amount=427.50');
  });

  it('the route itself always survives, so the log still shows what was called', () => {
    for (const url of [
      '/api/integration/customers-by-phone/9876543210',
      '/api/lockers/customers/by-pan/ABCDE1234F',
      '/api/dashboard/search?q=someone',
    ]) {
      expect(redactPiiInUrl(url).split('?')[0]).toContain('/api/');
      expect(redactPiiInUrl(url)).toContain(url.split('/').slice(0, 3).join('/'));
    }
  });

  it('empty and odd input does not throw', () => {
    expect(redactPiiInUrl('')).toBe('');
    expect(redactPiiInUrl('/')).toBe('/');
  });
});

/**
 * The function above only helps if morgan actually calls it. 'tiny' writes
 * ":method :url :status …", so overriding the `url` token is what makes the
 * redaction apply to every line. This asserts that wiring instead of trusting
 * it — get the token name wrong and everything above still passes while the
 * real log keeps the phone numbers.
 */
describe('morgan writes the redacted URL, not the real one', () => {
  it('logs a real request to the phone route redacted', async () => {
    // A real express server and a real request: morgan only writes its line
    // when the response genuinely finishes, so a hand-rolled mock proves
    // nothing about whether this works in production.
    const express = (await import('express')).default;
    const morgan = (await import('morgan')).default;

    // The same call app.ts makes — not a copy of it, so this test still means
    // something if the wiring there changes.
    installRedactedUrlToken(morgan);

    const written: string[] = [];
    const app = express();
    app.use(morgan('tiny', { stream: { write: (s: string) => { written.push(s); return true; } } }));
    app.get('*', (_req, res) => { res.json({ ok: true }); });

    const server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    const port = (server.address() as { port: number }).port;

    try {
      await fetch(`http://127.0.0.1:${port}/api/integration/customers-by-phone/9876543210`);
      await fetch(`http://127.0.0.1:${port}/api/dashboard/search?q=Ramasamy`);
      await fetch(`http://127.0.0.1:${port}/api/customers?page=2&limit=50`);
      // morgan writes on finish, which lands a tick after fetch resolves.
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      await new Promise((r) => server.close(r));
    }

    const log = written.join('');
    expect(log, 'morgan produced no output at all').not.toBe('');
    expect(log).toContain('<phone>');
    expect(log).toContain('q=<redacted>');
    // The identifiers must be absent, and the useful parts still present.
    expect(log).not.toContain('9876543210');
    expect(log).not.toContain('Ramasamy');
    expect(log).toContain('/api/integration/customers-by-phone/');
    expect(log).toContain('page=2&limit=50');
  });
});
