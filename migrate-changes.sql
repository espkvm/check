-- 2026-11-13: the changes table (see schema.sql). Run once before deploying:
--   npx wrangler@4 d1 execute espkvm-check --remote --file migrate-changes.sql
CREATE TABLE IF NOT EXISTS changes (
  day   TEXT NOT NULL,
  id    TEXT NOT NULL,
  field TEXT NOT NULL,
  old   TEXT NOT NULL,
  new   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS changes_day ON changes (day);
