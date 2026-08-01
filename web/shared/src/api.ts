/**
 * Thin fetch wrapper shared by all four portals.
 *
 * Identity is module-level rather than threaded through every call site: the
 * harness sets it once when a persona is chosen, and every subsequent request
 * carries it. When real auth replaces the harness, only `setIdentity` changes —
 * nothing that *consumes* identity has to.
 */
const INSTITUTION_ID = "00000000-0000-4000-8000-0000000000d1";

export interface Identity {
  /** A real `platform_user.id`. Sent as `x-user-id`; role checks read it. */
  userId: string | null;
  /** The acting user's own agency, for tenant-scoped requests. */
  agencyCode: string | null;
}

let identity: Identity = { userId: null, agencyCode: null };

export function setIdentity(next: Identity): void {
  identity = next;
}

export function getIdentity(): Identity {
  return identity;
}

function randomKey(): string {
  return crypto.randomUUID();
}

export class ApiError extends Error {
  code?: string;
  status?: number;
  body?: unknown;
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  opts?: { idempotent?: boolean; headers?: Record<string, string> },
): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-institution-id": INSTITUTION_ID,
    ...(identity.userId ? { "x-user-id": identity.userId } : {}),
    ...opts?.headers,
  };
  if (opts?.idempotent) headers["idempotency-key"] = randomKey();

  const res = await fetch(path, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = new ApiError(json?.detail ?? json?.title ?? `${method} ${path} failed (${res.status})`);
    err.code = json?.code;
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json as T;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: unknown, opts?: { idempotent?: boolean; headers?: Record<string, string> }) =>
    request<T>("POST", path, body, { idempotent: true, ...opts }),
  patch: <T>(path: string, body?: unknown, opts?: { idempotent?: boolean; headers?: Record<string, string> }) =>
    request<T>("PATCH", path, body, { idempotent: true, ...opts }),
};
