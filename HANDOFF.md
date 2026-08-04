# Ledger — Session Handoff

**Date:** 2026-07-12
**Repo:** `/Users/harrycameron/ledger` (GitHub `hjcameron1/ledger`, push to `main` auto-deploys frontend→Vercel, backend→Render)
**Stack:** React+TS+Vite+Tailwind+Zustand (frontend, Vercel) · Node+Express+TS (backend, Render) · Supabase Postgres · Telegram bot · Yahoo Finance prices · Claude AI parsing.

## Standing rules (carry forward)
- SQL migrations are run BY THE USER, not by us. ALWAYS paste migration SQL directly into chat (user can't open files).
- Never break recurring payments/subscriptions. Never log secret VALUES (booleans only). Never update git config. Never force-push to main.
- Delete temp/diagnostic scripts after use.
- Commit messages end with: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- No Hardwiring: never hand-patch data via curl to mask a bot failure — fix the system.
- Backend `.env` has `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`. One-off DB scripts: write a `*.mjs` in `backend/`, run with `node`, then `rm` it.

---

## This session — Income page financial-year (FY) scoping

**Scope:** Frontend only. Committed + pushed to `main`, deploying via Vercel.
**Context:** Australian FY = 1 July → 30 June, format `"YYYY-YYYY"`. Today 2026-07-12 → current FY = `2026-2027`.

### Problems reported
**A) Earned / on-track wrong at start of new FY.** New FY, nothing earned, but page showed ~$43,000 "earned this year" and ~$2,200,000 "on track".
- *Cause 1:* payslip aggregation counted ALL payslips regardless of FY → last year's stale `ytd_gross` read as this year's earnings (~$43k).
- *Cause 2:* on-track `weeksElapsed` computed from `financialYearStart()`; a last-FY `asOf` went negative and got clamped to `Math.max(1, …)` = 1 week → `earned / 1wk × 52` ≈ $2.2M.

**B) Pie + history showed last-FY entries; needed FY picker.** "Income by source · this FY" donut counted last-FY entries (e.g. 2 Jun 2026 Oliver Hume wage = $1,984). History had no FY selector.

### Changes made
**`frontend/src/utils/payroll.ts`**
- Added `inCurrentFinancialYear(p, ref=new Date())` — judges by `payment_date` (falls back to `pay_period_end`); undated slips kept.
- `payrollTotals`: grouping loop filters `payslips.filter(p => inCurrentFinancialYear(p))`.
- `onTrackAnnualFromPayslips`: FY-filters into `fyslips`, then uses it for empty check, `payrollTotals(fyslips)`, `weeksCovered`, `latestPayDate`.

**`frontend/src/utils/format.ts`**
- Added `financialYearOf(dateStr): string` — FY a date falls in (`month >= 7` logic, mirrors `getCurrentFinancialYear()`).

**`frontend/src/pages/Income.tsx`**
- Imports: `inCurrentFinancialYear` (payroll); `getCurrentFinancialYear`, `financialYearOf` (format).
- On-track calc FY-scoped: `fyPayslips = payslips.filter(inCurrentFinancialYear)` drives `weeksCovered`/`latestPayDate`/`weeksElapsed`/`onTrackAnnual`/`hasPayslips`.
- Pie (`bySource`) + `sourceDetail`: added `financialYearOf(e.date) === fy` guard → donut is current-FY only.
- New state `historyFY` (defaults to current FY); derived `historyFYs` (all FYs with entries, newest first) + `historyEntries` (approved entries in selected FY).
- Income History header: `<select>` FY dropdown (options `FY {y}`, current suffixed `(current)`); list maps `historyEntries`; empty state keyed to `historyFY`.

### Deliberately NOT changed
- Backend `backend/src/routes/payroll.ts` still returns ALL payslips — the raw **Payslips → History** list in `PayrollSection.tsx` intentionally keeps showing every payslip. FY-scoping is only on totals / on-track / pie / income-history.
- Telegram briefing has no payslip-derived earned/on-track line — nothing to fix there.

### Verification
- `npx tsc --noEmit` — clean.
- `npx vite build` — clean (only the pre-existing >500 kB chunk-size warning).

### Status
Both A and B implemented, built clean, committed, pushed to `main`, deploying via Vercel. If stale, hard-refresh once Vercel finishes.

## Known deferred (NOT requested)
- Route-based code-splitting to clear the ~500 kB bundle warning.
- Task #19 Phase 5 — Wine/watch live valuation via paid API.
