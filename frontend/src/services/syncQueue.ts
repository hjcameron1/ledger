/**
 * Central Supabase-write retry layer.
 *
 * Every backend write in dataService goes through syncWithRetry() instead of a
 * bare `.catch(console.warn)`. The write is parked in the persisted
 * pendingSyncQueue THE MOMENT it is issued and removed only when the server
 * confirms (or permanently refuses) it — so a reload or navigation while the
 * request is still in flight can never lose a write the UI already showed as
 * saved. Behaviour on failure:
 *   1. First failure → retry once after 3 seconds.
 *   2. Second failure → the write stays parked and a small non-blocking toast
 *      surfaces ("Some data couldn't sync — will retry").
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
import { accountsApi, investmentsApi, incomeApi, overviewApi, insuranceApi } from './api';
import { isDemoSession } from '../config/demo';

const RETRY_DELAY_MS = 3000;
const SYNC_TOAST_MSG = "Some data couldn't sync — will retry";
const REFUSED_TOAST_MSG = "A change wasn't allowed and won't be retried — tap the bell for details";

/**
 * "Will not be allowed" vs "will work later". A 403 (not permitted), 400 or 422
 * (the server rejected the write itself) will come back identical on every
 * retry — parking one in the queue burned five attempts to learn nothing and
 * told the user "will retry" about a write that never could. Network failures,
 * 5xx and 429 stay retryable. 401 is deliberately NOT here: it means the
 * session, not the write, and the API layer's re-auth handling owns it.
 */
function isRefusal(err: unknown): boolean {
  const status = (err as { response?: { status?: number } })?.response?.status;
  return status === 400 || status === 403 || status === 422;
}
// Total attempts before a write is considered permanently failed: the initial try
// + the 3s retry (= 2, the attempts value at enqueue time) followed by one bump per
// app load. At attempt 5 we give up and raise a persistent notification instead.
const MAX_ATTEMPTS = 5;

type Executor = (payload: Record<string, unknown>) => Promise<unknown>;
type SuccessHandler = (serverRecord: unknown, payload: Record<string, unknown>) => void;

// ── Dispatch table: kind → API call. Payload carries everything needed to replay.
// Shapes: create → { recordId, data }; update → { id, data }; delete/pay → { id };
// payment → { recordId?/id, creditCardId, data }.
const p = (o: Record<string, unknown>) => o as { id: string; recordId: string; creditCardId: string; data: object; sold?: boolean; key: string; delta?: number };

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

