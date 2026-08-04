/**
 * Local-first data service.
 * All operations update Zustand (persisted to localStorage) immediately.
 * Backend sync is attempted silently in the background — never blocks the UI.
 * Call bootstrapData() after login to load fresh server data into the store.
 */

import { useStore } from '../store';
import type {
  BankAccount, CreditCard, Transaction, Subscription,
  Investment, SuperFund, IncomeEntry, Bill, Goal, Loan, Budget,
  BudgetSettings, BudgetLine, CustomCategory,
  Notification, NetWorthSnapshot, PendingPayment, InvestmentSale,
  CreditCardStatement, CcPaymentPrompt,
} from '../types';
import { verifyInvestment } from '../utils/investmentVerification';
import { autoCategory } from '../utils/format';
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

/**
 * Server-authoritative merge. Unlike mergeById() — which keeps every local-only row
 * forever — this DROPS local rows the server no longer has, so anything deleted on
 * another device / the web / the Telegram bot stops lingering as a ghost on this
 * device (the "phone still shows old/deleted data" bug).
 *
 * Two rows are still protected from being dropped:
 *   1. Genuinely-unsynced offline creates still parked in the retry queue under
 *      `createKind` — they legitimately aren't on the server yet.
 *   2. ALL local rows when the server returns an EMPTY list — an empty response is
 *      ambiguous (often a transient cold-start/partial result), and treating it as
 *      authoritative would wipe the cache. We keep what we have, matching the
 *      conservative local-first stance used for transactions.
 * (A rejected request never reaches here — callers only merge on `fulfilled`.)
 */
function mergeServerAuthoritative<T extends { id: string }>(
  server: T[],
  local: T[],
  createKind: string,
): T[] {
  if (server.length === 0) return local; // ambiguous empty — keep cache, don't wipe
  const serverIds = new Set(server.map(r => r.id));
  const pendingCreateIds = new Set(
    useStore.getState().pendingSyncQueue
      .filter(q => q.kind === createKind)
      .map(q => String((q.payload as { recordId?: string }).recordId ?? '')),
  );
  const keptLocal = local.filter(l =>
    !serverIds.has(l.id) &&
    !serverIds.has(resolveAccountId(l.id)) &&
    pendingCreateIds.has(l.id),
  );
  return [...server, ...keptLocal];
}

/**
 * Collapse content-duplicate accounts/cards that ended up with DIFFERENT ids
 * (e.g. a queued account.create replayed and created a second server row for the
 * same real-world account). We key by the strongest identity available and keep
 * the EARLIEST-created row as canonical; every duplicate's id is mapped to the
 * canonical id (addIdMapping) so any transaction that referenced the duplicate
 * still resolves to the surviving account. Purely client-side de-dup — it never
 * deletes server rows, so it's safe to run on every bootstrap.
 */
