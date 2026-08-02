import type { Kysely } from "kysely";
import type { Database } from "../../db/schema.js";
import type { Clock } from "../../platform/clock/index.js";
import { appendAuditEntry } from "../../platform/audit/index.js";
import { appendOutboxEvent } from "../../platform/outbox/index.js";
import { capturePayment } from "../payment/index.js";

/**
 * Lodging a physical instrument at a counter.
 *
 * The dishonour cascade was built first, deliberately scoped to start from "the
 * instrument is already linked to a settled payment" — the seeded cheques come
 * from `demo-data/instruments.csv`, so nothing ever needed to create one. That
 * left `modules/instrument` exporting only `returnInstrument`, and a teller with
 * no way to accept a cheque across the counter.
 *
 * Everything this needs already existed: `capturePayment` accepts an
 * `instrumentId` and a `CHEQUE_CLEARING` rail, `instrument_link` is a real
 * table, and `returnInstrument` finds what to reverse via
 * `payment.instrument_id`. So lodging is composition, not new machinery — the
 * one thing it must get right is setting `instrument_id` on the payment, because
 * that is the only thread the cascade follows later.
 *
 * The money is **provisional**, and building this exposed a latent defect worth
 * recording: `capturePayment` hardcoded `finality: 'FINAL'` on confirmation. The
 * sweep correctly refuses anything non-FINAL, but nothing ever *set* PROVISIONAL,
 * so §13.4's `PROVISIONAL_FUNDS_NOT_SWEEPABLE` held only for the seeded dataset
 * (whose one provisional cheque comes straight from `payments.csv`). A cheque
 * lodged through the live pipeline would have produced final, sweepable money —
 * precisely the failure the rule exists to prevent. `capturePayment` now takes
 * `finality`, and lodgement always passes PROVISIONAL.
 */

export interface LodgeInstrumentInput {
  instrumentType: "CHEQUE" | "POST_DATED_CHEQUE" | "PAY_ORDER" | "DEMAND_DRAFT";
  instrumentNumber: string;
  amountMinor: bigint;
  draweeBankName?: string;
  drawerName?: string;
  drawerAccountMasked?: string;
  instrumentDate?: string;
  /** Bills this instrument is tendered against, in order. */
  allocations: readonly { psid: string; amountMinor: bigint }[];
  lodgedAtBranch?: string;
  lodgedByUser: string;
  valueDate: string;
}

export interface LodgeInstrumentResult {
  instrumentId: string;
  paymentId: string;
  paymentStatus: string;
  /** True when the credit is provisional and therefore not yet sweepable. */
  provisional: boolean;
  creditPolicy: string;
}

export class InstrumentAmountMismatchError extends Error {
  readonly httpStatus = 422;
  readonly code = "INSTRUMENT_AMOUNT_MISMATCH";
  constructor(amountMinor: bigint, allocatedMinor: bigint) {
    super(
      `The instrument is for ${amountMinor} but ${allocatedMinor} has been tendered against bills — an instrument must be fully allocated when it is lodged.`,
    );
    this.name = "InstrumentAmountMismatchError";
  }
}

export class InstrumentAlreadyLodgedError extends Error {
  readonly httpStatus = 409;
  readonly code = "INSTRUMENT_ALREADY_LODGED";
  constructor(instrumentNumber: string) {
    super(`Instrument ${instrumentNumber} has already been lodged — lodging it twice would double-credit the payer.`);
    this.name = "InstrumentAlreadyLodgedError";
  }
}

