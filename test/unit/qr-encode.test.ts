import { describe, expect, it } from "vitest";
import { encodeQrPayload } from "../../src/modules/resolution/qr-encode.js";
import { decodeQrPayload, QrDecodeError } from "../../src/modules/resolution/qr-decode.js";

/**
 * §8.5's QR encode, proven against the same real
 * `demo-data/qr-payloads.json` fixtures decode was already verified against
 * — reproducing them byte-for-byte, not just semantically round-tripping.
 */
describe("EMVCo QR encode (§8.5)", () => {
  it("reproduces the real dynamic_with_amount fixture byte-for-byte", () => {
    const expected = "00020101021226340008PK.RAAST0112NEXUSCOLLECT02024152049311530358654073750.005802PK5923PUNJAB SAFE CITIES AUTH6006LAHORE62530117410113000001901230511CHL-07791230713AGENCY-CTR-016304866B";
    const encoded = encodeQrPayload({ merchantAccountCode: "41", amountMinor: 375_000n, merchantName: "PUNJAB SAFE CITIES AUTH", psid: "41011300000190123", externalRef: "CHL-0779123" });
    expect(encoded).toBe(expected);
  });

  it("reproduces the real dynamic_open_amount fixture byte-for-byte (no tag 54)", () => {
    const expected = "00020101021226340008PK.RAAST0112NEXUSCOLLECT0202715204931153035865802PK5923BOARD OF REVENUE PUNJAB6006LAHORE62380117710118000001836270713AGENCY-CTR-01630408A7";
    const encoded = encodeQrPayload({ merchantAccountCode: "71", amountMinor: null, merchantName: "BOARD OF REVENUE PUNJAB", psid: "71011800000183627" });
    expect(encoded).toBe(expected);
  });

  it("reproduces the real static_counter fixture byte-for-byte (no bill number)", () => {
    const expected = "00020101021126340008PK.RAAST0112NEXUSCOLLECT0202005204931153035865802PK5917LAHORE HIGH COURT6006LAHORE62170713AGENCY-CTR-016304D2BF";
    const encoded = encodeQrPayload({ merchantAccountCode: "00", amountMinor: null, merchantName: "LAHORE HIGH COURT", psid: null });
    expect(encoded).toBe(expected);
  });

  it("round-trips through decode for all 3 valid fixtures", () => {
    const cases = [
      { merchantAccountCode: "41", amountMinor: 375_000n, merchantName: "PUNJAB SAFE CITIES AUTH", psid: "41011300000190123", externalRef: "CHL-0779123" },
      { merchantAccountCode: "71", amountMinor: null, merchantName: "BOARD OF REVENUE PUNJAB", psid: "71011800000183627" },
      { merchantAccountCode: "00", amountMinor: null, merchantName: "LAHORE HIGH COURT", psid: null },
    ];
    for (const c of cases) {
      const encoded = encodeQrPayload(c);
      const decoded = decodeQrPayload(encoded); // throws QrDecodeError if the CRC we just computed doesn't validate
      expect(decoded.psid).toBe(c.psid ?? null);
      expect(decoded.amountMinor).toBe(c.amountMinor ?? null);
      expect(decoded.merchantName).toBe(c.merchantName);
    }
  });

  it("a tampered encoded payload is rejected the same way the corrupted fixture is", () => {
    const encoded = encodeQrPayload({ merchantAccountCode: "41", amountMinor: 375_000n, merchantName: "PUNJAB SAFE CITIES AUTH", psid: "41011300000190123", externalRef: "CHL-0779123" });
    const tampered = encoded.slice(0, -1) + (encoded.at(-1) === "0" ? "1" : "0");
    expect(() => decodeQrPayload(tampered)).toThrow(QrDecodeError);
  });
});
