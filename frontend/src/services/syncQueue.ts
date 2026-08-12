/**
 * Central Supabase-write retry layer.
 *
 * Every backend write in dataService goes through syncWithRetry() instead of a
 * bare `.catch(console.warn)`. Behaviour on failure:
 *   1. First failure → retry once after 3 seconds.
 *   2. Second failure → park the write in the persisted pendingSyncQueue and
 *      surface a small non-blocking toast ("Some data couldn't sync — will retry").
 *   3. On next app load, retryPendingSync() replays every queued write.
 *
 * Queue items are fully serializable (a `kind` dispatch key + a plain payload),
 * so they survive a reload via Zustand's persist middleware.
 *
 * Success handlers (id reconciliation, portfolio recompute, …) are registered by
 * dataService at module load via registerSyncSuccess() — this keeps the import
 * direction one-way (dataService → syncQueue) with no circular dependency.
 */

import { useStore, type SyncQueueItem } from '../store';
import type { Notification } from '../types';
import { accountsApi, investmentsApi, incomeApi, overviewApi } from './api';

const RETRY_DELAY_MS = 3000;
const SYNC_TOAST_MSG = "Some data couldn't sync — will retry";
// Total attempts before a write is considered permanently failed: the initial try
// + the 3s retry (= 2, the attempts value at enqueue time) followed by one bump per
// app load. At attempt 5 we give up and raise a persistent notification instead.
const MAX_ATTEMPTS = 5;

type Executor = (payload: Record<string, unknown>) => Promise<unknown>;
type SuccessHandler = (serverRecord: unknown, payload: Record<string, unknown>) => void;

// ── Dispatch table: kind → API call. Payload carries everything needed to replay.
// Shapes: create → { recordId, data }; update → { id, data }; delete/pay → { id };
// payment → { recordId?/id, creditCardId, data }.
const p = (o: Record<string, unknown>) => o as { id: string; recordId: string; creditCardId: string; data: object; sold?: boolean };

// Follow the persisted temp→server id map so a queued op on a not-yet-reconciled
// record (e.g. ticking a bill paid while its create is still in flight) targets the
// real server row instead of the local temp id that would 404.
const resolveId = (id: string): string => {
  if (!id) return id;
  const { idMap } = useStore.getState();
  let r = id;
  const seen = new Set<string>();
  while (idMap[r] && !seen.has(r)) { seen.add(r); r = idMap[r]; }
  return r;
};

// Treat a 404/410 as success. For a DELETE this is obvious — the record is
// already gone, the desired end state. For an account-id-correcting transaction
// UPDATE it's also fine: a 404 means the row isn't on the server yet, so there is
// nothing to correct (its create will carry the resolved id). Either way the item
// must not get stuck retrying forever.
function swallow404(pr: Promise<unknown>): Promise<unknown> {
  return pr.catch((err: unknown) => {
    const status = (err as { response?: { status?: number } })?.response?.status;
    if (status === 404 || status === 410) return { idempotent: true };
    throw err;
  });
}
const idempotentDelete = swallow404;

