-- Notification preferences are real per-user state backed by PostgreSQL.
-- The account UI already writes them (PATCH /auth/me/preferences); this column
-- makes that contract real instead of a silent 404.
ALTER TABLE users ADD COLUMN IF NOT EXISTS preferences jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN users.preferences IS 'Per-user notification preferences (allowlisted boolean keys, merged on write).';
