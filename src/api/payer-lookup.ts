import type { Kysely } from "kysely";
import type { Database } from "../db/schema.js";
import { hashPrimaryId, encryptPrimaryId } from "../modules/identity/pii.js";
import type { Clock } from "../platform/clock/index.js";

export interface PayerInput {
  payer_type?: "INDIVIDUAL" | "SOLE_PROPRIETOR" | "AOP" | "COMPANY" | "GOVERNMENT" | "NON_RESIDENT";
  primary_id_type?: string;
  primary_id_value?: string;
  name?: string;
  msisdn_e164?: string;
  email?: string;
}

/** createAssessment's `payer_id` (existing payer) or inline `payer` (find-or-create
 * by primary_id_hash, same keyed-hash lookup the resolve identity path uses). */
export async function resolvePayer(db: Kysely<Database>, payerId: string | undefined, payer: PayerInput | undefined, clock: Clock): Promise<string | undefined> {
  if (payerId) return payerId;
  if (!payer?.primary_id_type || !payer.primary_id_value || !payer.name) return undefined;

  const hash = hashPrimaryId(payer.primary_id_type, payer.primary_id_value);
  const existing = await db.selectFrom("payer").select("id").where("primary_id_hash", "=", hash).executeTakeFirst();
  if (existing) return existing.id;

  const inserted = await db
    .insertInto("payer")
    .values({
      payer_type: payer.payer_type ?? "INDIVIDUAL",
      primary_id_type: payer.primary_id_type,
      primary_id_hash: hash,
      primary_id_enc: encryptPrimaryId(payer.primary_id_value),
      primary_id_last4: payer.primary_id_value.slice(-4),
      name: payer.name,
      msisdn_e164: payer.msisdn_e164 ?? null,
      email: payer.email ?? null,
      created_at: clock.now(),
    })
    .returning(["id"])
    .executeTakeFirstOrThrow();
  return inserted.id;
}
