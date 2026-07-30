import "dotenv/config";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, createPool } from "../src/db/client.js";
import { loadDemoData } from "../src/loader/index.js";
import { createClock } from "../src/platform/clock/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEMO_DATA_DIR = join(__dirname, "..", "demo-data");

async function main(): Promise<void> {
  const connectionString = process.env["DATABASE_URL"];
  if (!connectionString) throw new Error("DATABASE_URL is not set");
  const pool = createPool(connectionString);
  const db = createDb(pool);
  try {
    await loadDemoData(db, DEMO_DATA_DIR, createClock());
    console.log("Demo data loaded.");
  } finally {
    await db.destroy();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
