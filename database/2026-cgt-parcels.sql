-- Phase 5.7 — THE PARCEL BOOK BECOMES DURABLE.
--
-- Until now a capital-gains parcel lived in the browser's localStorage. That was
-- deliberate (no migration, no server work) and it survived a reload, but it did
-- not survive a new device, a cleared cache or a second browser — and on a device
-- that had never seen the portfolio, every sale silently fell back to the
-- holding's AVERAGE cost. These four tables move the acquisition record next to
-- the money it explains.
--
-- WHY IDs ARE MINTED BY THE CLIENT. Every row here is written with the uuid the
-- browser already generated for it, and every write is an upsert on that id. A
-- parcel is not "a row the server allocates"; it is a fact the user recorded,
-- and giving it one identity everywhere means a replayed sync (the enqueue-first
-- queue's whole job) converges instead of inserting a twin. It also means the
-- local book can be adopted onto the server exactly once, without duplication,
-- because the rows it pushes already carry the ids it holds them under.
--
-- Safe to run more than once (IF NOT EXISTS throughout). Ledger degrades
-- gracefully until it IS run: the routes answer "not available yet", the client
-- keeps its local book untouched, and the first bootstrap after the migration
-- adopts that book onto the server.

-- ── 1. Parcels — the acquisition ledger ──────────────────────────────────────
-- One row per purchase: the units bought, what they cost LOCKED in the owner's
-- preferred currency at the rate on the day, and the date they were bought.
--
-- investment_id has NO foreign key, deliberately, exactly as investment_sales
-- does not: a holding that is fully sold is DELETED from `investments`, and the
-- disposal it left behind still has to be costed from these parcels at tax time.
-- A cascade here would erase the cost base of every sale the moment the holding
-- emptied. It is nullable because the Tax page can record a parcel for something
-- Ledger holds no row for (a ticker the user names themselves).
CREATE TABLE IF NOT EXISTS cgt_parcels (
  id            UUID          PRIMARY KEY,
  user_id       UUID          NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  investment_id UUID,
  label         TEXT          NOT NULL DEFAULT 'Holding',
  ticker        TEXT,
  asset_type    TEXT,
  quantity      DECIMAL(24,8) NOT NULL,
  -- Already in the preferred currency. Never re-converted, never revalued.
  cost_base     DECIMAL(15,2) NOT NULL DEFAULT 0,
  acquired_date DATE,
  -- 'holding' = the placeholder Ledger opened for a purchase; 'user' = typed in,
  -- and a 'user' parcel supersedes the placeholder for the same holding.
  origin        TEXT          NOT NULL DEFAULT 'user',
  -- The SPLIT CLOCK, not a timestamp: "<iso>#<zero-padded counter>". Everything
  -- recorded before a split is re-expressed in the new units; everything after
  -- is already in them. Stored as TEXT because the counter is part of the value
  -- and plain string order is the real order.
  recorded_at   TEXT,
  created_at    TIMESTAMPTZ   DEFAULT NOW(),
  updated_at    TIMESTAMPTZ   DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cgt_parcels_user ON cgt_parcels(user_id);
CREATE INDEX IF NOT EXISTS idx_cgt_parcels_investment ON cgt_parcels(investment_id);

DROP TRIGGER IF EXISTS trg_cgt_parcels_updated_at ON cgt_parcels;
CREATE TRIGGER trg_cgt_parcels_updated_at
  BEFORE UPDATE ON cgt_parcels
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── 2. Splits — unit counts only, never cost or dates ────────────────────────
-- A split is not a CGT event. It is recorded as an EVENT rather than applied as
-- an edit so the parcels keep their original cost and acquisition dates: 1,000
-- units at $19,600 bought in 2019 become 10,000 units at $19,600 bought in 2019.
CREATE TABLE IF NOT EXISTS cgt_splits (
  id            UUID          PRIMARY KEY,
  user_id       UUID          NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  investment_id UUID,
  label         TEXT          NOT NULL DEFAULT 'Holding',
  ticker        TEXT,
  -- New units per old unit: 10 for a 10:1 split, 0.1 for a 1:10 consolidation.
  ratio         DECIMAL(24,8) NOT NULL,
  recorded_at   TEXT,
  created_at    TIMESTAMPTZ   DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cgt_splits_user ON cgt_splits(user_id);
CREATE INDEX IF NOT EXISTS idx_cgt_splits_investment ON cgt_splits(investment_id);

-- ── 3. Disposal allocations — WHAT A SALE ACTUALLY CONSUMED ──────────────────
-- The audit trail, and the reason a lodged year stops moving. Without it the
-- cost base of every past disposal is re-derived by FIFO on every read, so
-- recording an old parcel today silently re-costs a sale from three years ago —
-- a number that may already be on a return the ATO has accepted. With it, a sale
-- says which parcels it drew on and what each slice cost, and that stands.
--
-- parcel_id is TEXT, not UUID: a holding with nothing written down is costed
-- from a placeholder DERIVED from the holding itself, whose id is
-- 'derived:<investment id>'. That id is deterministic on every device, so the
-- allocation stays meaningful; it is simply not a uuid. NULL means these units
-- came from no parcel at all and used the figures on the sale itself.
CREATE TABLE IF NOT EXISTS cgt_disposal_allocations (
  id            UUID          PRIMARY KEY,
  user_id       UUID          NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The investment_sales row this belongs to. No FK for the same reason as
  -- above: the client mints the sale's id and may push the allocation before the
  -- sale itself has landed.
  sale_id       UUID          NOT NULL,
  parcel_id     TEXT,
  quantity      DECIMAL(24,8) NOT NULL,
  cost_base     DECIMAL(15,2) NOT NULL DEFAULT 0,
  acquired_date DATE,
  -- 'parcel' | 'recorded' | 'unmatched' — where this slice's cost came from.
  source        TEXT          NOT NULL DEFAULT 'parcel',
  recorded_at   TEXT,
  created_at    TIMESTAMPTZ   DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cgt_allocations_user ON cgt_disposal_allocations(user_id);
CREATE INDEX IF NOT EXISTS idx_cgt_allocations_sale ON cgt_disposal_allocations(sale_id);

-- ── 4. The opening loss — one row per user ───────────────────────────────────
-- Unapplied capital losses from the last return the user lodged. Ledger cannot
-- know about a loss made before it existed, a carried-forward loss lives
-- forever, and it was kept in the same local blob as the parcels — so a fresh
-- device forgot it and quietly taxed a gain the loss should have absorbed.
CREATE TABLE IF NOT EXISTS cgt_settings (
  user_id            UUID          PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  -- The first financial year Ledger is responsible for, as 'YYYY-YYYY'.
  opening_fy         TEXT,
  opening_ordinary   DECIMAL(15,2) NOT NULL DEFAULT 0,
  opening_collectable DECIMAL(15,2) NOT NULL DEFAULT 0,
  updated_at         TIMESTAMPTZ   DEFAULT NOW()
);

DROP TRIGGER IF EXISTS trg_cgt_settings_updated_at ON cgt_settings;
CREATE TRIGGER trg_cgt_settings_updated_at
  BEFORE UPDATE ON cgt_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
