CREATE TABLE IF NOT EXISTS notices (
  id SERIAL PRIMARY KEY,
  district_id INTEGER REFERENCES districts(id) ON DELETE CASCADE,
  audience TEXT NOT NULL DEFAULT 'all' CHECK (audience IN ('all','tenants','providers')),
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS move_out_notices (
  id SERIAL PRIMARY KEY,
  unit_id INTEGER NOT NULL REFERENCES units(id),
  tenant_user_id INTEGER NOT NULL REFERENCES users(id),
  district_id INTEGER NOT NULL REFERENCES districts(id),
  intended_move_out_date DATE NOT NULL,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','acknowledged','withdrawn')),
  acknowledged_by INTEGER REFERENCES users(id),
  acknowledged_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS one_active_move_out_per_tenant
  ON move_out_notices (tenant_user_id)
  WHERE status IN ('submitted','acknowledged');

ALTER TABLE app_settings
  ADD COLUMN IF NOT EXISTS notice_period_months INTEGER NOT NULL DEFAULT 3;