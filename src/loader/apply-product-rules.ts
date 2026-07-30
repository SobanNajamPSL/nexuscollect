import { readFileSync } from "node:fs";
import type { Kysely, Transaction } from "kysely";
import type { Database } from "../db/schema.js";
import { toJsonb } from "./csv-helpers.js";

/**
 * Finding N (audit): applies config/product-derived-rules.json — genuine
 * project configuration, not demo-data and not a TypeScript code-branch keyed
 * on product code (the old product-rule-overrides.ts, deleted). A new
 * product's derived-amount rule is now an edit to that JSON file; this
 * function is fully generic over whatever `rules[]` entries it contains.
 * Runs after products have been loaded (products only exist once the loader
 * has inserted them, so this can't be a migration — migrations run before
 * any data exists).
 */
interface ProductRuleEntry {
  product_code: string;
  surcharge_rule?: unknown;
  early_discount_rule?: unknown;
  rounding_rule?: string;
}

export async function applyProductDerivedRules(
  db: Kysely<Database> | Transaction<Database>,
  configPath: string,
): Promise<void> {
  const config = JSON.parse(readFileSync(configPath, "utf8")) as { rules: ProductRuleEntry[] };

  for (const rule of config.rules) {
    const update: Record<string, unknown> = {};
    if (rule.surcharge_rule !== undefined) update["surcharge_rule"] = toJsonb(rule.surcharge_rule);
    if (rule.early_discount_rule !== undefined) update["early_discount_rule"] = toJsonb(rule.early_discount_rule);
    if (rule.rounding_rule !== undefined) update["rounding_rule"] = rule.rounding_rule;

    if (Object.keys(update).length === 0) continue;

    await db
      .updateTable("collection_product")
      .set(update as never)
      .where("code", "=", rule.product_code)
      .execute();
  }
}
