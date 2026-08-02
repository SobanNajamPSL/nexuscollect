import { describe, expect, it } from "vitest";
import { splitCashTender } from "../../web/shared/src/money.js";

/**
 * What a cash drawer keeps versus what the payer handed over.
 *
 * The till screen originally captured the *tendered* amount while also telling the
 * teller how much change to return — so a payer handing over a round PKR 3,000 for
 * a PKR 2,480 bill had 3,000 recorded as collected, left 520 sitting as unapplied
 * money nobody had paid, and guaranteed the till came up short at close by exactly
 * the change. Tested here rather than trusted, because it is arithmetic that looks
 * right until you reconcile the drawer.
 */
describe("splitCashTender", () => {
  it("captures the amount owed and returns the change, not the whole tender", () => {
    // PKR 3,000 handed over for a PKR 2,480 bill.
    expect(splitCashTender(300_000, 248_000)).toEqual({ capturedMinor: 248_000, changeMinor: 52_000, shortByMinor: 0 });
  });

  it("captures the exact amount when the payer has exact change", () => {
    expect(splitCashTender(248_000, 248_000)).toEqual({ capturedMinor: 248_000, changeMinor: 0, shortByMinor: 0 });
  });

  it("captures what was actually handed over when it is short — a real partial payment", () => {
    expect(splitCashTender(100_000, 248_000)).toEqual({ capturedMinor: 100_000, changeMinor: 0, shortByMinor: 148_000 });
  });

  it("never returns negative change", () => {
    expect(splitCashTender(1, 248_000).changeMinor).toBe(0);
    expect(splitCashTender(0, 248_000).changeMinor).toBe(0);
  });

  it("conserves every paisa — what was tendered is either captured or returned", () => {
    for (const [tendered, due] of [[300_000, 248_000], [248_000, 248_000], [100_000, 248_000], [1, 1], [999_999, 1]]) {
      const split = splitCashTender(tendered!, due!);
      expect(split.capturedMinor + split.changeMinor).toBe(tendered);
    }
  });
});