const executors: Record<string, Executor> = {
  'account.create': (x) => accountsApi.createAccount(p(x).data),
  'account.update': (x) => swallow404(accountsApi.updateAccount(resolveId(p(x).id), p(x).data)),
  'account.delete': (x) => idempotentDelete(accountsApi.deleteAccount(p(x).id)),

  'card.create': (x) => accountsApi.createCreditCard(p(x).data),
  'card.delete': (x) => idempotentDelete(accountsApi.deleteCreditCard(p(x).id)),

  'transaction.create': (x) => accountsApi.createTransaction(p(x).data),
  'transaction.update': (x) => swallow404(accountsApi.updateTransaction(p(x).id, p(x).data)),
  'transaction.delete': (x) => idempotentDelete(accountsApi.deleteTransaction(p(x).id)),

  'subscription.create': (x) => accountsApi.createSubscription(p(x).data),
  'subscription.update': (x) => accountsApi.updateSubscription(p(x).id, p(x).data),
  'subscription.delete': (x) => idempotentDelete(accountsApi.deleteSubscription(p(x).id)),

  'investment.create': (x) => investmentsApi.createInvestment(p(x).data),
  'investment.update': (x) => investmentsApi.updateInvestment(p(x).id, p(x).data),
  'investment.delete': (x) => idempotentDelete(investmentsApi.deleteInvestment(p(x).id, p(x).sold === true)),
  'sale.create': (x) => investmentsApi.createSale(p(x).data),

  'super.create': (x) => investmentsApi.createSuper(p(x).data),
  'super.update': (x) => investmentsApi.updateSuper(p(x).id, p(x).data),

  'income.create': (x) => incomeApi.createIncome(p(x).data),
  'income.update': (x) => incomeApi.updateIncome(p(x).id, p(x).data),
  'income.delete': (x) => idempotentDelete(incomeApi.deleteIncome(p(x).id)),
  'income.approve': (x) => incomeApi.approveIncome(p(x).id),

  'bill.create': (x) => overviewApi.createBill(p(x).data),
  'bill.update': (x) => swallow404(overviewApi.updateBill(resolveId(p(x).id), p(x).data)),
  'bill.pay': (x) => swallow404(overviewApi.payBill(resolveId(p(x).id))),
  'bill.delete': (x) => idempotentDelete(overviewApi.deleteBill(resolveId(p(x).id))),

  'goal.create': (x) => overviewApi.createGoal(p(x).data),
  'goal.update': (x) => overviewApi.updateGoal(p(x).id, p(x).data),
  'goal.delete': (x) => idempotentDelete(overviewApi.deleteGoal(p(x).id)),

  'loan.create': (x) => overviewApi.createLoan(p(x).data),
  'loan.update': (x) => swallow404(overviewApi.updateLoan(resolveId(p(x).id), p(x).data)),
  'loan.delete': (x) => idempotentDelete(overviewApi.deleteLoan(resolveId(p(x).id))),

  'budget.create': (x) => overviewApi.createBudget(p(x).data),
  'budget.update': (x) => overviewApi.updateBudget(p(x).id, p(x).data),

  'budgetSettings.save': (x) => overviewApi.saveBudgetSettings(p(x).data),
  'budgetLine.create': (x) => overviewApi.createBudgetLine(p(x).data),
  'budgetLine.update': (x) => overviewApi.updateBudgetLine(p(x).id, p(x).data),
  'budgetLine.delete': (x) => idempotentDelete(overviewApi.deleteBudgetLine(p(x).id)),
  'customCategory.create': (x) => overviewApi.createCustomCategory(p(x).data),
  'customCategory.delete': (x) => idempotentDelete(overviewApi.deleteCustomCategory(p(x).id)),

  // Phase 2B — merchant recognition + rules
  'merchant.create': (x) => overviewApi.createMerchant(p(x).data),
  'merchant.update': (x) => swallow404(overviewApi.updateMerchant(resolveId(p(x).id), p(x).data)),
  'merchant.delete': (x) => idempotentDelete(overviewApi.deleteMerchant(resolveId(p(x).id))),
  'merchantAlias.create': (x) => overviewApi.createMerchantAlias(p(x).data),
  'merchantAlias.delete': (x) => idempotentDelete(overviewApi.deleteMerchantAlias(resolveId(p(x).id))),
  'rule.create': (x) => overviewApi.createTransactionRule(p(x).data),
  'rule.update': (x) => swallow404(overviewApi.updateTransactionRule(resolveId(p(x).id), p(x).data)),
  'rule.delete': (x) => idempotentDelete(overviewApi.deleteTransactionRule(resolveId(p(x).id))),

  // Phase 2C — recurring series + transaction splits
  'recurringSeries.create': (x) => overviewApi.createRecurringSeries(p(x).data),
  'recurringSeries.update': (x) => swallow404(overviewApi.updateRecurringSeries(resolveId(p(x).id), p(x).data)),
  'recurringSeries.delete': (x) => idempotentDelete(overviewApi.deleteRecurringSeries(resolveId(p(x).id))),
  'split.create': (x) => overviewApi.createTransactionSplit(p(x).data),
  'split.deleteFor': (x) => idempotentDelete(overviewApi.deleteTransactionSplitsFor(resolveId(p(x).id))),
  'split.delete': (x) => idempotentDelete(overviewApi.deleteTransactionSplit(resolveId(p(x).id))),

  'payment.create': (x) => accountsApi.createPayment(resolveId(p(x).creditCardId), p(x).data),
  'payment.update': (x) => accountsApi.updatePayment(resolveId(p(x).creditCardId), resolveId(p(x).id), p(x).data),

  'statement.create': (x) => accountsApi.createStatement(resolveId(p(x).creditCardId), p(x).data),
  'statement.update': (x) => swallow404(accountsApi.updateStatement(resolveId(p(x).creditCardId), resolveId(p(x).id), p(x).data)),
};

