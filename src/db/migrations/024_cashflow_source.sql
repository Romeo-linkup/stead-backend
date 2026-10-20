-- Add source column to cashflow_items to track auto-generated items
ALTER TABLE cashflow_items ADD COLUMN IF NOT EXISTS source TEXT;
