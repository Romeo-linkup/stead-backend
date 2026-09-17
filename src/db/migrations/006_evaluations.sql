CREATE TABLE property_evaluations (
  id SERIAL PRIMARY KEY,
  property_id INTEGER REFERENCES properties(id),
  evaluated_by INTEGER REFERENCES users(id),
  score_percent NUMERIC(5,2) CHECK (score_percent BETWEEN 0 AND 100),
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE VIEW property_current_score AS
SELECT DISTINCT ON (property_id) property_id, score_percent, created_at
FROM property_evaluations ORDER BY property_id, created_at DESC;
