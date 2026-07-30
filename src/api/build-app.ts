import Fastify, { type FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import type { Database } from "../db/schema.js";
import type { Clock } from "../platform/clock/index.js";
import { loadSchemeCache } from "../modules/resolution/scheme-cache.js";
import { resolveReference } from "../modules/resolution/index.js";
import {
  createAssessment,
  amendAssessment,
  cancelAssessment,
  VersionConflictError,
  CannotCancelPaidAssessment,
  IllegalStateTransition,
  LineItemsOrphanAllocationError,
  type LineItemInput,
} from "../modules/obligation/index.js";
import { mapAssessmentToApi, findCurrentAssessmentIdByPsid } from "../modules/obligation/api-mapper.js";
import { resolvePayer } from "./payer-lookup.js";
import { requireInstitutionId } from "./auth-stub.js";
import { handleIdempotently } from "./idempotency-middleware.js";
import { resolveRequestSchema, resolveResponseSchema, problemSchema } from "./schemas/resolve.js";
import { createAssessmentRequestSchema, amendAssessmentRequestSchema, cancelAssessmentRequestSchema, assessmentResponseSchema } from "./schemas/assessment.js";

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
          403: problemSchema,
          503: problemSchema,
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
        case "QR_CRC_INVALID":
          // openapi.yaml maps this to /v1/resolve's 400 slot (same as
          // INVALID_REFERENCE_CHECKSUM) — QR_CRC_INVALID is a real member of
          // the platform ErrorCode catalogue but has no dedicated HTTP status
          // of its own at this endpoint.
          return reply.code(400).send({
            type: "https://errors.nexuscollect.example/QR_CRC_INVALID",
            title: "QR payload CRC check failed",
            status: 400,
            code: "QR_CRC_INVALID",
            detail: "The QR payload's CRC-16/CCITT-FALSE checksum did not match its declared value.",
            payer_message: "That QR code looks corrupted — please rescan.",
            payer_message_ur: "یہ QR کوڈ خراب لگتا ہے — براہ کرم دوبارہ اسکین کریں۔",
            retryable: true,
          });
        case "CHANNEL_NOT_ELIGIBLE":
          return reply.code(403).send({
            type: "https://errors.nexuscollect.example/CHANNEL_NOT_ELIGIBLE",
            title: "Channel not eligible for this product",
            status: 403,
            code: "CHANNEL_NOT_ELIGIBLE",
            detail: `Channel "${body.channel}" is not in the allowed_channels of the matched product.`,
            retryable: false,
          });
        case "AGENCY_UNAVAILABLE":
          return reply.code(503).send({
            type: "https://errors.nexuscollect.example/AGENCY_UNAVAILABLE",
            title: "Agency temporarily unavailable",
            status: 503,
            code: "AGENCY_UNAVAILABLE",
            detail: "The agency owning the matched assessment(s) is not currently ACTIVE.",
            retryable: true,
          });
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

  const actorFor = (request: { headers: Record<string, unknown> }) => ({
    actorType: "INSTITUTION" as const,
    actorId: String(request.headers["x-institution-id"]),
  });

  app.post(
    "/v1/agency/assessments",
    { preHandler: requireInstitutionId, schema: { body: createAssessmentRequestSchema, response: { 201: assessmentResponseSchema, 400: problemSchema, 422: problemSchema } } },
    async (request, reply) => {
      const body = request.body as {
        product_code: string;
        psid?: string | null;
        external_ref?: string;
        payer_id?: string;
        payer?: import("./payer-lookup.js").PayerInput;
        description?: string;
        currency?: string;
        assessed_amount_minor: number;
        issue_date: string;
        due_date: string;
        expiry_date?: string | null;
        line_items: { seq: number; line_type: LineItemInput["lineType"]; revenue_head_code: string; tax_period?: string | null; description?: string; amount_minor: number; allocation_priority?: number }[];
        metadata?: Record<string, unknown>;
      };

      // §7.3's full PSID-minting algorithm (per-scheme sequence allocation,
      // collision policy) isn't documented beyond length/prefix/checksum —
      // inventing its internal digit layout would violate the "never
      // fabricate a reference" rule, so Phase 1 requires the caller to supply
      // one explicitly rather than guess at an undocumented composition.
      if (!body.psid) {
        return reply.code(422).send({
          type: "https://errors.nexuscollect.example/INVALID_REFERENCE_FORMAT",
          title: "psid is required",
          status: 422,
          code: "INVALID_REFERENCE_FORMAT",
          detail: "Platform PSID minting isn't implemented in this phase (its digit composition beyond prefix/length/checksum isn't documented) — supply psid explicitly.",
          retryable: false,
        });
      }

      const product = await db.selectFrom("collection_product").selectAll().where("code", "=", body.product_code).executeTakeFirst();
      if (!product) {
        return reply.code(422).send({
          type: "https://errors.nexuscollect.example/INVALID_REFERENCE_FORMAT",
          title: "Unknown product_code",
          status: 422,
          code: "INVALID_REFERENCE_FORMAT",
          detail: `No collection_product with code "${body.product_code}".`,
          retryable: false,
        });
      }

      await handleIdempotently(request, reply, db, clock, "POST /v1/agency/assessments", async () => {
        const payerId = await resolvePayer(db, body.payer_id, body.payer);
        const { id } = await createAssessment(
          db,
          {
            psid: body.psid as string,
            agencyId: product.agency_id,
            productId: product.id,
            ...(payerId !== undefined ? { payerId } : {}),
            payerSnapshot: body.payer?.name ? { name: body.payer.name } : {},
            ...(body.external_ref !== undefined ? { externalRef: body.external_ref } : {}),
            description: body.description ?? product.name,
            ...(body.currency !== undefined ? { currency: body.currency } : {}),
            assessedAmountMinor: BigInt(body.assessed_amount_minor),
            lineItems: body.line_items.map((l) => ({
              seq: l.seq,
              lineType: l.line_type,
              revenueHeadCode: l.revenue_head_code,
              taxPeriod: l.tax_period ?? null,
              ...(l.description !== undefined ? { description: l.description } : {}),
              amountMinor: BigInt(l.amount_minor),
              ...(l.allocation_priority !== undefined ? { allocationPriority: l.allocation_priority } : {}),
            })),
            issueDate: body.issue_date,
            dueDate: body.due_date,
            ...(body.expiry_date ? { expiryDate: body.expiry_date } : {}),
            source: "AGENCY_API",
            ...(body.metadata !== undefined ? { metadata: body.metadata } : {}),
          },
          actorFor(request),
          clock,
        );
        return { status: 201, body: await mapAssessmentToApi(db, id) };
      });
    },
  );

  app.get(
    "/v1/agency/assessments/:psid",
    { preHandler: requireInstitutionId, schema: { response: { 200: assessmentResponseSchema, 404: problemSchema } } },
    async (request, reply) => {
      const { psid } = request.params as { psid: string };
      const id = await findCurrentAssessmentIdByPsid(db, psid);
      if (!id) {
        return reply.code(404).send({
          type: "https://errors.nexuscollect.example/REFERENCE_NOT_FOUND",
          title: "Assessment not found",
          status: 404,
          code: "REFERENCE_NOT_FOUND",
          detail: `No assessment with PSID "${psid}".`,
          retryable: false,
        });
      }
      return reply.code(200).send(await mapAssessmentToApi(db, id));
    },
  );

  app.patch(
    "/v1/agency/assessments/:psid",
    { preHandler: requireInstitutionId, schema: { body: amendAssessmentRequestSchema, response: { 200: assessmentResponseSchema, 404: problemSchema, 409: problemSchema } } },
    async (request, reply) => {
      const { psid } = request.params as { psid: string };
      const body = request.body as {
        expected_version: number;
        reason_code: "APPEAL_ALLOWED" | "RECTIFICATION_ORDER" | "CLERICAL_ERROR" | "REASSESSMENT" | "WAIVER_GRANTED" | "DISCOUNT_APPLIED";
        due_date?: string;
        expiry_date?: string;
        description?: string;
        line_items?: { seq: number; line_type: LineItemInput["lineType"]; revenue_head_code: string; tax_period?: string | null; description?: string; amount_minor: number; allocation_priority?: number }[];
        narrative?: string;
      };

      const id = await findCurrentAssessmentIdByPsid(db, psid);
      if (!id) {
        return reply.code(404).send({
          type: "https://errors.nexuscollect.example/REFERENCE_NOT_FOUND",
          title: "Assessment not found",
          status: 404,
          code: "REFERENCE_NOT_FOUND",
          detail: `No assessment with PSID "${psid}".`,
          retryable: false,
        });
      }

      try {
        await handleIdempotently(request, reply, db, clock, "PATCH /v1/agency/assessments/:psid", async () => {
          const result = await amendAssessment(
            db,
            id,
            {
              expectedVersion: body.expected_version,
              reasonCode: body.reason_code,
              ...(body.due_date !== undefined ? { dueDate: body.due_date } : {}),
              ...(body.expiry_date !== undefined ? { expiryDate: body.expiry_date } : {}),
              ...(body.description !== undefined ? { description: body.description } : {}),
              ...(body.line_items !== undefined
                ? {
                    lineItems: body.line_items.map((l) => ({
                      seq: l.seq,
                      lineType: l.line_type,
                      revenueHeadCode: l.revenue_head_code,
                      taxPeriod: l.tax_period ?? null,
                      ...(l.description !== undefined ? { description: l.description } : {}),
                      amountMinor: BigInt(l.amount_minor),
                      ...(l.allocation_priority !== undefined ? { allocationPriority: l.allocation_priority } : {}),
                    })),
                  }
                : {}),
              ...(body.narrative !== undefined ? { narrative: body.narrative } : {}),
            },
            actorFor(request),
            clock,
          );
          const dto = await mapAssessmentToApi(db, result.newAssessmentId);
          return {
            status: 200,
            body: { ...dto, overpayment_recognised_minor: Number(result.overpaymentRecognisedMinor), refund_id: result.refundId },
          };
        });
      } catch (err) {
        if (err instanceof VersionConflictError) {
          return reply.code(409).send({
            type: "https://errors.nexuscollect.example/VERSION_CONFLICT",
            title: "Version conflict",
            status: 409,
            code: "VERSION_CONFLICT",
            detail: err.message,
            retryable: false,
          });
        }
        if (err instanceof IllegalStateTransition || err instanceof LineItemsOrphanAllocationError) {
          return reply.code(409).send({
            type: `https://errors.nexuscollect.example/${err.code}`,
            title: err.name,
            status: 409,
            code: err.code,
            detail: err.message,
            retryable: false,
          });
        }
        throw err;
      }
    },
  );

  app.post(
    "/v1/agency/assessments/:psid/cancel",
    { preHandler: requireInstitutionId, schema: { body: cancelAssessmentRequestSchema, response: { 200: assessmentResponseSchema, 404: problemSchema, 409: problemSchema } } },
    async (request, reply) => {
      const { psid } = request.params as { psid: string };
      const body = request.body as { reason_code: "ISSUED_IN_ERROR" | "DUPLICATE" | "WITHDRAWN" | "SUPERSEDED" | "COURT_ORDER"; narrative?: string };

      const id = await findCurrentAssessmentIdByPsid(db, psid);
      if (!id) {
        return reply.code(404).send({
          type: "https://errors.nexuscollect.example/REFERENCE_NOT_FOUND",
          title: "Assessment not found",
          status: 404,
          code: "REFERENCE_NOT_FOUND",
          detail: `No assessment with PSID "${psid}".`,
          retryable: false,
        });
      }

      try {
        await handleIdempotently(request, reply, db, clock, "POST /v1/agency/assessments/:psid/cancel", async () => {
          await cancelAssessment(db, id, { reasonCode: body.reason_code, ...(body.narrative !== undefined ? { narrative: body.narrative } : {}) }, actorFor(request), clock);
          return { status: 200, body: await mapAssessmentToApi(db, id) };
        });
      } catch (err) {
        if (err instanceof CannotCancelPaidAssessment) {
          return reply.code(409).send({
            type: "https://errors.nexuscollect.example/CANNOT_CANCEL_PAID_ASSESSMENT",
            title: "Cannot cancel a paid assessment",
            status: 409,
            code: "CANNOT_CANCEL_PAID_ASSESSMENT",
            detail: err.message,
            retryable: false,
          });
        }
        if (err instanceof IllegalStateTransition) {
          return reply.code(409).send({
            type: `https://errors.nexuscollect.example/${err.code}`,
            title: err.name,
            status: 409,
            code: err.code,
            detail: err.message,
            retryable: false,
          });
        }
        throw err;
      }
    },
  );

  return app;
}
