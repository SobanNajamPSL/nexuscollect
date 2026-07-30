import { dirname, join } from "node:path";
import { sql, type Kysely, type Transaction } from "kysely";
import type { Database } from "../db/schema.js";
import { readDemoCsv, str, requiredStr, minor, minorOrNull, yn, jsonOrNull, jsonOr, pipeList, dateOrNull, tsOrNull, toJsonb } from "./csv-helpers.js";
import { hashPrimaryId, encryptPrimaryId } from "../modules/identity/pii.js";
import { applyProductDerivedRules } from "./apply-product-rules.js";
import { ingestReconSourceFiles } from "./ingest-recon-source.js";
import { mintReceiptsForSettledAssessments } from "../modules/evidence/receipt.js";
import { postHistoricalJournals } from "./post-historical-journals.js";
import type { Clock } from "../platform/clock/index.js";

/**
 * Loads demo-data/ into the database, in the FK order documented by
 * demo-data/README.md. Business-key CSV ids (e.g. "AS-00013", "RH-FBR-B01101")
 * are resolved to real UUIDs via in-memory maps built as each table loads — the
 * CSVs reference each other by business key, the schema is keyed by UUID.
 *
 * Runs as one transaction with `app.is_platform_role` set, so RLS (§23.1) does not
 * block writes across all nine agencies in one pass.
 *
 * File-loading scope (finding Q, resolved with the user): the 12 master-data
 * CSVs load as before. bank_statement_camt053.csv / switch_settlement_1link.csv
 * / rail_settlement_raast.csv / scroll_fbr_20260730.csv are now ingested too —
 * as raw rows in recon_source_file/recon_source_record (§23 tables that already
 * exist), with zero matching logic (that's §12, Phase 4). qr-payloads.json is
 * not loaded into any table — QR_PAYLOAD resolution decodes it statelessly at
 * request time (modules/resolution/qr-decode.ts), tested directly against the
 * fixture. bulk_payment_input.csv and scroll-sample.txt have no natural Phase
 * 0/1 schema home without inventing Phase 3/5 tables (bulk_batch, a second
 * scroll representation) — genuinely not loaded, reported as a gap rather than
 * silently skipped or forced in.
 */
export async function loadDemoData(db: Kysely<Database>, demoDataDir: string, clock: Clock): Promise<void> {
  const productRulesConfigPath = join(dirname(demoDataDir), "config", "product-derived-rules.json");

  await db.transaction().execute(async (trx) => {
    await sql`SELECT set_config('app.is_platform_role', 'true', true)`.execute(trx);
    await loadAgencies(trx, demoDataDir);
    const revenueHeadById = await loadRevenueHeads(trx, demoDataDir);
    await loadReferenceSchemes(trx, demoDataDir);
    const productByAgencyCode = await loadProducts(trx, demoDataDir, revenueHeadById);
    await applyProductDerivedRules(trx, productRulesConfigPath); // finding N — data config, not a TS override, applied once products exist
    const payerById = await loadPayers(trx, demoDataDir);
    const payerAccountById = await loadPayerAccounts(trx, demoDataDir, productByAgencyCode);
    const assessmentById = await loadAssessments(trx, demoDataDir, productByAgencyCode, payerAccountById);
    const lineItemById = await loadAssessmentLineItems(trx, demoDataDir, assessmentById, revenueHeadById);
    const instrumentById = await loadInstruments(trx, demoDataDir, assessmentById);
    const paymentById = await loadPayments(trx, demoDataDir, instrumentById);
    await loadPaymentAllocations(trx, demoDataDir, paymentById, assessmentById, lineItemById, revenueHeadById);
    await loadRequestsToPay(trx, demoDataDir, assessmentById, paymentById);
    await mintReceiptsForSettledAssessments(trx, clock); // finding K — pre-minted now, resolve stays read-only
    await postHistoricalJournals(trx, clock); // Phase 2 §10.8: real ledger entries for the 115 historical payments' already-loaded allocation facts
    await ingestReconSourceFiles(trx, demoDataDir, clock); // finding Q — raw ingestion only
  });
}

