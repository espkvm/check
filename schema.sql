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
-- Kinds since 2026-11-13, all with key '': total (every id known by that day),
-- new (first seen that day), active1 / active7 (seen that day / in 7 days),
-- lost (last seen exactly 30 days before: just fell out of the window);
-- and channel (key release or dev: a tagged build or anything else).
CREATE TABLE IF NOT EXISTS daily (
  day     TEXT NOT NULL, -- 2026-10-29
  kind    TEXT NOT NULL, -- all, board, ver, rev, channel, total, new, active1, active7, lost
  key     TEXT NOT NULL,
  devices INTEGER NOT NULL,
  PRIMARY KEY (day, kind, key)
);

-- What a device changed since its previous report: an update (ver), another
-- image (board), a revision first reported (rev). One row per change, so how
-- fast a release spreads, rollbacks and reflashes stay known after seen moves on.
CREATE TABLE IF NOT EXISTS changes (
  day   TEXT NOT NULL, -- 2026-11-13
  id    TEXT NOT NULL,
  field TEXT NOT NULL, -- ver, board, rev
  old   TEXT NOT NULL,
  new   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS changes_day ON changes (day);