// Resolve a foreign-key field INSIDE a create payload (not the record's own id)
// through the temp→server idMap, so a create that references another local record
// targets that record's real server id. Returns a shallow copy with the field
// remapped; leaves the payload untouched when the field is absent.
const resolveFk = (data: object, field: string): object => {
  const d = data as Record<string, unknown>;
  const v = d[field];
  return typeof v === 'string' && v ? { ...d, [field]: resolveId(v) } : data;
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

// client_id = the record's local uuid, sent as an idempotency key on every
// create: if a reload replays a create the server already committed (response
// lost mid-flight), the backend returns the existing row instead of inserting
// a twin. Degrades gracefully — a backend/table without the column ignores it.
function withClientId(data: object, x: Record<string, unknown>): object {
  const rid = p(x).recordId;
  return typeof rid === 'string' && rid ? { ...(data as Record<string, unknown>), client_id: rid } : data;
}

const executors: Record<string, Executor> = {
  'account.create': (x) => accountsApi.createAccount(withClientId(p(x).data, x)),
  'account.update': (x) => swallow404(accountsApi.updateAccount(resolveId(p(x).id), p(x).data)),
  'account.delete': (x) => idempotentDelete(accountsApi.deleteAccount(p(x).id)),

  'card.create': (x) => accountsApi.createCreditCard(withClientId(p(x).data, x)),
  // resolveId for the same reason as transaction.update: a card created offline
  // carries a local id until its create lands, and an edit queued in between has
  // to follow the map to the real row rather than 404 on the dead one.
  'card.update': (x) => swallow404(accountsApi.updateCreditCard(resolveId(p(x).id), p(x).data)),
  'card.delete': (x) => idempotentDelete(accountsApi.deleteCreditCard(p(x).id)),

  // Balance moves that accompany a transaction add/delete/transfer. Deltas, not
  // absolutes, so a queued pair of moves lands correctly in either order — and
  // the backend applies them to the real row even on someone else's shared
  // account (a transaction's arithmetic isn't a change proposal).
  'account.adjust': (x) => swallow404(accountsApi.adjustAccountBalance(resolveId(p(x).id), p(x).delta as number)),
  'card.adjust': (x) => swallow404(accountsApi.adjustCreditCardBalance(resolveId(p(x).id), p(x).delta as number)),

  // client_id = the transaction's local uuid, sent as an idempotency key: if a
  // reload replays a create the server already committed (response lost mid-
  // flight), the backend returns the existing row instead of inserting a twin.
  // account_id rides the idMap so a create replayed after its account reconciled
  // lands with the real account id rather than needing the post-create heal.
  'transaction.create': (x) => accountsApi.createTransaction(withClientId(resolveFk(p(x).data, 'account_id'), x)),
  // resolveId: a transaction's id changes local→server on create (Postgres mints the
  // UUID), so an update queued before that reconciled must follow the id map to the
  // real row instead of 404ing on the dead local id.
  'transaction.update': (x) => swallow404(accountsApi.updateTransaction(resolveId(p(x).id), p(x).data)),
  'transaction.delete': (x) => idempotentDelete(accountsApi.deleteTransaction(p(x).id)),

  'subscription.create': (x) => accountsApi.createSubscription(withClientId(p(x).data, x)),
  'subscription.update': (x) => accountsApi.updateSubscription(p(x).id, p(x).data),
  'subscription.delete': (x) => idempotentDelete(accountsApi.deleteSubscription(p(x).id)),

  'investment.create': (x) => investmentsApi.createInvestment(withClientId(p(x).data, x)),
  'investment.update': (x) => investmentsApi.updateInvestment(p(x).id, p(x).data),
  'investment.delete': (x) => idempotentDelete(investmentsApi.deleteInvestment(p(x).id, p(x).sold === true)),
  'sale.create': (x) => investmentsApi.createSale(withClientId(p(x).data, x)),
  'sale.delete': (x) => idempotentDelete(investmentsApi.deleteSale(p(x).id)),

  // Phase 5.7 — the durable parcel book. Every id here was minted by the client
  // and every write is an upsert on it, so a replay converges instead of
  // recording the same acquisition twice; there is no temp→server id to follow
  // for that reason. investment_id IS followed through the idMap, because the
  // holding a parcel belongs to may still have been carrying its local id when
  // the parcel was written down.
  'cgtParcel.save': (x) => investmentsApi.saveCgtParcel(resolveFk(p(x).data, 'investment_id')),
  'cgtParcel.delete': (x) => idempotentDelete(investmentsApi.deleteCgtParcel(p(x).id)),
  'cgtSplit.save': (x) => investmentsApi.saveCgtSplit(resolveFk(p(x).data, 'investment_id')),
  'cgtSplit.delete': (x) => idempotentDelete(investmentsApi.deleteCgtSplit(p(x).id)),
  'cgtHolding.forget': (x) => idempotentDelete(investmentsApi.forgetCgtHolding(resolveId(p(x).id))),
  // The whole allocation for one disposal, replaced at once: half of an old set
  // beside half of a new one is a cost base nobody paid. The sale id is used
  // LITERALLY — deliberately not through the idMap: when a disposal's id changes
  // local→server, dataService clears the old set and writes the new one, and
  // resolving both through the map would aim them at the same place and leave
  // the orphan behind.
  'cgtAllocations.save': (x) => investmentsApi.saveCgtAllocations(p(x).id, p(x).data),
  'cgtOpening.save': (x) => investmentsApi.saveCgtOpening(p(x).data),

  'super.create': (x) => investmentsApi.createSuper(withClientId(p(x).data, x)),
  'super.update': (x) => investmentsApi.updateSuper(p(x).id, p(x).data),
  'super.delete': (x) => idempotentDelete(investmentsApi.deleteSuper(p(x).id)),

  'income.create': (x) => incomeApi.createIncome(withClientId(p(x).data, x)),
  'income.update': (x) => incomeApi.updateIncome(p(x).id, p(x).data),
  'income.delete': (x) => idempotentDelete(incomeApi.deleteIncome(p(x).id)),
  'income.approve': (x) => incomeApi.approveIncome(p(x).id),

  'bill.create': (x) => overviewApi.createBill(withClientId(p(x).data, x)),
  'bill.update': (x) => swallow404(overviewApi.updateBill(resolveId(p(x).id), p(x).data)),
  'bill.pay': (x) => swallow404(overviewApi.payBill(resolveId(p(x).id))),
  'bill.delete': (x) => idempotentDelete(overviewApi.deleteBill(resolveId(p(x).id))),

  // Postgres mints the goal's real id on create, so an update/delete queued
  // before that reconciled must follow the temp→server map or it targets an id
  // the server never had. Its contributions carry the same temp id in goal_id,
  // hence resolveFk on the create payload.
  'goal.create': (x) => overviewApi.createGoal(withClientId(p(x).data, x)),
  'goal.update': (x) => swallow404(overviewApi.updateGoal(resolveId(p(x).id), p(x).data)),
  'goal.delete': (x) => idempotentDelete(overviewApi.deleteGoal(resolveId(p(x).id))),

  'goalContribution.create': (x) => overviewApi.createGoalContribution(withClientId(resolveFk(p(x).data, 'goal_id'), x)),
  'goalContribution.update': (x) => swallow404(overviewApi.updateGoalContribution(resolveId(p(x).id), p(x).data)),
  'goalContribution.delete': (x) => idempotentDelete(overviewApi.deleteGoalContribution(resolveId(p(x).id))),

  // Phase 4.4 alert state. Keyed by the alert's own key rather than a row id,
  // and written as an upsert, so replaying a queued write — after a reload, or
  // alongside another device's — converges instead of duplicating. Nothing to
  // resolve through the id map for the same reason: the key IS the identity.
  'alertState.save': (x) => overviewApi.saveAlertState(p(x).data),
  'alertState.delete': (x) => idempotentDelete(overviewApi.deleteAlertState(String(p(x).key))),

  'loan.create': (x) => overviewApi.createLoan(withClientId(p(x).data, x)),
  'loan.update': (x) => swallow404(overviewApi.updateLoan(resolveId(p(x).id), p(x).data)),
  'loan.delete': (x) => idempotentDelete(overviewApi.deleteLoan(resolveId(p(x).id))),

  // Phase 4.2 loan movements. A loan added offline still carries its temp id, so
  // loan_id is mapped through idMap on the way out — same reason a property's
  // mortgage link is. There is no update: an event records what happened, and
  // correcting one means deleting it and recording the truth.
  'loanEvent.create': (x) => overviewApi.createLoanEvent(withClientId(resolveFk(p(x).data, 'loan_id'), x)),
  'loanEvent.delete': (x) => idempotentDelete(overviewApi.deleteLoanEvent(resolveId(p(x).id))),

  // A property's loan_id is a FK to loans(id). A mortgage added offline still
  // carries its temp id locally, so the link must be mapped through idMap on the
  // way out — on create AND on update, since a property is often linked to its
  // loan after the fact. Without it the server rejects an id it never had, and
  // the property would arrive on the other device unencumbered.
  'property.create': (x) => overviewApi.createProperty(withClientId(resolveFk(p(x).data, 'loan_id'), x)),
  'property.update': (x) => swallow404(overviewApi.updateProperty(resolveId(p(x).id), resolveFk(p(x).data, 'loan_id'))),
  'property.delete': (x) => idempotentDelete(overviewApi.deleteProperty(resolveId(p(x).id))),

  // Phase 8.2 insurance. Same id-resolution reason as every other create/update
  // pair: Postgres mints the policy's real id, so an edit queued before that
  // reconciled must follow the temp→server map or it targets an id the server
  // never had. A premium record's policy_id is the same problem one level down,
  // hence resolveFk on the create payload.
  'insurance.create': (x) => insuranceApi.create(withClientId(p(x).data, x)),
  'insurance.update': (x) => swallow404(insuranceApi.update(resolveId(p(x).id), p(x).data)),
  'insurance.delete': (x) => idempotentDelete(insuranceApi.remove(resolveId(p(x).id))),
  'insurancePremium.create': (x) => insuranceApi.createPremiumRecord(withClientId(resolveFk(p(x).data, 'policy_id'), x)),
  'insurancePremium.delete': (x) => idempotentDelete(insuranceApi.deletePremiumRecord(resolveId(p(x).id))),

  // A budget's id changes local→server on create, so update/delete must resolve
  // it (same reason as transaction.update) or they'd target an id the server
  // never had.
  'budget.create': (x) => overviewApi.createBudget(p(x).data),
  'budget.update': (x) => swallow404(overviewApi.updateBudget(resolveId(p(x).id), p(x).data)),
  'budget.delete': (x) => idempotentDelete(overviewApi.deleteBudget(resolveId(p(x).id))),

  'budgetSettings.save': (x) => overviewApi.saveBudgetSettings(p(x).data),
  'budgetLine.create': (x) => overviewApi.createBudgetLine(p(x).data),
  'budgetLine.update': (x) => overviewApi.updateBudgetLine(p(x).id, p(x).data),
  'budgetLine.delete': (x) => idempotentDelete(overviewApi.deleteBudgetLine(p(x).id)),
  'customCategory.create': (x) => overviewApi.createCustomCategory(p(x).data),
  'customCategory.delete': (x) => idempotentDelete(overviewApi.deleteCustomCategory(p(x).id)),
  // Bill↔subscription "Different bills" exclusions — keyed by the stable anchor
  // decision_key, so both create and delete are key-based (no id reconciliation).
  // swallow404 on create: until the migration + route deploy the endpoint 404s, but
  // the localStorage cache already holds the decision, so treat it as idempotent
  // success rather than a failed write (it re-syncs once the backend is live).
  'billSubExclusion.create': (x) => swallow404(overviewApi.createBillSubExclusion(p(x).data)),
  'billSubExclusion.delete': (x) => idempotentDelete(overviewApi.deleteBillSubExclusion(p(x).key)),

  // Phase 2B — merchant recognition + rules
  'merchant.create': (x) => overviewApi.createMerchant(p(x).data),
  'merchant.update': (x) => swallow404(overviewApi.updateMerchant(resolveId(p(x).id), p(x).data)),
  'merchant.delete': (x) => idempotentDelete(overviewApi.deleteMerchant(resolveId(p(x).id))),
  // The alias's merchant_id is a FK to merchants(id). The referenced merchant is
  // created locally with a temp id and only gets its real server id once
  // merchant.create syncs — so map merchant_id through the same temp→server idMap,
  // otherwise the server rejects the FK (500). merchant.create is enqueued first,
  // so by the time this runs the mapping exists; if not, it re-queues and self-heals.
  'merchantAlias.create': (x) => overviewApi.createMerchantAlias(resolveFk(p(x).data, 'merchant_id')),
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

  'payment.create': (x) => accountsApi.createPayment(resolveId(p(x).creditCardId), withClientId(p(x).data, x)),
  'payment.update': (x) => accountsApi.updatePayment(resolveId(p(x).creditCardId), resolveId(p(x).id), p(x).data),
  'payment.delete': (x) => idempotentDelete(accountsApi.deletePayment(resolveId(p(x).creditCardId), resolveId(p(x).id))),

  'statement.create': (x) => accountsApi.createStatement(resolveId(p(x).creditCardId), withClientId(p(x).data, x)),
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
  cgtParcel:    { noun: 'purchase parcel', route: '/tax' },
  cgtSplit:     { noun: 'share split',   route: '/investments' },
  cgtHolding:   { noun: 'parcel record', route: '/tax' },
  cgtAllocations: { noun: 'sale cost record', route: '/tax' },
  cgtOpening:   { noun: 'carried-forward capital loss', route: '/tax' },
  super:        { noun: 'super fund',   route: '/investments' },
  income:       { noun: 'income entry', route: '/income' },
  bill:         { noun: 'bill',         route: '/' },
  goal:         { noun: 'goal',         route: '/' },
  goalContribution: { noun: 'goal contribution', route: '/' },
  loan:         { noun: 'loan',         route: '/accounts?tab=loans' },
  loanEvent:    { noun: 'loan movement', route: '/accounts?tab=loans' },
  property:     { noun: 'property',     route: '/investments?tab=Property' },
  insurance:    { noun: 'insurance policy', route: '/insurance' },
  insurancePremium: { noun: 'premium record', route: '/insurance' },
  budget:       { noun: 'budget',       route: '/' },
  budgetSettings: { noun: 'budget settings', route: '/' },
  budgetLine:   { noun: 'budget item',  route: '/' },
  customCategory: { noun: 'category',   route: '/' },
  billSubExclusion: { noun: 'bill match decision', route: '/' },
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
function notifyPermanentFailure(items: SyncQueueItem[], flavour: 'failed' | 'refused' = 'failed'): void {
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
    // A refusal and a failure are different news: one needs permission (or a
    // different value), the other just needs the network back.
    message: flavour === 'refused'
      ? "A change wasn't allowed to be saved — tap to see what was refused"
      : "Some data couldn't be saved — tap to see what's affected",
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

// Queue items whose request is being attempted RIGHT NOW in this session.
// replayQueue() must skip these: the item is in the persisted queue from the
// moment it's issued (enqueue-first), and a bootstrap refetch that runs while
// the first attempt is still in flight would otherwise execute it a second time.
const inFlight = new Set<string>();

/**
 * Fire a backend write with one automatic retry. The write is parked in the
 * persisted queue FIRST — before the request is even sent — and dequeued only on
 * server confirmation or permanent refusal, so a reload mid-flight leaves it
 * queued for replay on next load instead of silently losing it. Never throws.
 */
export function syncWithRetry(kind: string, payload: Record<string, unknown>): void {
  // Demo sessions have no server account — every write is local-only by design.
  // Queueing them would just fill the banner with writes that can never land.
  if (isDemoSession(useStore.getState().token)) return;

  const exec = executors[kind];
  if (!exec) {
    console.warn('[sync] no executor registered for kind:', kind);
    return;
  }

  // Park it before the network is touched. Zustand persist writes localStorage
  // synchronously on this state change, so the write survives an immediate reload.
  const qid = genQid();
  useStore.getState().enqueueSync({ qid, kind, payload, attempts: 0, lastError: '' });
  inFlight.add(qid);

  const settle = (): void => { inFlight.delete(qid); };

  const confirm = (srv: unknown): void => {
    // Dequeue BEFORE the success handler runs — a handler exception must not
    // leave a confirmed write queued (a later replay would duplicate it).
    useStore.getState().dequeueSync(qid);
    settle();
    runSuccess(kind, srv, payload);
  };

  const refuse = (err: unknown): void => {
    console.warn(`[sync] ${kind} refused by the server — not retrying:`, err);
    const s = useStore.getState();
    s.dequeueSync(qid);
    settle();
    notifyPermanentFailure([{ qid, kind, payload, attempts: 1, lastError: String(err) }], 'refused');
    s.setSyncToast(REFUSED_TOAST_MSG);
  };

  const recordAttempts = (n: number, err: unknown): void => {
    const s = useStore.getState();
    s.setPendingSyncQueue(s.pendingSyncQueue.map((i) =>
      i.qid === qid ? { ...i, attempts: n, lastError: String(err) } : i
    ));
  };

  exec(payload)
    .then(confirm)
    .catch((err: unknown) => {
      if (isRefusal(err)) { refuse(err); return; }
      console.warn(`[sync] ${kind} failed (attempt 1) — retrying in ${RETRY_DELAY_MS / 1000}s:`, err);
      recordAttempts(1, err);
      setTimeout(() => {
        exec(payload)
          .then(confirm)
          .catch((err2: unknown) => {
            if (isRefusal(err2)) { refuse(err2); return; }
            console.warn(`[sync] ${kind} failed (attempt 2) — staying queued for next load:`, err2);
            recordAttempts(2, err2);
            settle();
            useStore.getState().setSyncToast(SYNC_TOAST_MSG);
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
  if (isDemoSession(useStore.getState().token)) return;
  const queue = useStore.getState().pendingSyncQueue;
  if (queue.length === 0) return;

  const exhausted: SyncQueueItem[] = [];
  const refused: SyncQueueItem[] = [];

  for (const item of queue) {
    // Enqueue-first means an item can be in the queue while its own request is
    // still in flight in THIS session — replaying it now would send it twice.
    if (inFlight.has(item.qid)) continue;
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
      if (isRefusal(err)) {
        // The server said no, not "not now" — retrying cannot change the
        // answer, so the item leaves the queue on ANY replay (manual included)
        // and is reported as refused rather than as a network casualty.
        console.warn('[sync] queued item refused by the server — dropping:', item.kind, err);
        refused.push(item);
        useStore.getState().dequeueSync(item.qid);
        continue;
      }
      if (!countAttempts) {
        // Manual retry — leave the item (and its attempt count) exactly as it was.
        console.warn('[sync] manual retry still failing (no attempt charged):', item.kind, err);
        continue;
      }
      // Jump straight to 2 for an item cut short mid-flight by a reload
      // (attempts 0/1): it has now genuinely failed a replay, so it should be
      // visible in the "waiting to sync" banner immediately, not two loads later.
      const nextAttempts = Math.max(item.attempts + 1, 2);
      if (nextAttempts >= MAX_ATTEMPTS) {
        // Final attempt failed — give up retrying and surface it for manual re-entry.
        console.warn('[sync] queued item permanently failed:', item.kind, err);
        exhausted.push(item);
        useStore.getState().dequeueSync(item.qid);
      } else {
        console.warn(`[sync] queued item still failing (attempt ${nextAttempts}):`, item.kind, err);
        const s = useStore.getState();
        s.setPendingSyncQueue(s.pendingSyncQueue.map((i) =>
          i.qid === item.qid ? { ...i, attempts: nextAttempts, lastError: String(err) } : i
        ));
      }
    }
  }

  if (exhausted.length > 0) notifyPermanentFailure(exhausted);
  if (refused.length > 0) notifyPermanentFailure(refused, 'refused');

  // Only items that actually failed count — a write that is simply still in
  // flight (enqueue-first parks everything immediately) hasn't "not synced".
  if (useStore.getState().pendingSyncQueue.some((i) => !inFlight.has(i.qid))) {
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
