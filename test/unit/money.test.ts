import { describe, expect, it } from "vitest";
import { parseMinor, parseJsonMinor, serializeMinor, formatMinor, addMinor, subMinor, sumMinor } from "../../src/platform/money/index.js";

describe("platform/money", () => {
  it("parses integer strings as bigint, never as a JS number", () => {
    expect(parseMinor("94388000")).toBe(94388000n);
    expect(parseMinor("-500")).toBe(-500n);
  });

  it("rejects non-integer input (CLAUDE.md: no float for money, ever)", () => {
    expect(() => parseMinor("100.50")).toThrow();
    expect(() => parseMinor("abc")).toThrow();
    expect(() => parseJsonMinor(100.5)).toThrow();
  });

  it("accepts a JSON integer or a JSON string, never a decimal", () => {
    expect(parseJsonMinor(94388000)).toBe(94388000n);
    expect(parseJsonMinor("94388000")).toBe(94388000n);
  });

  it("serializes as a decimal string, never a JS number", () => {
    expect(serializeMinor(94388000n)).toBe("94388000");
    expect(typeof serializeMinor(94388000n)).toBe("string");
  });

  it("formats minor units as PKR with two decimals and thousands grouping", () => {
    expect(formatMinor(94388000n)).toBe("PKR 943,880.00");
    expect(formatMinor(750n)).toBe("PKR 7.50");
    expect(formatMinor(0n)).toBe("PKR 0.00");
    expect(formatMinor(-50000n)).toBe("PKR -500.00");
  });

  it("arithmetic stays in bigint the whole way through", () => {
    expect(addMinor(100n, 200n)).toBe(300n);
    expect(subMinor(300n, 100n)).toBe(200n);
    expect(sumMinor([92000000n, 1288000n, 1100000n])).toBe(94388000n);
  });
});
