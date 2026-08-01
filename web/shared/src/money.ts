/**
 * Every amount crossing the wire is an integer count of minor units (paisa).
 * Formatting happens here and only here — no portal ever does its own division,
 * so a decimal can never be introduced by accident in a display path.
 */
export function formatPKR(minor: number): string {
  return (minor / 100).toLocaleString("en-PK", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** With the currency prefix, for standalone figures. */
export function pkr(minor: number): string {
  return `PKR ${formatPKR(minor)}`;
}

/** PKR → integer paisa, for anything a user types. */
export function toMinor(pkrAmount: string | number): number {
  return Math.round(Number(pkrAmount) * 100);
}
