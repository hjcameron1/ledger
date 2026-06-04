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
import { accountsApi, investmentsApi, incomeApi, overviewApi, API_BASE } from './api';
import { syncWithRetry, registerSyncSuccess, retryPendingSync } from './syncQueue';

// ─── helpers ────────────────────────────────────────────────────────────────

function uuid(): string {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
function ts() { return new Date().toISOString(); }
function uid() { return useStore.getState().user?.id ?? 'local'; }

/**
 * Merge server records with local records, keyed by id.
 *  - Server record WINS when the same id exists in both (it's authoritative).
 *  - Local-only records are KEPT (they may be pending sync after a failed write,
 *    and would otherwise vanish on reload — the core data-loss bug this fixes).
 * Local order is preserved first, then any server-only records are appended.
 */
function mergeById<T extends { id: string }>(server: T[], local: T[]): T[] {
  const byId = new Map<string, T>();
  for (const l of local) byId.set(l.id, l);    // seed with local (keeps local-only)
  for (const sv of server) byId.set(sv.id, sv); // server overwrites on id collision
  return [...byId.values()];
}

// ─── CENTRAL ID RECONCILIATION ───────────────────────────────────────────────
//
// The single source of truth for the local-temp-id ⇄ server-id problem.
// When a record is created locally it gets a temp UUID; once the server responds
// with the real UUID we must (a) swap the record's id, (b) rewrite every related
// record that referenced the temp id, and (c) remember the mapping forever so any
// record that was already persisted with the temp id can still be resolved later.
//
// EVERYTHING account-id related goes through resolveAccountId() / accountIdMatches()
// so there is exactly one place that understands id equivalence.

/**
 * Collapse any id to its canonical server id by following the persisted idMap
 * chain (handles the rare case of multiple swaps). Unknown ids return unchanged.
 */
export function resolveAccountId(id: string): string {
  if (!id) return id;
  const { idMap } = useStore.getState();
  let resolved = id;
  const seen = new Set<string>();
  while (idMap[resolved] && !seen.has(resolved)) {
    seen.add(resolved);
    resolved = idMap[resolved];
  }
  return resolved;
}

/**
 * Does `candidateId` refer to the same account/card as `account`?
 * Checks direct id, the record's localId/serverId, and the idMap-resolved canonical id.
 */
export function accountIdMatches(
  candidateId: string | undefined | null,
  account: { id: string; localId?: string; serverId?: string },
): boolean {
  if (!candidateId) return false;
  if (
    candidateId === account.id ||
    candidateId === account.localId ||
    candidateId === account.serverId
  ) return true;
  return resolveAccountId(candidateId) === resolveAccountId(account.id);
}

/** Every id variant a given account/card is known by — direct, secondary, and idMap-resolved. */
export function accountIdVariants(
  account: { id: string; localId?: string; serverId?: string },
): Set<string> {
  const { idMap } = useStore.getState();
  const variants = new Set<string>(
    [account.id, account.localId, account.serverId].filter(Boolean) as string[],
  );
  const canonical = resolveAccountId(account.id);
  variants.add(canonical);
  // Also include any temp id that maps INTO this account's canonical id.
  for (const [temp, server] of Object.entries(idMap)) {
    if (server === canonical || resolveAccountId(server) === canonical) variants.add(temp);
  }
  return variants;
}

/**
 * THE central handler. Call immediately after the server returns the real record
 * for a locally-created account or credit card.
 *  1. Records tempId → serverId permanently (persisted idMap)
 *  2. Swaps the record's id in its collection (keeping both ids for fallback)
 *  3. Rewrites every related record (transactions, subscriptions) that referenced the temp id
 */
export function reconcileServerId(
  tempId: string,
  serverRecord: BankAccount | CreditCard,
  type: 'bank' | 'credit_card',
): void {
  const serverId = serverRecord.id;
  if (!tempId || !serverId) return;
  const s = useStore.getState();

  // 1. Permanent mapping
  if (tempId !== serverId) s.addIdMapping(tempId, serverId);

  // 2. Swap the record's id, keep both ids on the merged record for fallback matching
  if (type === 'bank') {
    const merged = { ...(serverRecord as BankAccount), localId: tempId, serverId };
    s.setAccounts(s.accounts.map(a => (a.id === tempId ? merged : a)));
  } else {
    const merged = { ...(serverRecord as CreditCard), localId: tempId, serverId };
    s.setCreditCards(s.creditCards.map(c => (c.id === tempId ? merged : c)));
  }

  // 3. Rewrite every related record that still points at the temp id
  if (tempId !== serverId) {
    s.setTransactions(
      s.transactions.map(t => (t.account_id === tempId ? { ...t, account_id: serverId } : t)),
    );
    s.setSubscriptions(
      s.subscriptions.map(sub => (sub.account_id === tempId ? { ...sub, account_id: serverId } : sub)),
    );
  }

}

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

    // Background sync (with retry) — server record swaps in via the success handler.
    syncWithRetry('account.create', {
      recordId: record.id,
      data: {
        name: data.name, institution: data.institution, account_type: data.account_type,
        balance: data.balance, bsb: data.bsb, account_number: data.account_number,
        currency: data.currency,
      },
    });

    return record;
  },

  update(id: string, data: Partial<BankAccount>): BankAccount {
    const s = useStore.getState();
    const updated = s.accounts.map(a =>
      a.id === id ? { ...a, ...data, updated_at: ts() } : a
    );
    s.setAccounts(updated);
    syncWithRetry('account.update', { id, data });
    return updated.find(a => a.id === id)!;
  },

  remove(id: string): void {
    const s = useStore.getState();
    const acct = s.accounts.find(a => a.id === id);
    const ids = acct ? accountIdVariants(acct) : new Set([id]);
    s.setAccounts(s.accounts.filter(a => a.id !== id));
    s.setTransactions(s.transactions.filter(t => !ids.has(t.account_id)));
    syncWithRetry('account.delete', { id });
  },
};

