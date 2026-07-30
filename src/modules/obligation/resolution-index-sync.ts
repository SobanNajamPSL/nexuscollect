import type { Kysely, Transaction } from "kysely";
import type { Database } from "../../db/schema.js";
import { rfEncode } from "../../platform/checksum/rf.js";

/**
 * §7.5's resolvable keys, one row per (key_type, key_value) an assessment can
 * be found by. Populated in application code within the same transaction as
 * the assessment write (Prompt 1 allows "trigger or outbox" — this is a third
 * same-transaction option, chosen because RF/Damm encoding already exists in
 * TypeScript (platform/checksum) and duplicating that math in plpgsql would
 * be pure risk for no benefit).
 *
 * Only the key types resolvable via `resolution_index` are handled here:
 * PSID, RF_REFERENCE, CRN, VEHICLE_REG, CASE_NO, APPLICATION_NO. The
 * identity-keyed types (CNIC/NTN/STRN/RAAST_ID) resolve via a direct
 * `assessment.payer_id` lookup instead (see modules/resolution) — a payer's
 * open assessments span every agency they owe money to, which a per-assessment
 * index row can't express any more naturally than a straight join can.
 */

interface AssessmentForIndexing {
  id: string;
  agencyId: string;
  psid: string;
  payerAccountId: string | null;
  metadata: Record<string, unknown>;
  referenceSchemeTotalLength: number;
  referenceSchemeCode: string;
}

function candidateKeys(a: AssessmentForIndexing, crn: string | null): { keyType: string; keyValue: string }[] {
  const keys: { keyType: string; keyValue: string }[] = [{ keyType: "PSID", keyValue: a.psid }];

  // RF wrapping only applies to the platform's 17-digit main PSID schemes —
  // confirmed against demo-data: CRN-WASA-13 (13 digits) and LEGACY-NADRA-14
  // (14 digits, Luhn) both carry an empty rf_reference for every assessment,
  // even though WASA's scheme is also DAMM + platform-minted. Length is the
  // actual distinguishing factor, not checksum_algo or is_platform_minted.
  if (a.referenceSchemeTotalLength === 17) {
    keys.push({ keyType: "RF_REFERENCE", keyValue: rfEncode(a.psid) });
  }

  if (crn) keys.push({ keyType: "CRN", keyValue: crn });

  // Secondary lookup keys carried directly on the assessment (confirmed
  // against demo-data: assessment.metadata->>'vehicle_reg' / 'case_no' are
  // present even when payer_account_id is null — e.g. the PSCA traffic
  // challans linked to LEA-17-1000 have no payer_account row of their own).
  const metaKeyByType: Record<string, string> = {
    VEHICLE_REG: "vehicle_reg",
    CASE_NO: "case_no",
    APPLICATION_NO: "application_no",
  };
  for (const [keyType, metaField] of Object.entries(metaKeyByType)) {
    const value = a.metadata[metaField];
    if (typeof value === "string" && value.length > 0) keys.push({ keyType, keyValue: value });
  }

  return keys;
}

function normalize(keyValue: string): string {
  return keyValue.trim().toUpperCase();
}

/**
 * Closes every open resolution_index row for an assessment (used when it's
 * amended, cancelled, or settled — the old version must stop resolving) and,
 * if the assessment is still open, writes fresh rows for its current keys.
 * Call within the same transaction as the assessment write.
 */
export async function syncResolutionIndex(
  trx: Transaction<Database> | Kysely<Database>,
  assessmentId: string,
  isStillOpen: boolean,
): Promise<void> {
  await trx
    .updateTable("resolution_index")
    .set({ is_open: false })
    .where("assessment_id", "=", assessmentId)
    .where("is_open", "=", true)
    .execute();

  if (!isStillOpen) return;

  const assessment = await trx
    .selectFrom("assessment")
    .innerJoin("collection_product", "collection_product.id", "assessment.product_id")
    .innerJoin("reference_scheme", "reference_scheme.id", "collection_product.reference_scheme_id")
    .innerJoin("payer_account", "payer_account.id", "assessment.payer_account_id")
    .select([
      "assessment.id",
      "assessment.agency_id",
      "assessment.psid",
      "assessment.payer_account_id",
      "assessment.metadata",
      "reference_scheme.total_length as reference_scheme_total_length",
      "reference_scheme.code as reference_scheme_code",
      "payer_account.crn",
    ])
    .where("assessment.id", "=", assessmentId)
    .executeTakeFirst();

  // payer_account_id may be null (e.g. the PSCA challans) — re-fetch without
  // the inner join in that case, just missing a CRN key.
  const row =
    assessment ??
    (await trx
      .selectFrom("assessment")
      .innerJoin("collection_product", "collection_product.id", "assessment.product_id")
      .innerJoin("reference_scheme", "reference_scheme.id", "collection_product.reference_scheme_id")
      .select([
        "assessment.id",
        "assessment.agency_id",
        "assessment.psid",
        "assessment.payer_account_id",
        "assessment.metadata",
        "reference_scheme.total_length as reference_scheme_total_length",
        "reference_scheme.code as reference_scheme_code",
      ])
      .where("assessment.id", "=", assessmentId)
      .executeTakeFirstOrThrow());

  const forIndexing: AssessmentForIndexing = {
    id: row.id,
    agencyId: row.agency_id,
    psid: row.psid,
    payerAccountId: row.payer_account_id,
    metadata: row.metadata as Record<string, unknown>,
    referenceSchemeTotalLength: row.reference_scheme_total_length,
    referenceSchemeCode: row.reference_scheme_code,
  };
  const crn = "crn" in row ? (row.crn as string) : null;

  for (const { keyType, keyValue } of candidateKeys(forIndexing, crn)) {
    await trx
      .insertInto("resolution_index")
      .values({
        agency_id: forIndexing.agencyId,
        key_type: keyType,
        key_value_norm: normalize(keyValue),
        key_value_raw: keyValue,
        assessment_id: assessmentId,
        is_open: true,
      })
      .onConflict((oc) => oc.columns(["key_type", "key_value_norm", "assessment_id"]).doUpdateSet({ is_open: true }))
      .execute();
  }
}