const successHandlers: Record<string, SuccessHandler> = {};

/** dataService registers id-swap / recompute handlers here at module load. */
export function registerSyncSuccess(kind: string, fn: SuccessHandler): void {
  successHandlers[kind] = fn;
}

// ── Human-readable description of a queued write: a noun + the section it lives in.
// Used to tell the user exactly what couldn't be saved and where to re-enter it.
interface ItemDescription { label: string; route: string }

const SECTIONS: Record<string, { noun: string; route: string }> = {
  account:      { noun: 'account',      route: '/accounts' },
  card:         { noun: 'credit card',  route: '/accounts' },
  transaction:  { noun: 'transaction',  route: '/accounts?tab=transactions' },
  subscription: { noun: 'subscription', route: '/accounts?tab=subscriptions' },
  investment:   { noun: 'investment',   route: '/investments' },
  sale:         { noun: 'sale',          route: '/investments' },
  super:        { noun: 'super fund',   route: '/investments' },
  income:       { noun: 'income entry', route: '/income' },
  bill:         { noun: 'bill',         route: '/' },
  goal:         { noun: 'goal',         route: '/' },
  loan:         { noun: 'loan',         route: '/accounts?tab=loans' },
  budget:       { noun: 'budget',       route: '/' },
  budgetSettings: { noun: 'budget settings', route: '/' },
  budgetLine:   { noun: 'budget item',  route: '/' },
  customCategory: { noun: 'category',   route: '/' },
  merchant:     { noun: 'merchant',     route: '/accounts?tab=transactions' },
  merchantAlias: { noun: 'merchant mapping', route: '/accounts?tab=transactions' },
  rule:         { noun: 'transaction rule', route: '/accounts?tab=transactions' },
  recurringSeries: { noun: 'recurring series', route: '/accounts?tab=subscriptions' },
  split:        { noun: 'split',        route: '/accounts?tab=transactions' },
  payment:      { noun: 'payment',      route: '/accounts' },
};

function describeItem(item: SyncQueueItem): ItemDescription {
  const prefix = item.kind.split('.')[0];
  const section = SECTIONS[prefix] ?? { noun: 'item', route: '/' };
  const data = (item.payload.data ?? {}) as { name?: string; merchant?: string };
  const name = data.name || data.merchant;
  const label = name ? `${name} ${section.noun}` : `a ${section.noun}`;
  return { label, route: section.route };
}

// Raise (or refresh) the persistent "couldn't be saved" notification. Aggregates
// every permanently-failed item so the user sees one entry listing all of them,
// and links to the section of the first affected item so they can re-enter it.
function notifyPermanentFailure(items: SyncQueueItem[]): void {
  if (items.length === 0) return;
  const s = useStore.getState();
  const newLabels = items.map(i => describeItem(i).label);

  // Merge with any still-unread sync notification so repeated failures accumulate.
  const existing = s.notifications.find(n => n.type === 'sync' && !n.is_read);
  const prevLabels = existing?.detail ? existing.detail.split(', ') : [];
  const allLabels = Array.from(new Set([...prevLabels, ...newLabels]));

  const notif: Notification = {
    id: typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `sync-notif-${Date.now()}`,
    type: 'sync',
    message: "Some data couldn't be saved — tap to see what's affected",
    detail: allLabels.join(', '),
    link: describeItem(items[0]).route,
    is_read: false,
    created_at: new Date().toISOString(),
  };
  const withoutOldSync = s.notifications.filter(n => !(n.type === 'sync' && !n.is_read));
  s.setNotifications([notif, ...withoutOldSync]);
}

