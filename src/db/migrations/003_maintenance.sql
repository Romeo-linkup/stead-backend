CREATE TABLE maintenance_requests (
  id SERIAL PRIMARY KEY,
  unit_id INTEGER REFERENCES units(id),
  reported_by INTEGER REFERENCES users(id),
  category TEXT, description TEXT,
  status TEXT DEFAULT 'outstanding' CHECK (status IN ('outstanding','pending','finished')),
  assigned_to INTEGER REFERENCES users(id),
  before_photo_url TEXT, after_photo_url TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