function dedupeByContent<T extends { id: string; created_at?: string }>(
  rows: T[],
  keyOf: (r: T) => string,
): T[] {
  const sorted = [...rows].sort(
    (a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? ''),
  );
  const byKey = new Map<string, T>();
  for (const r of sorted) {
    const key = keyOf(r);
    const canonical = byKey.get(key);
    if (!canonical) {
      byKey.set(key, r);
    } else if (canonical.id !== r.id) {
      // Map the later duplicate onto the surviving canonical row.
      useStore.getState().addIdMapping(r.id, canonical.id);
    }
  }
  return [...byKey.values()];
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
    const before = useStore.getState().transactions;
    const remappedTxIds = before.filter(t => t.account_id === tempId).map(t => t.id);
    s.setTransactions(
      before.map(t => (t.account_id === tempId ? { ...t, account_id: serverId } : t)),
    );
    s.setSubscriptions(
      s.subscriptions.map(sub => (sub.account_id === tempId ? { ...sub, account_id: serverId } : sub)),
    );

    // Persist the temp→server account_id remap to the BACKEND for transactions that
    // were already created on the server with the temp id (e.g. an upload synced the
    // transactions before this account finished reconciling). Without this the
    // server row keeps the temp account_id, which no other device can resolve.
    // Skip rows still queued to create — their create will carry the resolved id,
    // and updating a not-yet-existent row would 404 (harmless, but pointless).
    const after = useStore.getState();
    for (const txId of remappedTxIds) {
      const stillPendingCreate = after.pendingSyncQueue.some(
        q => q.kind === 'transaction.create' &&
             String((q.payload as { recordId?: string }).recordId ?? '') === txId,
      );
      if (!stillPendingCreate) {
        syncWithRetry('transaction.update', { id: txId, data: { account_id: serverId } });
      }
    }
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

// ─── CREDIT CARD STATEMENTS ──────────────────────────────────────────────────

/** Re-derive a card's balance_owing from its newest unpaid/partial statement.
 *  A statement's closing balance already carries forward any prior unpaid
 *  balance, so only the most recent unpaid statement (not the sum of all
 *  unpaid statements) reflects the current amount owing. */
function recomputeCardBalanceLocal(creditCardId: string, paymentAmount?: number): void {
  const s = useStore.getState();
  const newest = s.creditCardStatements
    .filter(st => st.credit_card_id === creditCardId && st.status !== 'paid')
    .sort((a, b) => (b.period_end ?? '').localeCompare(a.period_end ?? ''))[0];
  const owing = newest ? Math.max(0, (newest.closing_balance ?? 0) - (newest.amount_paid ?? 0)) : 0;
  const patch: Partial<CreditCard> = { balance_owing: Math.max(0, owing) };
  if (paymentAmount && paymentAmount > 0) {
    patch.last_payment_amount = paymentAmount;
    patch.last_payment_date = new Date().toISOString().split('T')[0];
  }
  creditCardsDS.update(creditCardId, patch);
}

export const creditCardStatementsDS = {
  getAll(): CreditCardStatement[] {
    return useStore.getState().creditCardStatements;
  },

  /** Statements for a card, newest first. */
  getForCard(creditCardId: string): CreditCardStatement[] {
    return useStore.getState().creditCardStatements
      .filter(st => st.credit_card_id === creditCardId)
      .sort((a, b) => (b.period_end ?? '').localeCompare(a.period_end ?? ''));
  },

  /** Newest unpaid/partial statement for a card, or undefined. */
  newestUnpaid(creditCardId: string): CreditCardStatement | undefined {
    return this.getForCard(creditCardId).find(st => st.status !== 'paid');
  },

  add(data: {
    credit_card_id: string;
    closing_balance: number;
    minimum_payment?: number | null;
    amount_paid?: number;
    status?: CreditCardStatement['status'];
    period_label?: string | null;
    period_start?: string | null;
    period_end?: string | null;
    due_date?: string | null;
    source?: CreditCardStatement['source'];
    currency?: string | null;
  }): CreditCardStatement {
    const record: CreditCardStatement = {
      id: uuid(),
      user_id: uid(),
      credit_card_id: data.credit_card_id,
      period_label: data.period_label ?? null,
      period_start: data.period_start ?? null,
      period_end: data.period_end ?? new Date().toISOString().split('T')[0],
      due_date: data.due_date ?? null,
      closing_balance: data.closing_balance,
      minimum_payment: data.minimum_payment ?? null,
      amount_paid: data.amount_paid ?? 0,
      status: data.status ?? 'unpaid',
      paid_at: data.status === 'paid' ? ts() : null,
      source: data.source ?? 'statement',
      currency: data.currency ?? null,
      created_at: ts(),
      updated_at: ts(),
    };
    const s = useStore.getState();
    s.setCreditCardStatements([record, ...s.creditCardStatements]);

    syncWithRetry('statement.create', {
      recordId: record.id,
      creditCardId: data.credit_card_id,
      data: {
        period_label: record.period_label, period_start: record.period_start,
        period_end: record.period_end, due_date: record.due_date,
        closing_balance: record.closing_balance, minimum_payment: record.minimum_payment,
        amount_paid: record.amount_paid,
        status: record.status, source: record.source, currency: record.currency,
      },
    });

    recomputeCardBalanceLocal(data.credit_card_id);
    return record;
  },

  update(id: string, data: Partial<CreditCardStatement>): void {
    const s = useStore.getState();
    const existing = s.creditCardStatements.find(st => st.id === id);
    if (!existing) return;
    const merged = { ...existing, ...data, updated_at: ts() };
    s.setCreditCardStatements(s.creditCardStatements.map(st => st.id === id ? merged : st));

    syncWithRetry('statement.update', {
      id,
      creditCardId: existing.credit_card_id,
      data,
    });
    recomputeCardBalanceLocal(existing.credit_card_id, data.status === 'paid' ? existing.closing_balance : undefined);
  },

  /** Mark a statement fully paid. */
  markPaid(id: string): void {
    const st = useStore.getState().creditCardStatements.find(s => s.id === id);
    if (!st) return;
    this.update(id, { status: 'paid', amount_paid: st.closing_balance, paid_at: ts() });
  },

  /** Record a partial payment; remaining (closing - paid) stays owing. */
  markPartial(id: string, amountPaid: number): void {
    const st = useStore.getState().creditCardStatements.find(s => s.id === id);
    if (!st) return;
    const paid = amountPaid >= st.closing_balance - 0.01;
    this.update(id, {
      status: paid ? 'paid' : 'partial',
      amount_paid: amountPaid,
      paid_at: paid ? ts() : null,
    });
  },

  /** Fetch older statements (before a given period_end) from the server. */
  async loadOlder(creditCardId: string, before: string): Promise<CreditCardStatement[]> {
    try {
      const older: CreditCardStatement[] = await accountsApi.getStatements(creditCardId, { limit: 12, before });
      const s = useStore.getState();
      s.setCreditCardStatements(mergeById(older, s.creditCardStatements));
      return older;
    } catch {
      return [];
    }
  },
};

/** Record a reconciled payment row for a card (optionally linked to a statement). */
function recordReconciledPayment(cardId: string, amount: number, txId: string, statementId?: string): void {
  const record: PendingPayment = {
    id: uuid(),
    user_id: uid(),
    credit_card_id: cardId,
    amount,
    status: 'reconciled',
    reconciled_transaction_id: txId,
    statement_id: statementId,
    created_at: ts(),
    updated_at: ts(),
  };
  const s = useStore.getState();
  s.setPendingPayments([record, ...s.pendingPayments]);
  syncWithRetry('payment.create', {
    recordId: record.id,
    creditCardId: cardId,
    data: { amount, status: 'reconciled', reconciled_transaction_id: txId, statement_id: statementId },
  });
}

/** Apply a payment amount to a card: tick its newest unpaid statement if one exists,
 *  else reduce the rolling balance directly (legacy fallback). */
export function applyCardPayment(cardId: string, amount: number, txId: string): void {
  const unpaid = creditCardStatementsDS.getForCard(cardId).filter(st => st.status !== 'paid');
  // Prefer the statement whose REMAINING balance matches this payment (within 5%).
  // This lets an out-of-order / older bank payment tick off the right month's
  // statement instead of always hitting the most-recent one.
  const exact = unpaid.find(st => {
    const remaining = (st.closing_balance ?? 0) - (st.amount_paid ?? 0);
    return remaining > 0.01 && Math.abs(remaining - amount) / Math.max(remaining, 0.01) <= 0.05;
  });
  const stmt = exact ?? unpaid[0];
  if (stmt) {
    creditCardStatementsDS.markPartial(stmt.id, (stmt.amount_paid ?? 0) + amount);
    recordReconciledPayment(cardId, amount, txId, stmt.id);
  } else {
    const card = useStore.getState().creditCards.find(c => c.id === cardId);
    if (card) {
      creditCardsDS.update(cardId, {
        balance_owing: Math.max(0, card.balance_owing - amount),
        last_payment_amount: amount,
        last_payment_date: new Date().toISOString().split('T')[0],
      });
    }
    recordReconciledPayment(cardId, amount, txId);
  }
}

function enqueueCcPrompt(p: Omit<CcPaymentPrompt, 'id' | 'created_at'>): void {
  const s = useStore.getState();
  // Don't double-prompt for the same transaction.
  if (s.ccPaymentPrompts.some(q => q.transaction_id === p.transaction_id)) return;
  s.setCcPaymentPrompts([
    { ...p, id: uuid(), created_at: ts() },
    ...s.ccPaymentPrompts,
  ]);
}

export const ccPaymentPromptsDS = {
  getAll(): CcPaymentPrompt[] {
    return useStore.getState().ccPaymentPrompts;
  },
  dismiss(id: string): void {
    const s = useStore.getState();
    s.setCcPaymentPrompts(s.ccPaymentPrompts.filter(p => p.id !== id));
  },
  /** which-card answered: apply the payment to the chosen card, then re-run its flow. */
  resolveWhichCard(promptId: string, cardId: string): void {
    const s = useStore.getState();
    const prompt = s.ccPaymentPrompts.find(p => p.id === promptId);
    if (!prompt) return;
    this.dismiss(promptId);
    const stmt = creditCardStatementsDS.newestUnpaid(cardId);
    if (stmt) {
      applyCardPayment(cardId, prompt.amount, prompt.transaction_id);
    } else {
      enqueueCcPrompt({
        kind: 'whole-amount', transaction_id: prompt.transaction_id,
        merchant: prompt.merchant, amount: prompt.amount, card_id: cardId,
      });
    }
  },
  /** whole-amount answered. wholeAmount=true → statement total is the payment;
   *  else statementTotal supplied and the difference stays owing. */
  resolveWholeAmount(promptId: string, wholeAmount: boolean, statementTotal?: number): void {
    const s = useStore.getState();
    const prompt = s.ccPaymentPrompts.find(p => p.id === promptId);
    if (!prompt || !prompt.card_id) { this.dismiss(promptId); return; }
    const card = s.creditCards.find(c => c.id === prompt.card_id);
    const monthEnd = new Date().toISOString().split('T')[0];
    if (wholeAmount) {
      creditCardStatementsDS.add({
        credit_card_id: prompt.card_id,
        closing_balance: prompt.amount,
        amount_paid: prompt.amount,
        status: 'paid',
        period_end: monthEnd,
        source: 'basiq',
        currency: card?.currency ?? null,
      });
    } else {
      const total = statementTotal ?? prompt.amount;
      creditCardStatementsDS.add({
        credit_card_id: prompt.card_id,
        closing_balance: total,
        amount_paid: prompt.amount,
        status: prompt.amount >= total - 0.01 ? 'paid' : 'partial',
        period_end: monthEnd,
        source: 'basiq',
        currency: card?.currency ?? null,
      });
    }
    recordReconciledPayment(prompt.card_id, prompt.amount, prompt.transaction_id);
    this.dismiss(promptId);
  },
};

// Check an incoming bank transaction against pending payments and statements.
function tryReconcileTransaction(tx: Transaction): void {
  const s = useStore.getState();
  if (tx.account_type !== 'bank') return;
  const txAmount = Math.abs(tx.amount);

  const matchedCards = matchesCreditCardPayment(tx.merchant, s.creditCards);
  if (matchedCards.length === 0) return;

  // 1) Honour an explicit manual pending payment that matches the amount.
  for (const card of matchedCards) {
    const pending = s.pendingPayments
      .filter(p => p.credit_card_id === card.id && p.status === 'pending')
      .filter(p => Math.abs(p.amount - txAmount) / Math.max(p.amount, 0.01) <= 0.05)
      .sort((a, b) => Math.abs(a.amount - txAmount) - Math.abs(b.amount - txAmount));
    if (pending.length > 0) {
      pendingPaymentsDS.reconcile(pending[0].id, tx.id);
      return;
    }
  }

  // 2) Unambiguous card → apply against its newest unpaid statement, or ask
  //    "was this the whole amount?" when there's no statement to tick.
  if (matchedCards.length === 1) {
    const card = matchedCards[0];
    if (creditCardStatementsDS.newestUnpaid(card.id)) {
      applyCardPayment(card.id, txAmount, tx.id);
    } else {
      enqueueCcPrompt({
        kind: 'whole-amount', transaction_id: tx.id,
        merchant: tx.merchant, amount: txAmount, card_id: card.id,
      });
    }
    return;
  }

  // 3) Ambiguous → ask which card this payment belongs to.
  enqueueCcPrompt({
    kind: 'which-card', transaction_id: tx.id,
    merchant: tx.merchant, amount: txAmount,
    candidate_card_ids: matchedCards.map(c => c.id),
  });
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
    const pref = s.user?.currency_preference ?? 'AUD';
    const investments = s.investments.map(inv => {
      // conversion_rate is native → preferred (snapshotted by the backend). All
      // display figures are computed IN THE PREFERRED CURRENCY so profit/loss is
      // value-in-preferred minus cost-in-preferred — never native value mixed
      // with a differently-denominated cost (the old sign-flipping bug).
      // Cash is a plain balance (current_price = balance, shares_owned = 1) with no
      // gain/loss — cost tracks value so P&L is always 0.
      const isCash = inv.asset_type === 'cash';
      const rate = inv.conversion_rate ?? 1;
      const valueNative = inv.shares_owned * inv.current_price;
      const valuePref = parseFloat((valueNative * rate).toFixed(2));

      // cost → preferred, honouring the currency the cost was entered in. Prefer
      // the backend-computed display_cost, which already handles EVERY currency
      // pair (including exotic ones where the cost's currency differs from both the
      // native and preferred currency). Only fall back to a client-side estimate
      // for rows not yet round-tripped through the server (e.g. just-added locally).
      const costCcy = inv.cost_basis_currency || inv.native_currency || pref;
      let costPref: number;
      if (isCash) {
        costPref = valuePref;                                                       // cash: cost == value → P&L 0
      } else if (inv.display_cost != null && inv.display_currency === pref) {
        costPref = inv.display_cost;                                                // trust the server (all pairs)
      } else if (costCcy === pref)              costPref = inv.cost_basis;          // fixed (e.g. AUD historical cost)
      else if (costCcy === inv.native_currency) costPref = parseFloat((inv.cost_basis * rate).toFixed(2));
      else                                      costPref = inv.cost_basis;          // last-resort estimate

      const pl = isCash ? 0 : parseFloat((valuePref - costPref).toFixed(2));
      const plPct = (isCash || costPref === 0) ? 0 : parseFloat(((pl / costPref) * 100).toFixed(4));

      // Today's move: derive the preferred-currency $ change from the price % change
      // since the previous close. Value ∝ price, so value-at-prev-close = valuePref /
      // (1 + pct/100), and today's gain is the difference. Cash never moves.
      const dayPct = isCash ? null : (inv.day_change_percent ?? null);
      const dayChange = dayPct != null
        ? parseFloat((valuePref - valuePref / (1 + dayPct / 100)).toFixed(2))
        : null;

      return {
        ...inv,
        verification: {
          current_value: valueNative,
          profit_loss: pl,
          profit_loss_percent: plPct,
          day_change: dayChange,
          day_change_percent: dayPct,
          is_verified: inv.verification?.is_verified ?? true,
        },
        display_value: valuePref,
        display_cost: costPref,
        display_currency: pref,
      };
    });
    const portfolio_total = investments.reduce((sum, i) => sum + i.display_value, 0);
    return { investments, portfolio_total, portfolio_verified: true };
  },

  add(data: {
    name?: string; ticker?: string; market: string; asset_type: string;
    shares_owned: number; cost_basis: number; native_currency?: string;
    cost_basis_currency?: string; conversion_rate?: number;
    is_dividend_paying?: boolean; current_price?: number;
    acquired_date?: string | null;
  }): Investment {
    const current_price = data.current_price ?? 0;
    // Optimistic FX rate (native → preferred) from the form, so a freshly-added
    // foreign holding shows correct preferred-currency figures immediately rather
    // than raw native numbers until the server round-trip lands.
    const rate = data.conversion_rate ?? 1;
    const valueNative = data.shares_owned * current_price;
    const record: Investment = {
      id: uuid(),
      user_id: uid(),
      name: data.name ?? data.ticker ?? 'Unknown',
      ticker: data.ticker,
      market: data.market,
      asset_type: data.asset_type as Investment['asset_type'],
      shares_owned: data.shares_owned,
      cost_basis: data.cost_basis,
      cost_basis_currency: data.cost_basis_currency ?? data.native_currency ?? 'AUD',
      current_price,
      current_value: valueNative,
      currency: 'AUD',
      native_currency: data.native_currency ?? 'AUD',
      conversion_rate: rate,
      is_dividend_paying: data.is_dividend_paying ?? false,
      created_at: ts(),
      updated_at: ts(),
    };
    const s = useStore.getState();
    s.setInvestments([...s.investments, record]);
    s.setPortfolioTotal(s.portfolioTotal + valueNative * rate);

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
    // Portfolio total is in the preferred currency, so convert each native value.
    const newTotal = updated.reduce((sum, i) => sum + i.current_value * (i.conversion_rate ?? 1), 0);
    s.setPortfolioTotal(newTotal);

    syncWithRetry('investment.update', { id, data });

    return updated.find(i => i.id === id)!;
  },

  // `sold` distinguishes a disposal (keep the holding in the P&L history line) from a
  // genuine delete (scrub it out of history). Defaults to a real delete.
  remove(id: string, sold = false): void {
    const s = useStore.getState();
    const removed = s.investments.find(i => i.id === id);
    s.setInvestments(s.investments.filter(i => i.id !== id));
    if (removed) s.setPortfolioTotal(s.portfolioTotal - removed.current_value * (removed.conversion_rate ?? 1));
    syncWithRetry('investment.delete', { id, sold });
  },
};

