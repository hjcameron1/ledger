export interface User {
  id: string;
  email: string;
  name: string;
  currency_preference: string;
  timezone?: string;
  theme: 'light' | 'dark' | 'system';
  plan: 'free' | 'premium';
  onboarding_complete: boolean;
  telegram_bot_token?: string;
  telegram_chat_id?: string;
}

export interface BankAccount {
  id: string;
  user_id: string;
  name: string;
  institution: string;
  account_type: string;
  balance: number;
  currency: string;
  /** Balance converted into the user's preferred (display) currency. */
  display_balance?: number;
  display_currency?: string;
  conversion_rate?: number;
  bsb?: string;
  account_number?: string;
  is_manual: boolean;
  /** Hidden accounts are collapsed to the bottom of the list and excluded from
   *  net worth / the bank-balance total. Persisted server-side (bank_accounts.hidden). */
  hidden?: boolean;
  basiq_account_id?: string;
  /** Provenance of a live-synced account: 'basiq' or 'basiq_sandbox' (Hooli/AU00000). */
  source?: string;
  available_funds?: number | null;
  /** Original local temp UUID before server sync — kept for fallback ID matching */
  localId?: string;
  /** Server (Supabase) UUID after sync — kept for fallback ID matching */
  serverId?: string;
  created_at?: string;
  updated_at?: string;
}

export interface CreditCard {
  id: string;
  user_id: string;
  name: string;
  institution: string;
  balance_owing: number;
  credit_limit: number;
  minimum_payment?: number;
  due_date?: string;
  currency: string;
  /** balance_owing/credit_limit/minimum_payment/last_payment_amount converted into
   *  the user's preferred (display) currency. */
  display_balance_owing?: number;
  display_credit_limit?: number;
  display_minimum_payment?: number;
  display_last_payment_amount?: number;
  display_currency?: string;
  conversion_rate?: number;
  is_manual: boolean;
  basiq_account_id?: string;
  /** Provenance of a live-synced card: 'basiq' or 'basiq_sandbox' (Hooli/AU00000). */
  source?: string;
  last_payment_amount?: number;
  last_payment_date?: string;
  /** Original local temp UUID before server sync — kept for fallback ID matching */
  localId?: string;
  /** Server (Supabase) UUID after sync — kept for fallback ID matching */
  serverId?: string;
  created_at?: string;
  updated_at?: string;
}

export interface PendingPayment {
  id: string;
  user_id: string;
  credit_card_id: string;
  bank_account_id?: string;
  amount: number;
  status: 'pending' | 'reconciled';
  reconciled_transaction_id?: string;
  statement_id?: string;
  created_at: string;
  updated_at?: string;
}

export interface CreditCardStatement {
  id: string;
  user_id: string;
  credit_card_id: string;
  period_label?: string | null;
  period_start?: string | null;
  period_end?: string | null;
  due_date?: string | null;
  closing_balance: number;
  minimum_payment?: number | null;
  amount_paid: number;
  status: 'unpaid' | 'partial' | 'paid';
  paid_at?: string | null;
  source: 'statement' | 'basiq' | 'manual';
  currency?: string | null;
  /** Converted into the user's preferred (display) currency. */
  display_closing_balance?: number;
  display_amount_paid?: number;
  display_currency?: string;
  /** Local temp UUID before server sync — kept for fallback ID matching */
  localId?: string;
  serverId?: string;
  created_at: string;
  updated_at: string;
}

/**
 * A question raised when a bank transaction looks like a credit-card payment but
 * can't be auto-applied: either we don't know which card, or there's no statement
 * to tick off. Surfaced to the user as a modal in the Credit Cards tab.
 */
export interface CcPaymentPrompt {
  id: string;
  kind: 'which-card' | 'whole-amount';
  transaction_id: string;
  merchant: string;
  amount: number;
  /** which-card: the candidate cards to choose from. */
  candidate_card_ids?: string[];
  /** whole-amount: the single matched card. */
  card_id?: string;
  created_at: string;
}

