import { describe, expect, it } from "vitest";
import { amountInWordsEnglish, amountInWordsUrdu, toUrduDigits } from "../../web/shared/src/words.js";

/**
 * The amount in words on a receipt (§16.1).
 *
 * Tested rather than eyeballed because this is the line that makes a receipt
 * hard to alter, and because the South Asian grouping (crore / lakh) has an
 * off-by-one-group failure mode that looks perfectly plausible on screen: a
 * lakh rendered as a hundred thousand is legible, wrong, and easy to miss.
 *
 * The anchors are real amounts from the seeded dataset, so a figure that appears
 * on camera is a figure that has been asserted here.
 */
describe("amount in words — English", () => {
  it("renders the real P260000E receipt total", () => {
    // PKR 943,880.00 — the multi-head internet-banking payment.
    expect(amountInWordsEnglish(94_388_000)).toBe("Rupees Nine Lakh Forty-Three Thousand Eight Hundred Eighty Only");
  });

  it("renders the vehicle-token anchor", () => {
    expect(amountInWordsEnglish(1_000_000)).toBe("Rupees Ten Thousand Only");
  });

  it("renders the e-challan anchor with its discount applied", () => {
    // PKR 3,750.00 — the moving violation after the 1,250.00 early discount.
    expect(amountInWordsEnglish(375_000)).toBe("Rupees Three Thousand Seven Hundred Fifty Only");
  });

  it("spells paisa only when there are any", () => {
    expect(amountInWordsEnglish(750)).toBe("Rupees Seven and Fifty Paisa Only");
    expect(amountInWordsEnglish(700)).toBe("Rupees Seven Only");
  });

  it("groups by crore and lakh, not by million", () => {
    expect(amountInWordsEnglish(2_761_016_500)).toBe(
      "Rupees Two Crore Seventy-Six Lakh Ten Thousand One Hundred Sixty-Five Only",
    );
  });

  it("handles zero and a negative", () => {
    expect(amountInWordsEnglish(0)).toBe("Rupees Zero Only");
    expect(amountInWordsEnglish(-1_000_000)).toBe("Minus Rupees Ten Thousand Only");
  });
});

describe("amount in words — Urdu", () => {
  it("renders the real P260000E receipt total", () => {
    expect(amountInWordsUrdu(94_388_000)).toBe("نو لاکھ تینتالیس ہزار آٹھ سو اسی روپے صرف");
  });

  it("renders the vehicle-token anchor", () => {
    expect(amountInWordsUrdu(1_000_000)).toBe("دس ہزار روپے صرف");
  });

  it("spells paisa only when there are any", () => {
    expect(amountInWordsUrdu(750)).toBe("سات روپے اور پچاس پیسے صرف");
    expect(amountInWordsUrdu(700)).toBe("سات روپے صرف");
  });

  it("has a distinct word for every number below one hundred", () => {
    // Urdu builds no tens-plus-ones compound, so a missing or duplicated entry
    // in the table is a silent wrong-number bug rather than a crash.
    const words = new Set<string>();
    for (let n = 0; n < 100; n += 1) words.add(amountInWordsUrdu(n * 100).split(" روپے")[0]!);
    expect(words.size).toBe(100);
  });
});

describe("Urdu-Indic digits", () => {
  it("converts a formatted figure without touching separators", () => {
    expect(toUrduDigits("943,880.00")).toBe("۹۴۳,۸۸۰.۰۰");
  });

  it("converts a business date", () => {
    expect(toUrduDigits("2026-07-30")).toBe("۲۰۲۶-۰۷-۳۰");
  });
});
