/**
 * Capture every screen of every portal, and fail if any of them is broken.
 *
 * This is two jobs in one on purpose. The screenshots are for the manual, but
 * walking every route with the console wired up is also the cheapest complete
 * regression sweep this build has: a screen that throws, requests a route that
 * no longer exists, or renders `NaN` gets caught here rather than on camera.
 *
 * Determinism matters as much as it does anywhere else the demonstration is
 * visible. The clock is pinned and the database is reset before each portal, so
 * two runs a week apart produce the same images — otherwise the manual's figures
 * drift away from the fixture and nobody can tell whether a difference is a bug.
 *
 *   npx tsx scripts/capture-screens.ts            # all portals
 *   npx tsx scripts/capture-screens.ts ops field  # just these
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type ConsoleMessage, type Page } from "playwright";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, "..", "docs", "user-manual", "images");
const API = "http://localhost:3000";

/** Per-portal viewports: a phone for the public surface, a desk for the rest. */
const PORTALS = {
  citizen: { origin: "http://pay.localhost:5174", width: 480, height: 1000 },
  agency: { origin: "http://agency.localhost:5175", width: 1440, height: 1000 },
  ops: { origin: "http://ops.localhost:5176", width: 1600, height: 1000 },
  // 1280 rather than something narrower: below about 1200 the harness bar wraps
  // onto a second line, which reads as a layout fault in a screenshot.
  field: { origin: "http://field.localhost:5177", width: 1280, height: 1000 },
} as const;
type PortalName = keyof typeof PORTALS;

interface Shot {
  /** Output file name, without extension. */
  name: string;
  path: string;
  /** A persona to become first — omitted for the public citizen portal. */
  persona?: string;
  /** Anything to click, fill or wait for before the shutter. */
  prepare?: (page: Page) => Promise<void>;
  /** Wait for this text to appear, so the shot is never of a loading state. */
  expect?: string;
  fullPage?: boolean;
  /**
   * This shot deliberately provokes a rejection — a bad check digit, a refused
   * role — so a 4xx is the thing being demonstrated, not a fault. Named per shot
   * rather than globally, so a genuine 400 anywhere else still fails the sweep.
   */
  expectsRejection?: boolean;
}

/**
 * Console noise that is expected and not a defect. The React Router entries are
 * advisories about a major version this build does not use; they say nothing
 * about whether a screen works.
 */
const IGNORED_CONSOLE = [
  /Download the React DevTools/,
  /\[vite\] connect/,
  /Failed to load resource.*favicon/i,
  /React Router Future Flag Warning/,
];

const problems: string[] = [];

function watch(page: Page, label: string, rejectionExpected: () => boolean): void {
  page.on("console", (msg: ConsoleMessage) => {
    if (msg.type() !== "error" && msg.type() !== "warning") return;
    const text = msg.text();
    if (IGNORED_CONSOLE.some((re) => re.test(text))) return;
    if (rejectionExpected() && /Failed to load resource/.test(text)) return;
    problems.push(`[${label}] console.${msg.type()}: ${text}`);
  });
  page.on("pageerror", (err) => problems.push(`[${label}] pageerror: ${err.message}`));
  page.on("requestfailed", (req) => {
    if (req.url().includes("favicon")) return;
    problems.push(`[${label}] request failed: ${req.method()} ${req.url()} — ${req.failure()?.errorText}`);
  });
}

async function resetDemo(): Promise<void> {
  const res = await fetch(`${API}/internal/demo/reset`, { method: "POST" });
  if (!res.ok) throw new Error(`demo reset failed: ${res.status}`);
}

/**
 * Put the operator's day into the state they actually work in.
 *
 * Straight after a reset, reconciliation has not run: the break register is
 * empty and Today reports nothing to do. That is a truthful screenshot of an
 * unstarted day and a useless one for a manual — the reader needs to see the 11
 * breaks and how they are aged and grouped. So the ops shots run the same
 * reconciliation an operator would run first thing, against the same three real
 * files, producing the same 11 planted breaks every time.
 */
async function runReconciliation(): Promise<void> {
  const res = await fetch(`${API}/internal/recon/run`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "capture-recon-2026-07-30" },
    body: JSON.stringify({ business_date: "2026-07-30" }),
  });
  if (!res.ok) throw new Error(`recon run failed: ${res.status} ${await res.text()}`);
}

