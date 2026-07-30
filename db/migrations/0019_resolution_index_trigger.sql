-- Finding J (audit): resolution_index was maintained only by a TypeScript
-- function called from application code — it silently did nothing for any
-- write path that didn't go through that specific helper. Prompt 1 requires
-- "trigger or outbox... on every assessment write"; this replaces the
-- TypeScript sync (src/modules/obligation/resolution-index-sync.ts, deleted)
-- with a real Postgres trigger, so it fires unconditionally.
--
-- The two checksum primitives it needs (Damm validity, ISO 11649 RF encode via
-- MOD-97-10) are ported from src/platform/checksum/{damm,mod9710,rf}.ts —
-- same table, same algorithm, verified in Phase 1 against 128 real RF
-- references in demo-data.

CREATE OR REPLACE FUNCTION _p2g_damm_valid(digits text) RETURNS boolean AS $$
DECLARE
  damm_table int[][] := ARRAY[
    ARRAY[0,3,1,7,5,9,8,6,4,2],
    ARRAY[7,0,9,2,1,5,4,8,6,3],
    ARRAY[4,2,0,6,8,7,1,3,5,9],
    ARRAY[1,7,5,0,9,8,3,4,2,6],
    ARRAY[6,1,2,3,0,4,5,9,7,8],
    ARRAY[3,6,7,4,2,0,9,5,8,1],
    ARRAY[5,8,6,9,7,2,0,1,3,4],
    ARRAY[8,9,4,5,3,6,2,0,1,7],
    ARRAY[9,4,3,8,6,1,7,2,0,5],
    ARRAY[2,5,8,1,4,3,6,7,9,0]
  ];
  interim int := 0;
  i int;
  d int;
BEGIN
  IF digits !~ '^[0-9]+$' THEN RETURN false; END IF;
  FOR i IN 1..length(digits) LOOP
    d := substr(digits, i, 1)::int;
    interim := damm_table[interim + 1][d + 1]; -- pg arrays are 1-indexed
  END LOOP;
  RETURN interim = 0;
END; $$ LANGUAGE plpgsql IMMUTABLE;

CREATE OR REPLACE FUNCTION _p2g_mod9710_remainder(alphanumeric text) RETURNS int AS $$
DECLARE
  expanded text := '';
  ch text;
  code int;
  remainder int := 0;
  i int;
BEGIN
  FOR i IN 1..length(alphanumeric) LOOP
    ch := upper(substr(alphanumeric, i, 1));
    IF ch ~ '[0-9]' THEN
      expanded := expanded || ch;
    ELSIF ch ~ '[A-Z]' THEN
      code := ascii(ch) - 55; -- A=10 .. Z=35, same mapping as platform/checksum/mod9710.ts
      expanded := expanded || code::text;
    ELSE
      RAISE EXCEPTION 'mod9710: "%" is not alphanumeric', ch;
    END IF;
  END LOOP;
  FOR i IN 1..length(expanded) LOOP
    remainder := (remainder * 10 + substr(expanded, i, 1)::int) % 97;
  END LOOP;
  RETURN remainder;
END; $$ LANGUAGE plpgsql IMMUTABLE;

CREATE OR REPLACE FUNCTION _p2g_rf_encode(psid text) RETURNS text AS $$
DECLARE
  remainder int;
  check_digits text;
BEGIN
  remainder := _p2g_mod9710_remainder(upper(psid) || 'RF00');
  check_digits := lpad((98 - remainder)::text, 2, '0');
  RETURN 'RF' || check_digits || upper(psid);
END; $$ LANGUAGE plpgsql IMMUTABLE;

-- Normalization: trim -> uppercase -> strip spaces -> strip hyphens. Mirrored
-- exactly by a TypeScript `normalizeKeyValue()` on the lookup side (tested
-- together to prove "LEA-17-1000" and "LEA171000" normalize identically).
CREATE OR REPLACE FUNCTION _p2g_normalize_key(raw text) RETURNS text AS $$
  SELECT upper(replace(replace(trim(raw), ' ', ''), '-', ''));
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION _p2g_sync_resolution_index() RETURNS trigger AS $$
DECLARE
  scheme_total_length int;
  is_open_now boolean;
  crn_value text;
  loop_key_type text;
  metadata_value text;
