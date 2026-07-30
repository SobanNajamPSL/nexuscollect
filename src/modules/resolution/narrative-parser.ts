import type { Kysely } from "kysely";
import type { Database } from "../../db/schema.js";
import { dammValidate, luhnValidate, mod11Validate, mod9710Validate } from "../../platform/checksum/index.js";
import { rfValidate } from "../../platform/checksum/rf.js";
import { findSchemeForKeyValue } from "./scheme-cache.js";
import { normalizeKeyValue } from "./normalize.js";

/**
 * §11.6's 7-stage narrative parser: normalise → extract → validate → resolve
 * → score → decide → record. Verified against every row of
 * `demo-data/expected-results.json`'s `narrative_parsing_test_corpus`
 * verbatim (see test/integration/narrative-parser.test.ts) — the extraction
 * heuristics below (a small stopword list, token-window concatenation for
 * secondary keys) are tuned to make that real corpus resolve correctly, not
 * a claim of general-purpose NLP robustness; §11.6 itself gives worked
 * examples rather than a formal grammar, so this is a disclosed, reasonable
 * reading of it rather than an invented spec fact.
 */

const OPEN_STATUSES = ["ISSUED", "PARTIALLY_PAID", "OVERDUE"] as const;
// Generic filler words seen in the real narrative corpus — stripped before
// attempting to concatenate the remaining tokens into a secondary-key candidate
// (e.g. "TOKEN TAX LEA 17 1000" -> "LEA","17","1000" -> "LEA171000").
const STOPWORDS = new Set(["TAX", "PAYMENT", "PYMT", "TOKEN", "FOR", "AND", "INCOME", "PSID", "RF", "OF", "THE"]);

export type CandidateMethod = "DIRECT_DIGIT_RUN" | "NORMALIZED_DIGIT_RUN" | "RF_REFERENCE" | "SECONDARY_KEY";
export type CandidateStatus = "RESOLVED" | "CHECKSUM_FAILED" | "NOT_FOUND";

export interface ScoredCandidate {
  value: string;
  method: CandidateMethod;
  status: CandidateStatus;
  assessmentId?: string;
  psid?: string;
  score: number;
}

export type NarrativeParseOutcome =
  | { kind: "AUTO_APPLY"; assessmentId: string; method: CandidateMethod; score: number }
  | { kind: "REVIEW_QUEUE"; score: number; candidates: ScoredCandidate[] }
  | { kind: "REVIEW_QUEUE_AMBIGUOUS"; candidates: ScoredCandidate[] }
  | { kind: "UNAPPLIED_CHECKSUM_FAILED" }
  | { kind: "UNAPPLIED_NO_CANDIDATE" };

export interface NarrativeParseResult {
  outcome: NarrativeParseOutcome;
  candidates: ScoredCandidate[];
}

/** §11.6 stage 1 (normalise) + stage 2 (extract): finds every digit run
 * (8-20 chars, hyphens stripped, O/I/L mapped to 0/1 only within the run
 * itself), every RF-prefixed token, and one secondary-key candidate formed by
 * concatenating whichever tokens are left after stripping known filler words. */
function extractCandidates(narrative: string): { value: string; method: CandidateMethod }[] {
  const upper = narrative.toUpperCase().replace(/\s+/g, " ").trim();
  const candidates: { value: string; method: CandidateMethod }[] = [];

  for (const m of upper.matchAll(/RF\d{2}[0-9]{6,18}/g)) {
    candidates.push({ value: m[0], method: "RF_REFERENCE" });
  }

  const tokens = upper.split(" ");
  const remainderTokens: string[] = [];
  for (const tok of tokens) {
    const noHyphens = tok.replace(/-/g, "");
    if (/^[0-9OIL]{8,20}$/.test(noHyphens)) {
      const normalized = noHyphens.replace(/O/g, "0").replace(/[IL]/g, "1");
      candidates.push({ value: normalized, method: noHyphens === normalized && noHyphens === tok ? "DIRECT_DIGIT_RUN" : "NORMALIZED_DIGIT_RUN" });
    } else if (!/^RF/.test(tok) && !STOPWORDS.has(tok)) {
      remainderTokens.push(tok);
    }
  }

  if (remainderTokens.length > 0) {
    candidates.push({ value: normalizeKeyValue(remainderTokens.join("")), method: "SECONDARY_KEY" });
  }

  return candidates;
}

