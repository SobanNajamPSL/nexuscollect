import type { Kysely, Transaction } from "kysely";
import type { Database } from "../../db/schema.js";
import { dammCheckDigit, luhnCheckDigit } from "../../platform/checksum/index.js";

/**
 * Platform PSID minting.
 *
 * Phase 1 deliberately refused to do this and required the caller to supply a
 * PSID, on the grounds that inventing a reference layout would breach the
 * never-fabricate-a-reference rule. That was the right call at the time, but it
 * had a consequence that only became visible once an agency portal existed: an
 * agency could not issue a bill at all, because no finance officer can compose a
 * 17-digit reference with a correct Damm check digit by hand.
 *
 * The layout is not, in fact, undocumented. `reference_scheme` carries every
 * component (prefix, total_length, sequence_digits, random_digits,
 * checksum_algo, is_platform_minted), and `scripts/generate_demo_data.py` —
 * which produced every real PSID in the dataset — composes them as:
 *
 *     prefix(n) + product_code(4) + sequence + random + check digit
 *
 * e.g. FBR `12010100001359715` = `12` + `0101` + `000013` + `5971` + `5`.
 *
 * Two disclosed choices, both narrower than the generator rather than invented:
 *
 * 1. **The body is a pure sequence, with no random digits.** The generator uses
 *    six sequence digits plus four random. A minted PSID is shown on camera, and
 *    the demo must be reproducible take after take, so randomness is not
 *    available here. Zero-padding the sequence across the whole body satisfies
 *    prefix, length, charset and check digit identically.
 *
 * 2. **The 4-digit product code is read from the product's existing bills**
 *    rather than recomputed, so a minted PSID sorts and reads alongside the
 *    seeded ones. A product with no bills yet has no established code, so it is
 *    assigned the next unused one within its scheme.
 */

export class PsidNotMintableError extends Error {
  readonly httpStatus = 422;
  readonly code = "INVALID_REFERENCE_FORMAT";
  constructor(schemeCode: string) {
    super(
      `Reference scheme "${schemeCode}" is not platform-minted — the agency issues its own references under this scheme, so psid must be supplied explicitly.`,
    );
    this.name = "PsidNotMintableError";
  }
}

const PRODUCT_CODE_DIGITS = 4;

function checkDigitFor(algo: string, stem: string): string {
  switch (algo) {
    case "DAMM":
      return String(dammCheckDigit(stem));
    case "LUHN":
      return String(luhnCheckDigit(stem));
    case "NONE":
      return "";
    default:
      // MOD_97_10 / MOD_11 produce two digits or need a different stem shape;
      // no seeded platform-minted scheme uses them, so rather than guess, say so.
      throw new Error(`PSID minting for checksum algorithm ${algo} is not implemented`);
  }
}

export async function mintPsid(
  db: Kysely<Database> | Transaction<Database>,
  productId: string,
  referenceSchemeId: string,
): Promise<string> {
  const scheme = await db
    .selectFrom("reference_scheme")
    .select(["code", "prefix", "total_length", "checksum_algo", "is_platform_minted"])
    .where("id", "=", referenceSchemeId)
    .executeTakeFirstOrThrow();

  if (!scheme.is_platform_minted) throw new PsidNotMintableError(scheme.code);

  const prefix = scheme.prefix ?? "";

  // The product's established 4-digit code, taken from a bill it has already
  // issued. Substring is 1-indexed in Postgres.
  const existing = await db
    .selectFrom("assessment")
    .select("psid")
    .where("product_id", "=", productId)
    .orderBy("psid", "asc")
    .limit(1)
    .executeTakeFirst();

  let productCode: string;
  if (existing) {
    productCode = existing.psid.slice(prefix.length, prefix.length + PRODUCT_CODE_DIGITS);
  } else {
    // A product that has never issued a bill has no established code yet. Take
    // the next unused one within this scheme so it cannot collide with a sibling.
    const siblings = await db
      .selectFrom("assessment")
      .innerJoin("collection_product", "collection_product.id", "assessment.product_id")
      .select("assessment.psid")
      .where("collection_product.reference_scheme_id", "=", referenceSchemeId)
      .execute();
    const used = new Set(siblings.map((r) => r.psid.slice(prefix.length, prefix.length + PRODUCT_CODE_DIGITS)));
    let next = 1;
    while (used.has(String(next).padStart(PRODUCT_CODE_DIGITS, "0"))) next++;
    productCode = String(next).padStart(PRODUCT_CODE_DIGITS, "0");
  }

  const stemPrefix = prefix + productCode;
  const checkDigits = scheme.checksum_algo === "NONE" ? 0 : 1;
  const bodyLength = scheme.total_length - stemPrefix.length - checkDigits;
  if (bodyLength <= 0) throw new Error(`Reference scheme ${scheme.code} leaves no room for a sequence body`);

  // Next sequence for this product: the highest body already issued, plus one.
  // Deterministic, so a reset followed by the same actions mints the same PSID.
  const issued = await db
    .selectFrom("assessment")
    .select("psid")
    .where("psid", "like", `${stemPrefix}%`)
    .execute();
  let maxBody = 0;
  for (const row of issued) {
    const body = Number(row.psid.slice(stemPrefix.length, stemPrefix.length + bodyLength));
    if (Number.isFinite(body) && body > maxBody) maxBody = body;
  }

  const stem = stemPrefix + String(maxBody + 1).padStart(bodyLength, "0");
  return stem + checkDigitFor(scheme.checksum_algo, stem);
}
