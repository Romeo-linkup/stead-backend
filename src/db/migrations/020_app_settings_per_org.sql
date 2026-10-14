-- 020_app_settings_per_org.sql
-- Make app_settings per-organisation instead of single-row with id=1

ALTER TABLE app_settings DROP CONSTRAINT IF EXISTS app_settings_id_check;
CREATE SEQUENCE IF NOT EXISTS app_settings_id_seq OWNED BY app_settings.id;
SELECT setval('app_settings_id_seq', GREATEST((SELECT COALESCE(MAX(id), 1) FROM app_settings), 1));
ALTER TABLE app_settings ALTER COLUMN id SET DEFAULT nextval('app_settings_id_seq');
CREATE UNIQUE INDEX IF NOT EXISTS app_settings_organization_id_unique ON app_settings (organization_id);
INSERT INTO app_settings (business_name, notice_period_months, organization_id)
SELECT o.name, 3, o.id FROM organizations o
WHERE NOT EXISTS (SELECT 1 FROM app_settings s WHERE s.organization_id = o.id);
