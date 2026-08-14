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
  Merchant, MerchantAlias, TransactionRule, RuleCondition, RuleAction,
  RecurringSeries, RecurringKind, TransactionSplit, ReviewReason,
} from '../types';
import { verifyInvestment } from '../utils/investmentVerification';
import { autoCategory, getDisplayTimeZone } from '../utils/format';
import {
  buildCashFlowForecast,
  type RecurringInput,
  type AccountBalanceInput,
  type CashFlowForecast,
  type ForecastFrequency,
} from '../utils/cashFlowForecast';
import {
  stampIngest, findTransferMatch, classifyDuplicate, CC_PAYMENT_PATTERNS,
  resolveTransferSiblings,
} from '../utils/transactionCore';
import { classifyTransaction } from '../utils/transactionClassify';
import { planCorrection, type CorrectionMatch } from '../utils/corrections';
import { resolveMerchant, merchantMatchToken } from '../utils/merchantResolution';
import { normaliseMerchant, isTransferMerchant, type RecurringPattern } from '../utils/recurringDetection';
import { classifyRefund } from '../utils/refundMatching';
import { isTransactionReconciled, linkedCardPayments, buildCardPaymentLeg } from '../utils/cardPaymentReconciliation';
import {
  selectAiFallbackCandidates, toAiClassifyItem, planAiSuggestion, needsAiFallback,
} from '../utils/aiClassification';
import { mergeCategories } from '../utils/categories';
import { getReviewCutoff } from '../utils/reviewCutoff';
import {
  addManualDeduction,
  updateManualDeduction,
  removeManualDeduction,
  setDeductionLink,
  dismissDuplicate,
  type ManualDeduction,
  type NewManualDeduction,
} from '../utils/taxDeductions';
import { matchRule, type RuleCandidate } from '../utils/transactionRules';
import { validateSplits, type SplitLineInput } from '../utils/transactionSplits';
import {
  seriesFromPattern, occurrenceIdsForSeries, isSuggestionSuppressed, seriesKey,
} from '../utils/recurringSeries';
import { classifyManualAgainstSync, manualAdjustment } from '../utils/reconcile';
import type { TransactionSource } from '../types';
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
 * Build the Phase 2B classification context from the current store: the user's
 * merchants, aliases, rules and custom-category names. Read once per ingest so a
 * batch import sees a stable snapshot.
 */
/**
 * Ids currently being classified by the AI fallback. Module-level so two
 * concurrent triggers (e.g. an import auto-run + a manual button press) can never
 * send the same transaction to the model twice. Cleared when each pass settles.
 */
const aiInFlight = new Set<string>();

/**
 * Debounced trigger for the AI fallback. Every ingest path (manual / statement /
 * Basiq) calls this when it stamps an uncertain row; the debounce coalesces a
 * whole batch import — ingested in one synchronous loop — into a SINGLE AI call a
 * moment later, instead of one call per row. Guarded for non-DOM (test) envs.
 */
let _aiFallbackTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleAiFallback(): void {
  if (typeof setTimeout === 'undefined') return;
  if (_aiFallbackTimer) clearTimeout(_aiFallbackTimer);
  _aiFallbackTimer = setTimeout(() => {
    _aiFallbackTimer = null;
    void transactionsDS.runAiFallback().catch(() => {});
  }, 1500);
}

function classifyContext() {
  const s = useStore.getState();
  return {
    merchants: s.merchants,
    aliases: s.merchantAliases,
    rules: s.transactionRules,
    customCategories: s.customCategories.map(c => c.name),
    userId: s.user?.id ?? null,
  };
}

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

// ─── TRANSACTION CREATE-RESPONSE RECONCILIATION (Phase 2A/2C persistence) ─────
//
// When a locally-created transaction's `transaction.create` succeeds, the server
// returns the row it just inserted — but that row reflects ONLY the create
// payload. Classification that runs AFTER add() (transfer / refund / review, and
// any category inheritance) lives solely on the local row until its own
// transaction.update lands, so the create response is a STALE subset. Overwriting
// the local row with it drops that metadata — the bug where a matched refund's
// badge flashes and then vanishes a moment later.
//
// The fields below are the ones a post-add() this.update() can set. They are also
// exactly the fields whose diff we must re-send to the server under the real id
// (the original update targeted the local id, which the server never had).
export const POST_CREATE_META_FIELDS: (keyof Transaction)[] = [
  'transaction_type', 'refund_of', 'review_status', 'review_reason',
  'confidence', 'category', 'category_source', 'is_transfer',
  'transfer_pair_id', 'merchant_id',
];

/**
 * Merge a create RESPONSE into the local row without losing post-create metadata.
 * The local row is the fullest picture, so it wins for data; only the server-owned
 * identity/timestamps are adopted (the id changes local→server on insert).
 */
export function mergeCreatedTransaction(
  local: Transaction | undefined,
  server: Transaction,
  accountId: string,
): Transaction {
  const base = local ?? server;
  return {
    ...base,
    id: server.id,
    account_id: accountId,
    user_id: server.user_id ?? base.user_id,
    created_at: server.created_at ?? base.created_at,
    updated_at: server.updated_at ?? base.updated_at,
  };
}

/**
 * The metadata the create payload could NOT carry: every POST_CREATE_META_FIELD
 * whose local value is meaningful and differs from what was actually sent. A plain
 * purchase (no post-add classification) yields an empty object → no extra write.
 */
export function postCreateMetadataDiff(
  local: Transaction,
  sentData: Partial<Transaction>,
): Partial<Transaction> {
  const meta: Record<string, unknown> = {};
  for (const k of POST_CREATE_META_FIELDS) {
    const v = local[k];
    if (v !== undefined && v !== null && v !== sentData[k]) meta[k as string] = v;
  }
  return meta as Partial<Transaction>;
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

// CC_PAYMENT_PATTERNS now lives in transactionCore (single source of truth,
// shared with the canonical spend/transfer logic) and is imported above.

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

    // Settle STATEMENT-AUTHORITATIVELY: tick the matching/newest unpaid statement so
    // the reduction survives a recompute; only fall back to a direct balance_owing
    // reduce when the card has no statement. (A bare direct reduce here used to be
    // clobbered back to the old owing on the next statement-derived recompute.)
    const unpaid = creditCardStatementsDS.getForCard(payment.credit_card_id).filter(st => st.status !== 'paid');
    const exact = unpaid.find(st => {
      const remaining = (st.closing_balance ?? 0) - (st.amount_paid ?? 0);
      return remaining > 0.01 && Math.abs(remaining - payment.amount) / Math.max(remaining, 0.01) <= 0.05;
    });
    const stmt = exact ?? unpaid[0];

    const updated = s.pendingPayments.map(p =>
      p.id === paymentId
        ? { ...p, status: 'reconciled' as const, reconciled_transaction_id: transactionId,
            statement_id: stmt?.id ?? p.statement_id, updated_at: ts() }
        : p
    );
    s.setPendingPayments(updated);
    clearCardPaymentReview(transactionId);

    if (stmt) {
      creditCardStatementsDS.markPartial(stmt.id, (stmt.amount_paid ?? 0) + payment.amount);
    } else {
      const card = s.creditCards.find(c => c.id === payment.credit_card_id);
      if (card) {
        creditCardsDS.update(payment.credit_card_id, {
          balance_owing: Math.max(0, card.balance_owing - payment.amount),
          last_payment_amount: payment.amount,
          last_payment_date: new Date().toISOString().split('T')[0],
        });
      }
    }

    syncWithRetry('payment.update', {
      id: paymentId,
      creditCardId: payment.credit_card_id,
      data: { status: 'reconciled', reconciled_transaction_id: transactionId, statement_id: stmt?.id ?? payment.statement_id },
    });
    // Represent the settled payment as a bank→card transfer pair (both histories,
    // excluded from spend). Balance was already reduced above — this is display-only.
    linkCardPaymentTransfer(transactionId, payment.credit_card_id, payment.amount);
  },

  /** Delete a payment record entirely (local + server). Used when reversing a
   *  reconciled card payment whose bank transaction is being deleted. */
  remove(id: string): void {
    const s = useStore.getState();
    const payment = s.pendingPayments.find(p => p.id === id);
    s.setPendingPayments(s.pendingPayments.filter(p => p.id !== id));
    if (payment) syncWithRetry('payment.delete', { id, creditCardId: payment.credit_card_id });
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

/**
 * Represent a confirmed card payment as a linked bank→card transfer PAIR — the same
 * shape the Transfer button produces. The bank transaction becomes the out-leg
 * (stamped as an internal transfer) and a new card-side in-leg is created, both
 * sharing one `transfer_pair_id`, so the payment shows in BOTH histories and is
 * excluded from spend/income.
 *
 * REPRESENTATIONAL ONLY: the card's balance_owing was already reduced by the
 * statement / direct-owing path (the single balance authority), so the card leg
 * never moves a balance — see buildCardPaymentLeg (positive amount, source
 * 'unknown' so it's outside manualAdjustment). Idempotent on the bank-leg stamp.
 */
function linkCardPaymentTransfer(bankTxId: string, cardId: string, amount: number): void {
  const s = useStore.getState();
  const bankTx = s.transactions.find(t => t.id === bankTxId);
  if (!bankTx || !Number.isFinite(amount) || Math.abs(amount) < 0.01) return;

  const pairId = bankTx.transfer_pair_id ?? uuid();
  // Stamp the bank leg as an internal transfer (idempotent) — a card payment is a
  // movement of money, never spending.
  if (!bankTx.is_transfer || bankTx.transaction_type !== 'transfer' || !bankTx.transfer_pair_id) {
    transactionsDS.update(bankTxId, {
      is_transfer: true, transaction_type: 'transfer', transfer_pair_id: pairId,
    });
  }

  const bankAcc = accountsDS.getAll().find(a => accountIdMatches(bankTx.account_id, a));
  const card = creditCardsDS.getAll().find(c => accountIdMatches(cardId, c));
  const fromName = bankAcc?.name || bankAcc?.institution || 'account';
  const currency = card?.currency ?? bankTx.currency ?? 'AUD';

  // Add the card-side leg. add() never moves a balance and won't re-trigger
  // reconciliation (credit-card leg; tryReconcileTransaction bails on non-bank).
  transactionsDS.add(buildCardPaymentLeg({
    cardId, amount: Math.abs(amount), pairId, fromName, date: bankTx.date, currency,
  }));
}

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
  clearCardPaymentReview(txId);
}

/**
 * Reduce what's owed on a card by `amount`, STATEMENT-AUTHORITATIVE. If the card has
 * an unpaid statement, tick it off with `markPartial` (preserving its closing_balance
 * total and re-deriving balance_owing from it) so the reduction SURVIVES a re-sync /
 * refresh recompute — the bug behind a card that reverts to its old owing. Only when
 * there is no statement do we fall back to reducing the rolling balance_owing directly.
 * Records the settled amount as a reconciled PendingPayment linked to `bankTxId` (the
 * delete-reversal path keys off this). Does NOT create the bank/card transfer legs —
 * the caller owns leg representation (applyCardPayment / createTransfer differ there).
 */
