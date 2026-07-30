import type { FastifyReply, FastifyRequest } from "fastify";
import type { Kysely } from "kysely";
import type { Database } from "../db/schema.js";
import type { Clock } from "../platform/clock/index.js";
import { IdempotencyKeyReusedError, RequestInProgressError, withIdempotency, type IdempotentResponse } from "../platform/idempotency/index.js";

/**
 * §17.4 wired into the route layer (finding H): every state-changing route
 * calls this instead of running its handler directly. Maps the domain
 * outcomes to the exact wire contract — `X-Idempotent-Replay: true` on a
 * verbatim replay, `422 IDEMPOTENCY_KEY_REUSED` on a fingerprint mismatch,
 * `409 REQUEST_IN_PROGRESS` + `Retry-After: 2` while another call for the
 * same key is still running.
 */
export async function handleIdempotently<T>(
  request: FastifyRequest,
  reply: FastifyReply,
  db: Kysely<Database>,
  clock: Clock,
  endpoint: string,
  handler: () => Promise<IdempotentResponse<T>>,
): Promise<void> {
  const idempotencyKey = request.headers["idempotency-key"];
  if (!idempotencyKey || Array.isArray(idempotencyKey)) {
    reply.code(400).send({
      type: "https://errors.nexuscollect.example/INVALID_REFERENCE_FORMAT",
      title: "Missing Idempotency-Key",
      status: 400,
      code: "INVALID_REFERENCE_FORMAT",
      detail: "The Idempotency-Key header is required on this endpoint.",
      retryable: false,
    });
    return;
  }
  const institutionId = request.headers["x-institution-id"] as string;
  // idempotency_record.institution_id is a UUID column (db/migrations/0008) —
  // no institution registry table exists yet to translate a human-readable
  // caller identity into one, so this Phase 1 stub requires the header itself
  // to be a UUID on any route that touches idempotency. Reject cleanly here
  // rather than let an invalid-UUID insert surface as a raw 500.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(institutionId)) {
    reply.code(400).send({
      type: "https://errors.nexuscollect.example/INVALID_REFERENCE_FORMAT",
      title: "X-Institution-Id must be a UUID on this endpoint",
      status: 400,
      code: "INVALID_REFERENCE_FORMAT",
      detail: "This build has no institution registry yet — X-Institution-Id is used directly as idempotency_record.institution_id, which is a UUID column.",
      retryable: false,
    });
    return;
  }

  try {
    const outcome = await withIdempotency(
      db,
      { institutionId, endpoint, idempotencyKey, requestBody: request.body },
      handler,
      clock,
    );
    if (outcome.replayed) reply.header("X-Idempotent-Replay", "true");
    reply.code(outcome.status).send(outcome.body);
  } catch (err) {
    if (err instanceof IdempotencyKeyReusedError) {
      reply.code(422).send({
        type: "https://errors.nexuscollect.example/IDEMPOTENCY_KEY_REUSED",
        title: "Idempotency key reused with a different request body",
        status: 422,
        code: "IDEMPOTENCY_KEY_REUSED",
        detail: err.message,
        retryable: false,
      });
      return;
    }
    if (err instanceof RequestInProgressError) {
      reply.header("Retry-After", "2").code(409).send({
        type: "https://errors.nexuscollect.example/REQUEST_IN_PROGRESS",
        title: "A request with this idempotency key is still in progress",
        status: 409,
        code: "REQUEST_IN_PROGRESS",
        detail: err.message,
        retryable: true,
      });
      return;
    }
    throw err;
  }
}