// Realised disposals (CGT). The HOLDING change (reduce shares or remove) goes through
// investmentsDS.update / .remove as usual; this only records the sale row. Returns an
// optimistic record the caller can show immediately while the backend round-trip lands.
export const salesDS = {
  record(data: {
    investment_id?: string | null; name: string; ticker?: string | null;
    asset_type?: string | null; market?: string | null;
    quantity: number; proceeds: number; fees: number; cost_basis: number;
    acquired_date?: string | null; sale_date: string; currency?: string;
  }): InvestmentSale {
    const gain = parseFloat((data.proceeds - data.fees - data.cost_basis).toFixed(2));
    const held = data.acquired_date
      ? Math.round((new Date(data.sale_date).getTime() - new Date(data.acquired_date).getTime()) / 86_400_000)
      : null;
    const record: InvestmentSale = {
      id: uuid(),
      user_id: uid(),
      investment_id: data.investment_id ?? null,
      name: data.name,
      ticker: data.ticker ?? null,
      asset_type: data.asset_type ?? null,
      market: data.market ?? null,
      quantity: data.quantity,
      proceeds: data.proceeds,
      fees: data.fees,
      cost_basis: data.cost_basis,
      acquired_date: data.acquired_date ?? null,
      sale_date: data.sale_date,
      gain,
      held_days: held,
      discount_eligible: held != null && held > 365 && gain > 0,
      currency: data.currency ?? 'AUD',
      created_at: ts(),
    };
    syncWithRetry('sale.create', { recordId: record.id, data });
    return record;
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

export function calculateTax(
  hecsEnabled = false,
  overrides?: { total_income?: number; tax_withheld?: number; total_deductions?: number },
) {
  const s = useStore.getState();
  const entries = s.incomeEntries.filter(e => e.status === 'approved');
  // Prefer payslip YTD figures when supplied (they already accumulate the whole
  // FY); otherwise fall back to summing approved income entries.
  const gross_income = overrides?.total_income ?? entries.reduce((sum, e) => sum + e.amount, 0);
  const tax_withheld = overrides?.tax_withheld ?? entries.reduce((sum, e) => sum + (e.tax_withheld ?? 0), 0);

  // Deductions reduce taxable income, which is what tax, Medicare and HECS are
  // all assessed on — so claiming a deduction lowers the estimate and increases
  // any refund. Never let deductions push taxable income below zero.
  const total_deductions = overrides?.total_deductions ?? 0;
  const total_income = Math.max(0, gross_income - total_deductions);

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

/**
 * Estimate total annual Australian tax (income tax + 2% Medicare, optional HECS)
 * for a given taxable income. Standalone version of calculateTax that takes an
 * explicit income — used by the payslip "on track vs heading for a bill" check,
 * which annualises a payslip's gross rather than summing income entries.
 */
export function estimateTaxForIncome(total_income: number, hecsEnabled = false): number {
  const bracket = [...BRACKETS_2024_25].reverse().find(b => total_income >= b.min) ?? BRACKETS_2024_25[0];
  const income_tax = Math.max(0, bracket.base + (total_income - bracket.min) * bracket.rate);
  const medicare_levy = total_income > 26000 ? total_income * 0.02 : 0;

  let hecs_repayment = 0;
  if (hecsEnabled && total_income >= 54435) {
    const hecsRates = [
      { min: 54435,  rate: 0.01 }, { min: 62851,  rate: 0.02 }, { min: 66621, rate: 0.025 },
      { min: 70619,  rate: 0.03 }, { min: 74856,  rate: 0.035 }, { min: 79347, rate: 0.04 },
      { min: 84108,  rate: 0.045 }, { min: 89155, rate: 0.05 }, { min: 94504, rate: 0.055 },
      { min: 100175, rate: 0.06 },
    ];
    const hr = [...hecsRates].reverse().find(r => total_income >= r.min);
    if (hr) hecs_repayment = total_income * hr.rate;
  }
  return income_tax + medicare_levy + hecs_repayment;
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
  update(id: string, data: { name: string; amount: number; category: string; date: string }) {
    const all = deductionsDS.getAll().map((d: { id: string }) => (d.id === id ? { ...d, ...data } : d));
    localStorage.setItem(getDeductionsKey(), JSON.stringify(all));
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
    const current = s.bills.find(b => b.id === id);

    // The first time a bill is renamed, preserve its prior name as original_name
    // so a re-imported original-named bill can later be recognised as a duplicate.
    let patch = data;
    if (
      current &&
      data.name !== undefined &&
      data.name.trim().toLowerCase() !== current.name.trim().toLowerCase() &&
      !current.original_name &&
      data.original_name === undefined
    ) {
      patch = { ...data, original_name: current.name };
    }

    const updated = s.bills.map(b => b.id === id ? { ...b, ...patch, updated_at: ts() } : b);
    s.setBills(updated);

    syncWithRetry('bill.update', { id, data: patch });

    // Keep the linked subscription's name in sync. A recurring bill in Bills &
    // Reminders is the same entity as its row in Subscriptions, so renaming one
    // should rename the other. Newer bills are joined by stable subscription_id;
    // older/imported ones are linked by name — their original (import) name is
    // preserved on the bill as original_name and equals the subscription's anchor.
    const newName = data.name?.trim();
    if (
      current &&
      newName &&
      newName.toLowerCase() !== current.name.trim().toLowerCase()
    ) {
      const subs = s.subscriptions;
      let sub = current.subscription_id
        ? subs.find(x => x.id === current.subscription_id)
        : undefined;

      if (!sub) {
        // Name-based fallback: match on the stable import anchor. The bill's
        // original_name (set the first time it was renamed) holds the import name;
        // before any rename it's still the current name.
        const anchor = (current.original_name ?? current.name).trim().toLowerCase();
        sub = subs.find(x => {
          const subAnchor = (x.original_name ?? x.name).trim().toLowerCase();
          return subAnchor === anchor;
        });
      }

      if (sub) {
        // Snapshot the subscription's import anchor before the first rename so the
        // name link survives subsequent renames (rename() keeps original_name).
        if (!sub.original_name) {
          subscriptionsDS.update(sub.id, { original_name: sub.name });
        }
        subscriptionsDS.rename(sub.id, newName);
      }
    }

    return updated.find(b => b.id === id)!;
  },

  /**
   * Edit a bill/reminder with explicit recurrence scope.
   *  - Non-recurring, OR applyToFuture=true → the new values become canonical
   *    (any prior one-off template is cleared). Future occurrences inherit them.
   *  - Recurring + applyToFuture=false ("just this once") → snapshot the current
   *    canonical series values into recurring_template, then apply the edit only to
   *    the visible occurrence. The next generated occurrence reverts to the
   *    template (see backend pay route / advanceAutoPay).
   * The recurring GENERATION engine is untouched; this only sets a fallback field.
   */
  updateScoped(id: string, data: Partial<Bill>, applyToFuture: boolean): Bill | undefined {
    const current = useStore.getState().bills.find(b => b.id === id);
    if (!current) return undefined;

    if (!current.is_recurring || applyToFuture) {
      return this.update(id, { ...data, recurring_template: null });
    }

    const template = current.recurring_template ?? {
      name: current.name,
      amount: current.amount,
      category: current.category ?? null,
      frequency: current.frequency,
      colour: current.colour,
      kind: current.kind ?? 'bill',
      auto_pay: current.auto_pay,
    };
    return this.update(id, { ...data, recurring_template: template });
  },

  /** Pairs of unpaid bills where the user renamed one (its original_name now
   *  matches another bill's current name and amount) — i.e. a re-imported
   *  original-named bill duplicating one the user already renamed. Returns the
   *  bill to keep (the renamed one) and the likely duplicate (the import). */
  findDuplicates(): { keep: Bill; duplicate: Bill }[] {
    const unpaid = useStore.getState().bills.filter(b => !b.is_paid);
    const out: { keep: Bill; duplicate: Bill }[] = [];
    for (const keep of unpaid) {
      const orig = keep.original_name?.trim().toLowerCase();
      if (!orig) continue;
      const dup = unpaid.find(b =>
        b.id !== keep.id &&
        b.name.trim().toLowerCase() === orig &&
        parseFloat(b.amount.toFixed(2)) === parseFloat(keep.amount.toFixed(2))
      );
      if (dup) out.push({ keep, duplicate: dup });
    }
    return out;
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
   * Resolve every "auto" item whose due date has already passed. Call on app load.
   * An auto item is treated as always-handled-on-time, so it never goes overdue:
   *  - Recurring (bill OR reminder) → roll forward to the next future occurrence
   *    (an auto-pay bill or an auto-complete reminder simply restarts).
   *  - One-off REMINDER → tick itself off (mark complete) and drop into "Recently
   *    completed". This is the reminder equivalent of a bill's auto-pay: it
   *    auto-completes when the date arrives.
   * A one-off *bill* is left untouched — it moves money, so we never mark it paid
   * without the user's own tick.
   */
  advanceAutoPay(): void {
    const s = useStore.getState();
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    let changed = false;
    const updated = s.bills.map(b => {
      if (!b.auto_pay || b.is_paid) return b;
      const due = new Date(b.due_date);
      if (isNaN(due.getTime()) || due >= today) return b;

      // One-off auto reminder → auto tick-off once its date has passed.
      if (!b.is_recurring) {
        if (b.kind !== 'reminder') return b; // never auto-pay a one-off bill
        changed = true;
        const paidAt = new Date().toISOString().split('T')[0];
        syncWithRetry('bill.pay', { id: b.id });
        return { ...b, is_paid: true, paid_at: paidAt, updated_at: ts() };
      }

      // Recurring auto item → roll forward to the next future occurrence.
      let next = due;
      while (next < today) next = nextOccurrence(next, b.frequency);
      changed = true;
      const newDate = next.toISOString().split('T')[0];
      // A one-off ("just this once") edit snapshotted the canonical series values
      // in recurring_template — restore them on the new occurrence and clear it.
      const tmpl = b.recurring_template ?? null;
      const restore: Partial<Bill> = tmpl
        ? { name: tmpl.name ?? b.name, amount: tmpl.amount ?? b.amount, category: tmpl.category ?? b.category, colour: tmpl.colour ?? b.colour, kind: tmpl.kind ?? b.kind, auto_pay: tmpl.auto_pay ?? b.auto_pay }
        : {};
      const patch = { due_date: newDate, ...restore, recurring_template: null };
      syncWithRetry('bill.update', { id: b.id, data: patch });
      return { ...b, ...patch, updated_at: ts() };
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

// ─── LOANS / DEBT ─────────────────────────────────────────────────────────────

export const loansDS = {
  getAll(): Loan[] {
    return useStore.getState().loans;
  },

  add(data: Omit<Loan, 'id' | 'user_id' | 'created_at' | 'updated_at'>): Loan {
    const record: Loan = { ...data, id: uuid(), user_id: uid(), created_at: ts(), updated_at: ts() };
    const s = useStore.getState();
    s.setLoans([...s.loans, record]);
    // The backend mirrors the repayment into a linked bill on create.
    syncWithRetry('loan.create', { recordId: record.id, data });
    return record;
  },

  update(id: string, data: Partial<Loan>): Loan {
    const s = useStore.getState();
    const updated = s.loans.map(l => l.id === id ? { ...l, ...data, updated_at: ts() } : l);
    s.setLoans(updated);
    // The backend re-syncs the linked repayment bill (amount + next due) on update.
    syncWithRetry('loan.update', { id, data });
    return updated.find(l => l.id === id)!;
  },

  remove(id: string): void {
    const s = useStore.getState();
    const loan = s.loans.find(l => l.id === id);
    s.setLoans(s.loans.filter(l => l.id !== id));
    // Remove the mirrored repayment bill from the local store too, so it
    // disappears immediately (the backend deletes it server-side as well).
    // Match by loan_id when present, else fall back to the generated bill name.
    const repaymentName = loan ? `${loan.name} repayment` : null;
    const remaining = s.bills.filter(b =>
      b.loan_id !== id && !(repaymentName && b.category === 'loan' && b.name === repaymentName),
    );
    if (remaining.length !== s.bills.length) s.setBills(remaining);
    // The backend deletes the linked repayment bill alongside the loan.
    syncWithRetry('loan.delete', { id });
  },

  /**
   * Record a repayment: subtract the minimum repayment from the balance and
   * advance next_due_date by one repayment-frequency period. The backend keeps
   * the linked bill's due date in sync via the loan.update.
   */
  markPaid(id: string): Loan | undefined {
    const loan = useStore.getState().loans.find(l => l.id === id);
    if (!loan) return undefined;
    const repayment = loan.minimum_repayment ?? 0;
    const newBalance = Math.max(0, loan.current_balance - repayment);
    let nextDue = loan.next_due_date;
    if (loan.next_due_date) {
      nextDue = nextOccurrence(new Date(loan.next_due_date), loan.repayment_frequency)
        .toISOString().split('T')[0];
    }
    return this.update(id, { current_balance: newBalance, next_due_date: nextDue });
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

// ─── BUDGET PLAN (settings + line items) ──────────────────────────────────────

export const budgetSettingsDS = {
  get(): BudgetSettings | null {
    return useStore.getState().budgetSettings;
  },

  /** Upsert the single per-user settings row. */
  save(data: Partial<Omit<BudgetSettings, 'id' | 'user_id' | 'created_at' | 'updated_at'>>): BudgetSettings {
    const s = useStore.getState();
    const existing = s.budgetSettings;
    const record: BudgetSettings = {
      id: existing?.id ?? uuid(),
      user_id: uid(),
      period: data.period ?? existing?.period ?? 'monthly',
      income_basis: data.income_basis ?? existing?.income_basis ?? 'projected',
      income_amount: data.income_amount ?? existing?.income_amount ?? 0,
      created_at: existing?.created_at ?? ts(),
      updated_at: ts(),
    };
    s.setBudgetSettings(record);
    const { id, user_id, created_at, updated_at, ...payload } = record;
    syncWithRetry('budgetSettings.save', { data: payload });
    return record;
  },
};

export const budgetLinesDS = {
  getAll(): BudgetLine[] {
    return useStore.getState().budgetLines;
  },

  add(data: Omit<BudgetLine, 'id' | 'user_id' | 'created_at' | 'updated_at'>): BudgetLine {
    const record: BudgetLine = { ...data, id: uuid(), user_id: uid(), created_at: ts(), updated_at: ts() };
    const s = useStore.getState();
    s.setBudgetLines([...s.budgetLines, record]);
    const { id, user_id, created_at, updated_at, ...payload } = record;
    syncWithRetry('budgetLine.create', { recordId: record.id, data: payload });
    return record;
  },

  update(id: string, data: Partial<BudgetLine>): BudgetLine {
    const s = useStore.getState();
    const updated = s.budgetLines.map(l => l.id === id ? { ...l, ...data, updated_at: ts() } : l);
    s.setBudgetLines(updated);
    syncWithRetry('budgetLine.update', { id, data });
    return updated.find(l => l.id === id)!;
  },

  remove(id: string): void {
    const s = useStore.getState();
    s.setBudgetLines(s.budgetLines.filter(l => l.id !== id));
    syncWithRetry('budgetLine.delete', { id });
  },
};

// ─── CUSTOM CATEGORIES ────────────────────────────────────────────────────────

export const customCategoriesDS = {
  getAll(): CustomCategory[] {
    return useStore.getState().customCategories;
  },

  /** Names of user-created categories, for merging into the built-in lists. */
  names(): string[] {
    return useStore.getState().customCategories.map(c => c.name);
  },

  add(name: string): CustomCategory | null {
    const clean = name.trim();
    if (!clean) return null;
    const s = useStore.getState();
    // De-dupe (case-insensitive) against what already exists locally.
    const existing = s.customCategories.find(c => c.name.toLowerCase() === clean.toLowerCase());
    if (existing) return existing;
    const record: CustomCategory = { id: uuid(), user_id: uid(), name: clean, created_at: ts(), updated_at: ts() };
    s.setCustomCategories([...s.customCategories, record]);
    syncWithRetry('customCategory.create', { recordId: record.id, data: { name: clean } });
    return record;
  },

  remove(id: string): void {
    const s = useStore.getState();
    s.setCustomCategories(s.customCategories.filter(c => c.id !== id));
    syncWithRetry('customCategory.delete', { id });
  },
};

// ─── NET WORTH ──────────────────────────────────────────────────────────────

export function calculateNetWorth(): NetWorthSnapshot {
  const s = useStore.getState();
  const currency = s.user?.currency_preference ?? 'AUD';

  // Hidden accounts are excluded from net worth (mirrors the super/loan opt-out).
  const bank_balance   = s.accounts.filter(a => !a.hidden).reduce((sum, a) => sum + (a.display_balance ?? a.balance), 0);
  const investments    = s.investments.reduce((sum, i) => sum + (i.display_value ?? i.current_value * (i.conversion_rate ?? 1)), 0);
  const credit_card_debt = s.creditCards.reduce((sum, c) => sum + (c.display_balance_owing ?? c.balance_owing), 0);
  // Display total: every super fund, regardless of the net-worth toggle. The
  // Superannuation card (and Telegram briefing) should always reflect the full
  // super balance — the toggle only governs whether it feeds the net-worth sum.
  const superBalAll    = s.superFunds.reduce((sum, f) => sum + f.balance, 0);
  // Counted total: only funds opted into net worth. Legacy funds saved before
  // this flag existed have it null/undefined — treat those as included.
  const superBalCounted = s.superFunds
    .filter(f => f.include_in_net_worth !== false)
    .reduce((sum, f) => sum + f.balance, 0);

  // Loans count as debt when opted in. Legacy rows without the flag (undefined)
  // are treated as included to match super's opt-out behaviour.
  const loanDebt = s.loans
    .filter(l => l.include_in_net_worth !== false)
    .reduce((sum, l) => sum + (l.current_balance || 0), 0);

  const net_worth = bank_balance + investments + superBalCounted - credit_card_debt - loanDebt;

  const snapshot: NetWorthSnapshot = {
    net_worth:        parseFloat(net_worth.toFixed(2)),
    bank_balance:     parseFloat(bank_balance.toFixed(2)),
    investments:      parseFloat(investments.toFixed(2)),
    credit_card_debt: parseFloat(credit_card_debt.toFixed(2)),
    super:            parseFloat(superBalAll.toFixed(2)),
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
  const local = s.transactions.find(t => t.id === pl.recordId);
  const accountId = local?.account_id ?? (pl.data as { account_id?: string })?.account_id ?? (srv as Transaction).account_id;
  s.setTransactions(s.transactions.map(t =>
    t.id === pl.recordId ? { ...(srv as Transaction), account_id: accountId } : t));

  // The create may have been SENT with a temp account id (a statement upload fires
  // transaction creates immediately, before the new account's id has reconciled).
  // The backend has no idMap to bridge temp→server ids, so the row would be
  // unreachable by per-account queries on other devices. Now that the row exists
  // on the server, correct its account_id if it has since resolved.
  const sent = (pl.data as { account_id?: string })?.account_id;
  const resolved = resolveAccountId(accountId ?? '');
  const serverTxId = (srv as Transaction).id;
  if (serverTxId && resolved && sent && resolved !== sent) {
    syncWithRetry('transaction.update', { id: serverTxId, data: { account_id: resolved } });
  }
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
  // Server returns display_value (preferred currency); fall back to native×rate.
  s.setPortfolioTotal(next.reduce((sum, i) => sum + (i.display_value ?? i.current_value * (i.conversion_rate ?? 1)), 0));
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
  const server = srv as Bill;
  // Persist temp→server id so any queued op that still references the temp id
  // (e.g. a tick-paid fired before this create reconciled) resolves to the real row.
  if (pl.recordId && server.id && pl.recordId !== server.id) {
    s.addIdMapping(pl.recordId as string, server.id);
  }
  s.setBills(s.bills.map(b => b.id === pl.recordId ? server : b));
});

registerSyncSuccess('goal.create', (srv, pl) => {
  const s = useStore.getState();
  s.setGoals(s.goals.map(g => g.id === pl.recordId ? (srv as Goal) : g));
});

/**
 * Pull the server's loan-linked repayment bills into the store. The loan→bill
 * mirror runs SERVER-SIDE after a loan create/update, so the client never learns
 * about the mirrored "<loan> repayment" bill (or its removal when add_to_bills is
 * turned off) until a full bootstrap — which is why a freshly-added loan's bill
 * didn't appear in Bills & Reminders until reload. We replace only the loan-linked
 * bills with the server's authoritative set, leaving every other (non-loan) bill in
 * the store untouched so local/optimistic bill state is never disturbed.
 */
async function refreshLoanBills(): Promise<void> {
  try {
    const serverBills = (await overviewApi.getBills()) as Bill[];
    const s = useStore.getState();
    const serverLoanBills = serverBills.filter(b => b.loan_id);
    const nonLoanLocal = s.bills.filter(b => !b.loan_id);
    s.setBills([...nonLoanLocal, ...serverLoanBills]);
  } catch (err) {
    console.warn('[loan] bill refresh after sync failed:', err);
  }
}

registerSyncSuccess('loan.create', (srv, pl) => {
  const s = useStore.getState();
  const server = srv as Loan;
  // Persist temp→server id so any queued op still referencing the temp id resolves.
  if (pl.recordId && server.id && pl.recordId !== server.id) {
    s.addIdMapping(pl.recordId as string, server.id);
  }
  s.setLoans(s.loans.map(l => l.id === pl.recordId ? server : l));
  // The server may have just mirrored a repayment bill — pull it in now.
  refreshLoanBills();
});

registerSyncSuccess('loan.update', (srv, pl) => {
  const s = useStore.getState();
  s.setLoans(s.loans.map(l => l.id === resolveAccountId(pl.id as string) || l.id === pl.id ? (srv as Loan) : l));
  // An update can add, change, or REMOVE the mirrored repayment bill (e.g. amount/
  // due-date change, or add_to_bills toggled off) — reconcile loan-linked bills.
  refreshLoanBills();
});

registerSyncSuccess('budget.create', (srv, pl) => {
  const s = useStore.getState();
  s.setBudgets(s.budgets.map(b => b.id === pl.recordId ? (srv as Budget) : b));
});

registerSyncSuccess('budgetSettings.save', (srv) => {
  useStore.getState().setBudgetSettings(srv as BudgetSettings);
});

registerSyncSuccess('budgetLine.create', (srv, pl) => {
  const s = useStore.getState();
  s.setBudgetLines(s.budgetLines.map(l => l.id === pl.recordId ? (srv as BudgetLine) : l));
});

registerSyncSuccess('customCategory.create', (srv, pl) => {
  const s = useStore.getState();
  s.setCustomCategories(s.customCategories.map(c => c.id === pl.recordId ? (srv as CustomCategory) : c));
});

registerSyncSuccess('payment.create', (srv, pl) => {
  const s = useStore.getState();
  s.setPendingPayments(s.pendingPayments.map(p => p.id === pl.recordId ? (srv as PendingPayment) : p));
});

registerSyncSuccess('statement.create', (srv, pl) => {
  const s = useStore.getState();
  const server = srv as CreditCardStatement;
  if (pl.recordId && server.id && pl.recordId !== server.id) s.addIdMapping(pl.recordId as string, server.id);
  s.setCreditCardStatements(s.creditCardStatements.map(st => st.id === pl.recordId ? server : st));
});

// ─── BOOTSTRAP ──────────────────────────────────────────────────────────────

// How many months of history we guarantee are loaded instantly on every login.
const RECENT_MONTHS = 3;
// Page size for every paged transaction fetch. Supabase caps a single range
// request at 1000 rows, so this is the largest useful page.
const TX_PAGE = 1000;

/** ISO yyyy-mm-dd for `monthsAgo` months before today (local time). */
function isoMonthsAgo(monthsAgo: number): string {
  const d = new Date();
  d.setMonth(d.getMonth() - monthsAgo);
  return d.toISOString().split('T')[0];
}

/**
 * Fetch every transaction on/after `since` (yyyy-mm-dd), paging through the
 * backend until a short page is returned. Used on bootstrap to always pull the
 * full recent window (default: last RECENT_MONTHS months) regardless of count.
 *
 * The /accounts/transactions endpoint pages at up to 1000 rows, so a power user
 * with thousands of recent transactions still gets the complete window.
 */
async function fetchTransactionsSince(since: string): Promise<Transaction[]> {
  const all: Transaction[] = [];
  for (let offset = 0; ; offset += TX_PAGE) {
    const page = (await accountsApi.getTransactions({ limit: TX_PAGE, offset, since })) as Transaction[];
    if (!page || page.length === 0) break;
    all.push(...page);
    if (page.length < TX_PAGE) break; // last (short) page reached
  }
  return all;
}

// How many older transactions to pull per "Load older" click.
const OLDER_CHUNK = 500;

/**
 * Load OLDER transactions on demand — the next chunk strictly before the oldest
 * transaction currently in the store, regardless of any gaps in history. Returns
 * how many NEW transactions were added; 0 means we've reached the very start of
 * the user's history (no lower date bound is applied, so an empty result is
 * definitive). Backs the "Load older transactions" control in the UI.
 *
 * Note: uses a `before`-EXCLUSIVE cursor on date. In the rare case a single date
 * straddles the boundary, mergeById() dedupes any overlap on the next call.
 */
export async function loadOlderTransactions(): Promise<number> {
  const existing = useStore.getState().transactions;
  // Oldest date we already have; if the store is empty there's nothing to page
  // "before" — bootstrap handles the empty case, so report done.
  const oldest = existing.reduce<string | null>(
    (min, t) => (min === null || t.date < min ? t.date : min),
    null
  );
  if (!oldest) return 0;

  const page = (await accountsApi.getTransactions({
    limit: OLDER_CHUNK, offset: 0, before: oldest,
  })) as Transaction[];
  if (!page || page.length === 0) return 0;

  const countBefore = existing.length;
  const merged = mergeById(page, existing);
  useStore.getState().setTransactions(merged);
  return useStore.getState().transactions.length - countBefore;
}

/**
 * Load all user data from the backend and populate the Zustand store.
 * Call this once after the user logs in to hydrate the app with server data.
 */
export async function bootstrapData(): Promise<void> {
  let s = useStore.getState();

  // ── CROSS-USER GUARD ───────────────────────────────────────────────────────
  // If the data cached in localStorage belongs to a DIFFERENT user than the one
  // now logged in (e.g. a shared device where the previous user never logged out),
  // purge every user-scoped slice + the pending sync queue BEFORE we merge server
  // data or replay any queued writes. Without this, mergeById() would surface the
  // previous user's local-only rows, and retryPendingSync() would replay their
  // queued writes under the new user's token — leaking data across accounts.
  const currentUserId = s.user?.id ?? null;
  if (currentUserId && s.dataOwnerId && s.dataOwnerId !== currentUserId) {
    useStore.setState({
      accounts: [], creditCards: [], transactions: [], subscriptions: [],
      investments: [], superFunds: [], portfolioTotal: 0, incomeEntries: [],
      projectedAnnual: 0, bills: [], goals: [], loans: [], budgets: [], notifications: [],
      budgetSettings: null, budgetLines: [], customCategories: [],
      creditCardStatements: [], ccPaymentPrompts: [],
      netWorth: null, netWorthHistory: [], pendingPayments: [], idMap: {},
      basiqUserId: null, pendingSyncQueue: [], syncToast: null,
    });
  }
  // Stamp the current user as the owner of whatever data we're about to load.
  if (currentUserId) s.setDataOwnerId(currentUserId);
  // Re-read state after the possible purge so the merges below see the clean slate.
  s = useStore.getState();

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
    loansResult,
    budgetsResult,
    budgetSettingsResult,
    budgetLinesResult,
    customCategoriesResult,
  ] = await Promise.allSettled([
    accountsApi.getAccounts(),
    accountsApi.getCreditCards(),
    accountsApi.getSubscriptions(),
    fetchTransactionsSince(isoMonthsAgo(RECENT_MONTHS)),
    investmentsApi.getInvestments(),
    investmentsApi.getSuper(),
    incomeApi.getIncome(),
    overviewApi.getBills(),
    overviewApi.getGoals(),
    overviewApi.getLoans(),
    overviewApi.getBudgets(),
    overviewApi.getBudgetSettings(),
    overviewApi.getBudgetLines(),
    overviewApi.getCustomCategories(),
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
    s.setPendingPayments(mergeServerAuthoritative(payments, s.pendingPayments, 'payment.create'));

    // Load the latest 3 statements per card (older ones lazy-loaded on demand).
    const allStatements = await Promise.allSettled(
      cards.map(c => accountsApi.getStatements(c.id, { limit: 3 }))
    );
    const statements = allStatements
      .filter(r => r.status === 'fulfilled')
      .flatMap(r => (r as PromiseFulfilledResult<CreditCardStatement[]>).value ?? []);
    // NOTE: statements is a WINDOWED fetch (latest 3 per card; older lazy-loaded),
    // so mergeById is correct here — older cached statements are legitimately absent
    // from this response and must be kept, not treated as deleted.
    s.setCreditCardStatements(mergeById(statements, s.creditCardStatements));
  }

  if (accountsResult.status === 'fulfilled') {
    const merged = mergeById((accountsResult.value as BankAccount[]) ?? [], s.accounts);
    // Collapse identical accounts (same bsb+number, or same name+institution).
    const deduped = dedupeByContent(merged, (a) => {
      const bsb = (a.bsb ?? '').trim();
      const num = (a.account_number ?? '').trim();
      if (bsb && num) return `acct:${bsb}|${num}`;
      return `acct:${(a.name ?? '').toLowerCase().trim()}|${(a.institution ?? '').toLowerCase().trim()}`;
    });
    s.setAccounts(deduped);
  } else {
    console.warn('[bootstrapData] accounts failed:', accountsResult.reason);
  }

  if (creditCardsResult.status === 'fulfilled') {
    const mergedCards = mergeById((creditCardsResult.value as CreditCard[]) ?? [], s.creditCards);
    const dedupedCards = dedupeByContent(mergedCards, (c) =>
      `card:${(c.name ?? '').toLowerCase().trim()}|${(c.institution ?? '').toLowerCase().trim()}`,
    );
    s.setCreditCards(dedupedCards);
  } else {
    console.warn('[bootstrapData] creditCards failed:', creditCardsResult.reason);
  }

  if (subscriptionsResult.status === 'fulfilled') {
    s.setSubscriptions(mergeServerAuthoritative((subscriptionsResult.value as Subscription[]) ?? [], s.subscriptions, 'subscription.create'));
  } else {
    console.warn('[bootstrapData] subscriptions failed:', subscriptionsResult.reason);
  }

  if (transactionsResult.status === 'fulfilled') {
    // The server returns the COMPLETE recent window (last RECENT_MONTHS, fully
    // paged), so within that window the server is authoritative. We must drop any
    // locally-cached transaction the server no longer has — otherwise a server-side
    // cleanup (e.g. de-duplication) never reflects on a client that still holds the
    // old rows, because a plain id-merge keeps every local-only row forever.
    //
    // We still protect two kinds of local rows from being dropped:
    //   1. Rows OLDER than the fetched window — the server simply didn't return
    //      them this bootstrap (they load via "Load older transactions").
    //   2. Rows still queued to sync (offline/failed creates) — not yet on the
    //      server by design, so absence doesn't mean deleted.
    const serverTx = (transactionsResult.value as Transaction[]) ?? [];

    if (serverTx.length === 0) {
      // The server returned ZERO in-window transactions. This is ambiguous: it
      // could mean the user genuinely has none, but far more often (esp. on a
      // cold-starting backend) it's a transient empty/partial response. Treating
      // it as authoritative would permanently delete the user's local
      // transactions — the "everything vanished after login" data-loss bug. The
      // safe, local-first choice is to keep whatever we already have untouched.
      console.warn('[bootstrapData] transactions: server returned 0 rows — keeping local cache (not wiping)');
    } else {
      const serverIds = new Set(serverTx.map((t) => t.id));
      const windowStart = isoMonthsAgo(RECENT_MONTHS);
      const pendingTxIds = new Set(
        s.pendingSyncQueue
          .filter((q) => q.kind === 'transaction.create')
          .map((q) => String((q.payload as { recordId?: string }).recordId ?? '')),
      );
      const keptLocal = s.transactions.filter(
        (t) => !serverIds.has(t.id) && (t.date < windowStart || pendingTxIds.has(t.id)),
      );

      // The server is authoritative: always show every transaction it returns. We do
      // NOT second-guess them with an orphan/account-match filter — that historically
      // made transactions silently vanish on login (e.g. a fresh device, or an
      // account-id that hadn't reconciled yet). Duplicate accounts (the original
      // source of orphan transactions) are now prevented at upload time, so there is
      // nothing to filter out here.
      const combined = [...serverTx, ...keptLocal];
      s.setTransactions(combined);
    }
  } else {
    console.warn('[bootstrapData] transactions failed:', transactionsResult.reason);
  }

  if (investmentsResult.status === 'fulfilled') {
    const { investments, next_update } = investmentsResult.value as {
      investments: Investment[]; portfolio_total: number; next_update?: string | null;
    };
    // Investments use a STRICTER merge than mergeById's "keep all local-only".
    // A holding that was created on one device, synced to the server, then had its
    // temp-id → server-id reconcile fail to propagate here leaves a stale temp-id
    // record in this device's localStorage that no server row matches — a phantom
    // duplicate that survives every reload. So we keep a local-only holding ONLY if
    // it still has an unsynced create parked in the retry queue; otherwise we treat
    // it as stale and drop it, letting the authoritative server list stand.
    const serverInv = investments ?? [];
    const serverIds = new Set(serverInv.map(i => i.id));
    const pendingCreateIds = new Set(
      s.pendingSyncQueue
        .filter(q => q.kind === 'investment.create')
        .map(q => String((q.payload as { recordId?: string }).recordId ?? '')),
    );
    const localOnlyToKeep = s.investments.filter(l => {
      if (serverIds.has(l.id)) return false;            // server version replaces it
      if (serverIds.has(resolveAccountId(l.id))) return false; // same row via idMap
      return pendingCreateIds.has(l.id);                // keep only genuinely-unsynced
    });
    const merged = [...serverInv, ...localOnlyToKeep];
    s.setInvestments(merged);
    // Recompute the total locally so any kept local-only holdings are included.
    // Use the preferred-currency display value (native value × conversion rate).
    s.setPortfolioTotal(merged.reduce((sum, i) => sum + i.current_value * (i.conversion_rate ?? 1), 0));
    s.setInvestmentsNextUpdate(next_update ?? null);
  } else {
    console.warn('[bootstrapData] investments failed:', investmentsResult.reason);
  }

  if (superResult.status === 'fulfilled') {
    s.setSuperFunds(mergeServerAuthoritative((superResult.value as SuperFund[]) ?? [], s.superFunds, 'super.create'));
  } else {
    console.warn('[bootstrapData] super failed:', superResult.reason);
  }

  if (incomeResult.status === 'fulfilled') {
    const { entries } = incomeResult.value as {
      entries: IncomeEntry[]; projected_annual: number;
    };
    // Merge keeps local-only entries (genuine offline creates not yet synced),
    // but a local TEMP-id copy of an entry that since synced under a new server id
    // would otherwise live on forever as a phantom duplicate on that device only
    // (the "same payslip shows on phone but not computer" bug). So after merging,
    // drop any local-only row whose content matches a row the server returned —
    // the server row is authoritative. Genuinely unsynced locals are preserved.
    const serverEntries = (entries ?? []) as IncomeEntry[];
    const serverIds = new Set(serverEntries.map(e => e.id));
    const contentKey = (e: IncomeEntry) =>
      `${e.source}|${e.amount}|${e.date}|${e.category}|${e.reference_number ?? ''}`;
    const serverKeys = new Set(serverEntries.map(contentKey));
    const merged = mergeById(serverEntries, s.incomeEntries)
      .filter(e => serverIds.has(e.id) || !serverKeys.has(contentKey(e)));
    s.setIncomeEntries(merged);
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
    const merged: Bill[] = mergeServerAuthoritative(serverBills, localBills, 'bill.create').map(b => {
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
    s.setGoals(mergeServerAuthoritative((goalsResult.value as Goal[]) ?? [], s.goals, 'goal.create'));
  } else {
    console.warn('[bootstrapData] goals failed:', goalsResult.reason);
  }

  if (loansResult.status === 'fulfilled') {
    s.setLoans(mergeServerAuthoritative((loansResult.value as Loan[]) ?? [], s.loans, 'loan.create'));
  } else {
    console.warn('[bootstrapData] loans failed:', loansResult.reason);
  }

  if (budgetsResult.status === 'fulfilled') {
    s.setBudgets(mergeServerAuthoritative((budgetsResult.value as Budget[]) ?? [], s.budgets, 'budget.create'));
  } else {
    console.warn('[bootstrapData] budgets failed:', budgetsResult.reason);
  }

  // Budget plan: settings is server-authoritative when present; keep any local
  // unsynced settings only if the server has none yet.
  if (budgetSettingsResult.status === 'fulfilled') {
    const srv = budgetSettingsResult.value as BudgetSettings | null;
    if (srv) s.setBudgetSettings(srv);
  } else {
    console.warn('[bootstrapData] budget settings failed:', budgetSettingsResult.reason);
  }

  if (budgetLinesResult.status === 'fulfilled') {
    // Budget lines & custom categories are only ever created online (no offline
    // create queue), so the server list is fully authoritative.
    s.setBudgetLines(mergeServerAuthoritative((budgetLinesResult.value as BudgetLine[]) ?? [], s.budgetLines, 'budgetline.create'));
  } else {
    console.warn('[bootstrapData] budget lines failed:', budgetLinesResult.reason);
  }

  if (customCategoriesResult.status === 'fulfilled') {
    s.setCustomCategories(mergeServerAuthoritative((customCategoriesResult.value as CustomCategory[]) ?? [], s.customCategories, 'customcategory.create'));
  } else {
    console.warn('[bootstrapData] custom categories failed:', customCategoriesResult.reason);
  }


  // Replay any writes that failed to reach Supabase in a previous session.
  retryPendingSync();

  // ── Reconcile transaction ⇄ account links ──────────────────────────────────
  // Persisted transactions may reference a stale temp/local UUID after the account
  // was re-synced with a fresh server UUID. Remap them onto the correct account
  // where we can. We NEVER drop a transaction that fails to match: on a fresh
  // device (cleared localStorage) the temp→server idMap is gone, so many server
  // transactions carry orphan account_ids that can't be resolved — dropping them
  // would make a user's entire history vanish even though it's safely in the DB.
  // Unmatched transactions stay visible in the all-transactions list.
  reconcileTransactionLinks();

  // A second reconciliation pass after a short delay, so any late-arriving
  // accounts/cards (background id swaps) get relinked once they're in the store.
  setTimeout(() => reconcileTransactionLinks(), 2000);
}

/**
 * Align every transaction's account_id with a known account/card where possible.
 * Matching order: primary id → central idMap → secondary (localId/serverId) →
 * account name/institution. Transactions that still can't be matched are ALWAYS
 * kept (never dropped) so a user's history can never disappear from the UI just
 * because an account link couldn't be resolved.
 */
function reconcileTransactionLinks(): void {
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

    // Unmatched: keep it visible. A later pass (or a future account re-link)
    // may resolve it, but it must never be removed from the user's history.
    reconciled.push(t);
  }

  if (remapped > 0) {
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
  available_funds?: number | null;
  bsb: string | null;
  account_number: string | null;
  currency: string;
  /** 'basiq_sandbox' for the Hooli test institution (AU00000), else 'basiq'. */
  source?: string;
  is_manual: false;
}

export interface BasiqCreditCard {
  basiq_account_id: string;
  name: string;
  institution: string;
  balance_owing: number;
  credit_limit: number;
  currency: string;
  source?: string;
  is_manual: false;
}

export interface BasiqLoan {
  basiq_account_id: string;
  name: string;
  loan_type: 'mortgage' | 'personal';
  lender: string;
  current_balance: number;
  original_amount: number;
  currency: string;
  source?: string;
  is_manual: false;
}

/** Per-sync counts the backend reports so the UI never treats an empty account
 *  sync as success just because transactions imported. */
export interface BasiqAccountCounts {
  returned: number;
  bankAccounts: number;
  creditCards: number;
  loans: number;
  rejected: number;
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

export interface BasiqBusinessDetails {
  businessName: string;
  businessIdNo: string;
  businessIdNoType?: 'ABN' | 'ACN';
  businessAddress: {
    addressLine1: string;
    suburb: string;
    state: string;
    postcode: string;
  };
}

/** Outcome of a full Basiq sync, shared by the manual button and the auto-sync
 *  scheduler. `text`/`type` feed the Accounts page's status banner directly. */
export type BasiqSyncResult =
  | { status: 'ok'; text: string; type: 'success' | 'error' }
  | { status: 'reconnect' }
  | { status: 'consent_expired' }
  | { status: 'error'; text: string };

// Auto-sync scheduler state (module-level so it survives page navigation in the
// SPA and can never start twice). last-sync time is persisted in localStorage so
// a fresh tab only auto-syncs when the data is actually stale (> 1h old).
const BASIQ_AUTOSYNC_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const BASIQ_LAST_SYNC_KEY = 'ledger_basiq_last_sync';
let _basiqAutoSyncTimer: ReturnType<typeof setInterval> | null = null;
let _basiqSyncInFlight = false;

function basiqLastSyncAt(): number {
  const raw = localStorage.getItem(BASIQ_LAST_SYNC_KEY);
  const n = raw ? Number(raw) : 0;
  return Number.isFinite(n) ? n : 0;
}

export const basiqDS = {
  /** Fetch the authenticated user's stored Basiq user id from the DB (source of truth). */
  async me(): Promise<string | null> {
    const res = await fetch(`${API_BASE}/api/basiq/me`, {
      headers: { Authorization: `Bearer ${useStore.getState().token ?? ''}` },
    });
    if (!res.ok) throw new Error(`Basiq /me failed: HTTP ${res.status}`);
    const { basiqUserId } = await res.json() as { basiqUserId: string | null };
    return basiqUserId;
  },

  /** Clear the stored Basiq user id for the authenticated user (temporary reset). */
  async disconnect(): Promise<void> {
    const res = await fetch(`${API_BASE}/api/basiq/disconnect`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${useStore.getState().token ?? ''}` },
    });
    if (!res.ok) throw new Error(`Basiq disconnect failed: HTTP ${res.status}`);
  },

  /** Create a Basiq user and return the consent URL to open in a new tab. */
  async connect(
    email: string,
    mobile: string,
    business?: BasiqBusinessDetails,
  ): Promise<{ basiqUserId: string; authLink: string }> {
    const res = await fetch(`${API_BASE}/api/basiq/connect`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${useStore.getState().token ?? ''}`,
      },
      body: JSON.stringify({ email, mobile, business }),
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
    loans?: BasiqLoan[];
    counts?: BasiqAccountCounts;
    rejected?: Array<{ id: string; status: string; reason: string }>;
  }> {
    const res = await fetch(`${API_BASE}/api/basiq/accounts?userId=${encodeURIComponent(basiqUserId)}`, {
      headers: { Authorization: `Bearer ${useStore.getState().token ?? ''}` },
    });
    if (!res.ok) {
      const detail = await res.json().catch(() => ({})) as { error?: string; requiresReconnect?: boolean };
      // The stored Basiq user no longer exists (deleted / sharing revoked). The
      // backend has already cleared the link; signal the UI to reconnect.
      if (detail.requiresReconnect) throw new Error('requires_reconnect');
      if (detail.error === 'consent_expired') throw new Error('consent_expired');
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
      const detail = await res.json().catch(() => ({})) as { error?: string; requiresReconnect?: boolean };
      if (detail.requiresReconnect) throw new Error('requires_reconnect');
      if (detail.error === 'consent_expired') throw new Error('consent_expired');
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

  /**
   * Pull live accounts, cards and transactions from Basiq and merge them into the
   * store. Store-driven (reads/writes via useStore.getState()) so it works both
   * from the Accounts page button and the background scheduler — no component
   * state required. Returns a result the UI can render as a status banner.
   *
   * Fixes the "transactions land in the wrong account" bug: the Basiq→local id
   * map now covers BOTH bank accounts AND credit cards, each transaction takes
   * its account_type from the account it actually belongs to (not a hardcoded
   * 'bank'), and any previously mis-filed transactions are healed on the next
   * sync so they finally appear under the right account.
   */
  async syncAll(): Promise<BasiqSyncResult> {
    const basiqUserId = useStore.getState().basiqUserId;
    if (!basiqUserId) return { status: 'error', text: 'Not connected' };
    if (_basiqSyncInFlight) return { status: 'error', text: 'Sync already in progress' };
    _basiqSyncInFlight = true;
    try {
      const { bankAccounts: liveBankAccounts, creditCards: liveCreditCards, loans: liveLoans = [], counts, rejected } =
        await this.fetchAccounts(basiqUserId);

      console.log('[basiq] sync: accounts returned by Basiq =', counts?.returned ?? '?',
        '· bank =', liveBankAccounts.length, '· credit =', liveCreditCards.length,
        '· loans =', liveLoans.length,
        '· rejected =', counts?.rejected ?? 0, rejected?.length ? rejected : '');

      const userId = useStore.getState().user?.id ?? 'local';

      // ── Merge loans / mortgages ──────────────────────────────────────────
      // Mortgage/loan-class Basiq accounts are liabilities and belong in the
      // Loans section. Dedupe on basiq_account_id so re-syncs update in place.
      const liveLoanBasiqIds = new Set(liveLoans.map(l => l.basiq_account_id));
      let insertedLoans = 0;
      for (const live of liveLoans) {
        const existing = useStore.getState().loans.find(l => l.basiq_account_id === live.basiq_account_id);
        if (existing) {
          // Only refresh the live-owned fields; keep user edits (original_amount,
          // interest_rate, repayment schedule, name) intact.
          loansDS.update(existing.id, {
            current_balance: live.current_balance,
            lender: live.lender,
            source: live.source,
          });
        } else {
          insertedLoans++;
          loansDS.add({
            name: live.name,
            loan_type: live.loan_type,
            lender: live.lender,
            original_amount: live.original_amount,
            current_balance: live.current_balance,
            repayment_frequency: 'monthly',
            basiq_account_id: live.basiq_account_id,
            source: live.source,
          } as Omit<Loan, 'id' | 'user_id' | 'created_at' | 'updated_at'>);
        }
      }

      // Heal double-counting: an earlier sync (before loan routing existed) may
      // have filed this mortgage as a BANK ACCOUNT. Drop any bank account whose
      // basiq_account_id now belongs to a loan, so the debt isn't counted as an
      // asset as well.
      const misfiledAsAccount = useStore.getState().accounts.filter(
        a => a.basiq_account_id && liveLoanBasiqIds.has(a.basiq_account_id),
      );
      for (const a of misfiledAsAccount) accountsDS.remove(a.id);
      if (misfiledAsAccount.length) {
        console.log(`[basiq] sync: moved ${misfiledAsAccount.length} mis-filed loan(s) out of bank accounts`);
      }

      // ── Merge bank accounts ──────────────────────────────────────────────
      const mergedAccounts: BankAccount[] = [...useStore.getState().accounts];
      let insertedAccounts = 0;
      for (const live of liveBankAccounts) {
        const idx = mergedAccounts.findIndex(a =>
          a.basiq_account_id === live.basiq_account_id ||
          (live.source !== 'basiq_sandbox' &&
            a.bsb && a.account_number && a.bsb === live.bsb && a.account_number === live.account_number)
        );
        const liveNorm = {
          ...live,
          bsb: live.bsb ?? undefined,
          account_number: live.account_number ?? undefined,
          available_funds: live.available_funds ?? undefined,
        };
        if (idx >= 0) {
          mergedAccounts[idx] = {
            ...mergedAccounts[idx], ...liveNorm,
            id: mergedAccounts[idx].id,
            user_id: mergedAccounts[idx].user_id,
            updated_at: new Date().toISOString(),
          } as BankAccount;
        } else {
          insertedAccounts++;
          mergedAccounts.push({
            ...liveNorm,
            id: crypto.randomUUID(),
            user_id: userId,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          } as BankAccount);
        }
      }
      useStore.getState().setAccounts(mergedAccounts);

      // ── Merge credit cards ───────────────────────────────────────────────
      const mergedCards: CreditCard[] = [...useStore.getState().creditCards];
      for (const live of liveCreditCards) {
        const idx = mergedCards.findIndex(c => c.basiq_account_id === live.basiq_account_id);
        if (idx >= 0) {
          mergedCards[idx] = {
            ...mergedCards[idx], ...live,
            id: mergedCards[idx].id,
            user_id: mergedCards[idx].user_id,
            updated_at: new Date().toISOString(),
          } as CreditCard;
        } else {
          mergedCards.push({
            ...live,
            id: crypto.randomUUID(),
            user_id: userId,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          } as CreditCard);
        }
      }
      useStore.getState().setCreditCards(mergedCards);

      // ── Basiq account id → local account, covering banks AND cards ───────
      const metaByBasiqId = new Map<string, { localId: string; type: 'bank' | 'credit_card' }>();
      for (const a of mergedAccounts) {
        if (a.basiq_account_id) metaByBasiqId.set(a.basiq_account_id, { localId: a.id, type: 'bank' });
      }
      for (const c of mergedCards) {
        if (c.basiq_account_id) metaByBasiqId.set(c.basiq_account_id, { localId: c.id, type: 'credit_card' });
      }

      // ── Heal previously mis-filed transactions ───────────────────────────
      // Older syncs filed card transactions under the raw Basiq account id and
      // hardcoded account_type 'bank', so they never showed under the card (or
      // the account). Any transaction still keyed by a raw Basiq id is remapped
      // to its real local account + correct type here, retroactively fixing them.
      let healed = 0;
      for (const t of useStore.getState().transactions) {
        const m = metaByBasiqId.get(t.account_id);
        if (m && (t.account_id !== m.localId || t.account_type !== m.type)) {
          transactionsDS.update(t.id, { account_id: m.localId, account_type: m.type });
          healed++;
        }
      }
      if (healed > 0) console.log(`[basiq] sync: healed ${healed} mis-filed transaction(s)`);

      // ── Fetch & merge transactions (best-effort) ─────────────────────────
      let newTxnCount = 0;
      let txnError = false;
      try {
        const liveTxns = await this.fetchTransactions(basiqUserId);
        const existingBasiqIds = new Set(
          useStore.getState().transactions.map(t => t.basiq_tx_id).filter(Boolean)
        );
        const newTxns = liveTxns.filter(t => !existingBasiqIds.has(t.basiq_tx_id));
        for (const t of newTxns) {
          const m = metaByBasiqId.get(t.account_id);
          transactionsDS.add({
            account_id: m?.localId ?? t.account_id,
            account_type: m?.type ?? 'bank',
            date: t.date,
            merchant: t.merchant,
            amount: t.amount,
            currency: t.currency,
            category: t.category ?? autoCategory(t.merchant),
            is_duplicate_flagged: false,
            is_subscription: false,
            basiq_tx_id: t.basiq_tx_id,
          });
        }
        useStore.getState().setPendingPayments(pendingPaymentsDS.getAll());
        newTxnCount = newTxns.length;
      } catch {
        txnError = true;
      }

      localStorage.setItem(BASIQ_LAST_SYNC_KEY, String(Date.now()));

      // ── Build result banner ──────────────────────────────────────────────
      const totalAccounts = liveBankAccounts.length + liveCreditCards.length + liveLoans.length;
      if (totalAccounts === 0) {
        const rejectedNote = counts?.rejected ? ` (${counts.rejected} rejected as unavailable)` : '';
        return {
          status: 'ok',
          type: 'error',
          text: `No bank accounts returned by Basiq yet${rejectedNote}. `
            + `${!txnError ? `${newTxnCount} transaction${newTxnCount !== 1 ? 's' : ''} imported. ` : ''}`
            + `If you just connected, the bank may still be retrieving accounts — try Sync again in a moment.`,
        };
      }
      const parts = [
        `${liveBankAccounts.length} account${liveBankAccounts.length !== 1 ? 's' : ''} synced`,
        liveCreditCards.length ? `${liveCreditCards.length} card${liveCreditCards.length !== 1 ? 's' : ''}` : null,
        liveLoans.length ? `${liveLoans.length} loan${liveLoans.length !== 1 ? 's' : ''}` : null,
        insertedAccounts ? `${insertedAccounts} new account${insertedAccounts !== 1 ? 's' : ''} added` : null,
        insertedLoans ? `${insertedLoans} new loan${insertedLoans !== 1 ? 's' : ''} added` : null,
        !txnError ? `${newTxnCount} new transaction${newTxnCount !== 1 ? 's' : ''}` : 'transactions unavailable',
      ].filter(Boolean);
      return { status: 'ok', type: 'success', text: parts.join(' · ') };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Sync failed';
      if (msg === 'requires_reconnect') return { status: 'reconnect' };
      if (msg === 'consent_expired') return { status: 'consent_expired' };
      return { status: 'error', text: msg };
    } finally {
      _basiqSyncInFlight = false;
    }
  },

  /**
   * Start the background hourly auto-sync. Idempotent — safe to call from every
   * page mount; the timer is created once and lives for the SPA session. Runs an
   * immediate catch-up sync if the last sync was more than an hour ago (or never),
   * then every hour while the app stays open. Silently no-ops whenever the user
   * isn't connected; a `requires_reconnect`/`consent_expired` result stops the
   * timer so we don't hammer a dead connection (the Accounts page drives recovery).
   */
  startAutoSync(): void {
    if (_basiqAutoSyncTimer) return;

    const tick = async (force = false) => {
      if (!useStore.getState().basiqUserId) return;      // not connected → skip
      if (_basiqSyncInFlight) return;                    // a manual sync is running
      if (!force && Date.now() - basiqLastSyncAt() < BASIQ_AUTOSYNC_INTERVAL_MS) return;
      try {
        const r = await this.syncAll();
        if (r.status === 'reconnect' || r.status === 'consent_expired') {
          console.warn('[basiq] auto-sync paused —', r.status);
          this.stopAutoSync();
        } else if (r.status === 'ok') {
          console.log('[basiq] auto-sync:', r.text);
        }
      } catch (e) {
        console.warn('[basiq] auto-sync tick failed:', e instanceof Error ? e.message : e);
      }
    };

    _basiqAutoSyncTimer = setInterval(() => { void tick(); }, BASIQ_AUTOSYNC_INTERVAL_MS);
    // Kick off a catch-up on start if data is already stale (non-blocking).
    void tick();
  },

  /** Stop the background auto-sync timer (e.g. on disconnect or dead consent). */
  stopAutoSync(): void {
    if (_basiqAutoSyncTimer) { clearInterval(_basiqAutoSyncTimer); _basiqAutoSyncTimer = null; }
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
