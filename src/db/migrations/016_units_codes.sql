-- 016_units_codes.sql
-- Units get updated_at; enforce case-insensitive unit_number uniqueness per
-- property; allow at most one active tenant code per unit.
ALTER TABLE units ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

CREATE UNIQUE INDEX IF NOT EXISTS units_property_unit_unique
  ON units (property_id, lower(unit_number));

CREATE UNIQUE INDEX IF NOT EXISTS codes_one_active_tenant_per_unit
  ON codes (unit_id)
  WHERE unit_id IS NOT NULL AND active = true AND role = 'tenant';
