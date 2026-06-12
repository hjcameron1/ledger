# Handoff — Credit Card Statements Rework

_Last updated: 2026-06-12_

## What this feature is

Credit cards in Ledger are now **permanent entities** that accumulate **monthly statements**.
A card holds only card-level facts (name, institution, credit limit, currency); each
**statement** holds the per-cycle facts (closing balance, minimum payment, period, due
date, paid status). The card's `balance_owing` is derived from its unpaid statements.

## Intended UX flow (per user)

1. **Add a card first** — you cannot add a statement before a card exists.
2. **Add Card** form asks only: card name, institution, credit limit, currency.
   It does NOT ask for balance owing or minimum payment (those are statement-level).
3. **Two-step add**: Add card → optionally upload a statement PDF to auto-fill card
   details → confirm → if a statement was parsed, a **Confirm statement** popup appears
   (statement total, **minimum payment**, period, due date) → confirm to create the
   statement record.
4. **Click a card** to open its detail view. Inside:
   - **+ Add transaction** button (inline form).
   - **+ Add statement** button → opens the PDF uploader (auto-fills everything).
   - **Statements** list: latest 3 shown, "Show older statements" lazy-loads the rest.
   - **Click a statement** → filters the Transactions list to that statement's billing
     window; an **All statements** button clears the filter.
5. Dates are picked up from uploads so an older statement isn't treated as current.
6. Bank payments auto-reconcile against the right statement (incl. older ones) by
   remaining-balance amount matching.

## Status: DONE & deployed

All work is committed on `main` and pushed (Vercel frontend + Render backend auto-deploy).
Recent commits (newest first):

- `07d37a7` Select a statement → filter transactions to its period + "All statements" button
- `33abc0f` Open statement uploader above card (close detail, reopen after save)
- `0338363` "+ Add statement" button (PDF uploader) in card detail
- `a08d3cb` Statements carry `minimum_payment`; added to Confirm step + detail view
- `662b244` Add Card form: dropped balance owing & minimum payment
- `4d630ad` Two-step add; add-transaction button; amount-match older statements

## ⚠️ Pending action — USER MUST RUN THIS MIGRATION

`minimum_payment` will not persist until this column exists. Paste into Supabase SQL editor:

```sql
ALTER TABLE credit_card_statements ADD COLUMN IF NOT EXISTS minimum_payment numeric;
```

(The base `credit_card_statements` table + `pending_payments.statement_id` were created in
an earlier migration; this is the only outstanding one.)

## Key files

- **frontend/src/pages/Accounts.tsx** — main UI.
  - `AddCreditCardModal`: two-step flow (`step: 'card' | 'statement'`), `parsedStatement`,
    `stmtForm`, `commit(statement | null)`.
  - `CardDetailModal`: props `onAddStatement`, `onAddTransaction`; state `expandedStmtId`
    (also drives transaction filtering via `selectedStmt`/`selectedWindow`), `showAllStmts`,
    `showAddTx`, `txForm`.
  - Uploader open/close: `uploadCardOpen` state; opening from card detail does
    `setDetailCardId(null); setUploadCardOpen(card.id)`, and on save/close reopens the card.
- **frontend/src/services/dataService.ts**
  - `creditCardStatementsDS` (add/update/markPaid/getForCard) — `add()` takes `minimum_payment`.
  - `applyCardPayment(cardId, amount, txId)` — matches an unpaid statement by remaining
    balance within 5% tolerance, else falls back to newest unpaid.
  - `tryReconcileTransaction(tx)` runs inside `transactionsDS.add()` for bank txns.
- **frontend/src/types/index.ts** & **backend/src/types/index.ts** — `CreditCardStatement`
  includes `minimum_payment?: number | null`.
- **backend/src/routes/accounts.ts** — statement GET (paged `before=`)/POST/PATCH. POST/PATCH
  spread `...req.body` into Supabase, so new columns need only a DB column + frontend payload.

## Architecture notes

- Local-first: `dataService` updates the Zustand store (persisted to localStorage); backend
  sync via `syncQueue.ts` (`syncWithRetry(kind, payload)`, `resolveId`, `swallow404`).
- `credit_card_statements` is the source of truth for `balance_owing`.
- `enrichWithDisplayAmounts(rows, fields[], preferred)` adds `display_*` fields server-side.
- Deploy = push to `main`. Feature work was on `feat/credit-card-statements`, merged `--no-ff`.

## Standing project rules (do not violate)

- **SQL migrations are run BY THE USER** — always paste migration SQL directly into chat.
- Never break recurring payments / subscriptions. Never log secret VALUES (booleans only).
- Never update git config. Never force-push to `main`.
- Delete temp/diagnostic scripts after use (one-off DB scripts: `*.mjs` in `backend/`,
  run with node using `.env` SUPABASE_* keys, then `rm`).
- Commit messages end with: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- Always deploy frontend to Vercel.

## Suggested next steps / open questions

- Confirm the `minimum_payment` migration has been run, then verify min payment persists.
- BASIQ "no statement / partial payment" prompt queue (plan items 3 & 4) — verify behavior
  once BASIQ is live; currently exercised via manually-imported bank transactions.
- Optionally surface which card a transaction came from to GROK/matcher (user mentioned;
  reconciliation already targets the right card — confirm matcher context is sufficient).
