import type { FastifyReply, FastifyRequest } from "fastify";

/**
 * §17.2's real Channel API auth model is mTLS + OAuth2 client-credentials +
 * detached-JWS request signing — substantial infrastructure (certificate
 * issuance, a token issuer, signature verification) that no Phase 1 gate test
 * actually needs. This stub checks the one header (`X-Institution-Id`, §17.3)
 * that identifies the calling institution, which is enough to make every
 * Phase 1 gate test behave correctly (including the CNIC-without-step-up 401,
 * which is enforced separately inside modules/resolution against the request
 * body's `identity_assertion`, since that's a business rule keyed on
 * `key_type`, not a generic request-level auth concern).
 *
 * The full mTLS/OAuth2/JWS stack is deferred to Prompt 7 (§19/§20 hardening).
 */
export function requireInstitutionId(request: FastifyRequest, reply: FastifyReply, done: () => void): void {
  const institutionId = request.headers["x-institution-id"];
  if (!institutionId || Array.isArray(institutionId)) {
    reply.code(401).send({
      type: "https://errors.nexuscollect.example/AUTHENTICATION_REQUIRED",
      title: "Missing institution identity",
      status: 401,
      code: "AUTHENTICATION_REQUIRED",
      detail: "X-Institution-Id header is required.",
      retryable: false,
    });
    return;
  }
  done();
}
