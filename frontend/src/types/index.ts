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
  /**
   * Phase 2B: the resolved canonical merchant this transaction belongs to (see
   * Merchant). Nullable — set when merchant resolution finds a match. `merchant`
   * remains the display string; raw_description remains the untouched source.
   */
  merchant_id?: string | null;
  /** True when this is one leg of a confidently-detected internal transfer. */
  is_transfer?: boolean;
  /** Shared id linking the two legs of an internal transfer. */
  transfer_pair_id?: string | null;
  review_status?: 'clear' | 'needs_review' | 'reviewed';
  /** Phase 2C: WHY a transaction is in the review queue. Null when clear. */
  review_reason?: ReviewReason | null;
  confidence?: number | null;
  // ── Phase 2C: recurring series / refunds ──────────────────────────────────
  /** The recurring_series this transaction is an occurrence of (advisory TEXT id,
   *  like merchant_id — may hold a temp local id before sync). Null when not recurring. */
  recurring_series_id?: string | null;
  /** When transaction_type==='refund' and confidently matched, the id of the
   *  original PURCHASE this refund reverses (advisory TEXT id). Drives net-of-refund
   *  spend. Null for an unmatched/partial-only inflow. */
  refund_of?: string | null;
  category_source?: 'auto' | 'basiq' | 'user' | 'rule' | 'merchant' | 'ai' | null;
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
  /** Phase 2D.1 — free-text note explaining the tax treatment of this line. */
  tax_note?: string | null;
  /** Phase 2D.1 — reference to the receipt / evidence backing a deduction claim
   *  (a URL, a file id, or a plain note describing where the evidence lives). */
  receipt_ref?: string | null;
  // ── Phase 2D.3: AI-suggestion fallback ────────────────────────────────────
  // Filled ONLY when the deterministic classifier failed and Claude was asked as
  // a fallback. These are SUGGESTIONS surfaced in Needs Review — they never
  // override an explicit user rule (the AI path only runs on rows the engine left
  // 'auto'/Uncategorised). `ai_classified_at` is the guard that stops us re-asking.
  /** Category Claude proposed (normalised to the user's taxonomy; never invented). */
  ai_suggested_category?: string | null;
  /** Cleaned display merchant Claude proposed. */
  ai_suggested_merchant?: string | null;
  /** Transaction type Claude proposed. */
  ai_suggested_transaction_type?: TransactionType | null;
  /** Short human note from Claude — why it's unsure / what to check. */
  ai_suggested_reason?: string | null;
  /** Claude's own 0..1 confidence in the suggestion. */
  ai_confidence?: number | null;
  /** When Claude last answered for this row. Set once; its presence prevents a
   *  repeat AI call (persists cross-device, so a reload never re-asks). */
  ai_classified_at?: string | null;
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

// ─── Phase 2C: recurring series, review queue, refunds, splits ────────────────

/** Why a transaction landed in the Needs Review queue. */
export type ReviewReason =
  | 'ambiguous_duplicate'   // content collides across sources — could be a re-import
  | 'uncertain_merchant'    // merchant/category resolved with low confidence
  | 'possible_transfer'     // looks like an internal movement but couldn't be paired
  | 'possible_refund';      // an inflow that might reverse an earlier purchase

/** The kind of commitment a recurring series represents. */
export type RecurringKind =
  | 'subscription'
  | 'bill'
  | 'income'
  | 'loan_repayment'
  | 'investment_contribution'
  | 'other';

/**
 * A user's persisted "these are Different bills" decision — a rejected bill↔
 * subscription reconciliation match. `decision_key` is the STABLE anchor-name pair
 * (see billReconciliation.differentDecisionKey), so the decision survives
 * recurring-occurrence id churn and renames, and syncs across every device.
 */
export interface BillSubscriptionExclusion {
  id: string;
  user_id?: string;
  decision_key: string;
  created_at?: string;
}

/** Lifecycle of a persisted recurring series. */
export type RecurringStatus = 'active' | 'dismissed' | 'ended';

/**
 * A PERSISTED recurring relationship. Phase 2A/2B detected recurrence only at
 * render-time; Phase 2C stores a confirmed series so its occurrences can be
 * linked (Transaction.recurring_series_id) and a DISMISSED suggestion stays
 * dismissed across devices (status='dismissed').
 *
 * `merchant_normalized` + `frequency` is the identity key detection matches
 * against — both to link new occurrences and to suppress a suggestion the user
 * already confirmed or dismissed.
 */
