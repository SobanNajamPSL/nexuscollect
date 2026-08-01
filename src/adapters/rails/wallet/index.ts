import type { Kysely } from "kysely";
import type { Database } from "../../../db/schema.js";
import type { Clock } from "../../../platform/clock/index.js";
import { capturePayment, type CapturePaymentResult } from "../../../modules/payment/index.js";

/** §8.9: wallet (EMI balance) payment — same "no channel logic in core"
 * shape as the card adapter, over the WALLET rail. */
export interface WalletCaptureInput {
  psid: string;
  amountMinor: bigint;
  valueDate: string;
  obligationDischargeDate: string;
  walletProvider: string;
  walletMsisdnMasked: string;
  payerId?: string;
}

export async function captureWalletPayment(db: Kysely<Database>, input: WalletCaptureInput, clock: Clock): Promise<CapturePaymentResult> {
  await db
    .insertInto("wallet_account")
    .values({ payer_id: input.payerId ?? null, wallet_provider: input.walletProvider, wallet_msisdn_masked: input.walletMsisdnMasked, created_at: clock.now() })
    .execute();

  return capturePayment(
    db,
    {
      paymentReference: "", channel: "APP", rail: "WALLET", grossAmountMinor: input.amountMinor,
      valueDate: input.valueDate, obligationDischargeDate: input.obligationDischargeDate,
      explicitAllocations: [{ psid: input.psid, amountMinor: input.amountMinor }],
      captureOutcome: "CONFIRMED",
      ...(input.payerId ? { payerId: input.payerId } : {}),
    },
    clock,
  );
}
