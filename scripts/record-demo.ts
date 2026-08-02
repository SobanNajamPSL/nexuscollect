/**
 * Record the demonstration.
 *
 * Produces one continuous film following the agreed narrative arc, and the same
 * seven beats again as standalone clips so any single moment can be dropped into a
 * deck or re-recorded without redoing the whole thing.
 *
 * The arc is problem-first, then chronological:
 *
 *   0. Cold open on an agency's own position — the thing the audience cares about.
 *   1. Rewind: a citizen finds bills across two agencies and pays them.
 *   2. A teller takes cash and lodges a cheque at a counter.
 *   3. Back to the agency, whose position has moved by exactly what happened.
 *   4. The operator reconciles the day and resolves a break under maker-checker.
 *   5. The cheque bounces, and the cascade unwinds six things at once.
 *   6. Close on the five control assertions, a tamper caught by name, and the
 *      scroll to treasury.
 *
 * It is a silent film, so a caption overlay is injected before each beat. The
 * overlay is deliberately part of the recording rather than added in an editor:
 * the film has to be watchable as-is by somebody who was not in the room.
 *
 *   npx tsx scripts/record-demo.ts --dry     rehearse headlessly, no video
 *   npx tsx scripts/record-demo.ts --film    the continuous film only
 *   npx tsx scripts/record-demo.ts --beats   the standalone clips only
 *   npx tsx scripts/record-demo.ts           both
 */
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, "..", "docs", "demo", "recordings");
const RAW = join(OUT, "raw");
const API = "http://localhost:3000";

const CITIZEN = "http://pay.localhost:5174";
const AGENCY = "http://agency.localhost:5175";
const OPS = "http://ops.localhost:5176";
const FIELD = "http://field.localhost:5177";

/** Seeded users, by the name the harness shows. */
const AGENCY_ADMIN = "Bilal Farooq";
const ANALYST = "Imran Qureshi";
const APPROVER = "Ayesha Riaz";
const TELLER = "Nadia Aslam";

/**
 * The cheque the teller lodges in beat 2 and the bank returns in beat 5.
 *
 * A fresh one rather than the seeded `IN-0004`: that instrument arrives from
 * `demo-data/instruments.csv` already RETURNED, with its cascade already applied at
 * load time, so there is nothing left to demonstrate on it. Lodging one at the
 * counter and bouncing that same cheque is also the better story — it is one
 * cheque's whole life, and it ties the counter beat to the dishonour beat.
 */
const DEMO_CHEQUE = "004901";
const DEMO_CHEQUE_PSID = "12010400001899869";
const DEMO_CHEQUE_AMOUNT = "247968.00";

/** A small overdue water bill, paid in cash at the counter. */
const CASH_PSID = "5101150000142";
const CASH_TENDERED = "3000";

const dry = process.argv.includes("--dry");
/** Leave the database as the last beat left it, for inspecting what a take produced. */
const keep = process.argv.includes("--keep");
/** `--only=02-counter` re-records or rehearses one beat without redoing the rest. */
const only = process.argv.find((a) => a.startsWith("--only="))?.slice("--only=".length);

/**
 * Reading time, derived from the caption rather than fixed.
 *
 * The commonest way a screen recording becomes useless is being paced at the speed
 * of the software instead of the speed of a person. A flat pause cannot work here:
 * these captions run from six words to fifty, and the long ones carry the argument.
 * At roughly 170 words per minute — a comfortable rate for reading off a screen
 * somebody else is scrolling — a fifty-word caption needs about seventeen seconds,
 * and a short title needs three.
 *
 * The first cut of this film held every caption for 3.4 seconds and came out at four
 * minutes. It was unreadable.
 */
const BEAT = 1_600;
const LINGER = 2_400;
const WORD_MS = 350;
const CAPTION_FLOOR = 2_600;
const CAPTION_CEILING = 19_000;

function readingTime(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.min(CAPTION_CEILING, Math.max(CAPTION_FLOOR, 900 + words * WORD_MS));
}

async function pause(page: Page, ms: number): Promise<void> {
  await page.waitForTimeout(dry ? Math.min(ms, 150) : ms);
}

// --- The caption overlay -----------------------------------------------------

/**
 * Injected as an init script so it survives navigation. Everything about it says
 * "this is narration, not part of the product": it sits at the bottom, over a
 * gradient, in a different typeface from every portal.
 */
