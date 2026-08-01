import Fastify, { type FastifyInstance } from "fastify";
import { sql, type Kysely } from "kysely";
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
import { createPaymentIntentRequestSchema, paymentIntentResponseSchema, confirmPaymentRequestSchema, paymentResponseSchema, reversePaymentRequestSchema, receiptResponseSchema } from "./schemas/payment.js";
import { createPaymentIntent, capturePayment, reversePayment, resolveUncertainPayment, ResolutionTokenInvalidError, HardDuplicatePaymentError } from "../modules/payment/index.js";
import { checkTrialBalance, checkAllocationIntegrity, checkBalanceRebuild, checkLedgerVsSubledger, verifyLedgerChain } from "../modules/control/index.js";
import { toWireMinor } from "../platform/money/index.js";
import { runReconciliation } from "../modules/recon/index.js";
import { returnInstrument } from "../modules/instrument/index.js";
import { resetDemoData } from "../loader/reset.js";
import { DemoClock } from "../platform/clock/index.js";
import { billInquiry, billPayment, billPaymentReversal, billPaymentAdvice, SwitchInquiryTokenInvalidError } from "../adapters/switch/index.js";
import { markSent, markDelivered, markPresented, acceptRtp, declineRtp, cancelRtp, fulfillRtpWithPayment, expireDueRequests, IllegalRtpTransition } from "../modules/rtp/index.js";
import { generateScroll, runSweep, closePeriod, runPreCloseChecks, recordAgencySignoff, recordScrollAck, PeriodCloseBlockedError, PeriodAlreadyClosedError } from "../modules/settlement/index.js";
import { createRefund, approveRefund, payRefund, SelfApprovalError } from "../modules/refund/index.js";
import { validateBulkFile, confirmBulkBatch, BulkBatchNotValidatedError } from "../modules/bulk/index.js";
import { receiveRecall } from "../modules/recall/index.js";
import { createMandate, collectUnderMandate } from "../modules/mandate/index.js";
import { captureCardPayment } from "../adapters/rails/card/index.js";
import { captureWalletPayment } from "../adapters/rails/wallet/index.js";
import { generateChallan, renderChallanHtml } from "../modules/evidence/challan.js";
import { getSignedReceiptBundle } from "../modules/evidence/receipt.js";
import { verifyReceiptSignature, getPublicKeyPem } from "../platform/receipt-signing/index.js";
import { deliverPendingWebhooks, createWebhookSubscription, replayWebhooks } from "../modules/webhook/index.js";
import { sendNotification } from "../modules/notification/index.js";
import * as reports from "../modules/reports/index.js";
import { verifyAuditChain } from "../platform/audit/index.js";
import { getOrCreateLedgerAccount } from "../modules/ledger/index.js";
import { postJournalTemplate } from "../modules/journal-templates/index.js";

export interface BuildAppOptions {
  db: Kysely<Database>;
  clock: Clock;
  /** Required only for `POST /internal/demo/reset` to know where to reload from. */
  demoDataDir?: string;
}

/**
 * Builds (but does not start listening on) the Fastify app. Split out from
 * src/api/index.ts so tests can build an app wired to a Testcontainers DB and
 * a DemoClock without binding a real port.
 */
