-- Finding E (audit): the database currently accepts an assessment whose line
-- items don't sum to assessed_amount_minor. Enforced here the same way §10.5
-- enforces balanced journal entries: a DEFERRABLE INITIALLY DEFERRED constraint
-- trigger, so an assessment and its lines can be inserted in one transaction
-- (assessment first, then N line items) and the check only fires once, at
-- COMMIT — never after the first line, which would reject every legitimate
-- multi-line insert.
CREATE OR REPLACE FUNCTION assert_line_items_sum() RETURNS trigger AS $$
DECLARE
  target_assessment_id UUID;
  line_total BIGINT;
  assessed BIGINT;
BEGIN
  target_assessment_id := COALESCE(NEW.assessment_id, OLD.assessment_id);

  SELECT COALESCE(SUM(amount_minor), 0) INTO line_total
    FROM assessment_line_item WHERE assessment_id = target_assessment_id;

  SELECT assessed_amount_minor INTO assessed
    FROM assessment WHERE id = target_assessment_id;

  IF assessed IS NOT NULL AND line_total <> assessed THEN
    RAISE EXCEPTION 'LINE_ITEMS_DO_NOT_SUM: assessment % line total % <> assessed_amount_minor %',
      target_assessment_id, line_total, assessed;
  END IF;
  RETURN NULL;
END; $$ LANGUAGE plpgsql;

-- Fires on any write to assessment_line_item (insert/update/delete) for the
-- affected assessment_id(s).
CREATE CONSTRAINT TRIGGER trg_line_items_sum_on_lines
  AFTER INSERT OR UPDATE OR DELETE ON assessment_line_item
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_line_items_sum();

-- Belt-and-braces: if assessed_amount_minor is ever changed directly on an
-- existing assessment row (not the normal amendment path, which inserts a new
-- version instead — but this closes the gap for any future/admin direct write),
-- the same check re-fires from the assessment side.
CREATE OR REPLACE FUNCTION assert_line_items_sum_on_assessment() RETURNS trigger AS $$
DECLARE
  line_total BIGINT;
BEGIN
  SELECT COALESCE(SUM(amount_minor), 0) INTO line_total
    FROM assessment_line_item WHERE assessment_id = NEW.id;

  IF line_total <> NEW.assessed_amount_minor THEN
    RAISE EXCEPTION 'LINE_ITEMS_DO_NOT_SUM: assessment % line total % <> assessed_amount_minor %',
      NEW.id, line_total, NEW.assessed_amount_minor;
  END IF;
  RETURN NULL;
END; $$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_line_items_sum_on_assessment
  AFTER UPDATE OF assessed_amount_minor ON assessment
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_line_items_sum_on_assessment();
