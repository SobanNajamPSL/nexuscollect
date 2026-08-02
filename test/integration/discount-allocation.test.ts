import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDb, type TestDb } from "./helpers.js";
import { loadDemoData } from "../../src/loader/index.js";
import { buildApp } from "../../src/api/build-app.js";
import { DemoClock } from "../../src/platform/clock/index.js";
import { capToPayableBalance, type OpenLine } from "../../src/modules/allocation/index.js";
import type { FastifyInstance } from "fastify";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEMO_DATA_DIR = join(__dirname, "..", "..", "demo-data");
const INSTITUTION = "00000000-0000-4000-8000-0000000000d1";
const DATE = "2026-07-30";

/** The live early-payment discount anchor: PKR 5,000 fine, PKR 1,250 discount. */
const DISCOUNTED_PSID = "41011300000190123";
const OTHER_PSCA_PSID = "41011400000286611";
const ETPB_PSID = "31010900000181526";

function line(over: Partial<OpenLine> & { lineItemId: string; balanceMinor: bigint }): OpenLine {
  return { assessmentId: "a", lineType: "PRINCIPAL", taxPeriod: null, allocationPriority: 50, ...over };
}

/**
 * The gap between the line items and the payable.
 *
 * §6.4 keeps them deliberately separate — the lines sum to *assessed*, and the
 * payable is assessed minus the discount — so allocating against line balances
 * over-credits by exactly the discount. Unit-tested here because the arithmetic
 * is where the bug lived, then proven end to end below.
 */
describe("capToPayableBalance (§6.4)", () => {
  it("leaves lines untouched when nothing is discounted", () => {
    const lines = [line({ lineItemId: "l1", balanceMinor: 500_00n }), line({ lineItemId: "l2", balanceMinor: 300_00n })];
    expect(capToPayableBalance(lines, 800_00n).map((l) => l.balanceMinor)).toEqual([500_00n, 300_00n]);
  });

  it("relieves the principal, because that is what the discount is a percentage of (§15.4)", () => {
    const lines = [
      line({ lineItemId: "penalty", lineType: "PENALTY", allocationPriority: 10, balanceMinor: 200_00n }),
      line({ lineItemId: "principal", lineType: "PRINCIPAL", allocationPriority: 50, balanceMinor: 500_00n }),
    ];
    const capped = capToPayableBalance(lines, 575_00n); // a 125.00 discount
    expect(capped.find((l) => l.lineItemId === "principal")!.balanceMinor).toBe(375_00n);
    expect(capped.find((l) => l.lineItemId === "penalty")!.balanceMinor).toBe(200_00n);
  });

  it("spills into the remaining lines in priority order once the principal is exhausted", () => {
    const lines = [
      line({ lineItemId: "fee", lineType: "FEE", allocationPriority: 20, balanceMinor: 100_00n }),
      line({ lineItemId: "penalty", lineType: "PENALTY", allocationPriority: 10, balanceMinor: 100_00n }),
      line({ lineItemId: "principal", lineType: "PRINCIPAL", allocationPriority: 50, balanceMinor: 100_00n }),
    ];
    const capped = capToPayableBalance(lines, 150_00n); // a 150.00 discount
    // Principal wiped out entirely, then the lowest-priority remaining line.
    expect(capped.find((l) => l.lineItemId === "principal")).toBeUndefined();
    expect(capped.find((l) => l.lineItemId === "penalty")!.balanceMinor).toBe(50_00n);
    expect(capped.find((l) => l.lineItemId === "fee")!.balanceMinor).toBe(100_00n);
  });

  it("never invents or loses a paisa", () => {
    const lines = [
      line({ lineItemId: "a", balanceMinor: 333_33n }),
      line({ lineItemId: "b", lineType: "SURCHARGE", allocationPriority: 30, balanceMinor: 333_33n }),
      line({ lineItemId: "c", lineType: "PENALTY", allocationPriority: 10, balanceMinor: 333_34n }),
    ];
    const capped = capToPayableBalance(lines, 700_00n);
    expect(capped.reduce((s, l) => s + l.balanceMinor, 0n)).toBe(700_00n);
  });
});