export interface Transaction {
  id: string;
  user_id: string;
  account_id: string;
  account_type: 'bank' | 'credit_card' | 'loan';
  date: string;
  merchant: string;
  amount: number;
  currency: string;
  /** amount converted into the user's preferred (display) currency. */
  display_amount?: number;
  display_currency?: string;
  conversion_rate?: number;
  category: string;
  notes?: string;
  /** @deprecated LEGACY (Phase 2A) — unused, retained for back-compat only. */
  is_duplicate_flagged: boolean;
  is_subscription: boolean;
  basiq_tx_id?: string;
  // ── Phase 2A: Transaction Foundation ──────────────────────────────────────
  /** Origin of the transaction. */
  source?: TransactionSource;
  /** Source system's own identifier (generalises basiq_tx_id). */
  source_ref?: string | null;
  /** Original untouched source description — never overwritten once set. */
  raw_description?: string | null;
  /** normaliseMerchant() key for grouping/matching. */
  merchant_normalized?: string | null;
  /** True when this is one leg of a confidently-detected internal transfer. */
  is_transfer?: boolean;
  /** Shared id linking the two legs of an internal transfer. */
  transfer_pair_id?: string | null;
  review_status?: 'clear' | 'needs_review' | 'reviewed';
  confidence?: number | null;
  category_source?: 'auto' | 'basiq' | 'user' | 'rule' | 'ai' | null;
  /** Deterministic content hash for duplicate identity. */
  content_hash?: string | null;
  /**
   * Financial-event class. Phase 2A stamps only reliably-detected internal
   * transfers ('transfer'); refund/fee/interest classification is Phase 2B. A
   * positive amount is NOT automatically income — never infer type from sign.
   */
  transaction_type?: TransactionType | null;
  tags?: string[] | null;
  is_tax_deductible?: boolean;
  deduction_category?: string | null;
  entity?: string | null;
  // ── Manual ↔ bank-sync reconciliation (linked accounts only) ──────────────
  /**
   * Lifecycle of a manually-added transaction on a LIVE-SYNCED account:
   *  - 'pending'  awaiting reconciliation against the next bank sync (contributes to balance)
   *  - 'kept'     bank never showed it; user keeps it — intended divergence (contributes to balance)
   *  - 'conflict' a near-match to a synced txn was found (see reconcile_match_id); bank twin
   *               already counts it (does NOT contribute to balance)
   *  - 'resolved' conflict decided "keep mine" — bank twin removed, its figure already in the
   *               bank balance (does NOT contribute)
   * NULL for bank/statement rows and manual rows on unlinked accounts.
   */
  reconcile_state?: 'pending' | 'kept' | 'conflict' | 'resolved' | null;
  /** The synced (Basiq) transaction this manual entry may duplicate, when state='conflict'. */
  reconcile_match_id?: string | null;
  /** Last time the user deferred a "not in this sync" prompt ("check again next sync"). */
  reconcile_checked_at?: string | null;
  created_at?: string;
  updated_at?: string;
}

export type TransactionSource = 'basiq' | 'statement' | 'manual' | 'unknown';

/** Financial-event class. See Transaction.transaction_type. */
export type TransactionType =
  | 'purchase' | 'refund' | 'income' | 'transfer' | 'fee' | 'interest' | 'other';

export interface Subscription {
  id: string;
  user_id?: string;
  name: string;
  /** Raw merchant name from the source transaction — preserved even when the user renames */
  original_name: string | null;
  amount: number;
  currency: string;
  /** amount converted into the user's preferred (display) currency. */
  display_amount?: number;
  display_currency?: string;
  conversion_rate?: number;
  frequency: string;
  next_charge_date: string;
  account_id?: string;
  category: string;
  is_auto_detected: boolean;
  created_at?: string;
  updated_at?: string;
}

