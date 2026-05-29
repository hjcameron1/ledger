/**
 * Local-first data service.
 * All operations update Zustand (persisted to localStorage) immediately.
 * Backend sync is attempted silently in the background — never blocks the UI.
 * Call bootstrapData() after login to load fresh server data into the store.
 */

import { useStore } from '../store';
import type {
  BankAccount, CreditCard, Transaction, Subscription,
  Investment, SuperFund, IncomeEntry, Bill, Goal, Budget,
  Notification, NetWorthSnapshot, PendingPayment,
} from '../types';
import { verifyInvestment } from '../utils/investmentVerification';
import { accountsApi, investmentsApi, incomeApi, overviewApi } from './api';

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

    // Background sync — replace local record with server record (so ID matches DB)
    accountsApi.createAccount({
      name: data.name, institution: data.institution, account_type: data.account_type,
      balance: data.balance, bsb: data.bsb, account_number: data.account_number,
      currency: data.currency,
    }).then((serverRecord: unknown) => {
      const srv = serverRecord as BankAccount;
      const s2 = useStore.getState();
      s2.setAccounts(s2.accounts.map(a => a.id === record.id ? srv : a));
      // Remap any transactions that were linked to the temp local ID
      const remapped = s2.transactions.map(t =>
        t.account_id === record.id ? { ...t, account_id: srv.id } : t
      );
      s2.setTransactions(remapped);
    }).catch((err: unknown) => console.warn('[accountsDS.add] API sync failed:', err));

    return record;
  },

  update(id: string, data: Partial<BankAccount>): BankAccount {
    const s = useStore.getState();
    const updated = s.accounts.map(a =>
      a.id === id ? { ...a, ...data, updated_at: ts() } : a
    );
    s.setAccounts(updated);
    accountsApi.updateAccount(id, data)
      .catch((err: unknown) => console.warn('[accountsDS.update] API sync failed:', err));
    return updated.find(a => a.id === id)!;
  },

  remove(id: string): void {
    const s = useStore.getState();
    console.log('removing transactions for account', id, s.transactions.filter(t => t.account_id === id).length, 'found');
    s.setAccounts(s.accounts.filter(a => a.id !== id));
    s.setTransactions(s.transactions.filter(t => t.account_id !== id));
    accountsApi.deleteAccount(id)
      .catch((err: unknown) => console.warn('[accountsDS.remove] API sync failed:', err));
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

    accountsApi.createCreditCard({
      name: data.name, institution: data.institution, balance_owing: data.balance_owing,
      credit_limit: data.credit_limit, minimum_payment: data.minimum_payment,
      due_date: data.due_date, currency: data.currency,
    }).then((serverRecord: unknown) => {
      const srv = serverRecord as CreditCard;
      const s2 = useStore.getState();
      s2.setCreditCards(s2.creditCards.map(c => c.id === record.id ? srv : c));
      // Remap any transactions that were linked to the temp local ID
      s2.setTransactions(s2.transactions.map(t =>
        t.account_id === record.id ? { ...t, account_id: srv.id } : t
      ));
    }).catch((err: unknown) => console.warn('[creditCardsDS.add] API sync failed:', err));

    return record;
  },

  update(id: string, data: Partial<CreditCard>): CreditCard {
    const s = useStore.getState();
    const updated = s.creditCards.map(c =>
      c.id === id ? { ...c, ...data, updated_at: ts() } : c
    );
    s.setCreditCards(updated);
    // No dedicated updateCreditCard endpoint yet — local-only for now
    return updated.find(c => c.id === id)!;
  },

  remove(id: string): void {
    const s = useStore.getState();
    console.log('removing transactions for account', id, s.transactions.filter(t => t.account_id === id).length, 'found');
    s.setCreditCards(s.creditCards.filter(c => c.id !== id));
    s.setTransactions(s.transactions.filter(t => t.account_id !== id));
    accountsApi.deleteCreditCard(id)
      .catch((err: unknown) => console.warn('[creditCardsDS.remove] API sync failed:', err));
  },
};

