export interface User {
  id: string;
  email: string;
  name: string;
  currency_preference: string;
  theme: 'light' | 'dark';
  plan: 'free' | 'premium';
  basiq_user_id?: string;
  telegram_bot_token?: string;
  onboarding_complete: boolean;
  created_at: string;
  updated_at: string;
}

export interface BankAccount {
  id: string;
  user_id: string;
  name: string;
  institution: string;
  account_type: string;
  balance: number;
  bsb?: string;
  account_number?: string;
  currency: string;
  basiq_account_id?: string;
  is_manual: boolean;
  shared_code?: string;
  shared_password_hash?: string;
  created_at: string;
  updated_at: string;
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
  basiq_account_id?: string;
  is_manual: boolean;
  created_at: string;
  updated_at: string;
}

export interface Transaction {
  id: string;
  user_id: string;
  account_id: string;
  account_type: 'bank' | 'credit_card';
  date: string;
  merchant: string;
  amount: number;
  currency: string;
  category: string;
  notes?: string;
  is_duplicate_flagged: boolean;
  is_subscription: boolean;
  created_at: string;
  updated_at: string;
}

export interface Investment {
  id: string;
  user_id: string;
  name: string;
  ticker?: string;
  market: string;
  asset_type: 'stock' | 'etf' | 'crypto' | 'precious_metal' | 'managed_fund' | 'private' | 'other' | 'bond' | 'art' | 'wine' | 'jewellery';
  shares_owned: number;
  cost_basis: number;
  current_price: number;
  current_value: number;
  currency: string;
  native_currency: string;
  last_price_update?: string;
  is_dividend_paying: boolean;
  /** Flexible metadata for collectible/non-market types (bond, art, wine, jewellery). */
  details?: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export interface InvestmentVerification {
  current_value: number;
  profit_loss: number;
  profit_loss_percent: number;
  is_verified: boolean;
  check1_passed: boolean;
  check2_passed: boolean;
  check3_passed: boolean;
}

export interface SuperFund {
  id: string;
  user_id: string;
  fund_name: string;
  balance: number;
  employer_contributions: number;
  personal_contributions: number;
  investment_option?: string;
  performance_data?: Record<string, unknown>;
  include_in_investments: boolean;
  include_in_net_worth: boolean;
  created_at: string;
  updated_at: string;
}

export interface IncomeEntry {
  id: string;
  user_id: string;
  source: string;
  amount: number;
  currency: string;
  category: string;
  frequency?: string;
  is_recurring: boolean;
  reference_number?: string;
  date: string;
  status: 'approved' | 'pending';
  created_at: string;
  updated_at: string;
}

export interface Bill {
  id: string;
  user_id: string;
  name: string;
  amount: number;
  due_date: string;
  is_recurring: boolean;
  frequency?: string;
  colour: 'grey' | 'yellow' | 'red';
  is_paid: boolean;
  calendar_synced: boolean;
  created_at: string;
  updated_at: string;
}

export interface GoalLinkSource {
  type: 'account' | 'investment' | 'super';
  id: string;
  link_type: 'percent' | 'amount';
  link_value: number;
}

export interface Goal {
  id: string;
  user_id: string;
  name: string;
  target_amount: number;
  current_amount: number;
  target_date: string;
  linked_sources?: GoalLinkSource[] | null;
  linked_account_id?: string | null;
  link_type?: 'percent' | 'amount' | null;
  link_value?: number | null;
  include_in_briefing?: boolean;
  created_at: string;
  updated_at: string;
}

export interface Budget {
  id: string;
  user_id: string;
  category: string;
  limit_amount: number;
  period: 'weekly' | 'monthly' | 'yearly';
  rollover_enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface Notification {
  id: string;
  user_id: string;
  type: string;
  message: string;
  is_read: boolean;
  created_at: string;
}

export interface ExchangeRate {
  id: string;
  from_currency: string;
  to_currency: string;
  rate: number;
  date: string;
  created_at: string;
}

export interface TaxRecord {
  id: string;
  user_id: string;
  financial_year: string;
  total_income: number;
  tax_withheld: number;
  estimated_tax_owing: number;
  medicare_levy: number;
  hecs_repayment: number;
  total_deductions: number;
  franking_credits: number;
  created_at: string;
  updated_at: string;
}

export interface TaxDeduction {
  id: string;
  user_id: string;
  financial_year: string;
  name: string;
  amount: number;
  category: string;
  date: string;
  receipt_url?: string;
  created_at: string;
}

export interface Subscription {
  id: string;
  user_id: string;
  name: string;
  amount: number;
  currency: string;
  frequency: string;
  next_charge_date: string;
  account_id?: string;
  category: string;
  is_auto_detected: boolean;
  created_at: string;
  updated_at: string;
}

export interface Dividend {
  id: string;
  investment_id: string;
  user_id: string;
  amount: number;
  currency: string;
  per_share_amount: number;
  shares_at_time: number;
  franking_credit: number;
  payment_date: string;
  status: 'pending' | 'approved';
  created_at: string;
}

export interface AuthRequest {
  email: string;
  password: string;
}

export interface JWTPayload {
  userId: string;
  email: string;
  plan: string;
}
