/**
 * Mirrors `_p2g_normalize_key` in db/migrations/0019_resolution_index_trigger.sql
 * exactly (trim -> strip spaces -> strip hyphens -> uppercase) so a lookup on
 * this side always agrees with whatever the DB trigger indexed. Verified:
 * `LEA-17-1000` and `LEA171000` both normalize to `LEA171000` (finding J).
 */
export function normalizeKeyValue(raw: string): string {
  return raw.trim().replaceAll(" ", "").replaceAll("-", "").toUpperCase();
}
