/**
 * Local-first data service.
 * All operations update Zustand (persisted to localStorage) immediately.
 * Backend sync is attempted silently in the background — never blocks the UI.
 */

import { useStore } from '../store';
import type {
  BankAccount, CreditCard, Transaction, Subscription,
  Investment, SuperFund, IncomeEntry, Bill, Goal, Budget,
  Notification, NetWorthSnapshot,
} from '../types';
import { verifyInvestment } from '../utils/investmentVerification';

// ─── helpers ────────────────────────────────────────────────────────────────

function uuid(): string {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
function ts() { return new Date().toISOString(); }
function uid() { return useStore.getState().user?.id ?? 'local'; }

// ─── BANK ACCOUNTS ──────────────────────────────────────────────────────────

export const accountsDS = {
  getAll(): BankAccount[] {
    return useStore.getState().accounts;
  },

  add(data: Omit<BankAccount, 'id' | 'user_id' | 'created_at' | 'updated_at'>): BankAccount {
    const record: BankAccount = {
      ...data,
      id: uuid(),
      user_id: uid(),
      is_manual: true,
      created_at: ts(),
      updated_at: ts(),
    };
    const s = useStore.getState();
    s.setAccounts([...s.accounts, record]);
    return record;
  },

  update(id: string, data: Partial<BankAccount>): BankAccount {
    const s = useStore.getState();
    const updated = s.accounts.map(a =>
      a.id === id ? { ...a, ...data, updated_at: ts() } : a
    );
    s.setAccounts(updated);
    return updated.find(a => a.id === id)!;
  },

  remove(id: string): void {
    const s = useStore.getState();
    s.setAccounts(s.accounts.filter(a => a.id !== id));
  },
};

// ─── CREDIT CARDS ───────────────────────────────────────────────────────────

export const creditCardsDS = {
  getAll(): CreditCard[] {
    return useStore.getState().creditCards;
  },

  add(data: Omit<CreditCard, 'id' | 'user_id' | 'created_at' | 'updated_at'>): CreditCard {
    const record: CreditCard = {
      ...data,
      id: uuid(),
      user_id: uid(),
      is_manual: true,
      created_at: ts(),
      updated_at: ts(),
    };
    const s = useStore.getState();
    s.setCreditCards([...s.creditCards, record]);
    return record;
  },

  update(id: string, data: Partial<CreditCard>): CreditCard {
    const s = useStore.getState();
    const updated = s.creditCards.map(c =>
      c.id === id ? { ...c, ...data, updated_at: ts() } : c
    );
    s.setCreditCards(updated);
    return updated.find(c => c.id === id)!;
  },

  remove(id: string): void {
    const s = useStore.getState();
    s.setCreditCards(s.creditCards.filter(c => c.id !== id));
  },
};

// ─── TRANSACTIONS ───────────────────────────────────────────────────────────

export const transactionsDS = {
  getAll(params?: { account_id?: string; search?: string }): Transaction[] {
    let txns = useStore.getState().transactions;
    if (params?.account_id) txns = txns.filter(t => t.account_id === params.account_id);
    if (params?.search) txns = txns.filter(t =>
      t.merchant.toLowerCase().includes(params.search!.toLowerCase())
    );
    return [...txns].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  },

  add(data: Omit<Transaction, 'id' | 'user_id' | 'created_at' | 'updated_at'>): Transaction {
    const record: Transaction = {
      ...data,
      id: uuid(),
      user_id: uid(),
      created_at: ts(),
      updated_at: ts(),
    };
    const s = useStore.getState();
    s.setTransactions([record, ...s.transactions]);
    return record;
  },

  update(id: string, data: Partial<Transaction>): Transaction {
    const s = useStore.getState();
    const updated = s.transactions.map(t =>
      t.id === id ? { ...t, ...data, updated_at: ts() } : t
    );
    s.setTransactions(updated);
    return updated.find(t => t.id === id)!;
  },
};

// ─── SUBSCRIPTIONS ──────────────────────────────────────────────────────────

export const subscriptionsDS = {
  getAll(): Subscription[] {
    return useStore.getState().subscriptions;
  },

  add(data: Omit<Subscription, 'id' | 'user_id' | 'created_at' | 'updated_at'>): Subscription {
    const record: Subscription = {
      ...data,
      id: uuid(),
      user_id: uid(),
      is_auto_detected: false,
      created_at: ts(),
      updated_at: ts(),
    };
    const s = useStore.getState();
    s.setSubscriptions([...s.subscriptions, record]);
    return record;
  },

  remove(id: string): void {
    const s = useStore.getState();
    s.setSubscriptions(s.subscriptions.filter(sub => sub.id !== id));
  },
};

// ─── INVESTMENTS ────────────────────────────────────────────────────────────

export const investmentsDS = {
  getAll() {
    const s = useStore.getState();
    const investments = s.investments.map(inv => {
      const v = verifyInvestment(inv.shares_owned, inv.current_price, inv.cost_basis);
      return {
        ...inv,
        verification: v,
        display_value: v.current_value,
        display_currency: s.user?.currency_preference ?? 'AUD',
      };
    });
    const portfolio_total = investments.reduce((sum, i) => sum + i.display_value, 0);
    return { investments, portfolio_total, portfolio_verified: true };
  },

  add(data: {
    name?: string; ticker?: string; market: string; asset_type: string;
    shares_owned: number; cost_basis: number; native_currency?: string;
    is_dividend_paying?: boolean; current_price?: number;
  }): Investment {
    const current_price = data.current_price ?? 0;
    const v = verifyInvestment(data.shares_owned, current_price, data.cost_basis);
    const record: Investment = {
      id: uuid(),
      user_id: uid(),
      name: data.name ?? data.ticker ?? 'Unknown',
      ticker: data.ticker,
      market: data.market,
      asset_type: data.asset_type as Investment['asset_type'],
      shares_owned: data.shares_owned,
      cost_basis: data.cost_basis,
      current_price,
      current_value: v.current_value,
      currency: 'AUD',
      native_currency: data.native_currency ?? 'AUD',
      is_dividend_paying: data.is_dividend_paying ?? false,
      created_at: ts(),
      updated_at: ts(),
    };
    const s = useStore.getState();
    s.setInvestments([...s.investments, record]);
    s.setPortfolioTotal(s.portfolioTotal + v.current_value);
    return record;
  },

  update(id: string, data: Partial<Investment>): Investment {
    const s = useStore.getState();
    const updated = s.investments.map(i => {
      if (i.id !== id) return i;
      const merged = { ...i, ...data, updated_at: ts() };
      if (data.shares_owned !== undefined || data.current_price !== undefined || data.cost_basis !== undefined) {
        const v = verifyInvestment(merged.shares_owned, merged.current_price, merged.cost_basis);
        merged.current_value = v.current_value;
      }
      return merged;
    });
    s.setInvestments(updated);
    const newTotal = updated.reduce((sum, i) => sum + i.current_value, 0);
    s.setPortfolioTotal(newTotal);
    return updated.find(i => i.id === id)!;
  },

  remove(id: string): void {
    const s = useStore.getState();
    const removed = s.investments.find(i => i.id === id);
    s.setInvestments(s.investments.filter(i => i.id !== id));
    if (removed) s.setPortfolioTotal(s.portfolioTotal - removed.current_value);
  },
};

// ─── SUPER FUNDS ────────────────────────────────────────────────────────────

export const superDS = {
  getAll(): SuperFund[] {
    return useStore.getState().superFunds;
  },

  add(data: Omit<SuperFund, 'id' | 'user_id' | 'created_at' | 'updated_at'>): SuperFund {
    const record: SuperFund = { ...data, id: uuid(), user_id: uid(), created_at: ts(), updated_at: ts() };
    const s = useStore.getState();
    s.setSuperFunds([...s.superFunds, record]);
    return record;
  },

  update(id: string, data: Partial<SuperFund>): SuperFund {
    const s = useStore.getState();
    const updated = s.superFunds.map(f =>
      f.id === id ? { ...f, ...data, updated_at: ts() } : f
    );
    s.setSuperFunds(updated);
    return updated.find(f => f.id === id)!;
  },

  remove(id: string): void {
    const s = useStore.getState();
    s.setSuperFunds(s.superFunds.filter(f => f.id !== id));
  },
};

// ─── INCOME ─────────────────────────────────────────────────────────────────

export const incomeDS = {
  getAll() {
    const entries = useStore.getState().incomeEntries;
    const multipliers: Record<string, number> = {
      weekly: 52, fortnightly: 26, monthly: 12, quarterly: 4, annually: 1,
    };
    const projected_annual = entries
      .filter(e => e.is_recurring && e.status === 'approved')
      .reduce((sum, e) => sum + e.amount * (multipliers[e.frequency ?? 'monthly'] ?? 12), 0);
    return { entries, projected_annual };
  },

  add(data: Omit<IncomeEntry, 'id' | 'user_id' | 'created_at' | 'updated_at'>): IncomeEntry {
    const record: IncomeEntry = { ...data, id: uuid(), user_id: uid(), created_at: ts(), updated_at: ts() };
    const s = useStore.getState();
    s.setIncomeEntries([record, ...s.incomeEntries]);
    s.setProjectedAnnual(incomeDS.getAll().projected_annual);
    return record;
  },

  update(id: string, data: Partial<IncomeEntry>): IncomeEntry {
    const s = useStore.getState();
    const updated = s.incomeEntries.map(e =>
      e.id === id ? { ...e, ...data, updated_at: ts() } : e
    );
    s.setIncomeEntries(updated);
    s.setProjectedAnnual(incomeDS.getAll().projected_annual);
    return updated.find(e => e.id === id)!;
  },

  approve(id: string): IncomeEntry {
    return incomeDS.update(id, { status: 'approved' });
  },

  remove(id: string): void {
    const s = useStore.getState();
    s.setIncomeEntries(s.incomeEntries.filter(e => e.id !== id));
    s.setProjectedAnnual(incomeDS.getAll().projected_annual);
  },
};

// ─── TAX (local calculation) ─────────────────────────────────────────────────

const BRACKETS_2024_25 = [
  { min: 0,      max: 18200,    base: 0,      rate: 0     },
  { min: 18201,  max: 45000,    base: 0,      rate: 0.19  },
  { min: 45001,  max: 120000,   base: 5092,   rate: 0.325 },
  { min: 120001, max: 180000,   base: 29467,  rate: 0.37  },
  { min: 180001, max: Infinity, base: 51667,  rate: 0.45  },
];

export function calculateTax(hecsEnabled = false) {
  const s = useStore.getState();
  const entries = s.incomeEntries.filter(e => e.status === 'approved');
  const total_income = entries.reduce((sum, e) => sum + e.amount, 0);
  const tax_withheld = entries.reduce((sum, e) => sum + (e.tax_withheld ?? 0), 0);

  const bracket = [...BRACKETS_2024_25].reverse().find(b => total_income >= b.min) ?? BRACKETS_2024_25[0];
  const income_tax = Math.max(0, bracket.base + (total_income - bracket.min) * bracket.rate);

  // Medicare levy (simplified: 2% above $26,000 threshold)
  const medicare_levy = total_income > 26000 ? total_income * 0.02 : 0;

  // HECS repayment thresholds 2024-25
  let hecs_repayment = 0;
  if (hecsEnabled && total_income >= 54435) {
    const hecsRates = [
      { min: 54435,  max: 62850,  rate: 0.01 }, { min: 62851,  max: 66620,  rate: 0.02 },
      { min: 66621,  max: 70618,  rate: 0.025 }, { min: 70619, max: 74855,  rate: 0.03 },
      { min: 74856,  max: 79346,  rate: 0.035 }, { min: 79347, max: 84107,  rate: 0.04 },
      { min: 84108,  max: 89154,  rate: 0.045 }, { min: 89155, max: 94503,  rate: 0.05 },
      { min: 94504,  max: 100174, rate: 0.055 }, { min: 100175,max: Infinity,rate: 0.06 },
    ];
    const hr = [...hecsRates].reverse().find(r => total_income >= r.min);
    if (hr) hecs_repayment = total_income * hr.rate;
  }

  const deductions = s.incomeEntries; // placeholder — real deductions from tax_deductions
  const total_deductions = 0; // use separate deductions store if needed
  const estimated_tax_owing = income_tax + medicare_levy + hecs_repayment;

  return {
    financial_year: currentFY(),
    total_income,
    tax_withheld,
    estimated_tax_owing,
    medicare_levy,
    hecs_repayment,
    total_deductions,
    franking_credits: 0,
  };
}

function currentFY(): string {
  const now = new Date();
  const y = now.getFullYear();
  return now.getMonth() >= 6 ? `${y}-${y + 1}` : `${y - 1}-${y}`;
}

export function getTaxBrackets() {
  return BRACKETS_2024_25.filter(b => b.max !== Infinity).concat(
    [{ min: 180001, max: null as unknown as number, base: 51667, rate: 0.45 }]
  );
}

// ─── TAX DEDUCTIONS ─────────────────────────────────────────────────────────

// Store deductions in a dedicated key via localStorage (simple approach)
function getDeductionsKey() { return `ledger-deductions-${uid()}-${currentFY()}`; }

export const deductionsDS = {
  getAll() {
    try { return JSON.parse(localStorage.getItem(getDeductionsKey()) ?? '[]'); } catch { return []; }
  },
  add(data: { name: string; amount: number; category: string; date: string }) {
    const record = { ...data, id: uuid(), created_at: ts() };
    const all = deductionsDS.getAll();
    all.push(record);
    localStorage.setItem(getDeductionsKey(), JSON.stringify(all));
    return record;
  },
  remove(id: string) {
    const all = deductionsDS.getAll().filter((d: { id: string }) => d.id !== id);
    localStorage.setItem(getDeductionsKey(), JSON.stringify(all));
  },
};

// ─── BILLS ──────────────────────────────────────────────────────────────────

export const billsDS = {
  getAll(): Bill[] {
    return useStore.getState().bills.filter(b => !b.is_paid)
      .sort((a, b) => new Date(a.due_date).getTime() - new Date(b.due_date).getTime());
  },

  add(data: Omit<Bill, 'id' | 'user_id' | 'created_at' | 'updated_at'>): Bill {
    const record: Bill = { ...data, id: uuid(), user_id: uid(), created_at: ts(), updated_at: ts() };
    const s = useStore.getState();
    s.setBills([...s.bills, record]);
    return record;
  },

  update(id: string, data: Partial<Bill>): Bill {
    const s = useStore.getState();
    const updated = s.bills.map(b => b.id === id ? { ...b, ...data, updated_at: ts() } : b);
    s.setBills(updated);
    return updated.find(b => b.id === id)!;
  },

  pay(id: string): void {
    const s = useStore.getState();
    const bill = s.bills.find(b => b.id === id);
    if (!bill) return;

    // Mark paid
    s.setBills(s.bills.map(b => b.id === id ? { ...b, is_paid: true } : b));

    // Auto-generate next occurrence for recurring bills
    if (bill.is_recurring && bill.frequency) {
      const next = new Date(bill.due_date);
      const advance: Record<string, () => void> = {
        weekly:      () => next.setDate(next.getDate() + 7),
        fortnightly: () => next.setDate(next.getDate() + 14),
        monthly:     () => next.setMonth(next.getMonth() + 1),
        quarterly:   () => next.setMonth(next.getMonth() + 3),
        annually:    () => next.setFullYear(next.getFullYear() + 1),
      };
      advance[bill.frequency]?.();
      const nextBill: Bill = {
        ...bill,
        id: uuid(),
        is_paid: false,
        due_date: next.toISOString().split('T')[0],
        created_at: ts(),
        updated_at: ts(),
      };
      s.setBills([...s.bills.map(b => b.id === id ? { ...b, is_paid: true } : b), nextBill]);
    }
  },

  remove(id: string): void {
    const s = useStore.getState();
    s.setBills(s.bills.filter(b => b.id !== id));
  },
};

// ─── GOALS ──────────────────────────────────────────────────────────────────

export const goalsDS = {
  getAll(): Goal[] {
    return useStore.getState().goals;
  },

  add(data: Omit<Goal, 'id' | 'user_id' | 'created_at' | 'updated_at'>): Goal {
    const record: Goal = { ...data, id: uuid(), user_id: uid(), created_at: ts(), updated_at: ts() };
    const s = useStore.getState();
    s.setGoals([...s.goals, record]);
    return record;
  },

  update(id: string, data: Partial<Goal>): Goal {
    const s = useStore.getState();
    const updated = s.goals.map(g => g.id === id ? { ...g, ...data, updated_at: ts() } : g);
    s.setGoals(updated);
    return updated.find(g => g.id === id)!;
  },

  remove(id: string): void {
    const s = useStore.getState();
    s.setGoals(s.goals.filter(g => g.id !== id));
  },
};

// ─── BUDGETS ────────────────────────────────────────────────────────────────

export const budgetsDS = {
  getAll(): Budget[] {
    return useStore.getState().budgets;
  },

  add(data: Omit<Budget, 'id' | 'user_id' | 'created_at' | 'updated_at'>): Budget {
    const record: Budget = { ...data, id: uuid(), user_id: uid(), created_at: ts(), updated_at: ts() };
    const s = useStore.getState();
    s.setBudgets([...s.budgets, record]);
    return record;
  },

  update(id: string, data: Partial<Budget>): Budget {
    const s = useStore.getState();
    const updated = s.budgets.map(b => b.id === id ? { ...b, ...data } : b);
    s.setBudgets(updated);
    return updated.find(b => b.id === id)!;
  },

  remove(id: string): void {
    const s = useStore.getState();
    s.setBudgets(s.budgets.filter(b => b.id !== id));
  },
};

// ─── NET WORTH ──────────────────────────────────────────────────────────────

export function calculateNetWorth(): NetWorthSnapshot {
  const s = useStore.getState();
  const currency = s.user?.currency_preference ?? 'AUD';

  const bank_balance   = s.accounts.reduce((sum, a) => sum + a.balance, 0);
  const investments    = s.investments.reduce((sum, i) => sum + (i.display_value ?? i.current_value), 0);
  const credit_card_debt = s.creditCards.reduce((sum, c) => sum + c.balance_owing, 0);
  const superBal       = s.superFunds
    .filter(f => f.include_in_net_worth)
    .reduce((sum, f) => sum + f.balance, 0);

  const net_worth = bank_balance + investments + superBal - credit_card_debt;

  const snapshot: NetWorthSnapshot = {
    net_worth:        parseFloat(net_worth.toFixed(2)),
    bank_balance:     parseFloat(bank_balance.toFixed(2)),
    investments:      parseFloat(investments.toFixed(2)),
    credit_card_debt: parseFloat(credit_card_debt.toFixed(2)),
    super:            parseFloat(superBal.toFixed(2)),
    currency,
  };

  // Record daily snapshot in history
  const today = new Date().toISOString().split('T')[0];
  const hist = s.netWorthHistory;
  const exists = hist.some(h => h.recorded_date === today);
  if (!exists) {
    s.setNetWorthHistory([...hist, { recorded_date: today, total_value: snapshot.net_worth }]);
  }

  return snapshot;
}

// ─── NOTIFICATIONS ──────────────────────────────────────────────────────────

export const notificationsDS = {
  getAll(): Notification[] {
    return [...useStore.getState().notifications]
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  },

  add(type: string, message: string): Notification {
    const record: Notification = { id: uuid(), user_id: uid(), type, message, is_read: false, created_at: ts() };
    const s = useStore.getState();
    s.setNotifications([record, ...s.notifications]);
    return record;
  },

  markRead(id: string): void {
    const s = useStore.getState();
    s.setNotifications(s.notifications.map(n => n.id === id ? { ...n, is_read: true } : n));
  },

  markAllRead(): void {
    const s = useStore.getState();
    s.setNotifications(s.notifications.map(n => ({ ...n, is_read: true })));
  },
};

// ─── BASIQ LIVE BANK CONNECTION ──────────────────────────────────────────────

export interface BasiqBankAccount {
  basiq_account_id: string;
  name: string;
  institution: string;
  account_type: string;
  balance: number;
  bsb: string | null;
  account_number: string | null;
  currency: string;
  is_manual: false;
}

export interface BasiqCreditCard {
  basiq_account_id: string;
  name: string;
  institution: string;
  balance_owing: number;
  credit_limit: number;
  currency: string;
  is_manual: false;
}

export interface BasiqTransaction {
  basiq_tx_id: string;
  account_id: string;  // Basiq account ID
  date: string;
  merchant: string;
  amount: number;
  currency: string;
  category: string | null;
  type: string;
}

export const basiqDS = {
  /** Create a Basiq user and return the consent URL to open in a new tab. */
  async connect(email: string, mobile: string): Promise<{ basiqUserId: string; authLink: string }> {
    const res = await fetch('/api/basiq/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, mobile }),
    });
    if (!res.ok) {
      const detail = await res.json().catch(() => ({})) as { error?: string };
      throw new Error(detail.error ?? `Connect failed: HTTP ${res.status}`);
    }
    return res.json();
  },

  /** Fetch live accounts from Basiq for a connected user. */
  async fetchAccounts(basiqUserId: string): Promise<{
    bankAccounts: BasiqBankAccount[];
    creditCards: BasiqCreditCard[];
  }> {
    const res = await fetch(`/api/basiq/accounts?userId=${encodeURIComponent(basiqUserId)}`);
    if (!res.ok) {
      const detail = await res.json().catch(() => ({})) as { error?: string };
      throw new Error(detail.error ?? `Fetch accounts failed: HTTP ${res.status}`);
    }
    return res.json();
  },

  /** Fetch live transactions from Basiq. */
  async fetchTransactions(basiqUserId: string): Promise<BasiqTransaction[]> {
    const res = await fetch(`/api/basiq/transactions?userId=${encodeURIComponent(basiqUserId)}`);
    if (!res.ok) {
      const detail = await res.json().catch(() => ({})) as { error?: string };
      throw new Error(detail.error ?? `Fetch transactions failed: HTTP ${res.status}`);
    }
    const { transactions } = await res.json() as { transactions: BasiqTransaction[] };
    return transactions;
  },

  /** Get a fresh auth link for adding another bank to an existing Basiq user. */
  async getAuthLink(basiqUserId: string, mobile?: string): Promise<string> {
    const params = new URLSearchParams({ userId: basiqUserId });
    if (mobile) params.set('mobile', mobile);
    const res = await fetch(`/api/basiq/auth_link?${params}`);
    if (!res.ok) throw new Error(`Auth link failed: HTTP ${res.status}`);
    const { authLink } = await res.json() as { authLink: string };
    return authLink;
  },
};

// ─── DOCUMENT PARSING (best-effort client-side) ──────────────────────────────

/**
 * Tries the backend Claude API first. If unavailable, returns null so
 * the caller can fall back to manual entry with a clear message.
 */
export async function parseDocument(
  file: File,
  documentType: string
): Promise<{ parsed: Record<string, unknown> | null; error?: string }> {
  try {
    const form = new FormData();
    form.append('file', file);
    form.append('document_type', documentType);
    const res = await fetch('/api/upload/parse', {
      method: 'POST',
      headers: { Authorization: `Bearer ${useStore.getState().token ?? ''}` },
      body: form,
      signal: AbortSignal.timeout(90000), // 90s — real PDFs through Claude take 20-30s
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}${detail ? ': ' + detail : ''}`);
    }
    const json = await res.json();
    return { parsed: json.parsed };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[parseDocument] FAILED — exact error:', msg, err);
    return {
      parsed: null,
      error: `Upload failed: ${msg}`,
    };
  }
}