// ─── CREDIT CARDS ───────────────────────────────────────────────────────────

/** Canonical name for a credit card's payment-reminder bill. */
export const cardReminderBillName = (cardName: string): string => `${cardName} payment due`;

/** Reminder amount: the minimum payment, or the full balance owing if no minimum is set. */
export const cardReminderAmount = (
  card: Pick<CreditCard, 'minimum_payment' | 'balance_owing'>,
): number =>
  card.minimum_payment && card.minimum_payment > 0 ? card.minimum_payment : card.balance_owing;

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

    syncWithRetry('card.create', {
      recordId: record.id,
      data: {
        name: data.name, institution: data.institution, balance_owing: data.balance_owing,
        credit_limit: data.credit_limit, minimum_payment: data.minimum_payment,
        due_date: data.due_date, currency: data.currency,
      },
    });

    return record;
  },

  update(id: string, data: Partial<CreditCard>): CreditCard {
    const s = useStore.getState();
    const updated = s.creditCards.map(c =>
      c.id === id ? { ...c, ...data, updated_at: ts() } : c
    );
    s.setCreditCards(updated);
    // No dedicated updateCreditCard endpoint yet — local-only for now

    // Keep any linked payment-reminder bill in sync (amount + due date).
    const card = updated.find(c => c.id === id);
    if (card && card.due_date) {
      const billName = cardReminderBillName(card.name).toLowerCase();
      const linked = useStore.getState().bills.find(
        b => !b.is_paid && b.name.toLowerCase() === billName
      );
      if (linked) {
        billsDS.update(linked.id, { amount: cardReminderAmount(card), due_date: card.due_date });
      }
    }

    return updated.find(c => c.id === id)!;
  },

  remove(id: string): void {
    const s = useStore.getState();
    const card = s.creditCards.find(c => c.id === id);
    const ids = card ? accountIdVariants(card) : new Set([id]);
    s.setCreditCards(s.creditCards.filter(c => c.id !== id));
    s.setTransactions(s.transactions.filter(t => !ids.has(t.account_id)));
    // Remove the linked payment-reminder bill, if any.
    if (card) billsDS.removeByName(cardReminderBillName(card.name));
    syncWithRetry('card.delete', { id });
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

    syncWithRetry('payment.create', {
      recordId: record.id,
      creditCardId: data.credit_card_id,
      data: { bank_account_id: data.bank_account_id, amount: data.amount },
    });

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

    syncWithRetry('payment.update', {
      id: paymentId,
      creditCardId: payment.credit_card_id,
      data: { status: 'reconciled', reconciled_transaction_id: transactionId },
    });
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

      syncWithRetry('payment.create', {
        recordId: record.id,
        creditCardId: card.id,
        data: { amount: txAmount, status: 'reconciled', reconciled_transaction_id: tx.id },
      });
    }
  }
}

// ─── TRANSACTIONS ───────────────────────────────────────────────────────────