export interface RecurringSeries {
  id: string;
  user_id?: string;
  /** Advisory link to a canonical Merchant (uuid or synthetic seed id). */
  merchant_id?: string | null;
  /** normaliseMerchant() grouping key — the series identity, with frequency. */
  merchant_normalized: string;
  /** Display name (user-editable; defaults to the detected merchant). */
  name: string;
  /** First/detected name, preserved even when the user renames. */
  original_name?: string | null;
  kind: RecurringKind;
  frequency: 'weekly' | 'fortnightly' | 'monthly' | 'quarterly' | 'annually' | 'irregular';
  /** Typical charge amount (native/display magnitude of the cluster). */
  expected_amount?: number | null;
  last_transaction_date?: string | null;
  next_expected_date?: string | null;
  /** Primary account the series charges, when known. */
  account_id?: string | null;
  status: RecurringStatus;
  created_at?: string;
  updated_at?: string;
}

/**
 * One category line of a split transaction. The parent bank transaction stays
 * intact; these lines replace its single category in reporting/budgets. Amounts
 * are POSITIVE magnitudes that must sum to ABS(parent amount).
 */
export interface TransactionSplit {
  id: string;
  user_id?: string;
  transaction_id: string;
  category: string;
  amount: number;
  notes?: string | null;
  tags?: string[] | null;
  created_at?: string;
  updated_at?: string;
}

// ─── Phase 2B: Merchant recognition + rules ──────────────────────────────────

/**
 * A canonical merchant. `merchant_normalized` is the normaliseMerchant() key used
 * for direct matching; `display_name` is what the user sees. `user_id` NULL means
 * a GLOBAL merchant (shared default); a set user_id means a user-owned merchant,
 * which always takes precedence over a global one for that user.
 */
export interface Merchant {
  id: string;
  user_id?: string | null;
  display_name: string;
  merchant_normalized: string;
  /** Default category applied when this merchant is resolved and nothing higher-priority set one. */
  default_category?: string | null;
  logo_url?: string | null;
  created_at?: string;
  updated_at?: string;
}

/**
 * Maps a raw/normalised bank description to a canonical Merchant. Lets
 * "WOOLWORTHS 1234", "WOOLWORTHS ONLINE" and "W/WORTHS ROBINA" all resolve to the
 * same Woolworths merchant. `user_id` NULL = global mapping; a set user_id = a
 * user-specific alias that OVERRIDES any global alias for that user.
 */
export interface MerchantAlias {
  id: string;
  user_id?: string | null;
  merchant_id: string;
  /** The key to match against. Interpreted per `match_type`. Stored uppercased for 'contains'. */
  pattern: string;
  /**
   *  - 'normalized' → pattern must equal normaliseMerchant(raw) exactly (precise; used for learned aliases).
   *  - 'contains'   → uppercased raw description must contain pattern (fuzzy; used for seeds).
   */
  match_type: 'normalized' | 'contains';
  created_at?: string;
  updated_at?: string;
}

/** Direction of money movement for a rule condition. */
export type RuleDirection = 'debit' | 'credit';

/** All conditions are ANDed. An absent field is not tested. */
export interface RuleCondition {
  /** Exact normaliseMerchant() match against the transaction. */
  merchant_normalized?: string;
  /** Uppercased raw description / merchant contains this substring. */
  merchant_contains?: string;
  /** Uppercased raw description contains this substring. */
  description_contains?: string;
  /** Restrict the rule to a single account (kept account-specific). */
  account_id?: string;
  /** Inclusive bounds on the ABSOLUTE amount. */
  amount_min?: number;
  amount_max?: number;
  /** 'debit' = outflow (amount < 0); 'credit' = inflow (amount > 0). */
  direction?: RuleDirection;
  /** Restrict to a transaction source. */
  source?: TransactionSource;
}

/** Fields a matching rule stamps onto the transaction. All optional. */
export interface RuleAction {
  category?: string;
  merchant?: string;
  tags?: string[];
  /** business/personal is stored on the transaction's `entity` field. */
  entity?: 'business' | 'personal';
  is_tax_deductible?: boolean;
  transaction_type?: TransactionType;
}

/**
 * A user-owned transaction rule. NEVER applies to another user. Higher `priority`
 * wins; among equal priorities the newest rule wins. `enabled=false` is inert.
 */
export interface TransactionRule {
  id: string;
  user_id?: string;
  priority: number;
  enabled: boolean;
  conditions: RuleCondition;
  actions: RuleAction;
  /** Optional human label for the rules list. */
  label?: string | null;
  created_at?: string;
  updated_at?: string;
}

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
  /** Phase 3.4 — the bank account or credit card this bill is paid from / charged
   *  to. When set, marking the bill paid records a matching transaction on that
   *  account and moves its balance immediately; a later Basiq/statement import of
   *  the same payment reconciles against that manual transaction (see reconcile.ts)
   *  instead of duplicating it. Null / undefined = unassigned (pay() just ticks it
   *  off, no transaction — the pre-3.4 behaviour). */
  account_id?: string | null;
  /** Which owner `account_id` refers to. */
  account_type?: 'bank' | 'credit_card' | null;
  /** The manual transaction created when this bill was marked paid via an assigned
   *  account. Lets an un-pay reverse the exact transaction + balance move. Set to
   *  null once that transaction has been reconciled away by a real bank/statement
   *  import (the real row then represents the payment). */
  paid_transaction_id?: string | null;
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

