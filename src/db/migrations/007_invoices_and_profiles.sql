-- 007_invoices_and_profiles.sql
-- Adds: provider invoice submission (mockup's provider task flow)
--       + the two profile columns users.controller.js already writes to.
--
-- NOTE: use THIS version, not any earlier one I may have given you — it
-- matches your real users.controller.js (next_of_kin, service_specialty),
-- not the 3-field version I guessed at before seeing the actual file.

CREATE TABLE invoices (
  id SERIAL PRIMARY KEY,
  maintenance_request_id INTEGER REFERENCES maintenance_requests(id),
  provider_id INTEGER REFERENCES users(id),
  district_id INTEGER REFERENCES districts(id),
  amount NUMERIC(10,2) NOT NULL,
  description TEXT,
  file_url TEXT,
  status TEXT DEFAULT 'submitted' CHECK (status IN ('submitted','approved','rejected','paid')),
  reviewed_by INTEGER REFERENCES users(id),
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_invoices_maintenance_request ON invoices(maintenance_request_id);
CREATE INDEX idx_invoices_provider ON invoices(provider_id);
CREATE INDEX idx_invoices_status ON invoices(status);

ALTER TABLE users ADD COLUMN next_of_kin TEXT;
ALTER TABLE users ADD COLUMN service_specialty TEXT;