export interface Investment {
  id: string;
  user_id?: string;
  name: string;
  ticker?: string;
  market: string;
  asset_type: 'stock' | 'etf' | 'crypto' | 'precious_metal' | 'managed_fund' | 'private' | 'other' | 'bond' | 'art' | 'wine' | 'jewellery' | 'cash';
  shares_owned: number;
  cost_basis: number;
  /** Currency the cost_basis is stored in (user's per-holding choice). When unset,
   *  treated as native_currency (legacy behaviour). */
  cost_basis_currency?: string;
  current_price: number;
  current_value: number;
  currency: string;
  native_currency: string;
  last_price_update?: string;
  is_dividend_paying: boolean;
  /** Precious-metal weight unit (grams | ounces | kg). */
  metal_unit?: string;
  /** 'generic' (spot-tracked) or a specific product form (minted_bar, coin, …). */
  metal_form?: string;
  /** Mint / brand for an in-depth metal product (e.g. "Perth Mint"). */
  metal_mint?: string;
  /** True when the holding is a specific physical product priced manually. */
  metal_detailed?: boolean;
  /** Per-unit buy price for an in-depth metal product (informational). */
  metal_buy_price?: number | null;
  /** Per-unit sell price for an in-depth metal product (drives valuation). */
  metal_sell_price?: number | null;
  /** Flexible metadata for collectible/non-market types (bond, art, wine, jewellery).
   *  Collectibles reuse shares_owned×current_price for valuation; extra fields live here. */
  details?: Record<string, unknown> | null;
  /** Price % change since the previous market close (today's move), from Yahoo.
   *  Null for assets with no live daily quote (metals priced off dealer buyback,
   *  collectibles, manual holdings). */
  day_change_percent?: number | null;
  verification?: {
    is_verified: boolean;
    profit_loss: number;
    profit_loss_percent: number;
    /** Today's change in preferred currency (value now − value at prev close). */
    day_change?: number | null;
    /** Today's % move (mirror of day_change_percent, carried for convenience). */
    day_change_percent?: number | null;
    current_value?: number;
  };
  display_value?: number;
  /** Cost basis converted into the preferred (display) currency. */
  display_cost?: number;
  display_currency?: string;
  conversion_rate?: number;
  created_at?: string;
  updated_at?: string;
}

/** A realised disposal (partial or full sale) of a holding. Drives the FY CGT summary. */
export interface InvestmentSale {
  id: string;
  user_id?: string;
  investment_id?: string | null;
  name: string;
  ticker?: string | null;
  asset_type?: string | null;
  market?: string | null;
  quantity: number;
  proceeds: number;
  fees: number;
  cost_basis: number;
  acquired_date?: string | null;
  sale_date: string;
  gain: number;
  held_days?: number | null;
  discount_eligible: boolean;
  currency: string;
  created_at?: string;
}

export interface SuperFund {
  id: string;
  user_id?: string;
  fund_name: string;
  member_number?: string;
  balance: number;
  employer_contributions: number;
  personal_contributions: number;
  investment_option?: string;
  insurance_details?: string;
  fees?: number;
  include_in_investments: boolean;
  include_in_net_worth: boolean;
  last_updated?: string;
  created_at?: string;
  updated_at?: string;
}

export interface IncomeEntry {
  id: string;
  user_id?: string;
  source: string;
  amount: number;
  currency: string;
  /** amount/tax_withheld/super_contribution converted into the user's preferred
   *  (display) currency. */
  display_amount?: number;
  display_tax_withheld?: number;
  display_super_contribution?: number;
  display_currency?: string;
  conversion_rate?: number;
  category: string;
  frequency?: string;
  is_recurring: boolean;
  reference_number?: string;
  date: string;
  status: 'approved' | 'pending';
  tax_withheld?: number;
  super_contribution?: number;
  created_at?: string;
  updated_at?: string;
}

export interface Bill {
  id: string;
  user_id?: string;
  name: string;
  amount: number;
  due_date: string;
  is_recurring: boolean;
  frequency?: string;
  colour: 'grey' | 'yellow' | 'red';
  is_paid: boolean;
  /** When true, the bill auto-advances to its next occurrence on the due date and
   *  never goes overdue — shown with an ⚡ "Auto-pay" badge. */
  auto_pay?: boolean;
  paid_at?: string;          // ISO date set when the bill is ticked off; cleared on restore
  /** Stable link to the subscription this bill was created from (via the
   *  "Also in bills & reminders" toggle). Identity-based so renames, re-adds,
   *  and duplicate names never break the link. Null for manually-added bills. */
  subscription_id?: string | null;
  /** Stable link to the loan this repayment bill was mirrored from (via the loan's
   *  "Add repayment to bills & reminders" toggle). Null for non-loan bills. */
  loan_id?: string | null;
  /** The bill's first/import name, captured the first time it is renamed. Used to
   *  recognise a re-imported original-named bill as a duplicate of one the user
   *  already renamed. Null until the bill has been renamed at least once. */
  original_name?: string | null;
  /** Distinguishes a payable bill (amount + tick-to-pay) from a reminder (a date
   *  nudge where the amount is optional). Defaults to 'bill' for older rows. */
  kind?: 'bill' | 'reminder';
  /** Spending category (Bills, Credit Card, Transfers, Entertainment, Fitness, …).
   *  Prefilled from a linked bank subscription's category when one exists. */
  category?: string | null;
  /** How many days before the due date this item starts appearing on the overview.
   *  Null → use the user's base lead-time setting. Lets e.g. a credit card surface
   *  2 days out while everything else uses the 1-week default. */
  lead_days?: number | null;
  /** For recurring items only. When a user edits a single occurrence ("just this
   *  once"), the canonical series values are snapshotted here so the NEXT generated
   *  occurrence reverts to them instead of inheriting the one-off change. Null when
   *  the visible row IS the canonical template (the normal case). */
  recurring_template?: {
    name?: string; amount?: number; category?: string | null;
    frequency?: string; colour?: 'grey' | 'yellow' | 'red';
    kind?: 'bill' | 'reminder'; auto_pay?: boolean;
  } | null;
  /** Per-bill Telegram reminders. Each fires as a standalone Telegram message at
   *  (due_date − offset_days) at `time` in the user's timezone. Recurring bills
   *  carry these forward (with last_sent reset) so they repeat each occurrence. */
  reminders?: BillReminder[];
  calendar_synced: boolean;
  created_at?: string;
  updated_at?: string;
}