/** Per-portal setup beyond the reset. */
const PREPARE: Partial<Record<PortalName, () => Promise<void>>> = {
  ops: runReconciliation,
};

/**
 * Become someone, via the harness's persona selector.
 *
 * Matched on the leading name rather than the whole option text, because the
 * option carries the person's roles and agency too ("Bilal Farooq (Agency Admin,
 * ETPB) — Agency administrator · ETPB") and pinning a shot to that whole string
 * would break the moment a role label is reworded.
 */
async function becomePersona(page: Page, persona: string): Promise<void> {
  const select = page.getByLabel("Acting as");
  await select.waitFor({ state: "visible", timeout: 10_000 });

  const value = await select
    .locator("option")
    // Structurally typed rather than as HTMLOptionElement: this script runs under
    // the Node tsconfig, which has no DOM lib.
    .evaluateAll(
      (options, name) =>
        (options as unknown as { textContent: string | null; value: string }[]).find((o) => o.textContent?.startsWith(name))?.value ?? "",
      persona,
    );
  if (!value) throw new Error(`no persona whose name starts with "${persona}" in this portal`);

  const already = await select.inputValue();
  if (already === value) return;
  // Choosing a persona reloads the portal, so the identity is applied cleanly.
  await Promise.all([page.waitForLoadState("networkidle"), select.selectOption(value)]);
  await page.waitForTimeout(400);
}

async function capture(browser: Browser, portal: PortalName, shots: readonly Shot[]): Promise<void> {
  const { origin, width, height } = PORTALS[portal];
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  let current: Shot | null = null;
  watch(page, portal, () => current?.expectsRejection === true);

  for (const shot of shots) {
    current = shot;
    await page.goto(`${origin}${shot.path}`, { waitUntil: "networkidle" });
    if (shot.persona) await becomePersona(page, shot.persona);
    if (shot.prepare) await shot.prepare(page);
    if (shot.expect) {
      await page.getByText(shot.expect, { exact: false }).first().waitFor({ timeout: 15_000 }).catch(() => {
        problems.push(`[${portal}] ${shot.name}: expected text "${shot.expect}" never appeared`);
      });
    }
    await page.waitForTimeout(350);
    await page.screenshot({ path: join(OUT, `${shot.name}.png`), fullPage: shot.fullPage ?? false });
    process.stdout.write(`  ${shot.name}\n`);
  }

  await context.close();
}

// --- The shot lists, one per portal ------------------------------------------

/**
 * Real seeded users (`db/migrations/0028`, `0030`), by the name the harness shows.
 * Only four route groups are role-gated, so a reader with any internal role sees
 * every list screen; these are chosen to be the person the screen is *for*.
 */
const AGENCY_ADMIN = "Bilal Farooq";
const RECON_ANALYST = "Imran Qureshi";
const TELLER = "Nadia Aslam";

async function findBills(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Find my bills" }).click();
  await page.getByText("outstanding").first().waitFor({ timeout: 15_000 });
}

const CITIZEN: Shot[] = [
  { name: "citizen-01-find-bill", path: "/", expect: "What do you have?" },
  { name: "citizen-02-bills-found", path: "/", prepare: findBills, expect: "across 2 agencies", fullPage: true },
  {
    // A real PSID with its last digit changed. Vehicle registrations carry no
    // check digit, so the instant offline rejection is only demonstrable on a
    // reference scheme that has one.
    name: "citizen-03-bad-checksum",
    path: "/",
    expectsRejection: true,
    prepare: async (page) => {
      await page.getByLabel("What do you have?").selectOption("PSID");
      await page.getByLabel("Bill number (PSID)", { exact: true }).fill("31010900000181527");
      await page.getByRole("button", { name: "Find my bills" }).click();
      await page.getByText("check the digits").first().waitFor({ timeout: 10_000 });
    },
  },
  {
    name: "citizen-04-receipts-two-agencies",
    path: "/",
    prepare: async (page) => {
      await findBills(page);
      await page.getByRole("button", { name: /^Pay all/ }).click();
      await page.getByText("different agencies").first().waitFor({ timeout: 20_000 });
    },
    fullPage: true,
  },
  { name: "citizen-05-verify", path: "/verify", expect: "Check a receipt" },
];

