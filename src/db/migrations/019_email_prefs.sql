-- 019_email_prefs.sql
-- Email notification preference per user, and unique email constraint
-- scoped to owner role only (non-owners don't log in with email).
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_notifications BOOLEAN NOT NULL DEFAULT true;
DROP INDEX IF EXISTS users_email_unique;
CREATE UNIQUE INDEX IF NOT EXISTS users_owner_email_unique ON users (lower(email)) WHERE email IS NOT NULL AND role = 'owner';