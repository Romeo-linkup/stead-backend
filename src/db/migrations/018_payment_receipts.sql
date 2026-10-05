-- 018_payment_receipts.sql
-- Proof-of-payment receipts a tenant uploads against a payment.
CREATE TABLE IF NOT EXISTS payment_receipts (
  id SERIAL PRIMARY KEY,
  payment_id INTEGER NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  public_id TEXT,
  uploaded_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payment_receipts_payment_idx ON payment_receipts (payment_id);