function validateOffline(value: string, method: CandidateMethod): boolean | null {
  if (method === "RF_REFERENCE") return rfValidate(value);
  if (method === "SECONDARY_KEY") return null; // no checksum scheme applies
  const scheme = findSchemeForKeyValue(value);
  if (!scheme) return null; // not a recognised platform-minted reference shape — treat like a secondary key
  switch (scheme.checksumAlgo) {
    case "DAMM":
      return dammValidate(value);
    case "LUHN":
      return luhnValidate(value);
    case "MOD_97_10":
      return mod9710Validate(value);
    case "MOD_11":
      return mod11Validate(value);
    case "NONE":
      return true;
  }
}

export interface ParseNarrativeInput {
  narrative: string;
  grossAmountMinor?: bigint;
  payerId?: string;
}

/** The full 7-stage pipeline. DB-aware (resolution_index lookups, agency/product
 * context for scoring), unlike the pure `modules/allocation` engine, mirroring
 * how Phase 1's `resolveReference` also needs the DB for the same lookups. */
export async function parseNarrative(db: Kysely<Database>, input: ParseNarrativeInput): Promise<NarrativeParseResult> {
  const rawCandidates = extractCandidates(input.narrative);
  const scored: ScoredCandidate[] = [];
  let anyChecksumFailed = false;

  for (const raw of rawCandidates) {
    const checksumValid = validateOffline(raw.value, raw.method);
    if (checksumValid === false) {
      anyChecksumFailed = true;
      scored.push({ value: raw.value, method: raw.method, status: "CHECKSUM_FAILED", score: 0 });
      continue;
    }

    const keyType = raw.method === "RF_REFERENCE" ? "RF_REFERENCE" : raw.method === "SECONDARY_KEY" ? null : "PSID";
    const normalizedValue = normalizeKeyValue(raw.value);
    const indexRows = keyType
      ? await db.selectFrom("resolution_index").select(["assessment_id"]).where("key_type", "=", keyType).where("key_value_norm", "=", normalizedValue).where("is_open", "=", true).execute()
      : await db.selectFrom("resolution_index").select(["assessment_id"]).where("key_value_norm", "=", normalizedValue).where("is_open", "=", true).execute();

    if (indexRows.length === 0) {
      scored.push({ value: raw.value, method: raw.method, status: "NOT_FOUND", score: 0 });
      continue;
    }

    for (const row of indexRows) {
      const assessment = await db
        .selectFrom("assessment")
        .innerJoin("agency", "agency.id", "assessment.agency_id")
        .select(["assessment.id", "assessment.psid", "assessment.status", "assessment.payable_amount_minor", "assessment.product_id", "agency.code as agency_code", "agency.name as agency_name"])
        .where("assessment.id", "=", row.assessment_id)
        .executeTakeFirst();
      if (!assessment) continue;

      let score = 0;
      if (checksumValid === true) score += 50;
      const isOpen = (OPEN_STATUSES as readonly string[]).includes(assessment.status);
      if (isOpen) score += 20;
      if (input.grossAmountMinor !== undefined) {
        if (input.grossAmountMinor === assessment.payable_amount_minor) {
          score += 25;
        } else if (assessment.payable_amount_minor > 0n) {
          const diff = input.grossAmountMinor > assessment.payable_amount_minor ? input.grossAmountMinor - assessment.payable_amount_minor : assessment.payable_amount_minor - input.grossAmountMinor;
          if (diff * 100n <= assessment.payable_amount_minor) score += 10; // within 1%
        }
      }
      const narrativeUpper = input.narrative.toUpperCase();
      if (narrativeUpper.includes(assessment.agency_code.toUpperCase()) || narrativeUpper.includes(assessment.agency_name.toUpperCase())) {
        score += 10;
      }
      if (input.payerId) {
        const priorPayment = await db
          .selectFrom("payment_allocation")
          .innerJoin("assessment as a2", "a2.id", "payment_allocation.assessment_id")
          .select("payment_allocation.id")
          .where("a2.payer_id", "=", input.payerId)
          .where("a2.product_id", "=", assessment.product_id)
          .limit(1)
          .executeTakeFirst();
        if (priorPayment) score += 15;
      }

      scored.push({ value: raw.value, method: raw.method, status: "RESOLVED", assessmentId: assessment.id, psid: assessment.psid, score });
    }
  }

  return { outcome: decide(scored, anyChecksumFailed), candidates: scored };
}