// ─── PENDING PAYMENTS ────────────────────────────────────────────────────────

const CC_PAYMENT_PATTERNS = [
  'AMEX', 'AMERICAN EXPRESS', 'VISA PAYMENT', 'MASTERCARD', 'MASTERCARD PAYMENT',
  'CREDIT CARD PAYMENT', 'CREDIT CARD', 'ANZ CREDIT', 'CBA CREDIT', 'NAB CREDIT',
  'WESTPAC CREDIT', 'ING CREDIT', 'COMMBANK CREDIT', 'BANKWEST CREDIT',
];

function matchesCreditCardPayment(merchant: string, cards: CreditCard[]): CreditCard[] {
  const m = merchant.toUpperCase();
  const genericMatch = CC_PAYMENT_PATTERNS.some(p => m.includes(p));
  return cards.filter(card => {
    if (genericMatch) return true;
    return m.includes(card.institution.toUpperCase());
  });
}

export const pendingPaymentsDS = {
  getAll(): PendingPayment[] {
    return useStore.getState().pendingPayments;
  },

  getForCard(creditCardId: string): PendingPayment[] {
    return useStore.getState().pendingPayments.filter(p => p.credit_card_id === creditCardId);
  },

  add(data: { credit_card_id: string; bank_account_id?: string; amount: number }): PendingPayment {
    const record: PendingPayment = {
      ...data,
      id: uuid(),
      user_id: uid(),
      status: 'pending',
      created_at: ts(),
      updated_at: ts(),
    };
    const s = useStore.getState();
    s.setPendingPayments([record, ...s.pendingPayments]);

    accountsApi.createPayment(data.credit_card_id, {
      bank_account_id: data.bank_account_id,
      amount: data.amount,
    }).then((srv: unknown) => {
      const payment = srv as PendingPayment;
      const s2 = useStore.getState();
      s2.setPendingPayments(s2.pendingPayments.map(p => p.id === record.id ? payment : p));
    }).catch((err: unknown) => console.warn('[pendingPaymentsDS.add] sync failed:', err));

    return record;
  },

  reconcile(paymentId: string, transactionId: string): void {
    const s = useStore.getState();
    const payment = s.pendingPayments.find(p => p.id === paymentId);
    if (!payment) return;

    const updated = s.pendingPayments.map(p =>
      p.id === paymentId
        ? { ...p, status: 'reconciled' as const, reconciled_transaction_id: transactionId, updated_at: ts() }
        : p
    );
    s.setPendingPayments(updated);

    // Deduct from card balance_owing, record last payment
    const card = s.creditCards.find(c => c.id === payment.credit_card_id);
    if (card) {
      const newBalance = Math.max(0, card.balance_owing - payment.amount);
      creditCardsDS.update(payment.credit_card_id, {
        balance_owing: newBalance,
        last_payment_amount: payment.amount,
        last_payment_date: new Date().toISOString().split('T')[0],
      });
    }

    accountsApi.updatePayment(payment.credit_card_id, paymentId, {
      status: 'reconciled',
      reconciled_transaction_id: transactionId,
    }).catch((err: unknown) => console.warn('[pendingPaymentsDS.reconcile] sync failed:', err));
  },
};

