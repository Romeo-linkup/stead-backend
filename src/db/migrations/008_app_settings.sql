-- 008_app_settings.sql
-- Single-row table holding the property business's display name, set by
-- the owner and shown to every role in the topbar after login.
CREATE TABLE app_settings (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1), -- enforces exactly one row
  business_name TEXT NOT NULL DEFAULT 'Your Property Business',
  updated_at TIMESTAMPTZ DEFAULT now()
);

INSERT INTO app_settings (id, business_name) VALUES (1, 'Your Property Business');