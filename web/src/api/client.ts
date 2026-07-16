/** Typed fetch wrapper (docs/04). Sends cookies + CSRF header; unwraps the
 * error envelope into a thrown ApiError. */
export class ApiError extends Error {
  constructor(public code: string, public status: number, message: string, public detail?: unknown) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: {
      'X-Requested-With': 'dhanam',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    /* empty */
  }
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
