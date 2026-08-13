-- ══════════════════════════════════════════════════════════════════════════════
--  Phase 2D.1 — Transaction tax metadata
--  Run this in the Supabase SQL editor (idempotent; safe to re-run).
--
--  Builds on Phase 2A (2026-transaction-foundation.sql), which already added the
--  first three per-transaction tax fields:
--        is_tax_deductible  BOOLEAN   -- is this line claimable?
--        deduction_category TEXT      -- which deduction bucket (e.g. Self-education)
--        entity             TEXT      -- 'business' | 'personal'
--
--  This migration only ADDS the two remaining fields the tax-metadata surface
--  needs. NOTHING from 2A/2B/2C is changed — dedup, transfers, merchant
--  recognition, rules, refunds, splits, spend and offline-sync all keep their
--  meaning. Both columns are nullable and free-form, so every existing row and
--  every existing code path is unaffected.
--
--  This is per-transaction metadata only. It does NOT replace the standalone
--  `tax_deductions` table (manual, financial-year deduction line items with a
--  receipt_url) — the two coexist. No tax CALCULATIONS are introduced here.
-- ══════════════════════════════════════════════════════════════════════════════

-- Free-text note explaining the tax treatment (e.g. "50% work use, home office").
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS tax_note   TEXT;

-- Reference to the receipt / evidence backing the claim: a URL, a file id, or a
-- plain note describing where the evidence lives. Free-form TEXT, no FK.
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS receipt_ref TEXT;
