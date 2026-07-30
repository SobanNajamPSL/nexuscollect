import { mod9710Remainder } from "./mod9710.js";

/**
 * ISO 11649 Creditor Reference ("RF reference," §7.3): `RF` + 2 MOD-97-10 check
 * digits + up to 21 alphanumeric characters. Two independent check layers stack
 * here — RF's own MOD-97-10 over the whole string, plus (when the body is a PSID)
 * Damm inside it — which is why the spec calls this "the single highest-leverage
 * change" for auto-match rate.
 */
const RF_PATTERN = /^RF\d{2}[0-9A-Z]{1,21}$/;

export function rfEncode(referenceBody: string): string {
  if (!/^[0-9A-Za-z]{1,21}$/.test(referenceBody)) {
    throw new TypeError(`rfEncode: "${referenceBody}" must be 1-21 alphanumeric characters`);
  }
  // Mirrors rfValidate's rearrangement: the full reference is eventually
  // `body + "RF" + checkDigits`, so the remainder used to derive those check
  // digits must be computed over `body + "RF00"` (the literal characters R, F,
  // and a "00" placeholder), not just `body + "00"`.
  const remainder = mod9710Remainder(`${referenceBody.toUpperCase()}RF00`);
  const checkDigits = String(98 - remainder).padStart(2, "0");
  return `RF${checkDigits}${referenceBody.toUpperCase()}`;
}

export function rfValidate(reference: string): boolean {
  const normalized = reference.replace(/\s+/g, "").toUpperCase();
  if (!RF_PATTERN.test(normalized)) return false;
  const rearranged = normalized.slice(4) + normalized.slice(0, 4);
  return mod9710Remainder(rearranged) === 1;
}
