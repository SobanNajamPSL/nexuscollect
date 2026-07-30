import { crc16CcittFalse } from "./qr-decode.js";

/**
 * The encode half of §8.5's EMVCo QR (decode already existed from finding C —
 * "one quick sweep" scope cut adds just the inverse). Field layout reverse-
 * engineered from the real `demo-data/qr-payloads.json` fixtures themselves
 * (tag 26 merchant account info, 52 category code, 53 currency, 58 country,
 * 59 merchant name, 60 city, 62 additional data with PSID/external-ref/branch
 * sub-tags) — verified to reproduce those fixtures byte-for-byte
 * (test/integration/qr-encode.test.ts), not merely round-trip semantically.
 */
export interface EncodeQrPayloadInput {
  /** Tag 26 sub-tag 02 — this platform's own short agency/product code. */
  merchantAccountCode: string;
  amountMinor?: bigint | null;
  merchantName: string;
  psid?: string | null;
  externalRef?: string | null;
  branchRef?: string;
}

function tlv(tag: string, value: string): string {
  return `${tag}${String(value.length).padStart(2, "0")}${value}`;
}

function toDecimalString(amountMinor: bigint): string {
  const negative = amountMinor < 0n;
  const abs = negative ? -amountMinor : amountMinor;
  const whole = abs / 100n;
  const fraction = (abs % 100n).toString().padStart(2, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

export function encodeQrPayload(input: EncodeQrPayloadInput): string {
  const merchantAccountInfo = tlv("00", "PK.RAAST") + tlv("01", "NEXUSCOLLECT") + tlv("02", input.merchantAccountCode);

  const additionalDataParts: string[] = [];
  if (input.psid) additionalDataParts.push(tlv("01", input.psid));
  if (input.externalRef) additionalDataParts.push(tlv("05", input.externalRef));
  additionalDataParts.push(tlv("07", input.branchRef ?? "AGENCY-CTR-01"));

  const fields = [
    tlv("00", "01"),
    tlv("01", input.psid ? "12" : "11"),
    tlv("26", merchantAccountInfo),
    tlv("52", "9311"),
    tlv("53", "586"),
    ...(input.amountMinor != null ? [tlv("54", toDecimalString(input.amountMinor))] : []),
    tlv("58", "PK"),
    tlv("59", input.merchantName),
    tlv("60", "LAHORE"),
    tlv("62", additionalDataParts.join("")),
  ].join("");

  const bodyForCrc = `${fields}6304`;
  return `${bodyForCrc}${crc16CcittFalse(bodyForCrc)}`;
}
