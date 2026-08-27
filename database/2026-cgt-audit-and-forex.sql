-- ─────────────────────────────────────────────────────────────────────────────
-- CGT: the disposal audit trail, and the currency an asset was denominated in.
--
-- Run AFTER database/2026-cgt-parcels.sql. Additive only — three columns, all
-- nullable or defaulted, no data touched, no table rewritten. Safe to run twice.
--
-- 1. cgt_disposal_allocations.settled_at / settled_by
--    A settled disposal is never re-costed: its slices stand as written. Two
--    things can write them, and the difference matters when someone asks why a
--    figure is what it is —
--      'sale'     the slices were settled the moment the sale was recorded,
--                 from the parcels shown in the Sell dialog;
--      'backfill' the sale predates settlement entirely, and the slices were
--                 frozen later at the FIFO answer the Tax page was already
--                 giving for it. Freezing changed no figure on the day it ran;
--                 it stopped them changing afterwards.
--    Together with the timestamp, the rows say which of a user's realised gains
--    were fixed at the sale and which were fixed in one later pass, and when
--    that pass happened. Every row written before this column existed was
--    written by a sale, which is why 'sale' is the default.
--
-- 2. investment_sales.native_currency
--    The currency the ASSET was denominated in, as opposed to `currency`, which
--    is the currency the figures on the row are in (always the owner's own).
--    Disposing of a US-dollar CASH balance is a foreign exchange event and is
--    taxed differently from disposing of a US-listed share; a fully sold holding
--    is deleted, so the sale row has to be able to say which it was. NULL means
--    unknown, and unknown is never treated as foreign.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE cgt_disposal_allocations
  ADD COLUMN IF NOT EXISTS settled_at TEXT;

ALTER TABLE cgt_disposal_allocations
  ADD COLUMN IF NOT EXISTS settled_by TEXT NOT NULL DEFAULT 'sale';

ALTER TABLE investment_sales
  ADD COLUMN IF NOT EXISTS native_currency TEXT;

-- The audit question this table is asked: "which disposals were frozen in the
-- backfill, and when?"
CREATE INDEX IF NOT EXISTS idx_cgt_allocations_settled_by
  ON cgt_disposal_allocations(user_id, settled_by);
