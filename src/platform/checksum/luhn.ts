/** Luhn algorithm (§7.3): used for card-like/legacy government reference schemes. */
function requireDigits(digits: string, fnName: string): void {
  if (!/^\d+$/.test(digits)) {
    throw new TypeError(`${fnName}: "${digits}" must contain only digits`);
  }
}

function luhnSum(digits: string, doubleFromRight: boolean): number {
  let sum = 0;
  let shouldDouble = doubleFromRight;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (shouldDouble) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    shouldDouble = !shouldDouble;
  }
  return sum;
}

/** Computes the Luhn check digit for a digit string (without its check digit). */
export function luhnCheckDigit(digits: string): number {
  requireDigits(digits, "luhnCheckDigit");
  const sum = luhnSum(digits, true);
  return (10 - (sum % 10)) % 10;
}

/** Appends the Luhn check digit to a digit string. */
export function luhnEncode(digits: string): string {
  return `${digits}${luhnCheckDigit(digits)}`;
}

/** Validates a digit string whose last digit is a Luhn check digit. */
export function luhnValidate(digitsWithCheck: string): boolean {
  requireDigits(digitsWithCheck, "luhnValidate");
  return luhnSum(digitsWithCheck, false) % 10 === 0;
}
