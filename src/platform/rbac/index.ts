import type { FastifyReply, FastifyRequest } from "fastify";
import type { Kysely } from "kysely";
import type { Database } from "../../db/schema.js";

/**
 * §3.2's 12 named roles, now backed by real tables (migration 0027) instead
 * of the static enum this build used until Phase 11. This stays a lightweight
 * lookup, not a full identity system — `auth-stub.ts`'s X-Institution-Id
 * check is unchanged for external/Channel API calls; this guards internal
 * `/internal/*` routes only, via an `x-user-id` header identifying one of the
 * seeded `platform_user` rows.
 */
export async function getUserRoles(db: Kysely<Database>, userId: string): Promise<string[]> {
  const rows = await db.selectFrom("user_role").select("role_code").where("user_id", "=", userId).execute();
  return rows.map((r) => r.role_code);
}

export async function userHasAnyRole(db: Kysely<Database>, userId: string, roles: readonly string[]): Promise<boolean> {
  const userRoles = await getUserRoles(db, userId);
  return userRoles.some((r) => roles.includes(r));
}

/**
 * Applied only to brand-new Phase 9+ routes with no pre-existing test
 * coverage (per the non-breaking-enforcement decision made this phase) —
 * never retrofitted onto already-tested routes, to avoid breaking the
 * existing suite's arbitrary randomUUID() maker/checker fixtures.
 */
export function requireRole(db: Kysely<Database>, roles: readonly string[]) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const userId = request.headers["x-user-id"];
    if (!userId || Array.isArray(userId)) {
      reply.code(401).send({
        type: "https://errors.nexuscollect.example/AUTHENTICATION_REQUIRED",
        title: "Missing user identity",
        status: 401,
        code: "AUTHENTICATION_REQUIRED",
        detail: "X-User-Id header is required.",
        retryable: false,
      });
      return;
    }
    const ok = await userHasAnyRole(db, userId, roles);
    if (!ok) {
      reply.code(403).send({
        type: "https://errors.nexuscollect.example/FORBIDDEN",
        title: "Insufficient role",
        status: 403,
        code: "FORBIDDEN",
        detail: `Requires one of: ${roles.join(", ")}.`,
        retryable: false,
      });
    }
  };
}
