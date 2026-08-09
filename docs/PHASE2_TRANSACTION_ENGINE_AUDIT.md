# Ledger Phase 2 — Transaction Engine: Technical Audit

**Status:** Inspection only. Nothing changed. This documents the *existing* system so Phase 2 can extend it safely.

**Scope of inspection:** `database/schema.sql`, `database/2026-*.sql`, `backend/src/routes/{accounts,basiq,upload,settings}.ts`, `backend/src/services/{pdfParser,basiqService,claudeService,telegramService,integrationSummary,netWorthSnapshot}.ts`, `frontend/src/services/dataService.ts`, `frontend/src/utils/{recurringDetection,categories,format}.ts`, `frontend/src/components/overview/BudgetSection.tsx`, `frontend/src/pages/Accounts.tsx`, `frontend/src/store/index.ts`, `frontend/src/types/index.ts`.

---

## KEY ARCHITECTURAL FACT (read first)

**Ledger is local-first. The "transaction engine" lives in the browser, not the backend.**

- The Zustand store (`frontend/src/store/index.ts`) is the working set, persisted to `localStorage`.
- All mutations go through `dataService.ts` "DS" objects (`transactionsDS`, `subscriptionsDS`, …), which write the store immediately and enqueue a background sync (`syncWithRetry`) to the backend.
- The backend (`routes/accounts.ts`) is a **thin CRUD passthrough over Supabase**. `POST /accounts/transactions` does `insert({ ...req.body })` with **zero processing** — no dedup, categorisation, transfer, or recurring logic (`accounts.ts:382`).
- **Ingestion parsers only parse.** `POST /api/upload/parse` returns parsed JSON to the browser; the browser's modals decide what to save. Basiq routes return normalised rows; the browser merges them.

Consequence: every rule below runs client-side, per-device, mostly at render time (`useMemo`) and is **not persisted**. Two devices can disagree.

---

# TRANSACTION MODEL (Q1–Q6)

## Q1. Tables relating to transactions
- **`transactions`** — the only transaction table (`schema.sql:137`).
- Adjacent/related: `subscriptions`, `bills`, `pending_payments`, `credit_card_statements` (defined in a separate CC migration), `budget_lines`/`budget_settings`/`custom_categories` (`2026-budget.sql`), `income_entries`, `tax_deductions`. None of these hold transaction rows; they reference transactions only loosely (mostly by fuzzy name, not FK).

## Q2. Current fields (`transactions`, `schema.sql:137–153`)
| Field | Purpose |
|---|---|
| `id` UUID | PK. Client mints a temp UUID; server id reconciled via `idMap` (`dataService.ts:178`). |
| `user_id` UUID | Owner. FK → `users`, `ON DELETE CASCADE`. |
| `account_id` UUID | Which account/card/loan. **No FK, no index constraint to a specific table.** |
| `account_type` TEXT | Discriminator: `'bank' | 'credit_card' | 'loan'` (loan added `2026-transaction-loan-type.sql`). Tells you *which* table `account_id` points at. |
| `date` DATE | Transaction date. |
| `merchant` TEXT NOT NULL | Display name. Holds Basiq's enriched `businessName`, else raw description, else statement text. **Also the only description field.** |
| `amount` DECIMAL(15,2) | Signed: negative = debit/outflow, positive = credit/inflow. |
| `currency` TEXT | Native currency; display conversion added at read time (`enrichWithDisplayAmounts`). |
| `category` TEXT | Free-text category. No FK, no enum. |
| `notes` TEXT | Free-text. Only user-metadata field that exists. |
| `is_duplicate_flagged` BOOL | **Dead field — never set `true` anywhere** in the codebase. |
| `is_subscription` BOOL | Set `true` only on the manual "this row is a subscription" import path (`Accounts.tsx:1106`). Not maintained by auto-detection. |
| `basiq_tx_id` TEXT | Basiq's tx id. Sole dedup key for Basiq. Indexed. |
| `created_at`/`updated_at` | Timestamps; `updated_at` trigger-maintained. |