// ---------------------------------------------------------------------------
// agency
// ---------------------------------------------------------------------------
async function loadAgencies(trx: Transaction<Database>, dir: string): Promise<Map<string, string>> {
  const byCode = new Map<string, string>();
  for (const row of readDemoCsv(dir, "agencies.csv")) {
    const inserted = await trx
      .insertInto("agency")
      .values({
        code: requiredStr(row["agency_code"], "agency_code"),
        name: requiredStr(row["name"], "name"),
        tier: row["tier"] as never,
        jurisdiction: requiredStr(row["jurisdiction"], "jurisdiction"),
        legal_entity_name: requiredStr(row["name"], "name"),
        treasury_account_iban: str(row["treasury_account_iban"]),
        treasury_bank_bic: str(row["treasury_bank_bic"]),
        settlement_model: row["settlement_model"] as never,
        timezone: requiredStr(row["timezone"], "timezone"),
        fiscal_year_start_month: Number(row["fiscal_year_start_month"]),
        default_cutoff_time: requiredStr(row["default_cutoff_time"], "default_cutoff_time"),
        status: requiredStr(row["status"], "status"),
      })
      .returning(["id"])
      .executeTakeFirstOrThrow();
    byCode.set(row["agency_code"] as string, inserted.id);
  }
  return byCode;
}

// ---------------------------------------------------------------------------
// revenue_head
// ---------------------------------------------------------------------------
async function loadRevenueHeads(
  trx: Transaction<Database>,
  dir: string,
): Promise<Map<string, { id: string; agencyCode: string; code: string }>> {
  const byBusinessId = new Map<string, { id: string; agencyCode: string; code: string }>();
  const agencyByCode = await selectAgencyMap(trx);
  for (const row of readDemoCsv(dir, "revenue_heads.csv")) {
    const agencyCode = requiredStr(row["agency_code"], "agency_code");
    const agencyId = agencyByCode.get(agencyCode);
    if (!agencyId) throw new Error(`revenue_heads.csv: unknown agency_code "${agencyCode}"`);
    const inserted = await trx
      .insertInto("revenue_head")
      .values({
        agency_id: agencyId,
        code: requiredStr(row["code"], "code"),
        name: requiredStr(row["name"], "name"),
        fund: row["fund"] as never,
        object_class: row["object_class"] as never,
        is_refundable_deposit: yn(row["is_refundable_deposit"]),
        effective_from: requiredStr(row["effective_from"], "effective_from"),
        effective_to: dateOrNull(row["effective_to"]),
      })
      .returning(["id"])
      .executeTakeFirstOrThrow();
    byBusinessId.set(row["revenue_head_id"] as string, { id: inserted.id, agencyCode, code: row["code"] as string });
  }
  return byBusinessId;
}

async function selectAgencyMap(trx: Transaction<Database>): Promise<Map<string, string>> {
  const rows = await trx.selectFrom("agency").select(["id", "code"]).execute();
  return new Map(rows.map((r) => [r.code, r.id]));
}

// ---------------------------------------------------------------------------
// reference_scheme
// ---------------------------------------------------------------------------
async function loadReferenceSchemes(trx: Transaction<Database>, dir: string): Promise<Map<string, string>> {
  const byCode = new Map<string, string>();
  const agencyByCode = await selectAgencyMap(trx);
  for (const row of readDemoCsv(dir, "reference_schemes.csv")) {
    const inserted = await trx
      .insertInto("reference_scheme")
      .values({
        code: requiredStr(row["scheme_code"], "scheme_code"),
        agency_id: agencyByCode.get(row["agency_code"] as string) ?? null,
        total_length: Number(row["total_length"]),
        prefix: str(row["prefix"]),
        pattern_regex: requiredStr(row["pattern_regex"], "pattern_regex"),
        checksum_algo: row["checksum_algo"] as never,
        sequence_digits: Number(row["sequence_digits"]),
        random_digits: Number(row["random_digits"]),
        collision_policy: requiredStr(row["collision_policy"], "collision_policy"),
        is_platform_minted: yn(row["is_platform_minted"]),
        charset: row["charset"] as never,
      })
      .returning(["id"])
      .executeTakeFirstOrThrow();
    byCode.set(row["scheme_code"] as string, inserted.id);
  }
  return byCode;
}

