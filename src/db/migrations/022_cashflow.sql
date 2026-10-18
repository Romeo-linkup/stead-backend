-- 022_cashflow.sql
-- Owner-only monthly cashflow items per organisation, with append-only history.
CREATE TABLE IF NOT EXISTS cashflow_items (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  category TEXT NOT NULL,
  label TEXT NOT NULL CHECK (char_length(label) BETWEEN 1 AND 100),
  amount NUMERIC(12,2) NOT NULL CHECK (amount > 0 AND amount <= 100000000),
  day_of_month SMALLINT NOT NULL CHECK (day_of_month BETWEEN 1 AND 31),
  note TEXT CHECK (note IS NULL OR char_length(note) <= 300),
  version INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by INTEGER REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  amount_updated_by INTEGER REFERENCES users(id),
  amount_updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at TIMESTAMPTZ,
  archived_by INTEGER REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_cashflow_items_org_active
  ON cashflow_items (organization_id) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS cashflow_history (
  id BIGSERIAL PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES cashflow_items(id) ON DELETE CASCADE,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  change_type TEXT NOT NULL CHECK (change_type IN ('create', 'update', 'archive')),
  old_values JSONB,
  new_values JSONB,
  reason TEXT,
  changed_by INTEGER NOT NULL REFERENCES users(id),
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cashflow_history_org
  ON cashflow_history (organization_id, changed_at DESC);

-- History is append-only. Updates are always refused. Direct deletes are refused too;
-- cascading deletes (an owner deleting their whole account) run at trigger depth 2+ and are allowed.
CREATE OR REPLACE FUNCTION cashflow_history_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'cashflow_history is append-only';
  END IF;
  IF TG_OP = 'DELETE' AND pg_trigger_depth() = 1 THEN
    RAISE EXCEPTION 'cashflow_history is append-only';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS cashflow_history_guard_trg ON cashflow_history;
CREATE TRIGGER cashflow_history_guard_trg
  BEFORE UPDATE OR DELETE ON cashflow_history
  FOR EACH ROW EXECUTE FUNCTION cashflow_history_guard();
