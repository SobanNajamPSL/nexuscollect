import { SignJWT, jwtVerify, errors as joseErrors } from "jose";
import type { Clock } from "../clock/index.js";

/**
 * §8.2: "`resolution_token` is a short-lived (5 min) signed JWT binding the
 * resolved amount to the payable set. The subsequent quote/capture call MUST
 * present it." Closes a real attack (resolve at X, wait for surcharge to
 * accrue, pay the stale X) and doubles as an audit record of exactly what the
 * payer was shown.
 *
 * The spec says "signed JWT" but doesn't specify an algorithm or claim shape —
 * not an [A]/[V] marker, just silent. HS256 with a server-side secret is the
 * simplest choice that satisfies "signed, 5-minute, binds amounts"; there's no
 * cross-service verification requirement in Phase 1 that would need an
 * asymmetric key.
 */
const ALGORITHM = "HS256";
const EXPIRY_SECONDS = 5 * 60;

function getSecret(): Uint8Array {
  const secret = process.env["RESOLUTION_TOKEN_SECRET"];
  if (!secret) {
    throw new Error("RESOLUTION_TOKEN_SECRET is not set");
  }
  return new TextEncoder().encode(secret);
}

export interface ResolutionTokenPayable {
  psid: string;
  amountMinor: string; // bigint serialised as a decimal string (CLAUDE.md: money is never a JSON number-with-decimals; a plain integer string is safest across JWT libraries too)
}

export interface ResolutionTokenClaims {
  payables: ResolutionTokenPayable[];
}

export async function mintResolutionToken(
  claims: ResolutionTokenClaims,
  clock: Clock,
): Promise<{ token: string; expiresAt: Date }> {
  const issuedAt = clock.now();
  const expiresAt = new Date(issuedAt.getTime() + EXPIRY_SECONDS * 1000);
  const token = await new SignJWT({ payables: claims.payables })
    .setProtectedHeader({ alg: ALGORITHM })
    .setIssuedAt(Math.floor(issuedAt.getTime() / 1000))
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(getSecret());
  return { token, expiresAt };
}

export type ResolutionTokenVerification =
  | { valid: true; claims: ResolutionTokenClaims }
  | { valid: false; reason: "EXPIRED" | "INVALID" };

/**
 * Used by Phase 2's intent/capture to reject a tampered or stale token.
 *
 * Takes the injected Clock — jose's `jwtVerify` checks `exp`/`iat` against real
 * wall-clock time by default, which is exactly the two-clocks bug this fixes: a
 * token minted against `DemoClock` (pinned to 2026-07-30) would otherwise verify
 * as already-expired the instant it's checked against the real system clock, since
 * 2026-07-30 is in the past relative to whenever this code actually runs. Passing
 * `currentDate` makes verification agree with whatever minted the token.
 */
export async function verifyResolutionToken(token: string, clock: Clock): Promise<ResolutionTokenVerification> {
  try {
    const { payload } = await jwtVerify(token, getSecret(), { algorithms: [ALGORITHM], currentDate: clock.now() });
    return { valid: true, claims: { payables: payload["payables"] as ResolutionTokenPayable[] } };
  } catch (err) {
    if (err instanceof joseErrors.JWTExpired) return { valid: false, reason: "EXPIRED" };
    return { valid: false, reason: "INVALID" };
  }
}