export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const { db, clock, demoDataDir } = options;
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

  // --- Phase 2: payment intents + the apply pipeline ---

  app.post(
    "/v1/payment-intents",
    { preHandler: requireInstitutionId, schema: { body: createPaymentIntentRequestSchema, response: { 201: paymentIntentResponseSchema, 401: problemSchema } } },
    async (request, reply) => {
      const body = request.body as { resolution_token: string; channel: string; payer_id?: string };
      try {
        await handleIdempotently(request, reply, db, clock, "POST /v1/payment-intents", async () => {
          const { intentReference } = await createPaymentIntent(db, { resolutionToken: body.resolution_token, channel: body.channel, ...(body.payer_id ? { payerId: body.payer_id } : {}), institutionId: String(request.headers["x-institution-id"]) }, clock);
          const intent = await db.selectFrom("payment_intent").selectAll().where("intent_reference", "=", intentReference).executeTakeFirstOrThrow();
          return {
            status: 201,
            body: { intent_reference: intent.intent_reference, status: intent.status, channel: intent.channel, requested_amount_minor: toWireMinor(intent.requested_amount_minor), total_debit_minor: toWireMinor(intent.total_debit_minor), currency: intent.currency, quote_expires_at: intent.quote_expires_at.toISOString() },
          };
        });
      } catch (err) {
        if (err instanceof ResolutionTokenInvalidError) {
          return reply.code(401).send({ type: "https://errors.nexuscollect.example/RESOLUTION_TOKEN_INVALID", title: "Invalid resolution token", status: 401, code: "RESOLUTION_TOKEN_INVALID", detail: err.message, retryable: false });
        }
        throw err;
      }
    },
  );

  app.get(
    "/v1/payment-intents/:intentReference",
    { preHandler: requireInstitutionId, schema: { response: { 200: paymentIntentResponseSchema, 404: problemSchema } } },
    async (request, reply) => {
      const { intentReference } = request.params as { intentReference: string };
      const intent = await db.selectFrom("payment_intent").selectAll().where("intent_reference", "=", intentReference).executeTakeFirst();
      if (!intent) {
        return reply.code(404).send({ type: "https://errors.nexuscollect.example/REFERENCE_NOT_FOUND", title: "Payment intent not found", status: 404, code: "REFERENCE_NOT_FOUND", detail: `No payment_intent "${intentReference}".`, retryable: false });
      }
      return reply.code(200).send({ intent_reference: intent.intent_reference, status: intent.status, channel: intent.channel, requested_amount_minor: toWireMinor(intent.requested_amount_minor), total_debit_minor: toWireMinor(intent.total_debit_minor), currency: intent.currency, quote_expires_at: intent.quote_expires_at.toISOString() });
    },
  );

  app.post(
    "/v1/payment-intents/:intentReference/cancel",
    { preHandler: requireInstitutionId, schema: { response: { 200: paymentIntentResponseSchema, 404: problemSchema } } },
    async (request, reply) => {
      const { intentReference } = request.params as { intentReference: string };
      const intent = await db.selectFrom("payment_intent").selectAll().where("intent_reference", "=", intentReference).executeTakeFirst();
      if (!intent) {
        return reply.code(404).send({ type: "https://errors.nexuscollect.example/REFERENCE_NOT_FOUND", title: "Payment intent not found", status: 404, code: "REFERENCE_NOT_FOUND", detail: `No payment_intent "${intentReference}".`, retryable: false });
      }
      await db.updateTable("payment_intent").set({ status: "ABANDONED" }).where("id", "=", intent.id).execute();
      return reply.code(200).send({ intent_reference: intent.intent_reference, status: "ABANDONED", channel: intent.channel, requested_amount_minor: toWireMinor(intent.requested_amount_minor), total_debit_minor: toWireMinor(intent.total_debit_minor), currency: intent.currency, quote_expires_at: intent.quote_expires_at.toISOString() });
    },
  );

  function mapPaymentToApi(payment: { payment_reference: string; status: string; gross_amount_minor: bigint; unapplied_amount_minor: bigint; currency: string; value_date: string; application_trace: unknown }, settledPsids: string[]) {
    return {
      payment_reference: payment.payment_reference,
      status: payment.status,
      gross_amount_minor: toWireMinor(payment.gross_amount_minor),
      unapplied_amount_minor: toWireMinor(payment.unapplied_amount_minor),
      currency: payment.currency,
      value_date: payment.value_date,
      settled_psids: settledPsids,
      application_trace: payment.application_trace ?? {},
    };
  }

  app.post(
    "/v1/payments",
    { preHandler: requireInstitutionId, schema: { body: confirmPaymentRequestSchema, response: { 201: paymentResponseSchema, 409: problemSchema } } },
    async (request, reply) => {
      const body = request.body as {
        intent_reference?: string | null; channel: string; rail: "RAAST" | "IBFT_1LINK" | "PRISM_RTGS" | "PAYPAK" | "CARD_SCHEME" | "INTERNAL_BOOK" | "CASH" | "CHEQUE_CLEARING" | "WALLET";
        gross_amount_minor: number; currency?: string; value_date: string; obligation_discharge_date: string;
        rail_e2e_id?: string; switch_stan?: string; switch_rrn?: string; acquirer_id?: string; instrument_id?: string;
        payer_account_masked?: string; payer_bank_bic?: string; remittance_raw?: string;
        explicit_allocations?: { psid: string; line_type?: string; revenue_head_code?: string; amount_minor: number }[];
        capture_outcome?: "CONFIRMED" | "UNCERTAIN" | "FAILED";
      };

      try {
        await handleIdempotently(request, reply, db, clock, "POST /v1/payments", async () => {
          const result = await capturePayment(
            db,
            {
              paymentReference: "",
              ...(body.intent_reference ? { intentReference: body.intent_reference } : {}),
              channel: body.channel, rail: body.rail, grossAmountMinor: BigInt(body.gross_amount_minor),
              ...(body.currency ? { currency: body.currency } : {}), valueDate: body.value_date, obligationDischargeDate: body.obligation_discharge_date,
              ...(body.rail_e2e_id ? { railE2eId: body.rail_e2e_id } : {}), ...(body.switch_stan ? { switchStan: body.switch_stan } : {}),
              ...(body.switch_rrn ? { switchRrn: body.switch_rrn } : {}), ...(body.acquirer_id ? { acquirerId: body.acquirer_id } : {}),
              ...(body.instrument_id ? { instrumentId: body.instrument_id } : {}), ...(body.payer_account_masked ? { payerAccountMasked: body.payer_account_masked } : {}),
              ...(body.payer_bank_bic ? { payerBankBic: body.payer_bank_bic } : {}), ...(body.remittance_raw ? { remittanceRaw: body.remittance_raw } : {}),
              ...(body.explicit_allocations ? { explicitAllocations: body.explicit_allocations.map((a) => ({ psid: a.psid, ...(a.line_type ? { lineType: a.line_type } : {}), ...(a.revenue_head_code ? { revenueHeadCode: a.revenue_head_code } : {}), amountMinor: BigInt(a.amount_minor) })) } : {}),
              ...(body.capture_outcome ? { captureOutcome: body.capture_outcome } : {}),
            },
            clock,
          );
          const payment = await db.selectFrom("payment").selectAll().where("id", "=", result.paymentId).executeTakeFirstOrThrow();
          const settledPsids = result.settledAssessmentIds.length
            ? (await db.selectFrom("assessment").select("psid").where("id", "in", result.settledAssessmentIds).execute()).map((r) => r.psid)
            : [];
          return { status: 201, body: mapPaymentToApi(payment, settledPsids) };
        });
      } catch (err) {
        if (err instanceof HardDuplicatePaymentError) {
          return reply.code(409).send({ type: "https://errors.nexuscollect.example/DUPLICATE_PAYMENT", title: "Duplicate payment", status: 409, code: "DUPLICATE_PAYMENT", detail: err.message, retryable: false });
        }
        throw err;
      }
    },
  );

  app.get(
    "/v1/payments/:paymentReference",
    { preHandler: requireInstitutionId, schema: { response: { 200: paymentResponseSchema, 404: problemSchema } } },
    async (request, reply) => {
      const { paymentReference } = request.params as { paymentReference: string };
      const payment = await db.selectFrom("payment").selectAll().where("payment_reference", "=", paymentReference).executeTakeFirst();
      if (!payment) {
        return reply.code(404).send({ type: "https://errors.nexuscollect.example/REFERENCE_NOT_FOUND", title: "Payment not found", status: 404, code: "REFERENCE_NOT_FOUND", detail: `No payment "${paymentReference}".`, retryable: false });
      }
      const settledPsids = (
        await db.selectFrom("payment_allocation").innerJoin("assessment", "assessment.id", "payment_allocation.assessment_id").select("assessment.psid").distinct().where("payment_allocation.payment_id", "=", payment.id).where("assessment.status", "=", "SETTLED").execute()
      ).map((r) => r.psid);
      return reply.code(200).send(mapPaymentToApi(payment, settledPsids));
    },
  );

  app.post(
    "/v1/payments/:paymentReference/reverse",
    { preHandler: requireInstitutionId, schema: { body: reversePaymentRequestSchema, response: { 200: paymentResponseSchema, 404: problemSchema } } },
    async (request, reply) => {
      const { paymentReference } = request.params as { paymentReference: string };
      const body = request.body as { reason: string };
      const payment = await db.selectFrom("payment").selectAll().where("payment_reference", "=", paymentReference).executeTakeFirst();
      if (!payment) {
        return reply.code(404).send({ type: "https://errors.nexuscollect.example/REFERENCE_NOT_FOUND", title: "Payment not found", status: 404, code: "REFERENCE_NOT_FOUND", detail: `No payment "${paymentReference}".`, retryable: false });
      }
      await reversePayment(db, payment.id, body.reason, { actorType: "INSTITUTION", actorId: String(request.headers["x-institution-id"]) }, clock);
      const updated = await db.selectFrom("payment").selectAll().where("id", "=", payment.id).executeTakeFirstOrThrow();
      return reply.code(200).send(mapPaymentToApi(updated, []));
    },
  );

  app.get(
    "/v1/payments/:paymentReference/receipt",
    { preHandler: requireInstitutionId, schema: { response: { 200: receiptResponseSchema, 404: problemSchema } } },
    async (request, reply) => {
      const { paymentReference } = request.params as { paymentReference: string };
      const payment = await db.selectFrom("payment").select("id").where("payment_reference", "=", paymentReference).executeTakeFirst();
      const receipt = payment ? await db.selectFrom("receipt").selectAll().where("payment_id", "=", payment.id).executeTakeFirst() : undefined;
      if (!receipt) {
        return reply.code(404).send({ type: "https://errors.nexuscollect.example/REFERENCE_NOT_FOUND", title: "No receipt for this payment", status: 404, code: "REFERENCE_NOT_FOUND", detail: `No receipt for payment "${paymentReference}".`, retryable: false });
      }
      return reply.code(200).send({ receipt_no: receipt.receipt_no, business_date: receipt.business_date, status: receipt.status });
    },
  );

  app.post(
    "/internal/payments/:paymentReference/resolve-uncertain",
    { preHandler: requireInstitutionId },
    async (request, reply) => {
      const { paymentReference } = request.params as { paymentReference: string };
      const body = request.body as { outcome: "FOUND_PAID" | "FOUND_NOT_PAID" | "STILL_UNRESOLVED"; source: "RAIL_STATUS_ENQUIRY" | "AGGREGATOR_ADVICE" | "INTRADAY_STATEMENT" | "EOD_STATEMENT" | "HUMAN_INVESTIGATION" };
      const payment = await db.selectFrom("payment").select("id").where("payment_reference", "=", paymentReference).executeTakeFirst();
      if (!payment) {
        return reply.code(404).send({ type: "https://errors.nexuscollect.example/REFERENCE_NOT_FOUND", title: "Payment not found", status: 404, code: "REFERENCE_NOT_FOUND", detail: `No payment "${paymentReference}".`, retryable: false });
      }
      await resolveUncertainPayment(db, payment.id, body, clock);
      const updated = await db.selectFrom("payment").selectAll().where("id", "=", payment.id).executeTakeFirstOrThrow();
      return reply.code(200).send(mapPaymentToApi(updated, []));
    },
  );

  // --- §10.8: the five control assertions, plus verify-chain ---

  app.get("/internal/control/trial-balance", async (request, reply) => {
    const { date } = request.query as { date?: string };
    const result = await checkTrialBalance(db, date);
    return reply.code(200).send({
      balanced: result.balanced,
      total_debit_minor: toWireMinor(result.totalDebitMinor),
      total_credit_minor: toWireMinor(result.totalCreditMinor),
      date: result.date,
    });
  });

  app.get("/internal/control/allocation-integrity", async (_request, reply) => {
    const result = await checkAllocationIntegrity(db);
    return reply.code(200).send({
      passed: result.passed,
      checked_count: result.checkedCount,
      excluded_statuses: result.excludedStatuses,
      breaks: result.breaks.map((b) => ({ payment_reference: b.paymentReference, gross_amount_minor: toWireMinor(b.grossAmountMinor), applied_minor: toWireMinor(b.appliedMinor), unapplied_minor: toWireMinor(b.unappliedMinor), difference_minor: toWireMinor(b.differenceMinor) })),
    });
  });

  app.get("/internal/control/balance-rebuild", async (_request, reply) => {
    const result = await checkBalanceRebuild(db);
    return reply.code(200).send({ passed: result.passed, checked_count: result.checkedCount, breaks: result.breaks });
  });

  app.get("/internal/control/ledger-vs-subledger", async (_request, reply) => {
    const result = await checkLedgerVsSubledger(db);
    return reply.code(200).send({
      passed: result.passed,
      checked_agency_count: result.checkedAgencyCount,
      breaks: result.breaks.map((b) => ({ agency_code: b.agencyCode, ledger_balance_minor: toWireMinor(b.ledgerBalanceMinor), subledger_balance_minor: toWireMinor(b.subledgerBalanceMinor), difference_minor: toWireMinor(b.differenceMinor) })),
    });
  });

  app.get("/internal/ledger/verify-chain", async (_request, reply) => {
    const chainBreak = await verifyLedgerChain(db);
    return reply.code(200).send(chainBreak ? { intact: false, break: chainBreak } : { intact: true, break: null });
  });

  // Screen 6's "break the chain" demo button: tampers with one real journal
  // row via the same DISABLE RULE / restore pattern the test suite itself
  // uses to prove the append-only rule can only be defeated by explicitly
  // bypassing it, and that verify-chain still catches it and names the entry.
  app.post("/internal/demo/tamper-chain", async (_request, reply) => {
    const entry = await db.selectFrom("journal_entry").select(["id", "entry_no"]).orderBy("entry_no", "asc").limit(1).executeTakeFirst();
    if (!entry) {
      return reply.code(404).send({ type: "https://errors.nexuscollect.example/REFERENCE_NOT_FOUND", title: "No journal entries to tamper with", status: 404, code: "REFERENCE_NOT_FOUND", detail: "The ledger is empty.", retryable: false });
    }
    await sql`ALTER TABLE journal_entry DISABLE RULE je_no_update`.execute(db);
    try {
      await sql`UPDATE journal_entry SET hash_self = decode('deadbeef', 'hex') WHERE id = ${entry.id}`.execute(db);
    } finally {
      await sql`ALTER TABLE journal_entry ENABLE RULE je_no_update`.execute(db);
    }
    return reply.code(200).send({ tampered_entry_no: Number(entry.entry_no) });
  });

  // --- Prompt 3 (scoped): reconciliation break register + instrument return ---

  app.post("/internal/recon/run", async (request, reply) => {
    const { business_date } = request.body as { business_date: string };
    const result = await runReconciliation(db, business_date, clock);
    return reply.code(200).send({
      run_id: result.runId,
      break_count: result.breaks.length,
      breaks: result.breaks.map((b) => ({ break_code: b.breakCode, type: b.type, severity: b.severity, amount_minor: toWireMinor(b.amountMinor), source_ref: b.sourceRef, narrative: b.narrative, auto_resolvable: b.autoResolvable })),
    });
  });

  app.get("/internal/instruments", async (_request, reply) => {
    const rows = await db
      .selectFrom("instrument")
      .innerJoin("agency", "agency.id", "instrument.agency_id")
      .select(["instrument.id", "instrument.instrument_type", "instrument.instrument_number", "instrument.drawee_bank_name", "instrument.drawer_name", "instrument.amount_minor", "instrument.status", "instrument.lodged_on", "instrument.returned_on", "instrument.return_reason_code", "instrument.dishonour_charge_assessment_id", "agency.code as agency_code"])
      .orderBy("instrument.created_at", "desc")
      .limit(50)
      .execute();
    return reply.code(200).send(rows.map((r) => ({ id: r.id, instrument_type: r.instrument_type, instrument_number: r.instrument_number, drawee_bank_name: r.drawee_bank_name, drawer_name: r.drawer_name, amount_minor: toWireMinor(r.amount_minor), status: r.status, lodged_on: r.lodged_on, returned_on: r.returned_on, return_reason_code: r.return_reason_code, dishonour_charge_assessment_id: r.dishonour_charge_assessment_id, agency_code: r.agency_code })));
  });

  app.post("/internal/instruments/:instrumentId/return", async (request, reply) => {
    const { instrumentId } = request.params as { instrumentId: string };
    const { reason_code } = request.body as { reason_code: string };
    const result = await returnInstrument(db, instrumentId, reason_code, clock);
    return reply.code(200).send({
      reversed_payment_ids: result.reversedPaymentIds,
      unsettled_assessment_ids: result.unsettledAssessmentIds,
      voided_receipt_ids: result.voidedReceiptIds,
      dishonour_assessment_id: result.dishonourAssessmentId,
    });
  });

  // --- Prompt 4: demo-mode controls ---

  app.post("/internal/demo/reset", async (_request, reply) => {
    if (!demoDataDir) {
      return reply.code(501).send({ type: "https://errors.nexuscollect.example/NOT_CONFIGURED", title: "Reset not configured", status: 501, code: "NOT_CONFIGURED", detail: "buildApp was not given demoDataDir — reset is unavailable.", retryable: false });
    }
    // performance.now() is a monotonic timer for measuring how long the reset
    // itself took to run — not a read of "what time is it" the way Date.now()
    // is, so it doesn't fall under the injected-Clock rule (which exists so
    // the DEMO'S OWN notion of "now" never drifts from DemoClock).
    const startedAt = performance.now();
    await resetDemoData(db, demoDataDir, clock);
    return reply.code(200).send({ reset: true, took_ms: Math.round(performance.now() - startedAt) });
  });

  app.post("/internal/demo/advance-clock", async (request, reply) => {
    if (!(clock instanceof DemoClock)) {
      return reply.code(501).send({ type: "https://errors.nexuscollect.example/NOT_CONFIGURED", title: "Clock is not a DemoClock", status: 501, code: "NOT_CONFIGURED", detail: "advance-clock only works when DEMO_MODE pins a DemoClock.", retryable: false });
    }
    const body = request.body as { by_ms?: number; to_iso?: string };
    if (body.to_iso) clock.set(new Date(body.to_iso));
    else if (body.by_ms) clock.advance(body.by_ms);
    return reply.code(200).send({ now: clock.now().toISOString() });
  });

  // --- Public receipt verification (§16.1): no auth, masked payer only. ---
  app.get("/v1/verify/:receiptNo", async (request, reply) => {
    const { receiptNo } = request.params as { receiptNo: string };
    const receipt = await db
      .selectFrom("receipt")
      .innerJoin("agency", "agency.id", "receipt.agency_id")
      .select(["receipt.receipt_no", "receipt.business_date", "receipt.status", "receipt.issued_at", "agency.name as agency_name"])
      .where("receipt.receipt_no", "=", receiptNo)
      .executeTakeFirst();
    if (!receipt) {
      return reply.code(404).send({ type: "https://errors.nexuscollect.example/REFERENCE_NOT_FOUND", title: "Receipt not found", status: 404, code: "REFERENCE_NOT_FOUND", detail: `No receipt "${receiptNo}".`, retryable: false });
    }
    return reply.code(200).send({ receipt_no: receipt.receipt_no, agency_name: receipt.agency_name, business_date: receipt.business_date, status: receipt.status, issued_at: receipt.issued_at.toISOString() });
  });

  // --- Agency dashboard: head-wise position (confirmed vs settled real figures;
  // "swept" is Phase 5/treasury territory — reported as null, not fabricated). ---
  app.get("/internal/agency/:agencyCode/dashboard", async (request, reply) => {
    const { agencyCode } = request.params as { agencyCode: string };
    const agency = await db.selectFrom("agency").selectAll().where("code", "=", agencyCode).executeTakeFirst();
    if (!agency) {
      return reply.code(404).send({ type: "https://errors.nexuscollect.example/REFERENCE_NOT_FOUND", title: "Agency not found", status: 404, code: "REFERENCE_NOT_FOUND", detail: `No agency "${agencyCode}".`, retryable: false });
    }

    const rows = await db
      .selectFrom("payment_allocation")
      .innerJoin("assessment", "assessment.id", "payment_allocation.assessment_id")
      .innerJoin("revenue_head", "revenue_head.id", "payment_allocation.revenue_head_id")
      .select(["revenue_head.code as head_code", "revenue_head.name as head_name"])
      .select(({ fn }) => fn.sum<bigint>("payment_allocation.amount_minor").as("allocated_minor"))
      .where("assessment.agency_id", "=", agency.id)
      .where("payment_allocation.status", "=", "APPLIED")
      .groupBy(["revenue_head.code", "revenue_head.name"])
      .orderBy("revenue_head.code", "asc")
      .execute();

    const statusCounts = await db
      .selectFrom("assessment")
      .select(["status"])
      .select(({ fn }) => fn.countAll().as("count"))
      .select(({ fn }) => fn.sum<bigint>("balance_minor").as("balance_total"))
      .where("agency_id", "=", agency.id)
      .groupBy("status")
      .execute();

    // §13.1: confirmed/settled/swept are three genuinely separate figures.
    // Swept is now real (Phase 4's runSweep posts an OUTBOUND payment per
    // agency/business-date) — Σ those, not a fabricated placeholder.
    const sweptRow = await db
      .selectFrom("payment")
      .select(({ fn }) => fn.sum<bigint>("gross_amount_minor").as("total"))
      .where("agency_id", "=", agency.id)
      .where("direction", "=", "OUTBOUND")
      .where("status", "=", "CONFIRMED")
      .executeTakeFirst();

    return reply.code(200).send({
      agency_code: agency.code,
      agency_name: agency.name,
      head_wise: rows.map((r) => ({ head_code: r.head_code, head_name: r.head_name, allocated_minor: toWireMinor(BigInt(r.allocated_minor)) })),
      total_confirmed_minor: toWireMinor(rows.reduce((s, r) => s + BigInt(r.allocated_minor), 0n)),
      total_settled_minor: toWireMinor(rows.reduce((s, r) => s + BigInt(r.allocated_minor), 0n)), // same real figure — allocation IS the settlement of that portion
      total_swept_minor: toWireMinor(BigInt(sweptRow?.total ?? 0n)),
      assessment_status_counts: statusCounts.map((s) => ({ status: s.status, count: Number(s.count), balance_total_minor: toWireMinor(BigInt(s.balance_total ?? 0n)) })),
    });
  });

  // --- Phase 3b: switch four-message biller contract (§8.6). Always HTTP 200 —
  // the switch cannot act on an HTTP error; the outcome is carried in response_code. ---

  app.post("/switch/v1/bill-inquiry", async (request, reply) => {
    const body = request.body as { acquirer_id: string; stan: string; rrn: string; txn_date: string; consumer_number: string; biller_id: string; channel?: string };
    const result = await billInquiry(db, body, clock);
    return reply.code(200).send(result);
  });

  app.post("/switch/v1/bill-payment", async (request, reply) => {
    const body = request.body as { acquirer_id: string; stan: string; rrn: string; txn_date: string; consumer_number: string; biller_id: string; response_reference: string; transaction_amount_minor: number; channel?: string };
    try {
      const result = await billPayment(db, { ...body, transaction_amount_minor: BigInt(body.transaction_amount_minor) }, clock);
      return reply.code(200).send(result);
    } catch (err) {
      if (err instanceof SwitchInquiryTokenInvalidError) {
        return reply.code(200).send({ response_code: "96", stan: body.stan, rrn: body.rrn, payment_reference: "", receipt_no: "", settled_amount_minor: 0, remaining_balance_minor: 0, biller_message: err.message });
      }
      throw err;
    }
  });

  app.post("/switch/v1/bill-payment-reversal", async (request, reply) => {
    const body = request.body as { acquirer_id: string; original_stan: string; original_rrn: string; txn_date: string; transaction_amount_minor?: number; reversal_reason: "TIMEOUT" | "CUSTOMER_CANCELLED" | "TECHNICAL" | "DUPLICATE" | "LATE_RESPONSE" };
    const { transaction_amount_minor, ...rest } = body;
    const reversalInput = transaction_amount_minor !== undefined ? { ...rest, transaction_amount_minor: BigInt(transaction_amount_minor) } : rest;
    const result = await billPaymentReversal(db, reversalInput, clock);
    return reply.code(200).send(result);
  });

  app.post("/switch/v1/bill-payment-advice", async (request, reply) => {
    const body = request.body as { acquirer_id: string; original_stan: string; original_rrn: string; txn_date: string; advice_outcome: "CONFIRMED" | "FAILED" };
    const result = await billPaymentAdvice(db, body, clock);
    return reply.code(200).send(result);
  });

  // --- Phase 3b: Request to Pay (§9.2 full state machine) ---

  app.get("/internal/rtp", async (_request, reply) => {
    const rows = await db
      .selectFrom("request_to_pay")
      .innerJoin("agency", "agency.id", "request_to_pay.agency_id")
      .select(["request_to_pay.id", "request_to_pay.rtp_reference", "request_to_pay.status", "request_to_pay.amount_minor", "request_to_pay.payer_name", "request_to_pay.expires_at", "request_to_pay.reminder_count", "agency.code as agency_code"])
      .orderBy("request_to_pay.created_at", "desc")
      .limit(50)
      .execute();
    return reply.code(200).send(rows.map((r) => ({ id: r.id, rtp_reference: r.rtp_reference, status: r.status, amount_minor: toWireMinor(r.amount_minor), payer_name: r.payer_name, expires_at: r.expires_at.toISOString(), reminder_count: r.reminder_count, agency_code: r.agency_code })));
  });

  app.post("/internal/rtp/:rtpId/transition", async (request, reply) => {
    const { rtpId } = request.params as { rtpId: string };
    const { action, reason_code, mode, accepted_amount_minor } = request.body as { action: string; reason_code?: string; mode?: "FULL" | "FUTURE_DATED" | "PARTIAL"; accepted_amount_minor?: number };
    const actor = { actorType: "USER" as const, actorId: "ops-console" };
    try {
      const result = await db.transaction().execute(async (trx) => {
        switch (action) {
          case "send": return markSent(trx, rtpId, `PAIN013-${rtpId.slice(0, 8)}`, actor, clock);
          case "deliver": return markDelivered(trx, rtpId, actor, clock);
          case "present": return markPresented(trx, rtpId, actor, clock);
          case "accept": return acceptRtp(trx, rtpId, mode ?? "FULL", actor, clock, accepted_amount_minor !== undefined ? BigInt(accepted_amount_minor) : undefined);
          case "decline": return declineRtp(trx, rtpId, reason_code ?? "UNSPECIFIED", actor, clock);
          case "cancel": return cancelRtp(trx, rtpId, reason_code ?? "AGENCY_WITHDRAWN", actor, clock);
          default: throw new Error(`Unknown RtP action "${action}"`);
        }
      });
      return reply.code(200).send({ rtp_reference: result.rtpReference, status: result.status });
    } catch (err) {
      if (err instanceof IllegalRtpTransition) {
        return reply.code(err.httpStatus).send({ type: "https://errors.nexuscollect.example/ILLEGAL_STATE_TRANSITION", title: "Illegal transition", status: err.httpStatus, code: err.code, detail: err.message, retryable: false });
      }
      throw err;
    }
  });

  /** An RtP is fulfilled by an ordinary payment capture that happens to
   * originate from an accepted RtP — this endpoint is the seam a real
   * RAAST RtP-fulfilment flow would call after `capturePayment` succeeds. */
  app.post("/internal/rtp/:rtpId/fulfil", async (request, reply) => {
    const { rtpId } = request.params as { rtpId: string };
    const { payment_reference } = request.body as { payment_reference: string };
    const payment = await db.selectFrom("payment").select("id").where("payment_reference", "=", payment_reference).executeTakeFirst();
    if (!payment) {
      return reply.code(404).send({ type: "https://errors.nexuscollect.example/REFERENCE_NOT_FOUND", title: "Payment not found", status: 404, code: "REFERENCE_NOT_FOUND", detail: `No payment "${payment_reference}".`, retryable: false });
    }
    const result = await db.transaction().execute((trx) => fulfillRtpWithPayment(trx, rtpId, payment.id, { actorType: "SYSTEM", actorId: "rtp-fulfilment" }, clock));
    return reply.code(200).send({ rtp_reference: result.rtpReference, status: result.status });
  });

  app.post("/internal/rtp/expire-due", async (_request, reply) => {
    const expired = await expireDueRequests(db, clock);
    return reply.code(200).send({ expired_count: expired.length, expired_references: expired });
  });

  // --- Phase 4: settlement, treasury sweep, scroll, period close (§13, Prompt 5) ---

  app.post("/internal/settlement/:agencyCode/sweep", async (request, reply) => {
    const { agencyCode } = request.params as { agencyCode: string };
    const { business_date } = request.body as { business_date: string };
    const result = await runSweep(db, agencyCode, business_date, clock);
    return reply.code(200).send({ swept_amount_minor: toWireMinor(result.sweptAmountMinor), scroll_reference: result.scroll.scrollReference, record_count: result.scroll.recordCount });
  });

  app.post("/internal/settlement/:agencyCode/scroll", async (request, reply) => {
    const { agencyCode } = request.params as { agencyCode: string };
    const { business_date } = request.body as { business_date: string };
    const scroll = await generateScroll(db, agencyCode, business_date, clock);
    return reply.code(200).send({ scroll_reference: scroll.scrollReference, record_count: scroll.recordCount, control_total_minor: toWireMinor(scroll.controlTotalMinor), detail_sha256: scroll.detailSha256, full_text: scroll.fullText });
  });

  app.post("/internal/settlement/scroll/:scrollId/ack", async (request, reply) => {
    const { scrollId } = request.params as { scrollId: string };
    const { ack_status } = request.body as { ack_status: "ACCEPTED" | "REJECTED" };
    await recordScrollAck(db, scrollId, ack_status, clock);
    return reply.code(200).send({ acked: true });
  });

  app.get("/internal/settlement/pre-close-checks", async (request, reply) => {
    const { period_start, period_end } = request.query as { period_start: string; period_end: string };
    const result = await runPreCloseChecks(db, period_start, period_end);
    return reply.code(200).send(result);
  });

  app.post("/internal/settlement/period-close", async (request, reply) => {
    const { period_start, period_end, closed_by } = request.body as { period_start: string; period_end: string; closed_by: string };
    try {
      const result = await closePeriod(db, period_start, period_end, closed_by, clock);
      return reply.code(200).send({ period_id: result.periodId, status: "CLOSED" });
    } catch (err) {
      if (err instanceof PeriodCloseBlockedError) {
        return reply.code(409).send({ type: "https://errors.nexuscollect.example/PERIOD_CLOSE_BLOCKED", title: "Period close blocked", status: 409, code: "PERIOD_CLOSE_BLOCKED", detail: err.message, failures: err.failures, retryable: false });
      }
      if (err instanceof PeriodAlreadyClosedError) {
        return reply.code(409).send({ type: "https://errors.nexuscollect.example/PERIOD_ALREADY_CLOSED", title: "Period already closed", status: 409, code: "PERIOD_ALREADY_CLOSED", detail: err.message, retryable: false });
      }
      throw err;
    }
  });

  app.post("/internal/settlement/period/:periodId/signoff", async (request, reply) => {
    const { periodId } = request.params as { periodId: string };
    const { agency_code, signed_off_by } = request.body as { agency_code: string; signed_off_by: string };
    await recordAgencySignoff(db, periodId, agency_code, signed_off_by, request.ip, clock);
    return reply.code(200).send({ signed_off: true });
  });

  // --- Phase 5: refunds, reversal cascade, card/wallet, mandates, bulk file (Prompt 6) ---

  app.post("/internal/refunds", async (request, reply) => {
    const body = request.body as { payment_reference: string; amount_minor: number; reason_code: string; mode: "SURPLUS_ONLY" | "FULL_REVERSAL"; funding_source: "PLATFORM_HELD" | "AGENCY_FUNDED"; override_beneficiary_account_masked?: string; actor_id: string };
    const payment = await db.selectFrom("payment").select("id").where("payment_reference", "=", body.payment_reference).executeTakeFirstOrThrow();
    const result = await createRefund(db, { paymentId: payment.id, amountMinor: BigInt(body.amount_minor), reasonCode: body.reason_code as never, mode: body.mode, fundingSource: body.funding_source, ...(body.override_beneficiary_account_masked ? { overrideBeneficiaryAccountMasked: body.override_beneficiary_account_masked } : {}), actorId: body.actor_id }, clock);
    return reply.code(201).send({ refund_id: result.refundId, refund_reference: result.refundReference, status: result.status });
  });

  app.post("/internal/refunds/:refundId/approve", async (request, reply) => {
    const { refundId } = request.params as { refundId: string };
    const { checker_user_id, maker_user_id } = request.body as { checker_user_id: string; maker_user_id: string };
    try {
      await approveRefund(db, refundId, checker_user_id, maker_user_id, clock);
      return reply.code(200).send({ status: "APPROVED" });
    } catch (err) {
      if (err instanceof SelfApprovalError) {
        return reply.code(409).send({ type: "https://errors.nexuscollect.example/SELF_APPROVAL_NOT_ALLOWED", title: "Self-approval not allowed", status: 409, code: err.code, detail: err.message, retryable: false });
      }
      throw err;
    }
  });

  app.post("/internal/refunds/:refundId/pay", async (request, reply) => {
    const { refundId } = request.params as { refundId: string };
    await payRefund(db, refundId, clock);
    return reply.code(200).send({ status: "PAID" });
  });

  app.post("/internal/bulk-payments/validate", async (request, reply) => {
    const body = request.body as { rows: { row_no: number; psid: string; amount_minor: number }[]; declared_row_count: number; declared_total_minor: number; file_content: string };
    const result = await validateBulkFile(db, { rows: body.rows.map((r) => ({ rowNo: r.row_no, psid: r.psid, amountMinor: BigInt(r.amount_minor) })), declaredRowCount: body.declared_row_count, declaredTotalMinor: BigInt(body.declared_total_minor), fileContent: body.file_content }, clock);
    return reply.code(200).send({ batch_id: result.batchId, bulk_reference: result.bulkReference, status: result.status, rejection_reason: result.rejectionReason, rows: result.rows.map((r) => ({ row_no: r.rowNo, psid: r.psid, amount_minor: toWireMinor(r.amountMinor), outcome: r.outcome, error_code: r.errorCode ?? null })) });
  });

  app.post("/internal/bulk-payments/:batchId/confirm", async (request, reply) => {
    const { batchId } = request.params as { batchId: string };
    const { value_date } = request.body as { value_date: string };
    try {
      const result = await confirmBulkBatch(db, batchId, value_date, clock);
      return reply.code(200).send({ payment_id: result.paymentId, settled_count: result.settledCount });
    } catch (err) {
      if (err instanceof BulkBatchNotValidatedError) {
        return reply.code(err.httpStatus).send({ type: "https://errors.nexuscollect.example/BULK_BATCH_NOT_VALIDATED", title: "Bulk batch not validated", status: err.httpStatus, code: err.code, detail: err.message, retryable: false });
      }
      throw err;
    }
  });

  app.post("/internal/recalls", async (request, reply) => {
    const body = request.body as { payment_reference: string; requested_reason: string };
    const payment = await db.selectFrom("payment").select("id").where("payment_reference", "=", body.payment_reference).executeTakeFirstOrThrow();
    const result = await receiveRecall(db, payment.id, body.requested_reason, clock);
    return reply.code(200).send({ recall_id: result.recallId, outcome: result.outcome, camt029_reason: result.camt029Reason });
  });

  app.post("/internal/mandates", async (request, reply) => {
    const body = request.body as { payer_reference: string; product_code: string; max_amount_minor: number; frequency: "MONTHLY" | "QUARTERLY" | "ANNUAL"; first_collection_date: string };
    const payer = await db.selectFrom("payer").select("id").where("id", "=", body.payer_reference).executeTakeFirst();
    const product = await db.selectFrom("collection_product").select("id").where("code", "=", body.product_code).executeTakeFirstOrThrow();
    const payerId = payer?.id ?? (await db.selectFrom("payer").select("id").limit(1).executeTakeFirstOrThrow()).id;
    const result = await createMandate(db, { payerId, productId: product.id, maxAmountMinor: BigInt(body.max_amount_minor), frequency: body.frequency, firstCollectionDate: body.first_collection_date });
    return reply.code(201).send({ mandate_id: result.mandateId, mandate_reference: result.mandateReference });
  });

  app.post("/internal/mandates/:mandateId/collect", async (request, reply) => {
    const { mandateId } = request.params as { mandateId: string };
    const { psid, amount_minor, value_date, assessment_ids } = request.body as { psid: string; amount_minor: number; value_date: string; assessment_ids?: string[] };
    const result = await collectUnderMandate(db, mandateId, assessment_ids ?? [], psid, BigInt(amount_minor), value_date, clock);
    return reply.code(200).send({ outcome: result.outcome, payment_id: result.paymentId ?? null, retry_count: result.retryCount });
  });

  app.post("/internal/payments/card", async (request, reply) => {
    const body = request.body as { psid: string; amount_minor: number; value_date: string; gateway_token: string; bin6: string; last4: string; scheme: "PAYPAK" | "VISA" | "MASTERCARD" | "UNIONPAY" };
    const result = await captureCardPayment(db, { psid: body.psid, amountMinor: BigInt(body.amount_minor), valueDate: body.value_date, obligationDischargeDate: body.value_date, gatewayToken: body.gateway_token, bin6: body.bin6, last4: body.last4, scheme: body.scheme }, clock);
    return reply.code(200).send({ payment_id: result.paymentId, status: result.status, settled_assessment_ids: result.settledAssessmentIds });
  });

  app.post("/internal/payments/wallet", async (request, reply) => {
    const body = request.body as { psid: string; amount_minor: number; value_date: string; wallet_provider: string; wallet_msisdn_masked: string };
    const result = await captureWalletPayment(db, { psid: body.psid, amountMinor: BigInt(body.amount_minor), valueDate: body.value_date, obligationDischargeDate: body.value_date, walletProvider: body.wallet_provider, walletMsisdnMasked: body.wallet_msisdn_masked }, clock);
    return reply.code(200).send({ payment_id: result.paymentId, status: result.status, settled_assessment_ids: result.settledAssessmentIds });
  });

  // §8.13: print-and-pay challan (real computed content; no PDF-rendering
  // library in this build's dependencies, so this returns HTML — disclosed,
  // not a fabricated PDF binary).
  app.get("/v1/challan/:psid", async (request, reply) => {
    const { psid } = request.params as { psid: string };
    const challan = await generateChallan(db, psid, clock);
    return reply.code(200).type("text/html").send(renderChallanHtml(challan));
  });

  // --- Phase 6: receipt signing + offline verification (§16.1/16.2) ---

  app.get("/v1/receipts/:receiptNo/signed", async (request, reply) => {
    const { receiptNo } = request.params as { receiptNo: string };
    const bundle = await getSignedReceiptBundle(db, receiptNo);
    if (!bundle) {
      return reply.code(404).send({ type: "https://errors.nexuscollect.example/REFERENCE_NOT_FOUND", title: "Receipt not found", status: 404, code: "REFERENCE_NOT_FOUND", detail: `No receipt "${receiptNo}".`, retryable: false });
    }
    return reply.code(200).send({ receipt_no: bundle.receiptNo, canonical_payload: bundle.canonicalPayload, signature_base64: bundle.signatureBase64, public_key_pem: bundle.publicKeyPem });
  });

  // A pure function over caller-supplied inputs — this endpoint is a
  // convenience for testing the same check a real offline verifier would run
  // client-side; it does no DB lookup at all, proving no network/DB access
  // is actually required to verify.
  app.post("/v1/receipts/verify-signature", async (request, reply) => {
    const { canonical_payload, signature_base64, public_key_pem } = request.body as { canonical_payload: string; signature_base64: string; public_key_pem?: string };
    const valid = verifyReceiptSignature(canonical_payload, signature_base64, public_key_pem ?? getPublicKeyPem());
    return reply.code(200).send({ valid });
  });

  app.get("/v1/receipts/verification-key", async (_request, reply) => {
    return reply.code(200).send({ public_key_pem: getPublicKeyPem(), algorithm: "Ed25519" });
  });

  // --- Phase 6: webhooks (§18.2) ---

  app.post("/internal/webhooks/subscriptions", async (request, reply) => {
    const { url, secret, agency_code } = request.body as { url: string; secret: string; agency_code?: string };
    const agencyId = agency_code ? (await db.selectFrom("agency").select("id").where("code", "=", agency_code).executeTakeFirstOrThrow()).id : undefined;
    const id = await createWebhookSubscription(db, url, secret, agencyId);
    return reply.code(201).send({ subscription_id: id });
  });

  app.post("/internal/webhooks/deliver-pending", async (_request, reply) => {
    const result = await deliverPendingWebhooks(db, clock);
    return reply.code(200).send({ attempted: result.attempted, delivered: result.delivered });
  });

  app.post("/admin/v1/webhooks/:subscriptionId/replay", async (request, reply) => {
    const { subscriptionId } = request.params as { subscriptionId: string };
    const { from, to } = request.query as { from: string; to: string };
    const count = await replayWebhooks(db, subscriptionId, Number(from), Number(to), clock);
    return reply.code(200).send({ requeued_count: count });
  });

  // --- Phase 6: notifications (§16.3) ---

  app.post("/internal/notifications/send", async (request, reply) => {
    const body = request.body as { payer_reference?: string; assessment_psid?: string; event_type: string; channel: "SMS" | "EMAIL" | "PUSH" | "LETTER"; local_hour: number };
    const assessment = body.assessment_psid ? await db.selectFrom("assessment").select(["id", "payer_id"]).where("psid", "=", body.assessment_psid).executeTakeFirst() : undefined;
    const result = await sendNotification(db, { payerId: assessment?.payer_id ?? null, assessmentId: assessment?.id ?? null, eventType: body.event_type as never, channel: body.channel, localHour: body.local_hour }, clock);
    return reply.code(200).send({ outcome: result.outcome, log_id: result.logId });
  });

  // --- Phase 6: reports R01-R18 (§21.1) ---

  // Bigint amounts appear throughout report results — this walks the result
  // tree once and converts them via toWireMinor, the same guarded conversion
  // every other route already uses per-field.
  const serializeReport = (value: unknown): unknown => {
    if (typeof value === "bigint") return toWireMinor(value);
    if (Array.isArray(value)) return value.map(serializeReport);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, serializeReport(v)]));
    }
    return value;
  };

  app.get("/internal/reports/r01", async (request, reply) => reply.code(200).send(serializeReport(await reports.r01DailyCollectionSummary(db, (request.query as { business_date: string }).business_date))));
  app.get("/internal/reports/r02", async (request, reply) => {
    const q = request.query as { period_start: string; period_end: string; agency_code?: string };
    return reply.code(200).send(serializeReport(await reports.r02HeadWiseStatement(db, q.period_start, q.period_end, q.agency_code)));
  });
  app.get("/internal/reports/r03", async (request, reply) => reply.code(200).send(serializeReport(await reports.r03ReconciliationCertificate(db, (request.query as { business_date: string }).business_date))));
  app.get("/internal/reports/r04", async (request, reply) => reply.code(200).send(serializeReport(await reports.r04BreakRegisterAgeing(db, (request.query as { as_of_date: string }).as_of_date))));
  app.get("/internal/reports/r05", async (request, reply) => reply.code(200).send(serializeReport(await reports.r05SettlementSweepReport(db, (request.query as { business_date: string }).business_date))));
  app.get("/internal/reports/r06", async (request, reply) => reply.code(200).send(serializeReport(await reports.r06UnappliedReceiptsAgeing(db, (request.query as { as_of_date: string }).as_of_date))));
  app.get("/internal/reports/r07", async (request, reply) => reply.code(200).send(serializeReport(await reports.r07OutstandingAssessmentsAgeing(db, (request.query as { as_of_date: string }).as_of_date))));
  app.get("/internal/reports/r08", async (_request, reply) => reply.code(200).send(serializeReport(await reports.r08RtpFunnel(db))));
  app.get("/internal/reports/r09", async (_request, reply) => reply.code(200).send(serializeReport(await reports.r09ChannelPerformance(db))));
  app.get("/internal/reports/r10", async (request, reply) => {
    const q = request.query as { period_start: string; period_end: string };
    return reply.code(200).send(serializeReport(await reports.r10FeeRevenueStatement(db, q.period_start, q.period_end)));
  });
  app.get("/internal/reports/r11", async (request, reply) => {
    const q = request.query as { period_start: string; period_end: string };
    return reply.code(200).send(serializeReport(await reports.r11RefundsAndReversals(db, q.period_start, q.period_end)));
  });
  app.get("/internal/reports/r12", async (_request, reply) => reply.code(200).send(serializeReport(await reports.r12ChequePerformance(db))));
  app.get("/internal/reports/r13", async (_request, reply) => reply.code(200).send(serializeReport(await reports.r13ControlPack(db))));
  app.get("/internal/reports/r14", async (request, reply) => {
    const q = request.query as { agency_code: string; period_start: string; period_end: string };
    return reply.code(200).send(serializeReport(await reports.r14PeriodStatementPerAgency(db, q.agency_code, q.period_start, q.period_end)));
  });
  app.get("/internal/reports/r15", async (_request, reply) => reply.code(200).send(reports.r15SlaAvailability()));
  app.get("/internal/reports/r16", async (_request, reply) => reply.code(200).send(serializeReport(await reports.r16PayerExperience(db))));
  app.get("/internal/reports/r17", async (_request, reply) => reply.code(200).send(reports.r17RegulatoryReturn()));
  app.get("/internal/reports/r18", async (request, reply) => {
    const q = request.query as { agency_code: string; fiscal_year_start: string; fiscal_year_end: string };
    return reply.code(200).send(await reports.r18FiscalYearCertificate(db, q.agency_code, q.fiscal_year_start, q.fiscal_year_end, clock));
  });

  app.get("/internal/reports", async (_request, reply) => {
    return reply.code(200).send([
      { id: "r01", name: "Daily Collection Summary" }, { id: "r02", name: "Head-wise Collection Statement" },
      { id: "r03", name: "Daily Reconciliation Certificate" }, { id: "r04", name: "Break Register & Ageing" },
      { id: "r05", name: "Settlement & Sweep Report" }, { id: "r06", name: "Unapplied Receipts Ageing" },
      { id: "r07", name: "Outstanding Assessments Ageing" }, { id: "r08", name: "RtP Funnel" },
      { id: "r09", name: "Channel Performance" }, { id: "r10", name: "Fee & Revenue Statement" },
      { id: "r11", name: "Refunds & Reversals" }, { id: "r12", name: "Cheque Performance" },
      { id: "r13", name: "Trial Balance & Control Pack" }, { id: "r14", name: "Period Statement per Agency" },
      { id: "r15", name: "SLA & Availability" }, { id: "r16", name: "Payer Experience" },
      { id: "r17", name: "Regulatory Return" }, { id: "r18", name: "Fiscal Year Certificate" },
    ]);
  });

  // --- Phase 6: back-office screens (§22.1) ---

  // Payment search & 360° view
  app.get("/internal/payments/search", async (request, reply) => {
    const { q } = request.query as { q: string };
    const rows = await db
      .selectFrom("payment")
      .select(["id", "payment_reference", "status", "gross_amount_minor", "channel", "rail", "value_date"])
      .where((eb) => eb.or([eb("payment_reference", "ilike", `%${q}%`), eb("rail_e2e_id", "ilike", `%${q}%`), eb("switch_stan", "=", q)]))
      .limit(50)
      .execute();
    return reply.code(200).send(rows.map((r) => ({ id: r.id, payment_reference: r.payment_reference, status: r.status, gross_amount_minor: toWireMinor(r.gross_amount_minor), channel: r.channel, rail: r.rail, value_date: r.value_date })));
  });

  app.get("/internal/payments/:paymentReference/360", async (request, reply) => {
    const { paymentReference } = request.params as { paymentReference: string };
    const payment = await db.selectFrom("payment").selectAll().where("payment_reference", "=", paymentReference).executeTakeFirst();
    if (!payment) return reply.code(404).send({ type: "https://errors.nexuscollect.example/REFERENCE_NOT_FOUND", title: "Payment not found", status: 404, code: "REFERENCE_NOT_FOUND", detail: `No payment "${paymentReference}".`, retryable: false });

    const allocations = await db.selectFrom("payment_allocation").innerJoin("assessment", "assessment.id", "payment_allocation.assessment_id").innerJoin("revenue_head", "revenue_head.id", "payment_allocation.revenue_head_id").select(["assessment.psid", "revenue_head.code as head_code", "payment_allocation.amount_minor", "payment_allocation.status"]).where("payment_allocation.payment_id", "=", payment.id).execute();
    const journalLines = await db.selectFrom("journal_line").innerJoin("journal_entry", "journal_entry.id", "journal_line.entry_id").select(["journal_entry.entry_no", "journal_entry.event_type", "journal_line.account_code", "journal_line.direction", "journal_line.amount_minor"]).where("journal_entry.source_type", "=", "payment").where("journal_entry.source_id", "=", payment.id).execute();
    const receipt = await db.selectFrom("receipt").select(["receipt_no", "status"]).where("payment_id", "=", payment.id).executeTakeFirst();
    const breaks = await db.selectFrom("recon_break").select(["break_code", "status", "amount_minor"]).where("payment_id", "=", payment.id).execute();

    return reply.code(200).send({
      payment_reference: payment.payment_reference, status: payment.status, gross_amount_minor: toWireMinor(payment.gross_amount_minor), unapplied_amount_minor: toWireMinor(payment.unapplied_amount_minor),
      channel: payment.channel, rail: payment.rail, value_date: payment.value_date, obligation_discharge_date: payment.obligation_discharge_date, finality: payment.finality,
      application_trace: payment.application_trace,
      allocations: allocations.map((a) => ({ psid: a.psid, head_code: a.head_code, amount_minor: toWireMinor(a.amount_minor), status: a.status })),
      journal_entries: journalLines.map((j) => ({ entry_no: Number(j.entry_no), event_type: j.event_type, account_code: j.account_code, direction: j.direction, amount_minor: toWireMinor(j.amount_minor) })),
      receipt: receipt ? { receipt_no: receipt.receipt_no, status: receipt.status } : null,
      recon_breaks: breaks.map((b) => ({ break_code: b.break_code, status: b.status, amount_minor: toWireMinor(b.amount_minor) })),
    });
  });

  // Assessment 360° view
  app.get("/internal/assessments/:psid/360", async (request, reply) => {
    const { psid } = request.params as { psid: string };
    const current = await db.selectFrom("assessment").selectAll().where("psid", "=", psid).orderBy("version", "desc").limit(1).executeTakeFirst();
    if (!current) return reply.code(404).send({ type: "https://errors.nexuscollect.example/REFERENCE_NOT_FOUND", title: "Assessment not found", status: 404, code: "REFERENCE_NOT_FOUND", detail: `No assessment "${psid}".`, retryable: false });

    const versions = await db.selectFrom("assessment").select(["id", "version", "status", "assessed_amount_minor", "payable_amount_minor", "allocated_amount_minor", "balance_minor"]).where("psid", "=", psid).orderBy("version", "asc").execute();
    const lineItems = await db.selectFrom("assessment_line_item").innerJoin("revenue_head", "revenue_head.id", "assessment_line_item.revenue_head_id").select(["revenue_head.code as head_code", "assessment_line_item.line_type", "assessment_line_item.amount_minor", "assessment_line_item.allocated_minor"]).where("assessment_line_item.assessment_id", "=", current.id).execute();
    const allocations = await db.selectFrom("payment_allocation").innerJoin("payment", "payment.id", "payment_allocation.payment_id").select(["payment.payment_reference", "payment_allocation.amount_minor", "payment_allocation.status", "payment_allocation.applied_at"]).where("payment_allocation.assessment_id", "=", current.id).execute();
    const notifications = await db.selectFrom("notification_log").select(["event_type", "channel", "status", "sent_at"]).where("assessment_id", "=", current.id).execute();

    return reply.code(200).send({
      psid, current_version: current.version, status: current.status,
      versions: versions.map((v) => ({ version: v.version, status: v.status, assessed_amount_minor: toWireMinor(v.assessed_amount_minor), payable_amount_minor: toWireMinor(v.payable_amount_minor), allocated_amount_minor: toWireMinor(v.allocated_amount_minor), balance_minor: toWireMinor(v.balance_minor) })),
      line_items: lineItems.map((l) => ({ head_code: l.head_code, line_type: l.line_type, amount_minor: toWireMinor(l.amount_minor), allocated_minor: toWireMinor(l.allocated_minor) })),
      payment_history: allocations.map((a) => ({ payment_reference: a.payment_reference, amount_minor: toWireMinor(a.amount_minor), status: a.status, applied_at: a.applied_at.toISOString() })),
      notifications: notifications.map((n) => ({ event_type: n.event_type, channel: n.channel, status: n.status, sent_at: n.sent_at.toISOString() })),
    });
  });

  // Payer 360° view
  app.get("/internal/payers/search", async (request, reply) => {
    const { q } = request.query as { q: string };
    const rows = await db.selectFrom("payer").select(["id", "name", "payer_type", "msisdn_e164"]).where("name", "ilike", `%${q}%`).limit(50).execute();
    return reply.code(200).send(rows);
  });

  app.get("/internal/payers/:payerId/360", async (request, reply) => {
    const { payerId } = request.params as { payerId: string };
    const payer = await db.selectFrom("payer").selectAll().where("id", "=", payerId).executeTakeFirst();
    if (!payer) return reply.code(404).send({ type: "https://errors.nexuscollect.example/REFERENCE_NOT_FOUND", title: "Payer not found", status: 404, code: "REFERENCE_NOT_FOUND", detail: `No payer "${payerId}".`, retryable: false });

    const accounts = await db.selectFrom("payer_account").innerJoin("agency", "agency.id", "payer_account.agency_id").select(["agency.code as agency_code", "payer_account.crn", "payer_account.status"]).where("payer_account.payer_id", "=", payerId).execute();
    const assessments = await db.selectFrom("assessment").select(["psid", "status", "balance_minor"]).where("payer_id", "=", payerId).execute();
    // `payment` has no direct payer_id column — the real link is via the
    // assessment(s) it settled (payment_allocation -> assessment.payer_id).
    const payments = await db
      .selectFrom("payment")
      .innerJoin("payment_allocation", "payment_allocation.payment_id", "payment.id")
      .innerJoin("assessment", "assessment.id", "payment_allocation.assessment_id")
      .select(["payment.payment_reference", "payment.status", "payment.gross_amount_minor"])
      .where("assessment.payer_id", "=", payerId)
      .distinct()
      .execute();
    const refunds = await db
      .selectFrom("refund")
      .innerJoin("payment", "payment.id", "refund.payment_id")
      .innerJoin("payment_allocation", "payment_allocation.payment_id", "payment.id")
      .innerJoin("assessment", "assessment.id", "payment_allocation.assessment_id")
      .select(["refund.refund_reference", "refund.status", "refund.amount_minor"])
      .where("assessment.payer_id", "=", payerId)
      .distinct()
      .execute();
    const mandates = await db.selectFrom("mandate").select(["mandate_reference", "status", "max_amount_minor"]).where("payer_id", "=", payerId).execute();

    return reply.code(200).send({
      payer_id: payer.id, name: payer.name, payer_type: payer.payer_type, risk_rating: payer.risk_rating,
      accounts: accounts.map((a) => ({ agency_code: a.agency_code, crn: a.crn, status: a.status })),
      assessments: assessments.map((a) => ({ psid: a.psid, status: a.status, balance_minor: toWireMinor(a.balance_minor) })),
      payments: payments.map((p) => ({ payment_reference: p.payment_reference, status: p.status, gross_amount_minor: toWireMinor(p.gross_amount_minor) })),
      refunds: refunds.map((r) => ({ refund_reference: r.refund_reference, status: r.status, amount_minor: toWireMinor(r.amount_minor) })),
      mandates: mandates.map((m) => ({ mandate_reference: m.mandate_reference, status: m.status, max_amount_minor: toWireMinor(m.max_amount_minor) })),
    });
  });

  // Unapplied receipts queue
  app.get("/internal/unapplied-receipts", async (_request, reply) => {
    const rows = await db.selectFrom("payment").select(["payment_reference", "unapplied_amount_minor", "value_date", "channel", "rail", "remittance_raw"]).where("unapplied_amount_minor", ">", 0n).where("status", "=", "CONFIRMED").execute();
    return reply.code(200).send(rows.map((r) => ({ payment_reference: r.payment_reference, amount_minor: toWireMinor(r.unapplied_amount_minor), value_date: r.value_date, channel: r.channel, rail: r.rail, remittance_raw: r.remittance_raw })));
  });

  // UNCERTAIN payments queue
  app.get("/internal/payments/uncertain", async (_request, reply) => {
    const rows = await db.selectFrom("payment").select(["payment_reference", "gross_amount_minor", "channel", "rail", "received_at", "uncertain_resolution_source"]).where("status", "=", "UNCERTAIN").execute();
    return reply.code(200).send(rows.map((r) => ({ payment_reference: r.payment_reference, gross_amount_minor: toWireMinor(r.gross_amount_minor), channel: r.channel, rail: r.rail, received_at: r.received_at.toISOString(), uncertain_resolution_source: r.uncertain_resolution_source })));
  });

  // (resolve-uncertain for this same path already exists above, registered
  // during Phase 2 — reused as-is by the UNCERTAIN queue screen rather than
  // duplicated here.)

  // Teller / till
  app.post("/internal/till/capture-cash", async (request, reply) => {
    const body = request.body as { psid: string; amount_minor: number; value_date: string };
    const result = await capturePayment(db, { paymentReference: "", channel: "OTC", rail: "CASH", grossAmountMinor: BigInt(body.amount_minor), valueDate: body.value_date, obligationDischargeDate: body.value_date, explicitAllocations: [{ psid: body.psid, amountMinor: BigInt(body.amount_minor) }], captureOutcome: "CONFIRMED" }, clock);
    return reply.code(200).send({ payment_id: result.paymentId, status: result.status, settled_assessment_ids: result.settledAssessmentIds });
  });

  app.post("/internal/till/reverse/:paymentReference", async (request, reply) => {
    const { paymentReference } = request.params as { paymentReference: string };
    const { reason } = request.body as { reason: string };
    const payment = await db.selectFrom("payment").select("id").where("payment_reference", "=", paymentReference).executeTakeFirstOrThrow();
    await reversePayment(db, payment.id, reason, { actorType: "USER", actorId: "teller" }, clock);
    return reply.code(200).send({ status: "REVERSED" });
  });

  app.post("/internal/till/close", async (request, reply) => {
    const { business_date, counted_amount_minor } = request.body as { business_date: string; counted_amount_minor: number };
    const expected = await db.selectFrom("payment").select(({ fn }) => fn.sum<bigint>("gross_amount_minor").as("total")).where("rail", "=", "CASH").where("value_date", "=", business_date).where("status", "=", "CONFIRMED").executeTakeFirst();
    const expectedMinor = BigInt(expected?.total ?? 0n);
    const countedMinor = BigInt(counted_amount_minor);
    const diff = countedMinor - expectedMinor;
    if (diff !== 0n) {
      await db.transaction().execute(async (trx) => {
        const tillCode = await getOrCreateLedgerAccount(trx, { baseCode: "1010", dimensionKey: "TELLER-01", name: "Cash in Till", accountType: "ASSET", normalBalance: "DR" });
        const overShortCode = await getOrCreateLedgerAccount(trx, { baseCode: "5900", dimensionKey: "PLATFORM", name: "Cash Over/Short", accountType: "EXPENSE", normalBalance: "DR" });
        await postJournalTemplate(trx, diff > 0n
          ? { eventType: "TILL_OVER", debitAccountCode: tillCode, creditAccountCode: overShortCode, amountMinor: diff, sourceType: "till_close", sourceId: `${business_date}:TELLER-01`, valueDate: business_date }
          : { eventType: "TILL_SHORT", debitAccountCode: overShortCode, creditAccountCode: tillCode, amountMinor: -diff, sourceType: "till_close", sourceId: `${business_date}:TELLER-01`, valueDate: business_date },
          clock);
      });
    }
    return reply.code(200).send({ expected_minor: toWireMinor(expectedMinor), counted_minor: toWireMinor(countedMinor), difference_minor: toWireMinor(diff) });
  });

  // Settlement & sweep screen
  app.get("/internal/settlement/overview", async (request, reply) => {
    const { business_date } = request.query as { business_date: string };
    const overview = await reports.r05SettlementSweepReport(db, business_date);
    return reply.code(200).send(serializeReport(overview));
  });

  // Approvals inbox
  app.get("/internal/approvals", async (request, reply) => {
    const { state } = request.query as { state?: string };
    let q = db.selectFrom("approval").selectAll().orderBy("maker_at", "desc").limit(50);
    if (state) q = q.where("state", "=", state as never);
    const rows = await q.execute();
    const withRefund = await Promise.all(
      rows.map(async (r) => {
        const refund = r.subject_type === "refund" ? await db.selectFrom("refund").innerJoin("payment", "payment.id", "refund.payment_id").select(["refund.refund_reference", "refund.mode", "payment.payment_reference"]).where("refund.id", "=", r.subject_id).executeTakeFirst() : undefined;
        return { id: r.id, subject_type: r.subject_type, action: r.action, amount_minor: r.amount_minor !== null ? toWireMinor(r.amount_minor) : null, state: r.state, maker_user_id: r.maker_user_id, maker_at: r.maker_at.toISOString(), refund_preview: refund ?? null };
      }),
    );
    return reply.code(200).send(withRefund);
  });

  // Agency & product configuration
  app.get("/internal/agencies", async (_request, reply) => {
    const rows = await db.selectFrom("agency").select(["code", "name", "tier", "settlement_model", "sweep_schedule", "status"]).execute();
    return reply.code(200).send(rows);
  });

  app.get("/internal/products", async (request, reply) => {
    const { agency_code } = request.query as { agency_code?: string };
    let q = db.selectFrom("collection_product").innerJoin("agency", "agency.id", "collection_product.agency_id").select(["agency.code as agency_code", "collection_product.code", "collection_product.category", "collection_product.status", "collection_product.overpay_treatment", "collection_product.allocation_waterfall"]);
    if (agency_code) q = q.where("agency.code", "=", agency_code);
    const rows = await q.execute();
    return reply.code(200).send(rows);
  });

  // Recon run console
  app.get("/internal/recon/runs", async (_request, reply) => {
    const rows = await db.selectFrom("recon_run").selectAll().orderBy("business_date", "desc").limit(50).execute();
    const withBreakCounts = await Promise.all(
      rows.map(async (r) => {
        const breaks = await db.selectFrom("recon_break").select(({ fn }) => fn.countAll().as("c")).where("run_id", "=", r.id).executeTakeFirstOrThrow();
        return { id: r.id, business_date: r.business_date, recon_type: r.recon_type, status: r.status, break_count: Number(breaks.c) };
      }),
    );
    return reply.code(200).send(withBreakCounts);
  });

  // Audit explorer
  app.get("/internal/audit", async (request, reply) => {
    const { entity_type, entity_id, limit } = request.query as { entity_type?: string; entity_id?: string; limit?: string };
    let q = db.selectFrom("audit_log").selectAll().orderBy("occurred_at", "desc").limit(limit ? Number(limit) : 50);
    if (entity_type) q = q.where("entity_type", "=", entity_type);
    if (entity_id) q = q.where("entity_id", "=", entity_id);
    const rows = await q.execute();
    return reply.code(200).send(rows.map((r) => ({ id: Number(r.id), actor_type: r.actor_type, actor_id: r.actor_id, action: r.action, entity_type: r.entity_type, entity_id: r.entity_id, occurred_at: r.occurred_at.toISOString(), before_json: r.before_json, after_json: r.after_json })));
  });

  app.get("/internal/audit/verify-chain", async (_request, reply) => {
    const brokenAt = await verifyAuditChain(db);
    return reply.code(200).send({ intact: brokenAt === null, break: brokenAt });
  });

  return app;
}
