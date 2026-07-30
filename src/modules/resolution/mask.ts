/**
 * §7.5: certain key types (VEHICLE_REG, CASE_NO, APPLICATION_NO) get a masked
 * payer name rather than full detail. The spec's own openapi.yaml example
 * ("M****** A***d K***" for "Muhammad Ahmed Khan") isn't internally
 * consistent letter-for-letter (Ahmed keeps its last letter, Khan doesn't),
 * so it reads as illustrative rather than a precise algorithm to reverse
 * engineer. This is a simple, consistent rule: first letter of each word,
 * then asterisks for the rest.
 */
export function maskPayerName(name: string): string {
  return name
    .split(" ")
    .map((word) => (word.length <= 1 ? word : word[0] + "*".repeat(word.length - 1)))
    .join(" ");
}
