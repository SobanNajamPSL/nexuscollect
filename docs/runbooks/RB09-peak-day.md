# RB09 — Peak day (deadline approaching)

**Trigger:** a statutory payment deadline is approaching (e.g. fiscal-year-end,
a tax filing date) and collection volume is expected to spike sharply.

## Steps

This runbook executes the "§19.3 playbook" the design doc points to for
peak-day operational readiness (capacity, on-call staffing, rail liaison).
**§19.3 itself is design commentary, not built in this demo** (CLAUDE.md is
explicit: "Start on HSM key rotation, DR rehearsals or 3,000 TPS load tests —
No. §19 and §20 are design commentary for this build, not backlog"), so this
runbook stays a pointer plus what this build genuinely supports operationally:

1. Watch the fiscal-year-boundary log (§13.3: every value-date decision within
   ±2 hours of midnight is logged at INFO) if the peak coincides with a fiscal
   year boundary — the `AFTER_CUTOFF`/`NON_BUSINESS_DAY` reasons on
   `assignValueDate` output are exactly the audit trail for "did this payment
   count for the closing year or the new one."
2. Confirm the demo/production distinction: `DEMO_MODE` must be `false` in any
   real peak-day environment — this build's `DemoClock` pinning is explicitly
   for the recorded demo, never for production traffic.
3. Watch `UNCERTAIN` queue depth (RB04) more closely than usual — peak volume is
   exactly when a marginal rail/channel issue turns into a queue spike.
4. **Not built in this demo, disclosed rather than pretended:** load testing at
   scale, capacity autoscaling policy, and a formal peak-day staffing plan are
   §19 territory and out of scope per CLAUDE.md's explicit instruction.
