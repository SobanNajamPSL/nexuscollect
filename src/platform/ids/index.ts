import { createHash } from "node:crypto";

/**
 * A stable UUID derived from a natural key.
 *
 * Some things the ledger posts against are not rows with their own surrogate id —
 * a till close is identified by "this till, on this business date", not by a
 * `till_session` table this build doesn't have. `journal_entry.source_id` is a
 * `UUID NOT NULL` column, so such a source needs a UUID that is *derived* rather
 * than generated: the same natural key must always produce the same id, because
 * `UNIQUE (source_type, source_id, event_type, sequence)` is what makes posting
 * idempotent. A fresh random id each time would post a duplicate entry on every
 * retry.
 *
 * This is RFC 4122 version 5 (SHA-1, name-based) — a standard construction, not
 * an invented scheme. The namespace is a fixed UUID of this platform's own.
 */
const NAMESPACE = "6b1f0c9e-2d3a-4f5b-8c7d-9e0a1b2c3d4e";

function uuidToBytes(uuid: string): Buffer {
  return Buffer.from(uuid.replace(/-/g, ""), "hex");
}

export function deterministicUuid(name: string): string {
  const hash = createHash("sha1").update(uuidToBytes(NAMESPACE)).update(Buffer.from(name, "utf8")).digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  // Version 5 in the high nibble of byte 6; RFC 4122 variant in byte 8.
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The ledger source id for one till's close on one business date. */
export function tillCloseSourceId(businessDate: string, tillCode: string): string {
  return deterministicUuid(`till_close:${businessDate}:${tillCode}`);
}