## Q3. Relationships
- **users:** `user_id` FK, cascade delete. ✅ real FK.
- **accounts:** `account_id` + `account_type` — a **polymorphic pointer with no FK**. Resolution is client-side via `resolveAccountId`/`accountIdMatches`/`accountIdVariants` (`dataService.ts:125–169`) because of the temp-id→server-id problem.
- **categories:** free-text string only. No join. `custom_categories` table exists (`2026-budget.sql:61`) but transactions reference categories by *name*, not id.
- **recurring payments (`subscriptions`):** **No persistent link.** A subscription is matched to transactions only by fuzzy normalised-name at detection time (`recurringDetection.ts`). `subscriptions.account_id` is optional and advisory.
- **bills:** `bills.subscription_id` links a bill to a subscription (`schema.sql:476`). Bills are **not** linked to transactions at all.
- **credit cards:** transactions with `account_type='credit_card'`, `account_id=card.id`. Repayments handled out-of-band via `pending_payments` + `credit_card_statements`.
- **investments:** **no link.** Investment buys/sells/dividends live in `investments`/`investment_sales`/`dividends`, never as `transactions`.

## Q4. Raw/source data preserved? **No.**
`merchant` is overwritten with Basiq's enriched businessName at ingestion (`basiq.ts:357`) and with parser output for statements. There is **no `raw_description`** column. When the user edits `merchant`, the prior value is lost. The only "original preserved" behaviour anywhere is `subscriptions.original_name` and `bills.original_name` — not on transactions.

## Q5. Source distinction (statement vs manual vs Basiq)? **Weak.**
- Basiq rows are identifiable by `basiq_tx_id != null`.
- **Statement-imported and manually-created rows are indistinguishable at the DB level** — there is no `source` column on `transactions`. (`is_manual` exists on `bank_accounts`/`credit_cards`, and `credit_card_statements.source` exists, but not on transactions.)

## Q6. Fields duplicating the same concept
- `is_subscription` (bool on tx) vs the `subscriptions` table — two representations of "recurring", not kept in sync.
- `is_duplicate_flagged` — dead concept, never written.
- **Category taxonomy overlaps itself**: `BASE_TX_CATEGORIES` (`categories.ts:6`) contains `Food` **and** `Groceries` **and** `Dining`; `Bills` **and** `Utilities` **and** `Rent` **and** `Insurance`. Different code paths emit different ones (`autoCategory` emits `Groceries/Dining`; LLM prompts emit `Groceries|Dining|...`; Basiq emits ANZSIC titles that match none of them).

---

# INGESTION (Q7–Q10)

## Q7. Entry paths
1. **PDF statement** → `dataService.parseDocument()` → `POST /api/upload/parse` → `extractPdfText` (pdfjs) → **Groq `llama-3.3-70b`** (`pdfParser.ts:parseWithGemini`) → **Claude fallback** (`claudeService.parseFinancialDocument`) if Groq unavailable/over-budget or PDF is scanned. Returns parsed JSON to the browser. Saved by `AddBankAccountModal`/`AddCreditCardModal` in `Accounts.tsx` via `transactionsDS.add`.
2. **CSV** → `upload.ts:39` routes **all CSV to `parsePortfolioText`** (Claude) — i.e. CSV is treated as an **investment portfolio**, not bank transactions. **There is no CSV bank-statement → transactions path.**
3. **Basiq** → `basiqDS.syncAll()` (`dataService.ts:2824`) → `GET /api/basiq/accounts` + `/transactions` → normalised rows → merged into store, each new row via `transactionsDS.add`.
4. **Manual** → `transactionsDS.add()` directly (`AddTransactionModal`).

## Q8. Shared pipeline? **No — three divergent paths.**
There is no common "ingest a transaction" function. Each path has its own dedup rule, its own categorisation, and its own (in)ability to run transfer/recurring detection.

## Q9. Processing before save
- **Statement path** (`Accounts.tsx:2740` bank, `:2896` card): sign-normalise amount, **dedup by `(account_type, date, |amount|)`**, `category = autoCategory(merchant)`, then `transactionsDS.add`.
- **Basiq path** (`dataService.ts:2976`): **dedup by `basiq_tx_id`**, `category = t.category ?? autoCategory(merchant)`, `transactionsDS.add`.
- **Manual path**: **no processing at all.**
- `transactionsDS.add` (`dataService.ts:747`) itself runs exactly one thing: `tryReconcileTransaction` for bank rows (credit-card-repayment matching). It does **not** dedup, categorise, or detect transfers.

