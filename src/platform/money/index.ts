/**
 * CLAUDE.md hard rule #1: money is bigint minor units. No float, double, numeric,
 * or Decimal for money — not in the database, not in TypeScript, not in JSON.
 *
 * A `MinorAmount` is always a non-negative-or-negative integer count of the
 * currency's minor unit (paisa for PKR: 1 PKR = 100 paisa). It is a plain `bigint`
 * at the type level — CLAUDE.md is explicit that TypeScript money is `bigint`,
 * not a wrapper class — these are the only functions allowed to touch its digits.
 */
export type MinorAmount = bigint;

const INTEGER_STRING = /^-?\d+$/;

/**
 * Parses user/API/CSV input into a MinorAmount. Only accepts a bigint already, or
 * a string of digits (optionally signed) — never a JS `number`, since any `number`
 * carrying a real monetary value has already lost precision by the time it exists.
 */
export function parseMinor(input: string | bigint): MinorAmount {
  if (typeof input === "bigint") return input;
  if (typeof input !== "string" || !INTEGER_STRING.test(input)) {
    throw new TypeError(`parseMinor: "${input}" is not an integer string`);
  }
  return BigInt(input);
}

/** Serialises for JSON transport as a decimal string — never a JS number (CLAUDE.md). */
export function serializeMinor(amount: MinorAmount): string {
  return amount.toString();
}

/** Parses a JSON value that should be a MinorAmount: a string, or a JSON integer (not a decimal). */
export function parseJsonMinor(value: unknown): MinorAmount {
  if (typeof value === "string") return parseMinor(value);
  if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      throw new TypeError(`parseJsonMinor: ${value} is not an integer — money must never be a decimal`);
    }
    return BigInt(value);
  }
  throw new TypeError(`parseJsonMinor: ${JSON.stringify(value)} is not a valid minor-unit amount`);
}

/**
 * api/openapi.yaml's `MinorAmount` schema is `type: integer, format: int64` — a JSON
 * number, not a string. CLAUDE.md's own hard rule permits this explicitly: "Serialise
 * as a string **or a JSON number of minor units**; never a decimal." bigint stays the
 * only internal representation; this is only the wire-boundary conversion, and it
 * throws rather than silently truncating if a value would lose precision as a JS
 * number — every real amount in this system is many orders of magnitude below the
 * safe-integer ceiling, so this guard should never actually fire, but it's a real
 * guard, not a hope.
 */
export function toWireMinor(amount: MinorAmount): number {
  if (amount > BigInt(Number.MAX_SAFE_INTEGER) || amount < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new RangeError(
      `toWireMinor: ${amount} exceeds the safe JSON-integer range — this amount cannot be represented as a wire-format integer without precision loss`,
    );
  }
  return Number(amount);
}

/** The wire-boundary inverse of toWireMinor — an alias for parseJsonMinor's number branch, named for symmetry. */
export function fromWireMinor(value: number): MinorAmount {
  return parseJsonMinor(value);
}

export function addMinor(a: MinorAmount, b: MinorAmount): MinorAmount {
  return a + b;
}

export function subMinor(a: MinorAmount, b: MinorAmount): MinorAmount {
  return a - b;
}

export function sumMinor(amounts: readonly MinorAmount[]): MinorAmount {
  return amounts.reduce((total, a) => total + a, 0n);
}

export function isNegative(amount: MinorAmount): boolean {
  return amount < 0n;
}

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * Formats a minor-unit amount as "PKR X,XXX.XX" (or another 3-letter currency code).
 * Every division here is on the *displayed string*, never on the bigint itself, so
 * there is no float in the path from ledger to screen.
 */
export function formatMinor(amount: MinorAmount, currency = "PKR"): string {
  const negative = amount < 0n;
  const abs = negative ? -amount : amount;
  const whole = abs / 100n;
  const fraction = (abs % 100n).toString().padStart(2, "0");
  const sign = negative ? "-" : "";
  return `${currency} ${sign}${groupThousands(whole.toString())}.${fraction}`;
}