const OVERLAY = `
window.__caption = (title, body) => {
  let el = document.getElementById("__demo_caption");
  if (!el) {
    el = document.createElement("div");
    el.id = "__demo_caption";
    el.style.cssText = [
      "position:fixed", "left:0", "right:0", "bottom:0", "z-index:2147483647",
      "padding:28px 48px 34px", "pointer-events:none",
      "background:linear-gradient(to top, rgba(8,10,14,0.94) 0%, rgba(8,10,14,0.82) 55%, rgba(8,10,14,0) 100%)",
      "font-family:'Inter','Helvetica Neue',system-ui,sans-serif", "color:#fff",
      "transition:opacity 320ms ease", "opacity:0",
    ].join(";");
    el.innerHTML =
      '<div id="__demo_caption_title" style="font-size:27px;font-weight:650;letter-spacing:-0.011em;line-height:1.24"></div>' +
      '<div id="__demo_caption_body" style="font-size:18px;line-height:1.5;color:rgba(255,255,255,0.80);margin-top:8px;max-width:1180px"></div>';
    document.body.appendChild(el);
  }
  document.getElementById("__demo_caption_title").textContent = title || "";
  document.getElementById("__demo_caption_body").textContent = body || "";
  el.style.opacity = (title || body) ? "1" : "0";
};
window.__captionClear = () => window.__caption("", "");
`;

/**
 * `window` is not in scope for this script's own types — it runs under the Node
 * tsconfig — so the browser-side call is reached through `globalThis`, which is.
 */
interface CaptionWindow {
  __caption: (title: string, body: string) => void;
  __captionClear: () => void;
}

async function caption(page: Page, title: string, body = ""): Promise<void> {
  await page.evaluate(([t, b]) => (globalThis as unknown as CaptionWindow).__caption(t!, b!), [title, body]);
  await pause(page, readingTime(`${title} ${body}`));
}

async function clearCaption(page: Page): Promise<void> {
  await page.evaluate(() => (globalThis as unknown as CaptionWindow).__captionClear());
}

// --- Harness helpers ---------------------------------------------------------

async function resetDemo(): Promise<void> {
  const res = await fetch(`${API}/internal/demo/reset`, { method: "POST" });
  if (!res.ok) throw new Error(`demo reset failed: ${res.status}`);
}

async function becomePersona(page: Page, persona: string): Promise<void> {
  const select = page.getByLabel("Acting as");
  await select.waitFor({ state: "visible", timeout: 15_000 });
  const value = await select.locator("option").evaluateAll(
    (options, name) =>
      (options as unknown as { textContent: string | null; value: string }[]).find((o) => o.textContent?.startsWith(name))?.value ?? "",
    persona,
  );
  if (!value) throw new Error(`no persona starting "${persona}" in this portal`);
  if ((await select.inputValue()) === value) return;
  await Promise.all([page.waitForLoadState("networkidle"), select.selectOption(value)]);
  await page.waitForTimeout(dry ? 100 : 600);
}

/** Navigate, then restore the caption overlay's presence for the new document. */
async function go(page: Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForTimeout(dry ? 60 : 500);
}

/** Scroll a region into shot without the jump a click-to-anchor produces. */
async function reveal(page: Page, text: string): Promise<void> {
  const target = page.getByText(text, { exact: false }).first();
  if (await target.count()) {
    await target.scrollIntoViewIfNeeded().catch(() => undefined);
    await pause(page, 900);
  }
}

// --- The beats ---------------------------------------------------------------

/**
 * Each beat is self-contained: it can run as its own clip, or in sequence as part
 * of the film. Anything a beat needs that an earlier beat produced is set up by
 * `prepare`, so a clip is never dependent on having watched the previous one.
 */
interface Beat {
  id: string;
  title: string;
  /** State this beat needs that the arc would otherwise have produced. */
  prepare?: () => Promise<void>;
  run: (page: Page) => Promise<void>;
}

