/**
 * Thin fetch wrapper. `X-Institution-Id` is a fixed demo UUID (this build's
 * auth is a stub, §17.2's real mTLS/OAuth2 model is Prompt 7 territory) and
 * `Idempotency-Key` is a fresh UUID per call for any state-changing request.
 */
const INSTITUTION_ID = "00000000-0000-4000-8000-0000000000d1";

function randomKey(): string {
  return crypto.randomUUID();
}

async function request<T>(method: string, path: string, body?: unknown, opts?: { idempotent?: boolean }): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json", "x-institution-id": INSTITUTION_ID };
  if (opts?.idempotent) headers["idempotency-key"] = randomKey();
  const res = await fetch(path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = new Error(json?.detail ?? json?.title ?? `${method} ${path} failed (${res.status})`) as Error & { code?: string; status?: number; body?: unknown };
    err.code = json?.code;
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json as T;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: unknown, opts?: { idempotent?: boolean }) => request<T>("POST", path, body, opts ?? { idempotent: true }),
};

export function formatPKR(minor: number): string {
  return (minor / 100).toLocaleString("en-PK", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