## Q10. Can imports bypass processing? **Yes, extensively.**
- **Manual entry bypasses dedup entirely.**
- **Recurring detection** never runs at ingestion — it's a separate global pass (`useRecurringDetection`, mounted in `App.tsx`) over whatever is in the store.
- **Internal-transfer detection** never runs at ingestion — it's a render-time `useMemo` in `Accounts.tsx:64`, and only affects the per-account spend display.
- **Categorisation** is keyword-only and silently falls back to `'Uncategorised'`.

---

# MERCHANTS (Q11–Q14)

## Q11. Merchant detection/normalisation
`normaliseMerchant()` (`recurringDetection.ts:35`) is a solid bank-agnostic normaliser: strips "Direct Debit", card refs, URLs, ID tokens, camelCase IDs, locations/currency codes, keeps the first 3 meaningful words, preserves `xx1234` account refs. `isTransferMerchant()` (`:14`) flags transfer/PayID/BPAY strings.

## Q12. Merchant stored separately from raw description? **No.**
`normaliseMerchant` output is **computed on the fly** during detection and **never stored**. There is one `merchant` column that is both raw and display.

## Q13. Merchant aliases/mappings? **No table, no store.** `autoCategory` (`format.ts:133`) is a hardcoded keyword→category list — the closest thing to a merchant map, and it maps to *categories*, not canonical merchants.

## Q14. User-specific merchant corrections remembered? **No** for transactions. Editing a transaction's merchant just overwrites the string. (Only `subscriptions.original_name` remembers anything, and only for renamed subscriptions.)

---

# CATEGORIES (Q15–Q20)

## Q15. Category system
Free-text strings. Universe = `BASE_TX_CATEGORIES` (21 built-ins, `categories.ts:6`) ∪ `custom_categories` (DB, `2026-budget.sql:61`) ∪ budget-line categories. An **allowlist** (`selectedCategories`) plus `hiddenCategories` filter what's *pickable* (`useAllCategories`, `categories.ts:49`); allowlist persists in `users.ui_preferences` (JSONB).

## Q16. Automatic categorisation — three independent sources, no reconciliation:
1. **`autoCategory(merchant)`** — 13 hardcoded keyword rules (`format.ts:133`), else `'Uncategorised'`. Used by statement + Basiq-fallback paths.
2. **LLM parse-time category** — Groq/Claude prompt asks for a category from a fixed pipe-list (`pdfParser.ts:260`, `claudeService.ts:281`).
3. **Basiq ANZSIC title** — `t.enrich.category.anzsic.title` (`basiq.ts:360`) — free-form and does **not** match the built-in taxonomy.

## Q17. Can users correct categories? **Yes** — `PATCH /accounts/transactions/:id` (`accounts.ts:393`) or inline edit → `transactionsDS.update`.

## Q18. Do corrections affect future transactions? **No.** There is no learning/rule persistence. Correcting "Woolworths → Groceries" teaches nothing.

## Q19. Categorisation rules exist? **No rules engine.** Only the static `autoCategory` keyword table.

## Q20. Custom categories / allowlist interaction
Custom categories merge into the pick-list everywhere (`mergeCategories`). The allowlist governs *pickability* only — it does **not** re-file existing transactions, and a transaction can hold a category that's since been removed from the allowlist.

---

# TRANSFERS (Q21–Q25)

## Q21–Q23. Internal-transfer detection
`detectInternalTransferIds(transactions)` (`recurringDetection.ts:314`). Two rows are a transfer pair when **all** hold:
- different `account_id`,
- amounts equal to the cent (`|c.amount − |d.amount|| ≤ 0.01`),
- dates within 2 days,
- **at least one leg's merchant is transfer-like** (`isTransferMerchant`).

Greedy one-to-one (each credit consumed once). **Not persisted — recomputed every render via `useMemo`. There is no `transfer_pair_id` or equivalent.** (Q23 = **No.**)

## Q24. What transfers affect
- **Spending (per-account view in `Accounts.tsx`):** excluded ✅ (uses `internalTransferIds`).
- **Spending (Budget section):** **NOT excluded** ❌ — `spendByCategoryBetween` (`BudgetSection.tsx:197`) sums every negative amount by category with no transfer awareness.
- **Income:** the credit leg is positive; income is sourced from `income_entries`, so transfer credits don't inflate the income figure — but they aren't excluded from any "credits" view either.
- **Budgeting:** inherits the Budget-section behaviour → transfers *can* land in a budgeted category.
- **Net worth:** unaffected — `netWorthSnapshot.ts` uses account **balances**, not transactions.

