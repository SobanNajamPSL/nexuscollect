import type { Kysely } from "kysely";
import type { Database } from "../../../db/schema.js";
import type { Clock } from "../../../platform/clock/index.js";
import { capturePayment, type CapturePaymentResult } from "../../../modules/payment/index.js";

/**
 * §8.9: card/wallet payment. "The platform MUST NOT touch a PAN" — this
 * adapter only ever stores a gateway token + BIN6 + last4 (`card_token`),
 * never the card number itself, and calls straight into the same
 * `capturePayment` pipeline every other rail uses. No channel conditional
 * exists in `modules/payment` for this — the adapter is the only place that
 * knows "card" is special.
 */
export interface CardCaptureInput {
  psid: string;
  amountMinor: bigint;
  valueDate: string;
  obligationDischargeDate: string;
  gatewayToken: string;
  bin6: string;
  last4: string;
  scheme: "PAYPAK" | "VISA" | "MASTERCARD" | "UNIONPAY";
  payerId?: string;
}

export async function captureCardPayment(db: Kysely<Database>, input: CardCaptureInput, clock: Clock): Promise<CapturePaymentResult> {
  await db
    .insertInto("card_token")
    .values({ payer_id: input.payerId ?? null, gateway_token: input.gatewayToken, bin6: input.bin6, last4: input.last4, scheme: input.scheme })
    .execute();

  return capturePayment(
    db,
    {
      paymentReference: "", channel: "APP", rail: "CARD_SCHEME", grossAmountMinor: input.amountMinor,
      valueDate: input.valueDate, obligationDischargeDate: input.obligationDischargeDate,
      explicitAllocations: [{ psid: input.psid, amountMinor: input.amountMinor }],
      captureOutcome: "CONFIRMED",
      ...(input.payerId ? { payerId: input.payerId } : {}),
    },
    clock,
  );
}
