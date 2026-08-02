/**
 * An amount in words, in English and Urdu.
 *
 * §16.1 requires a receipt to carry the amount "in figures **and words**". This
 * is not decoration — the words are what makes a receipt hard to alter after the
 * fact, and it is the line an auditor reads when the figure looks wrong.
 *
 * Both languages use the South Asian numbering system (crore, lakh, thousand,
 * hundred), because that is how the amount is spoken and written on a Pakistani
 * government receipt — not the international million/billion grouping.
 *
 * Scope note, disclosed rather than implied: the Urdu rendering covers the
 * numerals and the receipt's own chrome. Revenue head names are *not* translated
 * — they are the official chart-of-accounts descriptions the agency itself
 * publishes, and inventing Urdu equivalents for them would be fabricating
 * reference data. They stay verbatim in both language modes.
 */

const EN_ONES = [
  "Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine",
  "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen",
];
const EN_TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

/**
 * Urdu has an irregular word for every number below one hundred — there is no
 * tens-plus-ones construction to fall back on, so the full hundred are listed.
 */
const UR_BELOW_100 = [
  "صفر", "ایک", "دو", "تین", "چار", "پانچ", "چھ", "سات", "آٹھ", "نو",
  "دس", "گیارہ", "بارہ", "تیرہ", "چودہ", "پندرہ", "سولہ", "سترہ", "اٹھارہ", "انیس",
  "بیس", "اکیس", "بائیس", "تئیس", "چوبیس", "پچیس", "چھبیس", "ستائیس", "اٹھائیس", "انتیس",
  "تیس", "اکتیس", "بتیس", "تینتیس", "چونتیس", "پینتیس", "چھتیس", "سینتیس", "اڑتیس", "انتالیس",
  "چالیس", "اکتالیس", "بیالیس", "تینتالیس", "چوالیس", "پینتالیس", "چھیالیس", "سینتالیس", "اڑتالیس", "انچاس",
  "پچاس", "اکاون", "باون", "ترپن", "چون", "پچپن", "چھپن", "ستاون", "اٹھاون", "انسٹھ",
  "ساٹھ", "اکسٹھ", "باسٹھ", "ترسٹھ", "چوسٹھ", "پینسٹھ", "چھیاسٹھ", "سڑسٹھ", "اڑسٹھ", "انہتر",
  "ستر", "اکہتر", "بہتر", "تہتر", "چوہتر", "پچھتر", "چھہتر", "ستہتر", "اٹھہتر", "اناسی",
  "اسی", "اکیاسی", "بیاسی", "تراسی", "چوراسی", "پچاسی", "چھیاسی", "ستاسی", "اٹھاسی", "نواسی",
  "نوے", "اکانوے", "بانوے", "ترانوے", "چورانوے", "پچانوے", "چھیانوے", "ستانوے", "اٹھانوے", "ننانوے",
];

function enBelow100(n: number): string {
  if (n < 20) return EN_ONES[n]!;
  const tens = EN_TENS[Math.floor(n / 10)]!;
  const ones = n % 10;
  return ones === 0 ? tens : `${tens}-${EN_ONES[ones]}`;
}

/** The South Asian grouping, shared by both languages: crore, lakh, thousand, hundred. */
function groups(whole: number): { crore: number; lakh: number; thousand: number; hundred: number; rest: number } {
  return {
    crore: Math.floor(whole / 10_000_000),
    lakh: Math.floor((whole % 10_000_000) / 100_000),
    thousand: Math.floor((whole % 100_000) / 1_000),
    hundred: Math.floor((whole % 1_000) / 100),
    rest: whole % 100,
  };
}

function englishWhole(whole: number): string {
  if (whole === 0) return "Zero";
  const g = groups(whole);
  const parts: string[] = [];
  if (g.crore) parts.push(`${enBelow100(g.crore)} Crore`);
  if (g.lakh) parts.push(`${enBelow100(g.lakh)} Lakh`);
  if (g.thousand) parts.push(`${enBelow100(g.thousand)} Thousand`);
  if (g.hundred) parts.push(`${EN_ONES[g.hundred]} Hundred`);
  if (g.rest) parts.push(enBelow100(g.rest));
  return parts.join(" ");
}

function urduWhole(whole: number): string {
  if (whole === 0) return UR_BELOW_100[0]!;
  const g = groups(whole);
  const parts: string[] = [];
  if (g.crore) parts.push(`${UR_BELOW_100[g.crore]} کروڑ`);
  if (g.lakh) parts.push(`${UR_BELOW_100[g.lakh]} لاکھ`);
  if (g.thousand) parts.push(`${UR_BELOW_100[g.thousand]} ہزار`);
  if (g.hundred) parts.push(`${UR_BELOW_100[g.hundred]} سو`);
  if (g.rest) parts.push(UR_BELOW_100[g.rest]!);
  return parts.join(" ");
}

/**
 * `minor` is an integer count of paisa, as every amount on the wire is. Paisa
 * are spelled out only when non-zero, matching how a receipt actually reads.
 */
export function amountInWordsEnglish(minor: number): string {
  const whole = Math.floor(Math.abs(minor) / 100);
  const paisa = Math.abs(minor) % 100;
  const sign = minor < 0 ? "Minus " : "";
  const rupees = `${sign}Rupees ${englishWhole(whole)}`;
  return paisa === 0 ? `${rupees} Only` : `${rupees} and ${enBelow100(paisa)} Paisa Only`;
}

export function amountInWordsUrdu(minor: number): string {
  const whole = Math.floor(Math.abs(minor) / 100);
  const paisa = Math.abs(minor) % 100;
  const sign = minor < 0 ? "منفی " : "";
  const rupees = `${sign}${urduWhole(whole)} روپے`;
  return paisa === 0 ? `${rupees} صرف` : `${rupees} اور ${UR_BELOW_100[paisa]} پیسے صرف`;
}

/** Urdu-Indic digits, for the figure itself when the receipt is read in Urdu. */
export function toUrduDigits(text: string): string {
  const map: Record<string, string> = { "0": "۰", "1": "۱", "2": "۲", "3": "۳", "4": "۴", "5": "۵", "6": "۶", "7": "۷", "8": "۸", "9": "۹" };
  return text.replace(/[0-9]/g, (d) => map[d]!);
}
