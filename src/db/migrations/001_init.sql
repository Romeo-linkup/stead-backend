-- 001_init.sql
CREATE TABLE districts (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE codes (
  id SERIAL PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','admin','property_manager','service_provider','tenant')),
  district_id INTEGER REFERENCES districts(id),
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT,
  role TEXT NOT NULL,
  district_id INTEGER REFERENCES districts(id),
  code_id INTEGER REFERENCES codes(id),
  created_at TIMESTAMPTZ DEFAULT now(),
  last_login_at TIMESTAMPTZ
);

CREATE TABLE properties (
  id SERIAL PRIMARY KEY,
  district_id INTEGER REFERENCES districts(id),
  name TEXT NOT NULL,
  address TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE units (
  id SERIAL PRIMARY KEY,
  property_id INTEGER REFERENCES properties(id),
  unit_number TEXT NOT NULL,
  tenant_user_id INTEGER REFERENCES users(id),
  rent_amount NUMERIC(10,2),
  rent_due_day INTEGER DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- audit_log is created here (ahead of migration 005 in the blueprint's
-- numbering) because Phase 1/2 already needs writeAudit() to work.
-- 005_audit_emergency.sql will only need to add emergency_alerts.
CREATE TABLE audit_log (
  id SERIAL PRIMARY KEY,
  actor_id INTEGER REFERENCES users(id),
  actor_role TEXT,
  district_id INTEGER REFERENCES districts(id),
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id INTEGER,
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);