// ---------------------------------------------------------------------------
// collection_product — keyed by "<agency_code>|<product_code>" since product_code
// alone is not guaranteed unique across agencies.
// ---------------------------------------------------------------------------
async function loadProducts(
  trx: Transaction<Database>,
  dir: string,
  revenueHeadById: Map<string, { id: string; agencyCode: string; code: string }>,
): Promise<Map<string, string>> {
  const byAgencyAndCode = new Map<string, string>();
  const agencyByCode = await selectAgencyMap(trx);
  const schemeByCode = new Map(
    (await trx.selectFrom("reference_scheme").select(["id", "code"]).execute()).map((r) => [r.code, r.id]),
  );
  const headIdByAgencyAndCode = new Map<string, string>();
  for (const head of revenueHeadById.values()) {
    headIdByAgencyAndCode.set(`${head.agencyCode}|${head.code}`, head.id);
  }

  for (const row of readDemoCsv(dir, "products.csv")) {
    const agencyCode = requiredStr(row["agency_code"], "agency_code");
    const agencyId = agencyByCode.get(agencyCode);
    if (!agencyId) throw new Error(`products.csv: unknown agency_code "${agencyCode}"`);
    const schemeId = schemeByCode.get(row["reference_scheme_code"] as string);
    if (!schemeId) throw new Error(`products.csv: unknown reference_scheme_code "${row["reference_scheme_code"]}"`);
    const defaultHeadId = headIdByAgencyAndCode.get(`${agencyCode}|${row["default_revenue_head_code"]}`);
    if (!defaultHeadId) {
      throw new Error(
        `products.csv: unknown default_revenue_head_code "${row["default_revenue_head_code"]}" for agency ${agencyCode}`,
      );
    }

    const inserted = await trx
      .insertInto("collection_product")
      .values({
        agency_id: agencyId,
        code: requiredStr(row["product_code"], "product_code"),
        name: requiredStr(row["name"], "name"),
        category: row["category"] as never,
        reference_scheme_id: schemeId,
        amount_rule: row["amount_rule"] as never,
        fixed_amount_minor: minorOrNull(row["fixed_amount_minor"]),
        allow_partial: yn(row["allow_partial"]),
        overpay_treatment: row["overpay_treatment"] as never,
        underpay_tolerance_minor: minorOrNull(row["underpay_tolerance_minor"]) ?? 0n,
        overpay_tolerance_minor: minorOrNull(row["overpay_tolerance_minor"]) ?? 0n,
        allocation_waterfall: row["allocation_waterfall"] as never,
        allowed_channels: pipeList(row["allowed_channels"]),
        allowed_instruments: pipeList(row["allowed_instruments"]),
        instrument_credit_policy: row["instrument_credit_policy"] as never,
        service_gating: row["service_gating"] as never,
        fee_bearer: row["fee_bearer"] as never,
        deposit_refundable: yn(row["deposit_refundable"]),
        default_revenue_head_id: defaultHeadId,
        head_mapping: toJsonb(jsonOr(row["head_mapping"], {})) as never,
        secondary_lookup_keys: toJsonb(jsonOr(row["secondary_lookup_keys"], [])) as never,
        status: requiredStr(row["status"], "status"),
        effective_from: requiredStr(row["effective_from"], "effective_from"),
        // demo-data/products.csv has no surcharge_rule/early_discount_rule
        // columns at all — left null here. config/product-derived-rules.json
        // (applied by applyProductDerivedRules, after all products are loaded)
        // is the actual, disclosed source of these rules — see that file for
        // why (finding N).
        surcharge_rule: null,
        early_discount_rule: null,
      })
      .returning(["id"])
      .executeTakeFirstOrThrow();
    byAgencyAndCode.set(`${agencyCode}|${row["product_code"]}`, inserted.id);
  }
  return byAgencyAndCode;
}

