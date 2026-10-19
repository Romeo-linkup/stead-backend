-- 023_cashflow_property.sql
-- Default NO ACTION (not CASCADE or RESTRICT): a property with cashflow records cannot be deleted on its own,
-- while deleting a whole organisation can still remove everything in one statement.
ALTER TABLE cashflow_items
  ADD COLUMN IF NOT EXISTS property_id INTEGER REFERENCES properties(id);

CREATE INDEX IF NOT EXISTS idx_cashflow_items_property
  ON cashflow_items (property_id) WHERE archived_at IS NULL;
