CREATE TABLE IF NOT EXISTS invoices (
  id SERIAL PRIMARY KEY,
  maintenance_request_id INTEGER NOT NULL REFERENCES maintenance_requests(id),
  provider_user_id INTEGER NOT NULL REFERENCES users(id),
  district_id INTEGER NOT NULL REFERENCES districts(id),
  to_party TEXT NOT NULL,
  note TEXT,
  payout_account TEXT NOT NULL,
  total NUMERIC(12,2) NOT NULL CHECK (total > 0),
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','approved','rejected','paid')),
  review_note TEXT,
  reviewed_by INTEGER REFERENCES users(id),
  reviewed_at TIMESTAMPTZ,
  paid_by INTEGER REFERENCES users(id),
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS one_live_invoice_per_task ON invoices (maintenance_request_id) WHERE status IN ('submitted','approved','paid');
CREATE INDEX IF NOT EXISTS invoices_district_status_idx ON invoices (district_id, status);
CREATE INDEX IF NOT EXISTS invoices_provider_idx ON invoices (provider_user_id);
CREATE TABLE IF NOT EXISTS invoice_items (
  id SERIAL PRIMARY KEY,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  description TEXT NOT NULL,
  qty NUMERIC(10,2) NOT NULL CHECK (qty > 0),
  unit_price NUMERIC(12,2) NOT NULL CHECK (unit_price >= 0),
  line_total NUMERIC(12,2) NOT NULL
);
CREATE TABLE IF NOT EXISTS invoice_receipts (
  id SERIAL PRIMARY KEY,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  image_url TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);
