import type { Kysely } from "kysely";
import type { Database } from "../../db/schema.js";
import type { ChecksumAlgo } from "../../platform/checksum/index.js";

/**
 * §8.2 step 2 requires checksum validation to happen "offline" — before any
 * database hit — but knowing WHICH checksum algorithm applies to a given PSID
 * depends on its reference_scheme (matched by prefix + length). The way to
 * reconcile "offline" with "scheme-dependent" is the standard one: scheme
 * configuration is small, close-to-static reference data, loaded into an
 * in-process cache once (at startup, or explicitly refreshed), never queried
 * per-request. "Zero DB queries" in Phase 1's gate test means zero queries
 * *during a single resolve call* — refreshing this cache is a startup/admin
 * concern, not part of request handling.
 */
export interface SchemeConfig {
  code: string;
  prefix: string;
  totalLength: number;
  checksumAlgo: ChecksumAlgo;
}

let cache: SchemeConfig[] | null = null;

export async function loadSchemeCache(db: Kysely<Database>): Promise<void> {
  const rows = await db.selectFrom("reference_scheme").select(["code", "prefix", "total_length", "checksum_algo"]).execute();
  cache = rows
    .filter((r): r is typeof r & { prefix: string } => r.prefix !== null)
    .map((r) => ({ code: r.code, prefix: r.prefix, totalLength: r.total_length, checksumAlgo: r.checksum_algo }));
}

export function isSchemeCacheLoaded(): boolean {
  return cache !== null;
}

/**
 * Matches a PSID-like value to its reference scheme by prefix + exact length —
 * confirmed against demo-data that length, not checksum_algo or
 * is_platform_minted, is what actually distinguishes the 17-digit main
 * schemes from the 13-digit WASA CRN and 14-digit legacy NADRA number.
 */
export function findSchemeForKeyValue(keyValue: string): SchemeConfig | null {
  if (!cache) throw new Error("Scheme cache not loaded — call loadSchemeCache(db) at startup");
  return cache.find((s) => keyValue.length === s.totalLength && keyValue.startsWith(s.prefix)) ?? null;
}

/** Test-only: forces a reload on the next findSchemeForKeyValue call in a fresh test DB. */
export function _resetSchemeCacheForTests(): void {
  cache = null;
}
