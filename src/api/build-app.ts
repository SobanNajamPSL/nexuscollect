import Fastify, { type FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import type { Database } from "../db/schema.js";
import type { Clock } from "../platform/clock/index.js";
import { loadSchemeCache } from "../modules/resolution/scheme-cache.js";
import { resolveReference } from "../modules/resolution/index.js";
import { requireInstitutionId } from "./auth-stub.js";
import { resolveRequestSchema, resolveResponseSchema, problemSchema } from "./schemas/resolve.js";

export interface BuildAppOptions {
  db: Kysely<Database>;
  clock: Clock;
}

/**
 * Builds (but does not start listening on) the Fastify app. Split out from
 * src/api/index.ts so tests can build an app wired to a Testcontainers DB and
 * a DemoClock without binding a real port.
 */
export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const { db, clock } = options;
  const app = Fastify({ logger: false });

  await loadSchemeCache(db);

  app.get("/health", async () => ({ status: "ok" }));

  app.post(
    "/v1/resolve",
    {
      preHandler: requireInstitutionId,
      schema: {
        body: resolveRequestSchema,
        response: {
          200: resolveResponseSchema,
          400: problemSchema,
          401: problemSchema,
        },
      },
    },
    async (request, reply) => {
      const body = request.body as {
        key_type: string;
        key_value: string;
        channel: string;
        identity_assertion?: { asserted_by_institution?: boolean; step_up_token?: string };
      };

      const outcome = await resolveReference(
        db,
        {
          keyType: body.key_type,
          keyValue: body.key_value,
          channel: body.channel,
          identityAssertion: body.identity_assertion
            ? { assertedByInstitution: body.identity_assertion.asserted_by_institution, stepUpToken: body.identity_assertion.step_up_token }
            : undefined,
        },
        clock,
      );

      switch (outcome.kind) {
        case "INVALID_CHECKSUM":
          return reply.code(400).send({
            type: "https://errors.nexuscollect.example/INVALID_REFERENCE_CHECKSUM",
            title: "Invalid reference checksum",
            status: 400,
            code: "INVALID_REFERENCE_CHECKSUM",
            detail: `Checksum failed for "${body.key_value}".`,
            payer_message: "That number doesn't look right — please check and re-enter.",
            payer_message_ur: "یہ نمبر درست نہیں لگتا — براہ کرم دوبارہ درج کریں۔",
            retryable: false,
          });
        case "AUTHENTICATION_REQUIRED":
          return reply.code(401).send({
            type: "https://errors.nexuscollect.example/AUTHENTICATION_REQUIRED",
            title: "Step-up authentication required",
            status: 401,
            code: "AUTHENTICATION_REQUIRED",
            detail: `${body.key_type} lookups require step-up authentication (§20.6).`,
            retryable: false,
          });
        case "NOT_CONFIGURED":
          // openapi.yaml defines no dedicated error status for "unsupported
          // key type" at this endpoint (only 200/400/401/403/429/503) — an
          // empty 200 is exactly what the spec's own "well-formed reference,
          // nothing outstanding" example looks like, so this reuses that
          // shape rather than inventing an error code outside the contract.
          return reply.code(200).send({ resolution_token: null, token_expires_at: null, payables: [], settled: [] });
        case "OK":
          return reply.code(200).send({
            resolution_token: outcome.resolutionToken,
            token_expires_at: outcome.tokenExpiresAt ? outcome.tokenExpiresAt.toISOString() : null,
            payables: outcome.payables,
            settled: outcome.settled,
          });
      }
    },
  );

  return app;
}
