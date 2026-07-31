# RB10 — Suspected fraud

**Trigger:** a fraud alert or an external report flags a specific payer,
channel, or pattern.

## Steps

1. **Preserve evidence first.** `audit_log` is append-only and hash-chained
   (`verifyLedgerChain`-equivalent audit chain verification exists in
   `platform/audit`) — pull the relevant entries and the full
   `application_trace` for every implicated payment before taking any other
   action, so the evidence trail can't be disputed later.
2. **Freeze the specific payer/channel, not the platform.** This build has no
   payer-level suspension flag yet — the closest real lever available today is
   product-level `allowed_channels` (temporarily remove the suspect channel for
   the affected product) or, for a single payer, declining new mandates
   (`modules/mandate.cancelMandate`) and holding new RtPs to them. A dedicated
   payer-risk-flag mechanism is §11 territory (`risk` in the module map) and is
   not built in this demo — disclosed, not silently assumed.
3. **Notify compliance.**
4. **Prepare the regulator report** using R17 (Regulatory Return) once the
   investigation's facts are established — never before.

**Velocity monitoring is per-remitter, not just per-taxpayer** (§8.14) — a
third-party payer (lawyer, clearing agent) paying many taxpayers' bills is
normal; the same pattern against unrelated payers from one remitter is the
actual signal.