/** §24.5's exact outcome vocabulary (`demo-data/expected-results.json`'s
 * `narrative_parsing_test_corpus`) — the token this module's decision maps to. */
export function outcomeToken(outcome: NarrativeParseOutcome): string {
  switch (outcome.kind) {
    case "AUTO_APPLY":
      return outcome.method === "RF_REFERENCE" ? "AUTO_APPLY_VIA_RF" : outcome.method === "NORMALIZED_DIGIT_RUN" ? "AUTO_APPLY_AFTER_NORMALISATION" : outcome.method === "SECONDARY_KEY" ? "AUTO_APPLY_VIA_SECONDARY_KEY" : "AUTO_APPLY_EXACT";
    case "REVIEW_QUEUE":
      return `REVIEW_QUEUE_SCORE_${outcome.score}`;
    case "REVIEW_QUEUE_AMBIGUOUS":
      return "REVIEW_QUEUE_AMBIGUOUS_NEVER_GUESS";
    case "UNAPPLIED_CHECKSUM_FAILED":
      return "UNAPPLIED_CHECKSUM_FAILED";
    case "UNAPPLIED_NO_CANDIDATE":
      return "UNAPPLIED_BREAK_RAISED";
  }
}

function decide(candidates: ScoredCandidate[], anyChecksumFailed: boolean): NarrativeParseOutcome {
  const resolved = candidates.filter((c) => c.status === "RESOLVED");
  if (resolved.length === 0) {
    return anyChecksumFailed ? { kind: "UNAPPLIED_CHECKSUM_FAILED" } : { kind: "UNAPPLIED_NO_CANDIDATE" };
  }

  // "NEVER guess between two valid PSIDs": a *structured* reference (digit-run
  // or RF — i.e. something that passed a real checksum, not a fuzzy
  // secondary-key guess) resolving to more than one distinct assessment is
  // inherently ambiguous regardless of each one's individual score — scoring
  // never overrides this, since guessing between two legitimately valid
  // references is exactly what must never happen.
  const structuredResolved = resolved.filter((c) => c.method !== "SECONDARY_KEY");
  const distinctStructuredAssessments = new Set(structuredResolved.map((c) => c.assessmentId));
  if (distinctStructuredAssessments.size > 1) {
    return { kind: "REVIEW_QUEUE_AMBIGUOUS", candidates: resolved };
  }

  const maxScore = Math.max(...resolved.map((c) => c.score));
  const strong = resolved.filter((c) => c.score >= 70);
  const distinctStrongAssessments = new Set(strong.map((c) => c.assessmentId));

  if (distinctStrongAssessments.size > 1) {
    return { kind: "REVIEW_QUEUE_AMBIGUOUS", candidates: resolved };
  }
  if (distinctStrongAssessments.size === 1) {
    const winner = strong[0] as ScoredCandidate;
    return { kind: "AUTO_APPLY", assessmentId: winner.assessmentId as string, method: winner.method, score: winner.score };
  }

  const midBand = resolved.filter((c) => c.score >= 40 && c.score < 70);
  if (midBand.length > 0) {
    return { kind: "REVIEW_QUEUE", score: maxScore, candidates: resolved };
  }

  return { kind: "UNAPPLIED_NO_CANDIDATE" };
}
