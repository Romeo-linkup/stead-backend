CREATE TABLE IF NOT EXISTS district_info (
  id SERIAL PRIMARY KEY,
  district_id INTEGER NOT NULL REFERENCES districts(id) ON DELETE CASCADE,
  section_key TEXT NOT NULL CHECK (section_key IN ('building_rules','utilities','leaving_property','contacts','access')),
  body TEXT NOT NULL DEFAULT '',
  updated_by INTEGER REFERENCES users(id),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (district_id, section_key)
);