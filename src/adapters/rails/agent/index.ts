import type { Kysely } from "kysely";
import type { Database } from "../../../db/schema.js";
import type { Clock } from "../../../platform/clock/index.js";
import { capturePayment, type CapturePaymentResult } from "../../../modules/payment/index.js";

/**
 * §8.7: agent / branchless banking. "An agent is not a branch, and modelling
 * it as one is how platforms lose money" — an agent collects cash from a
 * citizen against a float pre-funded with the operator, and that float (not
 * the citizen's payment) is what actually needs reconciling day to day. This
 * adapter, like card/wallet, is the only place that knows "agent" is
 * special — `modules/payment` itself has no channel conditional for it.
 */
export interface AgentCaptureInput {
  agentCode: string;
  agentName?: string;
  psid: string;
  amountMinor: bigint;
  valueDate: string;
  obligationDischargeDate: string;
  payerId?: string;
}

async function getOrCreateAgentFloatAccount(db: Kysely<Database>, agentCode: string, agentName?: string): Promise<string> {
  const existing = await db.selectFrom("agent_float_account").select("id").where("agent_code", "=", agentCode).executeTakeFirst();
  if (existing) return existing.id;
  const inserted = await db.insertInto("agent_float_account").values({ agent_code: agentCode, agent_name: agentName ?? agentCode }).returning("id").executeTakeFirstOrThrow();
  return inserted.id;
}

/**
 * The citizen's payment goes through the exact same `capturePayment` pipeline
 * every other channel uses — the float bookkeeping is a *parallel* record of
 * what the agent now owes the operator, not a substitute for it.
 */
export async function captureAgentPayment(db: Kysely<Database>, input: AgentCaptureInput, clock: Clock): Promise<CapturePaymentResult> {
  const floatAccountId = await getOrCreateAgentFloatAccount(db, input.agentCode, input.agentName);

  const result = await capturePayment(
    db,
    {
      paymentReference: "", channel: "AGENT", rail: "CASH", grossAmountMinor: input.amountMinor,
      valueDate: input.valueDate, obligationDischargeDate: input.obligationDischargeDate,
      explicitAllocations: [{ psid: input.psid, amountMinor: input.amountMinor }],
      captureOutcome: "CONFIRMED",
      ...(input.payerId ? { payerId: input.payerId } : {}),
    },
    clock,
  );

  await db
    .insertInto("agent_float_movement")
    .values({ agent_float_account_id: floatAccountId, payment_id: result.paymentId, movement_type: "COLLECTION", amount_minor: input.amountMinor, business_date: input.valueDate })
    .execute();

  return result;
}

export async function remitAgentFloat(db: Kysely<Database>, agentCode: string, amountMinor: bigint, businessDate: string): Promise<void> {
  const floatAccountId = await getOrCreateAgentFloatAccount(db, agentCode);
  await db.insertInto("agent_float_movement").values({ agent_float_account_id: floatAccountId, payment_id: null, movement_type: "REMITTANCE", amount_minor: amountMinor, business_date: businessDate }).execute();
}

export interface AgentFloatPosition {
  agentCode: string;
  collectedMinor: bigint;
  remittedMinor: bigint;
  outstandingMinor: bigint;
}

/**
 * §8.7's own daily reconciliation: the float's outstanding position (what
 * the agent has collected but not yet remitted) is always derived — Σ
 * collections − Σ remittances — never a cached running balance, matching
 * the "balances are derived" rule everywhere else in this platform.
 */
export async function getAgentFloatPosition(db: Kysely<Database>, agentCode: string): Promise<AgentFloatPosition> {
  const account = await db.selectFrom("agent_float_account").select("id").where("agent_code", "=", agentCode).executeTakeFirst();
  if (!account) return { agentCode, collectedMinor: 0n, remittedMinor: 0n, outstandingMinor: 0n };

  const rows = await db.selectFrom("agent_float_movement").select(["movement_type", "amount_minor"]).where("agent_float_account_id", "=", account.id).execute();
  const collectedMinor = rows.filter((r) => r.movement_type === "COLLECTION").reduce((s, r) => s + r.amount_minor, 0n);
  const remittedMinor = rows.filter((r) => r.movement_type === "REMITTANCE").reduce((s, r) => s + r.amount_minor, 0n);
  return { agentCode, collectedMinor, remittedMinor, outstandingMinor: collectedMinor - remittedMinor };
}