/** How often a loan is repaid. Drives every per-period figure in the engine. */
export type RepaymentFrequency = 'weekly' | 'fortnightly' | 'monthly';

/** Whether the rate can move. A fixed loan carries the date it expires and the
 *  rate it reverts to, which is what makes its projection honest. */
export type LoanRateType = 'variable' | 'fixed';

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
  repayment_frequency: RepaymentFrequency;
  next_due_date?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  notes?: string | null;
  include_in_net_worth?: boolean;
  add_to_bills?: boolean;

  // ── Phase 4.2 — what the mortgage/debt engine needs ──────────────────────
  // All optional: a loan entered before this phase projects fine on its rate,
  // repayment and balance alone, and every field below simply makes the
  // projection more accurate.

  /** 'fixed' means the rate holds until `fixed_until`, then becomes `revert_rate`. */
  rate_type?: LoanRateType | null;
  fixed_until?: string | null;
  /** The rate that applies once a fixed period ends. */
  revert_rate?: number | null;
  /** Interest-only until this date: nothing comes off the principal before it. */
  interest_only_until?: string | null;
  /** The contracted term in months, used with start_date when there's no end_date. */
  term_months?: number | null;
  /**
   * Cash offsetting the balance. It reduces the INTEREST CHARGED and is never
   * subtracted from the debt — that money is already counted as an asset in the
   * user's bank account, so netting it here too would count it twice.
   */
  offset_balance?: number | null;
  /** A bank account whose live balance is the offset. Overrides offset_balance. */
  offset_account_id?: string | null;
  /** Paid on top of every scheduled repayment. */
  extra_repayment?: number | null;
  /**
   * Extra repayments the user could pull back out. Re-borrowing capacity, not
   * cash: it is not an asset until it is redrawn, so it never reaches net worth.
   */
  redraw_available?: number | null;
  /** Set when this loan was imported from a Basiq open-banking connection, so a
   *  re-sync updates this row instead of creating a duplicate. Null for manual loans. */
  basiq_account_id?: string | null;
  /** 'basiq_sandbox' for the Hooli test institution (AU00000), else 'basiq'/undefined. */
  source?: string;
  created_at?: string;
  updated_at?: string;
}

/**
 * A movement recorded against a loan (Phase 4.2).
 *
 *   repayment       — a scheduled payment, including a PARTIAL one.
 *   extra_repayment — paid on top; reduces the balance and builds redraw.
 *   redraw          — money taken back out; re-borrowing, so the balance rises.
 *   rate_change     — the rate changed (or is scheduled to). `amount` is 0.
 *
 * The loan's own `current_balance` stays the authoritative debt — banks report
 * it and Basiq syncs it — so these rows are the audit trail of what moved it,
 * not a second ledger the balance is derived from.
 */
export type LoanEventKind = 'repayment' | 'extra_repayment' | 'redraw' | 'rate_change';

export interface LoanEvent {
  id: string;
  user_id?: string;
  loan_id: string;
  kind: LoanEventKind;
  /** Money moved. Always positive; the kind says which way. 0 for a rate change. */
  amount: number;
  /** The new annual rate, for rate_change only. */
  rate?: number | null;
  /** YYYY-MM-DD. A rate_change may be dated in the future. */
  date: string;
  note?: string | null;
  created_at?: string;
  updated_at?: string;
}

/** What kind of place a property is. Presentation only — every type is valued,
 *  owned and mortgaged the same way. */
export type PropertyType = 'home' | 'investment' | 'holiday' | 'land' | 'commercial' | 'other';

/** Who holds the property: the user, the user and someone else, or their SMSF. */
export type PropertyHeldBy = 'personal' | 'joint' | 'smsf';

/**
 * A property (Phase 4.1) — an ASSET, never a debt.
 *
 * The mortgage is not stored here: `loan_id` points at an existing row in
 * `loans`, which keeps its own balance, repayments and net-worth toggle. Net
 * worth therefore adds the owned share of `current_value` from this record and
 * subtracts the mortgage exactly once through the loan itself. Equity (owned
 * value − linked balance) is always derived — see utils/property.ts.
 *
 * An SMSF-held property follows the same count-it-once rule on the asset side:
 * when the holding fund's balance already includes the property's value
 * (`counted_in_fund_balance`), the property adds nothing of its own to net worth
 * because the fund is already carrying it.
 */
