import { describe, expect, it } from "vitest";
import { dammCheckDigit, dammEncode, dammValidate } from "../../src/platform/checksum/damm.js";
import { luhnEncode, luhnValidate } from "../../src/platform/checksum/luhn.js";
import { mod9710Validate, mod9710CheckDigits } from "../../src/platform/checksum/mod9710.js";
import { rfEncode, rfValidate } from "../../src/platform/checksum/rf.js";

function randomDigits(length: number): string {
  let s = "";
  for (let i = 0; i < length; i++) s += Math.floor(Math.random() * 10).toString();
  return s;
}

describe("Damm checksum (§7.3, PSID default)", () => {
  it("encodes and validates round-trip", () => {
    const body = "1201010000019512";
    const withCheck = dammEncode(body);
    expect(withCheck).toBe(body + dammCheckDigit(body));
    expect(dammValidate(withCheck)).toBe(true);
  });

  // PROMPTS.md Prompt 0, acceptance test 1: "Damm catches every single-digit
  // substitution AND every adjacent transposition across 10,000 random PSIDs."
  it("catches every single-digit substitution across 10,000 random 17-digit PSIDs", () => {
    for (let n = 0; n < 10_000; n++) {
      const valid = dammEncode(randomDigits(16));
      for (let pos = 0; pos < valid.length; pos++) {
        const original = valid[pos] as string;
        for (let digit = 0; digit < 10; digit++) {
          if (String(digit) === original) continue; // not a substitution
          const mutated = valid.slice(0, pos) + digit + valid.slice(pos + 1);
          expect(dammValidate(mutated), `substitution at pos ${pos} of ${valid} -> ${mutated}`).toBe(false);
        }
      }
    }
  });

  it("catches every adjacent-digit transposition across 10,000 random 17-digit PSIDs", () => {
    for (let n = 0; n < 10_000; n++) {
      const valid = dammEncode(randomDigits(16));
      for (let pos = 0; pos < valid.length - 1; pos++) {
        const a = valid[pos] as string;
        const b = valid[pos + 1] as string;
        if (a === b) continue; // transposing equal digits isn't an error
        const mutated = valid.slice(0, pos) + b + a + valid.slice(pos + 2);
        expect(dammValidate(mutated), `transposition at pos ${pos} of ${valid} -> ${mutated}`).toBe(false);
      }
    }
  });
});

describe("Luhn checksum (§7.3, legacy schemes)", () => {
  it("encodes and validates round-trip", () => {
    const withCheck = luhnEncode("7992739871");
    expect(luhnValidate(withCheck)).toBe(true);
  });

  it("rejects a corrupted digit", () => {
    const withCheck = luhnEncode("7992739871");
    const corrupted = "9" + withCheck.slice(1);
    expect(luhnValidate(corrupted)).toBe(false);
  });
});

describe("ISO 7064 MOD 97-10", () => {
  it("validates a known-good IBAN-style remainder", () => {
    // GB82 WEST 1234 5698 7654 32, rearranged & letter-substituted per ISO 13616 —
    // a standard textbook example, remainder must be 1.
    const rearranged = "WEST12345698765432GB82"
      .split("")
      .map((ch) => (/[A-Z]/.test(ch) ? String(ch.charCodeAt(0) - 55) : ch))
      .join("");
    expect(mod9710Validate(rearranged)).toBe(true);
  });

  it("check digits round-trip through validation", () => {
    const body = "PSID12010100001359715";
    const checkDigits = mod9710CheckDigits(body);
    expect(mod9710Validate(`${body}${checkDigits}`)).toBe(true);
  });
});

describe("ISO 11649 RF creditor reference (§7.3, the RF-wrapped PSID)", () => {
  it("encodes and validates round-trip for a real demo PSID", () => {
    const psid = "12010100001359715";
    const rf = rfEncode(psid);
    expect(rf.startsWith("RF")).toBe(true);
    expect(rfValidate(rf)).toBe(true);
  });

  it("matches the demo pack's own RF reference for a known PSID", () => {
    // demo-data/assessments.csv AS-00013: psid 12010100001359715, rf_reference
    // RF7712010100001359715 — confirms our encoder agrees with the generator's.
    expect(rfEncode("12010100001359715")).toBe("RF7712010100001359715");
  });

  it("rejects a corrupted RF reference", () => {
    const rf = rfEncode("12010100001359715");
    const corrupted = rf.slice(0, -1) + (rf.endsWith("9") ? "8" : "9");
    expect(rfValidate(corrupted)).toBe(false);
  });
});
