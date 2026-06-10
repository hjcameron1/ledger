# Ledger — Session Handoff

**Date:** 2026-06-10
**Repo:** `/Users/harrycameron/ledger` (GitHub `hjcameron1/ledger`, push to `main` auto-deploys frontend→Vercel, backend→Render)
**Stack:** React+TS+Vite+Tailwind+Zustand (frontend, Vercel) · Node+Express+TS (backend, Render) · Supabase Postgres · Telegram bot · Yahoo Finance prices · Claude AI parsing.

## Standing rules (carry forward)
- SQL migrations are run BY THE USER, not by us. ALWAYS paste migration SQL directly into chat (user can't open files).
- Never break recurring payments/subscriptions. Never log secret VALUES (booleans only). Never update git config. Never force-push to main.
- Delete temp/diagnostic scripts after use.
- Commit messages end with: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- Backend `.env` has `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`. One-off DB scripts: write a `*.mjs` in `backend/` (so it resolves `dotenv`/`@supabase/supabase-js`), run with `node`, then `rm` it.

---

## What this session did (all shipped & pushed)

### 1. Per-investment "Today's change" (% and $)
- Added `day_change_percent` column on `investments` (from Yahoo `regularMarketChangePercent`).
- `priceService.fetchCurrentPrice` now returns `dayChangePercent`; `updateAllInvestmentPrices` stores it — **including while a market is closed** (fetches just the day-change/FX, leaves price frozen).
- Frontend `Investments.tsx` shows a `Today: +$x (+y%)` line under each holding's total P&L. `$` derived as `value − value/(1+pct/100)`. Wired through `verification.day_change` / `day_change_percent` in `dataService.getAll` + `types/index.ts`.

### 2. FX kept live while markets are closed
- `updateAllInvestmentPrices` closed-market branch: share **price stays frozen**, but **FX `conversion_rate` is refreshed every cron tick** (forex trades 24/5). Net worth now moves slightly overnight on FX — intended.

### 3. Cost basis is LOCKED at purchase, never moves with FX  ← core correctness fix
- **Problem:** cost stored in native (USD) was re-multiplied by the live rate on every read, so cost (and P&L) drifted as FX moved.
- **Fix:** POST `/investments` and PUT `/investments/:id` now convert the entered cost into the owner's preferred currency ONCE and store `cost_basis_currency = preferred`, so it's frozen thereafter.
- Add path also snapshots `conversion_rate` + `display_currency` at insert (previously defaulted to 1 → foreign holdings showed ~unconverted until next cron).
- Backfilled all existing rows to AUD (one-off script, already run).

### 4. Foreign cost converted at the PURCHASE-DATE rate (portfolio-accurate)
- New `currencyService.getRateOn(from, to, date)` — Frankfurter historical endpoint `/{date}`.
- Optional **Purchase date** field added to the Add form (`acquired_date`), passed through `dataService.add` → `investment.create` sync → POST body.
- New column `acquired_date DATE` on `investments`. Used for cost FX lock and feeds CGT held-time.

### 5. Live FX from Yahoo instead of ECB daily reference  ← the big "value is ~$130 off" fix
- **Root cause:** Frankfurter = ECB reference rate published once/day. Ledger was converting at a day-old 1.4163 while the broker used live ~1.4229 (~0.5% → ~$130 portfolio value gap, ~$20 P&L gap).
- **Fix:** `currencyService.getRate` now tries **live Yahoo FX** (`${from}${to}=X`, e.g. `USDAUD=X`) FIRST, falling back to stored reference → Frankfurter. yahoo-finance2 v3 needs `new YahooFinance({ suppressNotices:['yahooSurvey'] })`.
- Refreshed existing foreign holdings to the live rate. Value now matches broker within a few dollars.

---

## ⚠️ MIGRATIONS THE USER MUST RUN (paste these into Supabase)
```sql
ALTER TABLE investments ADD COLUMN IF NOT EXISTS day_change_percent NUMERIC;
ALTER TABLE investments ADD COLUMN IF NOT EXISTS acquired_date DATE;
```
(User has confirmed running the `day_change_percent` one already; confirm `acquired_date` is run.)

---

## Open / outstanding
- **SPY & VOO cost basis still ~$114 under broker.** They're locked at the old day-old rate (23,961.91 vs broker 24,075.81) because the user re-added them entering USD with **no purchase date**. FIX: user edits each, enters cost in USD **+ the actual purchase date** → cost re-locks at that day's real rate. After that, value/cost/P&L all match broker.
- **Not yet done (nice-to-have):** show each holding's P&L in its native currency too, e.g. `−$15.59 AUD (−$11.01 USD)`, so it lines up with the broker at a glance. User was offered this; hasn't confirmed.
- **Import flow:** Claude parsing (`claudeService.ts`) extracts `purchase_date` only for collectibles, not stocks. Could extract it for all asset types so imported foreign portfolios auto-lock cost at the right historical rate. The sequential import review modal already lets the user add the date per holding manually.
- Task #19 (DEFERRED, pre-existing): Phase 5 live wine/watch valuation via paid API — not in scope.

## Key files
- `backend/src/services/currencyService.ts` — `getRate` (live Yahoo first), `getRateOn` (historical), `fetchLiveYahooRate`.
- `backend/src/services/priceService.ts` — `fetchCurrentPrice` (+dayChangePercent), `updateAllInvestmentPrices` (closed-market FX/day-change refresh).
- `backend/src/routes/investments.ts` — `enrichInvestment`, POST (cost lock + rate snapshot + acquired_date), PUT (cost re-lock).
- `frontend/src/pages/Investments.tsx` — holdings list "Today:" line, Add form purchase-date field.
- `frontend/src/services/dataService.ts` — `investmentsDS.getAll` (day_change calc), `add` (acquired_date passthrough).
- `frontend/src/types/index.ts` — `Investment.day_change_percent`, `verification.day_change*`.
- `database/schema.sql` — investments table + ALTERs.

## Current holdings (for sanity-checking math)
Gold, Silver, VGS.AX (AUD, fine) · SPY (USD, ~25.48 sh) · VOO (USD, ~0.43 sh). Live USD→AUD ≈ 1.4229.