export interface Property {
  id: string;
  user_id?: string;
  /** Optional nickname. Blank ⇒ the property is labelled by its address. */
  name?: string | null;
  /** Legacy single-line address; only read as a fallback for older rows. */
  address?: string | null;
  /** Unit / lot number — optional; everything else in the address is required. */
  address_unit?: string | null;
  address_street?: string | null;
  address_suburb?: string | null;
  address_state?: string | null;
  address_postcode?: string | null;
  address_country?: string | null;
  property_type: PropertyType;
  held_by?: PropertyHeldBy;
  /** The SMSF holding this property (smsf_funds.id). Only when held_by='smsf'. */
  smsf_fund_id?: string | null;
  /** A super fund tracked as a balance, holding this property (super_funds.id). */
  super_fund_id?: string | null;
  /** TRUE ⇒ the linked fund's balance already includes this value, so the
   *  property contributes nothing of its own to net worth. */
  counted_in_fund_balance?: boolean;
  /** What it cost — the baseline the value gain is measured against. */
  purchase_price: number;
  purchase_date?: string | null;
  current_value: number;
  /** Share the user owns, 0–100. Only this share of the value reaches net worth. */
  ownership_percent: number;
  /** Optional link to the EXISTING loan funding this property. Never creates debt. */
  loan_id?: string | null;
  include_in_net_worth?: boolean;
  notes?: string | null;

  // ── Phase 4.3 — how the property finds its own money ──────────────────────
  // Rent and expenses are ORDINARY TRANSACTIONS the user already has. There is
  // no property ledger: these two fields only say which of those transactions
  // belong to this property, and every performance figure is derived from them.

  /**
   * Text that identifies this property's transactions — an agent's name, a
   * council, a strata manager. Matched case-insensitively against the merchant,
   * the raw description and the notes. Empty ⇒ the property claims nothing on
   * text alone, which is deliberate: guessing would invent income.
   */
  match_terms?: string[] | null;
  /**
   * Accounts wholly dedicated to this property. Every transaction on one of them
   * is this property's, whatever it says — the usual setup for an investment
   * property with its own account.
   */
  match_account_ids?: string[] | null;

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

/**
 * Phase 4.3 — one movement of money toward (or out of) a goal. Signed:
 * positive is paid in, negative is withdrawn.
 *
 * `source_type` + `source_id` record WHERE the money moved, and exist to stop
 * double-counting: a deposit into an account the goal already links to is
 * visible in that account's balance, so the engine
 * (utils/savingsGoals.ts → isReflected) records the row for history but does
 * not add it again. A null source is cash Ledger cannot see, so it always
 * counts.
 */
export interface GoalContribution {
  id: string;
  user_id?: string;
  goal_id: string;
  /** SIGNED display-currency amount: + paid in, − withdrawn. */
  amount: number;
  /** `YYYY-MM-DD`. */
  date: string;
  source_type?: 'account' | 'investment' | 'super' | null;
  source_id?: string | null;
  note?: string | null;
  created_at?: string;
  updated_at?: string;
}

/** A budget caps one category's spending, or all spending at once. */
export type BudgetScope = 'category' | 'overall';

/**
 * Phase 4.1 — a monthly spending cap. `scope: 'category'` caps one category
 * (built-in or user-created, matched case-insensitively); `scope: 'overall'`
 * caps every category together and carries no category of its own. The engine
 * that turns these into spent / remaining / projected figures is
 * utils/budgeting.ts.
 */
export interface Budget {
  id: string;
  user_id?: string;
  /** Defaults to 'category' for rows saved before scopes existed. */
  scope?: BudgetScope;
  /** Null only for the overall budget. */
  category: string | null;
  limit_amount: number;
  period: 'weekly' | 'monthly' | 'yearly';
  rollover_enabled: boolean;
  /** First month this cap applies to (`YYYY-MM`); null = always. */
  start_month?: string | null;
  /** False retires a budget without deleting its history. Defaults true. */
  active?: boolean;
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

/**
 * Phase 4.4 — the user's response to a proactive alert.
 *
 * Alerts are never stored; they are re-derived from the budget/goal/forecast
 * engines every time (see utils/alerts.ts). This is the one part that has to
 * persist and follow the user across devices. The `*_stage` fields hold how bad
 * the situation was when they acted, so an alert dismissed while it was merely
 * nearing a limit comes back once it is actually over it.
 */
export interface AlertState {
  id: string;
  user_id?: string;
  /** The alert's stable identity, minted by the engine. */
  alert_key: string;
  /** Stage the user dismissed at; null/absent = never dismissed. */
  dismissed_stage?: number | null;
  dismissed_at?: string | null;
  /** Stage the user has read up to; null/absent = never read. */
  read_stage?: number | null;
  read_at?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface NetWorthSnapshot {
  net_worth: number;
  bank_balance: number;
  investments: number;
  credit_card_debt: number;
  super: number;
  /** Owned share of every property's value. Linked mortgages are NOT netted off
   *  here — they are loans, already subtracted once as debt. */
  property: number;
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
