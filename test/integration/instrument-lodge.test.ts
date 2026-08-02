import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDb, type TestDb } from "./helpers.js";
import { loadDemoData } from "../../src/loader/index.js";
import { buildApp } from "../../src/api/build-app.js";
import { DemoClock } from "../../src/platform/clock/index.js";
import { lodgeInstrument, InstrumentAmountMismatchError, InstrumentAlreadyLodgedError } from "../../src/modules/instrument/lodge.js";
import { runSweep } from "../../src/modules/settlement/index.js";
import type { FastifyInstance } from "fastify";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEMO_DATA_DIR = join(__dirname, "..", "..", "demo-data");
const TELLER = "00000000-0000-4000-9000-000000000007"; // Nadia Aslam
const SUPERVISOR = "00000000-0000-4000-9000-000000000008"; // Kamran Butt
const DATE = "2026-07-30";

/**
 * Instrument lodgement. The dishonour cascade was built first and started from
 * "the instrument already exists", because every seeded cheque comes from the
 * CSV loader — so nothing could actually accept one at a counter.
 */
describe("Instrument lodgement (§8.8)", () => {
  let testDb: TestDb;
  let app: FastifyInstance;
  const clock = new DemoClock();
  let openPsid: string;
  let openBalanceMinor: bigint;
  let n = 0;

  beforeAll(async () => {
    testDb = await startTestDb();
    await loadDemoData(testDb.db, DEMO_DATA_DIR, clock);
    app = await buildApp({ db: testDb.db, clock, demoDataDir: DEMO_DATA_DIR });

    const row = await testDb.db
      .selectFrom("assessment")
      .select(["psid", "balance_minor"])
      .where("status", "=", "OVERDUE")
      .where("balance_minor", ">", 0n)
      .orderBy("psid", "asc")
      .executeTakeFirstOrThrow();
    openPsid = row.psid;
    openBalanceMinor = row.balance_minor;
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await testDb.stop();
  });

  /** A distinct cheque number per call — lodging the same one twice is refused. */
  const chequeNo = () => `TEST${String(++n).padStart(4, "0")}`;

  it("creates the instrument, links it to the bill, and captures a payment that carries the instrument id", async () => {
    const number = chequeNo();
    const result = await lodgeInstrument(
      testDb.db,
      {
        instrumentType: "CHEQUE",
        instrumentNumber: number,
        amountMinor: openBalanceMinor,
        drawerName: "Rukhsana Bibi",
        allocations: [{ psid: openPsid, amountMinor: openBalanceMinor }],
        lodgedByUser: TELLER,
        valueDate: DATE,
      },
      clock,
    );

    const instrument = await testDb.db.selectFrom("instrument").selectAll().where("id", "=", result.instrumentId).executeTakeFirstOrThrow();
    expect(instrument.instrument_number).toBe(number);
    expect(instrument.status).toBe("IN_CLEARING");
    expect(instrument.lodged_by_user).toBe(TELLER);

    const links = await testDb.db.selectFrom("instrument_link").selectAll().where("instrument_id", "=", result.instrumentId).execute();
    expect(links).toHaveLength(1);

    // The cascade follows `payment.instrument_id` and nothing else, so this is
    // the one link that must exist.
    const payment = await testDb.db.selectFrom("payment").selectAll().where("id", "=", result.paymentId).executeTakeFirstOrThrow();
    expect(payment.instrument_id).toBe(result.instrumentId);
    expect(payment.rail).toBe("CHEQUE_CLEARING");
  });

  it("captures the money as PROVISIONAL, so it can never be swept to treasury", async () => {
    const result = await lodgeInstrument(
      testDb.db,
      {
        instrumentType: "CHEQUE",
        instrumentNumber: chequeNo(),
        amountMinor: 250_00n,
        allocations: [{ psid: openPsid, amountMinor: 250_00n }],
        lodgedByUser: TELLER,
        valueDate: DATE,
      },
      clock,
    );
    expect(result.provisional).toBe(true);

    const payment = await testDb.db.selectFrom("payment").select("finality").where("id", "=", result.paymentId).executeTakeFirstOrThrow();
    expect(payment.finality).toBe("PROVISIONAL");

    // §13.4 PROVISIONAL_FUNDS_NOT_SWEEPABLE, proven rather than asserted: sweep
    // the agency and confirm this payment isn't among what moved.
    const agency = await testDb.db
      .selectFrom("assessment")
      .innerJoin("agency", "agency.id", "assessment.agency_id")
      .select("agency.code")
      .where("assessment.psid", "=", openPsid)
      .executeTakeFirstOrThrow();
    await runSweep(testDb.db, agency.code, DATE, clock);

    const swept = await testDb.db
      .selectFrom("payment_allocation")
      .select("swept_in_payment_id")
      .where("payment_id", "=", result.paymentId)
      .execute();
    expect(swept.every((a) => a.swept_in_payment_id === null)).toBe(true);
  });

  it("refuses an instrument that isn't fully allocated to bills", async () => {
    await expect(
      lodgeInstrument(
        testDb.db,
        {
          instrumentType: "CHEQUE",
          instrumentNumber: chequeNo(),
          amountMinor: 500_00n,
          allocations: [{ psid: openPsid, amountMinor: 300_00n }],
          lodgedByUser: TELLER,
          valueDate: DATE,
        },
        clock,
      ),
    ).rejects.toBeInstanceOf(InstrumentAmountMismatchError);
  });

  it("refuses to lodge the same cheque number twice, which would double-credit the payer", async () => {
    const number = chequeNo();
    const input = {
      instrumentType: "CHEQUE" as const,
      instrumentNumber: number,
      amountMinor: 100_00n,
      allocations: [{ psid: openPsid, amountMinor: 100_00n }],
      lodgedByUser: TELLER,
      valueDate: DATE,
    };
    await lodgeInstrument(testDb.db, input, clock);
    await expect(lodgeInstrument(testDb.db, input, clock)).rejects.toBeInstanceOf(InstrumentAlreadyLodgedError);
  });

  it("holds a post-dated cheque rather than presenting it", async () => {
    const result = await lodgeInstrument(
      testDb.db,
      {
        instrumentType: "POST_DATED_CHEQUE",
        instrumentNumber: chequeNo(),
        amountMinor: 100_00n,
        allocations: [{ psid: openPsid, amountMinor: 100_00n }],
        lodgedByUser: TELLER,
        valueDate: DATE,
      },
      clock,
    );
    const instrument = await testDb.db.selectFrom("instrument").select("status").where("id", "=", result.instrumentId).executeTakeFirstOrThrow();
    expect(instrument.status).toBe("HELD_POST_DATED");
  });

  it("is a teller's act — a branch supervisor cannot accept a payment (§3.2)", async () => {
    const body = {
      instrument_type: "CHEQUE",
      instrument_number: chequeNo(),
      amount_minor: 100_00,
      allocations: [{ psid: openPsid, amount_minor: 100_00 }],
      value_date: DATE,
    };
    const refused = await app.inject({ method: "POST", url: "/internal/instruments", headers: { "x-user-id": SUPERVISOR }, payload: body });
    expect(refused.statusCode).toBe(403);

    const allowed = await app.inject({ method: "POST", url: "/internal/instruments", headers: { "x-user-id": TELLER }, payload: body });
    expect(allowed.statusCode).toBe(201);
    expect(allowed.json().provisional).toBe(true);
  });

  it("a lodged cheque that is returned drives the full dishonour cascade", async () => {
    const lodged = await lodgeInstrument(
      testDb.db,
      {
        instrumentType: "CHEQUE",
        instrumentNumber: chequeNo(),
        amountMinor: openBalanceMinor,
        allocations: [{ psid: openPsid, amountMinor: openBalanceMinor }],
        lodgedByUser: TELLER,
        valueDate: DATE,
      },
      clock,
    );

    const returned = await app.inject({
      method: "POST",
      url: `/internal/instruments/${lodged.instrumentId}/return`,
      payload: { reason_code: "INSUFFICIENT_FUNDS" },
    });
    expect(returned.statusCode).toBe(200);
    // The cascade found the payment purely via `payment.instrument_id`, which is
    // what lodgement had to set correctly.
    expect(returned.json().reversed_payment_ids).toContain(lodged.paymentId);

    const payment = await testDb.db.selectFrom("payment").select("status").where("id", "=", lodged.paymentId).executeTakeFirstOrThrow();
    expect(payment.status).toBe("REVERSED");
  });
});

