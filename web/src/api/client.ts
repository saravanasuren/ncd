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

export const api = {
  get: <T>(p: string) => request<T>('GET', p),
  post: <T>(p: string, b?: unknown) => request<T>('POST', p, b),
  put: <T>(p: string, b?: unknown) => request<T>('PUT', p, b),
  del: <T>(p: string) => request<T>('DELETE', p),
};