/** One scheduled Telegram reminder attached to a bill/reminder. Stored relative to
 *  the due date so it shifts automatically with each recurring occurrence. */
export interface BillReminder {
  id: string;
  /** Whole days before due_date (0 = on the day, negative = after). */
  offset_days: number;
  /** "HH:MM" 24h, in the user's local timezone. */
  time: string;
  /** The due_date (YYYY-MM-DD) this entry last fired for; de-dup guard. */
  last_sent: string | null;
}

/** Loan / debt types tracked under the Accounts page. */
export type LoanType = 'mortgage' | 'personal' | 'car' | 'hecs';

export interface Loan {
  id: string;
  user_id?: string;
  name: string;
  loan_type: LoanType;
  lender?: string | null;
  /** Amount originally borrowed — used as the denominator for the repaid progress bar. */
  original_amount: number;
  current_balance: number;
  /** Annual interest rate (%). Not used for HECS, which indexes instead. */
  interest_rate?: number | null;
  minimum_repayment?: number | null;
  repayment_frequency: 'weekly' | 'fortnightly' | 'monthly';
  next_due_date?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  notes?: string | null;
  include_in_net_worth?: boolean;
  add_to_bills?: boolean;
  /** Set when this loan was imported from a Basiq open-banking connection, so a
   *  re-sync updates this row instead of creating a duplicate. Null for manual loans. */
  basiq_account_id?: string | null;
  /** 'basiq_sandbox' for the Hooli test institution (AU00000), else 'basiq'/undefined. */
  source?: string;
  created_at?: string;
  updated_at?: string;
}

/** Categories a recurring bill/reminder can be tagged with. */
export const BILL_CATEGORIES = [
  'Bills', 'Credit Card', 'Transfers', 'Entertainment', 'Fitness',
  'Subscriptions', 'Insurance', 'Utilities', 'Rent', 'Health',
  'Transport', 'Groceries', 'Other',
] as const;

/** One asset (bank account or investment holding) feeding money into a goal,
 *  with how much of its balance/value is allocated (a % or a fixed $). */
export interface GoalLinkSource {
  type: 'account' | 'investment' | 'super';
  id: string;
  link_type: 'percent' | 'amount';
  link_value: number;
}

export interface Goal {
  id: string;
  user_id?: string;
  name: string;
  target_amount: number;
  current_amount: number;
  target_date?: string;
  /** Multiple accounts/investments can hold money toward a goal. When present and
   *  non-empty, this supersedes the legacy single-account fields below. */
  linked_sources?: GoalLinkSource[] | null;
  /** @deprecated legacy single-account link — read for back-compat, new saves use linked_sources. */
  linked_account_id?: string | null;
  /** @deprecated How a linked account's balance is allocated to this goal. */
  link_type?: 'percent' | 'amount' | null;
  /** @deprecated The % (0–100) or fixed $ amount, per link_type. */
  link_value?: number | null;
  /** When false, this goal is omitted from the daily briefing/Telegram message.
   *  Defaults to true (included) for goals saved before this option existed. */
  include_in_briefing?: boolean;
  created_at?: string;
  updated_at?: string;
}

export interface Budget {
  id: string;
  user_id?: string;
  category: string;
  limit_amount: number;
  period: 'weekly' | 'monthly' | 'yearly';
  rollover_enabled: boolean;
  created_at?: string;
  updated_at?: string;
}

