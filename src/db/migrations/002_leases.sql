CREATE TABLE leases (
  id SERIAL PRIMARY KEY,
  unit_id INTEGER REFERENCES units(id),
  lessor_name TEXT, lessor_id_number TEXT,
  lessee_name TEXT, lessee_id_number TEXT,
  start_date DATE, duration_months INTEGER,
  end_date DATE,
  rent_amount NUMERIC(10,2), rent_increase_pct NUMERIC(5,2),
  deposit_amount NUMERIC(10,2),
  cancellation_notice_days INTEGER, cancellation_penalty NUMERIC(10,2),
  terms_json JSONB,
  status TEXT DEFAULT 'draft' CHECK (status IN ('draft','sent','signed','expired')),
  signature_image_url TEXT,
  signed_at TIMESTAMPTZ,
  created_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT now()
);