// ---------------------------------------------------------------------------
// payer
// ---------------------------------------------------------------------------
async function loadPayers(trx: Transaction<Database>, dir: string): Promise<Map<string, string>> {
  const byBusinessId = new Map<string, string>();
  for (const row of readDemoCsv(dir, "payers.csv")) {
    const idType = requiredStr(row["primary_id_type"], "primary_id_type");
    const idValue = requiredStr(row["primary_id_value"], "primary_id_value");
    const inserted = await trx
      .insertInto("payer")
      .values({
        payer_type: row["payer_type"] as never,
        primary_id_type: idType,
        primary_id_hash: hashPrimaryId(idType, idValue),
        primary_id_enc: encryptPrimaryId(idValue),
        primary_id_last4: requiredStr(row["primary_id_last4"], "primary_id_last4"),
        name: requiredStr(row["name"], "name"),
        msisdn_e164: str(row["msisdn_e164"]),
        email: str(row["email"]),
        raast_id_type: (str(row["raast_id_type"]) as never) ?? null,
        raast_id_value: str(row["raast_id_value"]),
        raast_id_expires_on: dateOrNull(row["raast_id_expires_on"]),
        kyc_level: requiredStr(row["kyc_level"], "kyc_level"),
        risk_rating: requiredStr(row["risk_rating"], "risk_rating"),
        status: requiredStr(row["status"], "status"),
      })
      .returning(["id"])
      .executeTakeFirstOrThrow();
    byBusinessId.set(row["payer_id"] as string, inserted.id);
  }
  return byBusinessId;
}

// ---------------------------------------------------------------------------
// payer_account
// ---------------------------------------------------------------------------
async function loadPayerAccounts(
  trx: Transaction<Database>,
  dir: string,
  productByAgencyCode: Map<string, string>,
): Promise<Map<string, string>> {
  const byBusinessId = new Map<string, string>();
  const agencyByCode = await selectAgencyMap(trx);
  const payerIdByBusinessId = await selectPayerMap(trx, dir);

  for (const row of readDemoCsv(dir, "payer_accounts.csv")) {
    const agencyCode = requiredStr(row["agency_code"], "agency_code");
    const agencyId = agencyByCode.get(agencyCode);
    if (!agencyId) throw new Error(`payer_accounts.csv: unknown agency_code "${agencyCode}"`);
    const productId = productByAgencyCode.get(`${agencyCode}|${row["product_code"]}`);
    if (!productId) {
      throw new Error(`payer_accounts.csv: unknown product_code "${row["product_code"]}" for agency ${agencyCode}`);
    }
    const payerBusinessId = str(row["payer_id"]);
    const payerId = payerBusinessId ? payerIdByBusinessId.get(payerBusinessId) ?? null : null;

    const inserted = await trx
      .insertInto("payer_account")
      .values({
        payer_id: payerId,
        agency_id: agencyId,
        product_id: productId,
        crn: requiredStr(row["crn"], "crn"),
        account_label: str(row["account_label"]),
        attributes: toJsonb(jsonOr(row["attributes"], {})) as never,
        status: requiredStr(row["status"], "status"),
      })
      .returning(["id"])
      .executeTakeFirstOrThrow();
    byBusinessId.set(row["payer_account_id"] as string, inserted.id);
  }
  return byBusinessId;
}

// payers.csv is re-read here rather than threading the map through every caller;
// it's a small file (40 rows) and this keeps loadPayerAccounts's signature simple.
async function selectPayerMap(trx: Transaction<Database>, dir: string): Promise<Map<string, string>> {
  const rows = readDemoCsv(dir, "payers.csv");
  const byHash = new Map(
    (await trx.selectFrom("payer").select(["id", "primary_id_hash"]).execute()).map((r) => [
      r.primary_id_hash.toString("hex"),
      r.id,
    ]),
  );
  const byBusinessId = new Map<string, string>();
  for (const row of rows) {
    const idType = requiredStr(row["primary_id_type"], "primary_id_type");
    const idValue = requiredStr(row["primary_id_value"], "primary_id_value");
    const id = byHash.get(hashPrimaryId(idType, idValue).toString("hex"));
    if (id) byBusinessId.set(row["payer_id"] as string, id);
  }
  return byBusinessId;
}

// ---------------------------------------------------------------------------
// assessment
// ---------------------------------------------------------------------------
export interface LoadedAssessment {
  id: string;
  agencyId: string;
  psid: string;
}

