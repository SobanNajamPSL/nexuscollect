import { api } from "./api.js";

/**
 * The demonstration harness stands in for authentication, deliberately and
 * visibly: instead of a login, you *choose* who you are acting as, from the
 * real seeded `platform_user` roster. Nothing here pretends to be a security
 * boundary — but the shape of what it produces (a user id, a tenant, a set of
 * roles) is exactly what a real session would populate, so swapping in real
 * auth later replaces the source of identity without touching its consumers.
 */

export type PortalId = "citizen" | "agency" | "ops" | "field";

export interface Persona {
  id: string;
  name: string;
  agency_code: string | null;
  agency_name: string | null;
  roles: string[];
}

/**
 * Which of the twelve §3.2 roles each portal serves. A persona is only offered
 * in the portal where its role actually works — you navigate between portals,
 * you don't become someone who doesn't belong in the one you're looking at.
 *
 * SERVICE_CHANNEL is absent on purpose: it's a machine identity for the Channel
 * API, and it has no UI.
 */
export const PORTAL_ROLES: Record<PortalId, readonly string[]> = {
  citizen: [], // public and unauthenticated — no persona at all
  agency: ["AGENCY_ADMIN", "AGENCY_OPERATOR"],
  ops: [
    "PLATFORM_ADMIN",
    "OPS_RECON_ANALYST",
    "OPS_RECON_APPROVER",
    "OPS_REFUND_MAKER",
    "OPS_REFUND_APPROVER",
    "SUPPORT_AGENT",
    "AUDITOR",
  ],
  field: ["TELLER", "BRANCH_SUPERVISOR"],
};

export async function fetchPersonas(portal: PortalId): Promise<Persona[]> {
  const allowed = PORTAL_ROLES[portal];
  if (allowed.length === 0) return [];
  const users = await api.get<Persona[]>("/internal/users");
  return users.filter((u) => u.roles.some((r) => allowed.includes(r)));
}

/**
 * Strips the parenthetical role hint the seeded names carry, e.g.
 * "Bilal Farooq (Agency Admin, ETPB)" → "Bilal Farooq". Role and agency are
 * shown separately from real columns, so repeating them in the name is noise.
 */
export function displayName(persona: Persona): string {
  return persona.name.replace(/\s*\(.*\)\s*$/, "");
}

export function roleLabel(roleCode: string): string {
  return roleCode
    .toLowerCase()
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ")
    .replace(/^Ops /, "");
}
