/**
 * Damm algorithm (§7.3): the platform's default PSID check digit. Chosen over Luhn
 * because this quasigroup is "totally anti-symmetric," which guarantees it catches
 * every single-digit substitution AND every adjacent-digit transposition — Luhn
 * misses some transpositions (e.g. 09 <-> 90). That distinction is asserted by
 * Phase 0's own acceptance test (10,000 random PSIDs, every substitution/transposition
 * caught) so the table below must be the standard totally anti-symmetric one, not an
 * arbitrary 10x10 grid.
 */
const DAMM_TABLE: readonly (readonly number[])[] = [
  [0, 3, 1, 7, 5, 9, 8, 6, 4, 2],
  [7, 0, 9, 2, 1, 5, 4, 8, 6, 3],
  [4, 2, 0, 6, 8, 7, 1, 3, 5, 9],
  [1, 7, 5, 0, 9, 8, 3, 4, 2, 6],
  [6, 1, 2, 3, 0, 4, 5, 9, 7, 8],
  [3, 6, 7, 4, 2, 0, 9, 5, 8, 1],
  [5, 8, 6, 9, 7, 2, 0, 1, 3, 4],
  [8, 9, 4, 5, 3, 6, 2, 0, 1, 7],
  [9, 4, 3, 8, 6, 1, 7, 2, 0, 5],
  [2, 5, 8, 1, 4, 3, 6, 7, 9, 0],
];

function requireDigits(digits: string, fnName: string): void {
  if (!/^\d+$/.test(digits)) {
    throw new TypeError(`${fnName}: "${digits}" must contain only digits`);
  }
}

/** Computes the Damm check digit for a digit string (without its check digit). */
export function dammCheckDigit(digits: string): number {
  requireDigits(digits, "dammCheckDigit");
  let interim = 0;
  for (const ch of digits) {
    const row = DAMM_TABLE[interim];
    if (!row) throw new Error("dammCheckDigit: invalid interim state");
    interim = row[Number(ch)] as number;
  }
  return interim;
}

/** Appends the Damm check digit to a digit string. */
export function dammEncode(digits: string): string {
  return `${digits}${dammCheckDigit(digits)}`;
}

/** Validates a digit string whose last digit is a Damm check digit. */
export function dammValidate(digitsWithCheck: string): boolean {
  requireDigits(digitsWithCheck, "dammValidate");
  let interim = 0;
  for (const ch of digitsWithCheck) {
    const row = DAMM_TABLE[interim];
    if (!row) return false;
    interim = row[Number(ch)] as number;
  }
  return interim === 0;
}
