-- One row per device per month. The id is the device's random installId; no
-- IP address or anything else about the sender is stored.
CREATE TABLE IF NOT EXISTS seen (
  month TEXT NOT NULL, -- 2026-10
  id    TEXT NOT NULL, -- 32 hex digits
  board TEXT NOT NULL,
  ver   TEXT NOT NULL,
  first TEXT NOT NULL, -- day first seen this month
  last  TEXT NOT NULL, -- day last seen this month
  PRIMARY KEY (month, id)
);