/** Pay the LEA-17-1000 bills through the API, for beats that need them already paid. */
async function payTheVehicleBills(): Promise<void> {
  const headers = { "content-type": "application/json", "x-institution-id": "00000000-0000-4000-8000-0000000000d1" };
  const resolved = await fetch(`${API}/v1/resolve`, {
    method: "POST",
    headers,
    body: JSON.stringify({ key_type: "VEHICLE_REG", key_value: "LEA-17-1000", channel: "APP" }),
  }).then((r) => r.json() as Promise<{ resolution_token: string; payables: { psid: string; agency_code: string }[] }>);

  const byAgency = new Map<string, string[]>();
  for (const p of resolved.payables) byAgency.set(p.agency_code, [...(byAgency.get(p.agency_code) ?? []), p.psid]);

  for (const [agency, psids] of [...byAgency].sort(([a], [b]) => a.localeCompare(b))) {
    const intent = await fetch(`${API}/v1/payment-intents`, {
      method: "POST",
      headers: { ...headers, "idempotency-key": `film-intent-${agency}` },
      body: JSON.stringify({ resolution_token: resolved.resolution_token, channel: "APP", psids }),
    }).then((r) => r.json() as Promise<{ intent_reference: string; total_debit_minor: number }>);
    await fetch(`${API}/v1/payments`, {
      method: "POST",
      headers: { ...headers, "idempotency-key": `film-payment-${agency}` },
      body: JSON.stringify({
        intent_reference: intent.intent_reference,
        channel: "APP",
        rail: "RAAST",
        gross_amount_minor: intent.total_debit_minor,
        value_date: "2026-07-30",
        obligation_discharge_date: "2026-07-30",
        capture_outcome: "CONFIRMED",
      }),
    });
  }
}

/**
 * Walk the seeded request to ACCEPTED, for the clip that begins after that point.
 * Uses the same endpoints the agency portal's own buttons call.
 */
async function acceptSeededRequest(): Promise<void> {
  const list = await fetch(`${API}/internal/rtp`).then((r) => r.json() as Promise<{ id: string; rtp_reference: string; status: string }[]>);
  const rtp = list.find((r) => r.rtp_reference === RTP_REFERENCE);
  if (!rtp) return;
  for (const action of ["present", "accept"]) {
    await fetch(`${API}/internal/rtp/${rtp.id}/transition`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action }),
    });
  }
}

async function runReconciliation(): Promise<void> {
  await fetch(`${API}/internal/recon/run`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "film-recon-2026-07-30" },
    body: JSON.stringify({ business_date: "2026-07-30" }),
  });
}

const coldOpen: Beat = {
  id: "00-cold-open",
  title: "Cold open — an agency's own position",
  run: async (page) => {
    await go(page, AGENCY);
    await becomePersona(page, AGENCY_ADMIN);
    await caption(
      page,
      "NexusCollect — collecting money owed to government",
      "Start where the audience cares: what one agency can say about its own money, on one business date.",
    );
    await caption(
      page,
      "Three numbers, never one",
      "Confirmed is what has been applied to this agency's bills. Settled is which bills that discharged. Swept is cash that has actually reached the treasury account. A collection system that reports one figure called 'collected' is misstating its own position.",
    );
    await reveal(page, "HEAD-WISE COLLECTION");
    await caption(
      page,
      "Broken down by revenue head",
      "Government reporting is organised by head, not by transaction. Surcharge is collected against its own head rather than folded into the tax it accrued on, which is what makes it separately auditable.",
    );
    await reveal(page, "BILLS ISSUED");
    await caption(page, "And what is still owed", "Thirty-one bills raised, PKR 220,900.00 outstanding. Now rewind and watch one day's money produce those numbers.");
    await clearCaption(page);
    await pause(page, LINGER);
  },
};

/**
 * The bill the seeded Request to Pay R260005 is raised against — a real ETPB motor
 * vehicle bill, still unpaid. Held as a constant so the beat and its caption cannot
 * drift apart.
 */
const RTP_REFERENCE = "R260005";
const RTP_PSID = "31010900000396648";

const requestToPay: Beat = {
  id: "01-request-to-pay",
  title: "The agency asks to be paid",
  run: async (page) => {
    await go(page, `${AGENCY}/request-to-pay`);
    await becomePersona(page, AGENCY_ADMIN);
    await caption(
      page,
      "Before waiting, ask",
      "Everything so far assumes the payer goes looking for their bill. A Request to Pay is the platform asking instead — addressed to a phone number, carrying its own lifecycle, with every step recorded.",
    );
    await caption(
      page,
      "Fourteen requests, in eight different states",
      "Sent, delivered, presented, accepted, declined, expired, cancelled, undeliverable. A request is a conversation that can end several ways, and an agency needs to see which ended how.",
    );

    const row = page.locator("tr", { hasText: RTP_REFERENCE }).first();
    await row.scrollIntoViewIfNeeded();
    await pause(page, 900);
    await caption(page, `Request ${RTP_REFERENCE}, for PKR 16,500.00`, "Delivered to the payer's phone, not yet opened.");

    await row.getByRole("button", { name: "Mark presented" }).click();
    await page.getByText("PRESENTED").first().waitFor({ timeout: 15_000 });
    await pause(page, BEAT);
    await caption(page, "The payer opens it", "Presented — it is now in front of them.");

    await page.locator("tr", { hasText: RTP_REFERENCE }).first().getByRole("button", { name: "Payer accepts" }).click();
    await page.getByText("ACCEPTED").first().waitFor({ timeout: 15_000 });
    await pause(page, BEAT);
    await caption(
      page,
      "And accepts — which is not the same as paying",
      "Accepting is the payer agreeing. No money has moved. The bill is still outstanding, and the request will sit here until it is actually settled.",
    );
    await clearCaption(page);
    await pause(page, LINGER);
  },
};

