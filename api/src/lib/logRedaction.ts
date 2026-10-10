/**
 * Keep customer identifiers out of the access log.
 *
 * Several routes identify a person in the URL itself, so morgan's request line
 * recorded the identifier on every call. Over one week of production logs:
 *
 *     GET /api/integration/customers-by-phone/9xxxxxxxxx   ~2,100 lines
 *     GET /api/integration/customer-by-phone/9xxxxxxxxx        15 lines
 *     GET /api/lockers/customers/by-pan/AAAAA9999A             20 lines
 *     GET /api/dashboard/search?q=<a name, phone or PAN>       21 lines
 *
 * Nothing was being logged deliberately — it rides along in the URL. But the
 * log is readable by anyone on the box with the `adm` group, is copied into
 * rotations and backups, and long outlives any reason to keep the number.
 *
 * The route stays legible so the log is still worth having; only the
 * identifying value is replaced. nginx applies the same rules to its own
 * access log (conf.d/pii-redaction.conf) — this covers the app's copy.
 */

/** An Indian mobile number: ten digits starting 6-9. */
const PHONE = /\b[6-9]\d{9}\b/g;
/** A PAN: five letters, four digits, a letter. */
const PAN = /\b[A-Z]{5}\d{4}[A-Z]\b/g;
/** An Aadhaar-shaped twelve-digit run. None appear in the log today; this is
 *  here so that cannot change unnoticed. */
const AADHAAR = /\b\d{12}\b/g;
/** An email address. */
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/g;

/**
 * Query parameters whose VALUE is free text a person typed, so it may be a
 * name — which no pattern above can recognise. The whole value goes.
 */
const FREE_TEXT_PARAMS = /\b(q|search|name|customer_name|full_name|phone|mobile|pan|aadhaar|email)=[^&]*/gi;

/**
 * Replace customer identifiers in a URL with markers, keeping the route shape.
 *
 *   /api/integration/customers-by-phone/9876543210
 *       → /api/integration/customers-by-phone/<phone>
 *   /api/dashboard/search?q=Ramasamy&page=2
 *       → /api/dashboard/search?q=<redacted>&page=2
 *
 * Ordinary parameters are untouched: `?page=2&limit=50` survives intact, which
 * is most of what the log is read for.
 */
/**
 * Point morgan's `url` token at the redaction above. app.ts calls this once at
 * startup, and the test calls the same function — so the thing under test is
 * the thing production runs.
 */
export function installRedactedUrlToken(morgan: {
  token: (name: string, fn: (req: { originalUrl?: string; url?: string }) => string) => unknown;
}): void {
  // 'tiny' and 'combined' both render the URL through the `url` token, so
  // replacing it covers every format without touching the format string.
  morgan.token('url', (req) => redactPiiInUrl(req.originalUrl || req.url || ''));
}

export function redactPiiInUrl(url: string): string {
  if (!url) return url;
  return url
    // Free-text values first: a name is invisible to the patterns below, and
    // doing this first also catches a phone or PAN typed into a search box.
    .replace(FREE_TEXT_PARAMS, (m) => `${m.slice(0, m.indexOf('='))}=<redacted>`)
    .replace(EMAIL, '<email>')
    .replace(PAN, '<pan>')
    .replace(PHONE, '<phone>')
    .replace(AADHAAR, '<aadhaar>');
}
