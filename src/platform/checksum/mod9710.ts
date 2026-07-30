/**
 * ISO 7064 MOD 97-10 (§7.3/§7.4): used by IBAN and, wrapped by rf.ts, ISO 11649 RF
 * creditor references. Also a selectable `reference_scheme.checksum_algo` in its
 * own right for schemes that use it directly.
 */

/** A-Z -> 10-35, digits pass through unchanged, per ISO 7064/13616. */
function letterToDigits(ch: string): string {
  const code = ch.toUpperCase().charCodeAt(0);
  if (code >= 65 && code <= 90) return String(code - 55);
  if (ch >= "0" && ch <= "9") return ch;
  throw new TypeError(`mod9710: "${ch}" is not alphanumeric`);
}

function toNumericString(alphanumeric: string): string {
  let out = "";
  for (const ch of alphanumeric) out += letterToDigits(ch);
  return out;
}

/** Iterative mod-97, digit by digit, so this works for numbers far beyond 2^53. */
function mod97OfDigits(numericString: string): number {
  let remainder = 0;
  for (const ch of numericString) {
    remainder = (remainder * 10 + Number(ch)) % 97;
  }
  return remainder;
}

/** Remainder of an alphanumeric string (letters mapped A=10..Z=35) mod 97. */
export function mod9710Remainder(alphanumeric: string): number {
  return mod97OfDigits(toNumericString(alphanumeric));
}

/** ISO 7064 MOD 97-10 validity: remainder must be exactly 1. */
export function mod9710Validate(alphanumeric: string): boolean {
  return mod9710Remainder(alphanumeric) === 1;
}

/** The two check digits (98 - remainder, zero-padded) for a reference not yet carrying them. */
export function mod9710CheckDigits(referenceBody: string): string {
  const remainder = mod9710Remainder(`${referenceBody}00`);
  return String(98 - remainder).padStart(2, "0");
}