// Check an incoming bank transaction against pending payments and auto-reconcile.
function tryReconcileTransaction(tx: Transaction): void {
  const s = useStore.getState();
  if (tx.account_type !== 'bank') return;
  const txAmount = Math.abs(tx.amount);

  const matchedCards = matchesCreditCardPayment(tx.merchant, s.creditCards);
  if (matchedCards.length === 0) return;

  for (const card of matchedCards) {
    const pending = s.pendingPayments
      .filter(p => p.credit_card_id === card.id && p.status === 'pending')
      .filter(p => Math.abs(p.amount - txAmount) / Math.max(p.amount, 0.01) <= 0.05)
      .sort((a, b) => Math.abs(a.amount - txAmount) - Math.abs(b.amount - txAmount));

    if (pending.length > 0) {
      pendingPaymentsDS.reconcile(pending[0].id, tx.id);
    } else if (matchedCards.length === 1) {
      // Auto-create a reconciled payment record and reduce balance_owing
      const record: PendingPayment = {
        id: uuid(),
        user_id: uid(),
        credit_card_id: card.id,
        amount: txAmount,
        status: 'reconciled',
        reconciled_transaction_id: tx.id,
        created_at: ts(),
        updated_at: ts(),
      };
      const s2 = useStore.getState();
      s2.setPendingPayments([record, ...s2.pendingPayments]);

      const newBalance = Math.max(0, card.balance_owing - txAmount);
      creditCardsDS.update(card.id, {
        balance_owing: newBalance,
        last_payment_amount: txAmount,
        last_payment_date: new Date().toISOString().split('T')[0],
      });

      accountsApi.createPayment(card.id, {
        amount: txAmount,
        status: 'reconciled',
        reconciled_transaction_id: tx.id,
      }).catch((err: unknown) => console.warn('[tryReconcileTransaction] sync failed:', err));
    }
  }
}

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

    // Auto-reconcile credit card payments from bank transactions
    if (data.account_type === 'bank') tryReconcileTransaction(record);

    accountsApi.createTransaction(data)
      .then((serverRecord: unknown) => {
        const srv = serverRecord as Transaction;
        const s2 = useStore.getState();
        s2.setTransactions(s2.transactions.map(t => {
          if (t.id !== record.id) return t;
          // Preserve the current account_id from the store — it may have been
          // remapped from a temp UUID to the real Supabase UUID by accountsDS.add()
          // or creditCardsDS.add() after this request was already in-flight.
          return { ...srv, account_id: t.account_id };
        }));
      }).catch((err: unknown) => console.warn('[transactionsDS.add] API sync failed:', err));

    return record;
  },

  update(id: string, data: Partial<Transaction>): Transaction {
    const s = useStore.getState();
    const updated = s.transactions.map(t =>
      t.id === id ? { ...t, ...data, updated_at: ts() } : t
    );
    s.setTransactions(updated);
    accountsApi.updateTransaction(id, data)
      .catch((err: unknown) => console.warn('[transactionsDS.update] API sync failed:', err));
    return updated.find(t => t.id === id)!;
  },

  remove(id: string): void {
    const s = useStore.getState();
    s.setTransactions(s.transactions.filter(t => t.id !== id));
    accountsApi.deleteTransaction(id)
      .catch((err: unknown) => console.warn('[transactionsDS.remove] API sync failed:', err));
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

    accountsApi.createSubscription(data)
      .then((serverRecord: unknown) => {
        const srv = serverRecord as Subscription;
        const s2 = useStore.getState();
        s2.setSubscriptions(s2.subscriptions.map(sub => sub.id === record.id ? srv : sub));
      }).catch((err: unknown) => console.warn('[subscriptionsDS.add] API sync failed:', err));

    return record;
  },

  remove(id: string): void {
    const s = useStore.getState();
    s.setSubscriptions(s.subscriptions.filter(sub => sub.id !== id));
    accountsApi.deleteSubscription(id)
      .catch((err: unknown) => console.warn('[subscriptionsDS.remove] API sync failed:', err));
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

    // Background sync — backend fetches live price so replace with server record
    investmentsApi.createInvestment(data)
      .then((resp: unknown) => {
        const { investment: srv } = resp as { investment: Investment };
        const s2 = useStore.getState();
        const newInvestments = s2.investments.map(i => i.id === record.id ? srv : i);
        s2.setInvestments(newInvestments);
        s2.setPortfolioTotal(newInvestments.reduce((sum, i) => sum + i.current_value, 0));
      }).catch((err: unknown) => console.warn('[investmentsDS.add] API sync failed:', err));

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

    investmentsApi.updateInvestment(id, data)
      .catch((err: unknown) => console.warn('[investmentsDS.update] API sync failed:', err));

    return updated.find(i => i.id === id)!;
  },

  remove(id: string): void {
    const s = useStore.getState();
    const removed = s.investments.find(i => i.id === id);
    s.setInvestments(s.investments.filter(i => i.id !== id));
    if (removed) s.setPortfolioTotal(s.portfolioTotal - removed.current_value);
    investmentsApi.deleteInvestment(id)
      .catch((err: unknown) => console.warn('[investmentsDS.remove] API sync failed:', err));
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

    investmentsApi.createSuper(data)
      .then((serverRecord: unknown) => {
        const srv = serverRecord as SuperFund;
        const s2 = useStore.getState();
        s2.setSuperFunds(s2.superFunds.map(f => f.id === record.id ? srv : f));
      }).catch((err: unknown) => console.warn('[superDS.add] API sync failed:', err));

    return record;
  },

  update(id: string, data: Partial<SuperFund>): SuperFund {
    const s = useStore.getState();
    const updated = s.superFunds.map(f =>
      f.id === id ? { ...f, ...data, updated_at: ts() } : f
    );
    s.setSuperFunds(updated);

    investmentsApi.updateSuper(id, data)
      .catch((err: unknown) => console.warn('[superDS.update] API sync failed:', err));

    return updated.find(f => f.id === id)!;
  },

  remove(id: string): void {
    const s = useStore.getState();
    s.setSuperFunds(s.superFunds.filter(f => f.id !== id));
    // No delete endpoint yet — local-only removal
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

    incomeApi.createIncome(data)
      .then((serverRecord: unknown) => {
        const srv = serverRecord as IncomeEntry;
        const s2 = useStore.getState();
        s2.setIncomeEntries(s2.incomeEntries.map(e => e.id === record.id ? srv : e));
        s2.setProjectedAnnual(incomeDS.getAll().projected_annual);
      }).catch((err: unknown) => console.warn('[incomeDS.add] API sync failed:', err));

    return record;
  },

  update(id: string, data: Partial<IncomeEntry>): IncomeEntry {
    const s = useStore.getState();
    const updated = s.incomeEntries.map(e =>
      e.id === id ? { ...e, ...data, updated_at: ts() } : e
    );
    s.setIncomeEntries(updated);
    s.setProjectedAnnual(incomeDS.getAll().projected_annual);

    incomeApi.updateIncome(id, data)
      .catch((err: unknown) => console.warn('[incomeDS.update] API sync failed:', err));

    return updated.find(e => e.id === id)!;
  },

  approve(id: string): IncomeEntry {
    const updated = incomeDS.update(id, { status: 'approved' });
    // Also hit the dedicated approve endpoint
    incomeApi.approveIncome(id)
      .catch((err: unknown) => console.warn('[incomeDS.approve] API sync failed:', err));
    return updated;
  },

  remove(id: string): void {
    const s = useStore.getState();
    s.setIncomeEntries(s.incomeEntries.filter(e => e.id !== id));
    s.setProjectedAnnual(incomeDS.getAll().projected_annual);
    incomeApi.deleteIncome(id)
      .catch((err: unknown) => console.warn('[incomeDS.remove] API sync failed:', err));
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

    overviewApi.createBill(data)
      .then((serverRecord: unknown) => {
        const srv = serverRecord as Bill;
        const s2 = useStore.getState();
        s2.setBills(s2.bills.map(b => b.id === record.id ? srv : b));
      }).catch((err: unknown) => console.warn('[billsDS.add] API sync failed:', err));

    return record;
  },

  update(id: string, data: Partial<Bill>): Bill {
    const s = useStore.getState();
    const updated = s.bills.map(b => b.id === id ? { ...b, ...data, updated_at: ts() } : b);
    s.setBills(updated);

    overviewApi.updateBill(id, data)
      .catch((err: unknown) => console.warn('[billsDS.update] API sync failed:', err));

    return updated.find(b => b.id === id)!;
  },

  pay(id: string): void {
    const s = useStore.getState();
    const bill = s.bills.find(b => b.id === id);
    if (!bill) return;

    // Mark paid locally
    s.setBills(s.bills.map(b => b.id === id ? { ...b, is_paid: true } : b));

    // Auto-generate next occurrence locally for recurring bills
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

    // Sync to backend — reload bills after to get correct server IDs for next occurrence
    overviewApi.payBill(id)
      .then(() => overviewApi.getBills())
      .then((serverBills: unknown) => {
        useStore.getState().setBills((serverBills as Bill[]) ?? []);
      }).catch((err: unknown) => console.warn('[billsDS.pay] API sync failed:', err));
  },

  remove(id: string): void {
    const s = useStore.getState();
    s.setBills(s.bills.filter(b => b.id !== id));
    overviewApi.deleteBill(id)
      .catch((err: unknown) => console.warn('[billsDS.remove] API sync failed:', err));
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

    overviewApi.createGoal(data)
      .then((serverRecord: unknown) => {
        const srv = serverRecord as Goal;
        const s2 = useStore.getState();
        s2.setGoals(s2.goals.map(g => g.id === record.id ? srv : g));
      }).catch((err: unknown) => console.warn('[goalsDS.add] API sync failed:', err));

    return record;
  },

  update(id: string, data: Partial<Goal>): Goal {
    const s = useStore.getState();
    const updated = s.goals.map(g => g.id === id ? { ...g, ...data, updated_at: ts() } : g);
    s.setGoals(updated);

    overviewApi.updateGoal(id, data)
      .catch((err: unknown) => console.warn('[goalsDS.update] API sync failed:', err));

    return updated.find(g => g.id === id)!;
  },

  remove(id: string): void {
    const s = useStore.getState();
    s.setGoals(s.goals.filter(g => g.id !== id));
    overviewApi.deleteGoal(id)
      .catch((err: unknown) => console.warn('[goalsDS.remove] API sync failed:', err));
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

    overviewApi.createBudget(data)
      .then((serverRecord: unknown) => {
        const srv = serverRecord as Budget;
        const s2 = useStore.getState();
        s2.setBudgets(s2.budgets.map(b => b.id === record.id ? srv : b));
      }).catch((err: unknown) => console.warn('[budgetsDS.add] API sync failed:', err));

    return record;
  },

  update(id: string, data: Partial<Budget>): Budget {
    const s = useStore.getState();
    const updated = s.budgets.map(b => b.id === id ? { ...b, ...data } : b);
    s.setBudgets(updated);

    overviewApi.updateBudget(id, data)
      .catch((err: unknown) => console.warn('[budgetsDS.update] API sync failed:', err));

    return updated.find(b => b.id === id)!;
  },

  remove(id: string): void {
    const s = useStore.getState();
    s.setBudgets(s.budgets.filter(b => b.id !== id));
    // No delete endpoint yet — local-only removal
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

// ─── BOOTSTRAP ──────────────────────────────────────────────────────────────

/**
 * Load all user data from the backend and populate the Zustand store.
 * Call this once after the user logs in to hydrate the app with server data.
 */
export async function bootstrapData(): Promise<void> {
  const s = useStore.getState();
  console.log('[bootstrapData] Loading data from backend...');

  const [
    accountsResult,
    creditCardsResult,
    subscriptionsResult,
    transactionsResult,
    investmentsResult,
    superResult,
    incomeResult,
    billsResult,
    goalsResult,
    budgetsResult,
  ] = await Promise.allSettled([
    accountsApi.getAccounts(),
    accountsApi.getCreditCards(),
    accountsApi.getSubscriptions(),
    accountsApi.getTransactions(),
    investmentsApi.getInvestments(),
    investmentsApi.getSuper(),
    incomeApi.getIncome(),
    overviewApi.getBills(),
    overviewApi.getGoals(),
    overviewApi.getBudgets(),
  ]);

  // Load pending payments for all credit cards
  if (creditCardsResult.status === 'fulfilled') {
    const cards = (creditCardsResult.value as CreditCard[]) ?? [];
    const allPayments = await Promise.allSettled(
      cards.map(c => accountsApi.getPayments(c.id))
    );
    const payments = allPayments
      .filter(r => r.status === 'fulfilled')
      .flatMap(r => (r as PromiseFulfilledResult<PendingPayment[]>).value ?? []);
    s.setPendingPayments(payments);
  }

  if (accountsResult.status === 'fulfilled') {
    s.setAccounts((accountsResult.value as BankAccount[]) ?? []);
    console.log('[bootstrapData] accounts:', (accountsResult.value as BankAccount[])?.length ?? 0);
  } else {
    console.warn('[bootstrapData] accounts failed:', accountsResult.reason);
  }

  if (creditCardsResult.status === 'fulfilled') {
    s.setCreditCards((creditCardsResult.value as CreditCard[]) ?? []);
  } else {
    console.warn('[bootstrapData] creditCards failed:', creditCardsResult.reason);
  }

  if (subscriptionsResult.status === 'fulfilled') {
    s.setSubscriptions((subscriptionsResult.value as Subscription[]) ?? []);
  } else {
    console.warn('[bootstrapData] subscriptions failed:', subscriptionsResult.reason);
  }

  if (transactionsResult.status === 'fulfilled') {
    s.setTransactions((transactionsResult.value as Transaction[]) ?? []);
  } else {
    console.warn('[bootstrapData] transactions failed:', transactionsResult.reason);
  }

  if (investmentsResult.status === 'fulfilled') {
    const { investments, portfolio_total } = investmentsResult.value as {
      investments: Investment[]; portfolio_total: number;
    };
    s.setInvestments(investments ?? []);
    s.setPortfolioTotal(portfolio_total ?? 0);
    console.log('[bootstrapData] investments:', investments?.length ?? 0);
  } else {
    console.warn('[bootstrapData] investments failed:', investmentsResult.reason);
  }

  if (superResult.status === 'fulfilled') {
    s.setSuperFunds((superResult.value as SuperFund[]) ?? []);
  } else {
    console.warn('[bootstrapData] super failed:', superResult.reason);
  }

  if (incomeResult.status === 'fulfilled') {
    const { entries, projected_annual } = incomeResult.value as {
      entries: IncomeEntry[]; projected_annual: number;
    };
    s.setIncomeEntries(entries ?? []);
    s.setProjectedAnnual(projected_annual ?? 0);
  } else {
    console.warn('[bootstrapData] income failed:', incomeResult.reason);
  }

  if (billsResult.status === 'fulfilled') {
    s.setBills((billsResult.value as Bill[]) ?? []);
  } else {
    console.warn('[bootstrapData] bills failed:', billsResult.reason);
  }

  if (goalsResult.status === 'fulfilled') {
    s.setGoals((goalsResult.value as Goal[]) ?? []);
  } else {
    console.warn('[bootstrapData] goals failed:', goalsResult.reason);
  }

  if (budgetsResult.status === 'fulfilled') {
    s.setBudgets((budgetsResult.value as Budget[]) ?? []);
  } else {
    console.warn('[bootstrapData] budgets failed:', budgetsResult.reason);
  }

  // Clean up orphaned transactions (e.g. from accounts deleted while offline)
  const s2 = useStore.getState();
  const validAccountIds = new Set([
    ...s2.accounts.map(a => a.id),
    ...s2.creditCards.map(c => c.id),
  ]);
  const cleanedTransactions = s2.transactions.filter(t => validAccountIds.has(t.account_id));
  if (cleanedTransactions.length !== s2.transactions.length) {
    console.log('cleaned up', s2.transactions.length - cleanedTransactions.length, 'orphaned transactions');
    s2.setTransactions(cleanedTransactions);
  }

  console.log('[bootstrapData] Done.');
}

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