describe("Paying a discounted bill through the live pipeline", () => {
  let testDb: TestDb;
  let app: FastifyInstance;
  const clock = new DemoClock();

  beforeAll(async () => {
    testDb = await startTestDb();
    await loadDemoData(testDb.db, DEMO_DATA_DIR, clock);
    app = await buildApp({ db: testDb.db, clock, demoDataDir: DEMO_DATA_DIR });
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await testDb.stop();
  });

  async function resolveToken(): Promise<{ token: string; quoted: Record<string, number> }> {
    const res = await app.inject({
      method: "POST",
      url: "/v1/resolve",
      headers: { "x-institution-id": INSTITUTION },
      payload: { key_type: "VEHICLE_REG", key_value: "LEA-17-1000", channel: "APP" },
    });
    const body = res.json() as { resolution_token: string; payables: { psid: string; payable_amount_minor: number }[] };
    return {
      token: body.resolution_token,
      quoted: Object.fromEntries(body.payables.map((p) => [p.psid, p.payable_amount_minor])),
    };
  }

  async function pay(token: string, psids: string[]): Promise<{ reference: string; unapplied: number }> {
    const intent = await app.inject({
      method: "POST",
      url: "/v1/payment-intents",
      headers: { "x-institution-id": INSTITUTION, "idempotency-key": `k-${psids.join("-")}` },
      payload: { resolution_token: token, channel: "APP", psids },
    });
    const { intent_reference, total_debit_minor } = intent.json() as { intent_reference: string; total_debit_minor: number };
    const payment = await app.inject({
      method: "POST",
      url: "/v1/payments",
      headers: { "x-institution-id": INSTITUTION, "idempotency-key": `p-${psids.join("-")}` },
      payload: {
        intent_reference,
        channel: "APP",
        rail: "RAAST",
        gross_amount_minor: total_debit_minor,
        value_date: DATE,
        obligation_discharge_date: DATE,
        capture_outcome: "CONFIRMED",
      },
    });
    const body = payment.json() as { payment_reference: string; unapplied_amount_minor: number };
    return { reference: body.payment_reference, unapplied: body.unapplied_amount_minor };
  }

  it("applies the discounted amount, not the assessed one — and settles the bill exactly", async () => {
    const { token, quoted } = await resolveToken();
    // The quote itself already reflects the discount: 5,000.00 − 1,250.00.
    expect(quoted[DISCOUNTED_PSID]).toBe(375_000);

    const { unapplied } = await pay(token, [DISCOUNTED_PSID, OTHER_PSCA_PSID]);

    // Nothing left over. Before the cap, the discounted bill swallowed its full
    // 5,000.00 principal and starved the other bill of 1,250.00.
    expect(unapplied).toBe(0);

    const assessment = await testDb.db
      .selectFrom("assessment")
      .select(["payable_amount_minor", "allocated_amount_minor", "balance_minor", "status"])
      .where("psid", "=", DISCOUNTED_PSID)
      .where("status", "!=", "AMENDED")
      .executeTakeFirstOrThrow();
    expect(assessment.allocated_amount_minor).toBe(375_000n);
    expect(assessment.balance_minor).toBe(0n);
    expect(assessment.status).toBe("SETTLED");

    const other = await testDb.db
      .selectFrom("assessment")
      .select(["balance_minor", "status"])
      .where("psid", "=", OTHER_PSCA_PSID)
      .where("status", "!=", "AMENDED")
      .executeTakeFirstOrThrow();
    expect(other.balance_minor).toBe(0n);
    expect(other.status).toBe("SETTLED");
  });

  it("never drives a balance negative, which §6.4 forbids outright", async () => {
    const negative = await testDb.db.selectFrom("assessment").select("psid").where("balance_minor", "<", 0n).execute();
    expect(negative).toEqual([]);
  });

  it("keeps the books tied after a discounted payment", async () => {
    for (const check of ["trial-balance", "allocation-integrity", "balance-rebuild", "ledger-vs-subledger"]) {
      const res = await app.inject({ method: "GET", url: `/internal/control/${check}?date=${DATE}` });
      const body = res.json() as { balanced?: boolean; passed?: boolean };
      expect(body.balanced ?? body.passed, check).toBe(true);
    }
  });

  it("gives one payment and one receipt per agency, because a payment is swept to one treasury account", async () => {
    const { token } = await resolveToken();
    const { reference } = await pay(token, [ETPB_PSID]);

    const payment = await testDb.db
      .selectFrom("payment")
      .innerJoin("agency", "agency.id", "payment.agency_id")
      .select(["payment.id", "agency.code"])
      .where("payment.payment_reference", "=", reference)
      .executeTakeFirstOrThrow();
    expect(payment.code).toBe("ETPB");

    const receipt = await testDb.db
      .selectFrom("receipt")
      .innerJoin("agency", "agency.id", "receipt.agency_id")
      .select("agency.code")
      .where("receipt.payment_id", "=", payment.id)
      .executeTakeFirstOrThrow();
    // The receipt names the agency that actually received the money — it cannot
    // name one agency while carrying another's revenue.
    expect(receipt.code).toBe("ETPB");
  });

  it("refuses a PSID that the resolution token never quoted", async () => {
    const { token } = await resolveToken();
    const res = await app.inject({
      method: "POST",
      url: "/v1/payment-intents",
      headers: { "x-institution-id": INSTITUTION, "idempotency-key": "k-not-quoted" },
      payload: { resolution_token: token, channel: "APP", psids: ["12010100001359715"] },
    });
    expect(res.statusCode).toBe(401);
  });

  it("head-wise lines on the signed receipt sum to the amount paid", async () => {
    const receipt = await testDb.db
      .selectFrom("receipt")
      .innerJoin("payment", "payment.id", "receipt.payment_id")
      .select(["receipt.receipt_no", "payment.gross_amount_minor"])
      .where("payment.value_date", "=", DATE)
      .where("payment.channel", "=", "APP")
      .orderBy("receipt.receipt_no", "asc")
      .executeTakeFirstOrThrow();

    const signed = await app.inject({ method: "GET", url: `/v1/receipts/${receipt.receipt_no}/signed` });
    const payload = JSON.parse((signed.json() as { canonical_payload: string }).canonical_payload) as {
      head_wise: { amount_minor: string }[];
      gross_amount_minor: string;
    };
    const headTotal = payload.head_wise.reduce((s, h) => s + BigInt(h.amount_minor), 0n);
    // A receipt whose parts do not sum to its total is the first thing an auditor
    // rejects. This was false before the cap: the head lines came to less than
    // the money taken, because the rest sat unapplied.
    expect(headTotal).toBe(BigInt(payload.gross_amount_minor));
    expect(headTotal).toBe(receipt.gross_amount_minor);
  });
});
