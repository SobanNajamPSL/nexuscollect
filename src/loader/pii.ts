import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

/**
 * `payer.primary_id_hash` / `primary_id_enc` (db/migrations/0003_payer.sql / §23):
 * a keyed hash for searchable-but-not-reversible lookup, and envelope-encrypted
 * storage of the real value. This build has no HSM/key-management story (CLAUDE.md
 * §19/§20 are explicitly deferred design commentary, not backlog) — these use a
 * single demo-grade key from the environment, with a fixed fallback so the loader
 * runs out of the box. Replace both with real KMS-backed keys before this is
 * anything but a demo.
 */
const DEMO_HASH_SECRET = process.env["PAYER_ID_HASH_SECRET"] ?? "nexuscollect-demo-hash-secret-do-not-use-in-prod";
const DEMO_ENC_KEY = createHmac("sha256", "nexuscollect-demo-enc-key-do-not-use-in-prod")
  .update(process.env["PAYER_ID_ENC_KEY"] ?? "default")
  .digest(); // 32 bytes, suitable for AES-256-GCM regardless of the env value's length

export function hashPrimaryId(idType: string, idValue: string): Buffer {
  return createHmac("sha256", DEMO_HASH_SECRET).update(`${idType}:${idValue}`).digest();
}

export function encryptPrimaryId(idValue: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", DEMO_ENC_KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(idValue, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]); // 12-byte IV || 16-byte tag || ciphertext
}

export function decryptPrimaryId(blob: Buffer): string {
  const iv = blob.subarray(0, 12);
  const authTag = blob.subarray(12, 28);
  const ciphertext = blob.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", DEMO_ENC_KEY, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
