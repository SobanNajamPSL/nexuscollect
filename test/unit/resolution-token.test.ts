import { beforeEach, describe, expect, it } from "vitest";
import { DemoClock } from "../../src/platform/clock/index.js";
import { mintResolutionToken, verifyResolutionToken } from "../../src/platform/resolution-token/index.js";

/**
 * Finding B: mintResolutionToken used the injected Clock but
 * verifyResolutionToken used jose's real wall clock, so a token minted against
 * DemoClock (pinned to 2026-07-30) verified as EXPIRED immediately, since jose's
 * default `Date.now()` is long after that. Fixed by threading the same Clock
 * into verification.
 */
describe("platform/resolution-token: single clock, end to end", () => {
  let clock: DemoClock;

  beforeEach(() => {
    process.env["RESOLUTION_TOKEN_SECRET"] ??= "test-secret-not-for-prod";
    clock = new DemoClock();
  });

  it("a newly minted token is valid", async () => {
    const { token } = await mintResolutionToken({ payables: [{ psid: "P1", amountMinor: "1000" }] }, clock);
    const result = await verifyResolutionToken(token, clock);
    expect(result.valid).toBe(true);
  });

  it("is still valid at 4 minutes 59 seconds", async () => {
    const { token } = await mintResolutionToken({ payables: [{ psid: "P1", amountMinor: "1000" }] }, clock);
    clock.advance(4 * 60 * 1000 + 59 * 1000);
    const result = await verifyResolutionToken(token, clock);
    expect(result.valid).toBe(true);
  });

  it("is expired at exactly 5 minutes", async () => {
    const { token } = await mintResolutionToken({ payables: [{ psid: "P1", amountMinor: "1000" }] }, clock);
    clock.advance(5 * 60 * 1000);
    const result = await verifyResolutionToken(token, clock);
    expect(result).toEqual({ valid: false, reason: "EXPIRED" });
  });

  it("advancing DemoClock controls expiry deterministically — same token, two different verdicts", async () => {
    const { token } = await mintResolutionToken({ payables: [{ psid: "P1", amountMinor: "1000" }] }, clock);
    expect((await verifyResolutionToken(token, clock)).valid).toBe(true);
    clock.advance(10 * 60 * 1000); // well past expiry
    expect((await verifyResolutionToken(token, clock)).valid).toBe(false);
  });

  it("rejects a tampered token", async () => {
    const { token } = await mintResolutionToken({ payables: [{ psid: "P1", amountMinor: "1000" }] }, clock);
    const tampered = token.slice(0, -4) + (token.endsWith("AAAA") ? "BBBB" : "AAAA");
    const result = await verifyResolutionToken(tampered, clock);
    expect(result).toEqual({ valid: false, reason: "INVALID" });
  });

  it("binds the exact PSID and amount set it was minted with", async () => {
    const payables = [
      { psid: "31010900000181526", amountMinor: "1000000" },
      { psid: "41011300000190123", amountMinor: "375000" },
    ];
    const { token } = await mintResolutionToken({ payables }, clock);
    const result = await verifyResolutionToken(token, clock);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.claims.payables).toEqual(payables);
    }
  });
});