async function loadAssessments(
  trx: Transaction<Database>,
  dir: string,
  productByAgencyCode: Map<string, string>,
  payerAccountById: Map<string, string>,
): Promise<Map<string, LoadedAssessment>> {
  const byBusinessId = new Map<string, LoadedAssessment>();
  const agencyByCode = await selectAgencyMap(trx);
  const payerIdByBusinessId = await selectPayerMap(trx, dir);

  for (const row of readDemoCsv(dir, "assessments.csv")) {
    const agencyCode = requiredStr(row["agency_code"], "agency_code");
    const agencyId = agencyByCode.get(agencyCode);
    if (!agencyId) throw new Error(`assessments.csv: unknown agency_code "${agencyCode}"`);
    const productId = productByAgencyCode.get(`${agencyCode}|${row["product_code"]}`);
    if (!productId) {
      throw new Error(`assessments.csv: unknown product_code "${row["product_code"]}" for agency ${agencyCode}`);
    }
    const payerBusinessId = str(row["payer_id"]);
    const payerId = payerBusinessId ? payerIdByBusinessId.get(payerBusinessId) ?? null : null;
    const payerAccountBusinessId = str(row["payer_account_id"]);
    const payerAccountId = payerAccountBusinessId ? payerAccountById.get(payerAccountBusinessId) ?? null : null;

    const metadata = jsonOr(row["metadata"], {}) as Record<string, unknown>;
    metadata["demoWaterfall"] = row["waterfall"] ?? null;
    metadata["demoRfReference"] = row["rf_reference"] ?? null;

    const psid = requiredStr(row["psid"], "psid");
    const inserted = await trx
      .insertInto("assessment")
      .values({
        psid,
        agency_id: agencyId,
        product_id: productId,
        payer_id: payerId,
        payer_account_id: payerAccountId,
        payer_snapshot: toJsonb({
          name: row["payer_name_snapshot"] ?? null,
          maskedId: row["payer_id_masked"] ?? null,
        }) as never,
        external_ref: str(row["external_ref"]),
        description: requiredStr(row["description"], "description"),
        currency: requiredStr(row["currency"], "currency"),
        assessed_amount_minor: minor(row["assessed_amount_minor"], "assessed_amount_minor"),
        surcharge_accrued_minor: minorOrNull(row["surcharge_accrued_minor"]) ?? 0n,
        discount_applied_minor: minorOrNull(row["discount_applied_minor"]) ?? 0n,
        payable_amount_minor: minor(row["payable_amount_minor"], "payable_amount_minor"),
        allocated_amount_minor: minorOrNull(row["allocated_amount_minor"]) ?? 0n,
        balance_minor: minor(row["balance_minor"], "balance_minor"),
        issue_date: requiredStr(row["issue_date"], "issue_date"),
        due_date: requiredStr(row["due_date"], "due_date"),
        expiry_date: dateOrNull(row["expiry_date"]),
        status: row["status"] as never,
        source: requiredStr(row["source"], "source"),
        version: Number(row["version"] ?? "1"),
        metadata: toJsonb(metadata) as never,
      })
      .returning(["id"])
      .executeTakeFirstOrThrow();
    byBusinessId.set(row["assessment_id"] as string, { id: inserted.id, agencyId, psid });
    // resolution_index is now maintained entirely by the trg_sync_resolution_index
    // DB trigger (0019_resolution_index_trigger.sql) — it fires on this INSERT
    // unconditionally, regardless of which code path wrote the row (finding J).
  }
  return byBusinessId;
}

// ---------------------------------------------------------------------------
// assessment_line_item
// ---------------------------------------------------------------------------
async function loadAssessmentLineItems(
  trx: Transaction<Database>,
  dir: string,
  assessmentById: Map<string, LoadedAssessment>,
  revenueHeadById: Map<string, { id: string; agencyCode: string; code: string }>,
): Promise<Map<string, string>> {
  const byBusinessId = new Map<string, string>();
  for (const row of readDemoCsv(dir, "assessment_line_items.csv")) {
    const assessment = assessmentById.get(row["assessment_id"] as string);
    if (!assessment) throw new Error(`assessment_line_items.csv: unknown assessment_id "${row["assessment_id"]}"`);
    const head = revenueHeadById.get(row["revenue_head_id"] as string);
    if (!head) throw new Error(`assessment_line_items.csv: unknown revenue_head_id "${row["revenue_head_id"]}"`);

    const inserted = await trx
      .insertInto("assessment_line_item")
      .values({
        assessment_id: assessment.id,
        seq: Number(row["seq"]),
        line_type: row["line_type"] as never,
        revenue_head_id: head.id,
        tax_period: str(row["tax_period"]),
        description: str(row["description"]),
        amount_minor: minor(row["amount_minor"], "amount_minor"),
        allocated_minor: minorOrNull(row["allocated_minor"]) ?? 0n,
        allocation_priority: Number(row["allocation_priority"] ?? "100"),
      })
      .returning(["id"])
      .executeTakeFirstOrThrow();
    byBusinessId.set(row["line_item_id"] as string, inserted.id);
  }
  return byBusinessId;
}