export async function lodgeInstrument(
  db: Kysely<Database>,
  input: LodgeInstrumentInput,
  clock: Clock,
): Promise<LodgeInstrumentResult> {
  const allocatedMinor = input.allocations.reduce((s, a) => s + a.amountMinor, 0n);
  if (allocatedMinor !== input.amountMinor) {
    throw new InstrumentAmountMismatchError(input.amountMinor, allocatedMinor);
  }

  const duplicate = await db
    .selectFrom("instrument")
    .select("id")
    .where("instrument_number", "=", input.instrumentNumber)
    .executeTakeFirst();
  if (duplicate) throw new InstrumentAlreadyLodgedError(input.instrumentNumber);

  // The bills being paid decide the agency and the credit policy — a cheque is
  // tendered against an obligation, not into a void.
  const first = await db
    .selectFrom("assessment")
    .innerJoin("collection_product", "collection_product.id", "assessment.product_id")
    .select([
      "assessment.id as assessment_id",
      "assessment.agency_id",
      "collection_product.instrument_credit_policy",
    ])
    .where("assessment.psid", "=", input.allocations[0]!.psid)
    .orderBy("assessment.version", "desc")
    .executeTakeFirstOrThrow();

  // Under every one of the three credit policies the money is provisional at
  // lodgement — that is what an instrument *is*. What the policies actually
  // differ on is service gating and whether allocation waits for clearing, and
  // this build models the first but not the second: allocation happens at
  // lodgement regardless. Disclosed rather than implied.
  const creditPolicy = first.instrument_credit_policy;
  const provisional = true;

  const instrument = await db
    .insertInto("instrument")
    .values({
      instrument_type: input.instrumentType,
      instrument_number: input.instrumentNumber,
      amount_minor: input.amountMinor,
      agency_id: first.agency_id,
      drawee_bank_name: input.draweeBankName ?? null,
      drawer_name: input.drawerName ?? null,
      drawer_account_masked: input.drawerAccountMasked ?? null,
      instrument_date: input.instrumentDate ?? input.valueDate,
      lodged_at_branch: input.lodgedAtBranch ?? null,
      lodged_by_user: input.lodgedByUser,
      instrument_credit_policy: creditPolicy,
      // A post-dated cheque is deliberately held rather than presented.
      status: input.instrumentType === "POST_DATED_CHEQUE" ? "HELD_POST_DATED" : "IN_CLEARING",
      lodged_on: input.valueDate,
      created_at: clock.now(),
      updated_at: clock.now(),
    })
    .returning("id")
    .executeTakeFirstOrThrow();

  for (const allocation of input.allocations) {
    const assessment = await db
      .selectFrom("assessment")
      .select("id")
      .where("psid", "=", allocation.psid)
      .orderBy("version", "desc")
      .executeTakeFirstOrThrow();
    await db
      .insertInto("instrument_link")
      .values({ instrument_id: instrument.id, assessment_id: assessment.id, amount_minor: allocation.amountMinor })
      .execute();
  }

  // The payment carries `instrumentId` — the only thread the dishonour cascade
  // follows to find what to unwind if the bank returns this instrument.
  const capture = await capturePayment(
    db,
    {
      paymentReference: "",
      channel: "CHEQUE",
      rail: "CHEQUE_CLEARING",
      grossAmountMinor: input.amountMinor,
      valueDate: input.valueDate,
      obligationDischargeDate: input.valueDate,
      explicitAllocations: input.allocations.map((a) => ({ psid: a.psid, amountMinor: a.amountMinor })),
      captureOutcome: "CONFIRMED",
      // Not final until the bank clears it, so it can never be swept.
      finality: "PROVISIONAL",
      instrumentId: instrument.id,
      ...(input.drawerAccountMasked ? { payerAccountMasked: input.drawerAccountMasked } : {}),
    },
    clock,
  );

  await db.transaction().execute(async (trx) => {
    await appendAuditEntry(
      trx,
      {
        actorType: "USER",
        actorId: input.lodgedByUser,
        action: "instrument.lodged",
        entityType: "instrument",
        entityId: instrument.id,
        afterJson: {
          instrumentNumber: input.instrumentNumber,
          amountMinor: input.amountMinor.toString(),
          creditPolicy,
          provisional,
          paymentId: capture.paymentId,
        },
      },
      clock,
    );
    await appendOutboxEvent(
      trx,
      {
        aggregateType: "instrument",
        aggregateId: instrument.id,
        sequence: 1,
        eventType: "instrument.lodged",
        payload: { instrumentNumber: input.instrumentNumber, paymentId: capture.paymentId },
      },
      clock,
    );
  });

  return {
    instrumentId: instrument.id,
    paymentId: capture.paymentId,
    paymentStatus: capture.status,
    provisional,
    creditPolicy,
  };
}