export type BudgetPeriod = 'weekly' | 'fortnightly' | 'monthly';
export type BudgetIncomeBasis = 'projected' | 'manual' | 'average';

/** Plan-level budget config — one per user. */
export interface BudgetSettings {
  id: string;
  user_id?: string;
  period: BudgetPeriod;
  income_basis: BudgetIncomeBasis;
  /** Per-period income (manual figure, or a cached snapshot of the derived one). */
  income_amount: number;
  created_at?: string;
  updated_at?: string;
}

export type BudgetLineType = 'expense' | 'bill' | 'recurring' | 'pay' | 'income' | 'saving';
export type BudgetLineSource = 'manual' | 'bill' | 'recurring' | 'bank';

/** A single budgeted item within the plan. */
export interface BudgetLine {
  id: string;
  user_id?: string;
  type: BudgetLineType;
  name: string;
  /** Transaction category this line tracks actual spend against (null = untracked). */
  category?: string | null;
  /** Budgeted amount per the plan's period. */
  amount: number;
  source: BudgetLineSource;
  /** Origin id when imported from a bill / subscription / transaction. */
  source_ref_id?: string | null;
  /** True = this row is a category with a spending cap; false = an item under a category. */
  is_category_budget?: boolean;
  created_at?: string;
  updated_at?: string;
}

/** A user-created spending category that merges into the built-in list. */
export interface CustomCategory {
  id: string;
  user_id?: string;
  name: string;
  created_at?: string;
  updated_at?: string;
}

export interface Notification {
  id: string;
  user_id?: string;
  type: string;
  message: string;
  is_read: boolean;
  created_at: string;
  /** Optional in-app route to navigate to when the notification is clicked. */
  link?: string;
  /** Optional secondary line, e.g. a list of affected items for a sync failure. */
  detail?: string;
}

export interface NetWorthSnapshot {
  net_worth: number;
  bank_balance: number;
  investments: number;
  credit_card_debt: number;
  super: number;
  currency: string;
}

export interface TaxRecord {
  financial_year: string;
  total_income: number;
  tax_withheld: number;
  estimated_tax_owing: number;
  medicare_levy: number;
  hecs_repayment: number;
  total_deductions: number;
  franking_credits: number;
}

export interface TaxDeduction {
  id: string;
  name: string;
  amount: number;
  category: string;
  date: string;
  receipt_url?: string;
}

export type Theme = 'light' | 'dark' | 'system';
export type Currency = string;

export const INCOME_CATEGORIES = [
  'Salary', 'Wage', 'Freelance/Contractor', 'Rental', 'Dividends',
  'Government Payments', 'Interest', 'Bonus', 'Superannuation Pension',
  'Trust Distribution', 'Other',
] as const;

export const TRANSACTION_CATEGORIES: Record<string, string[]> = {
  Groceries: ['Woolworths', 'Coles', 'Aldi', 'IGA', 'Costco', 'Harris Farm'],
  Dining: ["McDonald's", 'KFC', 'Uber Eats', 'DoorDash', 'Menulog', 'Deliveroo', 'Hungry Jacks'],
  Entertainment: ['Netflix', 'Stan', 'Disney+', 'Binge', 'Kayo', 'Spotify', 'Apple Music', 'YouTube Premium', 'Foxtel'],
  Fuel: ['Shell', 'BP', 'Ampol', 'Caltex', '7-Eleven', 'United Petroleum'],
  Health: ['Chemist Warehouse', 'Priceline', 'Terry White', 'Blooms The Chemist', 'Bulk Billing'],
  Electronics: ['JB Hi-Fi', 'Apple Store', 'Harvey Norman', 'Officeworks', 'Microsoft'],
  Travel: ['Qantas', 'Virgin Australia', 'Jetstar', 'Tigerair', 'Airbnb', 'Booking.com', 'Expedia'],
  Transport: ['Uber', 'DiDi', 'Ola', 'GoCatch', 'Opal', 'Myki', 'Go Card'],
  Fitness: ['Fitness First', 'F45', 'Anytime Fitness', 'Gym', 'Goodlife', 'YMCA'],
  Insurance: ['NRMA', 'RACV', 'Allianz', 'Budget Direct', 'AAMI', 'NIB', 'Medibank'],
  Utilities: ['AGL', 'Origin Energy', 'Energy Australia', 'Sydney Water', 'Telstra', 'Optus', 'Vodafone'],
};
