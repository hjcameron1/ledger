-- ═══════════════════════════════════════════════════════════════════════════
-- CORPORATE ACTIONS — the third answer
--
-- Automatic split detection had two outcomes: apply the ratio to the unit
-- count, or drop the event. Dropping is right for a spin-off factor — value
-- left the company, the share count did not move — and quietly destructive for
-- a real consolidation announced in an awkward ratio, because the feed's price
-- falls by the ratio, the unit count does not rise to meet it, and the holding
-- sits at the wrong value for ever with nothing on any screen to say why.
--
-- Vodafone's 6-for-11 of 24 February 2014 is the case that forced this column.
-- Eleven shares became six; the price went from 134.50p on the Friday to 252.30p
-- on the Monday. Ledger kept the eleven and took the new price, so the holding
-- was worth 1.83x what its owner actually had — silently, permanently, and
-- straight into net worth. ASML's 77-for-100 of November 2012 is the same story
-- at 30%, and it is genuinely indistinguishable, by ratio alone, from Lloyds'
-- 41:40 rights-issue factor, which must NOT be applied.
--
-- So the events that cannot be told apart are no longer guessed at in either
-- direction. They are recorded here, against the holding, and the holder is
-- asked what really happened. Nothing in this column ever moves a number on its
-- own: it is a question, and the answer is an ordinary edit to the unit count,
-- which the parcel book already records as a split.
--
-- SHAPE. An array of objects, oldest first:
--
--   [{ "id":          "<uuid derived from holding + date + ratio>",
--      "date":        "2014-02-24",
--      "numerator":   6,
--      "denominator": 11,
--      "ratio":       0.54545455,
--      "seen_at":     "2026-08-30T21:00:00.000Z",
--      "resolved":    null | "applied" | "ignored",
--      "resolved_at": null | "<timestamp>" }]
--
-- The id is DERIVED — the same one the split would have been recorded under in
-- `cgt_splits` — so the same event seen again on the next run, on another device
-- or inside the seven-day heal window matches the entry already there and
-- changes nothing. Answered entries are KEPT and marked, never deleted, so a
-- question that has been answered is not asked a second time.
--
-- Safe to run more than once. Nothing is backfilled: the column starts NULL on
-- every holding and fills only with events seen from here on.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE investments
  ADD COLUMN IF NOT EXISTS pending_corporate_actions JSONB;

COMMENT ON COLUMN investments.pending_corporate_actions IS
  'Corporate actions the feed reported that Ledger would not classify. A question, never a value: nothing here changes a unit count until the holder answers. Answered entries are kept and marked so the question is not repeated.';

-- ── The split ratio needs more than eight decimal places ─────────────────────
--
-- Eleven shares becoming six is a ratio of 0.545454…, and at eight places that
-- is 0.54545455 — a hair HIGH. The holding is scaled by the ratio's TERMS and
-- lands on exactly 2,400 units from 4,400; the parcel book is scaled by this
-- stored number and lands on 2,400.00002. The two then disagree, and a full
-- sale leaves a phantom fraction behind that a later disposal is costed against.
--
-- Twelve places is inside a double's exactness and rounds back to the same
-- answer the terms give, on every ratio the feed has ever served. Widening a
-- numeric's scale keeps every existing value exactly as it is.
ALTER TABLE cgt_splits
  ALTER COLUMN ratio TYPE DECIMAL(30,12);

COMMENT ON COLUMN cgt_splits.ratio IS
  'New units per old unit: 10 for a 10:1 split, 0.1 for a 1:10 consolidation. Twelve decimal places, because ratios like 6-for-11 do not terminate and eight places drift the parcel book off the holding.';