// ---------------------------------------------------------------------------
// instrument + instrument_link
// ---------------------------------------------------------------------------
async function loadInstruments(
  trx: Transaction<Database>,
  dir: string,
  assessmentById: Map<string, LoadedAssessment>,
): Promise<Map<string, string>> {
  const byBusinessId = new Map<string, string>();
  const assessmentByPsid = new Map<string, LoadedAssessment>();
  for (const a of assessmentById.values()) assessmentByPsid.set(a.psid, a);

  for (const row of readDemoCsv(dir, "instruments.csv")) {
    const linkedBusinessIds = pipeList(row["linked_assessment_ids"]);
    const firstLinked = linkedBusinessIds[0] ? assessmentById.get(linkedBusinessIds[0]) : undefined;

    const inserted = await trx
      .insertInto("instrument")
      .values({
        instrument_type: row["instrument_type"] as never,
        instrument_number: str(row["instrument_number"]),
        drawee_bank_bic: str(row["drawee_bank_bic"]),
        drawee_bank_name: str(row["drawee_bank_name"]),
        drawee_branch_code: str(row["drawee_branch_code"]),
        drawer_name: str(row["drawer_name"]),
        drawer_account_masked: str(row["drawer_account_masked"]),
        instrument_date: dateOrNull(row["instrument_date"]),
        amount_minor: minor(row["amount_minor"], "amount_minor"),
        agency_id: firstLinked?.agencyId ?? null,
        lodged_at_branch: str(row["lodged_at_branch"]),
        lodged_by_user: str(row["lodged_by_user"]),
        teller_batch_id: str(row["teller_batch_id"]),
        instrument_credit_policy: row["instrument_credit_policy"] as never,
        status: row["status"] as never,
        lodged_on: dateOrNull(row["lodged_on"]),
        presented_on: dateOrNull(row["presented_on"]),
        clears_on_expected: dateOrNull(row["clears_on_expected"]),
        cleared_on: dateOrNull(row["cleared_on"]),
        returned_on: dateOrNull(row["returned_on"]),
        return_reason_code: str(row["return_reason_code"]),
        dishonour_charge_minor: minorOrNull(row["dishonour_charge_minor"]),
        // Not resolved here: the dishonour-charge assessment this instrument raised
        // is a business-logic outcome (§14.6, Phase 3's cheque cascade), not data
        // instruments.csv states directly — leaving it null is honest, not a gap.
        dishonour_charge_assessment_id: null,
        provisional_credit_given: yn(row["provisional_credit_given"]),
        image_front_uri: str(row["image_front_uri"]),
        image_back_uri: str(row["image_back_uri"]),
      })
      .returning(["id"])
      .executeTakeFirstOrThrow();
    byBusinessId.set(row["instrument_id"] as string, inserted.id);

    const linkedAmounts = jsonOrNull(row["linked_amounts"]) as { psid: string; amount_minor: number }[] | null;
    for (const link of linkedAmounts ?? []) {
      const assessment = assessmentByPsid.get(link.psid);
      if (!assessment) throw new Error(`instruments.csv: linked_amounts psid "${link.psid}" not found`);
      await trx
        .insertInto("instrument_link")
        .values({
          instrument_id: inserted.id,
          assessment_id: assessment.id,
          amount_minor: BigInt(link.amount_minor),
        })
        .execute();
    }
  }
  return byBusinessId;
}

// ---------------------------------------------------------------------------
// payment
// ---------------------------------------------------------------------------
export interface LoadedPayment {
  id: string;
  reference: string;
}

