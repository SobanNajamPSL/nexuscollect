import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startTestDb, type TestDb } from "./helpers.js";
import { loadDemoData } from "../../src/loader/index.js";
import { buildApp } from "../../src/api/build-app.js";
import { DemoClock } from "../../src/platform/clock/index.js";
import { listBreaks, proposeBreakResolution, approveBreakResolution } from "../../src/modules/recon/resolve.js";
import type { FastifyInstance } from "fastify";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEMO_DATA_DIR = join(__dirname, "..", "..", "demo-data");

const ANALYST = "00000000-0000-4000-9000-000000000003"; // Imran Qureshi, OPS_RECON_ANALYST
const APPROVER = "00000000-0000-4000-9000-000000000004"; // Ayesha Riaz, OPS_RECON_APPROVER
const BUSINESS_DATE = "2026-07-30";

/**
 * Break resolution under maker-checker.
 *
 * `recon_break` carried status/resolution_type/approval_id/resolved_by since
 * migration 0009 and none of it was ever written: the platform could find the
 * eleven breaks but could not resolve one. The Break Register screen only
 * displayed them, which is why the gap went unnoticed.
 */
describe("Break resolution (§3.2 analyst/approver segregation)", () => {
  let testDb: TestDb;
  let app: FastifyInstance;
  const clock = new DemoClock();

  /** Breaks the run itself resolved — they must stay RESOLVED between tests. */
  let autoResolvedIds: string[] = [];

  beforeAll(async () => {
    testDb = await startTestDb();
    await loadDemoData(testDb.db, DEMO_DATA_DIR, clock);
    app = await buildApp({ db: testDb.db, clock, demoDataDir: DEMO_DATA_DIR });

    await app.inject({ method: "POST", url: "/internal/recon/run", payload: { business_date: BUSINESS_DATE } });
    autoResolvedIds = (await listBreaks(testDb.db, { businessDate: BUSINESS_DATE, status: "RESOLVED" })).map((b) => b.id);
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await testDb.stop();
  });

  beforeEach(async () => {
    // Undo whatever the previous test did, rather than re-running
    // reconciliation: `recon_source_record` references `recon_run`, so the runs
    // can't simply be deleted, and re-running would leave the ingested source
    // rows pointing at a stale run.
    await testDb.db.deleteFrom("approval").where("subject_type", "=", "recon_break").execute();
    let restore = testDb.db
      .updateTable("recon_break")
      .set({ status: "OPEN", resolution_type: null, approval_id: null, resolved_at: null, resolved_by_user_id: null })
      .where("business_date", "=", BUSINESS_DATE);
    if (autoResolvedIds.length > 0) restore = restore.where("id", "not in", autoResolvedIds);
    await restore.execute();
  });

  async function firstOpenBreakId(): Promise<string> {
    const open = await listBreaks(testDb.db, { businessDate: BUSINESS_DATE, status: "OPEN" });
    return open[0]!.id;
  }

  it("lists persisted breaks with their state, not just what a run returned", async () => {
    const res = await app.inject({ method: "GET", url: `/internal/breaks?business_date=${BUSINESS_DATE}` });
    expect(res.statusCode).toBe(200);
    const rows = res.json() as { status: string; break_code: string }[];
    // Eleven planted breaks; the three auto-resolvable ones are already RESOLVED.
    expect(rows).toHaveLength(11);
    expect(rows.filter((r) => r.status === "RESOLVED")).toHaveLength(3);
    expect(rows.filter((r) => r.status === "OPEN")).toHaveLength(8);
  });

  it("an analyst proposes and an approver approves, moving the break to RESOLVED", async () => {
    const breakId = await firstOpenBreakId();

    const propose = await app.inject({
      method: "POST",
      url: `/internal/breaks/${breakId}/propose`,
      headers: { "x-user-id": ANALYST },
      payload: { resolution_type: "ACCEPT_TIMING", narrative: "Bank booked the next morning; timing only." },
    });
    expect(propose.statusCode).toBe(200);
    expect(propose.json().status).toBe("PENDING_APPROVAL");

    const approve = await app.inject({
      method: "POST",
      url: `/internal/breaks/${breakId}/approve`,
      headers: { "x-user-id": APPROVER },
      payload: {},
    });
    expect(approve.statusCode).toBe(200);

    const row = await testDb.db.selectFrom("recon_break").selectAll().where("id", "=", breakId).executeTakeFirstOrThrow();
    expect(row.status).toBe("RESOLVED");
    expect(row.resolution_type).toBe("ACCEPT_TIMING");
    expect(row.resolved_by_user_id).toBe(APPROVER);
    expect(row.approval_id).not.toBeNull();
  });

  it("the analyst and approver roles are segregated in both directions", async () => {
    const breakId = await firstOpenBreakId();

    // An approver may not propose.
    const wrongPropose = await app.inject({
      method: "POST",
      url: `/internal/breaks/${breakId}/propose`,
      headers: { "x-user-id": APPROVER },
      payload: { resolution_type: "WRITE_OFF", narrative: "x" },
    });
    expect(wrongPropose.statusCode).toBe(403);

    await app.inject({
      method: "POST",
      url: `/internal/breaks/${breakId}/propose`,
      headers: { "x-user-id": ANALYST },
      payload: { resolution_type: "WRITE_OFF", narrative: "Below tolerance." },
    });

    // And an analyst may not approve — not even a proposal that isn't theirs.
    const wrongApprove = await app.inject({
      method: "POST",
      url: `/internal/breaks/${breakId}/approve`,
      headers: { "x-user-id": ANALYST },
      payload: {},
    });
    expect(wrongApprove.statusCode).toBe(403);
  });

  it("refuses a self-approval even when the same user somehow holds both roles", async () => {
    // Grant the analyst the approver role too, so the role guard passes and only
    // the segregation check can stop them. This is the belt-and-braces case: the
    // control must not depend solely on role separation.
    await testDb.db.insertInto("user_role").values({ user_id: ANALYST, role_code: "OPS_RECON_APPROVER" }).execute();
    try {
      const breakId = await firstOpenBreakId();
      await proposeBreakResolution(
        testDb.db,
        { breakId, resolutionType: "WRITE_OFF", narrative: "Below tolerance.", makerUserId: ANALYST },
        clock,
      );
      await expect(approveBreakResolution(testDb.db, breakId, ANALYST, clock)).rejects.toThrow(
        /cannot also approve it/,
      );
    } finally {
      await testDb.db
        .deleteFrom("user_role")
        .where("user_id", "=", ANALYST)
        .where("role_code", "=", "OPS_RECON_APPROVER")
        .execute();
    }
  });

  it("a rejected proposal returns the break to OPEN with no resolution left on it", async () => {
    const breakId = await firstOpenBreakId();
    await app.inject({
      method: "POST",
      url: `/internal/breaks/${breakId}/propose`,
      headers: { "x-user-id": ANALYST },
      payload: { resolution_type: "WRITE_OFF", narrative: "Propose write-off." },
    });

    const reject = await app.inject({
      method: "POST",
      url: `/internal/breaks/${breakId}/reject`,
      headers: { "x-user-id": APPROVER },
      payload: { comment: "Too large to write off; investigate the narrative." },
    });
    expect(reject.statusCode).toBe(200);

    const row = await testDb.db.selectFrom("recon_break").selectAll().where("id", "=", breakId).executeTakeFirstOrThrow();
    expect(row.status).toBe("OPEN");
    expect(row.resolution_type).toBeNull();
    expect(row.approval_id).toBeNull();
  });

  it("cannot approve a break nobody has proposed a resolution for", async () => {
    const breakId = await firstOpenBreakId();
    const res = await app.inject({
      method: "POST",
      url: `/internal/breaks/${breakId}/approve`,
      headers: { "x-user-id": APPROVER },
      payload: {},
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("BREAK_NOT_PENDING_APPROVAL");
  });

  it("writes an audit entry for every step, so who resolved what is on the record", async () => {
    const breakId = await firstOpenBreakId();
    await app.inject({
      method: "POST",
      url: `/internal/breaks/${breakId}/propose`,
      headers: { "x-user-id": ANALYST },
      payload: { resolution_type: "RECLASSIFY", narrative: "Banked but misfiled." },
    });
    await app.inject({
      method: "POST",
      url: `/internal/breaks/${breakId}/approve`,
      headers: { "x-user-id": APPROVER },
      payload: {},
    });

    const entries = await testDb.db
      .selectFrom("audit_log")
      .select(["action", "actor_id"])
      .where("entity_type", "=", "recon_break")
      .where("entity_id", "=", breakId)
      .execute();
    const actions = entries.map((e) => e.action);
    expect(actions).toContain("recon_break.resolution_proposed");
    expect(actions).toContain("recon_break.resolution_approved");
    expect(entries.find((e) => e.action === "recon_break.resolution_proposed")?.actor_id).toBe(ANALYST);
    expect(entries.find((e) => e.action === "recon_break.resolution_approved")?.actor_id).toBe(APPROVER);
  });
});