const requestFulfilled: Beat = {
  id: "02-request-fulfilled",
  title: "The money arrives, and the request closes itself",
  prepare: async () => {
    await acceptSeededRequest();
  },
  run: async (page) => {
    await go(page, CITIZEN);
    await caption(
      page,
      "The payer pays it — through their own bank",
      "Nothing special. The same lookup, the same pipeline, the same rail as any other payment. A Request to Pay changes who starts the conversation, not how the collection works.",
    );

    await page.getByLabel("What do you have?").selectOption("PSID");
    await page.getByLabel("Bill number (PSID)", { exact: true }).fill(RTP_PSID);
    await page.getByRole("button", { name: "Find my bills" }).click();
    await page.getByText("outstanding").first().waitFor({ timeout: 15_000 });
    await pause(page, BEAT);
    await page.getByRole("button", { name: /^Pay all/ }).click();
    await page.getByText("OFFICIAL RECEIPT").first().waitFor({ timeout: 25_000 });
    await pause(page, BEAT);
    await caption(page, "Paid, and receipted", "PKR 16,500.00, against the bill the request named.");

    await go(page, `${AGENCY}/request-to-pay`);
    await becomePersona(page, AGENCY_ADMIN);
    await page.locator("tr", { hasText: RTP_REFERENCE }).first().scrollIntoViewIfNeeded();
    await pause(page, 900);
    await caption(
      page,
      "FULFILLED — and nobody pressed anything",
      "The platform recognised its own money and closed the request. That distinction is the whole reason fulfilment is a separate step from acceptance: an agency needs to know which of its requests were *paid*, not merely which were agreed to.",
    );
    await clearCaption(page);
    await pause(page, LINGER);
  },
};

const citizenPays: Beat = {
  id: "03-citizen-pays",
  title: "A citizen pays bills across two agencies",
  run: async (page) => {
    await go(page, CITIZEN);
    await caption(page, "The citizen portal", "Public. No account, no password, no sign-in. A bill is found with a reference the payer already has in their hand.");

    await page.getByRole("button", { name: "Find my bills" }).click();
    await page.getByText("outstanding").first().waitFor({ timeout: 15_000 });
    await pause(page, BEAT);
    await caption(
      page,
      "One vehicle registration, two agencies, three bills",
      "LEA-17-1000 returns bills from the Excise department and from the Safe Cities Authority, in one list, for PKR 16,750.00. Without a shared platform this payer visits two organisations.",
    );
    await reveal(page, "early-payment discount");
    await caption(
      page,
      "The discount is live, and already applied",
      "PKR 1,250.00 off the moving-violation challan while it lasts. The PKR 3,750.00 shown is what will be charged — and what the ledger will record.",
    );
    await reveal(page, "Already paid");
    await caption(
      page,
      "A bill already paid comes back with its receipt",
      "Not an error, and not an empty result. Showing the payer proof they already paid is what prevents the commonest duplicate payment there is.",
    );

    await clearCaption(page);
    await page.getByRole("button", { name: /^Pay all/ }).click();
    await page.getByText("different agencies").first().waitFor({ timeout: 25_000 });
    await pause(page, BEAT);
    await caption(
      page,
      "One tap — but two payments, and two receipts",
      "A payment belongs to exactly one agency, because the sweep moves it into one treasury account and the scroll is emitted per agency. So the split is real. That is also the answer to 'how do I know my money is mine': it was never mixed.",
    );

    await page.getByText("Punjab Safe Cities Authority").first().click();
    await page.getByText("OFFICIAL RECEIPT").first().waitFor({ timeout: 15_000 });
    await pause(page, BEAT);
    await caption(
      page,
      "The receipt is rendered from the signed payload",
      "Not from a convenient query — from the bytes that were cryptographically signed. A receipt that displays cannot disagree with a receipt that verifies.",
    );
    await reveal(page, "In words");
    await caption(
      page,
      "Head-wise, and it adds up",
      "PKR 6,750.00 across three revenue heads and two bills. The discounted challan contributes 3,750.00, not its 5,000.00 principal. A receipt whose parts do not sum to its total is the first thing an auditor rejects.",
    );

    await page.getByRole("button", { name: "اردو" }).click();
    await pause(page, BEAT);
    await caption(
      page,
      "In Urdu, right-to-left, with the amount in words",
      "The words are what make a printed receipt hard to alter. Revenue head names stay in English deliberately — they are the agency's own published descriptions, and inventing translations would be fabricating reference data.",
    );

    await page.getByRole("button", { name: "English" }).click();
    await pause(page, 700);
    await page.getByRole("button", { name: "Verify as issued" }).click();
    await page.getByText("Signature valid").first().waitFor({ timeout: 10_000 });
    // The verdict renders below the receipt, so without this it sits behind the
    // caption that is describing it — the viewer reads the claim and never sees it
    // land.
    await reveal(page, "Signature valid");
    await pause(page, BEAT);
    await caption(
      page,
      "Verified in the browser, with nothing sent anywhere",
      "An Ed25519 check run locally against the public key on the receipt. No network, no database — which is what offline verification has to mean to be worth claiming.",
    );

    await page.getByRole("button", { name: "Alter one digit" }).click();
    await page.getByText("Signature invalid").first().waitFor({ timeout: 10_000 });
    await reveal(page, "Signature invalid");
    await pause(page, BEAT);
    await caption(page, "Change one digit and it fails", "Somebody holding the receipt and the public key, with no access to the platform at all, can tell a genuine receipt from an altered one.");
    await clearCaption(page);
    await pause(page, LINGER);
  },
};