BEGIN
  -- "is_open" means "this is the current, non-superseded version of this
  -- PSID" — not "this is payable." AMENDED is the only status that means a
  -- newer version now exists; every other status (including SETTLED, EXPIRED,
  -- CANCELLED) is still the assessment's current, correctly-resolvable state
  -- (§8.2/finding I: an expired assessment "remains resolvable" — it must
  -- return PAYABLE_EXPIRED, not NOT_FOUND).
  is_open_now := (NEW.status <> 'AMENDED');

  UPDATE resolution_index SET is_open = false WHERE assessment_id = NEW.id AND is_open;

  IF NOT is_open_now THEN
    RETURN NULL;
  END IF;

  INSERT INTO resolution_index (agency_id, key_type, key_value_norm, key_value_raw, assessment_id, is_open)
  VALUES (NEW.agency_id, 'PSID', _p2g_normalize_key(NEW.psid), NEW.psid, NEW.id, true)
  ON CONFLICT (key_type, key_value_norm, assessment_id) DO UPDATE SET is_open = true;

  -- RF_REFERENCE: only the platform's 17-digit main schemes (length, not
  -- checksum_algo, is what distinguishes these from the 13-digit WASA CRN and
  -- 14-digit legacy NADRA number — confirmed against demo-data in Phase 1).
  SELECT rs.total_length INTO scheme_total_length
    FROM collection_product cp JOIN reference_scheme rs ON rs.id = cp.reference_scheme_id
    WHERE cp.id = NEW.product_id;

  IF scheme_total_length = 17 THEN
    INSERT INTO resolution_index (agency_id, key_type, key_value_norm, key_value_raw, assessment_id, is_open)
    VALUES (NEW.agency_id, 'RF_REFERENCE', _p2g_normalize_key(_p2g_rf_encode(NEW.psid)), _p2g_rf_encode(NEW.psid), NEW.id, true)
    ON CONFLICT (key_type, key_value_norm, assessment_id) DO UPDATE SET is_open = true;
  END IF;

  IF NEW.payer_account_id IS NOT NULL THEN
    SELECT crn INTO crn_value FROM payer_account WHERE id = NEW.payer_account_id;
    IF crn_value IS NOT NULL THEN
      INSERT INTO resolution_index (agency_id, key_type, key_value_norm, key_value_raw, assessment_id, is_open)
      VALUES (NEW.agency_id, 'CRN', _p2g_normalize_key(crn_value), crn_value, NEW.id, true)
      ON CONFLICT (key_type, key_value_norm, assessment_id) DO UPDATE SET is_open = true;
    END IF;
  END IF;

  -- Every secondary lookup key the PRODUCT declares, generically (finding N —
  -- not a fixed TypeScript list of 3 types). Metadata field name is the
  -- lowercase of the key type (confirmed against demo-data for GD_NO->gd_no,
  -- PROPERTY_ID->property_id, INSTRUMENT_NO->instrument_no,
  -- TENDER_REF->tender_ref, CHASSIS_NO->chassis_no, VEHICLE_REG->vehicle_reg,
  -- CASE_NO->case_no, APPLICATION_NO->application_no — 8 of the 11 documented
  -- + all 6 undocumented types checked this way; DL_NO has no real fixture
  -- value anywhere in demo-data to confirm against, but the mechanism is
  -- identical). CNIC/NTN/STRN/RAAST_ID are explicitly skipped here even though
  -- some products list them alongside a real secondary key (e.g.
  -- ETPB-TOKEN-CAR: ["VEHICLE_REG","CNIC"]) — those four resolve via
  -- `payer.primary_id_hash`/`raast_id_value` (a payer-wide lookup spanning
  -- every agency they owe, not a single assessment), never via a per-assessment
  -- index row.
  FOR loop_key_type IN
    SELECT jsonb_array_elements_text(cp.secondary_lookup_keys)
    FROM collection_product cp WHERE cp.id = NEW.product_id
  LOOP
    IF loop_key_type IN ('CNIC', 'NTN', 'STRN', 'RAAST_ID') THEN
      CONTINUE;
    END IF;
    metadata_value := NEW.metadata ->> lower(loop_key_type);
    IF metadata_value IS NOT NULL AND metadata_value <> '' THEN
      INSERT INTO resolution_index (agency_id, key_type, key_value_norm, key_value_raw, assessment_id, is_open)
      VALUES (NEW.agency_id, loop_key_type, _p2g_normalize_key(metadata_value), metadata_value, NEW.id, true)
      ON CONFLICT (key_type, key_value_norm, assessment_id) DO UPDATE SET is_open = true;
    END IF;
  END LOOP;

  RETURN NULL;
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_sync_resolution_index
  AFTER INSERT OR UPDATE ON assessment
  FOR EACH ROW EXECUTE FUNCTION _p2g_sync_resolution_index();
