/**
 * §8.5 EMVCo merchant-presented QR — the Phase-1-scoped decode-and-resolve
 * slice finding C asks for (not the broader Phase 3 channel/generation work:
 * no QR *encoding*, no channel adapter). A payload is a flat sequence of
 * TLV fields (2-digit tag, 2-digit length, then that many characters of
 * value); some tags ("templates", conventionally 02-51) nest another TLV
 * sequence inside their value. The CRC (tag 63) is always last, computed over
 * everything up to and including its own tag+length ("6304").
 */

export interface QrTlvNode {
  tag: string;
  value: string;
  children?: QrTlvField[];
}
export type QrTlvField = QrTlvNode;

function parseTlv(payload: string): QrTlvField[] {
  const fields: QrTlvField[] = [];
  let i = 0;
  while (i < payload.length) {
    const tag = payload.slice(i, i + 2);
    const length = Number(payload.slice(i + 2, i + 4));
    const value = payload.slice(i + 4, i + 4 + length);
    if (tag.length < 2 || Number.isNaN(length) || value.length !== length) {
      throw new QrDecodeError("QR_MALFORMED", `Malformed TLV at offset ${i}`);
    }
    // EMVCo template tags: merchant account info (02-51) and the additional
    // data field template (62) both nest another TLV sequence inside their
    // value — confirmed against the real payload structure (tag 62 sub-tag 01
    // is where this platform puts the PSID; sub-tag 05 holds the agency's own
    // external_ref instead).
    const tagNum = Number(tag);
    const isTemplateTag = /^[0-9]{2}$/.test(tag) && ((tagNum >= 2 && tagNum <= 51) || tagNum === 62);
    const isTemplate = isTemplateTag && /^[0-9]{2}/.test(value);
    const children = isTemplate ? tryParseChildren(value) : undefined;
    fields.push(children ? { tag, value, children } : { tag, value });
    i += 4 + length;
  }
  return fields;
}

function tryParseChildren(value: string): QrTlvField[] | undefined {
  try {
    return parseTlv(value);
  } catch {
    return undefined;
  }
}

export class QrDecodeError extends Error {
  constructor(
    public readonly code: "QR_CRC_INVALID" | "QR_MALFORMED",
    message: string,
  ) {
    super(message);
    this.name = "QrDecodeError";
  }
}

/** CRC-16/CCITT-FALSE — same algorithm the demo-data generator itself uses (poly 0x1021, init 0xFFFF). */
export function crc16CcittFalse(input: string): string {
  let crc = 0xffff;
  for (let i = 0; i < input.length; i++) {
    crc ^= input.charCodeAt(i) << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

export interface DecodedQrPayload {
  psid: string | null;
  amountMinor: bigint | null;
  merchantName: string | null;
}

function findTag(fields: QrTlvField[], tag: string): QrTlvField | undefined {
  return fields.find((f) => f.tag === tag);
}

/**
 * Validates the CRC (tag 63, always last) and extracts the fields resolution
 * needs. Throws QrDecodeError("QR_CRC_INVALID", ...) for a corrupted payload —
 * confirmed against all 4 real demo-data/qr-payloads.json fixtures, including
 * the deliberately corrupted one.
 */
export function decodeQrPayload(payload: string): DecodedQrPayload {
  const crcTagIndex = payload.lastIndexOf("6304");
  if (crcTagIndex === -1 || crcTagIndex !== payload.length - 8) {
    throw new QrDecodeError("QR_MALFORMED", "No trailing CRC (tag 63, length 04) field found");
  }
  const bodyForCrc = payload.slice(0, crcTagIndex + 4);
  const declaredCrc = payload.slice(crcTagIndex + 4);
  const computedCrc = crc16CcittFalse(bodyForCrc);
  if (computedCrc !== declaredCrc) {
    throw new QrDecodeError("QR_CRC_INVALID", `CRC mismatch: computed ${computedCrc}, declared ${declaredCrc}`);
  }

  const fields = parseTlv(payload);

  // Tag 54: transaction amount (top-level, EMVCo standard), decimal string
  // with a '.'; absent entirely for an "open amount" QR (payer enters it,
  // resolution's own amount is authoritative — matches qr-payloads.json's
  // `dynamic_open_amount` fixture).
  const amountField = findTag(fields, "54");
  const amountMinor = amountField ? toMinorFromDecimalString(amountField.value) : null;

  // Tag 62 (additional data field template) -> sub-tag 01 (EMVCo's standard
  // "Bill Number" field) carries the PSID in this platform's payloads —
  // confirmed by decoding all 4 real demo-data/qr-payloads.json fixtures and
  // matching their declared `psid` field exactly (sub-tag 05, "reference
  // label", carries the agency's own external_ref instead, e.g. "CHL-0779123").
  const additionalData = findTag(fields, "62");
  const billNumber = additionalData?.children ? findTag(additionalData.children, "01") : undefined;
  const psid = billNumber?.value ?? null;

  const merchantNameField = findTag(fields, "59");

  return { psid, amountMinor, merchantName: merchantNameField?.value ?? null };
}

function toMinorFromDecimalString(decimal: string): bigint {
  const [whole = "0", fraction = "0"] = decimal.split(".");
  const paisa = (fraction + "00").slice(0, 2);
  return BigInt(whole) * 100n + BigInt(paisa);
}