const counter: Beat = {
  id: "04-counter",
  title: "A teller takes cash and lodges a cheque",
  run: async (page) => {
    await go(page, FIELD);
    await becomePersona(page, TELLER);
    await caption(
      page,
      "The same day, at a counter",
      "Oversized targets, high contrast, one task per screen — because this is used standing up, in poor light, with somebody waiting.",
    );

    await page.getByLabel("Bill reference (PSID)").fill(CASH_PSID);
    await page.getByRole("button", { name: "Look up" }).click();
    await page.getByText("Amount due").first().waitFor({ timeout: 15_000 });
    await pause(page, BEAT);
    await caption(
      page,
      "Cash across the counter",
      "The amount due is computed live, so a surcharge that has accrued since the bill was printed is already in it. The teller reads it back before accepting the money.",
    );

    await page.getByLabel("Cash tendered (PKR)").fill(CASH_TENDERED);
    await pause(page, 900);
    await caption(page, "Tendered, and the change to return", "The platform works out the change so the teller does not have to.");
    await page.getByRole("button", { name: /^Accept / }).click();
    // The success notice, not the section heading — waiting on text that is always
    // present would mask a failure rather than catch it.
    await page.getByText("Payment accepted").first().waitFor({ timeout: 20_000 });
    await pause(page, BEAT);
    await caption(
      page,
      "Nothing about cash is special-cased",
      "Same apply pipeline as a bank app: allocated across the bill's line items by the product's waterfall, posted to the ledger, receipted with a gapless per-agency number. The channel is CASH and the rail is CASH — and that is the only difference.",
    );

    await go(page, `${FIELD}/instrument`);
    await caption(
      page,
      "Lodging a cheque",
      "A physical instrument accepted across the counter. This did not exist until the field portal was built: the platform could unwind a bounced cheque but had no way to accept one, because every seeded cheque came from the data loader.",
    );

    await page.getByLabel("Bill reference (PSID)").fill(DEMO_CHEQUE_PSID);
    await page.getByLabel("Instrument number").fill(DEMO_CHEQUE);
    await page.getByLabel("Amount on the instrument (PKR)").fill(DEMO_CHEQUE_AMOUNT);
    await page.getByLabel("Drawer name").fill("Zenith Clearing Agents (Pvt) Ltd");
    await page.getByLabel("Drawee bank").fill("Habib Bank Limited");
    await pause(page, BEAT);
    await caption(page, "Cheque 004901, for PKR 247,968.00", "Tendered against one overdue sales-tax bill. Remember this cheque — the bank has not paid it yet.");

    await page.getByRole("button", { name: /^Lodge / }).click();
    await page.getByText("Instrument lodged and linked").first().waitFor({ timeout: 20_000 });
    await pause(page, BEAT);
    await caption(
      page,
      "The credit is provisional, and stays provisional",
      "The bank can still take this money back, so it can never be swept to treasury, and the receipt says so on its face rather than implying the obligation is discharged.",
    );

    await go(page, `${FIELD}/till`);
    await caption(
      page,
      "Closing the till",
      "The teller counts the drawer. Any difference from what the platform expected is posted to the ledger as a real over/short entry, not absorbed into a rounding line — and the trial balance still ties afterwards.",
    );
    await caption(page, "Only a teller can accept money", "A branch supervisor cannot. A supervisor reverses a teller's mistakes, and somebody who can both take money and reverse it is not a control.");
    await clearCaption(page);
    await pause(page, LINGER);
  },
};

