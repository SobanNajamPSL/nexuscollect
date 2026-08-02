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

/**
 * What a cash drawer actually keeps, and what goes back to the payer.
 *
 * The distinction is not pedantry. Tendering PKR 3,000 against a PKR 2,480 bill
 * means the teller hands back PKR 520 and the drawer holds 2,480 — so capturing
 * the *tendered* figure overstates collections by the change, invents an unapplied
 * balance nobody paid, and guarantees the till comes up short at close by exactly
 * that amount.
 *
 * Tendering *less* than is owed is a different thing entirely: that is a genuine
 * partial payment, and the platform must record what was actually handed over
 * rather than what was owed. So the captured amount is the lesser of the two, and
 * change can never be negative.
 */
export interface CashTender {
  /** What the platform should capture as the payment. */
  capturedMinor: number;
  /** Physical change to hand back. Never negative. */
  changeMinor: number;
  /** How much of the bill remains unpaid after this. Never negative. */
  shortByMinor: number;
}

export function splitCashTender(tenderedMinor: number, dueMinor: number): CashTender {
  const capturedMinor = tenderedMinor < dueMinor ? tenderedMinor : dueMinor;
  return {
    capturedMinor,
    changeMinor: tenderedMinor - capturedMinor,
    shortByMinor: dueMinor - capturedMinor,
  };
}