export const transactionsDS = {
  getAll(params?: { account_id?: string; search?: string }): Transaction[] {
    let txns = useStore.getState().transactions;
    if (params?.account_id) {
      const target = resolveAccountId(params.account_id);
      txns = txns.filter(t => resolveAccountId(t.account_id) === target);
    }
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

    syncWithRetry('transaction.create', { recordId: record.id, data });

    return record;
  },

  update(id: string, data: Partial<Transaction>): Transaction {
    const s = useStore.getState();
    const updated = s.transactions.map(t =>
      t.id === id ? { ...t, ...data, updated_at: ts() } : t
    );
    s.setTransactions(updated);
    syncWithRetry('transaction.update', { id, data });
    return updated.find(t => t.id === id)!;
  },

  remove(id: string): void {
    const s = useStore.getState();
    s.setTransactions(s.transactions.filter(t => t.id !== id));
    syncWithRetry('transaction.delete', { id });
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

    syncWithRetry('subscription.create', { recordId: record.id, data });

    return record;
  },

  /** Patch arbitrary fields on a subscription (e.g. set account_id to null). */
  update(id: string, patch: Partial<Omit<Subscription, 'id' | 'user_id' | 'created_at' | 'updated_at'>>): void {
    const s = useStore.getState();
    s.setSubscriptions(s.subscriptions.map(sub =>
      sub.id === id ? { ...sub, ...patch, updated_at: ts() } : sub
    ));
    syncWithRetry('subscription.update', { id, data: patch });
  },

  /** Rename a subscription — keeps original_name intact. */
  rename(id: string, newName: string): void {
    const s = useStore.getState();
    s.setSubscriptions(s.subscriptions.map(sub =>
      sub.id === id ? { ...sub, name: newName, updated_at: ts() } : sub
    ));
    syncWithRetry('subscription.update', { id, data: { name: newName } });
  },

  remove(id: string): void {
    const s = useStore.getState();
    const sub = s.subscriptions.find(sub => sub.id === id);
    s.setSubscriptions(s.subscriptions.filter(sub => sub.id !== id));
    // Remove any linked bill — by stable id first, then by name for legacy bills.
    billsDS.removeBySubscription(id);
    if (sub) {
      billsDS.removeByName(sub.name, sub.original_name);
    }
    syncWithRetry('subscription.delete', { id });
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

    // Background sync — backend fetches live price so the server record replaces ours.
    syncWithRetry('investment.create', { recordId: record.id, data });

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

    syncWithRetry('investment.update', { id, data });

    return updated.find(i => i.id === id)!;
  },

  remove(id: string): void {
    const s = useStore.getState();
    const removed = s.investments.find(i => i.id === id);
    s.setInvestments(s.investments.filter(i => i.id !== id));
    if (removed) s.setPortfolioTotal(s.portfolioTotal - removed.current_value);
    syncWithRetry('investment.delete', { id });
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

    syncWithRetry('super.create', { recordId: record.id, data });

    return record;
  },

  update(id: string, data: Partial<SuperFund>): SuperFund {
    const s = useStore.getState();
    const updated = s.superFunds.map(f =>
      f.id === id ? { ...f, ...data, updated_at: ts() } : f
    );
    s.setSuperFunds(updated);

    syncWithRetry('super.update', { id, data });

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

    syncWithRetry('income.create', { recordId: record.id, data });

    return record;
  },

  update(id: string, data: Partial<IncomeEntry>): IncomeEntry {
    const s = useStore.getState();
    const updated = s.incomeEntries.map(e =>
      e.id === id ? { ...e, ...data, updated_at: ts() } : e
    );
    s.setIncomeEntries(updated);
    s.setProjectedAnnual(incomeDS.getAll().projected_annual);

    syncWithRetry('income.update', { id, data });

    return updated.find(e => e.id === id)!;
  },

  approve(id: string): IncomeEntry {
    const updated = incomeDS.update(id, { status: 'approved' });
    // Also hit the dedicated approve endpoint
    syncWithRetry('income.approve', { id });
    return updated;
  },

  remove(id: string): void {
    const s = useStore.getState();
    s.setIncomeEntries(s.incomeEntries.filter(e => e.id !== id));
    s.setProjectedAnnual(incomeDS.getAll().projected_annual);
    syncWithRetry('income.delete', { id });
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

/** Compute the next occurrence date for a recurring bill. */
function nextOccurrence(d: Date, frequency?: string): Date {
  const n = new Date(d);
  switch ((frequency ?? 'monthly').toLowerCase()) {
    case 'weekly':      n.setDate(n.getDate() + 7);  break;
    case 'fortnightly': n.setDate(n.getDate() + 14); break;
    case 'quarterly':   n.setMonth(n.getMonth() + 3); break;
    case 'annually':
    case 'yearly':      n.setFullYear(n.getFullYear() + 1); break;
    case 'monthly':
    default:            n.setMonth(n.getMonth() + 1); break;
  }
  return n;
}

export const billsDS = {
  /** Active (unpaid) bills, sorted soonest first. Also lazily:
   *  - purges completed bills paid more than 7 days ago
   *  - deduplicates unpaid bills with the same name + amount (keeps earliest due_date)
   *  - removes "Gym" bills (one-time cleanup)
   */
  getAll(): Bill[] {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const s = useStore.getState();

    // 1. Purge paid bills older than 7 days
    let working = s.bills.filter(b => {
      if (!b.is_paid) return true;
      if (!b.paid_at) return false;
      return new Date(b.paid_at) > sevenDaysAgo;
    });

    // 2. Deduplicate unpaid bills only when they are true duplicates: same name +
    // amount + due_date. Previously the key was name+amount alone, which silently
    // deleted distinct bills that merely shared a name and amount. Including
    // due_date means only genuine repeat occurrences collapse.
    const seen = new Map<string, Bill>();
    const toRemoveIds = new Set<string>();
    for (const b of working) {
      if (b.is_paid) continue; // leave paid bills alone
      if (b.subscription_id) continue; // subscription-linked — identity-keyed, never name-dedup
      const key = `${b.name.toLowerCase().trim()}::${parseFloat(b.amount.toFixed(2))}::${b.due_date}`;
      const prev = seen.get(key);
      if (!prev) {
        seen.set(key, b);
      } else {
        // Same name+amount+due_date — a true duplicate. Keep the first seen.
        toRemoveIds.add(b.id);
      }
    }
    if (toRemoveIds.size > 0) {
      working = working.filter(b => !toRemoveIds.has(b.id));
      toRemoveIds.forEach(id => syncWithRetry('bill.delete', { id }));
    }

    if (working.length !== s.bills.length) s.setBills(working);
    return working.filter(b => !b.is_paid)
      .sort((a, b) => new Date(a.due_date).getTime() - new Date(b.due_date).getTime());
  },

  /** Bills paid within the last 7 days, most recently paid first. */
  getRecentlyPaid(): Bill[] {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    return useStore.getState().bills
      .filter(b => b.is_paid && b.paid_at && new Date(b.paid_at) > sevenDaysAgo)
      .sort((a, b) => (b.paid_at ?? '').localeCompare(a.paid_at ?? ''));
  },

  add(data: Omit<Bill, 'id' | 'user_id' | 'created_at' | 'updated_at'>): Bill | null {
    const s = useStore.getState();
    const nameLower = data.name.toLowerCase().trim();
    // Skip ONLY if an unpaid bill with the EXACT same name (case-insensitive) already exists.
    const existing = s.bills.find(b =>
      !b.is_paid &&
      b.name.toLowerCase().trim() === nameLower
    );
    if (existing) {
      return null;
    }

    const record: Bill = { ...data, id: uuid(), user_id: uid(), created_at: ts(), updated_at: ts() };
    s.setBills([...s.bills, record]);

    syncWithRetry('bill.create', { recordId: record.id, data });

    return record;
  },

  // ── Subscription-linked bills ───────────────────────────────────────────────
  // Bills created via a subscription's "Also in bills & reminders" toggle are
  // linked by stable subscription_id, NOT by name. This makes the toggle robust:
  // renaming, deleting/re-adding, or duplicate names never break the link.

  /** The unpaid bill linked to a subscription, if any (identity match). */
  findBySubscription(subscriptionId: string): Bill | undefined {
    return useStore.getState().bills.find(
      b => !b.is_paid && b.subscription_id === subscriptionId
    );
  },

  /** Create a bill unconditionally — no name-collision guard. The user explicitly
   *  toggled this on, so it must always appear regardless of what it's called or
   *  whether a same-named bill ever existed. */
  addLinked(data: Omit<Bill, 'id' | 'user_id' | 'created_at' | 'updated_at'>): Bill {
    const s = useStore.getState();
    const record: Bill = { ...data, id: uuid(), user_id: uid(), created_at: ts(), updated_at: ts() };
    s.setBills([...s.bills, record]);
    syncWithRetry('bill.create', { recordId: record.id, data });
    return record;
  },

  /** Remove the unpaid bill(s) linked to a subscription id (toggle turned off). */
  removeBySubscription(subscriptionId: string): void {
    const s = useStore.getState();
    const toRemove = s.bills.filter(b => !b.is_paid && b.subscription_id === subscriptionId);
    if (toRemove.length === 0) return;
    const ids = new Set(toRemove.map(b => b.id));
    s.setBills(s.bills.filter(b => !ids.has(b.id)));
    toRemove.forEach(b => syncWithRetry('bill.delete', { id: b.id }));
  },

  update(id: string, data: Partial<Bill>): Bill {
    const s = useStore.getState();
    const updated = s.bills.map(b => b.id === id ? { ...b, ...data, updated_at: ts() } : b);
    s.setBills(updated);

    syncWithRetry('bill.update', { id, data });

    return updated.find(b => b.id === id)!;
  },

  /**
   * Mark a bill as paid. Stamps paid_at with today's date and moves the bill
   * to "Recently completed" — it stays visible there for 7 days then is purged.
   *
   * No new occurrence is created here; recurring bills must be re-added manually
   * or will be re-detected via the subscription flow.
   */
  pay(id: string): void {
    const s = useStore.getState();
    const bill = s.bills.find(b => b.id === id);
    if (!bill) return;

    const today = new Date().toISOString().split('T')[0];
    s.setBills(s.bills.map(b =>
      b.id === id ? { ...b, is_paid: true, paid_at: today, updated_at: ts() } : b
    ));

    syncWithRetry('bill.pay', { id });
  },

  /** Restore a recently-paid bill back to unpaid (undo tick-off). */
  restore(id: string): void {
    const s = useStore.getState();
    s.setBills(s.bills.map(b =>
      b.id === id ? { ...b, is_paid: false, paid_at: undefined, updated_at: ts() } : b
    ));
    // Backend doesn't have a restore endpoint — update the bill fields directly
    syncWithRetry('bill.update', { id, data: { is_paid: false } });
  },

  /** Delete all unpaid bills whose name matches any of the supplied names (case-insensitive).
   *  Pass both `name` and `original_name` so a renamed subscription still clears its bill. */
  removeByName(...names: (string | null | undefined)[]): void {
    const lowerNames = names
      .filter((n): n is string => typeof n === 'string' && n.length > 0)
      .map(n => n.toLowerCase());
    if (lowerNames.length === 0) return;
    const s = useStore.getState();
    const toRemove = s.bills.filter(b => {
      if (b.is_paid) return false;
      // EXACT (trimmed, lowercased) name match only. Fuzzy substring matching
      // here destroyed sibling bills (e.g. saving "Apple" deleted "Apple Music",
      // "Apple TV"). The original_name argument already covers the rename case.
      const bn = b.name.toLowerCase().trim();
      return lowerNames.some(n => bn === n.trim());
    });
    if (toRemove.length === 0) return;
    const removeIds = new Set(toRemove.map(b => b.id));
    s.setBills(s.bills.filter(b => !removeIds.has(b.id)));
    toRemove.forEach(b => syncWithRetry('bill.delete', { id: b.id }));
  },

  remove(id: string): void {
    const s = useStore.getState();
    s.setBills(s.bills.filter(b => b.id !== id));
    syncWithRetry('bill.delete', { id });
  },

  /**
   * Advance every auto-pay bill whose due date has already passed to its next
   * future occurrence — without marking it paid. Call on app load. Auto-pay
   * bills are treated as always-paid-on-time, so they never go overdue.
   */
  advanceAutoPay(): void {
    const s = useStore.getState();
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    let changed = false;
    const updated = s.bills.map(b => {
      if (!b.auto_pay || b.is_paid || !b.is_recurring) return b;
      let due = new Date(b.due_date);
      if (isNaN(due.getTime()) || due >= today) return b;
      while (due < today) due = nextOccurrence(due, b.frequency);
      changed = true;
      const newDate = due.toISOString().split('T')[0];
      syncWithRetry('bill.update', { id: b.id, data: { due_date: newDate } });
      return { ...b, due_date: newDate, updated_at: ts() };
    });
    if (changed) s.setBills(updated);
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

    syncWithRetry('goal.create', { recordId: record.id, data });

    return record;
  },

  update(id: string, data: Partial<Goal>): Goal {
    const s = useStore.getState();
    const updated = s.goals.map(g => g.id === id ? { ...g, ...data, updated_at: ts() } : g);
    s.setGoals(updated);

    syncWithRetry('goal.update', { id, data });

    return updated.find(g => g.id === id)!;
  },

  remove(id: string): void {
    const s = useStore.getState();
    s.setGoals(s.goals.filter(g => g.id !== id));
    syncWithRetry('goal.delete', { id });
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

    syncWithRetry('budget.create', { recordId: record.id, data });

    return record;
  },

  update(id: string, data: Partial<Budget>): Budget {
    const s = useStore.getState();
    const updated = s.budgets.map(b => b.id === id ? { ...b, ...data } : b);
    s.setBudgets(updated);

    syncWithRetry('budget.update', { id, data });

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

// ─── SYNC SUCCESS HANDLERS ───────────────────────────────────────────────────
//
// Registered with the retry layer so that — whether a write succeeds on the first
// try, on the 3s retry, or on a queued replay after reload — the local temp record
// is reconciled with the authoritative server record exactly once. Kept here (not
// in syncQueue) so they can reach reconcileServerId / the *DS recompute helpers
// without creating a circular import.

registerSyncSuccess('account.create', (srv, pl) =>
  reconcileServerId(pl.recordId as string, srv as BankAccount, 'bank'));

registerSyncSuccess('card.create', (srv, pl) =>
  reconcileServerId(pl.recordId as string, srv as CreditCard, 'credit_card'));

registerSyncSuccess('transaction.create', (srv, pl) => {
  const s = useStore.getState();
  // Preserve the current account_id — it may have been remapped from a temp UUID
  // to the real Supabase UUID while this request was in flight.
  s.setTransactions(s.transactions.map(t =>
    t.id === pl.recordId ? { ...(srv as Transaction), account_id: t.account_id } : t));
});

registerSyncSuccess('subscription.create', (srv, pl) => {
  const s = useStore.getState();
  s.setSubscriptions(s.subscriptions.map(sub =>
    sub.id === pl.recordId ? (srv as Subscription) : sub));
});

registerSyncSuccess('investment.create', (srv, pl) => {
  const { investment } = srv as { investment: Investment };
  const s = useStore.getState();
  const next = s.investments.map(i => i.id === pl.recordId ? investment : i);
  s.setInvestments(next);
  s.setPortfolioTotal(next.reduce((sum, i) => sum + i.current_value, 0));
});

registerSyncSuccess('super.create', (srv, pl) => {
  const s = useStore.getState();
  s.setSuperFunds(s.superFunds.map(f => f.id === pl.recordId ? (srv as SuperFund) : f));
});

registerSyncSuccess('income.create', (srv, pl) => {
  const s = useStore.getState();
  s.setIncomeEntries(s.incomeEntries.map(e => e.id === pl.recordId ? (srv as IncomeEntry) : e));
  s.setProjectedAnnual(incomeDS.getAll().projected_annual);
});

registerSyncSuccess('bill.create', (srv, pl) => {
  const s = useStore.getState();
  s.setBills(s.bills.map(b => b.id === pl.recordId ? (srv as Bill) : b));
});

registerSyncSuccess('goal.create', (srv, pl) => {
  const s = useStore.getState();
  s.setGoals(s.goals.map(g => g.id === pl.recordId ? (srv as Goal) : g));
});

registerSyncSuccess('budget.create', (srv, pl) => {
  const s = useStore.getState();
  s.setBudgets(s.budgets.map(b => b.id === pl.recordId ? (srv as Budget) : b));
});

registerSyncSuccess('payment.create', (srv, pl) => {
  const s = useStore.getState();
  s.setPendingPayments(s.pendingPayments.map(p => p.id === pl.recordId ? (srv as PendingPayment) : p));
});

// ─── BOOTSTRAP ──────────────────────────────────────────────────────────────

/**
 * Load all user data from the backend and populate the Zustand store.
 * Call this once after the user logs in to hydrate the app with server data.
 */
export async function bootstrapData(): Promise<void> {
  const s = useStore.getState();

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
    s.setPendingPayments(mergeById(payments, s.pendingPayments));
  }

  if (accountsResult.status === 'fulfilled') {
    const merged = mergeById((accountsResult.value as BankAccount[]) ?? [], s.accounts);
    s.setAccounts(merged);
  } else {
    console.warn('[bootstrapData] accounts failed:', accountsResult.reason);
  }

  if (creditCardsResult.status === 'fulfilled') {
    s.setCreditCards(mergeById((creditCardsResult.value as CreditCard[]) ?? [], s.creditCards));
  } else {
    console.warn('[bootstrapData] creditCards failed:', creditCardsResult.reason);
  }

  if (subscriptionsResult.status === 'fulfilled') {
    s.setSubscriptions(mergeById((subscriptionsResult.value as Subscription[]) ?? [], s.subscriptions));
  } else {
    console.warn('[bootstrapData] subscriptions failed:', subscriptionsResult.reason);
  }

  if (transactionsResult.status === 'fulfilled') {
    s.setTransactions(mergeById((transactionsResult.value as Transaction[]) ?? [], s.transactions));
  } else {
    console.warn('[bootstrapData] transactions failed:', transactionsResult.reason);
  }

  if (investmentsResult.status === 'fulfilled') {
    const { investments } = investmentsResult.value as {
      investments: Investment[]; portfolio_total: number;
    };
    const merged = mergeById(investments ?? [], s.investments);
    s.setInvestments(merged);
    // Recompute the total locally so any kept local-only holdings are included.
    s.setPortfolioTotal(merged.reduce((sum, i) => sum + i.current_value, 0));
  } else {
    console.warn('[bootstrapData] investments failed:', investmentsResult.reason);
  }

  if (superResult.status === 'fulfilled') {
    s.setSuperFunds(mergeById((superResult.value as SuperFund[]) ?? [], s.superFunds));
  } else {
    console.warn('[bootstrapData] super failed:', superResult.reason);
  }

  if (incomeResult.status === 'fulfilled') {
    const { entries } = incomeResult.value as {
      entries: IncomeEntry[]; projected_annual: number;
    };
    s.setIncomeEntries(mergeById(entries ?? [], s.incomeEntries));
    // Recompute projected annual locally to account for any kept local-only entries.
    s.setProjectedAnnual(incomeDS.getAll().projected_annual);
  } else {
    console.warn('[bootstrapData] income failed:', incomeResult.reason);
  }

  if (billsResult.status === 'fulfilled') {
    const serverBills = (billsResult.value as Bill[]) ?? [];
    const localBills  = s.bills;
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    // Merge server + local by id (server wins on collision; local-only bills kept
    // so a bill whose create failed to sync doesn't vanish on reload). Then preserve
    // local paid_at / is_paid where we marked it paid before the server caught up.
    const serverById = new Map(serverBills.map(b => [b.id, b]));
    const localById  = new Map(localBills.map(b => [b.id, b]));
    const merged: Bill[] = mergeById(serverBills, localBills).map(b => {
      const srv = serverById.get(b.id);
      if (!srv) return b; // local-only (pending sync) — keep verbatim
      const local = localById.get(b.id);
      if (local?.is_paid && !srv.is_paid) {
        // We paid it locally but server hasn't caught up — keep local paid state
        return { ...srv, is_paid: true, paid_at: local.paid_at };
      }
      // Server is authoritative otherwise, but carry over local paid_at if missing
      return srv.paid_at ? srv : { ...srv, paid_at: local?.paid_at };
    });

    // Drop paid bills older than 7 days (or paid bills with no paid_at date)
    const fresh = merged.filter(b =>
      !b.is_paid || (b.paid_at && new Date(b.paid_at) > sevenDaysAgo)
    );

    // ── Deduplicate true duplicates only: same name + amount + due_date ──
    // Previously keyed on name+amount alone, which permanently deleted distinct
    // bills that merely shared a name and amount (e.g. two subscriptions toggled
    // into bills). Including due_date means only genuine repeat occurrences
    // collapse. Mirrors the dedup in billsDS.getAll.
    const seen = new Map<string, Bill>();
    const toDelete: Bill[] = [];
    for (const b of fresh) {
      // Subscription-linked bills are identity-keyed by their own id so they are
      // never collapsed against another bill — the user explicitly toggled them on.
      const key = b.subscription_id
        ? `linked::${b.id}`
        : `${b.name.toLowerCase().trim()}::${parseFloat(b.amount.toFixed(2))}::${b.due_date}`;
      const existing = seen.get(key);
      if (!existing) {
        seen.set(key, b);
      } else {
        // Same name+amount+due_date — a true duplicate. Keep the first seen.
        toDelete.push(b);
      }
    }
    toDelete.forEach(b => syncWithRetry('bill.delete', { id: b.id }));
    const deduped = [...seen.values()];

    s.setBills(deduped);
    // Auto-advance any auto-pay bills that have rolled past their due date.
    billsDS.advanceAutoPay();
  } else {
    console.warn('[bootstrapData] bills failed:', billsResult.reason);
  }

  if (goalsResult.status === 'fulfilled') {
    s.setGoals(mergeById((goalsResult.value as Goal[]) ?? [], s.goals));
  } else {
    console.warn('[bootstrapData] goals failed:', goalsResult.reason);
  }

  if (budgetsResult.status === 'fulfilled') {
    s.setBudgets(mergeById((budgetsResult.value as Budget[]) ?? [], s.budgets));
  } else {
    console.warn('[bootstrapData] budgets failed:', budgetsResult.reason);
  }


  // Replay any writes that failed to reach Supabase in a previous session.
  retryPendingSync();

  // ── Reconcile transaction ⇄ account links ──────────────────────────────────
  // Persisted transactions may reference a stale temp/local UUID after the account
  // was re-synced with a fresh server UUID. Remap them onto the correct account
  // instead of deleting them (the previous behaviour, which made transactions vanish).
  reconcileTransactionLinks();

  // A second reconciliation pass after a short delay, so any late-arriving
  // accounts/cards (background id swaps) are in the store before we hard-clean.
  setTimeout(() => reconcileTransactionLinks(true), 2000);
}

/**
 * Align every transaction's account_id with a known account/card.
 * Matching order: primary id → secondary (localId/serverId) → account name/institution.
 * When `hardClean` is true, transactions that still can't be matched are dropped.
 */
function reconcileTransactionLinks(hardClean = false): void {
  const s = useStore.getState();
  const accountsList = s.accounts;
  const cardsList = s.creditCards;

  // Build lookup maps. Any secondary id (localId/serverId) → canonical primary id.
  const primaryIds = new Set<string>([
    ...accountsList.map(a => a.id),
    ...cardsList.map(c => c.id),
  ]);
  const secondaryToPrimary = new Map<string, string>();
  const norm = (v?: string) => (v ?? '').toLowerCase().trim();
  const nameToPrimary = new Map<string, { id: string; type: 'bank' | 'credit_card' }>();

  const register = (
    item: { id: string; localId?: string; serverId?: string; name: string; institution: string },
    type: 'bank' | 'credit_card',
  ) => {
    for (const sid of [item.localId, item.serverId]) {
      if (sid && sid !== item.id) secondaryToPrimary.set(sid, item.id);
    }
    if (item.name) nameToPrimary.set(norm(item.name), { id: item.id, type });
    if (item.institution) nameToPrimary.set(norm(item.institution), { id: item.id, type });
  };
  accountsList.forEach(a => register(a, 'bank'));
  cardsList.forEach(c => register(c, 'credit_card'));

  let remapped = 0;
  let dropped = 0;
  const reconciled: Transaction[] = [];
  for (const t of s.transactions) {
    if (primaryIds.has(t.account_id)) { reconciled.push(t); continue; }

    // Central idMap: collapse the tx's stale id to its canonical server id.
    const viaIdMap = resolveAccountId(t.account_id);
    if (viaIdMap !== t.account_id && primaryIds.has(viaIdMap)) {
      reconciled.push({ ...t, account_id: viaIdMap });
      remapped++;
      continue;
    }

    const viaSecondary = secondaryToPrimary.get(t.account_id);
    if (viaSecondary) {
      reconciled.push({ ...t, account_id: viaSecondary });
      remapped++;
      continue;
    }

    // Last resort: match by merchant-embedded account name / institution.
    const viaName = nameToPrimary.get(norm(t.merchant));
    if (viaName && viaName.type === t.account_type) {
      reconciled.push({ ...t, account_id: viaName.id });
      remapped++;
      continue;
    }

    if (hardClean) { dropped++; continue; }
    reconciled.push(t); // keep for now; a later pass may resolve it
  }

  if (remapped > 0 || dropped > 0) {
    s.setTransactions(reconciled);
  }
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
    const res = await fetch(`${API_BASE}/api/basiq/connect`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${useStore.getState().token ?? ''}`,
      },
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
    const res = await fetch(`${API_BASE}/api/basiq/accounts?userId=${encodeURIComponent(basiqUserId)}`, {
      headers: { Authorization: `Bearer ${useStore.getState().token ?? ''}` },
    });
    if (!res.ok) {
      const detail = await res.json().catch(() => ({})) as { error?: string };
      throw new Error(detail.error ?? `Fetch accounts failed: HTTP ${res.status}`);
    }
    return res.json();
  },

  /** Fetch live transactions from Basiq. */
  async fetchTransactions(basiqUserId: string): Promise<BasiqTransaction[]> {
    const res = await fetch(`${API_BASE}/api/basiq/transactions?userId=${encodeURIComponent(basiqUserId)}`, {
      headers: { Authorization: `Bearer ${useStore.getState().token ?? ''}` },
    });
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
    const res = await fetch(`${API_BASE}/api/basiq/auth_link?${params}`, {
      headers: { Authorization: `Bearer ${useStore.getState().token ?? ''}` },
    });
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
    const res = await fetch(`${API_BASE}/api/upload/parse`, {
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