const agencySeesIt: Beat = {
  id: "05-agency-position",
  title: "The agency's position has moved",
  prepare: payTheVehicleBills,
  run: async (page) => {
    await go(page, AGENCY);
    await becomePersona(page, AGENCY_ADMIN);
    await caption(
      page,
      "Back to the agency, after the money moved",
      "Confirmed has risen by exactly the PKR 10,000.00 token tax that citizen paid. Nothing here is entered by hand — every figure is computed from the ledger at the demonstration business date.",
    );
    await reveal(page, "SWEPT TO TREASURY");
    await caption(
      page,
      "Swept is still zero, and that is correct",
      "The money is confirmed against the bills but has not left the collection account. Swept lags on purpose: it is the number a finance officer can trust precisely because it is the most conservative of the three.",
    );
    await clearCaption(page);
    await pause(page, LINGER);
  },
};

const reconcile: Beat = {
  id: "06-reconcile",
  title: "Reconciling the day, under maker-checker",
  prepare: payTheVehicleBills,
  run: async (page) => {
    await go(page, `${OPS}/breaks`);
    await becomePersona(page, ANALYST);
    await caption(
      page,
      "The operator's back office",
      "Cross-agency, and organised around queues rather than dashboards. Reconciliation is three-way: the bank's statement, the switch's settlement file, and the rail's settlement file.",
    );

    await page.getByRole("button", { name: "Run reconciliation" }).click();
    await page.getByText("Breaks found").first().waitFor({ timeout: 30_000 });
    await pause(page, BEAT);
    await caption(
      page,
      "Eleven breaks — and eleven is the point",
      "Not ten, not twelve. The dataset has exactly eleven planted discrepancies and the engine finds exactly those, which is very hard to fake. Three of them resolve themselves.",
    );
    await caption(
      page,
      "A break is a disagreement, not missing money",
      "PKR 764,109.50 unexplained does not mean three quarters of a million rupees has gone. Most of these are filing problems — a treasury line posted to a head that is not valid for the period, a fee 7.50 above contract, a bank booking a day later than the platform.",
    );
    await reveal(page, "RESOLVED");
    await caption(
      page,
      "The mechanical ones resolve themselves",
      "Two timing differences across a date boundary, and one settlement row the switch sent twice. Identifiable without a human, so no human is asked.",
    );

    await reveal(page, "OPEN");
    await page.getByRole("button", { name: "Propose a resolution" }).first().click();
    await pause(page, BEAT);
    await caption(
      page,
      "An analyst proposes a resolution",
      "Five options: match it manually, accept it as timing, reclassify it, write it off, or escalate to the agency. The narrative is not optional — somebody has to say what they found.",
    );
    await page.getByPlaceholder("What you found, and why this resolution").fill(
      "Rail cycle net understated against its constituent payments; confirmed with the rail's own cycle report and escalating to the agency.",
    );
    await pause(page, 800);
    await page.getByRole("button", { name: "Propose", exact: true }).click();
    await page.getByText("AWAITING APPROVAL").first().waitFor({ timeout: 15_000 });
    await pause(page, BEAT);
    await caption(page, "And cannot approve it", "It moves to awaiting approval. The analyst has no button to finish the job.");

    await becomePersona(page, APPROVER);
    await pause(page, BEAT);
    await caption(
      page,
      "A different person, in a different role",
      "Maker-checker here is enforced twice: the same user id is refused, and proposing and approving require different roles. Two accounts belonging to one person defeats an id check — it does not defeat this.",
    );
    await page.getByRole("button", { name: "Approve" }).first().click();
    await pause(page, BEAT);
    await caption(page, "Resolved, with both names against it", "Who proposed it, who approved it, what they said, and when. That record is the reason a resolution can be trusted at all.");
    await clearCaption(page);
    await pause(page, LINGER);
  },
};