/**
 * Till close. This posted a *string* into `journal_entry.source_id`, a UUID
 * column, so closing a till whose drawer did not balance exactly returned a 500 —
 * and only an exact balance skipped the posting, which is why nothing caught it.
 */
describe("Till close (§8.5)", () => {
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

  async function close(countedMinor: number) {
    return app.inject({ method: "POST", url: "/internal/till/close", payload: { business_date: DATE, counted_amount_minor: countedMinor } });
  }

  it("posts a real over/short entry when the drawer does not balance, and keeps the books tied", async () => {
    const expected = (await close(0)).json().expected_minor as number;

    const over = await close(expected + 500_00);
    expect(over.statusCode).toBe(200);
    expect(over.json().difference_minor).toBe(500_00);

    const entries = await testDb.db.selectFrom("journal_entry").select("id").where("source_type", "=", "till_close").execute();
    expect(entries.length).toBeGreaterThan(0);

    // The whole point of posting it rather than absorbing it: the ledger still ties.
    const tb = await app.inject({ method: "GET", url: `/internal/control/trial-balance?date=${DATE}` });
    expect(tb.json().balanced).toBe(true);
  });

  it("closing the same till twice is an idempotent replay, not a duplicate posting", async () => {
    const expected = (await close(0)).json().expected_minor as number;
    await close(expected + 250_00);
    const after1 = await testDb.db.selectFrom("journal_entry").select("id").where("source_type", "=", "till_close").execute();
    await close(expected + 250_00);
    const after2 = await testDb.db.selectFrom("journal_entry").select("id").where("source_type", "=", "till_close").execute();
    expect(after2.length).toBe(after1.length);
  });
});
