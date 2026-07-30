export { dammCheckDigit, dammEncode, dammValidate } from "./damm.js";
export { luhnCheckDigit, luhnEncode, luhnValidate } from "./luhn.js";
export { mod9710Remainder, mod9710Validate, mod9710CheckDigits } from "./mod9710.js";
export { rfEncode, rfValidate } from "./rf.js";

import { dammValidate } from "./damm.js";
import { luhnValidate } from "./luhn.js";
import { mod9710Validate } from "./mod9710.js";

/** §7.4 `reference_scheme.checksum_algo` dispatch. */
export type ChecksumAlgo = "DAMM" | "LUHN" | "MOD_97_10" | "MOD_11" | "NONE";

export function validateByAlgo(algo: ChecksumAlgo, value: string): boolean {
  switch (algo) {
    case "DAMM":
      return dammValidate(value);
    case "LUHN":
      return luhnValidate(value);
    case "MOD_97_10":
      return mod9710Validate(value);
    case "MOD_11":
      return mod11Validate(value);
    case "NONE":
      return true;
  }
}

/**
 * MOD 11 (§7.3): older utility consumer-number check digit, not otherwise used by
 * demo-data's schemes but named in reference_scheme.checksum_algo, so it must exist.
 * Standard weighted mod-11 with weights 2..7 cycling from the rightmost digit
 * (the check digit itself), remainder 10 conventionally maps to check digit 0.
 */
export function mod11CheckDigit(digits: string): number {
  if (!/^\d+$/.test(digits)) throw new TypeError(`mod11CheckDigit: "${digits}" must contain only digits`);
  let sum = 0;
  let weight = 2;
  for (let i = digits.length - 1; i >= 0; i--) {
    sum += Number(digits[i]) * weight;
    weight = weight === 7 ? 2 : weight + 1;
  }
  const remainder = sum % 11;
  const check = 11 - remainder;
  return check >= 10 ? 0 : check;
}

export function mod11Validate(digitsWithCheck: string): boolean {
  if (!/^\d+$/.test(digitsWithCheck)) return false;
  const body = digitsWithCheck.slice(0, -1);
  const check = Number(digitsWithCheck.at(-1));
  return mod11CheckDigit(body) === check;
}
