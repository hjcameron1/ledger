-- ═══════════════════════════════════════════════════════════════════════════
-- CORPORATE ACTIONS — automatic split detection
--
-- One column: how far forward this holding has been checked for splits.
--
-- It is the whole idempotency story. A split multiplies a unit count, so
-- applying one twice multiplies somebody's holding by the square of the ratio —
-- a 4:1 applied twice is sixteen times the shares — and there is nothing on the
-- screen that would contradict it. The watermark makes that impossible three
-- ways over:
--
--   • it only ever moves FORWARD, and the update that moves it is a
--     compare-and-set (`WHERE split_checked_through IS NULL OR < :date`), so of
--     two processes racing on the same split exactly one write lands;
--   • NULL means "never checked", and the first check applies nothing at all —
--     it just stamps today. A unit count the user typed in already reflects
--     every split in that security's history, because it came off their
--     broker's statement, so treating the feed's history as unapplied would BE
--     the double-application;
--   • a holding is checked at most once per calendar day, so the feed is asked
--     for splits once a day per holding however often prices refresh.
--
-- The matching parcel-book entry goes in `cgt_splits` (2026-cgt-parcels.sql)
-- under an id derived from the holding, the date and the ratio — the same id in
-- every process and on every device, so an upsert of it can only land once.
--
-- Safe to run more than once. Nothing is backfilled: every existing holding
-- starts at NULL, is stamped with today on its next refresh, and is adjusted
-- only for splits that happen from then on.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE investments
  ADD COLUMN IF NOT EXISTS split_checked_through DATE;

COMMENT ON COLUMN investments.split_checked_through IS
  'Splits with an effective date up to and including this day have been dealt with. NULL = never checked; the first check stamps today and applies nothing.';

-- Only rows that are behind are ever read, so the index is on the column alone.
CREATE INDEX IF NOT EXISTS idx_investments_split_checked
  ON investments(split_checked_through);