## Q25. Credit-card repayment double-counting — **REAL RISK.**
A repayment is a bank debit like "AMEX PAYMENT". `autoCategory` has no credit-card rule → it becomes **`Uncategorised` spend**. Meanwhile the card's purchases are *also* counted as spend. `tryReconcileTransaction` (`dataService.ts:689`) consumes the debit to decrement the card balance/tick a statement, but **does not recategorise it or exclude it from spend**. So:
- **Budget/spend totals: the repayment double-counts** (purchases + the repayment).
- **`integrationSummary.monthlyExpenses` (`integrationSummary.ts:105`): worst case** — it sums `Math.abs(amount)` over **all** transactions in 30 days, counting income credits, transfers, and repayments as expenses.

---

# DUPLICATES (Q26–Q29)

## Q26–Q27. Detection & fields compared
- **Statement re-import:** `(account_type == && date == && |amount| within 0.01)` — **not account-scoped, not merchant-scoped** (`Accounts.tsx:2749`, `:2903`).
- **Basiq:** `basiq_tx_id` set membership only (`dataService.ts:2972`).
- **Cross-account (advisory only):** `findCrossAccountDuplicate` (`recurringDetection.ts:582`) = different account + same normalised merchant + amount within 2% + same date. Used to warn on manual add, not to block imports.
- **Bootstrap load:** transactions are merged by `id` only — `dedupeByContent` is applied to accounts/cards/subscriptions but **not to transactions** (`dataService.ts:2185` vs `:2252`).

## Q28. Across sources
- **Repeated statement imports:** caught by the `(type,date,|amt|)` rule — but see Q29.
- **PDF vs CSV:** N/A — CSV never becomes a bank transaction (Q7).
- **Statement vs Basiq:** the statement rule compares against *all* existing rows including Basiq ones, so it may coincidentally suppress or coincidentally duplicate; there is **no deliberate cross-source matching** (no date+amount+merchant tie-break).
- **Basiq refresh:** solid via `basiq_tx_id`.

## Q29. Risk of removing legitimate transactions? **Yes.**
The statement dedup key `(account_type, date, |amount|)` is coarse: two genuine $4.50 purchases on the same day and same account-type collapse into one. It ignores account and merchant, so it can silently drop real spend on re-import.

---

# SPLITS (Q30–Q32)

## Q30. Exist? **No.**
## Q31. n/a.
## Q32. Best architectural fit
A `transaction_splits` child table (or a `parent_transaction_id` self-reference on `transactions` + a `is_split_parent` flag). Parent keeps the true bank amount and is **excluded** from category spend; children carry `(category, amount, note)` and sum to the parent. Reporting reads children when present, parent otherwise. This slots cleanly under the "one canonical transaction → optional split" goal without touching the ingestion paths.

---

# RECURRING TRANSACTIONS (Q33–Q38)

## Q33. Detection
`detectRecurringPatterns(transactions, subscriptions)` (`recurringDetection.ts:369`), driven globally by `useRecurringDetection`. Groups debits by `normaliseMerchant` (or exact raw for transfers), merges same-first-word groups, clusters within edit-distance 2, requires ≥2 occurrences.

## Q34. Frequency inference
`classifyFrequency(avgGap)` bands (`:113`): weekly 4–9d, fortnightly 10–20d, monthly 21–45d, quarterly 75–110d, annually 330–400d, plus a `MAX_SPREAD` consistency gate that **demotes to `'irregular'`** rather than dropping the pattern.

## Q35. Next-charge date
`calcNextChargeDate` (`:273`) — calendar-month aware (`addMonthsUTC` preserves day-of-month, clamps short months), advances until future.

## Q36. Recurring records linked to source transactions? **No.**
`subscriptions` rows carry no transaction ids. Re-linking is by fuzzy name each run. Suppression of already-tracked patterns is by normalised-name set (`subNormNames`, `subTransferKeys`, `:376`).

## Q37. Renamed recurring preserves original? **Yes.** `subscriptionsDS.rename` (`dataService.ts:824`) snapshots the first name into `original_name`; detection suppresses by both current and original name.

## Q38. Interaction with Bills
Opt-in "also add to bills" creates a `bills` row linked via `bills.subscription_id`; renames/removes cascade (`billsDS.removeBySubscription`/`removeByName`). Detection suppression (skip/ignore) is **session/localStorage only** (`SESSION_SKIP_PREFIX`, `PERMANENT_DISMISS_PREFIX`, `:190`/`:221`) — **no DB memory**, so a dismissed pattern re-surfaces on another device.