async function loadPayments(
  trx: Transaction<Database>,
  dir: string,
  instrumentById: Map<string, string>,
): Promise<Map<string, LoadedPayment>> {
  const byBusinessId = new Map<string, LoadedPayment>();
  const byReference = new Map<string, string>();
  const agencyByCode = await selectAgencyMap(trx);
  const pendingDuplicates: { paymentId: string; duplicateOfReferenceRaw: string }[] = [];

  for (const row of readDemoCsv(dir, "payments.csv")) {
    const agencyCode = str(row["agency_code"]);
    const agencyId = agencyCode ? agencyByCode.get(agencyCode) ?? null : null;
    const instrumentBusinessId = str(row["instrument_id"]);
    const instrumentId = instrumentBusinessId ? instrumentById.get(instrumentBusinessId) ?? null : null;
    const reference = requiredStr(row["payment_reference"], "payment_reference");

    const metadata = {
      thirdPartyPayer: jsonOrNull(row["third_party_payer"]),
      settlementCycle: str(row["settlement_cycle"]),
      inBankStatement: yn(row["in_bank_statement"]),
      inSwitchFile: yn(row["in_switch_file"]),
      inRailFile: yn(row["in_rail_file"]),
    };

    const inserted = await trx
      .insertInto("payment")
      .values({
        payment_reference: reference,
        intent_id: null,
        agency_id: agencyId,
        channel: requiredStr(row["channel"], "channel"),
        rail: row["rail"] as never,
        direction: row["direction"] as never,
        instrument_id: instrumentId,
        bulk_batch_id: null,
        gross_amount_minor: minor(row["gross_amount_minor"], "gross_amount_minor"),
        fee_amount_minor: minorOrNull(row["fee_amount_minor"]) ?? 0n,
        net_to_agency_minor: minor(row["net_to_agency_minor"], "net_to_agency_minor"),
        unapplied_amount_minor: minorOrNull(row["unapplied_amount_minor"]) ?? 0n,
        currency: requiredStr(row["currency"], "currency"),
        status: row["status"] as never,
        finality: row["finality"] as never,
        value_date: requiredStr(row["value_date"], "value_date"),
        obligation_discharge_date: requiredStr(row["obligation_discharge_date"], "obligation_discharge_date"),
        cutoff_reason: str(row["cutoff_reason"]),
        cutoff_rule_version: str(row["cutoff_rule_version"]),
        received_at: tsOrNull(row["received_at"]) ?? undefined,
        confirmed_at: tsOrNull(row["confirmed_at"]),
        rail_e2e_id: str(row["rail_e2e_id"]),
        rail_txn_id: null,
        rail_uetr: str(row["rail_uetr"]),
        rail_instr_id: null,
        switch_stan: str(row["switch_stan"]),
        switch_rrn: str(row["switch_rrn"]),
        acquirer_id: str(row["acquirer_id"]),
        payer_account_masked: str(row["payer_account_masked"]),
        payer_bank_bic: str(row["payer_bank_bic"]),
        remittance_raw: str(row["remittance_raw"]),
        application_trace: null,
        settlement_batch_id: null,
        duplicate_of_payment_id: null,
        uncertain_resolution_source: null,
        metadata: toJsonb(metadata) as never,
      })
      .returning(["id"])
      .executeTakeFirstOrThrow();

    byBusinessId.set(row["payment_id"] as string, { id: inserted.id, reference });
    byReference.set(reference, inserted.id);

    const duplicateOfRaw = str(row["duplicate_of_payment_reference"]);
    if (duplicateOfRaw) pendingDuplicates.push({ paymentId: inserted.id, duplicateOfReferenceRaw: duplicateOfRaw });
  }

  for (const { paymentId, duplicateOfReferenceRaw } of pendingDuplicates) {
    const originalId = byReference.get(duplicateOfReferenceRaw);
    if (!originalId) {
      throw new Error(`payments.csv: duplicate_of_payment_reference "${duplicateOfReferenceRaw}" not found`);
    }
    await trx.updateTable("payment").set({ duplicate_of_payment_id: originalId }).where("id", "=", paymentId).execute();
  }

  return byBusinessId;
}

