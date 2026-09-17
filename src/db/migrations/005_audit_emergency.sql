CREATE TABLE emergency_alerts (
  id SERIAL PRIMARY KEY,
  unit_id INTEGER REFERENCES units(id),
  triggered_by INTEGER REFERENCES users(id),
  status TEXT DEFAULT 'unacknowledged' CHECK (status IN ('unacknowledged','acknowledged','resolved')),
  acknowledged_by INTEGER REFERENCES users(id),
  acknowledged_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);