---

# TAX / METADATA (Q39–Q40)

## Q39. Transaction supports:
| Field | Present? |
|---|---|
| tax-deductible status | ❌ |
| deduction category | ❌ (separate `tax_deductions` table, unlinked) |
| business/personal | ❌ |
| notes | ✅ (`notes`) |
| tags | ❌ |
| review status | ❌ |

## Q40. Metadata to add now (without building the tax engine)
Add nullable columns so data can accrue before features ship: `source`, `raw_description`, `merchant_normalized`, `merchant_id`, `transfer_pair_id`, `is_transfer`, `review_status`, `confidence`, `tags JSONB`, `is_tax_deductible`, `deduction_category`, `entity` (business/personal), `parent_transaction_id`. None need UI on day one.

---

# SEARCH & EDITING (Q41–Q43)

## Q41. Search/filter/edit
`GET /accounts/transactions` supports `account_id`, `search` (ILIKE on merchant), `since`/`before`, `limit`/`offset` (`accounts.ts:359`). Client `transactionsDS.getAll` filters by resolved account + substring. Edit via `PATCH` / `transactionsDS.update`.

**Note:** `PATCH` passes `req.body` straight to `update()` with **no field allowlist** (`accounts.ts:393`) — unlike the subscriptions PATCH which allowlists. A client can write any column.

## Q42. On manual change of…
- **merchant / category / description(=merchant) / notes:** value overwritten in place; nothing recomputed, nothing learned.
- **recurring status:** not a transaction field — managed by creating/deleting a `subscriptions` row.
- **transfer status:** not persistable — transfers are a render-time computation, so there's no way to mark/unmark a transaction as a transfer.

## Q43. Original imported info recoverable? **No.** No raw/audit copy is kept.

---

# DOWNSTREAM EFFECTS (Q44–Q45)

## Q44. What transactions feed
- **Spending totals:** `BudgetSection.spendByCategoryBetween` (no transfer exclusion) and `Accounts.tsx` per-account (transfer-excluded).
- **Budgets:** `budget_lines.category` matched to the same category spend.
- **Subscriptions:** detection + `subscriptions` table.
- **Bills:** only via subscription linkage; not directly.
- **Tax:** **not fed by transactions** (`tax_deductions` is manual/separate).
- **Net worth:** **not fed by transactions** (balances only).
- **Telegram:** generic `query_data`/CRUD tools over the `transactions` table (`telegramService.ts:65`); briefings.
- **Integration summary (PAssistant):** `monthlyExpenses = Σ|amount|` over 30d (`integrationSummary.ts:105`).

## Q45. Places that compute totals differently — **THREE incompatible definitions of "spend":**
1. **Accounts per-account:** negatives, **minus internal transfers**.
2. **Budget section:** negatives by category, **transfers included**.
3. **Integration summary:** `Σ|amount|` of **everything** (income + transfers + repayments included).

No single canonical "net spend" function exists.

---

# AI (Q46–Q49)

## Q46–Q47. AI parsing/classification & when called
- **Import parse only, per document:** Groq `llama-3.3-70b-versatile` primary (`pdfParser.ts:394`), Claude fallback for scanned PDFs/images/over-budget (`claudeService.parseFinancialDocument`). CSV → Claude `parsePortfolioText`.
- **Telegram:** Claude for conversational CRUD (`claudeService.telegramAIResponse`).
- **Per-transaction categorisation is NOT AI** — it's keyword `autoCategory` or Basiq ANZSIC.

## Q48. What AI results are stored
Only the resulting `merchant`/`amount`/`category`/`date` on the saved transaction. **No confidence, no model id, no raw response, no document hash.**

## Q49. Repeated AI calls?
- **Re-uploading the same statement re-runs the full LLM parse every time** — no document hash/cache. The subsequent per-row dedup prevents duplicate *rows*, but the expensive parse already ran.
- **Basiq refresh:** no AI. **Steady-state categorisation:** no AI. So no per-transaction repeat-call waste, but re-imports are wasteful.

---

# SYNTHESIS

