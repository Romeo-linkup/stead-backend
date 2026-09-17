-- 007_profile_fields.sql
-- Add fields for profile pages
ALTER TABLE users ADD COLUMN IF NOT EXISTS next_of_kin TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS service_specialty TEXT;