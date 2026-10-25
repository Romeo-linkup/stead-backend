-- 025_cashflow_actuals.sql
-- Add bond tracking and one-off payment support to cashflow_items
ALTER TABLE cashflow_items
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'monthly',
  ADD COLUMN IF NOT EXISTS paid_on date,
  ADD COLUMN IF NOT EXISTS source_ref text,
  ADD COLUMN IF NOT EXISTS bond_months_remaining integer,
  ADD COLUMN IF NOT EXISTS bond_baseline_on date,
  ADD COLUMN IF NOT EXISTS bond_paid_before numeric(14,2) NOT NULL DEFAULT 0;
ALTER TABLE cashflow_items DROP CONSTRAINT IF EXISTS cashflow_items_kind_check;
ALTER TABLE cashflow_items ADD CONSTRAINT cashflow_items_kind_check CHECK (kind IN ('monthly','one_off'));
ALTER TABLE cashflow_items DROP CONSTRAINT IF EXISTS cashflow_items_bond_months_check;
ALTER TABLE cashflow_items ADD CONSTRAINT cashflow_items_bond_months_check CHECK (bond_months_remaining IS NULL OR bond_months_remaining BETWEEN 0 AND 600);
CREATE UNIQUE INDEX IF NOT EXISTS ux_cashflow_source_ref ON cashflow_items (organization_id, source_ref) WHERE source_ref IS NOT NULL AND archived_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_cashflow_one_off ON cashflow_items (organization_id, property_id, paid_on) WHERE kind = 'one_off';