function settleCardStatement(cardId: string, amount: number, bankTxId: string): void {
  const unpaid = creditCardStatementsDS.getForCard(cardId).filter(st => st.status !== 'paid');
  // Prefer the statement whose REMAINING balance matches this payment (within 5%),
  // so an out-of-order / older payment ticks the right month instead of the newest.
  const exact = unpaid.find(st => {
    const remaining = (st.closing_balance ?? 0) - (st.amount_paid ?? 0);
    return remaining > 0.01 && Math.abs(remaining - amount) / Math.max(remaining, 0.01) <= 0.05;
  });
  const stmt = exact ?? unpaid[0];
  if (stmt) {
    creditCardStatementsDS.markPartial(stmt.id, (stmt.amount_paid ?? 0) + amount);
    recordReconciledPayment(cardId, amount, bankTxId, stmt.id);
  } else {
    const card = useStore.getState().creditCards.find(c => c.id === cardId);
    if (card) {
      creditCardsDS.update(cardId, {
        balance_owing: Math.max(0, card.balance_owing - amount),
        last_payment_amount: amount,
        last_payment_date: new Date().toISOString().split('T')[0],
      });
    }
    recordReconciledPayment(cardId, amount, bankTxId);
  }
}

/**
 * A confirmed card-payment relationship resolves any pending review on the bank
 * transaction: we now know exactly what it is, so it leaves the Needs Review queue
 * and is never re-questioned. No-op when the transaction isn't awaiting review, so
 * this never disturbs an already-clear record.
 */
function clearCardPaymentReview(txId: string): void {
  const tx = useStore.getState().transactions.find(t => t.id === txId);
  if (tx && tx.review_status === 'needs_review') {
    transactionsDS.update(txId, { review_status: 'reviewed', review_reason: null });
  }
}

/** Add `amount` back onto a card's owing (display in lockstep) — the inverse of a
 *  direct-balance payment that reduced it. */
function bumpCardOwing(cardId: string, amount: number): void {
  const card = useStore.getState().creditCards.find(c => c.id === cardId);
  if (!card) return;
  const rate = card.conversion_rate ?? 1;
  creditCardsDS.update(cardId, {
    balance_owing: (card.balance_owing ?? 0) + amount,
    display_balance_owing: (card.display_balance_owing ?? card.balance_owing ?? 0) + amount * rate,
  });
}

/**
 * Reverse every confirmed card payment settled by a bank transaction, undoing its
 * effect the same way it was applied so the card is no longer falsely marked paid:
 *   • statement-linked → roll the statement's amount_paid back down (which
 *     re-derives the card balance); a fully-reversed statement returns to 'unpaid'.
 *   • direct-balance   → add the amount back onto balance_owing.
 * The reconciled payment record itself is then removed. Returns how many payments
 * were reversed. Pure-data reversal — the transaction is deleted separately.
 */
function reverseCardPaymentsForTx(txId: string): number {
  const payments = linkedCardPayments(txId, useStore.getState().pendingPayments);
  for (const p of payments) {
    const stmt = p.statement_id
      ? useStore.getState().creditCardStatements.find(st => st.id === p.statement_id)
      : undefined;
    if (stmt) {
      const restored = Math.max(0, (stmt.amount_paid ?? 0) - p.amount);
      if (restored <= 0.01) {
        creditCardStatementsDS.update(stmt.id, { status: 'unpaid', amount_paid: 0, paid_at: null });
      } else {
        creditCardStatementsDS.markPartial(stmt.id, restored);
      }
    } else {
      bumpCardOwing(p.credit_card_id, p.amount);
    }
    pendingPaymentsDS.remove(p.id);
  }
  // Remove the representational card-side leg(s) of this payment. The owing was
  // already rolled back above, so this is a plain balance-free delete (found via
  // the bank transaction's transfer_pair_id). No-op for legacy payments that
  // predate the transfer-pair representation.
  if (payments.length > 0) {
    const s = useStore.getState();
    const pairId = s.transactions.find(t => t.id === txId)?.transfer_pair_id;
    if (pairId) {
      for (const leg of s.transactions.filter(t => t.transfer_pair_id === pairId && t.account_type === 'credit_card')) {
        transactionsDS.remove(leg.id);
      }
    }
  }
  return payments.length;
}

/** Apply a bank transaction's payment to a card: settle it against the card's
 *  statement (authoritative, survives recompute) and represent it as a bank→card
 *  transfer pair so it shows in both histories and is excluded from spend/income. */
export function applyCardPayment(cardId: string, amount: number, txId: string): void {
  settleCardStatement(cardId, amount, txId);
  linkCardPaymentTransfer(txId, cardId, amount);
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
    // Represent it as a bank→card transfer pair (both histories, spend-excluded).
    linkCardPaymentTransfer(prompt.transaction_id, prompt.card_id, prompt.amount);
    this.dismiss(promptId);
  },
};

