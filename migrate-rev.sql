-- 2026-11-01: the chip revision. Run once on the live database BEFORE deploying
-- the Worker that writes it; the old Worker keeps working with the column there.
ALTER TABLE seen ADD COLUMN rev TEXT NOT NULL DEFAULT '';
