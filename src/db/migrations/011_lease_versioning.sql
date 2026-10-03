ALTER TABLE leases DROP CONSTRAINT IF EXISTS leases_status_check;
ALTER TABLE leases ADD CONSTRAINT leases_status_check
  CHECK (status = ANY (ARRAY['draft', 'sent', 'signed', 'expired', 'superseded']));
ALTER TABLE leases ADD COLUMN IF NOT EXISTS supersedes_id INTEGER REFERENCES leases(id);
ALTER TABLE leases ADD COLUMN IF NOT EXISTS superseded_by INTEGER REFERENCES leases(id);
ALTER TABLE leases ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();
ALTER TABLE leases ADD COLUMN IF NOT EXISTS updated_by INTEGER REFERENCES users(id);
UPDATE leases SET updated_at = COALESCE(signed_at, created_at);

DO $$
DECLARE
  duplicate_unit_ids INTEGER[];
BEGIN
  SELECT array_agg(duplicates.unit_id ORDER BY duplicates.unit_id)
    INTO duplicate_unit_ids
    FROM (
      SELECT unit_id, count(*)
      FROM leases
      WHERE status IN ('draft', 'sent')
      GROUP BY unit_id
      HAVING count(*) > 1
    ) AS duplicates;

  IF COALESCE(cardinality(duplicate_unit_ids), 0) > 0 THEN
    RAISE NOTICE 'Skipping one_open_lease_per_unit; duplicate unit_ids: %', array_to_string(duplicate_unit_ids, ', ');
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS one_open_lease_per_unit
      ON leases (unit_id) WHERE status IN ('draft', 'sent');
  END IF;
END $$;

DO $$
DECLARE
  duplicate_unit_ids INTEGER[];
BEGIN
  SELECT array_agg(duplicates.unit_id ORDER BY duplicates.unit_id)
    INTO duplicate_unit_ids
    FROM (
      SELECT unit_id, count(*)
      FROM leases
      WHERE status = 'signed'
      GROUP BY unit_id
      HAVING count(*) > 1
    ) AS duplicates;

  IF COALESCE(cardinality(duplicate_unit_ids), 0) > 0 THEN
    RAISE NOTICE 'Skipping one_signed_lease_per_unit; duplicate unit_ids: %', array_to_string(duplicate_unit_ids, ', ');
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS one_signed_lease_per_unit
      ON leases (unit_id) WHERE status = 'signed';
  END IF;
END $$;