// Check an incoming bank transaction against pending payments and statements.
function tryReconcileTransaction(tx: Transaction): void {
  const s = useStore.getState();
  if (tx.account_type !== 'bank') return;
  // A transfer leg is an EXPLICIT movement (incl. a Transfer-button card payment,
  // which settles the card itself). Never auto-detect it as a card payment — that
  // would double-apply when its merchant ("Transfer to <card>") matches the card.
  if (tx.is_transfer || tx.transfer_pair_id) return;
  // Already-confirmed card payment — auto-applied earlier or resolved by the user
  // in the popup. The relationship is persisted as a reconciled payment, so never
  // re-apply it or re-raise the popup for the same transaction (e.g. on a Basiq
  // re-sync that re-ingests the row).
  if (isTransactionReconciled(tx.id, s.pendingPayments)) return;
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

/**
 * Move a bank account's or credit card's balance by `delta` (in the account's
 * own currency), keeping the rendered `display_*` figure in lockstep. `delta` is
 * expressed as "money into the account is positive":
 *   • bank card → `balance += delta`            (money in raises the balance)
 *   • credit card → `balance_owing -= delta`    (money in = a repayment, lowers owing)
 * This is the single place both the manual-add reversal and the transfer engine
 * use, so every balance move stays consistent with net worth (Σ bank.balance −
 * Σ card.balance_owing). Unknown account types are ignored.
 */
function moveOwnerBalance(accountId: string, accountType: string, delta: number): void {
  if (!Number.isFinite(delta) || delta === 0) return;
  if (accountType === 'bank') {
    const acc = accountsDS.getAll().find(a => accountIdMatches(accountId, a));
    if (acc) {
      const rate = acc.conversion_rate ?? 1;
      accountsDS.update(acc.id, {
        balance: (acc.balance ?? 0) + delta,
        display_balance: (acc.display_balance ?? acc.balance ?? 0) + delta * rate,
      });
    }
  } else if (accountType === 'credit_card') {
    const card = creditCardsDS.getAll().find(c => accountIdMatches(accountId, c));
    if (card) {
      const rate = card.conversion_rate ?? 1;
      creditCardsDS.update(card.id, {
        balance_owing: (card.balance_owing ?? 0) - delta,
        display_balance_owing: (card.display_balance_owing ?? card.balance_owing ?? 0) - delta * rate,
      });
    }
  }
}

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

  /**
   * CANONICAL ingestion entry point (Phase 2A). Every new-transaction path —
   * manual, statement PDF, Basiq — should funnel through here so that source,
   * raw data, duplicate identity, and transfers are handled ONE way.
   *
   * Pipeline: stamp source/raw_description/merchant_normalized/content_hash →
   * exact/content-hash duplicate check → persist → transfer matching. It builds
   * on the existing local-first add() (offline queue + reconciliation preserved)
   * and does NOT do merchant/rules/AI/recurring work — that is Phase 2B.
   */
  ingest(
    input: Omit<Transaction, 'id' | 'user_id' | 'created_at' | 'updated_at' | 'merchant_normalized' | 'content_hash'> & {
      source: TransactionSource;
    },
    opts: {
      allowDuplicate?: boolean;
      /**
       * Shared across one import batch to make duplicate detection
       * MULTIPLICITY-aware: two genuinely-distinct same-day/same-amount/
       * same-merchant purchases in one statement both survive, while a full
       * re-import of that statement adds nothing. Pass the SAME Map for every
       * transaction in a single upload.
       */
      batchState?: Map<string, number>;
    } = {},
  ): { status: 'added' | 'transfer' | 'duplicate' | 'refund' | 'review'; transaction?: Transaction; duplicateOf?: Transaction } {
    const existing = useStore.getState().transactions;

    // 1. Stamp foundation fields without ever destroying raw source data.
    const stamped = stampIngest({
      merchant: input.merchant,
      amount: input.amount,
      raw_description: input.raw_description ?? null,
      source: input.source,
      source_ref: input.source_ref ?? input.basiq_tx_id ?? null,
      category: input.category,
      category_source: input.category_source,
      user_id: uid(),
      account_id: input.account_id,
      date: input.date,
    });

    // 2. Duplicate classification. content_hash is dedup EVIDENCE, not a unique
    //    financial-event id: a provider ref is strict identity, and an imported
    //    line is never suppressed by a manual entry (see classifyDuplicate).
    const decision = classifyDuplicate(
      {
        source: input.source,
        content_hash: stamped.content_hash,
        basiq_tx_id: input.basiq_tx_id,
        source_ref: stamped.source_ref,
      },
      existing,
      { allowDuplicate: opts.allowDuplicate, batchState: opts.batchState },
    );
    if (decision.isDuplicate) return { status: 'duplicate', duplicateOf: decision.duplicateOf };

    // 2.5 CLASSIFY (Phase 2B): merchant recognition + rules + category taxonomy.
    //     Runs for EVERY path (manual/statement/basiq) so classification is one
    //     way. Explicit user values (category_source==='user') are preserved by
    //     the classifier's priority order; it never rewrites raw_description.
    const cls = classifyTransaction(
      {
        merchant: input.merchant,
        raw_description: stamped.raw_description,
        amount: input.amount,
        account_id: input.account_id,
        source: input.source,
        category: input.category,
        category_source: input.category_source,
        tags: input.tags,
        entity: input.entity,
        is_tax_deductible: input.is_tax_deductible,
        transaction_type: input.transaction_type,
      },
      classifyContext(),
    );

    // 3. Persist through the existing local-first add(). A cross-source content
    //    collision is preserved but flagged for later review — never dropped.
    const record = this.add({
      ...input,
      merchant: cls.merchant,
      category: cls.category,
      category_source: cls.category_source,
      confidence: cls.confidence,
      merchant_id: cls.merchant_id,
      tags: cls.tags,
      entity: cls.entity,
      is_tax_deductible: cls.is_tax_deductible,
      transaction_type: cls.transaction_type ?? input.transaction_type,
      is_duplicate_flagged: input.is_duplicate_flagged ?? false,
      is_subscription: input.is_subscription ?? false,
      source: stamped.source,
      source_ref: stamped.source_ref ?? input.basiq_tx_id ?? null,
      raw_description: stamped.raw_description,
      merchant_normalized: stamped.merchant_normalized,
      content_hash: stamped.content_hash,
      review_status: input.review_status ?? decision.reviewFlag ?? 'clear',
      // A cross-source content collision is an ambiguous duplicate; a low-confidence
      // classification is an uncertain merchant/category. Explicit input wins.
      review_reason: input.review_reason
        ?? (decision.reviewFlag ? 'ambiguous_duplicate'
          : (cls.confidence != null && cls.confidence < 0.4 ? 'uncertain_merchant' : null)),
    });

    // 4. Conservative transfer matching against prior transactions. When a
    //    high-confidence counter-leg exists (bank→bank / bank→savings /
    //    bank→credit-card repayment), pair both legs so neither counts as spend.
    const tm = findTransferMatch(record, existing);
    if (tm && !tm.counterparty.is_transfer && !tm.counterparty.transfer_pair_id) {
      const pairId = uuid();
      // Reliably detected → also stamp transaction_type='transfer' on both legs
      // (this is a detection, not a guess). Other event types stay NULL in 2A.
      this.update(record.id, { is_transfer: true, transfer_pair_id: pairId, transaction_type: 'transfer' });
      this.update(tm.counterparty.id, { is_transfer: true, transfer_pair_id: pairId, transaction_type: 'transfer' });
      record.is_transfer = true;
      record.transfer_pair_id = pairId;
      record.transaction_type = 'transfer';
      return { status: 'transfer', transaction: record };
    }

    // 5. Conservative refund matching (Phase 2C). Only a POSITIVE inflow that
    //    isn't already income/transfer is a refund candidate. A confident match
    //    stamps transaction_type='refund' + refund_of and inherits the original
    //    purchase's category so it NETS that category's spend; an ambiguous or
    //    over-refund case goes to Needs Review; otherwise it's left untouched (an
    //    ordinary inflow, excluded from spend, never counted as income).
    if (record.amount > 0 && !record.transaction_type) {
      const refund = classifyRefund(record, existing);
      if (refund.status === 'matched') {
        const patch: Partial<Transaction> = {
          transaction_type: 'refund',
          refund_of: refund.original.id,
          category: refund.original.category,
          confidence: refund.confidence,
          review_status: 'clear',
          review_reason: null,
        };
        this.update(record.id, patch);
        Object.assign(record, patch);
        return { status: 'refund', transaction: record };
      }
      if (refund.status === 'review') {
        const patch: Partial<Transaction> = { review_status: 'needs_review', review_reason: 'possible_refund' };
        this.update(record.id, patch);
        Object.assign(record, patch);
        return { status: 'review', transaction: record };
      }
    }

    // Phase 2D.3: the deterministic engine couldn't confidently place this row —
    // schedule the AI fallback (debounced, so a batch import = one call).
    if (needsAiFallback(record)) scheduleAiFallback();

    return { status: 'added', transaction: record };
  },

  /**
   * LEARN FROM CORRECTIONS (Phase 2B).
   *
   * Apply a user's merchant/category correction to a transaction with an explicit
   * SCOPE — the corrected row is always updated (category_source='user',
   * confidence 1.0); what else happens depends on scope:
   *
   *   'only'     — just this transaction. Creates NO rule/alias. (Default: we do
   *                NOT silently turn every edit into a permanent rule.)
   *   'future'   — also create a user RULE (category) and/or user MERCHANT ALIAS
   *                (merchant) keyed on this transaction's normalised merchant, so
   *                FUTURE matching transactions classify the same way.
   *   'existing' — everything 'future' does, PLUS retro-apply to already-stored
   *                transactions sharing the same normalised merchant that the user
   *                hasn't hand-set. Only ever run when explicitly requested.
   *
   * Rules/aliases created here are USER-scoped (user_id set), so they never affect
   * another user.
   */
  applyCorrection(
    id: string,
    changes: {
      merchant?: string;
      category?: string;
      tags?: string[];
      entity?: 'business' | 'personal';
      is_tax_deductible?: boolean;
      transaction_type?: Transaction['transaction_type'];
    },
    scope: 'only' | 'future' | 'existing' = 'only',
  ): void {
    const tx = useStore.getState().transactions.find(t => t.id === id);
    if (!tx) return;

    // 1. Always update the corrected transaction. A category/merchant the user
    //    picks is explicit → category_source 'user', full confidence.
    const patch: Partial<Transaction> = {};
    if (changes.merchant !== undefined) patch.merchant = changes.merchant;
    if (changes.category !== undefined) {
      patch.category = changes.category;
      patch.category_source = 'user';
      patch.confidence = 1;
    }
    if (changes.tags !== undefined) patch.tags = changes.tags;
    if (changes.entity !== undefined) patch.entity = changes.entity;
    if (changes.is_tax_deductible !== undefined) patch.is_tax_deductible = changes.is_tax_deductible;
    if (changes.transaction_type !== undefined) patch.transaction_type = changes.transaction_type;
    if (Object.keys(patch).length) this.update(id, patch);

    if (scope === 'only') return;

    // 2. Persist the learning so it covers EVERY transaction from this merchant,
    //    not just this one line. Resolve the merchant to a broad brand token
    //    (contains-match across all store/online variants); fall back to the exact
    //    normalised key only when the merchant isn't recognised.
    const raw = tx.raw_description || tx.merchant || '';
    const norm = tx.merchant_normalized || normaliseMerchant(raw);
    const ctx = classifyContext();
    const res = resolveMerchant(raw, { merchants: ctx.merchants, aliases: ctx.aliases, userId: ctx.userId });
    const token = merchantMatchToken(res, raw);
    const match: CorrectionMatch = token
      ? { type: 'contains', pattern: token }
      : { type: 'normalized', pattern: norm };

    const plan = planCorrection(
      match,
      { merchant: changes.merchant, category: changes.category, entity: changes.entity },
      scope,
      { merchantDefaultCategory: res?.defaultCategory ?? undefined },
    );

    let merchantId: string | null = null;
    if (plan.merchant) {
      const merchant = merchantsDS.upsertUserMerchant(plan.merchant);
      merchantId = merchant?.id ?? null;
      if (plan.alias && merchantId) {
        merchantAliasesDS.addUserAlias({ merchant_id: merchantId, pattern: plan.alias.pattern, match_type: plan.alias.match_type });
      }
    }
    if (plan.rule) {
      // Merge into the existing learned rule for this merchant, never duplicate.
      transactionRulesDS.upsertLearned(plan.rule);
    }

    // 3. 'existing' only: retro-apply to ALL matching rows (same breadth as the
    //    learned rule) that the user hasn't hand-set.
    if (plan.applyToExisting && plan.match.pattern) {
      const matchesTx = (t: Transaction): boolean => {
        if (plan.match.type === 'contains') {
          return (t.raw_description || t.merchant || '').toUpperCase().includes(plan.match.pattern.toUpperCase());
        }
        return (t.merchant_normalized || normaliseMerchant(t.raw_description || t.merchant || '')) === plan.match.pattern;
      };
      const affected = useStore.getState().transactions.filter(t => t.id !== id && matchesTx(t));
      for (const t of affected) {
        const p: Partial<Transaction> = {};
        // Category / merchant re-filing skips rows the user hand-set (category_source
        // 'user') — those are deliberate and must never be overwritten by a rule.
        if (t.category_source !== 'user') {
          if (changes.merchant !== undefined) { p.merchant = changes.merchant; if (merchantId) p.merchant_id = merchantId; }
          if (changes.category !== undefined) { p.category = changes.category; p.category_source = 'rule'; p.confidence = 0.9; }
        }
        // Business/personal has no per-row "hand-set" source to protect, so an
        // explicit "apply to matching existing" stamps it across every match —
        // including rows whose category the user set by hand.
        if (changes.entity !== undefined) p.entity = changes.entity;
        if (Object.keys(p).length) this.update(t.id, p);
      }
    }
  },

  /**
   * Manually mark or unmark a pair of transactions as an internal transfer.
   * Wiring for a future UI; the data model already supports it in Phase 2A.
   */
  setTransferPair(aId: string, bId: string, isTransfer: boolean): void {
    const pairId = isTransfer ? uuid() : null;
    const type = isTransfer ? 'transfer' : null;
    this.update(aId, { is_transfer: isTransfer, transfer_pair_id: pairId, transaction_type: type });
    this.update(bId, { is_transfer: isTransfer, transfer_pair_id: pairId, transaction_type: type });
  },

  // ── Needs Review queue actions (Phase 2C) ──────────────────────────────────
  // A transaction flagged review_status='needs_review' can be:
  //   confirm  → it's correct as-is; clear the flag (review_status='reviewed').
  //   dismiss  → it's fine / not worth reviewing; clear the flag likewise.
  //   correct  → the user fixes merchant/category/type; routes through the SAME
  //              Phase 2B learning (applyCorrection) so it improves future
  //              classification, then the item is marked reviewed.
  // (confirm and dismiss both mark 'reviewed' — the difference is intent; neither
  // deletes anything. The reason is cleared so it leaves the queue.)

  /** Confirm a reviewed transaction is correct — clears the review flag. */
  confirmReview(id: string): void {
    this.update(id, { review_status: 'reviewed', review_reason: null });
  },

  /** Dismiss a review item without changes — clears the review flag. */
  dismissReview(id: string): void {
    this.update(id, { review_status: 'reviewed', review_reason: null });
  },

  /**
   * Clear the entire current Needs Review backlog in one action — every
   * transaction presently flagged 'needs_review' is marked 'reviewed' (same as
   * dismissing each individually). This does NOT change go-forward behaviour:
   * newly-added transactions the engine is unsure about will still be flagged
   * and reappear here. Returns how many were cleared.
   */
  dismissAllReview(): number {
    const pending = useStore.getState().transactions.filter(t => t.review_status === 'needs_review');
    for (const t of pending) this.update(t.id, { review_status: 'reviewed', review_reason: null });
    return pending.length;
  },

  /**
   * Correct a review item: apply the user's fix through the Phase 2B learning
   * system (so it also improves future matching per the chosen scope), then mark
   * the item reviewed. A special case: correcting to transaction_type='refund'
   * with an explicit `refundOf` links it to the original purchase so it nets
   * spend — the manual counterpart of automatic refund matching.
   */
  correctReview(
    id: string,
    changes: {
      merchant?: string; category?: string;
      transaction_type?: Transaction['transaction_type']; refundOf?: string;
    },
    scope: 'only' | 'future' | 'existing' = 'only',
  ): void {
    const { refundOf, ...learnable } = changes;
    this.applyCorrection(id, learnable, scope);
    const patch: Partial<Transaction> = { review_status: 'reviewed', review_reason: null };
    if (changes.transaction_type === 'refund' && refundOf) patch.refund_of = refundOf;
    this.update(id, patch);
  },

  // ── Phase 2D.3: AI classification FALLBACK ─────────────────────────────────
  /**
   * Ask Claude to classify the transactions the deterministic engine left
   * uncertain, and persist its suggestions. This is a strict fallback:
   *   • Only rows that pass `needsAiFallback` are ever sent (deterministic
   *     user/rule/merchant/provider/keyword all failed → source 'auto', low
   *     confidence, not already AI-classified). See utils/aiClassification.ts.
   *   • Each row is sent at most once — `aiInFlight` blocks concurrent double
   *     sends, and `ai_classified_at` (persisted) blocks re-asking on reload.
   *   • The suggestion NEVER overrides a user/rule category: `planAiSuggestion`
   *     returns null (and we skip) if the row became user/rule-sourced while the
   *     model was thinking.
   *   • A failed/empty AI response is a no-op — the rows just stay uncertain and
   *     can be retried later; ingestion is never blocked.
   *
   * Suggestions are surfaced in Needs Review for the user to confirm/correct.
   * Returns how many rows were sent and how many suggestions were applied.
   */
  async runAiFallback(opts: { limit?: number } = {}): Promise<{ requested: number; applied: number }> {
    const s = useStore.getState();
    // Respect the "Clear all" cutoff: only rows added since it get sent to AI.
    const cutoff = getReviewCutoff(s.user?.id);
    const candidates = selectAiFallbackCandidates(s.transactions, { inFlight: aiInFlight, limit: opts.limit, cutoff });
    if (!candidates.length) return { requested: 0, applied: 0 };

    const ids = candidates.map(c => c.id);
    ids.forEach(id => aiInFlight.add(id));

    const customCats = s.customCategories.map(c => c.name);
    const categories = mergeCategories(customCats); // built-ins + user's own
    const currency = s.user?.currency_preference ?? 'AUD';

    let applied = 0;
    try {
      const { results } = await overviewApi.aiClassify({
        transactions: candidates.map(toAiClassifyItem),
        categories,
        currency,
      });
      const byId = new Map((results ?? []).map(r => [r.id, r]));
      for (const c of candidates) {
        const suggestion = byId.get(c.id);
        if (!suggestion) continue;
        // Re-read: the user may have edited/categorised the row while the model
        // was thinking. planAiSuggestion refuses to overwrite a user/rule source.
        const current = useStore.getState().transactions.find(t => t.id === c.id);
        if (!current) continue;
        const patch = planAiSuggestion(current, suggestion, { customCategories: customCats });
        if (!patch) continue;
        this.update(c.id, patch);
        applied++;
      }
    } catch (err) {
      console.warn('[dataService] AI fallback failed:', (err as Error)?.message);
    } finally {
      ids.forEach(id => aiInFlight.delete(id));
    }
    return { requested: candidates.length, applied };
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

  /**
   * Delete a transaction AND undo its effect on the owning account/card balance —
   * the exact mirror of the manual-add path in Accounts.tsx. Adding money in
   * raised `balance`; deleting it must lower it again (and vice-versa), so the
   * displayed figure stays truthful the instant something is removed.
   *
   *   • bank/savings → `balance -= amount`  (money-in was +, money-out was −)
   *   • credit card  → `balance_owing += amount`  (a charge is a negative amount
   *                     that raised owing; removing it lowers owing again)
   *
   * We move the `display_*` field in lockstep (× conversion_rate) because that's
   * what every balance readout actually renders. On a Basiq-linked account this
   * is optimistic: the next sync re-anchors to the bank figure + manualAdjustment.
   * Loans (tracked separately) and orphaned rows fall back to a plain remove.
   *
   * Internal transfers are atomic: deleting one leg also removes the paired leg
   * and undoes ITS balance move, so net worth stays neutral (reversing only one
   * side would shift net worth by the transfer amount).
   *
   * Use this for user-initiated deletes. Flows that manage the balance themselves
   * (reconcile resolutions, "Use bank data") keep calling plain `remove`.
   */
  removeAndReverseBalance(id: string): void {
    const s = useStore.getState();
    const tx = s.transactions.find(t => t.id === id);
    if (tx && Number.isFinite(tx.amount)) {
      // Undo this leg's balance effect. The add moved balance by +amount
      // (bank) / owing by −amount (card); moveOwnerBalance(−amount) reverses both.
      moveOwnerBalance(tx.account_id, tx.account_type, -tx.amount);
      // A CARD PAYMENT's card-side leg is balance-neutral: its owing is owned by the
      // statement / direct-owing path and is reversed separately (reverseCardPayment).
      // When deleting the bank leg of a card payment, remove that card leg but DON'T
      // also reverse its balance here — that would double-reverse the owing. A genuine
      // Transfer-button bank→card transfer has no reconciled payment, so this stays
      // inactive and its card leg is balance-reversed as before.
      const isCardPayment = linkedCardPayments(id, s.pendingPayments).length > 0;
      // Internal transfers are stored as paired legs sharing a transfer_pair_id —
      // take every counter-leg down with this one (resolved purely, works from
      // either side) so neither account keeps an orphan half-transfer. A missing
      // pair returns [] → this is just a safe single-row delete.
      for (const sib of resolveTransferSiblings(id, s.transactions)) {
        const balanceOwnedElsewhere = isCardPayment && sib.account_type === 'credit_card';
        if (!balanceOwnedElsewhere && Number.isFinite(sib.amount)) {
          moveOwnerBalance(sib.account_id, sib.account_type, -sib.amount);
        }
        this.remove(sib.id);
      }
    }
    this.remove(id);
  },

  /**
   * If a bank transaction settled a credit card, summarise that confirmed payment
   * so the delete flow can ask whether to reverse it too. Returns null when the
   * transaction isn't linked to any reconciled card payment.
   */
  cardPaymentFor(txId: string): { bankTxId: string; amount: number; cardName: string } | null {
    const s = useStore.getState();
    // The id passed might be the CARD-side leg of a payment (deleting from the card
    // page) — resolve it to the bank transaction that actually settled the card, so
    // the reversal operates on the record that owns the statement/owing rollback.
    let bankTxId = txId;
    if (linkedCardPayments(bankTxId, s.pendingPayments).length === 0) {
      const leg = s.transactions.find(t => t.id === txId);
      const pairId = leg?.transfer_pair_id;
      if (leg?.account_type === 'credit_card' && pairId) {
        const bankLeg = s.transactions.find(t =>
          t.transfer_pair_id === pairId && t.account_type === 'bank' &&
          linkedCardPayments(t.id, s.pendingPayments).length > 0,
        );
        if (bankLeg) bankTxId = bankLeg.id;
      }
    }
    const linked = linkedCardPayments(bankTxId, s.pendingPayments);
    if (linked.length === 0) return null;
    const total = linked.reduce((sum, p) => sum + p.amount, 0);
    const card = s.creditCards.find(c => c.id === linked[0].credit_card_id);
    return { bankTxId, amount: total, cardName: card?.name ?? 'a credit card' };
  },

  /** Reverse the credit-card payment(s) a bank transaction settled (undo the card's
   *  paid status), for when that transaction is being deleted. Returns the count. */
  reverseCardPayment(txId: string): number {
    return reverseCardPaymentsForTx(txId);
  },

  /**
   * Create an internal transfer between two of the user's own accounts/cards as
   * TWO linked legs — money out of the source, money into the destination — so
   * the transfer is net-worth-neutral by construction and neither leg counts as
   * spend or income. Recording only one side (the old single-transaction path)
   * would wrongly move net worth by the transfer amount; this moves both balances
   * at once. Both legs share a `transfer_pair_id` and `transaction_type:'transfer'`
   * so the existing exclusion logic already treats them as internal movement.
   *
   * Balance math (X = amount > 0): source loses X, destination gains X. Net worth
   * = Σ bank.balance − Σ card.balance_owing, so the two moves cancel to exactly 0.
   */
  createTransfer(input: {
    fromId: string; fromType: 'bank' | 'credit_card';
    toId: string;   toType: 'bank' | 'credit_card';
    amount: number; date: string; note?: string;
  }): void {
    const X = Math.abs(input.amount);
    if (!Number.isFinite(X) || X < 0.01) return;
    if (input.fromId === input.toId) return;

    const bankById = (id: string) => accountsDS.getAll().find(a => accountIdMatches(id, a));
    const cardById = (id: string) => creditCardsDS.getAll().find(c => accountIdMatches(id, c));
    const nameOf = (id: string, type: 'bank' | 'credit_card') => {
      if (type === 'bank') { const a = bankById(id); return a?.name || a?.institution || 'account'; }
      const c = cardById(id); return c?.name || c?.institution || 'card';
    };
    const currencyOf = (id: string, type: 'bank' | 'credit_card') =>
      (type === 'bank' ? bankById(id)?.currency : cardById(id)?.currency) ?? 'AUD';

    const fromName = nameOf(input.fromId, input.fromType);
    const toName = nameOf(input.toId, input.toType);
    const pairId = uuid();
    const leg = {
      category: 'Transfer', category_source: 'user' as const,
      is_duplicate_flagged: false, is_subscription: false,
      source: 'manual' as const, is_transfer: true,
      transaction_type: 'transfer' as const, transfer_pair_id: pairId,
    };

    // Out-leg on the source (negative amount = money leaving).
    const outLeg = this.add({
      ...leg,
      account_id: input.fromId, account_type: input.fromType, date: input.date,
      merchant: `Transfer to ${toName}`, raw_description: input.note || `Transfer to ${toName}`,
      amount: -X, currency: currencyOf(input.fromId, input.fromType),
    });
    // In-leg on the destination (positive amount = money arriving).
    this.add({
      ...leg,
      account_id: input.toId, account_type: input.toType, date: input.date,
      merchant: `Transfer from ${fromName}`, raw_description: input.note || `Transfer from ${fromName}`,
      amount: X, currency: currencyOf(input.toId, input.toType),
      // A card in-leg must stay OUT of manualAdjustment: the Basiq reconciliation
      // pass negates the signed sum of source:'manual' card rows, which would
      // re-reduce owing on top of the statement settlement (double count). 'unknown'
      // is the same choice buildCardPaymentLeg makes for the reconcile-flow leg.
      source: input.toType === 'credit_card' ? 'unknown' : 'manual',
    });

    // Source always moves directly (bank balance, or a card being drawn down —
    // increases its owing). moveOwnerBalance handles both.
    moveOwnerBalance(input.fromId, input.fromType, -X);

    if (input.toType === 'credit_card') {
      // Paying a card: settle against its STATEMENT (the balance authority) so the
      // reduction survives a re-sync/refresh recompute — a bare moveOwnerBalance here
      // would be clobbered back to the old owing. This also records a reconciled
      // PendingPayment linked to the out-leg, so deleting either leg reverses the
      // owing exactly once (reverseCardPaymentsForTx keys off transfer_pair_id).
      settleCardStatement(input.toId, X, outLeg.id);
    } else {
      moveOwnerBalance(input.toId, input.toType, +X); // destination bank gains X
    }
  },

  /**
   * "Use bank data" escape hatch: drop every manually-added transaction on an
   * account and trust the bank feed entirely. Returns how many were removed so
   * the caller can re-snap the balance to the authoritative bank figure.
   */
  dropManualForAccount(ids: Set<string>): number {
    const s = useStore.getState();
    const doomed = s.transactions.filter(t => t.source === 'manual' && ids.has(t.account_id));
    if (!doomed.length) return 0;
    const doomedIds = new Set(doomed.map(t => t.id));
    s.setTransactions(s.transactions.filter(t => !doomedIds.has(t.id)));
    for (const t of doomed) syncWithRetry('transaction.delete', { id: t.id });
    return doomed.length;
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

  /**
   * Rename a subscription. The FIRST time a subscription is renamed we snapshot
   * what it was called into original_name, so the UI can show the original in
   * parentheses (e.g. "Transfer to Investment (Transfer to xx2319 …)"). Auto-
   * detected subs already carry original_name; manually-added ones start null, so
   * without this a manual rename would erase any trace of the source name.
   * Subsequent renames leave the (already-set) original_name untouched.
   */
  rename(id: string, newName: string): void {
    const s = useStore.getState();
    const existing = s.subscriptions.find(sub => sub.id === id);
    const captureOriginal = !!existing
      && !existing.original_name
      && newName.trim().toLowerCase() !== existing.name.trim().toLowerCase();
    const patch: Partial<Subscription> = captureOriginal
      ? { name: newName, original_name: existing!.name }
      : { name: newName };

    s.setSubscriptions(s.subscriptions.map(sub =>
      sub.id === id ? { ...sub, ...patch, updated_at: ts() } : sub
    ));
    syncWithRetry('subscription.update', { id, data: patch });
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

// Thin localStorage wrapper over the pure list mutators in utils/taxDeductions.
// All the merge/dedup/FY logic lives there (and is unit-tested); this only reads
// and writes the array. Records now carry an optional `source_transaction_id`
// link used for double-count prevention against deductible transactions.
export const deductionsDS = {
  getAll(): ManualDeduction[] {
    try { return JSON.parse(localStorage.getItem(getDeductionsKey()) ?? '[]') as ManualDeduction[]; } catch { return []; }
  },
  save(list: ManualDeduction[]) {
    localStorage.setItem(getDeductionsKey(), JSON.stringify(list));
  },
  add(data: NewManualDeduction) {
    const id = uuid();
    deductionsDS.save(addManualDeduction(deductionsDS.getAll(), data, { id, now: ts() }));
    return deductionsDS.getAll().find(d => d.id === id)!;
  },
  update(id: string, data: Partial<NewManualDeduction>) {
    deductionsDS.save(updateManualDeduction(deductionsDS.getAll(), id, data));
  },
  /** Set (or clear, with null) the transaction link — toggles dedup protection. */
  setLink(id: string, transactionId: string | null) {
    deductionsDS.save(setDeductionLink(deductionsDS.getAll(), id, transactionId));
  },
  /** Mark a suspected-duplicate pair as "keep both" so both keep counting. */
  dismissDuplicate(id: string, transactionId: string) {
    deductionsDS.save(dismissDuplicate(deductionsDS.getAll(), id, transactionId));
  },
  remove(id: string) {
    deductionsDS.save(removeManualDeduction(deductionsDS.getAll(), id));
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

// ─── MERCHANTS + ALIASES + RULES (Phase 2B) ───────────────────────────────────

export const merchantsDS = {
  getAll(): Merchant[] {
    return useStore.getState().merchants;
  },

  add(data: Omit<Merchant, 'id' | 'user_id' | 'created_at' | 'updated_at'>): Merchant {
    const record: Merchant = { ...data, id: uuid(), user_id: uid(), created_at: ts(), updated_at: ts() };
    const s = useStore.getState();
    s.setMerchants([...s.merchants, record]);
    const { id, user_id, created_at, updated_at, ...payload } = record;
    syncWithRetry('merchant.create', { recordId: record.id, data: payload });
    return record;
  },

  /**
   * Find-or-create a USER merchant by normalised key. If one already exists for
   * this user, update its display name / default category; otherwise create it.
   */
  upsertUserMerchant(data: { display_name: string; merchant_normalized: string; default_category?: string }): Merchant {
    const s = useStore.getState();
    const myId = s.user?.id ?? 'local';
    const existing = s.merchants.find(m => m.user_id === myId && m.merchant_normalized === data.merchant_normalized);
    if (existing) {
      const patch: Partial<Merchant> = { display_name: data.display_name };
      if (data.default_category !== undefined) patch.default_category = data.default_category;
      return this.update(existing.id, patch);
    }
    return this.add({
      display_name: data.display_name,
      merchant_normalized: data.merchant_normalized,
      default_category: data.default_category ?? null,
    });
  },

  update(id: string, data: Partial<Merchant>): Merchant {
    const s = useStore.getState();
    const updated = s.merchants.map(m => m.id === id ? { ...m, ...data, updated_at: ts() } : m);
    s.setMerchants(updated);
    syncWithRetry('merchant.update', { id, data });
    return updated.find(m => m.id === id)!;
  },

  remove(id: string): void {
    const s = useStore.getState();
    s.setMerchants(s.merchants.filter(m => m.id !== id));
    syncWithRetry('merchant.delete', { id });
  },
};

export const merchantAliasesDS = {
  getAll(): MerchantAlias[] {
    return useStore.getState().merchantAliases;
  },

  addUserAlias(data: { merchant_id: string; pattern: string; match_type: 'normalized' | 'contains' }): MerchantAlias {
    const s = useStore.getState();
    const myId = s.user?.id ?? 'local';
    // De-dupe: one user alias per (pattern, match_type) → latest merchant wins.
    const existing = s.merchantAliases.find(a =>
      a.user_id === myId && a.match_type === data.match_type && a.pattern === data.pattern);
    if (existing) {
      if (existing.merchant_id === data.merchant_id) return existing;
      return this.update(existing.id, { merchant_id: data.merchant_id });
    }
    const record: MerchantAlias = { ...data, id: uuid(), user_id: myId, created_at: ts(), updated_at: ts() };
    s.setMerchantAliases([...s.merchantAliases, record]);
    const { id, user_id, created_at, updated_at, ...payload } = record;
    syncWithRetry('merchantAlias.create', { recordId: record.id, data: payload });
    return record;
  },

  update(id: string, data: Partial<MerchantAlias>): MerchantAlias {
    const s = useStore.getState();
    const updated = s.merchantAliases.map(a => a.id === id ? { ...a, ...data, updated_at: ts() } : a);
    s.setMerchantAliases(updated);
    // No dedicated alias.update executor — recreate semantics via delete+create is
    // overkill; an alias is small, so persist the new mapping as a fresh create and
    // drop the stale row server-side on next full load. Locally we already updated.
    syncWithRetry('merchantAlias.create', { recordId: id, data: {
      merchant_id: data.merchant_id, pattern: updated.find(a => a.id === id)?.pattern, match_type: updated.find(a => a.id === id)?.match_type,
    } });
    return updated.find(a => a.id === id)!;
  },

  remove(id: string): void {
    const s = useStore.getState();
    s.setMerchantAliases(s.merchantAliases.filter(a => a.id !== id));
    syncWithRetry('merchantAlias.delete', { id });
  },
};

export const transactionRulesDS = {
  getAll(): TransactionRule[] {
    return useStore.getState().transactionRules;
  },

  add(data: { priority: number; enabled: boolean; conditions: RuleCondition; actions: RuleAction; label?: string }): TransactionRule {
    const record: TransactionRule = {
      id: uuid(), user_id: uid(),
      priority: data.priority, enabled: data.enabled,
      conditions: data.conditions, actions: data.actions,
      label: data.label ?? null,
      created_at: ts(), updated_at: ts(),
    };
    const s = useStore.getState();
    s.setTransactionRules([...s.transactionRules, record]);
    const { id, user_id, created_at, updated_at, ...payload } = record;
    syncWithRetry('rule.create', { recordId: record.id, data: payload });
    return record;
  },

  update(id: string, data: Partial<TransactionRule>): TransactionRule {
    const s = useStore.getState();
    const updated = s.transactionRules.map(r => r.id === id ? { ...r, ...data, updated_at: ts() } : r);
    s.setTransactionRules(updated);
    syncWithRetry('rule.update', { id, data });
    return updated.find(r => r.id === id)!;
  },

  setEnabled(id: string, enabled: boolean): void {
    this.update(id, { enabled });
  },

  /**
   * Create-or-MERGE a learned rule (Phase 2B/2D.2). A "learned" rule is one
   * planCorrection emits — keyed on a single merchant condition. When the user
   * teaches two things about the SAME merchant (e.g. category now, business vs
   * personal later) we must NOT add two competing rules: the engine applies only
   * the single highest-priority match, so a second rule would shadow the first.
   * Instead we find the existing rule with the identical condition and merge the
   * new actions into it (new fields win), keeping ONE rule that stamps everything.
   * The label is rebuilt from the merged actions so the settings list stays true.
   */
  upsertLearned(rule: { conditions: RuleCondition; actions: RuleAction; priority: number; label?: string }): TransactionRule {
    const me = uid();
    const sameCondition = (a: RuleCondition, b: RuleCondition) => JSON.stringify(a) === JSON.stringify(b);
    const existing = useStore.getState().transactionRules.find(
      r => r.user_id === me && sameCondition(r.conditions, rule.conditions),
    );
    if (!existing) return this.add({ enabled: true, ...rule });

    const mergedActions: RuleAction = { ...existing.actions, ...rule.actions };
    // Rebuild the human label from what the merged rule now does, keeping the
    // merchant name from whichever label mentioned it.
    const name = ((rule.label ?? existing.label ?? '').split('→')[0] ?? '').trim() || 'Rule';
    const effect = [mergedActions.category, mergedActions.entity].filter(Boolean).join(' · ');
    return this.update(existing.id, {
      actions: mergedActions,
      enabled: true,
      priority: Math.max(existing.priority, rule.priority),
      label: effect ? `${name} → ${effect}` : (existing.label ?? null),
    });
  },

  remove(id: string): void {
    const s = useStore.getState();
    s.setTransactionRules(s.transactionRules.filter(r => r.id !== id));
    syncWithRetry('rule.delete', { id });
  },

  /**
   * Rules only file FUTURE transactions — a rule never retroactively touches the
   * past. So an earlier transaction from the same merchant can still sit under the
   * category it had before the rule existed (e.g. a merchant that used to be
   * "Health" and is now "Groceries"). These two helpers make that visible and
   * fixable from Settings → Category Rules:
   *
   *   pastMismatches(rule)  → READ-ONLY: the already-stored transactions this rule
   *     WOULD file under its category but which currently sit on a DIFFERENT one,
   *     excluding any the user set by hand (category_source==='user') — those are
   *     deliberate and never overridden. Powers the "N earlier still on X" line.
   *
   *   applyToPast(ruleId)   → re-file exactly those onto the rule's category
   *     (category_source='rule', the same stamp the engine uses), returning how
   *     many changed. This is the one-time retroactive pass; matching thresholds
   *     and the rule itself are unchanged.
   */
  pastMismatches(rule: TransactionRule): Transaction[] {
    const target = rule.actions.category;
    if (!target) return [];
    return useStore.getState().transactions.filter(t => {
      if (t.category === target) return false;          // already on the rule's category
      if (t.category_source === 'user') return false;   // hand-set → leave alone
      const candidate: RuleCandidate = {
        merchant_normalized: t.merchant_normalized || normaliseMerchant(t.raw_description || t.merchant || ''),
        raw_description: t.raw_description || t.merchant || '',
        merchant: t.merchant,
        account_id: t.account_id,
        amount: t.amount,
        source: t.source ?? 'manual',
      };
      return matchRule(rule.conditions, candidate);
    });
  },

  applyToPast(ruleId: string): number {
    const rule = useStore.getState().transactionRules.find(r => r.id === ruleId);
    if (!rule || !rule.actions.category) return 0;
    const affected = this.pastMismatches(rule);
    for (const t of affected) {
      transactionsDS.update(t.id, { category: rule.actions.category, category_source: 'rule', confidence: 0.9 });
    }
    return affected.length;
  },
};

// ─── RECURRING SERIES (Phase 2C) ──────────────────────────────────────────────
// Persist a detected recurring relationship so its occurrences are linked and a
// dismissed suggestion stays dismissed across devices. Detection itself is
// unchanged — this layer only stores the OUTCOME (see recurringSeries.ts /
// recurringDetection.ts).

export const recurringSeriesDS = {
  getAll(): RecurringSeries[] {
    return useStore.getState().recurringSeries;
  },

  /** Active (tracked) series only. */
  active(): RecurringSeries[] {
    return useStore.getState().recurringSeries.filter(s => s.status === 'active');
  },

  /**
   * Find-or-create a series by identity key (normalised merchant + frequency),
   * mirroring the DB unique index so confirm/dismiss are idempotent. Returns the
   * stored row.
   */
  upsert(data: Omit<RecurringSeries, 'id' | 'user_id' | 'created_at' | 'updated_at'>): RecurringSeries {
    const s = useStore.getState();
    const key = seriesKey(data.merchant_normalized, data.frequency);
    const existing = s.recurringSeries.find(r =>
      seriesKey(r.merchant_normalized, r.frequency) === key);
    if (existing) return this.update(existing.id, data);
    const record: RecurringSeries = { ...data, id: uuid(), user_id: uid(), created_at: ts(), updated_at: ts() };
    s.setRecurringSeries([...s.recurringSeries, record]);
    const { id, user_id, created_at, updated_at, ...payload } = record;
    syncWithRetry('recurringSeries.create', { recordId: record.id, data: payload });
    return record;
  },

  update(id: string, data: Partial<RecurringSeries>): RecurringSeries {
    const s = useStore.getState();
    const updated = s.recurringSeries.map(r => r.id === id ? { ...r, ...data, updated_at: ts() } : r);
    s.setRecurringSeries(updated);
    const { id: _i, user_id: _u, created_at: _c, updated_at: _t, ...payload } = { ...updated.find(r => r.id === id)! };
    syncWithRetry('recurringSeries.update', { id, data: payload });
    return updated.find(r => r.id === id)!;
  },

  /**
   * CONFIRM a detected pattern as an active series and LINK every current
   * occurrence (stamps transaction.recurring_series_id). Reuses the pure
   * seriesFromPattern (which reuses calcNextChargeDate) — no new frequency logic.
   */
  confirmFromPattern(pattern: RecurringPattern, kind?: RecurringKind): RecurringSeries {
    const series = this.upsert({ ...seriesFromPattern(pattern, kind), status: 'active' });
    const ids = occurrenceIdsForSeries(series, useStore.getState().transactions);
    for (const txId of ids) transactionsDS.update(txId, { recurring_series_id: series.id });
    return series;
  },

  /**
   * DISMISS a detected pattern ("this is NOT recurring"). Persists a
   * status='dismissed' series row keyed on the pattern identity — because series
   * rows sync, the suggestion stays dismissed on every device (the cross-device
   * guarantee), unlike the old sessionStorage/localStorage-only suppression.
   */
  dismissPattern(pattern: RecurringPattern): RecurringSeries {
    const base = seriesFromPattern(pattern);
    return this.upsert({ ...base, status: 'dismissed' });
  },

  /** Filter detected patterns down to those NOT already confirmed or dismissed. */
  suggestable(patterns: RecurringPattern[]): RecurringPattern[] {
    const series = useStore.getState().recurringSeries;
    return patterns.filter(p => !isSuggestionSuppressed(p, series));
  },

  remove(id: string): void {
    const s = useStore.getState();
    // Unlink occurrences so nothing points at a deleted series.
    for (const t of s.transactions.filter(t => t.recurring_series_id === id)) {
      transactionsDS.update(t.id, { recurring_series_id: null });
    }
    s.setRecurringSeries(s.recurringSeries.filter(r => r.id !== id));
    syncWithRetry('recurringSeries.delete', { id });
  },
};

// ─── TRANSACTION SPLITS (Phase 2C) ────────────────────────────────────────────
// Split ONE bank transaction across multiple categories. The parent row is never
// mutated; reporting uses the split lines (see transactionCore.spendByCategory).
// Splits are set ATOMICALLY: validate they sum to the parent, then replace.

export const transactionSplitsDS = {
  getAll(): TransactionSplit[] {
    return useStore.getState().transactionSplits;
  },

  /** All split lines for a parent transaction. */
  forTransaction(transactionId: string): TransactionSplit[] {
    return useStore.getState().transactionSplits.filter(s => s.transaction_id === transactionId);
  },

  /** Map of parent id → split lines, for splits-aware spend reporting. */
  byTransactionId(): Map<string, TransactionSplit[]> {
    const map = new Map<string, TransactionSplit[]>();
    for (const sp of useStore.getState().transactionSplits) {
      const list = map.get(sp.transaction_id);
      if (list) list.push(sp);
      else map.set(sp.transaction_id, [sp]);
    }
    return map;
  },

  /**
   * Replace the splits of a transaction with `lines`. Enforces the core rule —
   * split amounts must sum to the parent's magnitude — and rejects otherwise
   * (returns the validation so the UI can show the shortfall). Passing an empty
   * array UN-splits the transaction (back to its own category).
   */
  setSplits(transactionId: string, lines: SplitLineInput[]) {
    const s = useStore.getState();
    const parent = s.transactions.find(t => t.id === transactionId);
    if (!parent) return { ok: false as const, error: 'no_parent' as const };

    if (lines.length > 0) {
      const v = validateSplits(lines, parent.amount);
      if (!v.ok) return { ok: false as const, validation: v };
    }

    // Atomic replace: drop existing lines, then create the new ones.
    const kept = s.transactionSplits.filter(sp => sp.transaction_id !== transactionId);
    const created: TransactionSplit[] = lines.map(l => ({
      id: uuid(), user_id: uid(), transaction_id: transactionId,
      category: l.category.trim(), amount: Math.abs(Number(l.amount) || 0),
      notes: l.notes ?? null, tags: l.tags ?? null,
      created_at: ts(), updated_at: ts(),
    }));
    s.setTransactionSplits([...kept, ...created]);

    // Sync: clear server-side lines for this txn, then create each new one.
    syncWithRetry('split.deleteFor', { id: transactionId });
    for (const rec of created) {
      const { id, user_id, created_at, updated_at, ...payload } = rec;
      syncWithRetry('split.create', { recordId: rec.id, data: payload });
    }
    return { ok: true as const, splits: created };
  },

  /** Remove all splits for a transaction (un-split it). */
  clear(transactionId: string): void {
    const s = useStore.getState();
    s.setTransactionSplits(s.transactionSplits.filter(sp => sp.transaction_id !== transactionId));
    syncWithRetry('split.deleteFor', { id: transactionId });
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
  const server = srv as Transaction;
  const localId = pl.recordId as string;
  const serverId = server.id;

  // The backend ignores the client-supplied id and Postgres mints a fresh UUID on
  // insert, so a transaction's id changes local→server HERE. Record the mapping so
  // any queued transaction.update still addressed to the local id resolves to the
  // real row (see resolveId in syncQueue) instead of silently 404ing forever.
  if (serverId && localId && serverId !== localId) s.addIdMapping(localId, serverId);

  const local = s.transactions.find(t => t.id === localId);
  // Preserve the current account_id — it may have been remapped from a temp UUID
  // to the real Supabase UUID while this request was in flight.
  const accountId = local?.account_id ?? (pl.data as { account_id?: string })?.account_id ?? server.account_id;

  // MERGE, don't overwrite. Overwriting with `srv` here is what made a matched
  // refund's badge flash and then vanish a moment later (see mergeCreatedTransaction).
  s.setTransactions(s.transactions.map(t => {
    if (t.id === localId) return mergeCreatedTransaction(local, server, accountId);
    // A refund booked against THIS purchase points at its old local id. Now that
    // the purchase has its real server id, re-point the refund so refund_of stays
    // valid after a reload from the server (Phase 2C persistence). Sync the fix.
    if (serverId && t.refund_of === localId) {
      syncWithRetry('transaction.update', { id: t.id, data: { refund_of: serverId } });
      return { ...t, refund_of: serverId };
    }
    return t;
  }));

  // Persist post-create metadata to the SERVER under the REAL id. The transaction.update
  // fired by add()'s post-classification (this.update during ingest) targeted the LOCAL
  // id, which the server never had — swallow404 turns that 404 into a silent no-op, so
  // refund/transfer/review fields would never reach the server and would disappear on the
  // next bootstrap. Re-send only the fields the create payload could not carry (a plain
  // purchase produces an empty diff → no extra write).
  if (local && serverId) {
    const meta = postCreateMetadataDiff(local, (pl.data ?? {}) as Partial<Transaction>) as Record<string, unknown>;
    // refund_of / transfer_pair_id may still hold a LOCAL id (the counter-row's create
    // hasn't reconciled yet); resolve through the id map so the link persists correctly.
    if (typeof meta.refund_of === 'string') meta.refund_of = resolveAccountId(meta.refund_of);
    if (typeof meta.transfer_pair_id === 'string') meta.transfer_pair_id = resolveAccountId(meta.transfer_pair_id);
    if (Object.keys(meta).length > 0) {
      syncWithRetry('transaction.update', { id: serverId, data: meta });
    }
  }

  // The create may have been SENT with a temp account id (a statement upload fires
  // transaction creates immediately, before the new account's id has reconciled).
  // The backend has no idMap to bridge temp→server ids, so the row would be
  // unreachable by per-account queries on other devices. Now that the row exists
  // on the server, correct its account_id if it has since resolved.
  const sentAccount = (pl.data as { account_id?: string })?.account_id;
  const resolved = resolveAccountId(accountId ?? '');
  if (serverId && resolved && sentAccount && resolved !== sentAccount) {
    syncWithRetry('transaction.update', { id: serverId, data: { account_id: resolved } });
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

// Phase 2B: swap temp id → server row (and persist the mapping so any queued op
// that referenced the temp id resolves to the real row).
registerSyncSuccess('merchant.create', (srv, pl) => {
  const s = useStore.getState();
  const server = srv as Merchant;
  if (pl.recordId && server.id && pl.recordId !== server.id) s.addIdMapping(pl.recordId as string, server.id);
  s.setMerchants(s.merchants.map(m => m.id === pl.recordId ? server : m));
});

registerSyncSuccess('merchantAlias.create', (srv, pl) => {
  const s = useStore.getState();
  const server = srv as MerchantAlias;
  if (pl.recordId && server.id && pl.recordId !== server.id) s.addIdMapping(pl.recordId as string, server.id);
  s.setMerchantAliases(s.merchantAliases.map(a => a.id === pl.recordId ? server : a));
});

registerSyncSuccess('rule.create', (srv, pl) => {
  const s = useStore.getState();
  const server = srv as TransactionRule;
  if (pl.recordId && server.id && pl.recordId !== server.id) s.addIdMapping(pl.recordId as string, server.id);
  s.setTransactionRules(s.transactionRules.map(r => r.id === pl.recordId ? server : r));
});

// Phase 2C: swap temp id → server row for recurring series + splits.
registerSyncSuccess('recurringSeries.create', (srv, pl) => {
  const s = useStore.getState();
  const server = srv as RecurringSeries;
  if (pl.recordId && server.id && pl.recordId !== server.id) s.addIdMapping(pl.recordId as string, server.id);
  s.setRecurringSeries(s.recurringSeries.map(r => r.id === pl.recordId ? server : r));
});

registerSyncSuccess('split.create', (srv, pl) => {
  const s = useStore.getState();
  const server = srv as TransactionSplit;
  if (pl.recordId && server.id && pl.recordId !== server.id) s.addIdMapping(pl.recordId as string, server.id);
  s.setTransactionSplits(s.transactionSplits.map(sp => sp.id === pl.recordId ? server : sp));
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
      merchants: [], merchantAliases: [], transactionRules: [],
      recurringSeries: [], transactionSplits: [],
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
    merchantsResult,
    merchantAliasesResult,
    transactionRulesResult,
    recurringSeriesResult,
    transactionSplitsResult,
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
    overviewApi.getMerchants(),
    overviewApi.getMerchantAliases(),
    overviewApi.getTransactionRules(),
    overviewApi.getRecurringSeries(),
    overviewApi.getTransactionSplits(),
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

  // Phase 2B — merchants / aliases / rules. These endpoints may 404 until the
  // migration + routes deploy; Promise.allSettled makes that a graceful skip
  // (the classifier just runs on seeds only until the tables exist).
  if (merchantsResult.status === 'fulfilled') {
    s.setMerchants(mergeServerAuthoritative((merchantsResult.value as Merchant[]) ?? [], s.merchants, 'merchant.create'));
  } else {
    console.warn('[bootstrapData] merchants failed:', merchantsResult.reason);
  }
  if (merchantAliasesResult.status === 'fulfilled') {
    s.setMerchantAliases(mergeServerAuthoritative((merchantAliasesResult.value as MerchantAlias[]) ?? [], s.merchantAliases, 'merchantAlias.create'));
  } else {
    console.warn('[bootstrapData] merchant aliases failed:', merchantAliasesResult.reason);
  }
  if (transactionRulesResult.status === 'fulfilled') {
    s.setTransactionRules(mergeServerAuthoritative((transactionRulesResult.value as TransactionRule[]) ?? [], s.transactionRules, 'rule.create'));
  } else {
    console.warn('[bootstrapData] transaction rules failed:', transactionRulesResult.reason);
  }

  // Phase 2C — recurring series + transaction splits. Like 2B, these may 404
  // until the migration + routes deploy; Promise.allSettled makes that a graceful
  // skip (detection just runs render-time-only and nothing is split until then).
  if (recurringSeriesResult.status === 'fulfilled') {
    s.setRecurringSeries(mergeServerAuthoritative((recurringSeriesResult.value as RecurringSeries[]) ?? [], s.recurringSeries, 'recurringSeries.create'));
  } else {
    console.warn('[bootstrapData] recurring series failed:', recurringSeriesResult.reason);
  }
  if (transactionSplitsResult.status === 'fulfilled') {
    s.setTransactionSplits(mergeServerAuthoritative((transactionSplitsResult.value as TransactionSplit[]) ?? [], s.transactionSplits, 'split.create'));
  } else {
    console.warn('[bootstrapData] transaction splits failed:', transactionSplitsResult.reason);
  }


  // Self-heal: move any bank account that is really a mortgage/loan into the
  // Loans section. Runs on every load, independent of Basiq consent — so a
  // mortgage imported before loan-routing existed (and now stranded in the bank
  // list, possibly only in localStorage) migrates itself without needing a fresh
  // bank sync. Idempotent: once migrated, there's nothing left to move.
  migrateMisfiledLoanAccounts();
  // Attach imported repayments to their loan so they show under it (covers loans
  // whose bank account was already migrated in an earlier session).
  relinkLoanTransactions();

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
 * Move any bank account whose type is really a debt (mortgage/loan) into the
 * Loans section, then remove the bank-account copy so the balance isn't counted
 * as both an asset and a liability. "Mortgage"/"Loan" as a bank account type only
 * ever originates from a Basiq import (mapAccountType) — manual accounts are
 * Everyday/Savings/Offset/High Yield Savings — so this never touches a
 * user-created account. Deduped against existing loans (by basiq_account_id, else
 * name) so re-running is a no-op.
 */
function migrateMisfiledLoanAccounts(): void {
  const isLoanType = (t?: string) => {
    const v = (t ?? '').toLowerCase();
    return v.includes('mortgage') || v.includes('loan');
  };
  const misfiled = useStore.getState().accounts.filter(a => isLoanType(a.account_type));
  if (!misfiled.length) return;

  for (const a of misfiled) {
    const already = useStore.getState().loans.find(l =>
      (a.basiq_account_id && l.basiq_account_id === a.basiq_account_id) ||
      (!a.basiq_account_id && l.name === a.name),
    );
    let loanId = already?.id;
    if (!already) {
      const owing = Math.abs(a.balance ?? 0);
      const created = loansDS.add({
        name: a.name,
        loan_type: (a.account_type ?? '').toLowerCase().includes('mortgage') ? 'mortgage' : 'personal',
        lender: a.institution ?? null,
        original_amount: owing,
        current_balance: owing,
        repayment_frequency: 'monthly',
        basiq_account_id: a.basiq_account_id ?? null,
        source: a.source,
      } as Omit<Loan, 'id' | 'user_id' | 'created_at' | 'updated_at'>);
      loanId = created.id;
    }
    // Re-point this account's transactions (its repayments) at the loan BEFORE
    // removing the account — accountsDS.remove() deletes an account's
    // transactions, so relinking first is what keeps them. Match every id the
    // account is known by, plus its raw Basiq id (Basiq txns keep that as their
    // account_id until remapped).
    const variants = accountIdVariants(a);
    if (a.basiq_account_id) variants.add(a.basiq_account_id);
    for (const t of useStore.getState().transactions) {
      if (variants.has(t.account_id)) {
        transactionsDS.update(t.id, { account_id: loanId!, account_type: 'loan' });
      }
    }
    accountsDS.remove(a.id);
  }
  console.log(`[migrate] moved ${misfiled.length} mortgage/loan account(s) from Accounts into Loans`);
}

/**
 * Re-link Basiq loan transactions onto their loan. Imported mortgage/loan
 * transactions keep the raw Basiq account id as their account_id (and type
 * 'bank'); once the account has been migrated into a Loan, those transactions
 * are orphaned. This matches them back to the loan by basiq_account_id so they
 * appear under the loan — the same way a bank account shows its transactions.
 * Idempotent: after re-linking, account_id equals the loan id (no longer the
 * Basiq id), so a second pass matches nothing.
 */
function relinkLoanTransactions(): void {
  const loans = useStore.getState().loans.filter(l => l.basiq_account_id);
  if (!loans.length) return;
  const loanIdByBasiq = new Map(loans.map(l => [l.basiq_account_id as string, l.id]));
  let n = 0;
  for (const t of useStore.getState().transactions) {
    const loanId = loanIdByBasiq.get(t.account_id);
    if (loanId && (t.account_id !== loanId || t.account_type !== 'loan')) {
      transactionsDS.update(t.id, { account_id: loanId, account_type: 'loan' });
      n++;
    }
  }
  if (n) console.log(`[migrate] re-linked ${n} loan transaction(s) to their loan`);
  estimateLoanOriginals();
}

/**
 * Basiq only reports a loan's CURRENT owing balance, never the original
 * principal — so at import we default `original_amount = current_balance`,
 * which makes every imported loan read "0% repaid / owe what you borrowed".
 * Estimate a real original from history: original ≈ current balance + total
 * repayments recorded against the loan (positive-amount credits reduce the
 * debt). Only fills the default guess (original <= current) so a user's own
 * edited "Original amount" is never overwritten.
 */
function estimateLoanOriginals(): void {
  const s = useStore.getState();
  const loans = s.loans.filter(l => l.basiq_account_id);
  if (!loans.length) return;
  for (const loan of loans) {
    // Skip if the user (or a prior estimate) already set a real original.
    if (loan.original_amount > loan.current_balance) continue;
    const repaid = s.transactions
      .filter(t => t.account_id === loan.id && t.account_type === 'loan' && t.amount > 0)
      .reduce((sum, t) => sum + t.amount, 0);
    if (repaid > 0) {
      loansDS.update(loan.id, { original_amount: loan.current_balance + repaid });
    }
  }
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
  merchant: string;         // enriched businessName when available, else raw description
  raw_description?: string; // original untouched Basiq description
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

export function basiqLastSyncAt(): number {
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

      // ── Basiq account id → local account, covering banks, cards AND loans ─
      const metaByBasiqId = new Map<string, { localId: string; type: 'bank' | 'credit_card' | 'loan' }>();
      for (const a of mergedAccounts) {
        if (a.basiq_account_id) metaByBasiqId.set(a.basiq_account_id, { localId: a.id, type: 'bank' });
      }
      for (const c of mergedCards) {
        if (c.basiq_account_id) metaByBasiqId.set(c.basiq_account_id, { localId: c.id, type: 'credit_card' });
      }
      for (const l of useStore.getState().loans) {
        if (l.basiq_account_id) metaByBasiqId.set(l.basiq_account_id, { localId: l.id, type: 'loan' });
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
        // Oldest-first: refund matching (Phase 2C) only sees transactions already
        // stored, so a purchase must be ingested BEFORE the refund that reverses
        // it. Basiq returns newest-first, which would make a refund miss its
        // same-batch purchase — sort ascending by date to guarantee ordering.
        const newTxns = liveTxns
          .filter(t => !existingBasiqIds.has(t.basiq_tx_id))
          .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
        let added = 0;
        const batchState = new Map<string, number>();
        for (const t of newTxns) {
          const m = metaByBasiqId.get(t.account_id);
          // Funnel through the canonical ingestion pipeline: basiq_tx_id keeps
          // this idempotent, raw_description preserves the original description
          // even though `merchant` shows the enriched businessName.
          const result = transactionsDS.ingest({
            account_id: m?.localId ?? t.account_id,
            account_type: m?.type ?? 'bank',
            date: t.date,
            merchant: t.merchant,
            raw_description: t.raw_description ?? t.merchant,
            amount: t.amount,
            currency: t.currency,
            category: t.category ?? autoCategory(t.merchant),
            category_source: t.category ? 'basiq' : 'auto',
            is_duplicate_flagged: false,
            is_subscription: false,
            basiq_tx_id: t.basiq_tx_id,
            source: 'basiq',
            source_ref: t.basiq_tx_id,
          }, { batchState });
          if (result.status !== 'duplicate') added++;
        }
        useStore.getState().setPendingPayments(pendingPaymentsDS.getAll());
        newTxnCount = added;
      } catch {
        txnError = true;
      }

      localStorage.setItem(BASIQ_LAST_SYNC_KEY, String(Date.now()));

      // ── Reconcile manual entries against the freshly-synced bank data ─────
      // For each LIVE-SYNCED account: an exact bank match supersedes the manual
      // dup; a near-match (amount off a few $ / merchant spelled differently)
      // becomes a 'conflict' for the user to resolve; anything unmatched stays
      // 'pending' (the account modal's grace-gated banner does the "keep it?"
      // ask). Then re-layer each account's balance on top of the authoritative
      // bank figure so 'kept'/'pending' manual money the bank hasn't posted is
      // still reflected (and 'conflict'/'resolved' isn't double-counted).
      try {
        const reconcileOwner = (ids: Set<string>) => {
          const txns = useStore.getState().transactions.filter(t => ids.has(t.account_id));
          const synced = txns.filter(t => t.source === 'basiq');
          for (const manual of txns.filter(t => t.source === 'manual')) {
            if (manual.reconcile_state === 'kept' || manual.reconcile_state === 'resolved') continue;
            const { result, candidate } = classifyManualAgainstSync(manual, synced);
            if (result === 'exact') {
              transactionsDS.remove(manual.id);                          // bank authoritative
            } else if (result === 'conflict' && candidate) {
              if (manual.reconcile_state !== 'conflict' || manual.reconcile_match_id !== candidate.id) {
                transactionsDS.update(manual.id, { reconcile_state: 'conflict', reconcile_match_id: candidate.id });
              }
            } else if (manual.reconcile_state == null) {
              transactionsDS.update(manual.id, { reconcile_state: 'pending' });
            } else if (manual.reconcile_state === 'conflict') {
              transactionsDS.update(manual.id, { reconcile_state: 'pending', reconcile_match_id: null }); // near-twin gone
            }
          }
        };
        for (const a of useStore.getState().accounts) if (!a.is_manual) reconcileOwner(accountIdVariants(a));
        for (const c of useStore.getState().creditCards) if (!c.is_manual) reconcileOwner(accountIdVariants(c));

        const after = useStore.getState().transactions;
        for (const a of useStore.getState().accounts) {
          if (a.is_manual) continue;
          const adj = manualAdjustment(after.filter(t => accountIdVariants(a).has(t.account_id) && t.source === 'manual'));
          if (adj !== 0) {
            const bal = (a.balance ?? 0) + adj;                          // a.balance == just-merged bank figure
            accountsDS.update(a.id, { balance: bal, display_balance: bal * (a.conversion_rate ?? 1) });
          }
        }
        for (const c of useStore.getState().creditCards) {
          if (c.is_manual) continue;
          // A charge (negative amount) RAISES owing, a credit lowers it → negate the signed sum.
          const owingAdj = -manualAdjustment(after.filter(t => accountIdVariants(c).has(t.account_id) && t.source === 'manual'));
          if (owingAdj !== 0) {
            const owe = (c.balance_owing ?? 0) + owingAdj;
            creditCardsDS.update(c.id, { balance_owing: owe, display_balance_owing: owe * (c.conversion_rate ?? 1) });
          }
        }
      } catch (e) {
        console.warn('[basiq] reconciliation pass failed:', e instanceof Error ? e.message : e);
      }

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

// ─── Phase 3.1: cash-flow forecast (DS wiring) ───────────────────────────────
//
// Thin gatherer over the pure engine (utils/cashFlowForecast.ts). It reads the
// user's bank balances plus every known recurring inflow/outflow — income,
// bills, subscriptions, recurring series, loans and credit-card minimum
// payments — normalises each into a display-currency `RecurringInput` (signed
// amount, frequency, anchor/next date, owning account, confidence, source
// links) and hands them to buildCashFlowForecast. All maths, de-duplication and
// transfer netting live in the engine; this layer only maps records. No UI yet.

/** Map a free-text frequency string to the engine's frequency enum. Returns
 *  null for irregular/unknown cadences so the caller can decide how to treat it. */
function toForecastFrequency(raw?: string | null): ForecastFrequency | null {
  const f = (raw ?? '').toLowerCase().trim();
  if (f === 'weekly' || f === 'week') return 'weekly';
  if (f === 'fortnightly' || f === 'biweekly' || f === 'bi-weekly') return 'fortnightly';
  if (f === 'monthly' || f === 'month') return 'monthly';
  if (f === 'quarterly' || f === 'quarter') return 'quarterly';
  if (f === 'annually' || f === 'annual' || f === 'yearly' || f === 'year') return 'annually';
  return null;
}

/** Today's date (YYYY-MM-DD) in the user's display timezone — the forecast's
 *  `asOf`. Kept out of the pure engine so the engine stays deterministic. */
function todayInDisplayTz(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: getDisplayTimeZone(),
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

export const forecastDS = {
  /** Build the 30/60/90-day cash-flow forecast from current data. `asOf` and
   *  `horizons` are overridable (tests / what-if); both default sensibly. */
  build(opts?: { asOf?: string; horizons?: number[] }): CashFlowForecast {
    const asOf = opts?.asOf ?? todayInDisplayTz();

    const banks = accountsDS.getAll().filter(a => !a.hidden);
    const bankIds = new Set(banks.map(a => a.id));
    const accounts: AccountBalanceInput[] = banks.map(a => ({
      accountId: a.id,
      name: a.name,
      balance: a.display_balance ?? a.balance,
    }));
    // Resolve a record's account reference to a known bank account, else null
    // (→ the engine's unallocated bucket). The engine also tolerates unknown ids.
    const routeAccount = (raw?: string | null): string | null => {
      if (!raw) return null;
      const r = resolveAccountId(raw);
      if (bankIds.has(r)) return r;
      if (bankIds.has(raw)) return raw;
      return null;
    };

    const inputs: RecurringInput[] = [];

    // Income — recurring by frequency; approved is certain, pending less so.
    for (const e of incomeDS.getAll().entries) {
      const amount = Math.abs(e.display_amount ?? e.amount);
      if (!amount) continue;
      const freq: ForecastFrequency | null = e.is_recurring ? toForecastFrequency(e.frequency) : 'once';
      if (!freq) continue; // irregular recurring income has no reliable cadence
      inputs.push({
        id: `income:${e.id}`,
        sourceType: 'income',
        name: e.source,
        amount, // inflow (+)
        frequency: freq,
        anchorDate: e.date,
        accountId: null,
        confidence: e.status === 'approved' ? 1 : 0.65,
      });
    }

    // Bills & reminders — obligations. Reminders (no amount) are skipped. A bill
    // mirrored from a loan/subscription carries the link so the engine de-dups it.
    for (const b of billsDS.getAll()) {
      if (b.kind === 'reminder') continue;
      const amount = Math.abs(b.amount);
      if (!amount) continue;
      const freq: ForecastFrequency = b.is_recurring ? (toForecastFrequency(b.frequency) ?? 'monthly') : 'once';
      inputs.push({
        id: `bill:${b.id}`,
        sourceType: 'bill',
        name: b.name,
        amount: -amount, // outflow (−)
        frequency: freq,
        anchorDate: b.due_date,
        accountId: null,
        confidence: 1,
        links: { subscription_id: b.subscription_id ?? null, loan_id: b.loan_id ?? null },
        skipAnchor: b.is_paid, // current cycle already settled
        // Signals a credit-card payment so the engine can de-dup it against the
        // card's own minimum-payment projection (bills carry no card link).
        creditCardPayment: b.category === 'Credit Card',
      });
    }

    // Subscriptions — user-managed recurring charges, allocated to their account.
    for (const sub of subscriptionsDS.getAll()) {
      const amount = Math.abs(sub.display_amount ?? sub.amount);
      if (!amount) continue;
      inputs.push({
        id: `sub:${sub.id}`,
        sourceType: 'subscription',
        name: sub.name,
        amount: -amount,
        frequency: toForecastFrequency(sub.frequency) ?? 'monthly',
        anchorDate: sub.next_charge_date,
        accountId: routeAccount(sub.account_id),
        confidence: sub.is_auto_detected ? 0.85 : 1,
      });
    }

    // Recurring series — detected commitments. Kept sign (income +, expense −).
    // A transfer-like series is flagged so the engine nets it out. Series that
    // duplicate a subscription/income/loan are de-duped away in the engine.
    for (const s of recurringSeriesDS.active()) {
      if (s.expected_amount == null || !s.next_expected_date) continue;
      const freq = toForecastFrequency(s.frequency);
      if (!freq) continue; // irregular — no reliable cadence to project
      const looksTransfer = s.kind === 'other' && isTransferMerchant(s.name);
      inputs.push({
        id: `series:${s.id}`,
        sourceType: 'recurring_series',
        name: s.name,
        amount: s.expected_amount,
        frequency: freq,
        anchorDate: s.next_expected_date,
        accountId: routeAccount(s.account_id),
        confidence: 0.7,
        links: { recurring_series_id: s.id },
        transfer: looksTransfer ? { counterpartAccountId: null } : undefined,
      });
    }

    // Loans — scheduled minimum repayments (needs an amount + a next due date).
    for (const l of loansDS.getAll()) {
      const amount = Math.abs(l.minimum_repayment ?? 0);
      if (!amount || !l.next_due_date) continue;
      inputs.push({
        id: `loan:${l.id}`,
        sourceType: 'loan',
        name: l.name,
        amount: -amount,
        frequency: l.repayment_frequency, // already weekly | fortnightly | monthly
        anchorDate: l.next_due_date,
        accountId: null,
        confidence: 0.95,
      });
    }

    // Credit cards — monthly minimum payment (needs an amount + a due date).
    for (const c of creditCardsDS.getAll()) {
      const amount = Math.abs(c.display_minimum_payment ?? c.minimum_payment ?? 0);
      if (!amount || !c.due_date) continue;
      inputs.push({
        id: `card:${c.id}`,
        sourceType: 'credit_card',
        name: `${c.name} (min payment)`,
        amount: -amount,
        frequency: 'monthly',
        anchorDate: c.due_date,
        accountId: null,
        confidence: 0.9,
      });
    }

    return buildCashFlowForecast({ asOf, accounts, inputs, horizons: opts?.horizons });
  },
};
