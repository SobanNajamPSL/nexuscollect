import "dotenv/config";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "./build-app.js";
import { getDb } from "../db/client.js";
import { createClock } from "../platform/clock/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEMO_DATA_DIR = join(__dirname, "..", "..", "demo-data");

/**
 * Runtime entrypoint. Phase 1 adds the first real endpoint, `POST /v1/resolve`
 * (§8.2) — everything else is still deferred (Phase 0's `/health` stays for
 * Docker Compose's healthcheck target).
 */
async function main(): Promise<void> {
  const db = getDb();
  const clock = createClock();
  const app = await buildApp({ db, clock, demoDataDir: DEMO_DATA_DIR });

  const port = Number(process.env["API_PORT"] ?? 3000);
  await app.listen({ port, host: "0.0.0.0" });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
