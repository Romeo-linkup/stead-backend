-- 015_organizations.sql
-- Add multi-owner foundation with organizations, owner accounts with email/password
CREATE TABLE IF NOT EXISTS organizations (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE districts ADD COLUMN IF NOT EXISTS organization_id INTEGER REFERENCES organizations(id);
ALTER TABLE users ADD COLUMN IF NOT EXISTS organization_id INTEGER REFERENCES organizations(id);
ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON users (lower(email)) WHERE email IS NOT NULL;
ALTER TABLE codes ADD COLUMN IF NOT EXISTS organization_id INTEGER REFERENCES organizations(id);
ALTER TABLE codes ADD COLUMN IF NOT EXISTS unit_id INTEGER REFERENCES units(id);
ALTER TABLE codes ADD COLUMN IF NOT EXISTS created_by INTEGER REFERENCES users(id);
ALTER TABLE notices ADD COLUMN IF NOT EXISTS organization_id INTEGER REFERENCES organizations(id);
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS organization_id INTEGER REFERENCES organizations(id);

-- app_settings is a single-row table with id=1, so add organization_id and a unique index on it
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS organization_id INTEGER REFERENCES organizations(id);
CREATE UNIQUE INDEX IF NOT EXISTS app_settings_organization_unique ON app_settings (organization_id) WHERE organization_id IS NOT NULL;
