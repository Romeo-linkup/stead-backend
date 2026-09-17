CREATE TABLE complaints (
  id SERIAL PRIMARY KEY,
  district_id INTEGER REFERENCES districts(id),
  unit_id INTEGER REFERENCES units(id),
  submitted_by INTEGER REFERENCES users(id),
  is_anonymous BOOLEAN DEFAULT false,
  tracking_code TEXT UNIQUE,
  category TEXT, description TEXT,
  status TEXT DEFAULT 'open' CHECK (status IN ('open','resolved')),
  created_at TIMESTAMPTZ DEFAULT now(),
  resolved_at TIMESTAMPTZ
);

CREATE TABLE payments (
  id SERIAL PRIMARY KEY,
  unit_id INTEGER REFERENCES units(id),
  type TEXT CHECK (type IN ('rent','water','other')),
  amount NUMERIC(10,2),
  due_date DATE,
  status TEXT DEFAULT 'outstanding' CHECK (status IN ('outstanding','pending','paid')),
  paid_at TIMESTAMPTZ,
  reference TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE messages (
  id SERIAL PRIMARY KEY,
  thread_id INTEGER,
  sender_id INTEGER REFERENCES users(id),
  recipient_scope TEXT,
  body TEXT, attachment_url TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
