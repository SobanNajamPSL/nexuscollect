import { createHash } from "node:crypto";
import type { Kysely } from "kysely";
import type { Database } from "../../db/schema.js";
import type { Clock } from "../clock/index.js";
import { canonicalJson } from "./canonical-json.js";

/**
 * §17.4 idempotency semantics, verbatim (lines 2382-2400 of the design doc), on the
 * `idempotency_record` table whose primary key *is* the lock (institution_id,
 * endpoint, idempotency_key):
 *
 *   1. fingerprint = SHA256(canonical(body))
 *   2. Look up (I, E, K) in idempotency_record
 *   3. Not found  → INSERT state=IN_PROGRESS → process → UPDATE state=COMPLETE → return
 *   4. Found, COMPLETE, same fingerprint  → return the STORED status/body verbatim.
 *      Do NOT reprocess. Add header X-Idempotent-Replay: true
 *   5. Found, COMPLETE, different fingerprint → 422 IDEMPOTENCY_KEY_REUSED
 *   6. Found, IN_PROGRESS → 409 REQUEST_IN_PROGRESS with Retry-After: 2
 *   7. Records retained 7 days (configurable), then purged
 *
 * Finding H: the previous implementation polled on IN_PROGRESS instead of returning
 * 409 immediately — this rewrite removes that entirely. "Do not add an
 * application-level mutex; the database is already correct" (spec, same section) —
 * the UNIQUE constraint on the three-column primary key is the only concurrency
 * control here, same as before.
 */

export class IdempotencyKeyReusedError extends Error {
  readonly httpStatus = 422;
  readonly code = "IDEMPOTENCY_KEY_REUSED";
  constructor(institutionId: string, endpoint: string, idempotencyKey: string) {
    super(
      `Idempotency-Key "${idempotencyKey}" for ${institutionId}/${endpoint} was already used with a different request body`,
    );
    this.name = "IdempotencyKeyReusedError";
  }
}

export class RequestInProgressError extends Error {
  readonly httpStatus = 409;
  readonly code = "REQUEST_IN_PROGRESS";
  readonly retryAfterSeconds = 2;
  constructor(institutionId: string, endpoint: string, idempotencyKey: string) {
    super(`A request with Idempotency-Key "${idempotencyKey}" for ${institutionId}/${endpoint} is already in progress`);
    this.name = "RequestInProgressError";
  }
}

/** §17.4 line 2397: "Records retained 7 days (configurable), then purged." */
export const IDEMPOTENCY_RETENTION_DAYS = 7;

export interface IdempotencyParams {
  institutionId: string;
  endpoint: string;
  idempotencyKey: string;
  requestBody: unknown;
}

export interface IdempotentResponse<T> {
  status: number;
  body: T;
}

export interface IdempotencyOutcome<T> extends IdempotentResponse<T> {
  /** True if this call returned a previously-stored result rather than running the handler — route layer sets X-Idempotent-Replay: true when this is true. */
  replayed: boolean;
}

function fingerprintOf(requestBody: unknown): Buffer {
  return createHash("sha256").update(canonicalJson(requestBody)).digest();
}

export async function withIdempotency<T>(
  db: Kysely<Database>,
  params: IdempotencyParams,
  handler: () => Promise<IdempotentResponse<T>>,
  clock: Clock,
): Promise<IdempotencyOutcome<T>> {
  const { institutionId, endpoint, idempotencyKey } = params;
  const fingerprint = fingerprintOf(params.requestBody);

  const inserted = await db
    .insertInto("idempotency_record")
    .values({
      institution_id: institutionId,
      endpoint,
      idempotency_key: idempotencyKey,
      request_fingerprint: fingerprint,
      state: "IN_PROGRESS",
      created_at: clock.now(),
    })
    .onConflict((oc) => oc.columns(["institution_id", "endpoint", "idempotency_key"]).doNothing())
    .returning(["institution_id"])
    .executeTakeFirst();

  if (inserted) {
    // We won the INSERT: we are the only caller that will ever run the handler
    // for this key. Everyone else hit the unique-constraint conflict below.
    const result = await handler();
    await db
      .updateTable("idempotency_record")
      .set({
        state: "COMPLETE",
        response_status: result.status,
        // node-postgres only auto-serialises plain OBJECTS to JSON for jsonb
        // columns — a plain JS array gets turned into a Postgres ARRAY literal
        // instead, which Postgres then rejects as invalid JSON. Stringify
        // explicitly so this works regardless of whether the body is an object,
        // array, or scalar.
        response_body: JSON.stringify(result.body) as never,
        completed_at: clock.now(),
      })
      .where("institution_id", "=", institutionId)
      .where("endpoint", "=", endpoint)
      .where("idempotency_key", "=", idempotencyKey)
      .execute();
    return { ...result, replayed: false };
  }

  // Lost the race, or this is a genuine later replay: read the existing row and
  // apply steps 4-6 exactly. No polling — the spec's contract for IN_PROGRESS
  // is an immediate 409, not a wait.
  const row = await db
    .selectFrom("idempotency_record")
    .selectAll()
    .where("institution_id", "=", institutionId)
    .where("endpoint", "=", endpoint)
    .where("idempotency_key", "=", idempotencyKey)
    .executeTakeFirstOrThrow();

  if (!row.request_fingerprint.equals(fingerprint)) {
    throw new IdempotencyKeyReusedError(institutionId, endpoint, idempotencyKey);
  }

  if (row.state === "IN_PROGRESS") {
    throw new RequestInProgressError(institutionId, endpoint, idempotencyKey);
  }

  // state === "COMPLETE", same fingerprint: return the stored result verbatim.
  return {
    status: row.response_status as number,
    body: row.response_body as T,
    replayed: true,
  };
}

/**
 * §17.4 line 2397's retention policy. No cron/job-runner exists in this build
 * (Phase 0/1 scope), so this is a callable primitive an operator schedules —
 * exercised directly by tests rather than by a scheduler that doesn't exist yet.
 */
export async function purgeExpiredIdempotencyRecords(
  db: Kysely<Database>,
  clock: Clock,
  retentionDays: number = IDEMPOTENCY_RETENTION_DAYS,
): Promise<number> {
  const cutoff = new Date(clock.now().getTime() - retentionDays * 24 * 60 * 60 * 1000);
  const result = await db.deleteFrom("idempotency_record").where("created_at", "<", cutoff).executeTakeFirst();
  return Number(result.numDeletedRows ?? 0n);
}
