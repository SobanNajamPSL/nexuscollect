import { createHash } from "node:crypto";
import { canonicalJson } from "../idempotency/canonical-json.js";

/**
 * Shared hash-chain primitive: `hash_self = SHA256(canonical_json(content) || hash_prev)`
 * (§10.4's formula, generalised — the spec states it for journal_entry; audit_log
 * carries the same hash_prev/hash_self columns for the same reason, so both use
 * this one function rather than two near-identical implementations.)
 */
export function computeHashChainLink(content: unknown, hashPrev: Buffer | null): Buffer {
  const hash = createHash("sha256");
  hash.update(canonicalJson(content));
  if (hashPrev) hash.update(hashPrev);
  return hash.digest();
}

export interface ChainBreak {
  /** Identifies the row that failed to verify, in caller-defined terms (e.g. entry_no, id). */
  label: string;
  reason: "hash_prev_mismatch" | "hash_self_mismatch";
}

/**
 * Walks a sequence of already-fetched rows (oldest first) and reports the FIRST
 * break, by name — not just a pass/fail boolean. This is the mechanism behind
 * `GET /internal/ledger/verify-chain`: tamper with one row's stored amount and
 * this recomputes hash_self from its (now-different) content, finds it no longer
 * matches what was stored, and stops there.
 */
function buffersEqual(a: Buffer | null, b: Buffer | null): boolean {
  if (a === null || b === null) return a === b;
  return a.equals(b);
}

export function verifyChain<
  T extends { hash_prev: Buffer | null; hash_self: Buffer | null },
>(rows: readonly T[], contentOf: (row: T) => unknown, labelOf: (row: T) => string): ChainBreak | null {
  let expectedPrev: Buffer | null = null;
  for (const row of rows) {
    if (!buffersEqual(row.hash_prev, expectedPrev)) {
      return { label: labelOf(row), reason: "hash_prev_mismatch" };
    }
    const recomputed = computeHashChainLink(contentOf(row), row.hash_prev);
    if (!row.hash_self || !recomputed.equals(row.hash_self)) {
      return { label: labelOf(row), reason: "hash_self_mismatch" };
    }
    expectedPrev = row.hash_self;
  }
  return null;
}