/** Lodge the cheque through the API, for the standalone clip that starts after it. */
async function lodgeTheCheque(): Promise<void> {
  await fetch(`${API}/internal/instruments`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-user-id": "00000000-0000-4000-9000-000000000007",
      "idempotency-key": `film-lodge-${DEMO_CHEQUE}`,
    },
    body: JSON.stringify({
      instrument_type: "CHEQUE",
      instrument_number: DEMO_CHEQUE,
      amount_minor: 24_796_800,
      drawer_name: "Zenith Clearing Agents (Pvt) Ltd",
      drawee_bank_name: "Habib Bank Limited",
      allocations: [{ psid: DEMO_CHEQUE_PSID, amount_minor: 24_796_800 }],
      value_date: "2026-07-30",
    }),
  });
}

const chequeBounces: Beat = {
  id: "07-cheque-bounces",
  title: "The cheque bounces, and six things unwind",
  prepare: lodgeTheCheque,
  run: async (page) => {
    await go(page, `${OPS}/instruments`);
    await becomePersona(page, ANALYST);
    await caption(
      page,
      "Three days later, the bank returns it",
      "Cheque 004901, PKR 247,968.00, insufficient funds — the one the teller took across the counter. One action, and watch what it has to undo.",
    );

    // Located by cheque number rather than by position: the caption names this
    // specific instrument and its amount, so clicking whatever happens to be first
    // in the table would make the narration a lie the moment the ordering changes.
    const cheque = page.locator("tr", { hasText: DEMO_CHEQUE }).first();
    await cheque.scrollIntoViewIfNeeded();
    await pause(page, 700);
    await cheque.getByRole("button", { name: "Return (dishonour)" }).click();
    await page.getByText("Dishonour cascade applied").first().waitFor({ timeout: 25_000 });
    await pause(page, BEAT);
    await caption(
      page,
      "Everything it funded, unwound at once",
      "Every allocation the cheque funded is reversed. Every bill it settled is un-settled. Every receipt it produced is VOIDED — never deleted, still linked to the original. Surcharge resumes from the ORIGINAL due date, so the bill gets no holiday for the time it sat as provisionally paid. The service gate closes again. And a dishonour charge is raised automatically.",
    );

    await go(page, `${CITIZEN}/verify`);
    await caption(
      page,
      "And the receipt the payer is holding",
      "A receipt that verified as valid an hour ago now verifies as VOIDED, with the reason. That is why status is the headline of the public verification screen and not a footnote.",
    );
    await clearCaption(page);
    await pause(page, LINGER);
  },
};

const proveIt: Beat = {
  id: "08-prove-it",
  title: "Prove it: five assertions, a tamper, and the scroll",
  prepare: async () => {
    await payTheVehicleBills();
    await runReconciliation();
  },
  run: async (page) => {
    await go(page, `${OPS}/controls`);
    await becomePersona(page, ANALYST);
    await caption(
      page,
      "Five control assertions, re-performed on demand",
      "Not a status page. Every one of these is recomputed against the live ledger the moment you ask, because a stored 'all green' proves nothing.",
    );
    await page.getByRole("button", { name: "Re-perform all five" }).click();
    await pause(page, BEAT);
    await caption(
      page,
      "Every entry balances, every cached balance rebuilds identically",
      "The third check is the quiet one: throw away every cached balance column, recompute from the allocations, and get the same numbers to the paisa. Cached figures are only ever a cache.",
    );

    await caption(page, "Now break it, on camera", "The harness bar has a button whose only purpose is to corrupt a row in the financial ledger. Nothing in the product can do this.");
    await page.getByRole("button", { name: "Break the chain" }).click();
    await pause(page, LINGER);
    await page.getByRole("button", { name: "Re-perform all five" }).click();
    await pause(page, BEAT);
    await caption(
      page,
      "Caught, and named",
      "Not a general warning that something somewhere is wrong. The specific journal entry that was altered, by number — because each entry's hash covers the one before it, so a changed row can only be consistent with itself.",
    );

    await page.getByRole("button", { name: "Reset" }).click();
    await pause(page, LINGER);
    await go(page, `${OPS}/controls`);
    await page.getByRole("button", { name: "Re-perform all five" }).click();
    await pause(page, BEAT);
    await caption(page, "Reset, and verifiable again", "Same actions, same numbers, every take.");

    await go(page, `${OPS}/sweep`);
    await caption(
      page,
      "Finally, the money leaves",
      "The sweep moves confirmed, final money to treasury and refuses anything provisional. Run it for one agency and watch what it produces.",
    );
    await page.getByRole("button", { name: "Run sweep" }).click();
    await page.getByText("swept", { exact: false }).first().waitFor({ timeout: 25_000 });
    await pause(page, BEAT);
    await caption(
      page,
      "And the scroll goes with it",
      "One line per allocation, with a control total. It is never emitted unless that total ties exactly to the ledger — because treasury is being asked to acknowledge receipt of exactly what the platform says it sent.",
    );
    await reveal(page, "Control total");
    await pause(page, LINGER);
    await caption(
      page,
      "That is the whole argument",
      "One reference finds every bill. One payment is provably split across heads and agencies. Every discrepancy is found, and resolved by two people. Nothing reaches treasury unless it ties. And if anybody alters the record, the platform names what they touched.",
    );
    await clearCaption(page);
    await pause(page, LINGER);
  },
};

