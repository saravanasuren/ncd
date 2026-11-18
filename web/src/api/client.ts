/** Typed fetch wrapper (docs/04). Sends cookies + CSRF header; unwraps the
 * error envelope into a thrown ApiError. On a 401 (expired 15-min access token)
 * it silently refreshes once and retries, so an idle session keeps working; if
 * the refresh also fails (the 30-day refresh token is dead), it redirects to
 * login instead of leaving pages stuck on "Failed to load". */
export class ApiError extends Error {
  constructor(public code: string, public status: number, message: string, public detail?: unknown) {
    super(message);
  }
}

const BASE_HEADERS = { 'X-Requested-With': 'dhanam' } as const;

/** Single in-flight refresh shared by all concurrent 401s (avoids a refresh storm). */
let refreshing: Promise<boolean> | null = null;
function refreshOnce(): Promise<boolean> {
  if (!refreshing) {
    refreshing = fetch('/api/auth/refresh', { method: 'POST', credentials: 'same-origin', headers: BASE_HEADERS })
      .then((r) => r.ok)
      .catch(() => false)
      .finally(() => { refreshing = null; });
  }
  return refreshing;
}

function redirectToLogin() {
  if (typeof window === 'undefined') return;
  const p = window.location.pathname;
  if (p.startsWith('/login') || p.startsWith('/portal')) return; // already there / portal has its own flow
  window.location.assign('/login');
}

async function request<T>(method: string, path: string, body?: unknown, retried = false): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: { ...BASE_HEADERS, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  // Expired access token → refresh once and retry the original request.
  if (res.status === 401 && !retried && !path.startsWith('/api/auth/')) {
    const ok = await refreshOnce();
    if (ok) return request<T>(method, path, body, true);
    redirectToLogin(); // refresh failed → session is really over
  }

  let json: unknown = null;
  try { json = await res.json(); } catch { /* empty */ }
  if (!res.ok) {
    const e = (json as { error?: { code: string; message: string; detail?: unknown } })?.error;
    throw new ApiError(e?.code ?? 'ERROR', res.status, e?.message ?? res.statusText, e?.detail);
  }
  return json as T;
}

/** A binary GET (a PDF). Same session handling as `request` — refresh once on
 *  an expired token — but the body is kept as a Blob, and a failure still comes
 *  back as an ApiError carrying the server's own readable message. */
async function requestBlob(path: string, retried = false): Promise<Blob> {
  const res = await fetch(path, { credentials: 'same-origin', headers: BASE_HEADERS });
  if (res.status === 401 && !retried && !path.startsWith('/api/auth/')) {
    const ok = await refreshOnce();
    if (ok) return requestBlob(path, true);
    redirectToLogin();
  }
  if (!res.ok) {
    let json: unknown = null;
    try { json = await res.json(); } catch { /* not JSON */ }
    const e = (json as { error?: { code: string; message: string; detail?: unknown } })?.error;
    throw new ApiError(e?.code ?? 'ERROR', res.status, e?.message ?? res.statusText, e?.detail);
  }
  return res.blob();
}

/**
 * A binary POST: send JSON, get a file back.
 *
 * Needed where the file to download is produced FROM a body rather than
 * identified by a URL — Bulk Redemption Letters posts the uploaded sheet and
 * receives the archive. `headers` of the response come back alongside the blob
 * because the server reports the generated/failed counts there.
 */
async function postBlob(path: string, body: unknown, retried = false)
: Promise<{ blob: Blob; headers: Headers }> {
  const res = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { ...BASE_HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 401 && !retried && !path.startsWith('/api/auth/')) {
    const ok = await refreshOnce();
    if (ok) return postBlob(path, body, true);
    redirectToLogin();
  }
  if (!res.ok) {
    let json: unknown = null;
    try { json = await res.json(); } catch { /* not JSON */ }
    const e = (json as { error?: { code: string; message: string; detail?: unknown } })?.error;
    throw new ApiError(e?.code ?? 'ERROR', res.status, e?.message ?? res.statusText, e?.detail);
  }
  return { blob: await res.blob(), headers: res.headers };
}

export const api = {
  blob: (p: string) => requestBlob(p),
  postBlob: (p: string, b: unknown) => postBlob(p, b),
  get: <T>(p: string) => request<T>('GET', p),
  post: <T>(p: string, b?: unknown) => request<T>('POST', p, b),
  put: <T>(p: string, b?: unknown) => request<T>('PUT', p, b),
  patch: <T>(p: string, b?: unknown) => request<T>('PATCH', p, b),
  del: <T>(p: string, b?: unknown) => request<T>('DELETE', p, b),
};
