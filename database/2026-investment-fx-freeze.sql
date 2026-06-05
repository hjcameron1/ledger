-- Migration: per-holding FX snapshot for market-hours price/value freezing.
-- Adds the columns the backend writes during in-session price refreshes so a
-- holding's converted value stays frozen while its market is closed.
--
-- Safe to run once on the existing database (idempotent via IF NOT EXISTS).
-- Run with:  ./database/migrate.sh <db-password>  is for schema.sql; for this
-- one-off, apply it directly, e.g.:
--   psql "$LEDGER_DB_URL" -f database/2026-investment-fx-freeze.sql

ALTER TABLE investments
  ADD COLUMN IF NOT EXISTS conversion_rate  DECIMAL(18,8) DEFAULT 1,
  ADD COLUMN IF NOT EXISTS display_currency TEXT          DEFAULT 'AUD';
