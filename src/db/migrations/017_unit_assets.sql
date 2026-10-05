-- 017_unit_assets.sql
-- Per-unit assets register (the client's "Building & Assets List").
-- condition NULL means "Not assessed".
CREATE TABLE IF NOT EXISTS unit_assets (
  id SERIAL PRIMARY KEY,
  unit_id INTEGER NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  area TEXT,
  item TEXT NOT NULL,
  condition TEXT CHECK (condition IN ('good','fair','poor','damaged','missing')),
  comments TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  updated_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS unit_assets_unit_idx ON unit_assets (unit_id);
