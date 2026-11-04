-- One row per device per month. The id is the device's random installId; no
-- IP address or anything else about the sender is stored.
CREATE TABLE IF NOT EXISTS seen (
  month TEXT NOT NULL, -- 2026-10
  id    TEXT NOT NULL, -- 32 hex digits
  board TEXT NOT NULL,
  ver   TEXT NOT NULL,
  first TEXT NOT NULL, -- day first seen this month
  last  TEXT NOT NULL, -- day last seen this month
  rev   TEXT NOT NULL DEFAULT '', -- chip revision, 3.1; '' from older consoles (last: added by ALTER)
  PRIMARY KEY (month, id)
);

-- A snapshot a day, taken by the cron trigger: devices seen in the 30 days up
-- to that day, in all (kind 'all', key ''), by board, version and chip revision. Counts
-- only, so the history of versions survives the rows in seen being updated.
CREATE TABLE IF NOT EXISTS daily (
  day     TEXT NOT NULL, -- 2026-10-29
  kind    TEXT NOT NULL, -- all, board, ver
  key     TEXT NOT NULL,
  devices INTEGER NOT NULL,
  PRIMARY KEY (day, kind, key)
);