## A. Current transaction architecture
Local-first: browser Zustand store (localStorage) is the working engine; `dataService.ts` mutates it and background-syncs to a thin Express/Supabase CRUD backend. Three separate ingestion paths (statement-via-LLM, Basiq, manual) each with their own dedup/categorisation; detection (transfers, recurring, cross-account dups) runs render-time in the browser and is mostly unpersisted.

## B. Current DB model
Single flat `transactions` table (13 columns), polymorphic un-FK'd `account_id` + `account_type`, free-text `category`, one `merchant` doubling as description, `basiq_tx_id` for Basiq dedup, two boolean flags (one dead). No merchant table, no categories FK, no rules table, no splits, no transfer pairing, no source/raw/confidence/tax metadata.

## C. Strong — preserve
- `normaliseMerchant` / `isTransferMerchant` — genuinely good, reusable normalisation (`recurringDetection.ts`).
- Recurring classifier (`classifyFrequency` + `MAX_SPREAD` + `calcNextChargeDate`) — thoughtful, calendar-aware, degrades to `irregular` instead of dropping.
- The temp-id ⇄ server-id reconciliation layer (`resolveAccountId`/`reconcileServerId`) — hard-won, do not disturb.
- `original_name` preservation pattern (subscriptions/bills) — the right instinct; generalise it.
- Basiq `basiq_tx_id` dedup and account/loan routing + self-healing remaps.
- Local-first offline queue + "never wipe on empty server response" guard (`dataService.ts:2226`).

## D. Bugs / architectural risks
1. **Coarse statement dedup** `(type,date,|amt|)` can delete legitimate same-day same-amount transactions (Q29).
2. **Credit-card repayment double-counts** in Budget + integration spend (Q25).
3. **Three different "spend" definitions** (Q45) → numbers disagree across screens.
4. **`integrationSummary` sums |all|** including income/transfers → overstated expenses to PAssistant.
5. **Transfers not excluded from Budget spend.**
6. **Detection state is per-device/session** (transfers recomputed; dismissals in localStorage) → cross-device inconsistency.
7. **`PATCH /transactions` has no field allowlist** — any column writable.
8. **No CSV bank-statement path** — CSV silently treated as portfolio.
9. **Raw description destroyed** by Basiq enrichment / edits — unrecoverable.
10. **Manual entries skip all dedup.**
11. **`is_duplicate_flagged` dead**, `is_subscription` unmaintained → misleading schema.

## E. Duplicate / redundant systems
- `is_subscription` flag vs `subscriptions` table.
- Category taxonomy overlaps itself (Food/Groceries/Dining; Bills/Utilities/Rent).
- Three categorisers (autoCategory / LLM / ANZSIC) producing non-aligned label sets.
- Two dedup strategies (statement tuple vs Basiq id) with no shared rule.

## F. Missing capabilities
Source tagging, raw-description preservation, canonical merchant model, learned/user rules, persistent transfer pairing, split transactions, confidence + review workflow, unified spend function, per-transaction tax/tags/entity metadata, document-hash cache for re-imports, server-side ingestion so all clients agree.

## G. Recommended canonical transaction model
One `transactions` table remains the anchor; add (all nullable, backward-compatible):
`source` (`manual|statement_pdf|statement_csv|basiq|api`), `source_ref` (basiq id / statement id / file hash), `raw_description`, `merchant_id` (FK → merchants), `merchant_normalized`, `is_transfer` + `transfer_pair_id`, `parent_transaction_id` (splits), `review_status` (`unreviewed|auto|confirmed`), `confidence` NUMERIC, `category_source` (`user|rule|ai|basiq|default`), `tags` JSONB, `is_tax_deductible`, `deduction_category`, `entity` (`personal|business`), `content_hash` (dedup key). Keep `merchant` as the display field derived from merchant/raw.

## H. Recommended processing pipeline (single path, ideally server-side)
`raw input → normalise (sign, currency, date) → content_hash → dedup (hash + fuzzy) → merchant resolve (raw→normalized→merchant_id→alias) → categorise (user-rule → merchant default → ai/basiq → fallback) → transfer match (persist pair) → recurring link → split (optional) → confidence + review_status → persist → downstream`. Every source funnels through this; manual entry included.

## I. Recommended merchant model
`merchants(id, user_id NULL=global, canonical_name, normalized_key, default_category, logo?)` + `merchant_aliases(raw_pattern → merchant_id)`. On ingest, `merchant_normalized = normaliseMerchant(raw)`; look up alias → merchant; unknown creates a provisional merchant. User rename writes an alias so future imports self-correct (the missing Q14 capability).