function genQid(): string {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `sync-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function runSuccess(kind: string, srv: unknown, payload: Record<string, unknown>): void {
  try {
    successHandlers[kind]?.(srv, payload);
  } catch (e) {
    console.warn('[sync] success handler threw for', kind, e);
  }
}

/**
 * Fire a backend write with one automatic retry. On a second failure the write is
 * parked in the persisted queue for replay on next load. Never throws.
 */
export function syncWithRetry(kind: string, payload: Record<string, unknown>): void {
  const exec = executors[kind];
  if (!exec) {
    console.warn('[sync] no executor registered for kind:', kind);
    return;
  }

  exec(payload)
    .then((srv) => runSuccess(kind, srv, payload))
    .catch((err: unknown) => {
      console.warn(`[sync] ${kind} failed (attempt 1) — retrying in ${RETRY_DELAY_MS / 1000}s:`, err);
      setTimeout(() => {
        exec(payload)
          .then((srv) => runSuccess(kind, srv, payload))
          .catch((err2: unknown) => {
            console.warn(`[sync] ${kind} failed (attempt 2) — queueing for next load:`, err2);
            const s = useStore.getState();
            s.enqueueSync({ qid: genQid(), kind, payload, attempts: 2, lastError: String(err2) });
            s.setSyncToast(SYNC_TOAST_MSG);
          });
      }, RETRY_DELAY_MS);
    });
}

/**
 * Replay every queued write once.
 *
 * @param countAttempts When true (automatic app-load retry), each failure advances
 *   the item's attempt count toward MAX_ATTEMPTS and an exhausted item is dropped +
 *   reported. When false (user-initiated "Retry now"), failures leave the item's
 *   attempt count untouched so manual retries can never prematurely exhaust an item.
 */
async function replayQueue(countAttempts: boolean): Promise<void> {
  const queue = useStore.getState().pendingSyncQueue;
  if (queue.length === 0) return;

  const exhausted: SyncQueueItem[] = [];

  for (const item of queue) {
    const exec = executors[item.kind];
    if (!exec) {
      // Unknown kind (e.g. removed in a later build) — drop it so it can't wedge.
      useStore.getState().dequeueSync(item.qid);
      continue;
    }
    try {
      const srv = await exec(item.payload);
      runSuccess(item.kind, srv, item.payload);
      useStore.getState().dequeueSync(item.qid);
    } catch (err: unknown) {
      if (!countAttempts) {
        // Manual retry — leave the item (and its attempt count) exactly as it was.
        console.warn('[sync] manual retry still failing (no attempt charged):', item.kind, err);
        continue;
      }
      const nextAttempts = item.attempts + 1;
      if (nextAttempts >= MAX_ATTEMPTS) {
        // Final attempt failed — give up retrying and surface it for manual re-entry.
        console.warn('[sync] queued item permanently failed:', item.kind, err);
        exhausted.push(item);
        useStore.getState().dequeueSync(item.qid);
      } else {
        console.warn(`[sync] queued item still failing (attempt ${nextAttempts}):`, item.kind, err);
        useStore.getState().bumpSyncAttempt(item.qid, String(err));
      }
    }
  }

  if (exhausted.length > 0) notifyPermanentFailure(exhausted);

  if (useStore.getState().pendingSyncQueue.length > 0) {
    useStore.getState().setSyncToast(SYNC_TOAST_MSG);
  }
}

/**
 * Automatic replay — called from bootstrapData() on each app load. Failures count
 * toward the 5-attempt limit; exhausted items are dropped and reported.
 */
export function retryPendingSync(): Promise<void> {
  return replayQueue(true);
}

/**
 * User-initiated replay — called from the "Retry now" banner. Attempts every queued
 * write immediately but does NOT charge a failed attempt, so repeatedly tapping
 * Retry can never push an item to permanent failure. Successful items are still
 * removed from the queue as normal.
 */
export function retryPendingSyncNow(): Promise<void> {
  return replayQueue(false);
}