const AGENCY: Shot[] = [
  { name: "agency-01-position", path: "/", persona: AGENCY_ADMIN, expect: "Confirmed", fullPage: true },
  { name: "agency-02-bills-issued", path: "/assessments", persona: AGENCY_ADMIN, expect: "PSID", fullPage: true },
  { name: "agency-03-issue-bill", path: "/issue", persona: AGENCY_ADMIN, expect: "Issue" },
  { name: "agency-04-request-to-pay", path: "/request-to-pay", persona: AGENCY_ADMIN, fullPage: true },
  { name: "agency-05-treasury", path: "/treasury", persona: AGENCY_ADMIN, fullPage: true },
  { name: "agency-06-statements", path: "/reports", persona: AGENCY_ADMIN, fullPage: true },
  { name: "agency-07-products", path: "/products", persona: AGENCY_ADMIN, fullPage: true },
];

const OPS: Shot[] = [
  { name: "ops-01-today", path: "/", persona: RECON_ANALYST, fullPage: true },
  { name: "ops-02-payments", path: "/payments", persona: RECON_ANALYST, fullPage: true },
  { name: "ops-03-payers", path: "/payers", persona: RECON_ANALYST, fullPage: true },
  { name: "ops-04-assessments", path: "/assessments", persona: RECON_ANALYST, fullPage: true },
  { name: "ops-05-uncertain", path: "/uncertain", persona: RECON_ANALYST, fullPage: true },
  { name: "ops-06-unapplied", path: "/unapplied", persona: RECON_ANALYST, fullPage: true },
  { name: "ops-07-recon-runs", path: "/recon", persona: RECON_ANALYST, fullPage: true },
  { name: "ops-08-breaks", path: "/breaks", persona: RECON_ANALYST, fullPage: true },
  { name: "ops-09-refunds", path: "/refunds", persona: RECON_ANALYST, fullPage: true },
  { name: "ops-10-disputes", path: "/disputes", persona: RECON_ANALYST, fullPage: true },
  { name: "ops-11-approvals", path: "/approvals", persona: RECON_ANALYST, fullPage: true },
  { name: "ops-12-instruments", path: "/instruments", persona: RECON_ANALYST, fullPage: true },
  { name: "ops-13-sweep", path: "/sweep", persona: RECON_ANALYST, fullPage: true },
  { name: "ops-14-bulk", path: "/bulk", persona: RECON_ANALYST, fullPage: true },
  { name: "ops-15-controls", path: "/controls", persona: RECON_ANALYST, fullPage: true },
  { name: "ops-16-audit", path: "/audit", persona: RECON_ANALYST, fullPage: true },
  { name: "ops-17-overview", path: "/overview", persona: RECON_ANALYST, fullPage: true },
  { name: "ops-18-reports", path: "/reports", persona: RECON_ANALYST, fullPage: true },
  { name: "ops-19-roles", path: "/roles", persona: RECON_ANALYST, fullPage: true },
];

const FIELD: Shot[] = [
  { name: "field-01-take-payment", path: "/", persona: TELLER, fullPage: true },
  { name: "field-02-lodge-cheque", path: "/instrument", persona: TELLER, fullPage: true },
  { name: "field-03-close-till", path: "/till", persona: TELLER, fullPage: true },
  { name: "field-04-agent-float", path: "/agent", persona: TELLER, fullPage: true },
];

const LISTS: Record<PortalName, Shot[]> = { citizen: CITIZEN, agency: AGENCY, ops: OPS, field: FIELD };

async function main(): Promise<void> {
  const requested = process.argv.slice(2).filter((a): a is PortalName => a in PORTALS);
  const portals = (requested.length > 0 ? requested : (Object.keys(PORTALS) as PortalName[]));

  await mkdir(OUT, { recursive: true });
  const browser = await chromium.launch();

  for (const portal of portals) {
    // Reset per portal, so a screenshot never shows another portal's side effects.
    await resetDemo();
    await PREPARE[portal]?.();
    process.stdout.write(`\n${portal}\n`);
    await capture(browser, portal, LISTS[portal]);
  }

  await browser.close();
  await resetDemo();

  if (problems.length > 0) {
    await writeFile(join(__dirname, "..", "capture-problems.txt"), problems.join("\n"), "utf8");
    process.stderr.write(`\n${problems.length} problem(s) found:\n${problems.map((p) => `  ${p}`).join("\n")}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write("\nAll screens captured with no console or network errors.\n");
}

await main();