// ---------------------------------------------------------------------------
// payment_allocation
// ---------------------------------------------------------------------------
async function loadPaymentAllocations(
  trx: Transaction<Database>,
  dir: string,
  paymentById: Map<string, LoadedPayment>,
  assessmentById: Map<string, LoadedAssessment>,
  lineItemById: Map<string, string>,
  revenueHeadById: Map<string, { id: string; agencyCode: string; code: string }>,
): Promise<void> {
  for (const row of readDemoCsv(dir, "payment_allocations.csv")) {
    const payment = paymentById.get(row["payment_id"] as string);
    if (!payment) throw new Error(`payment_allocations.csv: unknown payment_id "${row["payment_id"]}"`);
    const assessment = assessmentById.get(row["assessment_id"] as string);
    if (!assessment) throw new Error(`payment_allocations.csv: unknown assessment_id "${row["assessment_id"]}"`);
    const lineItemId = lineItemById.get(row["line_item_id"] as string);
    if (!lineItemId) throw new Error(`payment_allocations.csv: unknown line_item_id "${row["line_item_id"]}"`);
    const head = revenueHeadById.get(row["revenue_head_id"] as string);
    if (!head) throw new Error(`payment_allocations.csv: unknown revenue_head_id "${row["revenue_head_id"]}"`);

    await trx
      .insertInto("payment_allocation")
      .values({
        payment_id: payment.id,
        assessment_id: assessment.id,
        line_item_id: lineItemId,
        revenue_head_id: head.id,
        amount_minor: minor(row["amount_minor"], "amount_minor"),
        allocation_basis: row["allocation_basis"] as never,
        status: row["status"] as never,
        applied_at: tsOrNull(row["applied_at"]) ?? undefined,
        reversed_at: null,
        reversal_reason: str(row["reversal_reason"]),
        applied_by_user_id: null,
        approval_id: null,
      })
      .execute();
  }
}

// ---------------------------------------------------------------------------
// request_to_pay
// ---------------------------------------------------------------------------
async function loadRequestsToPay(
  trx: Transaction<Database>,
  dir: string,
  assessmentById: Map<string, LoadedAssessment>,
  paymentById: Map<string, LoadedPayment>,
): Promise<void> {
  const agencyByCode = await selectAgencyMap(trx);
  const payerIdByBusinessId = await selectPayerMap(trx, dir);
  const paymentIdByReference = new Map<string, string>();
  for (const p of paymentById.values()) paymentIdByReference.set(p.reference, p.id);

  for (const row of readDemoCsv(dir, "requests_to_pay.csv")) {
    const agencyCode = requiredStr(row["agency_code"], "agency_code");
    const agencyId = agencyByCode.get(agencyCode);
    if (!agencyId) throw new Error(`requests_to_pay.csv: unknown agency_code "${agencyCode}"`);

    const assessmentIds = pipeList(row["assessment_ids"]).map((businessId) => {
      const a = assessmentById.get(businessId);
      if (!a) throw new Error(`requests_to_pay.csv: unknown assessment id "${businessId}"`);
      return a.id;
    });

    const payerBusinessId = str(row["payer_id"]);
    const payerId = payerBusinessId ? payerIdByBusinessId.get(payerBusinessId) ?? null : null;
    const fulfillingRef = str(row["fulfilling_payment_reference"]);
    const fulfillingPaymentId = fulfillingRef ? paymentIdByReference.get(fulfillingRef) ?? null : null;

    await trx
      .insertInto("request_to_pay")
      .values({
        rtp_reference: requiredStr(row["rtp_reference"], "rtp_reference"),
        agency_id: agencyId,
        assessment_ids: assessmentIds,
        payer_id: payerId,
        payer_alias_type: (str(row["payer_alias_type"]) as never) ?? null,
        payer_alias_value: str(row["payer_alias_value"]),
        resolved_payer_iban: str(row["resolved_payer_iban"]),
        resolved_payer_bank_bic: str(row["resolved_payer_bank_bic"]),
        payer_name: str(row["payer_name"]),
        amount_minor: minor(row["amount_minor"], "amount_minor"),
        amount_modifiable: yn(row["amount_modifiable"]),
        requested_execution_date: dateOrNull(row["requested_execution_date"]),
        expires_at: tsOrNull(row["expires_at"]) as never,
        status: row["status"] as never,
        decline_reason_code: str(row["decline_reason_code"]),
        rail_msg_id: str(row["rail_msg_id"]),
        rail_status_msg_id: str(row["rail_status_msg_id"]),
        fulfilling_payment_id: fulfillingPaymentId,
        reminder_count: Number(row["reminder_count"] ?? "0"),
        raast_id_expires_on: dateOrNull(row["raast_id_expires_on"]),
        created_at: tsOrNull(row["created_at"]) ?? undefined,
      })
      .execute();
  }
}