const BEATS: Beat[] = [coldOpen, requestToPay, requestFulfilled, citizenPays, counter, agencySeesIt, reconcile, chequeBounces, proveIt];

// --- Running -----------------------------------------------------------------

async function newContext(browser: Browser, record: boolean): Promise<BrowserContext> {
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    ...(record ? { recordVideo: { dir: RAW, size: { width: 1920, height: 1080 } } } : {}),
  });
  await context.addInitScript(OVERLAY);
  return context;
}

/** Playwright names videos by an internal id; rename to the beat once closed. */
async function collectVideo(context: BrowserContext, name: string): Promise<void> {
  const page = context.pages()[0];
  const video = page?.video();
  await context.close();
  if (!video) return;
  const from = await video.path();
  await rename(from, join(OUT, `${name}.webm`));
  process.stdout.write(`  → ${name}.webm\n`);
}

async function recordFilm(browser: Browser): Promise<void> {
  process.stdout.write("\nContinuous film\n");
  await resetDemo();
  const context = await newContext(browser, !dry);
  const page = await context.newPage();
  page.on("pageerror", (err) => process.stderr.write(`  ! pageerror: ${err.message}\n`));

  for (const beat of BEATS) {
    process.stdout.write(`  ${beat.id} — ${beat.title}\n`);
    // The film runs the arc in order, so each beat's state is produced by the
    // beats before it — except where the arc itself skipped ahead.
    if (beat === agencySeesIt) await payTheVehicleBills();
    // requestToPay already walked the request to ACCEPTED on camera, so the
    // fulfilment beat needs no preparation here.
    if (beat === proveIt) await runReconciliation();
    // beat 02 lodged the cheque through the UI, so beat 05 needs no preparation here.
    await beat.run(page);
  }

  if (dry) {
    await context.close();
    return;
  }
  await collectVideo(context, "nexuscollect-full-demonstration");
}

async function recordBeats(browser: Browser): Promise<void> {
  process.stdout.write("\nStandalone beats\n");
  for (const beat of BEATS.filter((b) => !only || b.id === only)) {
    process.stdout.write(`  ${beat.id} — ${beat.title}\n`);
    await resetDemo();
    await beat.prepare?.();
    const context = await newContext(browser, !dry);
    const page = await context.newPage();
    page.on("pageerror", (err) => process.stderr.write(`  ! pageerror: ${err.message}\n`));
    await beat.run(page);
    if (dry) {
      await context.close();
      continue;
    }
    await collectVideo(context, `beat-${beat.id}`);
  }
}

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });
  await mkdir(RAW, { recursive: true });

  const wantFilm = !process.argv.includes("--beats");
  const wantBeats = !process.argv.includes("--film");

  const browser = await chromium.launch();
  try {
    if (wantFilm) await recordFilm(browser);
    if (wantBeats) await recordBeats(browser);
  } finally {
    await browser.close();
  }

  // Playwright's own directory should be empty once every video is claimed.
  const leftovers = await readdir(RAW).catch(() => []);
  if (leftovers.length === 0) await rm(RAW, { recursive: true, force: true });

  if (!keep) await resetDemo();
  process.stdout.write(dry ? "\nRehearsal complete — no video written.\n" : "\nRecording complete.\n");
}

await main();