## J. Recommended rules engine
`transaction_rules(user_id, priority, match {field, op, value}[], set {category, is_transfer, tags, entity, tax}, enabled)`. A user category correction offers "always do this for <merchant>" → writes a rule. Rules run in the categorise step before AI. Solves Q18/Q19.

## K. Recommended transfer matching
Persist pairs: on ingest, match debit↔credit by (different account, amount to cent, ≤N-day gap, transfer-like or same |amount| both internal accounts) → write shared `transfer_pair_id`, set `is_transfer=true` on both, and a `category='Transfer'`. Also treat **credit-card repayments** as transfers (bank debit ↔ card) so they stop double-counting. Downstream excludes `is_transfer` uniformly.

## L. Recommended duplicate strategy
Deterministic `content_hash = sha(user_id, account_id, date, amount_cents, normalized_merchant)` as a unique-ish key; plus `source_ref` short-circuit (basiq id / statement-line id). Fuzzy fallback only for cross-source (±1 day, ±2% amount, merchant match) and **flag for review rather than silently drop**. Replaces the lossy `(type,date,|amt|)` rule.

## M. Recommended split design
`parent_transaction_id` self-ref + child rows; parent excluded from category spend when it has children; children `(category, amount, note, tags)` sum-validated to parent. Reporting prefers children.

## N. Recommended recurring architecture
Keep the classifier. Add persistence: `recurring_series(id, merchant_id, amount_hint, frequency, next_date, original_name, status)` and `transaction.recurring_series_id` so occurrences are linked (Q36), dismissals live in DB (cross-device), and rename history is first-class (generalise `original_name`).

## O. Recommended review/confidence system
Per-transaction `confidence` (0–1) from source certainty (Basiq/user=high, AI=medium, keyword-default=low) and `review_status`. Surface a "needs review" queue for low-confidence / fuzzy-dup / ambiguous-transfer rows. Confirming promotes to `confirmed` and can spawn a rule.

## P. Migrations eventually required
1. `ALTER TABLE transactions ADD` the columns in (G) — all nullable, safe.
2. `ADD CONSTRAINT` proper FK indexing for `account_id` is impossible while polymorphic — instead add `content_hash` + partial unique indexes per source.
3. New tables: `merchants`, `merchant_aliases`, `transaction_rules`, `recurring_series` (+ backfill from `subscriptions`), `transaction_splits` (or reuse parent ref).
4. Backfill: derive `source` (`basiq_tx_id != null` → basiq, else statement/manual heuristic), `merchant_normalized`, `content_hash`; migrate `subscriptions` → `recurring_series`.
5. Drop/repurpose dead `is_duplicate_flagged`.

## Q. Staged implementation plan
- **Stage 0 (non-breaking foundation):** add nullable columns + `content_hash`; backfill; **do not change behaviour**. Add a single canonical `netSpend`/`spendByCategory` util and route all three call sites (Accounts, Budget, integrationSummary) through it — fixes Q45/Q25/transfer-exclusion with no schema risk.
- **Stage 1 (source + raw):** stamp `source` and `raw_description` at every ingestion path; stop overwriting raw with enriched merchant. Add document `content_hash` cache to skip re-parsing identical uploads (Q49).
- **Stage 2 (unified ingestion):** extract one `ingestTransaction()` pipeline (H); make manual/statement/Basiq all call it; move dedup to `content_hash` + review-flagging (L). Add the missing CSV bank path.
- **Stage 3 (merchants + rules):** `merchants`/`aliases`/`transaction_rules`; user rename → alias, user recategorise → optional rule (I/J, fixes Q14/Q18/Q19).
- **Stage 4 (transfers persisted):** `transfer_pair_id`, credit-card repayment as transfer, uniform downstream exclusion (K, closes Q25).
- **Stage 5 (recurring persisted):** `recurring_series` linked to transactions, DB-side dismissals (N, closes Q36).
- **Stage 6 (confidence/review):** confidence scoring + review queue (O).
- **Stage 7 (splits + tax metadata):** splits (M) and tax/tags/entity fields wired to reporting.

Throughout: prefer server-side execution of the pipeline so all devices agree, but keep the local-first store as a cache — do not regress the offline queue or the id-reconciliation layer.
