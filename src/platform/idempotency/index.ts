import { createHash } from "node:crypto";
import type { Kysely } from "kysely";
import type { Database } from "../../db/schema.js";
import type { Clock } from "../clock/index.js";
import { canonicalJson } from "./canonical-json.js";

/**
 * §17.4 idempotency semantics, on the `idempotency_record` table whose primary key
 * *is* the lock (institution_id, endpoint, idempotency_key):
 *  - Replaying the same key with the same body returns the original status/body
 *    and performs no second effect.
 *  - The same key with a *different* body is a client error (422) — the key was
 *    reused for a different request, which the spec treats as a caller bug, not a
 *    retry.
 *  - N concurrent identical requests race to INSERT; exactly one wins, runs the
 *    handler once, and every loser waits for that winner's result rather than
 *    running the handler itself — so exactly one record (and one real effect) is
 *    ever created.
 */

export class IdempotencyConflictError extends Error {
  constructor(institutionId: string, endpoint: string, idempotencyKey: string) {
    super(
      `Idempotency-Key "${idempotencyKey}" for ${institutionId}/${endpoint} was already used with a different request body`,
    );
    this.name = "IdempotencyConflictError";
  }
}

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
  /** True if this call returned a previously-stored result rather than running the handler. */
  replayed: boolean;
}

const POLL_INTERVAL_MS = 25;
const MAX_POLL_ATTEMPTS = 200; // 5s worst case, generous for a test-suite handler

function fingerprintOf(requestBody: unknown): Buffer {
  return createHash("sha256").update(canonicalJson(requestBody)).digest();
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
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
    })
    .onConflict((oc) => oc.columns(["institution_id", "endpoint", "idempotency_key"]).doNothing())
    .returning(["institution_id"])
    .executeTakeFirst();

  if (inserted) {
    // We won the race: we are the only caller that will ever run the handler for
    // this key.
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

  // We lost the race (or this is a genuine replay of an already-complete request):
  // read the winner's row and either return its result or reject as a conflict.
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
    const row = await db
      .selectFrom("idempotency_record")
      .selectAll()
      .where("institution_id", "=", institutionId)
      .where("endpoint", "=", endpoint)
      .where("idempotency_key", "=", idempotencyKey)
      .executeTakeFirst();

    if (!row) {
      // Vanishingly unlikely (would mean the winner's row was deleted), but the
      // append-only-adjacent idempotency table has no delete path in this build.
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    if (!row.request_fingerprint.equals(fingerprint)) {
      throw new IdempotencyConflictError(institutionId, endpoint, idempotencyKey);
    }

    if (row.state === "COMPLETE") {
      return {
        status: row.response_status as number,
        body: row.response_body as T,
        replayed: true,
      };
    }

    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error(
    `Idempotency-Key "${idempotencyKey}" never completed for ${institutionId}/${endpoint} within the poll window`,
  );
}
