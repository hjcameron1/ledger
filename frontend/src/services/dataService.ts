/**
 * Local-first data service.
 * All operations update Zustand (persisted to localStorage) immediately.
 * Backend sync is attempted silently in the background — never blocks the UI.
 * Call bootstrapData() after login to load fresh server data into the store.
 */

import { useStore } from '../store';
import type {
  BankAccount, CreditCard, Transaction, Subscription,
  Investment, SuperFund, IncomeEntry, Bill, Goal, GoalContribution, Loan, LoanEvent, Property, Budget,
  BudgetSettings, BudgetLine, CustomCategory,
  Notification, NetWorthSnapshot, PendingPayment, InvestmentSale,
  CreditCardStatement, CcPaymentPrompt,
  Merchant, MerchantAlias, TransactionRule, RuleCondition, RuleAction,
  RecurringSeries, RecurringKind, TransactionSplit, ReviewReason,
  AlertState,
  Household, HouseholdMember, HouseholdInvitation, FinanceScope, Shareable,
  RecordShare, ShareCode, ShareRecordType, SharePermission, ResponsibilityLine,
  InsurancePolicy, InsurancePremiumRecord,
} from '../types';
import { verifyInvestment } from '../utils/investmentVerification';
import { autoCategory, getDisplayTimeZone, financialYearOf, formatCurrency } from '../utils/format';
import {
  buildCashFlowForecast,
  type RecurringInput,
  type AccountBalanceInput,
  type CashFlowForecast,
  type ForecastFrequency,
} from '../utils/cashFlowForecast';
import { learnFromHistory, type HistoryTxn } from '../utils/adaptiveForecast';
import {
  stampIngest, findTransferMatch, classifyDuplicate, CC_PAYMENT_PATTERNS,
  resolveTransferSiblings,
  computeTransferExclusionIds, isSpendTransaction, isTransferTransaction,
  isRefundTransaction, effectiveAmount, spendAmount, spendByCategory,
  totalIncomeInflow, netMovement, totalSpend, incomeInflowAmount,
  type SpendOptions,
} from '../utils/transactionCore';
import { classifyTransaction } from '../utils/transactionClassify';
import { planCorrection, type CorrectionMatch } from '../utils/corrections';
import { resolveMerchant, merchantMatchToken } from '../utils/merchantResolution';
import { normaliseMerchant, isTransferMerchant, detectInternalTransferIds, type RecurringPattern } from '../utils/recurringDetection';
import { classifyRefund } from '../utils/refundMatching';
import { isTransactionReconciled, linkedCardPayments, buildCardPaymentLeg } from '../utils/cardPaymentReconciliation';
import {
  selectAiFallbackCandidates, toAiClassifyItem, planAiSuggestion, needsAiFallback,
} from '../utils/aiClassification';
import { mergeCategories } from '../utils/categories';
import {
  categoryKey, sameCategory, tidyCategoryName, resolveCategoryName, resolvedName,
  rememberDecision, pruneAliases, type CategoryResolution,
} from '../utils/categoryResolve';
import {
  countCategoryUsage, planCategoryDeletion, undeletableReason,
  type CategoryUsage, type UsageSources,
} from '../utils/categoryUsage';
import { UNCATEGORISED } from '../utils/categoryTaxonomy';
import {
  buildGoalReport, toGoalInput, toContributionInput,
  type GoalCapacity,
  type GoalInput,
  type GoalReport,
  type ContributionInput,
  type SourceValue,
} from '../utils/savingsGoals';
import {
  buildContext, scopeRows, householdRows,
  activeHouseholdId as resolveActiveHouseholdId, inAnyHousehold,
  planShare, planUnshare, canEdit, canView, editRefusal,
  summariseSharing, memberViews, invitationsFor, liveInvitations,
  memberRows, byResponsibility, responsibleFor, householdsOf,
  can as householdCan, roleIn as householdRoleIn, activeMembers, myHouseholds,
  activeHousehold,
  roleCan,
  type HouseholdContext, type SharingSummary,
} from '../utils/household';
import {
  memberSpending, validateResponsibilitySplit, paidBy as paidByOf,
  type MemberSpendingRow,
} from '../utils/sharedSpending';
import {
  buildSharingContext, visibleRecords, sharedWithMeRecords,
  canEditRecord, editRecordRefusal, canDeleteRecord,
  grantsIHold, grantsIGave, sharedWith as grantsOn,
  planShareCode, planEndGrant, cascadeOfEnding,
  assignmentOf, shareTargets, sharedByMe, sharedWithMe as incomingShares,
  sharingOverview, liveCodesFor, liveCodes,
  type SharingContext,
} from '../utils/sharing';
import { patchUiPrefs, loadUiPrefs, resetUiPrefsCache } from './uiPreferences';
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
import {
  buildTaxYearPosition,
  availableTaxYears,
  fyBounds,
  type TaxYearPosition,
} from '../utils/taxYear';
import {
  estimateTaxForFY,
  displayBracketsFor,
  type RateConfidence,
} from '../utils/taxRates';
import {
  repaymentIncomeFrom,
  normaliseRepaymentIncomeAdjustments,
  emptyRepaymentIncomeAdjustments,
  hasRepaymentIncomeAdjustments,
  type RepaymentIncomeAdjustments,
} from '../utils/repaymentIncome';
import {
  normaliseTaxCredits,
  emptyTaxCredits,
  hasTaxCredits,
  type TaxCredits,
} from '../utils/taxCredits';
import {
  normaliseTaxProfile,
  emptyTaxProfile,
  hasTaxProfile,
  type TaxProfile,
} from '../utils/taxProfile';
import {
  buildCapitalGains,
  cgtAssetClassOf,
  isoDay,
  type CgtDisposal,
  type CgtParcel,
  type OpeningCapitalLosses,
} from '../utils/capitalGains';
import {
  normaliseDividendStatement,
  type DividendStatement,
} from '../utils/dividendIncome';
import type { PayslipCore } from '../utils/payroll';
import {
  buildBudgetReport, applyCategoryRename, budgetsFromLegacyPlan, monthKeyOf,
  addMonthsKey, BUDGET_OVERALL_KEY,
  type BudgetReport,
} from '../utils/budgeting';
import {
  buildAlerts,
  type AlertReport,
  type AlertStateInput,
} from '../utils/alerts';
import {
  buildInsights, insightWindows, isInsightKey,
  type Insight, type InsightReport, type RecurringCostInput, type WindowSpend, type WindowTxn,
} from '../utils/insights';
import {
  buildInsuranceReport,
  type InsuranceReport, type InsurancePolicyInput, type PremiumRecordInput,
} from '../utils/insurance';
import {
  buildReview, reviewPeriods, reviewPeriodFor, periodContaining,
  type ReviewPeriod, type ReviewPeriodKind, type ReviewReport,
} from '../utils/review';
import {
  buildPropertyReport, propertyNetWorthTotal, availableLoansForProperty, validateProperty,
  availableFundsForProperty, attributeTransactions,
  type PropertyReport, type PropertyDraft, type FundEntity,
} from '../utils/property';
import {
  buildRentalPosition, emptyRentalSettings, rentalActivityDates,
  type RentalPosition, type RentalPropertyInput, type RentalPropertySettings,
} from '../utils/rentalProperty';
import {
  buildLoanReport, applyExtraRepayment, applyRedraw, applyRepayment, redrawLimit,
  validateMovement, checkMovement, extraRepaymentScenario, offsetScenario, projectionInputForLoan, projectLoan,
  repaymentImpact, resolveOffset, todayISO,
  type LoanReport, type LoanMovementDraft, type RepaymentChange, type RepaymentImpact,
  type LoanProjection, type OffsetAccount, type MovementCheck, type ExtraRepaymentScenario,
  type OffsetScenario,
} from '../utils/loanEngine';
import {
  matchIntent, sanitiseIntent, vocabularyForModel, defaultSpendPeriod, fyOf,
  type AskIntent, type AskPeriod, type AskVocabulary,
} from '../utils/askIntent';
import {
  describeAnswer, gapsForUnresolved, coverageGap, scopeGap, resolvePhrasing,
  type AskAnswer, type AskFacts, type AskFigure, type AskGap, type AskSource,
  type CategorySlice, type MerchantSlice, type GoalFact, type OffsetFact,
  type LoanPayoffFact, type DeductionSlice, type BudgetLineFact, type BillFact,
  type ChangeFact,
} from '../utils/askAnswer';
import { describeInsight } from '../utils/insightView';
import { matchRule, type RuleCandidate } from '../utils/transactionRules';
import { validateSplits, type SplitLineInput, type SplitCategoryChoice } from '../utils/transactionSplits';
import {
  seriesFromPattern, occurrenceIdsForSeries, isSuggestionSuppressed, seriesKey,
} from '../utils/recurringSeries';
import { classifyManualAgainstSync, manualAdjustment } from '../utils/reconcile';
import { buildBillPayment, canRecordBillPayment } from '../utils/billPayment';
import {
  findReconciliationCandidates, differentDecisionKey, preferredCanonicalName,
  type ReconCandidate, type ReconBill, type ReconSubscription,
} from '../utils/billReconciliation';
import type { TransactionSource, BillSubscriptionExclusion } from '../types';
import { accountsApi, investmentsApi, incomeApi, overviewApi, smsfApi, householdsApi, sharesApi, insuranceApi, API_BASE } from './api';
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

// ─── PHASE 7.1: HOUSEHOLD SCOPE ──────────────────────────────────────────────
//
// The store now holds rows the user does not own — the ones their household
// shares with them — so "everything in the store" stopped being an answer to any
// question. `scoped()` is the answer instead, and every DS getAll() goes through
// it:
//
//   personal   the rows you OWN. Identical to what getAll() returned before 7.1
//              for anyone not in a household, because for them every row is
//              theirs. That equivalence is deliberate: a solo user's totals must
//              not move by a cent because this phase shipped.
//   household  the rows SHARED with the household, from every member, each
//              counted once. Nobody's private rows.
//
// Because the switch lives here rather than in each screen, the Personal and
// Household views are the same code reading a different slice — there is no
// second net-worth path that could drift from the first.

/** The signed-in user's household context, rebuilt from the store on demand. */
export function householdContext(): HouseholdContext {
  const s = useStore.getState();
  return buildContext(s.user?.id ?? null, s.households, s.householdMembers, s.activeHouseholdId);
}

/**
 * Phase 7.2 — the same context plus every direct grant the user is either side
 * of. Used wherever the question is "may I LOOK at this", which now has two
 * more answers than it did (see utils/sharing.ts).
 *
 * It is deliberately NOT used by anything that adds money up. Totals are
 * computed from `scoped()` below, which is ownership and household stamps and
 * nothing else — so a direct grant physically cannot reach a net worth, a budget
 * or a forecast, however many rows it puts on screen.
 */
export function sharingContext(): SharingContext {
  const s = useStore.getState();
  return buildSharingContext(
    s.user?.id ?? null, s.households, s.householdMembers,
    s.recordShares, s.activeHouseholdId, s.shareCodes,
  );
}

/** The scope the screens are currently on. Household is only ever honoured for
 *  somebody actually in one — a stale preference can't strand a user on an empty
 *  view after they leave. */
export function currentScope(): FinanceScope {
  const s = useStore.getState();
  return s.financeScope === 'household' && inAnyHousehold(householdContext())
    ? 'household'
    : 'personal';
}

/**
 * Narrow any list of shareable rows to the current scope — the ONE function
 * every total in this file is computed from.
 *
 * Ownership and household stamps only. Rows somebody granted this user directly
 * are not here and must never be: they are somebody else's money, visible but
 * not owned, and the moment they entered this function they would start being
 * counted. `visible()` below is where those rows appear instead.
 */
function scoped<T extends Shareable>(rows: T[], scope?: FinanceScope): T[] {
  return scopeRows(rows, householdContext(), scope ?? currentScope());
}

/**
 * ONLY the signed-in user's rows, in every scope. The store is a visible
 * SUPERSET — it holds rows other people shared into view — so anything personal
 * by nature (tax, the user's own annual income figure) must narrow through
 * here, never read the store raw. A missing user_id is a local-first own row.
 */
function ownRows<T extends { user_id?: string }>(rows: T[]): T[] {
  const u = useStore.getState().user?.id ?? null;
  return rows.filter(r => !u || !r.user_id || r.user_id === u);
}

/**
 * Everything the user may LOOK at, of one kind: their own rows, their
 * household's shared ones, and the ones granted to them directly. What a list
 * screen renders — never what a total sums.
 */
function visible<T extends Shareable>(kind: ShareRecordType, rows: T[]): T[] {
  return visibleRecords(kind, rows, sharingContext());
}

/**
 * Only the rows granted directly, which are by definition not the user's. The
 * "Shared with you" section: shown clearly, badged as somebody else's, and
 * counted nowhere.
 *
 * SCOPE-AWARE. A direct grant is somebody showing you ONE account of theirs — it
 * belongs to no household, so it appears only in "My Finances", the view that
 * means "everything I can see". When the ledger is pointed at a specific
 * household, that view is that household's shared picture and nothing else, so a
 * personal grant must not appear in it. Returning [] here is the whole-app fix:
 * every screen reads its "Shared with you" list through this one door, so the
 * Accounts tab, the Cards tab and the transaction lists all obey it at once.
 */
function sharedWithMeOnly<T extends Shareable>(kind: ShareRecordType, rows: T[]): T[] {
  if (currentScope() === 'household') return [];
  return sharedWithMeRecords(kind, rows, sharingContext());
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
 *
 * CRUCIAL: de-dup is per OWNER, never across owners. Two different people can
 * genuinely each bank an "Everyday" account at "CBA" — and once households/direct
 * shares are in play, another member's account arrives in this store alongside
 * your own. Collapsing those two by content would (a) hide the shared account
 * from the household view entirely and (b) worse, `addIdMapping` would remap
 * SOMEBODY ELSE'S account id onto yours, silently misrouting their transactions
 * onto your account. So rows the current user does not own are passed straight
 * through, and content keys only ever compete within the user's own rows (which
 * is the only place the replayed-create duplicate this exists for can occur).
 */
export function dedupeByContent<T extends { id: string; created_at?: string; user_id?: string | null }>(
  rows: T[],
  ownerId: string | null,
  keyOf: (r: T) => string,
): T[] {
  // Whose row is this? A missing user_id means a local-first own row (see
  // isOwnedBy) — by construction the signed-in user's. Another member's shared
  // rows are never de-dup candidates, so they pass straight through untouched.
  const owned = (r: T) => !r.user_id || r.user_id === ownerId;
  const foreign = rows.filter(r => !owned(r));
  const mine = rows.filter(owned);

  const sorted = [...mine].sort(
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
  return [...byKey.values(), ...foreign];
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
  /** The accounts in the current scope — yours, or the household's shared ones. */
  getAll(): BankAccount[] {
    return scoped(useStore.getState().accounts);
  },

  /** Every account the user may see: theirs, their households', and any shared
   *  with them directly. For pickers that have to name the account a shared
   *  transaction sits in — and for the Accounts screen, which shows the shared
   *  ones in their own section rather than mixed into the totals. */
  getVisible(): BankAccount[] {
    return visible('account', useStore.getState().accounts);
  },

  /** Accounts somebody else shared with this user. Not theirs, not in any total,
   *  and the same single row the owner is looking at. */
  sharedWithMe(): BankAccount[] {
    return sharedWithMeOnly('account', useStore.getState().accounts);
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
    return scoped(useStore.getState().creditCards);
  },

  getVisible(): CreditCard[] {
    return visible('card', useStore.getState().creditCards);
  },

  /** Cards somebody else shared with this user. Never in a total — see
   *  `accountsDS.sharedWithMe`. */
  sharedWithMe(): CreditCard[] {
    return sharedWithMeOnly('card', useStore.getState().creditCards);
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
    // Cards persist exactly like accounts do. This used to be local-only, which
    // meant a card edit — and, once sharing existed, putting a card into a
    // household — lived on this device and nowhere else: it looked like it had
    // worked, then came back un-shared on the next load and never reached the
    // other members at all.
    syncWithRetry('card.update', { id, data });

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
  const card = s.creditCards.find(c => c.id === creditCardId);
  // Move display_balance_owing in lockstep with balance_owing (× conversion rate).
  // The "Balance owing" readout renders `display_balance_owing ?? balance_owing`, so
  // updating only balance_owing left the headline figure stale (e.g. a $200 payment
  // dropped the statement to $600 left + 60% utilisation, but the top still read $800).
  const patch: Partial<CreditCard> = {
    balance_owing: Math.max(0, owing),
    display_balance_owing: Math.max(0, owing) * (card?.conversion_rate ?? 1),
  };
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
export function moveOwnerBalance(accountId: string, accountType: string, delta: number): void {
  if (!Number.isFinite(delta) || delta === 0) return;
  // getVisible, not getAll: the move must land whichever scope it started from,
  // including a shared account reached through the household view or a direct
  // grant — the transaction is real in every one of them.
  if (accountType === 'bank') {
    const acc = accountsDS.getVisible().find(a => accountIdMatches(accountId, a));
    if (acc) {
      const rate = acc.conversion_rate ?? 1;
      const s = useStore.getState();
      s.setAccounts(s.accounts.map(a => a.id === acc.id ? {
        ...a,
        balance: (a.balance ?? 0) + delta,
        display_balance: (a.display_balance ?? a.balance ?? 0) + delta * rate,
        updated_at: ts(),
      } : a));
      // A DELTA op, not account.update with an absolute balance: the server adds
      // it to its own current figure, and — unlike a member's direct balance edit,
      // which diverts into a change request — a transaction's arithmetic applies
      // to the real row without asking the owner.
      syncWithRetry('account.adjust', { id: acc.id, delta });
    }
  } else if (accountType === 'credit_card') {
    const card = creditCardsDS.getVisible().find(c => accountIdMatches(accountId, c));
    if (card) {
      const rate = card.conversion_rate ?? 1;
      const s = useStore.getState();
      s.setCreditCards(s.creditCards.map(c => c.id === card.id ? {
        ...c,
        balance_owing: (c.balance_owing ?? 0) - delta,
        display_balance_owing: (c.display_balance_owing ?? c.balance_owing ?? 0) - delta * rate,
        updated_at: ts(),
      } : c));
      // delta is "money in"; the card column is owing, so the server-side delta flips sign.
      syncWithRetry('card.adjust', { id: card.id, delta: -delta });
      // Keep the card's linked payment-reminder bill in step with the new owing
      // (same upkeep creditCardsDS.update does — this path no longer goes through it).
      const updatedCard = useStore.getState().creditCards.find(c => c.id === card.id);
      if (updatedCard?.due_date) {
        const billName = cardReminderBillName(updatedCard.name).toLowerCase();
        const linked = useStore.getState().bills.find(
          b => !b.is_paid && b.name.toLowerCase() === billName
        );
        if (linked) {
          billsDS.update(linked.id, { amount: cardReminderAmount(updatedCard), due_date: updatedCard.due_date });
        }
      }
    }
  }
}

/**
 * Reconcile one owner's MANUAL entries against a set of authoritative IMPORT rows
 * (Basiq or statement). An exact content match means the real transaction has now
 * posted → drop the manual duplicate (a bill-paid entry stays "paid", now
 * represented by the real row). A near-match becomes a 'conflict' the user resolves.
 *
 * Reuses the pure classifyManualAgainstSync policy. It only ever POSITIVELY
 * reconciles (exact → remove) or raises a conflict; it never rewinds an entry's
 * state and never touches 'kept'/'resolved' — the full lifecycle (incl. null→pending
 * seeding and conflict rewind on the near-twin disappearing) stays owned by the
 * Basiq sync pass. Safe on manual owners too: matching is content-based, independent
 * of reconcile_state, so a bill payment recorded on a manual account still de-dups
 * against a later statement import.
 */
export function reconcileManualEntries(ownerIdVariants: Set<string>, authoritative: Transaction[]): void {
  const manuals = useStore.getState().transactions.filter(
    t => ownerIdVariants.has(t.account_id) && t.source === 'manual',
  );
  for (const manual of manuals) {
    if (manual.reconcile_state === 'kept' || manual.reconcile_state === 'resolved') continue;
    const { result, candidate } = classifyManualAgainstSync(manual, authoritative);
    if (result === 'exact') {
      transactionsDS.remove(manual.id);
    } else if (result === 'conflict' && candidate) {
      if (manual.reconcile_state !== 'conflict' || manual.reconcile_match_id !== candidate.id) {
        transactionsDS.update(manual.id, { reconcile_state: 'conflict', reconcile_match_id: candidate.id });
      }
    }
  }
}

/**
 * Import-flow convenience: reconcile an owner's manual entries against EVERY
 * non-manual (basiq/statement) row it already holds. Call right after ingesting a
 * batch of statement/CSV rows so a manually-recorded bill payment (or any hand-added
 * entry) that the statement also contains doesn't pile up as a duplicate.
 */
export function reconcileOwnerAfterImport(ownerIdVariants: Set<string>): void {
  const imported = useStore.getState().transactions.filter(
    t => ownerIdVariants.has(t.account_id) && t.source !== 'manual',
  );
  reconcileManualEntries(ownerIdVariants, imported);
}

/**
 * Transactions inherit the household stamps of the account they sit on.
 *
 * Sharing an account with a household shares what happened on it — an account
 * without its transactions is a number with no explanation — and, by the same
 * law in the other direction, the activity of a household-shared account
 * belongs to that household's picture, not to "Personal finances". Derived at
 * read time from the account's stamps (the server cascades its reads the same
 * way), so un-sharing the account takes every transaction back in the same
 * instant with the same single write. A transaction's OWN stamps still apply on
 * top — an individually shared row keeps working.
 */
/**
 * Phase 7.2 — every household ONE transaction is visible to: its own stamps
 * plus its account's. The per-row twin of `withAccountStamps` below, for
 * callers holding a single transaction that may have reached them WITHOUT the
 * list-level stamping (the account detail modal, the review queue, the budget
 * drill-down all render rows straight from the store). Attribution must not
 * depend on which list a row happened to arrive through.
 */
export function transactionHouseholds(tx: Transaction): string[] {
  const s = useStore.getState();
  const carrier = [...s.accounts, ...s.creditCards].find(a => accountIdMatches(tx.account_id, a));
  return [...new Set([...householdsOf(tx), ...(carrier ? householdsOf(carrier) : [])])];
}

/**
 * May the signed-in user set who-paid / responsibility on this transaction?
 *
 * The same rule as any shared edit, stated over the REACHABLE households
 * (own stamps or the account's): your own transaction once it's in front of a
 * household at all, somebody else's only where your role can edit shared
 * money. A viewer can look at the joint account and cannot re-attribute its
 * spending — the server's refuseWrite would refuse them anyway; this keeps the
 * button honest instead of letting the refusal arrive after the save.
 */
export function canAttribute(tx: Transaction): boolean {
  const s = useStore.getState();
  const me = s.user?.id ?? null;
  const reachable = transactionHouseholds(tx);
  if (!reachable.length) return false;
  const memberships = s.householdMembers.filter(m =>
    m.user_id === me && m.status === 'active' && reachable.includes(m.household_id));
  if (!memberships.length) return false;
  if (!tx.user_id || tx.user_id === me) return true;
  return memberships.some(m => roleCan(m.role, 'edit_shared'));
}

function withAccountStamps(txns: Transaction[]): Transaction[] {
  const s = useStore.getState();
  const carriers = [...s.accounts, ...s.creditCards].filter(a => householdsOf(a).length > 0);
  if (!carriers.length) return txns;
  return txns.map(t => {
    const acct = carriers.find(a => accountIdMatches(t.account_id, a));
    if (!acct) return t;
    return { ...t, household_ids: [...new Set([...householdsOf(t), ...householdsOf(acct)])] };
  });
}

export const transactionsDS = {
  getAll(params?: { account_id?: string; search?: string; category?: string }): Transaction[] {
    let txns = scoped(withAccountStamps(useStore.getState().transactions));
    if (params?.account_id) {
      const target = resolveAccountId(params.account_id);
      txns = txns.filter(t => resolveAccountId(t.account_id) === target);
    }
    // Matched case-insensitively, the same way budgets and spend reporting match
    // a category, so an alert about "Dining" opens exactly the rows that alert
    // was counting.
    if (params?.category) {
      const key = params.category.trim().toLowerCase();
      txns = txns.filter(t => (t.category ?? '').trim().toLowerCase() === key);
    }
    if (params?.search) txns = txns.filter(t =>
      t.merchant.toLowerCase().includes(params.search!.toLowerCase())
    );
    return [...txns].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  },

  /**
   * Every transaction the user may LOOK at, including the ones that came with an
   * account somebody shared with them directly.
   *
   * That cascade is what makes "we both see the same account" true rather than
   * half-true: an account without its transactions is a number with no
   * explanation. It is derived from `account_id` at read time — no transaction is
   * stamped or copied — so un-sharing the account takes them all back in the same
   * instant, with the same single write.
   */
  getVisible(params?: { account_id?: string }): Transaction[] {
    let txns = visible('transaction', withAccountStamps(useStore.getState().transactions));
    if (params?.account_id) txns = txns.filter(t => t.account_id === params.account_id);
    return [...txns].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  },

  /** Transactions visible only because somebody shared their account. Never in
   *  a total: they are not this user's spending and never become it. */
  sharedWithMe(params?: { account_id?: string }): Transaction[] {
    let txns = sharedWithMeOnly('transaction', withAccountStamps(useStore.getState().transactions));
    if (params?.account_id) txns = txns.filter(t => t.account_id === params.account_id);
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
   *
   * SPLIT TRANSACTIONS. Reports read a split transaction's LINES, not its
   * category column, so re-filing one is ambiguous: does the new category
   * replace the division, or sit under it? `opts.splits` carries the user's
   * answer — 'replace' removes the lines so the new category is what gets
   * counted, and the default ('keep') leaves them alone. Nothing here ever
   * destroys a split the user wasn't asked about.
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
    opts?: { splits?: SplitCategoryChoice },
  ): void {
    const tx = useStore.getState().transactions.find(t => t.id === id);
    if (!tx) return;

    // 0. The split decision, when a category change came with one. Done FIRST so
    //    the row is never momentarily showing a category the reports contradict.
    if (opts?.splits === 'replace' && changes.category !== undefined) {
      transactionSplitsDS.clear(id);
    }

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
      const splitParents = transactionSplitsDS.byTransactionId();
      for (const t of affected) {
        const p: Partial<Transaction> = {};
        // Category / merchant re-filing skips rows the user hand-set (category_source
        // 'user') — those are deliberate and must never be overwritten by a rule.
        if (t.category_source !== 'user') {
          if (changes.merchant !== undefined) { p.merchant = changes.merchant; if (merchantId) p.merchant_id = merchantId; }
          // A SPLIT row is hand-set in the same sense, and more so: its lines are
          // what the reports count, so re-filing the column would either do
          // nothing or (worse) put a category on screen that no report agrees
          // with. The user is asked about their OWN split; a rule never gets to
          // answer for one it has never seen. Renaming the merchant is still
          // fine — that isn't what the split decides.
          const isSplit = (splitParents.get(t.id)?.length ?? 0) > 0;
          if (changes.category !== undefined && !isSplit) {
            p.category = changes.category; p.category_source = 'rule'; p.confidence = 0.9;
          }
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
    opts?: { splits?: SplitCategoryChoice },
  ): void {
    const { refundOf, ...learnable } = changes;
    this.applyCorrection(id, learnable, scope, opts);
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
  async runAiFallback(opts: { limit?: number } = {}): Promise<{ requested: number; applied: number; error?: string }> {
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
    let error: string | undefined;
    try {
      const { results, error: serverError } = await overviewApi.aiClassify({
        transactions: candidates.map(toAiClassifyItem),
        categories,
        currency,
      });
      // The server ran but the Claude call itself failed (e.g. no API key) — carry
      // the reason up so the UI can say so rather than appear to do nothing.
      if (serverError) error = serverError;
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
      // Network/timeout: the request never completed (a stalled model call trips
      // the 45s client timeout). Surface it so the button doesn't just reset.
      const msg = (err as Error)?.message ?? '';
      error = /timeout/i.test(msg)
        ? "The AI request timed out — the server didn't respond in time. Try again."
        : 'Could not reach the AI service. Check your connection and try again.';
      console.warn('[dataService] AI fallback failed:', msg);
    } finally {
      ids.forEach(id => aiInFlight.delete(id));
    }
    return { requested: candidates.length, applied, error };
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

/**
 * Rename the unpaid bill(s) that mirror a subscription so a subscription rename
 * shows everywhere (Bills & Reminders + Forecast). `sub` is the PRE-rename
 * subscription (its anchor still matches the old bill name). Bills are written
 * directly to the store — NOT via billsDS.update — so this never recurses back
 * into subscription rename. A bill's import name is snapshotted into original_name
 * on first divergence, so the user-edited name never gets clobbered on re-import.
 */
function propagateSubNameToLinkedBills(sub: Subscription, newName: string): void {
  const s = useStore.getState();
  const target = newName.trim().toLowerCase();
  const anchor = (sub.original_name ?? sub.name).trim().toLowerCase();
  const linked = s.bills.filter(b =>
    !b.is_paid &&
    b.name.trim().toLowerCase() !== target &&
    (b.subscription_id === sub.id ||
      (!b.subscription_id && (b.original_name ?? b.name).trim().toLowerCase() === anchor)),
  );
  if (linked.length === 0) return;
  const linkedIds = new Set(linked.map(b => b.id));
  s.setBills(s.bills.map(b => {
    if (!linkedIds.has(b.id)) return b;
    const patch: Partial<Bill> = { name: newName, updated_at: ts() };
    if (!b.original_name) patch.original_name = b.name; // preserve import name once
    return { ...b, ...patch };
  }));
  for (const b of linked) {
    const data: Partial<Bill> = { name: newName };
    if (!b.original_name) data.original_name = b.name;
    syncWithRetry('bill.update', { id: b.id, data });
  }
}

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
    const before = s.subscriptions.find(sub => sub.id === id);
    s.setSubscriptions(s.subscriptions.map(sub =>
      sub.id === id ? { ...sub, ...patch, updated_at: ts() } : sub
    ));
    syncWithRetry('subscription.update', { id, data: patch });
    // A name change here must reach the linked Bills & Reminders entry too.
    if (before && patch.name && patch.name.trim().toLowerCase() !== before.name.trim().toLowerCase()) {
      propagateSubNameToLinkedBills(before, patch.name);
    }
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

    // A subscription and its Bills & Reminders entry are the SAME commitment, so a
    // rename on the subscription must reach the linked bill(s). (The reverse —
    // bill→subscription — already lives in billsDS.update.) `existing` is the
    // pre-rename subscription, so its anchor still matches the old bill name.
    if (existing) propagateSubNameToLinkedBills(existing, newName);
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

/** Enrich one raw holding with preferred-currency display figures. Pulled out
 *  of getAll() so the enrichment (which is per-row and scope-blind) can run over
 *  the store's full superset while totals stay scoped. */
function enrichLocalInvestment(inv: Investment, pref: string) {
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
}

export const investmentsDS = {
  /** The holdings in the current scope — yours, or the household's shared ones —
   *  enriched, with their total. Scoped like every other shareable slice, so a
   *  holding shared WITH this user can never reach their portfolio total. */
  getAll() {
    const s = useStore.getState();
    const pref = s.user?.currency_preference ?? 'AUD';
    const investments = scoped(s.investments).map(inv => enrichLocalInvestment(inv, pref));
    const portfolio_total = investments.reduce((sum, i) => sum + i.display_value, 0);
    return { investments, portfolio_total, portfolio_verified: true };
  },

  /** EVERY holding the store knows about — own, household-shared and directly
   *  granted alike — enriched, plus the SCOPED total. This is what the
   *  Investments page writes back into the store: the store holds the visible
   *  superset, and each screen narrows to its scope at read time. Writing the
   *  scoped subset back instead would silently drop everybody else's shared
   *  rows from the cache. */
  enrichAll() {
    const s = useStore.getState();
    const pref = s.user?.currency_preference ?? 'AUD';
    const all = s.investments.map(inv => enrichLocalInvestment(inv, pref));
    const portfolio_total = scoped(all).reduce((sum, i) => sum + i.display_value, 0);
    return { all, portfolio_total };
  },

  /** Holdings somebody else shared with this user directly. Not theirs, not in
   *  any total — the same single row the owner is looking at. */
  sharedWithMe(): Investment[] {
    return sharedWithMeOnly('investment', useStore.getState().investments);
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
    // Scoped: a holding somebody shared with this user is not their money.
    const newTotal = scoped(updated).reduce((sum, i) => sum + i.current_value * (i.conversion_rate ?? 1), 0);
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
//
// Phase 5.4 moved the list INTO THE STORE. It used to live in the Investments page's
// own useState, fetched on mount, which meant the Tax page — the one place a capital
// gain actually has to be assessed — could not see a single disposal. One list, two
// pages, and it survives a reload like every other slice.
export const salesDS = {
  getAll(): InvestmentSale[] {
    return useStore.getState().investmentSales;
  },

  /** Replace the cached list with the server's, keeping local-only rows not yet synced. */
  load(sales: InvestmentSale[]): InvestmentSale[] {
    const merged = mergeById(sales, useStore.getState().investmentSales);
    useStore.getState().setInvestmentSales(merged);
    return merged;
  },

  remove(id: string): void {
    const s = useStore.getState();
    s.setInvestmentSales(s.investmentSales.filter(r => r.id !== id));
    syncWithRetry('sale.delete', { id });
  },

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
    const s = useStore.getState();
    s.setInvestmentSales([record, ...s.investmentSales]);
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
  /** The entries in the current scope, and their projected annual figure.
   *  Personal = everything the user owns (shared or not — sharing a salary
   *  never removes it from its earner's own picture); a household view = what
   *  that household was shown, from every member, counted once. */
  getAll() {
    const entries = scoped(useStore.getState().incomeEntries);
    const multipliers: Record<string, number> = {
      weekly: 52, fortnightly: 26, monthly: 12, quarterly: 4, annually: 1,
    };
    const projected_annual = entries
      .filter(e => e.is_recurring && e.status === 'approved')
      .reduce((sum, e) => sum + e.amount * (multipliers[e.frequency ?? 'monthly'] ?? 12), 0);
    return { entries, projected_annual };
  },

  /** Entries somebody granted this user directly — visible, never counted. */
  sharedWithMe(): IncomeEntry[] {
    return sharedWithMeOnly('income', useStore.getState().incomeEntries);
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

/**
 * Rates, thresholds and levy rules live in utils/taxRates.ts, keyed by financial
 * year. Nothing here knows a rate: this layer only decides WHICH year to assess
 * and what to do when Ledger has no rates for it (answer: say so — never borrow
 * a neighbouring year's scales).
 */
export interface TaxCalculationResult {
  financial_year: string;
  /** Taxable income — gross less deductions. Known even with no rates. */
  total_income: number;
  /**
   * The OTHER income base: what a study and training loan repayment is assessed
   * on. Equals `total_income` plus the year's reportable-benefit / investment-loss
   * / reportable-super / exempt-foreign figures. Known even with no rates.
   */
  repayment_income: number;
  /** repayment_income − total_income, so the UI can show the gap it created. */
  repayment_income_adjustments: number;
  tax_withheld: number;
  total_deductions: number;
  /** False when Ledger holds no rates for `financial_year`. */
  rates_available: boolean;
  rates_confidence: RateConfidence | null;
  rates_notes: string[];
  /** All null when `rates_available` is false. */
  estimated_tax_owing: number | null;
  income_tax: number | null;
  medicare_levy: number | null;
  hecs_repayment: number | null;
  franking_credits: number;
}

export function calculateTax(
  hecsEnabled = false,
  overrides?: {
    fy?: string;
    total_income?: number;
    tax_withheld?: number;
    total_deductions?: number;
    /**
     * The year's repayment-income additions. Omitted means none supplied, in
     * which case repayment income is taxable income — correct for a plain wage
     * earner and understated for anyone salary sacrificing, which is why the
     * Tax page asks rather than guessing.
     */
    repayment_income_adjustments?: RepaymentIncomeAdjustments | null;
  },
): TaxCalculationResult {
  const s = useStore.getState();
  // Own entries ONLY: income a partner shared into view is their taxable
  // income, not this user's.
  const entries = ownRows(s.incomeEntries).filter(e => e.status === 'approved');
  // Prefer payslip YTD figures when supplied (they already accumulate the whole
  // FY); otherwise fall back to summing approved income entries.
  const gross_income = overrides?.total_income ?? entries.reduce((sum, e) => sum + e.amount, 0);
  const tax_withheld = overrides?.tax_withheld ?? entries.reduce((sum, e) => sum + (e.tax_withheld ?? 0), 0);

  // Deductions reduce taxable income, which is what tax, Medicare and HECS are
  // all assessed on — so claiming a deduction lowers the estimate and increases
  // any refund. Never let deductions push taxable income below zero.
  const total_deductions = overrides?.total_deductions ?? 0;
  const total_income = Math.max(0, gross_income - total_deductions);

  // The loan's own base, built from taxable income — never the other way round.
  const repayment = repaymentIncomeFrom(total_income, overrides?.repayment_income_adjustments);

  const fy = overrides?.fy ?? currentFY();
  const estimate = estimateTaxForFY(fy, total_income, {
    studentLoan: hecsEnabled,
    repaymentIncome: repayment.total,
  });

  // No rates for this year. The position is still real — income, withholding and
  // deductions are the user's own figures — so return them, and leave every
  // rate-derived number null so the UI has to show "estimate unavailable"
  // instead of rendering a plausible wrong number.
  if (!estimate) {
    return {
      financial_year: fy,
      total_income,
      repayment_income: repayment.total,
      repayment_income_adjustments: repayment.adjustments,
      tax_withheld,
      total_deductions,
      rates_available: false,
      rates_confidence: null,
      rates_notes: [],
      estimated_tax_owing: null,
      income_tax: null,
      medicare_levy: null,
      hecs_repayment: null,
      franking_credits: 0,
    };
  }

  return {
    financial_year: fy,
    total_income,
    repayment_income: estimate.repaymentIncome,
    repayment_income_adjustments: repayment.adjustments,
    tax_withheld,
    total_deductions,
    rates_available: true,
    rates_confidence: estimate.confidence,
    rates_notes: estimate.notes,
    estimated_tax_owing: estimate.total,
    income_tax: estimate.incomeTax,
    medicare_levy: estimate.medicareLevy,
    hecs_repayment: estimate.studentLoanRepayment,
    franking_credits: 0,
  };
}

/**
 * Estimate total annual Australian tax (income tax + Medicare, optional HECS)
 * for a given taxable income in a given financial year. Standalone version of
 * calculateTax that takes an explicit income — used by the payslip "on track vs
 * heading for a bill" check, which annualises a payslip's gross rather than
 * summing income entries. Returns null when Ledger has no rates for the year.
 */
export function estimateTaxForIncome(
  total_income: number,
  hecsEnabled = false,
  fy: string = currentFY(),
  repaymentIncome?: number,
): number | null {
  return estimateTaxForFY(fy, total_income, { studentLoan: hecsEnabled, repaymentIncome })?.total ?? null;
}

function currentFY(): string {
  const now = new Date();
  const y = now.getFullYear();
  return now.getMonth() >= 6 ? `${y}-${y + 1}` : `${y - 1}-${y}`;
}

/** Display bracket table for a financial year — empty when unsupported. */
export function getTaxBrackets(fy: string = currentFY()) {
  return displayBracketsFor(fy);
}

// ─── TAX DEDUCTIONS ─────────────────────────────────────────────────────────

// Store deductions in a dedicated key via localStorage (simple approach).
//
// The key is scoped to the USER only — never to a financial year. Every record
// carries its own date and the engine buckets by that, so one list serves every
// FY: switching the Tax page to a past year shows the deductions that were
// entered for it, and rolling over on 1 July doesn't strand last year's claims
// in a key nothing reads any more.
function getDeductionsKey() { return `ledger-deductions-${uid()}`; }

// Deductions used to live under a per-FY key (`…-<uid>-<FY>`), which made prior
// years invisible once the FY ticked over. Fold any of those legacy buckets into
// the single list, once, on first read. Ids are de-duplicated so a repeated
// migration (or a merge from two FY buckets holding the same record) can't
// double up a claim. The legacy keys are left in place — this only ever adds.
// Tracked per user id, not with a single flag: signing in changes uid(), and the
// user who arrives after a switch still needs their own legacy buckets folded in.
const deductionsMigrated = new Set<string>();
function migrateLegacyDeductionKeys(): void {
  const key = getDeductionsKey();
  if (deductionsMigrated.has(key)) return;
  deductionsMigrated.add(key);
  try {
    const prefix = `${key}-`;
    const legacyKeys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(prefix)) legacyKeys.push(k);
    }
    if (legacyKeys.length === 0) return;

    const current = JSON.parse(localStorage.getItem(key) ?? '[]') as ManualDeduction[];
    const byId = new Map<string, ManualDeduction>(current.map(d => [d.id, d]));
    let added = 0;
    for (const legacyKey of legacyKeys.sort()) {
      const legacy = JSON.parse(localStorage.getItem(legacyKey) ?? '[]') as ManualDeduction[];
      for (const d of legacy) {
        if (!d?.id || byId.has(d.id)) continue;
        byId.set(d.id, d);
        added++;
      }
    }
    if (added > 0) localStorage.setItem(key, JSON.stringify([...byId.values()]));
  } catch {
    /* a malformed legacy bucket must never block the deduction list */
  }
}

// Thin localStorage wrapper over the pure list mutators in utils/taxDeductions.
// All the merge/dedup/FY logic lives there (and is unit-tested); this only reads
// and writes the array. Records now carry an optional `source_transaction_id`
// link used for double-count prevention against deductible transactions.
export const deductionsDS = {
  getAll(): ManualDeduction[] {
    migrateLegacyDeductionKeys();
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

// ─── STUDY AND TRAINING LOAN INCOME ─────────────────────────────────────────

/**
 * The repayment-income figures Ledger cannot derive: reportable fringe benefits,
 * net investment losses, reportable super contributions, exempt foreign income
 * and any FHSS release. They come off a payment summary or a lodged return, so
 * the user supplies them — PER FINANCIAL YEAR, because each is an annual figure
 * and last year's salary sacrifice says nothing about this year's.
 *
 * Whether the user HAS a loan at all is a single fact about them, not about a
 * year, so it sits at the root of the record. Same storage shape and user-scoped
 * key as deductionsDS: one bucket per user, every year inside it, so rolling
 * over on 1 July never strands a prior year's figures.
 */
interface StudentLoanIncomeRecord {
  hasLoan: boolean;
  byFY: Record<string, RepaymentIncomeAdjustments>;
}

function studentLoanIncomeKey() { return `ledger-help-income-${uid()}`; }

function readStudentLoanIncome(): StudentLoanIncomeRecord {
  try {
    const raw = JSON.parse(localStorage.getItem(studentLoanIncomeKey()) ?? '{}') as Partial<StudentLoanIncomeRecord>;
    const byFY: Record<string, RepaymentIncomeAdjustments> = {};
    for (const [fy, adj] of Object.entries(raw.byFY ?? {})) {
      byFY[fy] = normaliseRepaymentIncomeAdjustments(adj);
    }
    return { hasLoan: raw.hasLoan === true, byFY };
  } catch {
    // A malformed bucket must degrade to "no figures supplied", never to a
    // wrong repayment: with no adjustments, repayment income is taxable income.
    return { hasLoan: false, byFY: {} };
  }
}

function writeStudentLoanIncome(rec: StudentLoanIncomeRecord): void {
  localStorage.setItem(studentLoanIncomeKey(), JSON.stringify(rec));
}

export const studentLoanIncomeDS = {
  hasLoan(): boolean {
    return readStudentLoanIncome().hasLoan;
  },
  setHasLoan(hasLoan: boolean): void {
    writeStudentLoanIncome({ ...readStudentLoanIncome(), hasLoan });
  },
  /** This year's adjustments — all zeros when none were entered. */
  adjustmentsFor(fy: string): RepaymentIncomeAdjustments {
    return readStudentLoanIncome().byFY[fy] ?? emptyRepaymentIncomeAdjustments();
  },
  /** Whether this year has anything entered — drives "show the detail" in the UI. */
  hasAdjustments(fy: string): boolean {
    return hasRepaymentIncomeAdjustments(readStudentLoanIncome().byFY[fy]);
  },
  save(fy: string, adjustments: RepaymentIncomeAdjustments): void {
    const rec = readStudentLoanIncome();
    rec.byFY[fy] = normaliseRepaymentIncomeAdjustments(adjustments);
    writeStudentLoanIncome(rec);
  },
};

// ─── TAX ALREADY PAID (Phase 5.2) ───────────────────────────────────────────

/**
 * The tax payments and credits Ledger cannot derive — PAYG instalments, franking
 * credits, other amounts already withheld. Per financial year, because each is
 * an annual figure, and user-scoped like every other client-side tax record.
 *
 * PAYG WITHHOLDING IS NOT HERE. That one Ledger DOES know, from payslips and
 * income entries, and it is summed by the FY position. Storing it again would
 * create a second version of a number that already exists.
 */
interface TaxCreditsRecord {
  byFY: Record<string, TaxCredits>;
}

function taxCreditsKey() { return `ledger-tax-credits-${uid()}`; }

function readTaxCredits(): TaxCreditsRecord {
  try {
    const raw = JSON.parse(localStorage.getItem(taxCreditsKey()) ?? '{}') as Partial<TaxCreditsRecord>;
    const byFY: Record<string, TaxCredits> = {};
    for (const [fy, c] of Object.entries(raw.byFY ?? {})) byFY[fy] = normaliseTaxCredits(c);
    return { byFY };
  } catch {
    // Degrade to "nothing else was paid", which understates a refund. The other
    // direction would invent money the user never paid.
    return { byFY: {} };
  }
}

export const taxCreditsDS = {
  /** This year's credits — all zeros when none were entered. */
  forFY(fy: string): TaxCredits {
    return readTaxCredits().byFY[fy] ?? emptyTaxCredits();
  },
  /** Whether this year has anything entered — drives "show the detail" in the UI. */
  has(fy: string): boolean {
    return hasTaxCredits(readTaxCredits().byFY[fy]);
  },
  save(fy: string, credits: TaxCredits): void {
    const rec = readTaxCredits();
    rec.byFY[fy] = normaliseTaxCredits(credits);
    localStorage.setItem(taxCreditsKey(), JSON.stringify(rec));
  },
};

// ─── TAX PROFILE (Phase 5.3) ────────────────────────────────────────────────

/**
 * The facts about the PERSON that the offsets and the Medicare levy surcharge
 * need — spouse, dependants, hospital cover, seniors eligibility, and the
 * figures off a private health statement. See utils/taxProfile.ts for why none
 * of them can be derived from transactions.
 *
 * Per financial year and user-scoped, like the tax credits beside it. Every one
 * of these answers can change between years — a spouse arrives, cover lapses,
 * someone turns 65 — so last year's answers are never this year's.
 */
interface TaxProfileRecord {
  byFY: Record<string, TaxProfile>;
}

function taxProfileKey() { return `ledger-tax-profile-${uid()}`; }

function readTaxProfiles(): TaxProfileRecord {
  try {
    const raw = JSON.parse(localStorage.getItem(taxProfileKey()) ?? '{}') as Partial<TaxProfileRecord>;
    const byFY: Record<string, TaxProfile> = {};
    for (const [fy, p] of Object.entries(raw.byFY ?? {})) byFY[fy] = normaliseTaxProfile(p);
    return { byFY };
  } catch {
    // Degrade to "nothing answered": no offsets claimed and no surcharge
    // charged. Both halves of that are safer than acting on a corrupt answer.
    return { byFY: {} };
  }
}

export const taxProfileDS = {
  /** This year's answers — the empty profile when none were given. */
  forFY(fy: string): TaxProfile {
    return readTaxProfiles().byFY[fy] ?? emptyTaxProfile();
  },
  /** Whether this year has anything answered — drives "show the detail" in the UI. */
  has(fy: string): boolean {
    return hasTaxProfile(readTaxProfiles().byFY[fy]);
  },
  save(fy: string, profile: TaxProfile): void {
    const rec = readTaxProfiles();
    rec.byFY[fy] = normaliseTaxProfile(profile);
    localStorage.setItem(taxProfileKey(), JSON.stringify(rec));
  },
  /**
   * Copy last year's answers onto a year that has none. Offered explicitly by
   * the UI and never automatic: most of these facts persist year to year, but
   * assuming they did is exactly how a lapsed policy becomes a silent error.
   */
  copyFrom(sourceFY: string, targetFY: string): TaxProfile {
    const rec = readTaxProfiles();
    const source = rec.byFY[sourceFY] ?? emptyTaxProfile();
    rec.byFY[targetFY] = normaliseTaxProfile(source);
    localStorage.setItem(taxProfileKey(), JSON.stringify(rec));
    return rec.byFY[targetFY];
  },
};

// ─── CAPITAL GAINS (Phase 5.4) ──────────────────────────────────────────────

/**
 * The two things a CGT calculation needs that Ledger cannot derive.
 *
 *   • PARCELS — what you bought, when, and for how much. A holding carries ONE
 *     cost basis and no acquisition date, which is enough to value a portfolio
 *     and not enough to tax a sale: a partial sale out of three parcels bought
 *     three years apart has three different answers to "does the 50% discount
 *     apply". Parcels are optional — without them a disposal falls back to the
 *     figures the Sell dialog already records — and they only ever make the
 *     answer more accurate.
 *   • THE OPENING LOSS — unapplied net capital losses from the last return you
 *     lodged. Ledger cannot know about a loss you made before you started using
 *     it, and a carried-forward loss lives forever, so it is asked for once with
 *     the year it was measured at.
 *
 * User-scoped and NOT per financial year: a parcel belongs to a purchase, not to
 * a year, and the engine buckets it by its own acquisition date.
 */
interface CapitalGainsRecord {
  parcels: CgtParcel[];
  opening: OpeningCapitalLosses | null;
}

function cgtKey() { return `ledger-cgt-${uid()}`; }

function normaliseParcel(raw: unknown): CgtParcel | null {
  const r = (raw ?? {}) as Record<string, unknown>;
  const id = String(r.id ?? '').trim();
  const qty = Number(r.quantity);
  if (!id || !Number.isFinite(qty) || qty <= 0) return null;
  return {
    id,
    investmentId: typeof r.investmentId === 'string' && r.investmentId ? r.investmentId : null,
    label: String(r.label ?? '').trim() || 'Holding',
    ticker: typeof r.ticker === 'string' && r.ticker.trim() ? r.ticker.trim().toUpperCase() : null,
    assetType: typeof r.assetType === 'string' && r.assetType ? r.assetType : null,
    quantity: parseFloat(qty.toFixed(8)),
    costBase: Number.isFinite(Number(r.costBase)) && Number(r.costBase) > 0
      ? parseFloat(Number(r.costBase).toFixed(2))
      : 0,
    acquiredDate: isoDay(r.acquiredDate),
  };
}

function readCapitalGains(): CapitalGainsRecord {
  try {
    const raw = JSON.parse(localStorage.getItem(cgtKey()) ?? '{}') as Partial<CapitalGainsRecord>;
    const parcels = (Array.isArray(raw.parcels) ? raw.parcels : [])
      .map(normaliseParcel)
      .filter((p): p is CgtParcel => p !== null);
    const o = raw.opening as Record<string, unknown> | null | undefined;
    const openingFY = String(o?.fy ?? '').trim();
    const opening: OpeningCapitalLosses | null = /^\d{4}-\d{4}$/.test(openingFY)
      ? {
          fy: openingFY,
          ordinary: Math.max(0, Number(o?.ordinary) || 0),
          collectable: Math.max(0, Number(o?.collectable) || 0),
        }
      : null;
    return { parcels, opening };
  } catch {
    // A corrupt bucket degrades to "no parcels and no carried-forward loss".
    // Both halves cost the user money rather than inventing a deduction: without
    // parcels a sale falls back to its recorded cost base and loses the discount,
    // and without an opening loss there is nothing to reduce the gain.
    return { parcels: [], opening: null };
  }
}

function writeCapitalGains(rec: CapitalGainsRecord): void {
  localStorage.setItem(cgtKey(), JSON.stringify(rec));
}

export const cgtDS = {
  parcels(): CgtParcel[] {
    return readCapitalGains().parcels;
  },
  /** Parcels recorded against one holding. */
  parcelsFor(investmentId: string): CgtParcel[] {
    return readCapitalGains().parcels.filter(p => p.investmentId === investmentId);
  },
  addParcel(data: Omit<CgtParcel, 'id'>): CgtParcel {
    const rec = readCapitalGains();
    const parcel = normaliseParcel({ ...data, id: uuid() });
    if (!parcel) throw new Error('A parcel needs a quantity greater than zero.');
    rec.parcels = [...rec.parcels, parcel];
    writeCapitalGains(rec);
    return parcel;
  },
  updateParcel(id: string, data: Partial<Omit<CgtParcel, 'id'>>): void {
    const rec = readCapitalGains();
    rec.parcels = rec.parcels.map(p => {
      if (p.id !== id) return p;
      return normaliseParcel({ ...p, ...data, id }) ?? p;
    });
    writeCapitalGains(rec);
  },
  removeParcel(id: string): void {
    const rec = readCapitalGains();
    rec.parcels = rec.parcels.filter(p => p.id !== id);
    writeCapitalGains(rec);
  },
  /** The unapplied losses brought in from the last lodged return. */
  opening(): OpeningCapitalLosses | null {
    return readCapitalGains().opening;
  },
  setOpening(opening: OpeningCapitalLosses | null): void {
    writeCapitalGains({ ...readCapitalGains(), opening });
  },

  /**
   * Every recorded disposal, in the shape the engine reads. The store keeps the
   * backend's `InvestmentSale` rows verbatim; this only renames the fields, so
   * there is one disposal record and not two.
   */
  disposals(): CgtDisposal[] {
    return salesDS.getAll().map((r): CgtDisposal => ({
      id: r.id,
      investmentId: r.investment_id ?? null,
      label: r.name,
      ticker: r.ticker ?? null,
      assetType: r.asset_type ?? null,
      quantity: Number(r.quantity) || 0,
      proceeds: Number(r.proceeds) || 0,
      fees: Number(r.fees) || 0,
      costBase: Number(r.cost_basis) || 0,
      acquiredDate: isoDay(r.acquired_date),
      saleDate: String(r.sale_date ?? '').slice(0, 10),
      currency: r.currency ?? null,
      parcelIds: null,
    }));
  },

  /** The whole CGT position for one year, rolled forward from the opening loss. */
  build(fy: string) {
    const rec = readCapitalGains();
    return buildCapitalGains({
      fy,
      parcels: rec.parcels,
      disposals: cgtDS.disposals(),
      opening: rec.opening,
    });
  },

  /**
   * A starting parcel for a holding that has none — its own cost basis and
   * quantity, with NO acquisition date, because the holding does not carry one.
   * Offered by the UI so the user can fill the date in; never written silently,
   * since a parcel with a guessed date would hand out a discount nobody earned.
   */
  suggestParcel(investmentId: string): Omit<CgtParcel, 'id'> | null {
    const inv = useStore.getState().investments.find(i => i.id === investmentId);
    if (!inv) return null;
    return {
      investmentId: inv.id,
      label: inv.name,
      ticker: inv.ticker ?? null,
      assetType: inv.asset_type,
      quantity: inv.shares_owned,
      costBase: inv.display_cost ?? inv.cost_basis,
      acquiredDate: null,
    };
  },

  /** Whether a holding is one of the ATO's collectables — art, wine, jewellery. */
  isCollectable(assetType: string | null | undefined): boolean {
    return cgtAssetClassOf(assetType) === 'collectable';
  },
};

// ─── DIVIDEND STATEMENTS (Phase 5.4) ────────────────────────────────────────

/**
 * Registry statements: the franked/unfranked split and the franking credit, none
 * of which ever appears in a bank feed — the bank sees one cash amount with no
 * hint that company tax was already paid on it.
 *
 * Stored as ONE list across all years, keyed by user, and bucketed by payment
 * date. Per-FY storage would strand last year's statements on 1 July, which is
 * the bug the deduction store was already fixed for.
 */
interface DividendRecord {
  statements: DividendStatement[];
}

function dividendsKey() { return `ledger-dividends-${uid()}`; }

function readDividends(): DividendRecord {
  try {
    const raw = JSON.parse(localStorage.getItem(dividendsKey()) ?? '{}') as Partial<DividendRecord>;
    const statements = (Array.isArray(raw.statements) ? raw.statements : [])
      .map(x => normaliseDividendStatement(x, String((x as { id?: unknown })?.id ?? '').trim()))
      .filter(x => x.id !== '');
    return { statements };
  } catch {
    // Degrade to "no statements": the manual franking figure on the tax-paid card
    // is then the only source, which is exactly the Phase 5.2 behaviour.
    return { statements: [] };
  }
}

function writeDividends(rec: DividendRecord): void {
  localStorage.setItem(dividendsKey(), JSON.stringify(rec));
}

export const dividendsDS = {
  getAll(): DividendStatement[] {
    return readDividends().statements;
  },
  forFY(fy: string): DividendStatement[] {
    return readDividends().statements.filter(
      x => x.paymentDate && financialYearOf(x.paymentDate) === fy,
    );
  },
  add(data: Omit<DividendStatement, 'id'>): DividendStatement {
    const rec = readDividends();
    const statement = normaliseDividendStatement(data, uuid());
    rec.statements = [...rec.statements, statement];
    writeDividends(rec);
    return statement;
  },
  update(id: string, data: Partial<Omit<DividendStatement, 'id'>>): void {
    const rec = readDividends();
    rec.statements = rec.statements.map(x =>
      x.id === id ? normaliseDividendStatement({ ...x, ...data }, id) : x,
    );
    writeDividends(rec);
  },
  remove(id: string): void {
    const rec = readDividends();
    rec.statements = rec.statements.filter(x => x.id !== id);
    writeDividends(rec);
  },
};

// ─── RENTAL PROPERTY TAX (Phase 5.5) ────────────────────────────────────────

/**
 * The facts a rental schedule needs and a bank feed cannot contain: the lender's
 * annual interest figure, whether a co-owner's share has already been taken out,
 * how much of a part-let property is private, and the two non-cash claims
 * (capital works and depreciation).
 *
 * Keyed by property and stored as ONE record across all years, with the annual
 * figures nested per FY inside it. A per-FY storage key would strand last year's
 * settings on 1 July — the bug the deduction store was already fixed for — while
 * the ownership basis and the private-use split are facts about the property,
 * not about a year, so they sit outside `byFY` and never have to be re-entered.
 */
interface RentalTaxRecord {
  byProperty: Record<string, RentalPropertySettings>;
}

function rentalTaxKey() { return `ledger-rental-tax-${uid()}`; }

function normaliseRentalSettings(raw: unknown): RentalPropertySettings {
  const base = emptyRentalSettings();
  const r = (raw ?? {}) as Partial<RentalPropertySettings>;
  const app = r.apportionment ?? base.apportionment;
  const shares: Record<string, number> = {};
  for (const [k, v] of Object.entries(r.ruleDeductiblePercent ?? {})) {
    const n = Number(v);
    if (Number.isFinite(n)) shares[k] = Math.min(100, Math.max(0, n));
  }
  return {
    recordedBasis: r.recordedBasis === 'whole' ? 'whole' : 'my-share',
    apportionment: {
      mode: app.mode === 'percent' || app.mode === 'days' ? app.mode : 'full',
      percent: Math.min(100, Math.max(0, Number(app.percent) || 0)),
      daysRented: Math.max(0, Number(app.daysRented) || 0),
      daysPrivate: Math.max(0, Number(app.daysPrivate) || 0),
    },
    ruleDeductiblePercent: shares,
    byFY: (r.byFY ?? {}) as RentalPropertySettings['byFY'],
  };
}

function readRentalTax(): RentalTaxRecord {
  try {
    const raw = JSON.parse(localStorage.getItem(rentalTaxKey()) ?? '{}') as Partial<RentalTaxRecord>;
    const byProperty: Record<string, RentalPropertySettings> = {};
    for (const [id, settings] of Object.entries(raw.byProperty ?? {})) {
      byProperty[id] = normaliseRentalSettings(settings);
    }
    return { byProperty };
  } catch {
    // Degrade to "nothing entered": no interest is claimed, nothing is
    // apportioned, and the schedule says so. Every one of those costs the user
    // money rather than inventing a deduction out of a corrupt bucket.
    return { byProperty: {} };
  }
}

function writeRentalTax(rec: RentalTaxRecord): void {
  localStorage.setItem(rentalTaxKey(), JSON.stringify(rec));
}

export const rentalTaxDS = {
  settingsFor(propertyId: string): RentalPropertySettings {
    return readRentalTax().byProperty[propertyId] ?? emptyRentalSettings();
  },

  save(propertyId: string, settings: RentalPropertySettings): void {
    const rec = readRentalTax();
    rec.byProperty = { ...rec.byProperty, [propertyId]: normaliseRentalSettings(settings) };
    writeRentalTax(rec);
  },

  /**
   * Everything the rental engine needs, per property.
   *
   * Attribution is the SAME call the Property tab makes, over the same one list,
   * so a contested transaction is settled once and the two screens can never
   * disagree about whose rent it was.
   *
   * Interest charges arrive separately because utils/property.ts refuses to
   * claim anything on a loan account — a mortgage repayment there would be
   * counted twice, once as a transaction and once from the loan's schedule. The
   * interest inside it is the one thing on that account a rental return wants.
   */
  inputs(): RentalPropertyInput[] {
    const s = useStore.getState();
    const userId = s.user?.id ?? null;
    const own = <T extends { user_id?: string }>(x: T) => !userId || !x.user_id || x.user_id === userId;
    const properties = propertiesDS.getAll();
    if (properties.length === 0) return [];
    const loans = s.loans.filter(own);
    const transactions = s.transactions.filter(own);
    const attributed = attributeTransactions(properties, transactions);
    const rec = readRentalTax();

    return properties.map((property): RentalPropertyInput => {
      const claimed = attributed.get(property.id) ?? [];
      const loan = property.loan_id ? loans.find(l => l.id === property.loan_id) ?? null : null;
      const loanAccountId = loan?.basiq_account_id ?? null;
      const seen = new Set<string>();
      const interestTransactions = [
        ...claimed.filter(t => t.account_type === 'loan'),
        ...(loanAccountId
          ? transactions.filter(t => t.account_type === 'loan' && t.account_id === loanAccountId)
          : []),
      ].filter(t => (seen.has(t.id) ? false : (seen.add(t.id), true)));

      return {
        property,
        transactions: claimed,
        loan,
        interestTransactions,
        settings: rec.byProperty[property.id] ?? null,
      };
    });
  },

  /** The whole rental schedule for one year. */
  build(fy: string): RentalPosition {
    return buildRentalPosition({
      fy,
      properties: this.inputs(),
      // An explicit manual-deduction link is the user's own statement that this
      // payment is already claimed somewhere; the schedule releases it rather
      // than claiming the same money a second time.
      manuallyLinkedTransactionIds: new Set(
        deductionsDS.getAll()
          .map(d => d.source_transaction_id?.trim())
          .filter((x): x is string => !!x),
      ),
      asOf: todayISO(),
    });
  },

  /** Dates any property had rental activity on — for the FY switcher. */
  activityDates(): string[] {
    return rentalActivityDates(this.inputs());
  },
};

// ─── TAX YEAR POSITION (Phase 5.1) ──────────────────────────────────────────

/**
 * Gatherer for the pure FY engine in utils/taxYear.ts. It only COLLECTS —
 * transactions from the store, deductions from deductionsDS, income entries from
 * the store, payslips from the caller (the Tax page already fetches them from
 * the payroll API) — and hands them to buildTaxYearPosition. All the merging,
 * dedup and arithmetic live in the engine, where they are unit-tested.
 *
 * The transfer-exclusion set is the SAME one every spend/income surface uses, so
 * an internal movement can never appear as business income here while being
 * ignored on Accounts.
 */
export const taxYearDS = {
  build(opts: { fy: string; payslips?: PayslipCore[] }): TaxYearPosition {
    const transactions = useStore.getState().transactions;
    // Phase 5.4 — the capital gain is settled BEFORE the position is built,
    // because it has to be rolled forward from earlier years before this one can
    // know what losses it starts with. Dividend statements go in raw: their
    // double-count check needs the income lines, which only exist inside.
    return buildTaxYearPosition({
      fy: opts.fy,
      transactions,
      manualDeductions: deductionsDS.getAll(),
      incomeEntries: ownRows(useStore.getState().incomeEntries),
      payslips: opts.payslips ?? [],
      excludeIds: computeTransferExclusionIds(transactions, detectInternalTransferIds),
      capitalGains: cgtDS.build(opts.fy),
      dividendStatements: dividendsDS.getAll(),
      manualFrankingCredit: taxCreditsDS.forFY(opts.fy).frankingCredits,
      // Phase 5.5 — the rental schedule is settled BEFORE the position, because
      // the position needs to know which payments it has already claimed before
      // it can decide what the general deduction view is allowed to count.
      rental: rentalTaxDS.build(opts.fy),
    });
  },

  /** FY options for the switcher, newest first, always including the current FY. */
  financialYears(opts?: { payslips?: PayslipCore[] }): string[] {
    const found = availableTaxYears({
      transactions: useStore.getState().transactions,
      manualDeductions: deductionsDS.getAll(),
      incomeEntries: ownRows(useStore.getState().incomeEntries),
      payslips: opts?.payslips ?? [],
      // A year whose only event was a share sale or a dividend still has a tax
      // position, so it has to appear in the switcher.
      extraDates: [
        ...salesDS.getAll().map(r => r.sale_date),
        ...dividendsDS.getAll().map(d => d.paymentDate),
        // A year whose only event was rent arriving still has a tax position.
        ...rentalTaxDS.activityDates(),
      ],
    });
    const cur = currentFY();
    return found.includes(cur) ? found : [cur, ...found];
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

    // Maintenance below (purge + dedupe) touches ONLY the user's own bills. The
    // store is a visible superset now — it holds bills other members shared —
    // and a lazy cleanup that deleted somebody else's row because it happened to
    // share a name would be exactly the cross-member write nothing else allows.
    const mine = new Set(ownRows(s.bills).map(b => b.id));

    // 1. Purge (our own) paid bills older than 7 days
    let working = s.bills.filter(b => {
      if (!b.is_paid) return true;
      if (!mine.has(b.id)) return true; // someone else's history is not ours to sweep
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
      if (!mine.has(b.id)) continue; // never auto-delete a shared member's bill
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
    // Narrowed to the active scope like every other list: your own bills on
    // "My Finances", the household's shared ones on a household view.
    return scoped(working.filter(b => !b.is_paid))
      .sort((a, b) => new Date(a.due_date).getTime() - new Date(b.due_date).getTime());
  },

  /** Bills paid within the last 7 days, most recently paid first. */
  getRecentlyPaid(): Bill[] {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    return scoped(useStore.getState().bills)
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
    const bill = useStore.getState().bills.find(b => b.id === id);
    if (!bill) return;

    const today = new Date().toISOString().split('T')[0];

    // Phase 3.4 — a bill assigned to an account/card records its payment as a manual
    // transaction on that owner and moves the balance now. Routing it through the
    // canonical ingest gives it the SAME manual↔import reconciliation a hand-added
    // transaction gets, so a later Basiq/statement import of the real payment
    // reconciles against it (reconcile.ts / the sync reconcile pass) instead of
    // duplicating. Unassigned bills / reminders skip this and just tick off.
    let paidTxId: string | null = null;
    if (canRecordBillPayment(bill)) {
      const owner = bill.account_type === 'bank'
        ? accountsDS.getAll().find(a => accountIdMatches(bill.account_id!, a))
        : creditCardsDS.getAll().find(c => accountIdMatches(bill.account_id!, c));
      if (owner) {
        const plan = buildBillPayment({
          bill,
          account: {
            id: owner.id,
            kind: bill.account_type as 'bank' | 'credit_card',
            currency: owner.currency,
            is_manual: owner.is_manual,
          },
          asOf: today,
        });
        if (plan) {
          const res = transactionsDS.ingest(plan.ingest, { allowDuplicate: true });
          if (res.transaction) {
            paidTxId = res.transaction.id;
            // Mirror the manual-add path: ingest never touches the balance, so move
            // it here (money out lowers a bank balance / a charge raises card owing).
            moveOwnerBalance(owner.id, bill.account_type!, plan.balanceDelta);
          }
        }
      }
    }

    useStore.getState().setBills(useStore.getState().bills.map(b =>
      b.id === id ? { ...b, is_paid: true, paid_at: today, paid_transaction_id: paidTxId, updated_at: ts() } : b
    ));

    syncWithRetry('bill.pay', { id });
    // bill.pay only flips is_paid/paid_at server-side; persist the transaction link
    // separately so an un-pay (here or on another device) can find and reverse it.
    if (paidTxId) syncWithRetry('bill.update', { id, data: { paid_transaction_id: paidTxId } });
  },

  /** Restore a recently-paid bill back to unpaid (undo tick-off). */
  restore(id: string): void {
    const bill = useStore.getState().bills.find(b => b.id === id);

    // Reverse the recorded payment transaction (and its balance move) if it still
    // exists AS OUR MANUAL ENTRY. If a real bank/statement import already reconciled
    // it away, the authoritative row now represents the payment — leave it alone;
    // reversing a real posted transaction would corrupt the balance.
    if (bill?.paid_transaction_id) {
      const tx = useStore.getState().transactions.find(t => t.id === bill.paid_transaction_id);
      if (tx && tx.source === 'manual') {
        transactionsDS.removeAndReverseBalance(tx.id);
      }
    }

    useStore.getState().setBills(useStore.getState().bills.map(b =>
      b.id === id ? { ...b, is_paid: false, paid_at: undefined, paid_transaction_id: null, updated_at: ts() } : b
    ));
    // Backend doesn't have a restore endpoint — update the bill fields directly
    syncWithRetry('bill.update', { id, data: { is_paid: false, paid_transaction_id: null } });
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
    return scoped(useStore.getState().goals);
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
    // The ledger has no meaning without its goal. The server cascades via the
    // goal_id FK, but the queued deletes are sent anyway: a contribution create
    // still sitting in the queue would otherwise land AFTER the cascade and
    // resurrect an orphan row. Queue order makes the pair safe, and a delete
    // for a row the server never had is swallowed as a 404.
    goalContributionsDS.removeForGoal(id);
    syncWithRetry('goal.delete', { id });
  },
};

// ─── GOAL CONTRIBUTIONS (Phase 4.3) ──────────────────────────────────────────
//
// Money moved toward — or out of — a goal, recorded as a signed ledger. Whether
// a row COUNTS is not decided here: `utils/savingsGoals.ts` compares it against
// the goal's current links, so a deposit already visible in a linked account's
// balance is kept for history without being added twice.

export const goalContributionsDS = {
  /** The signed-in user's contributions, plus everyone's contributions to any
   *  goal visible in the CURRENT scope — a shared goal's progress is
   *  meaningless without the money already moved toward it, whoever moved it. */
  getAll(): GoalContribution[] {
    const s = useStore.getState();
    const userId = s.user?.id ?? null;
    const visibleGoals = new Set(scoped(s.goals).map(g => g.id));
    return s.goalContributions.filter(c =>
      visibleGoals.has(c.goal_id)
      || !userId || !c.user_id || c.user_id === userId);
  },

  /** One goal's ledger, newest first — the order the history panel reads in. */
  forGoal(goalId: string): GoalContribution[] {
    return this.getAll()
      .filter(c => c.goal_id === goalId)
      .sort((a, b) => (a.date === b.date
        ? (b.created_at ?? '').localeCompare(a.created_at ?? '')
        : (a.date < b.date ? 1 : -1)));
  },

  add(data: Omit<GoalContribution, 'id' | 'user_id' | 'created_at' | 'updated_at'>): GoalContribution {
    const record: GoalContribution = {
      ...data, id: uuid(), user_id: uid(), created_at: ts(), updated_at: ts(),
    };
    const s = useStore.getState();
    s.setGoalContributions([...s.goalContributions, record]);
    syncWithRetry('goalContribution.create', { recordId: record.id, data });
    return record;
  },

  update(id: string, data: Partial<GoalContribution>): GoalContribution | undefined {
    const s = useStore.getState();
    const updated = s.goalContributions.map(c => c.id === id ? { ...c, ...data, updated_at: ts() } : c);
    s.setGoalContributions(updated);
    syncWithRetry('goalContribution.update', { id, data });
    return updated.find(c => c.id === id);
  },

  remove(id: string): void {
    const s = useStore.getState();
    s.setGoalContributions(s.goalContributions.filter(c => c.id !== id));
    syncWithRetry('goalContribution.delete', { id });
  },

  /** Drop a goal's whole ledger. Called when the goal itself is deleted. */
  removeForGoal(goalId: string): void {
    const s = useStore.getState();
    const doomed = s.goalContributions.filter(c => c.goal_id === goalId);
    if (doomed.length === 0) return;
    s.setGoalContributions(s.goalContributions.filter(c => c.goal_id !== goalId));
    for (const c of doomed) syncWithRetry('goalContribution.delete', { id: c.id });
  },
};

// ─── LOANS / DEBT ─────────────────────────────────────────────────────────────

export const loansDS = {
  getAll(): Loan[] {
    return scoped(useStore.getState().loans);
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
    // The movement history has no meaning without the loan, and the server drops
    // it too (loan_events.loan_id is ON DELETE CASCADE) — so no delete is queued
    // per event, only the local rows are cleared.
    const withoutEvents = s.loanEvents.filter(e => e.loan_id !== id);
    if (withoutEvents.length !== s.loanEvents.length) s.setLoanEvents(withoutEvents);
    // Remove the mirrored repayment bill from the local store too, so it
    // disappears immediately (the backend deletes it server-side as well).
    // Match by loan_id when present, else fall back to the generated bill name.
    const repaymentName = loan ? `${loan.name} repayment` : null;
    const remaining = s.bills.filter(b =>
      b.loan_id !== id && !(repaymentName && b.category === 'loan' && b.name === repaymentName),
    );
    if (remaining.length !== s.bills.length) s.setBills(remaining);
    // A property pointing at this loan must be released. The server does the same
    // via ON DELETE SET NULL; doing it locally too means the property shows as
    // unencumbered immediately rather than netting a mortgage that no longer
    // exists. The property itself is untouched — deleting debt is not selling a
    // house. No sync write is queued: the FK already handled it server-side.
    const orphaned = s.properties.filter(pr => pr.loan_id === id);
    if (orphaned.length > 0) {
      s.setProperties(s.properties.map(pr =>
        pr.loan_id === id ? { ...pr, loan_id: null, updated_at: ts() } : pr));
    }
    // The backend deletes the linked repayment bill alongside the loan.
    syncWithRetry('loan.delete', { id });
  },

  /**
   * Record a repayment against the loan.
   *
   * The period's interest is charged FIRST (on the balance net of any offset) and
   * only what's left comes off the debt — the split a lender actually applies.
   * Before Phase 4.2 the whole repayment came off the balance, which quietly
   * understated a 30-year mortgage by years; a loan with no rate on file, and an
   * indexed debt like HECS, still behave exactly as they did because their
   * interest is zero.
   *
   * A PARTIAL payment (less than the scheduled repayment) reduces the balance but
   * does NOT advance the due date — that period is still owed. Anything paid ABOVE
   * the scheduled amount becomes redrawable, exactly like an extra repayment.
   *
   * A payment bigger than the loan is worth applies the PAYOFF figure (balance
   * plus the period's interest) and stops there — the balance lands on zero and
   * never goes past it into a negative debt that would read as an asset. The UI
   * makes the user correct or confirm that first (see checkMovement), so the
   * trim is never a surprise, and the event records what was applied.
   *
   * The backend keeps the linked bill's due date in sync via the loan.update, so
   * Bills & Reminders behaves as before.
   */
  markPaid(id: string, amount?: number): Loan | undefined {
    const s = useStore.getState();
    const loan = s.loans.find(l => l.id === id);
    if (!loan) return undefined;

    const paid = amount != null ? Math.max(0, amount) : (loan.minimum_repayment ?? 0);
    const split = applyRepayment(withResolvedOffset(loan), paid);

    // Only a payment that meets the schedule moves the loan on to the next one.
    let nextDue = loan.next_due_date;
    if (loan.next_due_date && split.meetsSchedule) {
      nextDue = nextOccurrence(new Date(loan.next_due_date), loan.repayment_frequency)
        .toISOString().split('T')[0];
    }

    const updated = this.update(id, {
      current_balance: split.current_balance,
      redraw_available: split.redraw_available,
      next_due_date: nextDue,
    });
    loanEventsDS.record(id, { kind: 'repayment', amount: split.applied });
    return updated;
  },

  /**
   * Pay extra off the loan. The debt falls and the same amount becomes
   * redrawable — money handed over early, which the user may take back.
   */
  recordExtraRepayment(id: string, amount: number, opts: { date?: string; note?: string } = {}): Loan | undefined {
    const loan = useStore.getState().loans.find(l => l.id === id);
    if (!loan) return undefined;
    const next = applyExtraRepayment(loan, amount);
    const updated = this.update(id, {
      current_balance: next.current_balance,
      redraw_available: next.redraw_available,
    });
    // The event records what was APPLIED, not what was asked for. A payment
    // bigger than the balance is capped at it (the UI has already made the user
    // confirm that), and the history has to agree with the balance it moved.
    loanEventsDS.record(id, {
      kind: 'extra_repayment',
      amount: next.applied,
      date: opts.date,
      note: opts.note,
    });
    return updated;
  },

  /**
   * Take money back out. This is RE-BORROWING: the balance rises by what was
   * taken and the available redraw falls by the same amount. Capped at what is
   * available, so a redraw can never invent borrowing capacity.
   */
  recordRedraw(id: string, amount: number, opts: { date?: string; note?: string } = {}): Loan | undefined {
    const loan = useStore.getState().loans.find(l => l.id === id);
    if (!loan) return undefined;
    const taken = Math.min(Math.max(0, amount), redrawLimit(loan));
    const next = applyRedraw(loan, amount);
    const updated = this.update(id, next);
    loanEventsDS.record(id, { kind: 'redraw', amount: taken, date: opts.date, note: opts.note });
    return updated;
  },

  /**
   * Record a rate change.
   *
   * One dated TODAY OR EARLIER is in force, so it becomes the loan's rate. One
   * dated in the FUTURE is only recorded: the projection picks it up from the
   * event (see loanRateSteps) and the loan keeps charging today's rate until the
   * day arrives — which is what makes "my fixed rate ends in March" projectable
   * without lying about what is being paid now.
   */
  recordRateChange(id: string, rate: number, opts: { date?: string; note?: string } = {}): Loan | undefined {
    const loan = useStore.getState().loans.find(l => l.id === id);
    if (!loan) return undefined;
    const date = opts.date || todayISO();
    const event = loanEventsDS.record(id, { kind: 'rate_change', amount: 0, rate, date, note: opts.note });
    if (!event) return loan;
    return date <= todayISO() ? this.update(id, { interest_rate: rate }) : loan;
  },

  /** Why a movement can't be recorded (empty = fine). Mirrors the engine's rules. */
  validateMovement(id: string, draft: LoanMovementDraft): string[] {
    const loan = useStore.getState().loans.find(l => l.id === id);
    if (!loan) return ['That loan no longer exists.'];
    return validateMovement(draft, withResolvedOffset(loan));
  },

  /**
   * The full check: what BLOCKS a movement and what merely overshoots.
   *
   * Callers must refuse to record while `requiresConfirmation` is true and
   * unconfirmed — that is what stops a repayment bigger than the loan being
   * quietly trimmed to fit. The offset is resolved first so the payoff figure
   * includes the same interest the repayment will actually be charged.
   */
  checkMovement(id: string, draft: LoanMovementDraft): MovementCheck {
    const loan = useStore.getState().loans.find(l => l.id === id);
    if (!loan) {
      return {
        errors: ['That loan no longer exists.'], warnings: [],
        maxApplicable: 0, excess: 0, appliedIfConfirmed: 0, requiresConfirmation: false,
      };
    }
    return checkMovement(draft, withResolvedOffset(loan));
  },

  /** The amortisation schedule for one loan, offset and rate changes included. */
  projection(id: string): LoanProjection | null {
    const loan = useStore.getState().loans.find(l => l.id === id);
    if (!loan) return null;
    return projectLoan(projectionInputForLoan(withResolvedOffset(loan), loanEventsDS.forLoan(id)));
  },

  /** "What if I paid more?" — the same engine, run twice, so the answer can't
   *  drift from the schedule the user is already being shown. */
  impact(id: string, change: RepaymentChange): RepaymentImpact | null {
    const loan = useStore.getState().loans.find(l => l.id === id);
    if (!loan) return null;
    return repaymentImpact(projectionInputForLoan(withResolvedOffset(loan), loanEventsDS.forLoan(id)), change);
  },

  /**
   * The ceiling on a tested extra repayment: what the loan still needs, and what
   * an amount past that is worth (nothing).
   *
   * Reuses the payoff figure the overpayment guard already enforces, so the
   * what-if panel and the record-a-repayment form can't disagree about how much
   * this loan takes to clear. The offset is resolved first — a linked account's
   * live balance lowers the interest inside that payoff figure, exactly as it
   * does everywhere else.
   */
  extraScenario(id: string, extraPerPeriod: number): ExtraRepaymentScenario | null {
    const loan = useStore.getState().loans.find(l => l.id === id);
    if (!loan) return null;
    return extraRepaymentScenario(withResolvedOffset(loan), extraPerPeriod);
  },

  /**
   * The ceiling on a tested addition to the offset: how much of the balance is
   * still charged interest, and what parking more than that is worth (nothing).
   *
   * The offset in force is resolved first, so the question is asked against the
   * linked account's LIVE balance rather than a figure typed months ago. Purely
   * a question — it reads the loan and the account and writes to neither.
   */
  offsetScenario(id: string, extraOffset: number): OffsetScenario | null {
    const loan = useStore.getState().loans.find(l => l.id === id);
    if (!loan) return null;
    return offsetScenario(withResolvedOffset(loan), extraOffset);
  },
};

/**
 * The offset actually in force on a loan.
 *
 * A loan may point at a bank account instead of storing a number, in which case
 * the account's LIVE balance is the offset. Resolved here rather than in the
 * engine so the engine stays pure, and returned as a copy so nothing writes a
 * derived figure back onto the loan.
 */
function withResolvedOffset(loan: Loan): Loan {
  if (!loan.offset_account_id) return loan;
  // The engine's one resolution rule, not a second copy of it: a linked loan
  // gets the account's live balance, and a link that can't be resolved gets 0
  // rather than the figure typed before the link existed.
  return { ...loan, offset_balance: resolveOffset(loan, offsetAccounts()).balance };
}

/** Cash accounts that can sit against a loan as an offset. */
function offsetAccounts(): OffsetAccount[] {
  const s = useStore.getState();
  const userId = s.user?.id ?? null;
  return s.accounts
    .filter(a => !userId || !a.user_id || a.user_id === userId)
    .map(a => ({ id: a.id, balance: Number(a.balance) || 0, name: a.name || a.institution || null }));
}

// ─── LOAN MOVEMENTS (Phase 4.2) ──────────────────────────────────────────────
//
// What MOVED a loan: repayments (including partial ones), extra repayments,
// redraws and rate changes. The loan's own current_balance stays the
// authoritative debt — Basiq syncs it and the user can correct it — so these
// rows are the audit trail of what changed it, never a second ledger net worth
// reads. That is why deleting an event leaves the balance where it is.

export const loanEventsDS = {
  /** Every movement belonging to the signed-in user. */
  getAll(): LoanEvent[] {
    const s = useStore.getState();
    const userId = s.user?.id ?? null;
    return s.loanEvents.filter(e => !userId || !e.user_id || e.user_id === userId);
  },

  /** One loan's movements, newest first. */
  forLoan(loanId: string): LoanEvent[] {
    return this.getAll()
      .filter(e => e.loan_id === loanId)
      .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
  },

  /** Record a movement. Called by the loansDS methods that move the balance, so
   *  the balance change and its audit row are always written together. */
  record(
    loanId: string,
    data: { kind: LoanEvent['kind']; amount: number; rate?: number | null; date?: string; note?: string | null },
  ): LoanEvent | undefined {
    const record: LoanEvent = {
      id: uuid(),
      user_id: uid(),
      loan_id: loanId,
      kind: data.kind,
      amount: parseFloat((Number(data.amount) || 0).toFixed(2)),
      rate: data.rate ?? null,
      date: data.date || todayISO(),
      note: data.note ?? null,
      created_at: ts(),
      updated_at: ts(),
    };
    const s = useStore.getState();
    s.setLoanEvents([...s.loanEvents, record]);
    syncWithRetry('loanEvent.create', {
      recordId: record.id,
      data: {
        loan_id: record.loan_id, kind: record.kind, amount: record.amount,
        rate: record.rate, date: record.date, note: record.note,
      },
    });
    return record;
  },

  /**
   * Forget a movement.
   *
   * The RECORD goes; its effect does not. The balance it changed belongs to the
   * loan and stays where the user left it — silently unwinding a repayment
   * because its history row was tidied away would be far worse than a gap in the
   * audit trail.
   */
  remove(id: string): void {
    const s = useStore.getState();
    s.setLoanEvents(s.loanEvents.filter(e => e.id !== id));
    syncWithRetry('loanEvent.delete', { id });
  },
};

/** Gatherer: the user's loans, their movements, the properties they back and the
 *  accounts offsetting them, run through the engine. */
export const loanReportDS = {
  build(opts: { today?: string } = {}): LoanReport {
    const s = useStore.getState();
    // Scoped, not owner-filtered: a household view must project the loans the
    // household was shown, whoever's name is on them. Personal stays the
    // user's own loans — sharing one never removes it from its owner's report.
    const loans = scoped(s.loans);
    return buildLoanReport(loans, loanEventsDS.getAll(), propertiesDS.getAll(), {
      today: opts.today,
      offsetAccounts: offsetAccounts(),
    });
  },

  /** One loan's worked-out row, or null when it isn't there. */
  row(id: string) {
    return this.build().rows.find(r => r.id === id) ?? null;
  },
};

// ─── PROPERTIES (Phase 4.1 property foundation) ──────────────────────────────
//
// A property is an ASSET. Its mortgage is an ordinary loan that keeps living in
// loansDS — this layer only stores a pointer to it. That is what keeps the debt
// counted exactly once: net worth adds the owned share of the value from here
// and subtracts the loan balance over there. Every figure the user reads
// (equity, LVR, gain, totals) is computed by utils/property.ts, never stored.

/**
 * Fields the server accepts — never id/user_id/timestamps.
 *
 * The five address parts are REQUIRED server-side, so a BLANK one is never sent.
 * Every write here carries the whole record (that is what makes a replay out of
 * the sync queue safe), which meant a property saved before the address became
 * structured shipped five nulls and had every unrelated edit — a net-worth
 * toggle included — rejected with a 400. Omitting the key leaves whatever is
 * stored alone; a real address change still sends a real value.
 */
function propertyPayload(p: Property): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    name: p.name ?? null,
    address: p.address ?? null,
    address_unit: p.address_unit ?? null,
    property_type: p.property_type,
    held_by: p.held_by ?? 'personal',
    smsf_fund_id: p.smsf_fund_id ?? null,
    super_fund_id: p.super_fund_id ?? null,
    counted_in_fund_balance: p.counted_in_fund_balance !== false,
    purchase_price: p.purchase_price,
    purchase_date: p.purchase_date ?? null,
    current_value: p.current_value,
    ownership_percent: p.ownership_percent,
    loan_id: p.loan_id ?? null,
    include_in_net_worth: p.include_in_net_worth !== false,
    notes: p.notes ?? null,
    // Phase 4.3 — how this property recognises its own transactions. Always
    // sent as arrays (never null) so clearing the last term actually clears it:
    // an omitted key would leave the old rules in place server-side.
    match_terms: p.match_terms ?? [],
    match_account_ids: p.match_account_ids ?? [],
    // Rent: who pays it, where it lands and what it should be. Sent for every
    // property, including the nulls an owner-occupied home carries — that is
    // how switching a rental back to a home actually CLEARS its rent rules
    // rather than leaving them stored and silently still matching.
    rent_match_terms: p.rent_match_terms ?? [],
    rent_account_id: p.rent_account_id ?? null,
    expected_rent_amount: p.expected_rent_amount ?? null,
    expected_rent_frequency: p.expected_rent_frequency ?? null,
    // Expenses, one rule per cost. Sent whole for the same reason as the arrays
    // above: the list IS the setting, so deleting the last rule has to arrive as
    // an empty list rather than as a missing key the server would ignore.
    property_expenses: p.property_expenses ?? [],
    // Payments the user has taken back off this property. Kept server-side so
    // the correction survives a reinstall — otherwise the rule would quietly
    // reclaim the transaction on the next device.
    excluded_transaction_ids: p.excluded_transaction_ids ?? [],
  };

  const REQUIRED_PARTS = [
    'address_street', 'address_suburb', 'address_state', 'address_postcode', 'address_country',
  ] as const;
  for (const key of REQUIRED_PARTS) {
    const value = p[key];
    if (typeof value === 'string' && value.trim()) payload[key] = value.trim();
  }
  return payload;
}

/**
 * The funds a property can be held in.
 *
 * Super funds live in the store, but SMSFs are backend-only — there is no SMSF
 * slice in the client store — so their half of the list is fetched and cached in
 * memory. Callers read whatever is known synchronously and refresh in the
 * background: a slow (or missing) SMSF API must never block adding a property,
 * it just means the fund can't be named yet.
 */
let smsfFundCache: FundEntity[] = [];

export const propertyFundsDS = {
  /** Every fund known right now — the user's super funds plus the cached SMSFs. */
  list(): FundEntity[] {
    const s = useStore.getState();
    const userId = s.user?.id ?? null;
    const supers: FundEntity[] = s.superFunds
      .filter(f => !userId || !f.user_id || f.user_id === userId)
      .map(f => ({
        kind: 'super' as const,
        id: f.id,
        name: f.fund_name,
        includeInNetWorth: f.include_in_net_worth !== false,
      }));
    return availableFundsForProperty([...smsfFundCache, ...supers]);
  },

  /** Refresh the SMSF half of the list, then return the merged list. */
  async load(): Promise<FundEntity[]> {
    try {
      const data = await smsfApi.getAll() as {
        funds?: Array<{ id: string; name: string; include_in_net_worth?: boolean }>;
      };
      smsfFundCache = (data?.funds ?? []).map(f => ({
        kind: 'smsf' as const,
        id: f.id,
        name: f.name,
        includeInNetWorth: f.include_in_net_worth !== false,
      }));
    } catch {
      // Offline, or no SMSF set up. Keep whatever was already known.
    }
    return this.list();
  },

  /** Forget the cached SMSFs — one user's funds must never show up for another. */
  reset(): void { smsfFundCache = []; },
};

export const propertiesDS = {
  /** The properties in the current scope. The owner filter this used to do by
   *  hand IS the personal scope, so nothing changes for a user without a
   *  household — it is simply expressed once now, for every entity. */
  getAll(): Property[] {
    return scoped(useStore.getState().properties);
  },

  add(data: Omit<Property, 'id' | 'user_id' | 'created_at' | 'updated_at'>): Property {
    const record: Property = { ...data, id: uuid(), user_id: uid(), created_at: ts(), updated_at: ts() };
    const s = useStore.getState();
    s.setProperties([...s.properties, record]);
    syncWithRetry('property.create', { recordId: record.id, data: propertyPayload(record) });
    return record;
  },

  update(id: string, data: Partial<Property>): Property | undefined {
    const s = useStore.getState();
    const updated = s.properties.map(p => p.id === id ? { ...p, ...data, updated_at: ts() } : p);
    s.setProperties(updated);
    const record = updated.find(p => p.id === id);
    if (record) {
      // `propertyPayload` is a whitelist of the property's own columns, and which
      // households a row sits in is not one of them — it lives in `record_households`
      // and reaches the server as `household_ids`. Carried through ONLY when the
      // caller actually asked to change it, so an ordinary property edit still says
      // nothing about sharing and can't overwrite it.
      const payload = propertyPayload(record);
      if (data.household_ids) payload.household_ids = data.household_ids;
      syncWithRetry('property.update', { id, data: payload });
    }
    return record;
  },

  /**
   * Delete the property. The linked loan is deliberately left alone — the
   * mortgage is money still owed whether or not the asset is tracked here, and
   * silently removing debt would overstate net worth.
   */
  remove(id: string): void {
    const s = useStore.getState();
    s.setProperties(s.properties.filter(p => p.id !== id));
    syncWithRetry('property.delete', { id });
  },

  /** Loans this property may link to — see availableLoansForProperty. */
  availableLoans(propertyId?: string | null): Loan[] {
    const userId = useStore.getState().user?.id ?? null;
    const loans = useStore.getState().loans.filter(l => !userId || !l.user_id || l.user_id === userId);
    return availableLoansForProperty(loans, this.getAll(), propertyId ?? null);
  },

  /** Funds this property may be held in — SMSFs first, then super funds. */
  availableFunds(): FundEntity[] {
    return propertyFundsDS.list();
  },

  /** Why a draft can't be saved (empty = fine). Mirrors the server's checks. */
  validate(draft: PropertyDraft, propertyId?: string | null): string[] {
    const userId = useStore.getState().user?.id ?? null;
    const loans = useStore.getState().loans.filter(l => !userId || !l.user_id || l.user_id === userId);
    return validateProperty(draft, {
      loans,
      properties: this.getAll(),
      propertyId: propertyId ?? null,
      funds: propertyFundsDS.list(),
    });
  },
};

/**
 * Gatherer: the user's properties + the loans and funds they point at, run
 * through the engine.
 *
 * Phase 4.3 also hands it the user's TRANSACTIONS, because rent and expenses are
 * ordinary transactions the property claims rather than a ledger of its own. They
 * are passed as one list so the engine can settle a contested transaction on the
 * spot — the same rent can never be counted by two properties.
 */
export const propertyReportDS = {
  build(asOf?: string): PropertyReport {
    const userId = useStore.getState().user?.id ?? null;
    const loans = useStore.getState().loans.filter(l => !userId || !l.user_id || l.user_id === userId);
    const transactions = useStore.getState().transactions
      .filter(t => !userId || !t.user_id || t.user_id === userId);
    return buildPropertyReport(propertiesDS.getAll(), loans, propertyFundsDS.list(), {
      transactions,
      asOf,
    });
  },
};


// ─── INSURANCE (Phase 8.2) ───────────────────────────────────────────────────
//
// A policy is stored; everything ABOUT a policy is derived. What cover costs a
// year, how close its renewal is, whether it has lapsed and what its premium has
// done are all worked out by the pure engine in utils/insurance.ts, so the
// Insurance page, the renewal alert and the premium insight are three views of
// one calculation rather than three calculations.
//
// Sharing: a policy has none of its own. The server stamps `household_ids` from
// the record the policy COVERS, which is why `scoped()` below — the same call
// every other entity makes — puts a policy in exactly the household views its
// property or account is already in, with no special case anywhere on the client.

/** Fields the server accepts — never id/user_id/timestamps/household_ids. */
function insurancePayload(p: InsurancePolicy): Record<string, unknown> {
  return {
    name: p.name,
    policy_type: p.policy_type,
    insurer: p.insurer ?? null,
    policy_number: p.policy_number ?? null,
    premium_amount: p.premium_amount ?? 0,
    premium_frequency: p.premium_frequency ?? 'annually',
    start_date: p.start_date ?? null,
    renewal_date: p.renewal_date ?? null,
    excess: p.excess ?? null,
    coverage_amount: p.coverage_amount ?? null,
    linked_type: p.linked_type ?? null,
    linked_id: p.linked_id ?? null,
    document_id: p.document_id ?? null,
    notes: p.notes ?? null,
    active: p.active !== false,
  };
}

export const insurancePremiumHistoryDS = {
  /** Every premium record belonging to the signed-in user. Not scoped to a
   *  household: what a shared house is INSURED FOR is household business, what
   *  its owner has paid over the years is theirs. */
  getAll(): InsurancePremiumRecord[] {
    const s = useStore.getState();
    const userId = s.user?.id ?? null;
    return s.insurancePremiumHistory.filter(r => !userId || !r.user_id || r.user_id === userId);
  },

  /** One policy's prices, oldest first — the order a change is read in. */
  forPolicy(policyId: string): InsurancePremiumRecord[] {
    return this.getAll()
      .filter(r => r.policy_id === policyId)
      .sort((a, b) => (a.effective_date ?? '').localeCompare(b.effective_date ?? ''));
  },

  /**
   * Record what the premium became, and from when.
   *
   * Called by the insuranceDS methods that set a price, so the new premium and
   * the record of the change are always written in one act — the same pairing
   * loan events have with a balance move. Nothing derives the premium FROM this
   * history; the policy's own figure stays the truth about today.
   */
  record(
    policyId: string,
    data: { amount: number; frequency: InsurancePolicy['premium_frequency']; date?: string; note?: string | null },
  ): InsurancePremiumRecord {
    const record: InsurancePremiumRecord = {
      id: uuid(),
      user_id: uid(),
      policy_id: policyId,
      premium_amount: parseFloat((Number(data.amount) || 0).toFixed(2)),
      premium_frequency: data.frequency,
      effective_date: data.date || todayInDisplayTz(),
      note: data.note ?? null,
      created_at: ts(),
    };
    const s = useStore.getState();
    s.setInsurancePremiumHistory([...s.insurancePremiumHistory, record]);
    syncWithRetry('insurancePremium.create', {
      recordId: record.id,
      data: {
        policy_id: record.policy_id,
        premium_amount: record.premium_amount,
        premium_frequency: record.premium_frequency,
        effective_date: record.effective_date,
        note: record.note,
      },
    });
    return record;
  },

  /** Forget a price record. The premium it described stays on the policy — an
   *  observation being tidied away must never silently re-price the cover. */
  remove(id: string): void {
    const s = useStore.getState();
    s.setInsurancePremiumHistory(s.insurancePremiumHistory.filter(r => r.id !== id));
    syncWithRetry('insurancePremium.delete', { id });
  },
};

export const insuranceDS = {
  /** The policies in the current scope — yours in the personal view, the
   *  household's in a household view, exactly as every other entity behaves. */
  getAll(): InsurancePolicy[] {
    return scoped(useStore.getState().insurancePolicies);
  },

  /**
   * Every policy this device may see, scope ignored — including ones shared with
   * the user through a record they do not own. The page's "Shared with you"
   * section is drawn from the difference between this and `getAll()`; totals and
   * alerts use `getAll()`, so a policy somebody else owns never reaches a figure
   * presented as yours.
   */
  visible(): InsurancePolicy[] {
    return useStore.getState().insurancePolicies;
  },

  find(id: string): InsurancePolicy | undefined {
    return this.visible().find(p => p.id === id);
  },

  add(data: Omit<InsurancePolicy, 'id' | 'user_id' | 'created_at' | 'updated_at'>): InsurancePolicy {
    const record: InsurancePolicy = {
      ...data, id: uuid(), user_id: uid(), created_at: ts(), updated_at: ts(),
    };
    const s = useStore.getState();
    s.setInsurancePolicies([...s.insurancePolicies, record]);
    syncWithRetry('insurance.create', { recordId: record.id, data: insurancePayload(record) });

    // The opening price, recorded as the first point of the policy's history.
    // Without it the first change would have nothing to be a change FROM, and
    // the most useful thing insurance can tell anybody — "it went up at
    // renewal" — could not be said until the second change.
    if ((record.premium_amount ?? 0) > 0) {
      insurancePremiumHistoryDS.record(record.id, {
        amount: record.premium_amount,
        frequency: record.premium_frequency,
        date: record.start_date || undefined,
        note: 'Opening premium',
      });
    }
    return record;
  },

  /**
   * Edit a policy — and, when the PRICE changed, record that as history in the
   * same act.
   *
   * The premium and its history can therefore never disagree: there is no path
   * that writes one without the other. The effective date is the policy's own
   * renewal date when the user moved it (a renewal is what re-prices cover) and
   * otherwise today.
   */
  update(id: string, data: Partial<InsurancePolicy>): InsurancePolicy | undefined {
    const s = useStore.getState();
    const before = s.insurancePolicies.find(p => p.id === id);
    const updated = s.insurancePolicies.map(p =>
      p.id === id ? { ...p, ...data, updated_at: ts() } : p);
    s.setInsurancePolicies(updated);

    const record = updated.find(p => p.id === id);
    if (!record) return undefined;

    const payload = insurancePayload(record);
    // Which households a row sits in is not one of its own columns — a policy's
    // are derived from what it covers — so nothing about sharing is ever sent.
    syncWithRetry('insurance.update', { id, data: payload });

    const priceMoved = !!before && (
      (before.premium_amount ?? 0) !== (record.premium_amount ?? 0)
      || before.premium_frequency !== record.premium_frequency
    );
    if (priceMoved) {
      const renewalMoved = !!before && before.renewal_date !== record.renewal_date;
      insurancePremiumHistoryDS.record(id, {
        amount: record.premium_amount,
        frequency: record.premium_frequency,
        date: renewalMoved && record.renewal_date ? record.renewal_date : undefined,
        note: renewalMoved ? 'Renewal' : null,
      });
    }
    return record;
  },

  /** Mark cover as no longer held. Kept rather than deleted so last year's
   *  policy — and what it cost — is still answerable. */
  setActive(id: string, active: boolean): InsurancePolicy | undefined {
    return this.update(id, { active });
  },

  remove(id: string): void {
    const s = useStore.getState();
    s.setInsurancePolicies(s.insurancePolicies.filter(p => p.id !== id));
    // The price history has no meaning without the policy, and the server drops
    // it too (ON DELETE CASCADE), so the local rows are simply cleared — no
    // per-record delete is queued.
    const remaining = s.insurancePremiumHistory.filter(r => r.policy_id !== id);
    if (remaining.length !== s.insurancePremiumHistory.length) {
      s.setInsurancePremiumHistory(remaining);
    }
    syncWithRetry('insurance.delete', { id });
  },

  /** Load policies and their premium history from the server. Both in one call,
   *  because a history without its policy prices nothing. */
  async refresh(): Promise<void> {
    try {
      const { policies, history } = await insuranceApi.getAll();
      const s = useStore.getState();
      s.setInsurancePolicies(mergeServerAuthoritative(policies ?? [], s.insurancePolicies, 'insurance.create'));
      s.setInsurancePremiumHistory(
        mergeServerAuthoritative(history ?? [], s.insurancePremiumHistory, 'insurancePremium.create'),
      );
    } catch (err) {
      console.warn('[insurance] refresh failed:', err);
    }
  },
};

/** Gatherer: the policies in scope and the premium records behind them, run
 *  through the engine. The ONE place a report is built, so the page, the alerts
 *  and the insights all read the same figures. */
export const insuranceReportDS = {
  build(asOf?: string): InsuranceReport {
    return buildInsuranceReport({
      asOf: asOf ?? todayInDisplayTz(),
      policies: insuranceDS.getAll() as unknown as InsurancePolicyInput[],
      premiumHistory: insurancePremiumHistoryDS.getAll() as unknown as PremiumRecordInput[],
    });
  },

  /** The same report over everything visible, including policies shared with the
   *  user through a record they don't own — what the Insurance page draws. */
  visible(asOf?: string): InsuranceReport {
    return buildInsuranceReport({
      asOf: asOf ?? todayInDisplayTz(),
      policies: insuranceDS.visible() as unknown as InsurancePolicyInput[],
      premiumHistory: insurancePremiumHistoryDS.getAll() as unknown as PremiumRecordInput[],
    });
  },
};

// ─── BUDGETS (Phase 4.1 budgeting foundation) ────────────────────────────────
//
// A budget is a MONTHLY spending cap, either on one category or on all spending
// at once (scope='overall'). This layer only persists caps — every figure the
// user sees (spent / remaining / % used / projected month-end) is computed by
// the pure engine in utils/budgeting.ts and served by budgetReportDS below.
//
// Writes go through the standard offline-safe path (local first, then
// syncWithRetry), so a budget set on a plane persists and syncs on landing, and
// the same budget read on another device comes from the server row.

/** Fields the server accepts — never id/user_id/timestamps. */
function budgetPayload(b: Budget): Record<string, unknown> {
  return {
    scope: b.scope ?? 'category',
    category: b.scope === 'overall' ? null : b.category,
    limit_amount: b.limit_amount,
    period: b.period,
    rollover_enabled: b.rollover_enabled,
    start_month: b.start_month ?? null,
    active: b.active !== false,
  };
}

export const budgetsDS = {
  getAll(): Budget[] {
    return scoped(useStore.getState().budgets);
  },

  /** Live budgets in the current scope (retired ones dropped). The owner filter
   *  this used to apply by hand is now the personal scope — and in the household
   *  scope it would have been wrong, silently hiding the shared cap a partner
   *  set. */
  active(): Budget[] {
    return this.getAll().filter(b => b.active !== false);
  },

  /** The active budget for a category (case-insensitive), if one exists. */
  forCategory(category: string): Budget | undefined {
    const key = (category ?? '').trim().toLowerCase();
    if (!key) return undefined;
    return this.active().find(b =>
      (b.scope ?? 'category') === 'category' && (b.category ?? '').trim().toLowerCase() === key);
  },

  /** The active overall (all-spending) budget, if one exists. */
  overall(): Budget | undefined {
    return this.active().find(b => b.scope === 'overall');
  },

  add(data: Omit<Budget, 'id' | 'user_id' | 'created_at' | 'updated_at'>): Budget {
    const record: Budget = { ...data, id: uuid(), user_id: uid(), created_at: ts(), updated_at: ts() };
    const s = useStore.getState();
    s.setBudgets([...s.budgets, record]);

    syncWithRetry('budget.create', { recordId: record.id, data: budgetPayload(record) });

    return record;
  },

  update(id: string, data: Partial<Budget>): Budget {
    const s = useStore.getState();
    const updated = s.budgets.map(b => b.id === id ? { ...b, ...data, updated_at: ts() } : b);
    s.setBudgets(updated);

    syncWithRetry('budget.update', { id, data });

    return updated.find(b => b.id === id)!;
  },

  remove(id: string): void {
    const s = useStore.getState();
    s.setBudgets(s.budgets.filter(b => b.id !== id));
    syncWithRetry('budget.delete', { id });
  },

  /**
   * Set (or clear) the monthly cap on a category. Upserts by category name so
   * calling it twice edits one budget instead of creating a duplicate — the
   * same guarantee the DB's unique index enforces server-side. `amount <= 0`
   * removes the budget.
   *
   * Any category works, including one the user invented: the name is also
   * registered as a custom category so it appears everywhere categories are
   * picked.
   */
  setCategoryBudget(
    category: string,
    amount: number,
    opts: { rollover?: boolean; startMonth?: string | null } = {},
  ): Budget | null {
    const name = (category ?? '').trim();
    if (!name) return null;
    const existing = this.forCategory(name);

    if (!(amount > 0)) {
      if (existing) this.remove(existing.id);
      return null;
    }

    customCategoriesDS.add(name);

    if (existing) {
      return this.update(existing.id, {
        category: name,
        limit_amount: amount,
        period: 'monthly',
        rollover_enabled: opts.rollover ?? existing.rollover_enabled,
        start_month: opts.startMonth !== undefined ? opts.startMonth : existing.start_month,
        active: true,
      });
    }

    return this.add({
      scope: 'category',
      category: name,
      limit_amount: amount,
      period: 'monthly',
      rollover_enabled: opts.rollover ?? false,
      start_month: opts.startMonth ?? currentBudgetMonth(),
      active: true,
    });
  },

  /** Set (or clear, with `amount <= 0`) the single overall spending cap. */
  setOverallBudget(
    amount: number,
    opts: { rollover?: boolean; startMonth?: string | null } = {},
  ): Budget | null {
    const existing = this.overall();

    if (!(amount > 0)) {
      if (existing) this.remove(existing.id);
      return null;
    }

    if (existing) {
      return this.update(existing.id, {
        limit_amount: amount,
        period: 'monthly',
        rollover_enabled: opts.rollover ?? existing.rollover_enabled,
        start_month: opts.startMonth !== undefined ? opts.startMonth : existing.start_month,
        active: true,
      });
    }

    return this.add({
      scope: 'overall',
      category: null,
      limit_amount: amount,
      period: 'monthly',
      rollover_enabled: opts.rollover ?? false,
      start_month: opts.startMonth ?? currentBudgetMonth(),
      active: true,
    });
  },

  /** Re-point budgets when a category is renamed (see applyCategoryRename). */
  renameCategory(from: string, to: string): number {
    const before = this.getAll();
    const after = applyCategoryRename(before, from, to);
    let changed = 0;
    for (let i = 0; i < after.length; i++) {
      if (after[i] === before[i]) continue;
      changed++;
      const { category, active } = after[i];
      this.update(before[i].id, { category, active });
    }
    return changed;
  },

  /**
   * One-time import of the Overview budget PLANNER's category goals as real
   * monthly budgets. Idempotent — a category that already has a budget is left
   * alone, so running it twice imports nothing the second time.
   */
  seedFromPlan(): number {
    const s = useStore.getState();
    const planCategories = s.budgetLines
      .filter(l => l.is_category_budget)
      .map(l => ({ name: l.name, amount: l.amount }));
    const proposed = budgetsFromLegacyPlan(planCategories, s.budgetSettings?.period, this.getAll());
    for (const p of proposed) this.setCategoryBudget(p.category, p.monthlyLimit);
    return proposed.length;
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

/** Everything in the store that references a category by name. */
function usageSources(): UsageSources {
  const s = useStore.getState();
  return {
    budgets: s.budgets,
    rules: s.transactionRules,
    transactions: s.transactions,
    splits: s.transactionSplits,
  };
}

/**
 * Move split lines off a category. Splits have no update op of their own — the
 * only supported write is a whole-transaction replace — so each affected parent
 * is rewritten with its amounts untouched, which is what keeps the
 * splits-sum-to-parent rule satisfied.
 */
function repointSplits(parentIds: string[], from: string, to: string): void {
  for (const parentId of parentIds) {
    const lines = transactionSplitsDS.forTransaction(parentId);
    if (lines.length === 0) continue;
    transactionSplitsDS.setSplits(parentId, lines.map(l => ({
      category: sameCategory(l.category, from) ? to : l.category,
      amount: l.amount,
      notes: l.notes ?? undefined,
      tags: l.tags ?? undefined,
    })));
  }
}

/**
 * Keep the Settings menu honest when a category is renamed or removed.
 *
 * The allowlist and the legacy blocklist are lists of NAMES, so a category that
 * has gone leaves a dead entry behind. Harmless on its own, but a stale name
 * silently re-selects itself if the user ever recreates the category, and the
 * saved list is what syncs to their other devices.
 */
function forgetCategoryName(from: string, to: string | null): void {
  const s = useStore.getState();

  if (s.selectedCategories) {
    const wasSelected = s.selectedCategories.some(c => sameCategory(c, from));
    const kept = s.selectedCategories.filter(c => !sameCategory(c, from));
    // The destination inherits the source's place in the menu — but only if the
    // source had one. Adding it otherwise would silently switch on a category
    // the user had chosen not to see.
    const next = to && wasSelected && !kept.some(c => sameCategory(c, to)) ? [...kept, to] : kept;
    // Compare contents, not length: a rename swaps one name for another and
    // leaves the count identical.
    if (next.join(' ') !== s.selectedCategories.join(' ')) {
      s.setSelectedCategories(next);
      patchUiPrefs({ selected_categories: next });
    }
  }

  const hidden = s.hiddenCategories.filter(c => !sameCategory(c, from));
  if (hidden.length !== s.hiddenCategories.length) s.setHiddenCategories(hidden);
}

export const customCategoriesDS = {
  getAll(): CustomCategory[] {
    return useStore.getState().customCategories;
  },

  /** Names of user-created categories, for merging into the built-in lists. */
  names(): string[] {
    return useStore.getState().customCategories.map(c => c.name);
  },

  /**
   * Every category name that exists right now — built-ins plus the user's own
   * plus anything a budget commits to. The input to every identity decision.
   */
  known(): string[] {
    const s = useStore.getState();
    const committed = s.budgets
      .filter(b => b.active !== false && b.scope !== 'overall')
      .map(b => (b.category ?? '').trim());
    return mergeCategories([...s.customCategories.map(c => c.name), ...committed]);
  },

  /**
   * What does this typed name actually refer to? See `utils/categoryResolve` —
   * deterministic spellings resolve silently, close misses come back as a
   * SUGGESTION for the user to confirm, and nothing is ever merged on a guess.
   */
  resolve(input: string): CategoryResolution {
    const s = useStore.getState();
    return resolveCategoryName(input, { known: this.known(), aliases: s.categoryAliases });
  },

  /**
   * Remember what the user decided about a spelling — that it means an existing
   * category, or that it is genuinely its own. Either way they are asked once.
   * Mirrored to `ui_preferences` so the decision follows them to other devices.
   */
  rememberAlias(input: string, canonical: string): void {
    const s = useStore.getState();
    const next = rememberDecision(s.categoryAliases, input, canonical);
    if (next === s.categoryAliases) return;
    s.setCategoryAliases(next);
    patchUiPrefs({ category_aliases: next });
  },

  add(name: string): CustomCategory | null {
    const clean = tidyCategoryName(name);
    if (!clean) return null;
    const s = useStore.getState();
    // De-dupe by IDENTITY, so "groceries", "Groceries " and "Groceries!" can
    // never become three rows for one category.
    const existing = s.customCategories.find(c => sameCategory(c.name, clean));
    if (existing) return existing;
    const record: CustomCategory = { id: uuid(), user_id: uid(), name: clean, created_at: ts(), updated_at: ts() };
    s.setCustomCategories([...s.customCategories, record]);
    syncWithRetry('customCategory.create', { recordId: record.id, data: { name: clean } });
    return record;
  },

  /**
   * Create a category from a name the user typed, applying the identity rules.
   *
   * Returns the name that ended up being used, so the caller can select it. A
   * resolution that needs confirmation is NOT decided here — the caller shows
   * the prompt and calls back in with the user's answer.
   */
  addResolved(name: string): { name: string; created: boolean } {
    const resolution = this.resolve(name);
    const chosen = resolvedName(resolution);
    if (!chosen) return { name: '', created: false };
    // 'exact'/'alias' already point at a live category — nothing to create, and
    // creating anything would be the duplicate we are here to prevent.
    if (resolution.status === 'exact' || resolution.status === 'alias') {
      return { name: chosen, created: false };
    }
    const before = useStore.getState().customCategories.length;
    this.add(chosen);
    return { name: chosen, created: useStore.getState().customCategories.length > before };
  },

  remove(id: string): void {
    const s = useStore.getState();
    s.setCustomCategories(s.customCategories.filter(c => c.id !== id));
    syncWithRetry('customCategory.delete', { id });
  },

  /** How many loaded transactions are filed under a category (case-insensitive). */
  countTransactions(category: string): number {
    const key = (category ?? '').trim().toLowerCase();
    if (!key) return 0;
    return useStore.getState().transactions
      .filter(t => (t.category ?? '').trim().toLowerCase() === key).length;
  },

  /** Everything currently pointing at a category name (see `categoryUsage`). */
  usage(name: string): CategoryUsage {
    return countCategoryUsage(name, usageSources());
  },

  /** Why this category can't be deleted, or null if it can be. */
  deleteBlockedReason(name: string): string | null {
    return undeletableReason(name, this.names());
  },

  /**
   * Delete a category the user created, and deal with everything that pointed
   * at it. Never destructive: nothing is deleted except the category row.
   *
   *   • `reassignTo` given → this is a merge, so it runs through `rename()`,
   *     which already moves budgets, rules, transactions, splits and aliases
   *     together.
   *   • otherwise → transactions and split lines become Uncategorised, budgets
   *     on it are RETIRED, and rules that stamped it stop stamping it.
   *
   * Retiring the budgets is not tidiness. `reconcile()` registers a category
   * for every active budget on the next load, so a live budget left behind
   * would quietly recreate the category the user just deleted.
   */
  deleteCategory(
    name: string, opts: { reassignTo?: string | null } = {},
  ): { ok: false; reason: string } | { ok: true; plan: ReturnType<typeof planCategoryDeletion> } {
    const blocked = this.deleteBlockedReason(name);
    if (blocked) return { ok: false, reason: blocked };

    const plan = planCategoryDeletion(name, usageSources(), opts);

    if (plan.reassignTo) {
      this.rename(plan.name, plan.reassignTo);
      return { ok: true, plan };
    }

    for (const id of plan.budgetIds) budgetsDS.update(id, { active: false });

    for (const edit of plan.ruleEdits) {
      const patch: Partial<TransactionRule> = { actions: edit.actions };
      if (edit.disable) patch.enabled = false;
      transactionRulesDS.update(edit.id, patch);
    }

    for (const id of plan.transactionIds) {
      transactionsDS.update(id, { category: UNCATEGORISED });
    }
    repointSplits(plan.splitParentIds, plan.name, UNCATEGORISED);

    const row = this.getAll().find(c => sameCategory(c.name, plan.name));
    if (row) this.remove(row.id);

    forgetCategoryName(plan.name, null);
    this.prune();

    return { ok: true, plan };
  },

  /** Drop alias decisions that point at a category which no longer exists. */
  prune(): void {
    const s = useStore.getState();
    const pruned = pruneAliases(s.categoryAliases, this.known());
    if (Object.keys(pruned).length === Object.keys(s.categoryAliases).length) return;
    s.setCategoryAliases(pruned);
    patchUiPrefs({ category_aliases: pruned });
  },

  /**
   * Rename a category EVERYWHERE it is used, in one step.
   *
   * A category name is a soft foreign key: transactions, budgets and the
   * custom-category row all reference it by string. Renaming only one of them
   * silently breaks the link — a budget re-pointed at "Eating out" while its
   * transactions still say "Dining" reads as zero spend, which looks like a
   * bug and hides real overspending. So all three move together:
   *
   *   • the custom-category row (recreated under the new name — there is no
   *     server-side rename, and add() de-dupes if the name already exists);
   *   • every budget on the old name (see applyCategoryRename: a budget that
   *     would collide with an existing cap is retired, never merged);
   *   • every LOADED transaction filed under the old name, and every split line
   *     inside one;
   *   • every rule that STAMPS the old name, which would otherwise keep filing
   *     new transactions under a category that no longer exists;
   *   • the Settings allowlist, so the renamed category stays selected.
   *
   * Transactions outside the loaded window keep the old name. That is a real
   * limit, not an oversight: the store holds only the recent window, and the
   * caller shows the count returned here so the user knows what moved.
   */
  rename(from: string, to: string): { budgets: number; transactions: number; rules: number; splits: number } {
    const fromName = (from ?? '').trim();
    const toName = (to ?? '').trim();
    const fromKey = fromName.toLowerCase();
    if (!fromKey || !toName || fromKey === toName.toLowerCase()) {
      return { budgets: 0, transactions: 0, rules: 0, splits: 0 };
    }

    const plan = planCategoryDeletion(fromName, usageSources(), { reassignTo: toName });

    this.add(toName);
    const old = this.getAll().find(c => c.name.trim().toLowerCase() === fromKey);
    if (old) this.remove(old.id);

    const budgets = budgetsDS.renameCategory(fromName, toName);

    const moving = useStore.getState().transactions
      .filter(t => (t.category ?? '').trim().toLowerCase() === fromKey);
    for (const t of moving) transactionsDS.update(t.id, { category: toName });

    for (const edit of plan.ruleEdits) transactionRulesDS.update(edit.id, { actions: edit.actions });
    repointSplits(plan.splitParentIds, fromName, toName);
    forgetCategoryName(fromName, toName);

    // A remembered "grocuries means Groceries" must follow Groceries when it is
    // renamed, or it starts pointing at a category that no longer exists.
    const s = useStore.getState();
    const repointed = Object.fromEntries(
      Object.entries(s.categoryAliases).map(([k, v]) => [k, sameCategory(v, fromName) ? toName : v]),
    );
    if (JSON.stringify(repointed) !== JSON.stringify(s.categoryAliases)) {
      s.setCategoryAliases(repointed);
      patchUiPrefs({ category_aliases: repointed });
    }

    return {
      budgets, transactions: moving.length,
      rules: plan.ruleEdits.length, splits: plan.usage.splits,
    };
  },

  /**
   * SELF-HEAL: make the category taxonomy agree with itself.
   *
   * Budgets, custom categories and the Settings menu each hold category names as
   * plain strings, and until now nothing guaranteed they used the SAME string.
   * That produced the visible bug — a budget on "Groceries" with no matching
   * category row, so Groceries never appeared when categorising a transaction —
   * and the invisible one, several rows for one category.
   *
   * Three passes, all idempotent and all non-destructive:
   *
   *   1. collapse custom-category rows that are the same category differently
   *      spelled, keeping the first (built-in spelling wins, see `known()`);
   *   2. re-point any budget whose category differs only in spelling from a real
   *      category onto that category's canonical name;
   *   3. give every remaining budget category a custom-category row, so a
   *      budget-only category becomes a first-class one instead of a name that
   *      exists nowhere else.
   *
   * A budget naming something merely SIMILAR to a known category (a typo) is
   * left exactly as it is and registered under its own name — auto-merging on a
   * guess is the one thing this must never do. Transactions are not rewritten:
   * spend matching is case-insensitive, so re-pointing a budget's display name
   * cannot move money, and rewriting history to fix casing would be a large,
   * un-asked-for write.
   *
   * Runs on every bootstrap; once settled it does nothing.
   */
  reconcile(): { merged: number; repointed: number; registered: number } {
    const result = { merged: 0, repointed: 0, registered: 0 };

    // ── 1. Duplicate custom-category rows ──
    {
      const rows = useStore.getState().customCategories;
      const seen = new Set<string>();
      for (const row of rows) {
        const key = categoryKey(row.name);
        if (!key) continue;
        if (seen.has(key)) { this.remove(row.id); result.merged++; continue; }
        seen.add(key);
      }
    }

    // ── 2. Budget categories that are a known category, differently spelled ──
    //
    // `budgetsDS.renameCategory` is deliberately NOT used here: it delegates to
    // applyCategoryRename, which treats a spelling-only rename as a no-op (from
    // its point of view "Groceries" → "groceries" changes nothing). That is the
    // right call for a user rename and exactly wrong for this pass, whose whole
    // job is settling spellings. So the budget row is updated directly.
    {
      const stamp = (b: Budget) => b.updated_at ?? b.created_at ?? '';
      const claimed = new Map<string, Budget>();

      for (const b of budgetsDS.active()) {
        if (b.scope === 'overall') continue;
        const current = tidyCategoryName(b.category);
        if (!current) continue;
        const key = categoryKey(current);

        // Two active budgets for ONE category is already broken — the engine
        // keeps whichever was updated last and ignores the other. Make that
        // explicit rather than arbitrary: retire the older row so the cap the
        // user currently sees is the one that survives.
        const rival = claimed.get(key);
        if (rival) {
          const survivor = stamp(b) >= stamp(rival) ? b : rival;
          const loser = survivor === b ? rival : b;
          claimed.set(key, survivor);
          budgetsDS.update(loser.id, { active: false });
          result.merged++;
          // The survivor's own spelling settles on the next pass; reconcile is
          // convergent, and bootstrap runs it on every load.
          continue;
        }
        claimed.set(key, b);

        // Resolve against every OTHER name — including this budget's own would
        // just match itself.
        const others = mergeCategories([
          ...useStore.getState().customCategories.map(c => c.name),
          ...budgetsDS.active()
            .filter(x => x.id !== b.id && x.scope !== 'overall')
            .map(x => tidyCategoryName(x.category)),
        ]);
        const resolution = resolveCategoryName(current, {
          known: others, aliases: useStore.getState().categoryAliases,
        });
        if (resolution.status !== 'exact' && resolution.status !== 'alias') continue;
        if (resolution.canonical === current) continue;
        budgetsDS.update(b.id, { category: resolution.canonical });
        result.repointed++;
      }
    }

    // ── 3. Budget-only categories become real categories ──
    for (const b of budgetsDS.active()) {
      if (b.scope === 'overall') continue;
      const name = tidyCategoryName(b.category);
      if (!name) continue;
      const before = useStore.getState().customCategories.length;
      // add() skips built-ins? No — it de-dupes against custom rows only, so a
      // built-in would gain a redundant row. Guard on the full known list.
      const isKnownElsewhere = mergeCategories(useStore.getState().customCategories.map(c => c.name))
        .some(k => sameCategory(k, name));
      if (isKnownElsewhere) continue;
      this.add(name);
      if (useStore.getState().customCategories.length > before) result.registered++;
    }

    // ── Aliases pointing at categories that have since gone ──
    {
      const s = useStore.getState();
      const pruned = pruneAliases(s.categoryAliases, this.known());
      if (Object.keys(pruned).length !== Object.keys(s.categoryAliases).length) {
        s.setCategoryAliases(pruned);
      }
    }

    return result;
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

// ─── BILL ↔ SUBSCRIPTION RECONCILIATION ──────────────────────────────────────
// A recurring charge can exist as BOTH an auto-detected subscription and a manual
// bill — a duplicate in the list and double-counted in the forecast. This surfaces
// evidence-based "possible same bill" candidates (never auto-linking) and applies
// the user's decision: "Same bill" links them (subscription_id + one shared name,
// which the forecast then de-dups), "Different bills" is persisted so the pair is
// never suggested again.
//
// "Different bills" decisions are stored CROSS-DEVICE: the authoritative store is
// the synced `bill_subscription_exclusions` table (via billSubExclusions in the
// store, loaded on bootstrap and written through syncWithRetry). localStorage is
// kept as a per-device OFFLINE CACHE layered on top — a decision made offline still
// suppresses locally and syncs when back online. Both are keyed by the STABLE anchor
// `differentDecisionKey`, so a decision survives occurrence-id churn and renames.

function reconDifferentCacheKey(): string { return `ledger-bill-sub-different-${uid()}`; }

export const billReconciliationDS = {
  /** localStorage offline cache of decision keys (per device/user). */
  _localCache(): Set<string> {
    try { return new Set(JSON.parse(localStorage.getItem(reconDifferentCacheKey()) ?? '[]') as string[]); }
    catch { return new Set(); }
  },
  _saveLocalCache(set: Set<string>): void {
    localStorage.setItem(reconDifferentCacheKey(), JSON.stringify([...set]));
  },
  /** Synced decision keys from the store (authoritative, cross-device). */
  _syncedKeys(): Set<string> {
    return new Set(useStore.getState().billSubExclusions.map(e => e.decision_key));
  },

  /** Has the user marked this bill and subscription as genuinely different? Union
   *  of the synced decisions and the local offline cache. */
  isDifferent(bill: ReconBill, sub: ReconSubscription): boolean {
    const key = differentDecisionKey(bill, sub);
    return this._syncedKeys().has(key) || this._localCache().has(key);
  },

  /** True when a bill and a subscription resolve to the SAME account/card, false
   *  when they resolve to different ones, null when either side is unassigned. */
  _sameAccount(bill: ReconBill, sub: ReconSubscription): boolean | null {
    if (!bill.account_id || !sub.account_id) return null;
    if (bill.account_id === sub.account_id) return true;
    const owners = [...accountsDS.getAll(), ...creditCardsDS.getAll()];
    const shared = owners.some(o =>
      accountIdMatches(bill.account_id!, o) && accountIdMatches(sub.account_id!, o));
    return shared;
  },

  /** Evidence-based candidates for review, best match per bill, strongest first. */
  candidates(): ReconCandidate[] {
    const s = useStore.getState();
    return findReconciliationCandidates(s.bills, s.subscriptions, {
      isDifferent: (b, sub) => this.isDifferent(b, sub),
      sameAccount: (b, sub) => this._sameAccount(b, sub),
    });
  },

  /** Confirm "Same bill": link the bill to the subscription and unify the name to
   *  the user-preferred canonical (never the raw import text over an edited name). */
  link(billId: string, subId: string): void {
    const s = useStore.getState();
    const bill = s.bills.find(b => b.id === billId);
    const sub = s.subscriptions.find(x => x.id === subId);
    if (!bill || !sub) return;
    const canonical = preferredCanonicalName(bill, sub);
    // Link + adopt the canonical name. billsDS.update propagates the name to the
    // subscription when it changes; if it doesn't change the bill, rename the sub
    // explicitly so both always end on the same canonical name.
    billsDS.update(billId, { subscription_id: subId, name: canonical });
    if (sub.name.trim().toLowerCase() !== canonical.trim().toLowerCase()) {
      subscriptionsDS.rename(subId, canonical);
    }
  },

  /** Persist a "Different bills" decision cross-device so the pair is never
   *  suggested again: write the synced store row (+ enqueue the backend upsert)
   *  AND the local offline cache. Idempotent by decision_key. */
  markDifferent(billId: string, subId: string): void {
    const s = useStore.getState();
    const bill = s.bills.find(b => b.id === billId);
    const sub = s.subscriptions.find(x => x.id === subId);
    if (!bill || !sub) return;
    const key = differentDecisionKey(bill, sub);

    // Local offline cache.
    const cache = this._localCache();
    cache.add(key);
    this._saveLocalCache(cache);

    // Synced store row + backend upsert (skip if already present by key).
    if (!s.billSubExclusions.some(e => e.decision_key === key)) {
      const row: BillSubscriptionExclusion = { id: uuid(), user_id: uid(), decision_key: key, created_at: ts() };
      s.setBillSubExclusions([...s.billSubExclusions, row]);
      syncWithRetry('billSubExclusion.create', { data: { decision_key: key } });
    }
  },

  /** Reverse a "Different bills" decision (re-allow suggestions): clear the synced
   *  store row (+ enqueue the backend delete) AND the local cache, by anchor key. */
  removeDifferent(billId: string, subId: string): void {
    const s = useStore.getState();
    const bill = s.bills.find(b => b.id === billId);
    const sub = s.subscriptions.find(x => x.id === subId);
    if (!bill || !sub) return;
    const key = differentDecisionKey(bill, sub);

    const cache = this._localCache();
    if (cache.delete(key)) this._saveLocalCache(cache);

    if (s.billSubExclusions.some(e => e.decision_key === key)) {
      s.setBillSubExclusions(s.billSubExclusions.filter(e => e.decision_key !== key));
      syncWithRetry('billSubExclusion.delete', { key });
    }
  },
};

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

// ─── HOUSEHOLDS (Phase 7.1) ──────────────────────────────────────────────────
//
// A household holds PEOPLE, never money. Everything below either changes who is
// in one or records/removes a row's household membership beside it — there
// is no create, no copy and no balance anywhere in this section.
//
// Unlike the rest of this file these calls are NOT local-first. A household is
// shared with somebody else, so its truth is the server's: inviting a partner
// optimistically and finding out later that it failed would be a worse lie than
// a spinner. Sharing a ROW is the opposite case — it is one column on a record
// the user already owns, so it rides the existing update path and its retry
// queue, and works offline exactly as every other edit does.

export const householdsDS = {
  getAll(): Household[] {
    return useStore.getState().households;
  },

  members(householdId?: string | null): HouseholdMember[] {
    const ctx = householdContext();
    const id = householdId ?? resolveActiveHouseholdId(ctx);
    return id ? activeMembers(useStore.getState().householdMembers, id) : [];
  },

  /**
   * Every household the user is in — a couple, a family, an investment group —
   * each with its own member list and its own shared picture.
   *
   * Nothing about belonging to several needed a new model: `household_members`
   * was always one row per person per household, so a second membership was
   * always legal. What was missing was only ever the screen.
   */
  mine(): {
    household: Household;
    role: string | null;
    memberCount: number;
    isActive: boolean;
  }[] {
    const ctx = householdContext();
    const active = resolveActiveHouseholdId(ctx);
    return myHouseholds(ctx).map(household => ({
      household,
      role: householdRoleIn(ctx, household.id),
      memberCount: activeMembers(useStore.getState().householdMembers, household.id).length,
      isActive: household.id === active,
    }));
  },

  /** Point the household view at one of them. A household the user is not in is
   *  ignored rather than obeyed — a stale id must never resolve. */
  switchTo(householdId: string | null): void {
    const s = useStore.getState();
    if (householdId === null) { s.setFinanceScope('personal'); return; }
    if (!householdIsMine(householdId)) return;
    s.setActiveHouseholdId(householdId);
    s.setFinanceScope('household');
  },

  /** The active household, its members and what the signed-in user may do. */
  current() {
    const ctx = householdContext();
    const id = resolveActiveHouseholdId(ctx);
    if (!id) return null;
    const household = useStore.getState().households.find(h => h.id === id) ?? null;
    if (!household) return null;
    return {
      household,
      role: householdRoleIn(ctx, id),
      members: memberViews(ctx, id),
      can: {
        invite: householdCan(ctx, 'invite_member', id),
        remove: householdCan(ctx, 'remove_member', id),
        changeRole: householdCan(ctx, 'change_role', id),
        rename: householdCan(ctx, 'rename_household', id),
        delete: householdCan(ctx, 'delete_household', id),
        editShared: householdCan(ctx, 'edit_shared', id),
        shareOwn: householdCan(ctx, 'share_own', id),
      },
    };
  },

  /** Invitations sent by this household (for the owner/admin who can see them). */
  outgoingInvitations(householdId?: string | null): HouseholdInvitation[] {
    const ctx = householdContext();
    const id = householdId ?? resolveActiveHouseholdId(ctx);
    return id ? liveInvitations(useStore.getState().householdInvitations, id, ts()) : [];
  },

  /** Invitations waiting for the signed-in user's own address. */
  myInvitations(): HouseholdInvitation[] {
    const s = useStore.getState();
    return invitationsFor(s.householdInvitations, s.user?.email ?? null, ts());
  },

  /** Reload households, members and invitations from the server. */
  async refresh(): Promise<void> {
    try {
      const data = await householdsApi.getAll();
      const s = useStore.getState();
      s.setHouseholds(data.households ?? []);
      s.setHouseholdMembers(data.members ?? []);
      s.setHouseholdInvitations(data.invitations ?? []);
      // A household the user is no longer in must not stay selected, or the
      // household view keeps answering questions about a household they lost.
      const ctx = householdContext();
      const resolved = resolveActiveHouseholdId(ctx);
      if (s.activeHouseholdId !== resolved) s.setActiveHouseholdId(resolved);
      if (!resolved && s.financeScope === 'household') s.setFinanceScope('personal');
    } catch (err) {
      // Never fatal: a user with no households (almost everybody) is unaffected,
      // and one with households keeps the cached copy until the next attempt.
      console.warn('[household] refresh failed:', err);
    }
  },

  async create(name: string, currency?: string): Promise<Household> {
    const { household } = await householdsApi.create({ name, currency });
    await this.refresh();
    useStore.getState().setActiveHouseholdId(household.id);
    return household;
  },

  async rename(id: string, name: string): Promise<void> {
    await householdsApi.update(id, { name });
    await this.refresh();
  },

  /** Deletes the household. Every shared row reverts to personal, owned by
   *  whoever owned it all along — no money is deleted. The local copies are
   *  un-stamped here too so the screen matches the server without a reload. */
  async remove(id: string): Promise<void> {
    await householdsApi.remove(id);
    unstampLocalRows(id, () => true);
    await this.refresh();
  },

  async invite(id: string, email: string, role: string): Promise<HouseholdInvitation> {
    const invitation = await householdsApi.invite(id, { email, role });
    await this.refresh();
    return invitation;
  },

  async revokeInvite(id: string, inviteId: string): Promise<void> {
    await householdsApi.revokeInvite(id, inviteId);
    await this.refresh();
  },

  /** Accepting mints a MEMBERSHIP — the invitation itself grants nothing. The
   *  full bootstrap that follows is what pulls in the household's shared rows. */
  async acceptInvite(code: string): Promise<Household | null> {
    const { household } = await householdsApi.acceptInvite(code);
    await this.refresh();
    if (household?.id) useStore.getState().setActiveHouseholdId(household.id);
    return household ?? null;
  },

  async declineInvite(code: string): Promise<void> {
    await householdsApi.declineInvite(code);
    await this.refresh();
  },

  async setRole(id: string, memberId: string, role: string): Promise<void> {
    await householdsApi.setRole(id, memberId, role);
    await this.refresh();
  },

  /** Removal takes ACCESS, never money: the departing member's own shared rows
   *  revert to personal (server side, mirrored locally), and every other
   *  member's rows are untouched. */
  async removeMember(id: string, memberId: string): Promise<void> {
    const target = useStore.getState().householdMembers.find(m => m.id === memberId);
    await householdsApi.removeMember(id, memberId);
    if (target) unstampLocalRows(id, r => r.user_id === target.user_id);
    await this.refresh();
  },

  async leave(id: string): Promise<void> {
    const me = useStore.getState().user?.id ?? null;
    await householdsApi.leave(id);
    unstampLocalRows(id, r => !r.user_id || r.user_id === me);
    // Rows the OTHER members shared are no longer visible to this user — dropped
    // rather than left in a cache that nothing will ever refresh. But only when
    // THIS household was the last reason they could see them: a row shared with
    // two households, one of which they're still in, stays.
    const stillMine = new Set(
      myHouseholds(householdContext()).map(h => h.id).filter(h => h !== id),
    );
    dropLocalRows(r =>
      householdsOf(r).includes(id) && !!r.user_id && r.user_id !== me &&
      !householdsOf(r).some(h => stillMine.has(h)));
    await this.refresh();
  },

  async transfer(id: string, memberId: string): Promise<void> {
    await householdsApi.transfer(id, memberId);
    await this.refresh();
  },

  // ── Join links (Phase 7.2) ─────────────────────────────────────────────────
  //
  // The other half of getting somebody in. An invitation is addressed to one
  // email; a join link is addressed to nobody, and whoever holds it joins at the
  // household's `join_role`. Rotating the link invalidates the previous one, so
  // "regenerate" and "withdraw the old one" are the same single call.

  async regenerateJoinCode(id: string, role?: string): Promise<Household | null> {
    const { household } = await householdsApi.regenerateCode(id, role ? { role } : undefined);
    await this.refresh();
    return household ?? null;
  },

  async revokeJoinCode(id: string): Promise<void> {
    await householdsApi.revokeCode(id);
    await this.refresh();
  },

  /** Join by link. Mints a MEMBERSHIP — the code itself grants nothing, exactly
   *  as an invitation grants nothing until it is accepted. */
  async joinByCode(code: string): Promise<Household | null> {
    const { household } = await householdsApi.join(code.trim());
    await this.refresh();
    if (household?.id) {
      useStore.getState().setActiveHouseholdId(household.id);
      useStore.getState().setFinanceScope('household');
    }
    return household ?? null;
  },
};

/** Is this a household the signed-in user is actually an active member of? */
function householdIsMine(householdId: string): boolean {
  return myHouseholds(householdContext()).some(h => h.id === householdId);
}

/** Every store slice that can carry a household stamp, with its setter. */
function shareableSlices() {
  const s = useStore.getState();
  return [
    { rows: s.accounts as Shareable[],    set: (r: Shareable[]) => s.setAccounts(r as BankAccount[]) },
    { rows: s.creditCards as Shareable[], set: (r: Shareable[]) => s.setCreditCards(r as CreditCard[]) },
    { rows: s.transactions as Shareable[],set: (r: Shareable[]) => s.setTransactions(r as Transaction[]) },
    { rows: s.loans as Shareable[],       set: (r: Shareable[]) => s.setLoans(r as Loan[]) },
    { rows: s.properties as Shareable[],  set: (r: Shareable[]) => s.setProperties(r as Property[]) },
    { rows: s.budgets as Shareable[],     set: (r: Shareable[]) => s.setBudgets(r as Budget[]) },
    { rows: s.goals as Shareable[],       set: (r: Shareable[]) => s.setGoals(r as Goal[]) },
    { rows: s.investments as Shareable[], set: (r: Shareable[]) => s.setInvestments(r as Investment[]) },
    { rows: s.incomeEntries as Shareable[], set: (r: Shareable[]) => s.setIncomeEntries(r as IncomeEntry[]) },
    { rows: s.bills as Shareable[],       set: (r: Shareable[]) => s.setBills(r as Bill[]) },
  ];
}

/**
 * Take ONE household off matching local rows. Mirrors what the server does on
 * removal/leave/deletion — the rows themselves are untouched, and a row that is
 * also in another household stays in that one.
 */
function unstampLocalRows(householdId: string, match: (row: Shareable) => boolean): void {
  const affected = (r: Shareable) => match(r) && householdsOf(r).includes(householdId);
  for (const slice of shareableSlices()) {
    if (!slice.rows.some(affected)) continue;
    slice.set(slice.rows.map(r => (affected(r)
      ? { ...r, household_ids: householdsOf(r).filter(h => h !== householdId), household_id: null }
      : r)));
  }
}

/** Patch ONE local row in place, in whichever slice holds it — display state
 *  only (overlay maps and the like), never a queued write. Ids are UUIDs, so
 *  matching by id alone cannot touch a row of another kind. */
function patchLocalShareable(id: string, patch: Partial<Shareable>): void {
  for (const slice of shareableSlices()) {
    if (!slice.rows.some(r => r.id === id)) continue;
    slice.set(slice.rows.map(r => (r.id === id ? { ...r, ...patch } : r)));
  }
}

/** Forget rows the user can no longer see. Only ever other members' rows, and
 *  only from this device's cache — nothing is deleted anywhere. */
function dropLocalRows(match: (row: Shareable) => boolean): void {
  for (const slice of shareableSlices()) {
    if (!slice.rows.some(match)) continue;
    slice.set(slice.rows.filter(r => !match(r)));
  }
}

/**
 * The entity kinds a row can be, for the one sharing entry point below.
 *
 * An ALIAS rather than a second union: households and direct grants have to
 * agree on what "an account" is called, and two lists of the same seven strings
 * would only ever be one careless edit away from disagreeing.
 */
export type ShareableKind = ShareRecordType;

/** The sharing patch: which households the row should be in, plus — when the
 *  owner is re-sharing a row a household edited while it was last shared — the
 *  choice of which version that household should now see ('keep' its edited
 *  overlay, or 'reset' it so the household sees the row as the owner has it). */
type SharePatch = {
  household_ids: string[];
  household_overlay_resolutions?: Record<string, 'keep' | 'reset'>;
};

const SHARE_UPDATERS: Record<ShareableKind, (id: string, patch: SharePatch) => void> = {
  account:     (id, patch) => { accountsDS.update(id, patch); },
  card:        (id, patch) => { creditCardsDS.update(id, patch); },
  transaction: (id, patch) => { transactionsDS.update(id, patch); },
  loan:        (id, patch) => { loansDS.update(id, patch); },
  property:    (id, patch) => { propertiesDS.update(id, patch); },
  budget:      (id, patch) => { budgetsDS.update(id, patch); },
  goal:        (id, patch) => { goalsDS.update(id, patch); },
  investment:  (id, patch) => { investmentsDS.update(id, patch); },
  income:      (id, patch) => { incomeDS.update(id, patch); },
  bill:        (id, patch) => { billsDS.update(id, patch); },
};

function findShareable(kind: ShareableKind, id: string): Shareable | undefined {
  const s = useStore.getState();
  const lists: Record<ShareableKind, Shareable[]> = {
    account: s.accounts, card: s.creditCards, transaction: s.transactions,
    loan: s.loans, property: s.properties, budget: s.budgets, goal: s.goals,
    investment: s.investments, income: s.incomeEntries, bill: s.bills,
  };
  return lists[kind].find(r => r.id === id);
}

/** One member's row of the household spending summary, with the names the
 *  screen needs resolved (engine rows carry only ids). */
export interface MemberSpendingView extends MemberSpendingRow {
  name: string | null;
  email: string | null;
  isYou: boolean;
}

/**
 * Making a row personal or shared.
 *
 * One entry point for all seven entities, because it is one operation: set or
 * change which households a row that already exists sits in. It writes exactly that
 * column — a share can never move a balance, a date or an owner as a side
 * effect — and it goes through the entity's normal update, so it queues and
 * retries like every other edit.
 */
export const sharingDS = {
  /** Whether the current user could share this row, and why not if they can't. */
  canShare(kind: ShareableKind, id: string, householdId?: string | null): { ok: boolean; error?: string } {
    const row = findShareable(kind, id);
    if (!row) return { ok: false, error: 'Not found' };
    const ctx = householdContext();
    const target = householdId ?? resolveActiveHouseholdId(ctx);
    if (!target) return { ok: false, error: "You're not in a household yet." };
    const plan = planShare(row, ctx, target);
    return { ok: plan.ok, error: plan.error };
  },

  /**
   * `overlayResolution` matters only when this household edited the row while
   * it was last shared and the owner is sharing it back: 'keep' shows the
   * household its own last-seen version again, 'reset' clears that overlay so
   * the household sees the row as the owner has it now.
   */
  share(
    kind: ShareableKind, id: string, householdId?: string | null,
    overlayResolution?: 'keep' | 'reset',
  ): { ok: boolean; error?: string } {
    const row = findShareable(kind, id);
    if (!row) return { ok: false, error: 'Not found' };
    const ctx = householdContext();
    const target = householdId ?? resolveActiveHouseholdId(ctx);
    if (!target) return { ok: false, error: "You're not in a household yet." };

    const plan = planShare(row, ctx, target);
    if (!plan.ok) return { ok: false, error: plan.error };
    const patch: SharePatch = overlayResolution
      ? { ...plan.patch!, household_overlay_resolutions: { [target]: overlayResolution } }
      : plan.patch!;
    SHARE_UPDATERS[kind](id, patch);
    // A reset is a promise the household sees the owner's version NOW — reflect
    // it locally in the same beat rather than waiting for the next full load.
    if (overlayResolution === 'reset' && row.household_overlays?.[target]) {
      const { [target]: _cleared, ...rest } = row.household_overlays;
      patchLocalShareable(id, { household_overlays: rest });
    }
    return { ok: true };
  },

  /** Take a row out of ONE household, or — with no id — out of all of them.
   *  Every other household it's in is left exactly as it was. */
  unshare(kind: ShareableKind, id: string, householdId?: string | null): { ok: boolean; error?: string } {
    const row = findShareable(kind, id);
    if (!row) return { ok: false, error: 'Not found' };
    const plan = planUnshare(row, householdContext(), householdId);
    if (!plan.ok) return { ok: false, error: plan.error };
    SHARE_UPDATERS[kind](id, plan.patch!);
    return { ok: true };
  },

  /** A household's surviving EDITED version of this row (a member change the
   *  owner declined or hasn't answered), if any — what the re-share choice
   *  ("their version or mine?") is drawn from. */
  overlay(kind: ShareableKind, id: string, householdId: string): Record<string, unknown> | null {
    const row = findShareable(kind, id);
    const overlay = row?.household_overlays?.[householdId];
    return overlay && Object.keys(overlay).length ? overlay : null;
  },

  /** Is this row shared, and may this user change it? What a row's menu asks. */
  status(kind: ShareableKind, id: string) {
    const row = findShareable(kind, id);
    if (!row) return null;
    const ctx = householdContext();
    return {
      shared: householdsOf(row).length > 0,
      householdIds: householdsOf(row),
      mine: !row.user_id || row.user_id === ctx.userId,
      canEdit: canEdit(row, ctx),
      canView: canView(row, ctx),
      refusal: editRefusal(row, ctx),
    };
  },

  /** How much of each entity is shared — the Household settings summary. */
  summary(householdId?: string | null): Record<ShareableKind, SharingSummary> {
    const s = useStore.getState();
    const ctx = householdContext();
    const of = (rows: Shareable[]) => summariseSharing(rows, ctx, householdId);
    return {
      account: of(s.accounts), card: of(s.creditCards), transaction: of(s.transactions),
      loan: of(s.loans), property: of(s.properties), budget: of(s.budgets), goal: of(s.goals),
      investment: of(s.investments), income: of(s.incomeEntries), bill: of(s.bills),
    };
  },

  /** Shared spending grouped by WHO IS RESPONSIBLE for it — reporting only; see
   *  the note on `responsible_user_id`. Balances come from account rows, so this
   *  can move a transaction between columns and never move a net worth. */
  spendByMember(householdId?: string | null): Map<string, Transaction[]> {
    return byResponsibility(useStore.getState().transactions, householdContext(), householdId);
  },

  /** Attribute a shared transaction to whoever actually spent it. Clears any
   *  responsibility split — a single answer and a many-person answer to the same
   *  question must never both stand, or reports would have to pick one. */
  setResponsible(transactionId: string, userId: string | null): void {
    transactionsDS.update(transactionId, { responsible_user_id: userId, responsibility_split: null });
  },

  /** Who a transaction's spending belongs to. */
  responsibleFor(transactionId: string): string | null {
    const row = findShareable('transaction', transactionId) as Transaction | undefined;
    return row ? responsibleFor(row, householdContext().userId) : null;
  },

  /** Who paid for a transaction (null/absent attribution = its owner). */
  paidBy(transactionId: string): string | null {
    const row = findShareable('transaction', transactionId) as Transaction | undefined;
    return row ? paidByOf(row, householdContext().userId) : null;
  },

  /**
   * Phase 7.2 — the whole attribution in one write: who paid, and either the
   * single responsible member or a split between several (by amount or percent).
   * One update, one sync-queue entry, so an offline save can't half-apply.
   * A split is validated against the transaction's own amount before anything
   * is written — an unbalanced split is refused here exactly as the UI refuses
   * to save it, so reporting never has to guess at a broken one.
   */
  setAttribution(
    transactionId: string,
    attribution: {
      paidBy?: string | null;
      responsible?: string | null;
      split?: ResponsibilityLine[] | null;
    },
  ): { ok: boolean; error?: string } {
    const row = findShareable('transaction', transactionId) as Transaction | undefined;
    if (!row) return { ok: false, error: 'Not found' };
    if (attribution.split?.length) {
      const check = validateResponsibilitySplit(attribution.split, row.amount);
      if (!check.ok) {
        return {
          ok: false,
          error: check.error === 'sum_mismatch'
            ? (check.mode === 'percent'
                ? 'The percentages have to add up to 100.'
                : 'The shares have to add up to the whole amount.')
            : 'Each line needs a member and a positive share.',
        };
      }
    }
    transactionsDS.update(transactionId, {
      // The owner is the default answer, so storing them explicitly adds nothing
      // — null keeps the row meaning exactly what it meant before 7.2 touched it.
      paid_by_user_id: attribution.paidBy === row.user_id ? null : attribution.paidBy ?? null,
      responsible_user_id: attribution.split?.length
        ? null
        : attribution.responsible === row.user_id ? null : attribution.responsible ?? null,
      responsibility_split: attribution.split?.length ? attribution.split : null,
    });
    return { ok: true };
  },

  /**
   * Phase 7.2 — the household's shared spending this month, per member: what
   * each person PAID for vs what they were RESPONSIBLE for, with the difference
   * stated (never recorded — Ledger keeps no IOU ledger). Transactions inherit
   * their shared account's households first, exactly as every transaction list
   * does, so a joint-account purchase counts without anyone stamping it.
   */
  memberSpending(householdId?: string | null): MemberSpendingView[] {
    const s = useStore.getState();
    const ctx = householdContext();
    const id = householdId ?? resolveActiveHouseholdId(ctx);
    if (!id) return [];
    const monthStart = new Date();
    monthStart.setDate(1);
    const since = monthStart.toISOString().split('T')[0];
    const rows = memberSpending(
      withAccountStamps(s.transactions).filter(t => t.date >= since),
      ctx, id,
    );
    const memberOf = (userId: string) => s.householdMembers.find(m =>
      m.household_id === id && m.user_id === userId) ?? s.householdMembers.find(m => m.user_id === userId);
    return rows.map(r => {
      const m = memberOf(r.userId);
      return {
        ...r,
        name: m?.name ?? null,
        email: m?.email ?? null,
        isYou: r.userId === s.user?.id,
      };
    });
  },

  // ── Direct sharing (Phase 7.2) ─────────────────────────────────────────────
  //
  // The other grant. A household stamp puts a row into a shared VIEW with totals
  // of its own; a direct grant lets one named person SEE one row that stays
  // entirely its owner's and enters no total anywhere. Everything below either
  // mints a code, redeems one, or ends a grant — none of it writes to a
  // financial row, and none of it can move a balance.

  /** Where this row currently sits: personal or in a household, and who else can
   *  see it directly. What the row's own Sharing menu is drawn from. */
  assignment(kind: ShareableKind, id: string) {
    const row = findShareable(kind, id);
    if (!row) return null;
    const ctx = sharingContext();
    return {
      ...assignmentOf(kind, row, ctx),
      /** The households it could be moved into. */
      targets: shareTargets(ctx, row),
      /** Codes minted for it that nobody has redeemed yet. */
      pendingCodes: liveCodesFor(ctx, kind, id, ts()),
      canEdit: canEditRecord(kind, row, ctx),
      canDelete: canDeleteRecord(row, ctx),
      refusal: editRecordRefusal(kind, row, ctx),
    };
  },

  /** The people this row is shared with directly. */
  people(kind: ShareableKind, id: string): RecordShare[] {
    return grantsOn(sharingContext(), kind, id);
  },

  /** Can this user mint a share link for this row, and why not if they can't. */
  canShareDirectly(kind: ShareableKind, id: string): { ok: boolean; error?: string } {
    const row = findShareable(kind, id);
    if (!row) return { ok: false, error: 'Not found' };
    const plan = planShareCode(kind, row, sharingContext(), ts());
    return { ok: plan.ok, error: plan.error };
  },
};

// ─── DIRECT SHARING (Phase 7.2) ──────────────────────────────────────────────
//
// Server-authoritative like households, and for the same reason: a grant is an
// agreement with somebody else, so guessing at it optimistically and finding out
// later that it failed would be a worse lie than a spinner.

export const sharesDS = {
  /** Grants this user holds — rows other people shared with them. */
  incoming(): RecordShare[] {
    return grantsIHold(sharingContext());
  },

  /** Grants this user gave — rows they shared with other people. */
  outgoing(): RecordShare[] {
    return grantsIGave(sharingContext());
  },

  /** Live codes nobody has redeemed yet. */
  codes(): ShareCode[] {
    return liveCodes(sharingContext(), ts());
  },

  /** "What have I shared, who with, and what has been shared with me" — the
   *  Sharing screen, resolved against whatever the rows are actually called. */
  overview() {
    const ctx = sharingContext();
    return {
      totals: sharingOverview(ctx, ts()),
      given: sharedByMe(ctx, labelOfRecord, ts()),
      held: incomingShares(ctx, labelOfRecord),
    };
  },

  /** Reload grants and codes from the server. */
  async refresh(): Promise<void> {
    try {
      const data = await sharesApi.getAll();
      const s = useStore.getState();
      s.setRecordShares(data.shares ?? []);
      s.setShareCodes(data.codes ?? []);
    } catch (err) {
      // Never fatal. A user who shares nothing — nearly everybody — is
      // unaffected, and one who does keeps the cached grants until next time.
      console.warn('[sharing] refresh failed:', err);
    }
  },

  /**
   * Mint a share link for a row the caller owns.
   *
   * Owner-only, checked here and again on the server: a household member who can
   * edit the joint account still cannot publish it to a stranger. Editing
   * somebody's account and handing out sight of it are not the same permission.
   */
  async createCode(
    kind: ShareableKind, id: string, permission: SharePermission = 'view',
  ): Promise<ShareCode> {
    const row = findShareable(kind, id);
    if (!row) throw new Error('Not found');
    const plan = planShareCode(kind, row, sharingContext(), ts(), permission);
    if (!plan.ok) throw new Error(plan.error ?? 'Could not share that.');
    const { code } = await sharesApi.createCode({
      record_type: kind, record_id: id, permission,
      label: labelOfRecord(kind, id) ?? undefined,
    });
    await this.refresh();
    return code;
  },

  async revokeCode(codeId: string): Promise<void> {
    await sharesApi.revokeCode(codeId);
    await this.refresh();
  },

  /**
   * Redeem somebody's code.
   *
   * Returns `{ already: true }` rather than failing when the caller can already
   * see the row: together with the database's one-live-grant-per-person index,
   * that is the whole of duplicate prevention — no amount of link-passing can
   * make one row appear on one screen twice.
   */
  async redeem(code: string): Promise<{ share: RecordShare | null; already: boolean }> {
    const result = await sharesApi.redeem(code.trim());
    await this.refresh();
    // The rows themselves arrive with the next bootstrap; a grant with nothing
    // behind it yet simply shows nothing, which is better than showing a stale
    // guess at somebody else's balance.
    return { share: result.share ?? null, already: !!result.already };
  },

  /**
   * End a grant, from either side.
   *
   * The owner revokes; the recipient leaves. Both stop the access and NEITHER
   * deletes anything: the account keeps its balance, its transactions and its
   * owner, and disappears from exactly one screen.
   */
  async end(grantId: string): Promise<{ ok: boolean; error?: string }> {
    const ctx = sharingContext();
    const grant = ctx.shares.find(g => g.id === grantId);
    if (!grant) return { ok: false, error: 'Not found' };
    const plan = planEndGrant(grant, ctx, ts());
    if (!plan.ok) return { ok: false, error: plan.error };

    await sharesApi.end(grantId);
    // Drop the rows this device can no longer see. Only ever somebody else's,
    // and only from this cache — nothing is deleted anywhere.
    if (grant.shared_with_user_id === ctx.userId) {
      const cascade = cascadeOfEnding(grant, useStore.getState().transactions);
      const gone = new Set([grant.record_id, ...cascade.transactions]);
      dropLocalRows(r => gone.has(r.id) && !isOwnedByMe(r));
    }
    await this.refresh();
    return { ok: true };
  },

  /** Change what somebody may do with a row you own. */
  async setPermission(grantId: string, permission: SharePermission): Promise<void> {
    await sharesApi.setPermission(grantId, permission);
    await this.refresh();
  },

  /** What a recipient stops seeing if this grant ends — for the confirmation. */
  cascade(grantId: string) {
    const grant = sharingContext().shares.find(g => g.id === grantId);
    if (!grant) return { transactions: [], deletes: [] };
    return cascadeOfEnding(grant, useStore.getState().transactions);
  },
};

const isOwnedByMe = (row: Shareable): boolean => {
  const me = useStore.getState().user?.id ?? null;
  return !row.user_id || row.user_id === me;
};

/** What a shared row is called, resolved from whatever this device can see. A
 *  recipient who cannot see the row yet gets null, and the caller falls back to
 *  the label the API stored when the code was minted. */
function labelOfRecord(kind: ShareRecordType, id: string): string | null {
  const row = findShareable(kind, id) as Record<string, unknown> | undefined;
  if (!row) return null;
  return (row.name as string) || (row.merchant as string) || (row.category as string) || null;
}

// ─── NET WORTH ──────────────────────────────────────────────────────────────

/**
 * Net worth, in one of the two scopes.
 *
 *   personal   (the default, and the only one a solo user ever sees) — the rows
 *              you OWN. For anybody not in a household that is every row in the
 *              store, so this returns exactly what it returned before Phase 7.1.
 *   household  the rows SHARED with the household, from every member, EACH
 *              COUNTED ONCE. Two people looking does not make two accounts:
 *              `householdRows` filters the single list every row already lives
 *              in, so there is no step at which a balance could be added twice.
 *
 * Both go through the same arithmetic (`netWorthFrom`) over a different slice —
 * one code path, so the household figure cannot drift from the personal one.
 *
 * Investments and super stay personal in this phase: only the entities Phase 7.1
 * made shareable (accounts, cards, transactions, loans, properties, budgets,
 * goals) can reach the household view, and the household view shows what is
 * shared and nothing else. A partner's portfolio stays private until there is a
 * deliberate decision to let it be otherwise.
 */
export function calculateNetWorth(scope: FinanceScope = currentScope()): NetWorthSnapshot {
  const s = useStore.getState();
  const ctx = householdContext();
  const currency = s.user?.currency_preference ?? 'AUD';
  const household = scope === 'household';

  const snapshot = netWorthFrom({
    accounts:    scopeRows(s.accounts, ctx, scope),
    creditCards: scopeRows(s.creditCards, ctx, scope),
    loans:       scopeRows(s.loans, ctx, scope),
    properties:  scopeRows(s.properties, ctx, scope),
    // Personal by construction — see above.
    investments: household ? [] : s.investments,
    superFunds:  household ? [] : s.superFunds,
  }, currency);

  // Record daily snapshot in history — the PERSONAL figure only. The household
  // view is a lens over the same rows, not a second net worth, and writing it
  // into the history would make the trend line jump every time somebody changed
  // which view they were looking at.
  if (!household) {
    const today = new Date().toISOString().split('T')[0];
    const hist = s.netWorthHistory;
    if (!hist.some(h => h.recorded_date === today)) {
      s.setNetWorthHistory([...hist, { recorded_date: today, total_value: snapshot.net_worth }]);
    }
  }

  return snapshot;
}

/** The lists net worth is computed from — whichever scope selected them. */
interface NetWorthSlice {
  accounts: BankAccount[];
  creditCards: CreditCard[];
  loans: Loan[];
  properties: Property[];
  investments: Investment[];
  superFunds: SuperFund[];
}

/**
 * The arithmetic itself. Unchanged from what it always was, now taking its lists
 * as an argument instead of reading the store — so the personal total, the
 * household total and each member's contribution are all literally the same sum.
 */
function netWorthFrom(slice: NetWorthSlice, currency: string): NetWorthSnapshot {
  // Hidden accounts are excluded from net worth (mirrors the super/loan opt-out).
  const bank_balance   = slice.accounts.filter(a => !a.hidden).reduce((sum, a) => sum + (a.display_balance ?? a.balance), 0);
  const investments    = slice.investments.reduce((sum, i) => sum + (i.display_value ?? i.current_value * (i.conversion_rate ?? 1)), 0);
  const credit_card_debt = slice.creditCards.reduce((sum, c) => sum + (c.display_balance_owing ?? c.balance_owing), 0);
  // Display total: every super fund, regardless of the net-worth toggle. The
  // Superannuation card (and Telegram briefing) should always reflect the full
  // super balance — the toggle only governs whether it feeds the net-worth sum.
  const superBalAll    = slice.superFunds.reduce((sum, f) => sum + f.balance, 0);
  // Counted total: only funds opted into net worth. Legacy funds saved before
  // this flag existed have it null/undefined — treat those as included.
  const superBalCounted = slice.superFunds
    .filter(f => f.include_in_net_worth !== false)
    .reduce((sum, f) => sum + f.balance, 0);

  // Loans count as debt when opted in. Legacy rows without the flag (undefined)
  // are treated as included to match super's opt-out behaviour.
  const loanDebt = slice.loans
    .filter(l => l.include_in_net_worth !== false)
    .reduce((sum, l) => sum + (l.current_balance || 0), 0);

  // Properties add the OWNED SHARE of their value. A linked mortgage is one of
  // the loans already subtracted above, so netting it here as well would count
  // the same debt twice — the property's true effect on net worth (value share
  // minus its mortgage) falls out of the two terms together.
  //
  // The loans are passed in for the one case where that doesn't hold: a mortgage
  // opted OUT of net worth is skipped by `loanDebt`, so the property subtracts it
  // itself rather than presenting a mortgaged house as owned outright. Exactly one
  // of the two terms nets any given balance, which is why this can't double-count.
  //
  // A property held in an SMSF whose balance already lists it adds NOTHING here:
  // the fund's balance is carrying the value, so counting it again would inflate
  // net worth by the whole property. propertyNetWorthTotal applies both rules.
  //
  // Phase 7.1 note: the loans handed in are in the SAME scope as the properties,
  // so a shared house is netted against a shared mortgage and a private one
  // against a private mortgage. Mixing the scopes would be the one way to make a
  // debt count twice — or not at all.
  const propertyValue = propertyNetWorthTotal(slice.properties, slice.loans);

  const net_worth = bank_balance + investments + superBalCounted + propertyValue - credit_card_debt - loanDebt;

  return {
    net_worth:        parseFloat(net_worth.toFixed(2)),
    bank_balance:     parseFloat(bank_balance.toFixed(2)),
    investments:      parseFloat(investments.toFixed(2)),
    credit_card_debt: parseFloat(credit_card_debt.toFixed(2)),
    super:            parseFloat(superBalAll.toFixed(2)),
    property:         parseFloat(propertyValue.toFixed(2)),
    // Reported alongside the assets so the breakdown ADDS UP to the headline.
    // Without it the screen showed a property at its full value and no debt line
    // anywhere, which reads as the house sitting on top of the mortgage.
    loans:            parseFloat(loanDebt.toFixed(2)),
    currency,
  };
}

/**
 * What each member brings to the household total.
 *
 * The proof that the household figure is not a double count: every shared row
 * has exactly one owner, so slicing the household by owner PARTITIONS it — the
 * members' net worths add up to the household's, with nothing counted twice and
 * nothing left out. `reconciliation` reports the difference so the screen (and
 * the tests) can show it is zero rather than take it on trust.
 */
export interface HouseholdMemberNetWorth {
  userId: string;
  name: string | null;
  email: string | null;
  role: string | null;
  isYou: boolean;
  netWorth: NetWorthSnapshot;
}

export interface HouseholdNetWorthReport {
  householdId: string;
  householdName: string;
  /** The household total — every shared row, counted once. */
  total: NetWorthSnapshot;
  /** That same total, split by who owns each row. */
  members: HouseholdMemberNetWorth[];
  /** total.net_worth − Σ members. Zero, always. */
  reconciliation: number;
}

export const householdReportDS = {
  build(householdId?: string | null): HouseholdNetWorthReport | null {
    const s = useStore.getState();
    const ctx = householdContext();
    const id = householdId ?? resolveActiveHouseholdId(ctx);
    if (!id) return null;
    // Membership, not the cached household row, is what grants this. A household
    // can sit in the local cache after the user is removed from it (or be named
    // outright by a caller passing an id), and the member list below carries
    // every member's name, email and role — so answering for a non-member would
    // leak who a household's people are, even with every figure at zero.
    if (!householdRoleIn(ctx, id)) return null;
    const household = s.households.find(h => h.id === id);
    if (!household) return null;

    const currency = s.user?.currency_preference ?? 'AUD';
    const sliceFor = (pick: <T extends Shareable>(list: T[]) => T[]): NetWorthSlice => ({
      accounts: pick(s.accounts), creditCards: pick(s.creditCards),
      loans: pick(s.loans), properties: pick(s.properties),
      investments: [], superFunds: [],
    });

    const total = netWorthFrom(
      sliceFor(<T extends Shareable>(list: T[]) => householdRows(list, ctx, id)),
      currency,
    );

    const members = activeMembers(s.householdMembers, id).map(m => ({
      userId: m.user_id,
      name: m.name ?? null,
      email: m.email ?? null,
      role: m.role as string,
      isYou: m.user_id === s.user?.id,
      netWorth: netWorthFrom(
        sliceFor(<T extends Shareable>(list: T[]) => memberRows(list, ctx, m.user_id, id)),
        currency,
      ),
    }));

    const summed = members.reduce((t, m) => t + m.netWorth.net_worth, 0);
    return {
      householdId: id,
      householdName: household.name,
      total,
      members,
      reconciliation: parseFloat((total.net_worth - summed).toFixed(2)),
    };
  },
};

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
  s.setPortfolioTotal(scoped(next).reduce((sum, i) => sum + (i.display_value ?? i.current_value * (i.conversion_rate ?? 1)), 0));
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
  const server = srv as Goal;
  s.setGoals(s.goals.map(g => g.id === pl.recordId ? server : g));
  // Postgres mints the real id. Map local→server so a queued update/delete —
  // and any contribution still carrying the temp id in `goal_id` — resolves to
  // the row the server actually has.
  if (pl.recordId && server.id && pl.recordId !== server.id) {
    s.addIdMapping(pl.recordId as string, server.id);
    s.setGoalContributions(s.goalContributions.map(c =>
      c.goal_id === pl.recordId ? { ...c, goal_id: server.id } : c));
  }
});

registerSyncSuccess('goalContribution.create', (srv, pl) => {
  const s = useStore.getState();
  const server = srv as GoalContribution;
  s.setGoalContributions(s.goalContributions.map(c => c.id === pl.recordId ? server : c));
  if (pl.recordId && server.id && pl.recordId !== server.id) {
    s.addIdMapping(pl.recordId as string, server.id);
  }
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
  // A property linked to this loan while it was still local holds the temp id.
  // Re-point it at the real row, or the mortgage would vanish from that
  // property's equity the moment the loan's id changed underneath it.
  if (pl.recordId && server.id && pl.recordId !== server.id) {
    s.setProperties(s.properties.map(p =>
      p.loan_id === pl.recordId ? { ...p, loan_id: server.id } : p));
    // Movements recorded against the loan while it was local carry the temp id
    // too — without this the history would be orphaned from the loan it belongs to.
    s.setLoanEvents(s.loanEvents.map(e =>
      e.loan_id === pl.recordId ? { ...e, loan_id: server.id } : e));
  }
  // The server may have just mirrored a repayment bill — pull it in now.
  refreshLoanBills();
});

registerSyncSuccess('loan.update', (srv, pl) => {
  const s = useStore.getState();
  const server = srv as Loan;
  s.setLoans(s.loans.map(l => l.id === resolveAccountId(pl.id as string) || l.id === pl.id
    // Keep the household stamps if the server response predates them (an older
    // backend still deployed) — swapping in a bare row would read as "editing
    // un-shared it" until the next full load.
    ? { ...server, household_ids: server.household_ids ?? l.household_ids }
    : l));
  // An update can add, change, or REMOVE the mirrored repayment bill (e.g. amount/
  // due-date change, or add_to_bills toggled off) — reconcile loan-linked bills.
  refreshLoanBills();
});

registerSyncSuccess('loanEvent.create', (srv, pl) => {
  const s = useStore.getState();
  const server = srv as LoanEvent;
  s.setLoanEvents(s.loanEvents.map(e => e.id === pl.recordId ? server : e));
  if (pl.recordId && server.id && pl.recordId !== server.id) {
    s.addIdMapping(pl.recordId as string, server.id);
  }
});

registerSyncSuccess('property.create', (srv, pl) => {
  const s = useStore.getState();
  const server = srv as Property;
  if (pl.recordId && server.id && pl.recordId !== server.id) {
    s.addIdMapping(pl.recordId as string, server.id);
  }
  s.setProperties(s.properties.map(p => p.id === pl.recordId ? server : p));
});

// Phase 8.2 — the policy's server id replaces the local one, and the temp→server
// mapping is recorded so a queued edit (or a premium record created in the same
// breath, which carries the temp id in policy_id) resolves to a row the server
// actually has.
registerSyncSuccess('insurance.create', (srv, pl) => {
  const s = useStore.getState();
  const server = srv as InsurancePolicy;
  if (pl.recordId && server.id && pl.recordId !== server.id) {
    s.addIdMapping(pl.recordId as string, server.id);
    // The local history rows point at the local policy id; re-point them so the
    // page and the premium-change insight keep seeing this policy's own prices
    // before the next full load.
    s.setInsurancePremiumHistory(s.insurancePremiumHistory.map(r =>
      r.policy_id === pl.recordId ? { ...r, policy_id: server.id } : r));
  }
  s.setInsurancePolicies(s.insurancePolicies.map(p => p.id === pl.recordId ? server : p));
});

registerSyncSuccess('insurancePremium.create', (srv, pl) => {
  const s = useStore.getState();
  const server = srv as InsurancePremiumRecord;
  s.setInsurancePremiumHistory(
    s.insurancePremiumHistory.map(r => r.id === pl.recordId ? server : r));
  if (pl.recordId && server.id && pl.recordId !== server.id) {
    s.addIdMapping(pl.recordId as string, server.id);
  }
});

registerSyncSuccess('budget.create', (srv, pl) => {
  const s = useStore.getState();
  const server = srv as Budget;
  s.setBudgets(s.budgets.map(b => b.id === pl.recordId ? server : b));
  // Postgres mints the real id; map local→server so a queued update/delete for
  // the budget resolves to an id the server actually has.
  if (pl.recordId && server.id && pl.recordId !== server.id) {
    s.addIdMapping(pl.recordId as string, server.id);
  }
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
      investments: [], investmentSales: [], superFunds: [], portfolioTotal: 0, incomeEntries: [],
      projectedAnnual: 0, bills: [], goals: [], goalContributions: [], loans: [],
      loanEvents: [],
      properties: [],
      insurancePolicies: [], insurancePremiumHistory: [],
      budgets: [], notifications: [], alertStates: [],
      budgetSettings: null, budgetLines: [], customCategories: [],
      merchants: [], merchantAliases: [], transactionRules: [],
      recurringSeries: [], transactionSplits: [], billSubExclusions: [],
      creditCardStatements: [], ccPaymentPrompts: [],
      netWorth: null, netWorthHistory: [], pendingPayments: [], idMap: {},
      basiqUserId: null, pendingSyncQueue: [], syncToast: null,
      categoryAliases: {},
      // Phase 7.1 — the previous user's household went with their data. Leaving
      // it behind would let the new user's session resolve a membership that was
      // never theirs, and the shared rows cached under it would stay visible.
      households: [], householdMembers: [], householdInvitations: [],
      financeScope: 'personal', activeHouseholdId: null,
      // Phase 7.2 — and so did every direct grant. A grant naming the previous
      // user is exactly the thing that would keep a stranger's bank account on
      // screen for whoever signs in next.
      recordShares: [], shareCodes: [],
    });
    // The cached ui_preferences blob belongs to the previous user too.
    resetUiPrefsCache();
    // …and so do the cached SMSF names a property could be held in.
    propertyFundsDS.reset();
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
    investmentSalesResult,
    superResult,
    incomeResult,
    billsResult,
    goalsResult,
    goalContributionsResult,
    loansResult,
    loanEventsResult,
    propertiesResult,
    insuranceResult,
    budgetsResult,
    budgetSettingsResult,
    budgetLinesResult,
    customCategoriesResult,
    merchantsResult,
    merchantAliasesResult,
    transactionRulesResult,
    recurringSeriesResult,
    transactionSplitsResult,
    billSubExclusionsResult,
    alertStatesResult,
    householdsResult,
    sharesResult,
  ] = await Promise.allSettled([
    accountsApi.getAccounts(),
    accountsApi.getCreditCards(),
    accountsApi.getSubscriptions(),
    fetchTransactionsSince(isoMonthsAgo(RECENT_MONTHS)),
    investmentsApi.getInvestments(),
    investmentsApi.getSales(),
    investmentsApi.getSuper(),
    incomeApi.getIncome(),
    overviewApi.getBills(),
    overviewApi.getGoals(),
    overviewApi.getGoalContributions(),
    overviewApi.getLoans(),
    overviewApi.getLoanEvents(),
    overviewApi.getProperties(),
    // Phase 8.2 — policies and their premium history together: a history without
    // its policy prices nothing, and a policy without its history cannot say
    // what changed. Fails soft (see below) like every other slice.
    insuranceApi.getAll(),
    overviewApi.getBudgets(),
    overviewApi.getBudgetSettings(),
    overviewApi.getBudgetLines(),
    overviewApi.getCustomCategories(),
    overviewApi.getMerchants(),
    overviewApi.getMerchantAliases(),
    overviewApi.getTransactionRules(),
    overviewApi.getRecurringSeries(),
    overviewApi.getTransactionSplits(),
    overviewApi.getBillSubExclusions(),
    overviewApi.getAlertStates(),
    // Phase 7.1 — who the user shares with. Fetched in the same breath as the
    // money so the first render already knows which rows are whose; a failure
    // here is not fatal (see below), because a user in no household — nearly
    // everybody — is unaffected by it either way.
    householdsApi.getAll(),
    // Phase 7.2 — direct grants, in the same breath and for the same reason:
    // the first render has to know which rows are somebody else's before it
    // draws them, or a shared account flashes up looking like the user's own.
    sharesApi.getAll(),
  ]);

  // Households first: every merge below is judged against them, and a shared row
  // arriving before its household is known would briefly look like a stranger's.
  if (householdsResult.status === 'fulfilled') {
    const data = householdsResult.value as {
      households?: Household[]; members?: HouseholdMember[]; invitations?: HouseholdInvitation[];
    };
    s.setHouseholds(data.households ?? []);
    s.setHouseholdMembers(data.members ?? []);
    s.setHouseholdInvitations(data.invitations ?? []);
    // A household the user is no longer in must not stay selected, and the
    // household view must not be the one they land on with nothing in it.
    const resolved = resolveActiveHouseholdId(householdContext());
    if (s.activeHouseholdId !== resolved) s.setActiveHouseholdId(resolved);
    if (!resolved && s.financeScope === 'household') s.setFinanceScope('personal');
  }

  // Grants next, before any row is merged: a row arriving before the grant that
  // explains it would briefly be a stranger's account with no badge on it.
  if (sharesResult.status === 'fulfilled') {
    const data = sharesResult.value as { shares?: RecordShare[]; codes?: ShareCode[] };
    s.setRecordShares(data.shares ?? []);
    s.setShareCodes(data.codes ?? []);
  }

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
    // Collapse identical accounts (same bsb+number, or same name+institution) —
    // but only among the user's OWN rows; a household/shared account owned by
    // someone else is a different account even when it looks the same.
    const deduped = dedupeByContent(merged, s.user?.id ?? null, (a) => {
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
    const dedupedCards = dedupeByContent(mergedCards, s.user?.id ?? null, (c) =>
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
    // Scoped: the server list now carries holdings shared WITH this user, and
    // somebody else's money must never enter this total.
    s.setPortfolioTotal(scoped(merged).reduce((sum, i) => sum + i.current_value * (i.conversion_rate ?? 1), 0));
    s.setInvestmentsNextUpdate(next_update ?? null);
  } else {
    console.warn('[bootstrapData] investments failed:', investmentsResult.reason);
  }

  if (investmentSalesResult.status === 'fulfilled') {
    // The server returns EVERY disposal, not a window, so it is authoritative —
    // but a sale recorded offline and still queued has to survive the merge, or
    // it disappears from the capital-gains working the moment the app reloads.
    const { sales } = (investmentSalesResult.value ?? {}) as { sales?: InvestmentSale[] };
    s.setInvestmentSales(mergeServerAuthoritative(sales ?? [], s.investmentSales, 'sale.create'));
  } else {
    console.warn('[bootstrapData] investment sales failed:', investmentSalesResult.reason);
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

  if (goalContributionsResult.status === 'fulfilled') {
    s.setGoalContributions(mergeServerAuthoritative(
      (goalContributionsResult.value as GoalContribution[]) ?? [],
      s.goalContributions,
      'goalContribution.create',
    ));
  } else {
    // The endpoint 404s until the Phase 4.3 migration is applied. Keeping the
    // locally recorded ledger is the right failure mode — losing a user's
    // contributions because a table is missing would be far worse than a
    // device-local history that syncs once the migration lands.
    console.warn('[bootstrapData] goal contributions failed:', goalContributionsResult.reason);
  }

  if (loansResult.status === 'fulfilled') {
    s.setLoans(mergeServerAuthoritative((loansResult.value as Loan[]) ?? [], s.loans, 'loan.create'));
  } else {
    console.warn('[bootstrapData] loans failed:', loansResult.reason);
  }

  if (loanEventsResult.status === 'fulfilled') {
    s.setLoanEvents(mergeServerAuthoritative(
      (loanEventsResult.value as LoanEvent[]) ?? [],
      s.loanEvents,
      'loanEvent.create',
    ));
  } else {
    // The endpoint 404s until the Phase 4.2 migration + route are deployed. Keep
    // the locally recorded history rather than losing a user's repayments to a
    // missing table; it syncs once the backend is live.
    console.warn('[bootstrapData] loan events failed:', loanEventsResult.reason);
  }

  if (propertiesResult.status === 'fulfilled') {
    s.setProperties(mergeServerAuthoritative((propertiesResult.value as Property[]) ?? [], s.properties, 'property.create'));
  } else {
    // The endpoint 404s until the Phase 4.1 migration + route are deployed. Keep
    // whatever was entered locally rather than dropping a house from the app
    // because a table is missing; it syncs once the backend is live.
    console.warn('[bootstrapData] properties failed:', propertiesResult.reason);
  }

  if (insuranceResult.status === 'fulfilled') {
    const value = insuranceResult.value as {
      policies?: InsurancePolicy[]; history?: InsurancePremiumRecord[];
    };
    s.setInsurancePolicies(mergeServerAuthoritative(
      value.policies ?? [], s.insurancePolicies, 'insurance.create'));
    s.setInsurancePremiumHistory(mergeServerAuthoritative(
      value.history ?? [], s.insurancePremiumHistory, 'insurancePremium.create'));
  } else {
    // The endpoint 404s until the Phase 8.2 migration + route are deployed. Keep
    // whatever was entered locally rather than dropping somebody's cover from
    // the app because a table is missing; it syncs once the backend is live.
    console.warn('[bootstrapData] insurance failed:', insuranceResult.reason);
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

  // "Different bills" reconciliation decisions (cross-device). Server rows are
  // authoritative; keep any local-only (offline, not-yet-synced) decisions by
  // decision_key so an offline mark isn't lost on the next load. May 404 until the
  // migration + route deploy — Promise.allSettled makes that a graceful skip (the
  // localStorage cache still suppresses locally until then).
  if (billSubExclusionsResult.status === 'fulfilled') {
    const server = (billSubExclusionsResult.value as BillSubscriptionExclusion[]) ?? [];
    const serverKeys = new Set(server.map(e => e.decision_key));
    const localOnly = s.billSubExclusions.filter(e => !serverKeys.has(e.decision_key));
    s.setBillSubExclusions([...server, ...localOnly]);
  } else {
    console.warn('[bootstrapData] bill↔subscription exclusions failed:', billSubExclusionsResult.reason);
  }

  // Phase 4.4 alert dismiss/read state. Merged by alert_key, not by id: the row
  // is written by upsert, so the server's id for a key can legitimately differ
  // from the one this device minted offline, and matching on id would leave two
  // records for one alert. The server's copy wins; a key only this device knows
  // about (dismissed offline, still queued) is kept.
  if (alertStatesResult.status === 'fulfilled') {
    const server = (alertStatesResult.value as AlertState[]) ?? [];
    const serverKeys = new Set(server.map(a => a.alert_key));
    const localOnly = s.alertStates.filter(a => !serverKeys.has(a.alert_key));
    s.setAlertStates([...server, ...localOnly]);
  } else {
    // The endpoint may not be deployed yet — a graceful skip, keeping whatever
    // this device already knows rather than resurfacing dismissed alerts.
    console.warn('[bootstrapData] alert states failed:', alertStatesResult.reason);
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

  // Make the category taxonomy agree with itself: collapse duplicate rows, give
  // every budget category a real category row, and settle spelling variants onto
  // one name. Idempotent — once reconciled it does nothing.
  const catFix = customCategoriesDS.reconcile();
  if (catFix.merged || catFix.repointed || catFix.registered) {
    console.info('[bootstrapData] categories reconciled:', catFix);
  }
  // Cross-device category decisions ("grocuries means Groceries") live in the
  // shared ui_preferences blob, same as the chosen-category allowlist.
  loadUiPrefs().then(prefs => {
    const stored = prefs.category_aliases;
    if (stored && typeof stored === 'object') {
      const local = useStore.getState().categoryAliases;
      // Local wins on conflict: it is the decision made most recently on the
      // device the user is actually looking at.
      useStore.getState().setCategoryAliases({ ...(stored as Record<string, string>), ...local });
    }
  });

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

/** The current calendar month (`YYYY-MM`) in the user's display timezone. */
function currentBudgetMonth(): string {
  return todayInDisplayTz().slice(0, 7);
}

// ─── BUDGET REPORTING (Phase 4.1) ────────────────────────────────────────────
//
// Gathers what the pure engine needs — the user's budgets, their transactions,
// the canonical transfer-exclusion set, the split map and the adaptive spend
// rates — and hands them to utils/budgeting.ts. No budgeting maths lives here.

export const budgetReportDS = {
  /**
   * Typical MONTHLY spend per category, learned from transaction history by the
   * SAME adaptive learner the forecast uses (outliers stripped, sparse and
   * short-history categories skipped). This is what turns "projected month-end
   * spend" from a naive day-one run rate into an estimate that knows what a
   * normal month looks like.
   *
   * `monthlyObserved` is deliberately used rather than `monthlyResidual`: a
   * budget caps ALL spending in a category, bills included, so nothing is
   * subtracted for known obligations here.
   */
  adaptiveRates(asOf: string): { byCategory: Record<string, number>; overall: number } {
    const all = transactionsDS.getAll();
    const excludeIds = computeTransferExclusionIds(all, detectInternalTransferIds);

    const history: HistoryTxn[] = all.map(t => ({
      date: (t.date || '').slice(0, 10),
      amount: effectiveAmount(t),
      category: t.category || 'Uncategorised',
      accountId: t.account_id ?? null,
      merchantKey: t.merchant_normalized || normaliseMerchant(t.merchant || ''),
      merchantName: t.merchant || undefined,
      isSpend: isSpendTransaction(t, { excludeIds }),
      isTransfer: isTransferTransaction(t, { excludeIds }),
      isRefund: isRefundTransaction(t),
      committed: false, // budgets track every dollar, committed or not
    }));

    // knownInputs is empty on purpose — see the note above about monthlyObserved.
    const learned = learnFromHistory({ asOf, history, knownInputs: [] });
    const byCategory: Record<string, number> = {};
    let overall = 0;
    for (const c of learned.categories) {
      byCategory[c.category] = c.monthlyObserved;
      overall += c.monthlyObserved;
    }
    return { byCategory, overall };
  },

  /**
   * The earliest month the report can speak about honestly — bootstrap loads
   * only the last RECENT_MONTHS of transactions, so any month before this one
   * would report zero spend rather than "unknown". The UI uses it to bound how
   * far back a user can page through history.
   */
  coverageMonth(): string {
    return monthKeyOf(isoMonthsAgo(RECENT_MONTHS)) ?? currentBudgetMonth();
  },

  /** The current calendar month (`YYYY-MM`) in the user's display timezone. */
  currentMonth(): string {
    return currentBudgetMonth();
  },

  /**
   * The full budget report for a month: spent, remaining, % used and projected
   * month-end spend per category budget and for the overall budget, with
   * rollover applied. `month`/`asOf` are overridable (history, tests); both
   * default to now in the user's display timezone.
   */
  build(opts?: {
    month?: string;
    asOf?: string;
    adaptive?: boolean;
    includeUnbudgeted?: boolean;
  }): BudgetReport {
    const asOf = opts?.asOf ?? todayInDisplayTz();
    const transactions = transactionsDS.getAll();
    const rates = (opts?.adaptive ?? true) ? this.adaptiveRates(asOf) : null;

    return buildBudgetReport({
      // Omitted → the engine reports the month `asOf` falls in, so overriding
      // asOf alone (history, tests) can never report a different month's spend
      // against today's elapsed days.
      month: opts?.month,
      asOf,
      budgets: budgetsDS.getAll(),
      transactions,
      userId: useStore.getState().user?.id ?? null,
      spendOptions: {
        // The SAME exclusion set and split map every other spend surface uses,
        // so a budget can never disagree with the Accounts page.
        excludeIds: computeTransferExclusionIds(transactions, detectInternalTransferIds),
        splitsByTxId: transactionSplitsDS.byTransactionId(),
      },
      projection: rates
        ? { monthlyRateByCategory: rates.byCategory, overallMonthlyRate: rates.overall }
        : undefined,
      // Bootstrap loads only the last RECENT_MONTHS of transactions. Months
      // older than that look empty, and an empty month would hand a rollover
      // budget a full month's phantom surplus — so carry never reaches back
      // past what we can actually see.
      coverageFromMonth: monthKeyOf(isoMonthsAgo(RECENT_MONTHS)),
      includeUnbudgeted: opts?.includeUnbudgeted ?? false,
    });
  },
};

export const forecastDS = {
  /** Build the 30/60/90-day cash-flow forecast from current data. `asOf` and
   *  `horizons` are overridable (tests / what-if); both default sensibly.
   *  `adaptive` (default true) blends in income + discretionary spend learned
   *  from transaction history — see utils/adaptiveForecast.ts. */
  build(opts?: { asOf?: string; horizons?: number[]; adaptive?: boolean }): CashFlowForecast {
    const asOf = opts?.asOf ?? todayInDisplayTz();
    const adaptive = opts?.adaptive ?? true;

    // Hidden accounts are excluded from the forecast entirely — not in the
    // account list, and none of their transactions/subscriptions/series feed it.
    const allBanks = accountsDS.getAll();
    const banks = allBanks.filter(a => !a.hidden);
    const hiddenBanks = allBanks.filter(a => a.hidden);
    const accounts: AccountBalanceInput[] = banks.map(a => ({
      accountId: a.id,
      name: a.name,
      balance: a.display_balance ?? a.balance,
    }));
    // Resolve a record's account reference to a VISIBLE bank account's id (via the
    // canonical id-equivalence check, so localId/serverId variants match), else
    // null (→ the engine's unallocated bucket). The engine tolerates unknown ids.
    const routeAccount = (raw?: string | null): string | null => {
      if (!raw) return null;
      const hit = banks.find(a => accountIdMatches(raw, a));
      return hit ? hit.id : null;
    };
    // True when a reference points at a HIDDEN bank account — such records are
    // dropped from the forecast rather than routed to the unallocated bucket.
    const isHiddenAccount = (raw?: string | null): boolean =>
      !!raw && hiddenBanks.some(a => accountIdMatches(raw, a));

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
        category: e.category,
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
        category: b.category,
        skipAnchor: b.is_paid, // current cycle already settled
        // Due date already passed and still unpaid — the engine carries the
        // missed payment forward instead of dropping it out of the forecast.
        overdue: !b.is_paid && !!b.due_date && b.due_date <= asOf,
        // Signals a credit-card payment so the engine can de-dup it against the
        // card's own minimum-payment projection (bills carry no card link).
        creditCardPayment: b.category === 'Credit Card',
      });
    }

    // Subscriptions — user-managed recurring charges, allocated to their account.
    for (const sub of subscriptionsDS.getAll()) {
      const amount = Math.abs(sub.display_amount ?? sub.amount);
      if (!amount) continue;
      if (isHiddenAccount(sub.account_id)) continue; // charged from a hidden account
      inputs.push({
        id: `sub:${sub.id}`,
        sourceType: 'subscription',
        name: sub.name,
        amount: -amount,
        frequency: toForecastFrequency(sub.frequency) ?? 'monthly',
        anchorDate: sub.next_charge_date,
        accountId: routeAccount(sub.account_id),
        confidence: sub.is_auto_detected ? 0.85 : 1,
        category: sub.category,
      });
    }

    // Recurring series — detected commitments. Kept sign (income +, expense −).
    // A transfer-like series is flagged so the engine nets it out. Series that
    // duplicate a subscription/income/loan are de-duped away in the engine.
    for (const s of recurringSeriesDS.active()) {
      if (s.expected_amount == null || !s.next_expected_date) continue;
      if (isHiddenAccount(s.account_id)) continue; // runs on a hidden account
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

    // ── Phase 3.3: adaptive layer ────────────────────────────────────────────
    // Learn recurring income + typical discretionary spend from transaction
    // history and blend them in as extra inputs. All learning is in the pure
    // learner; here we only normalise stored transactions into its minimal
    // HistoryTxn shape, reusing the CANONICAL transactionCore classifiers so
    // "what is spend / transfer / refund" is decided in exactly one place.
    if (adaptive) {
      const allTxns = transactionsDS.getAll();
      // Shared exclusion set (persisted + detected transfers, card repayments)
      // so transfers are recognised identically to every other spend surface.
      const excludeIds = computeTransferExclusionIds(allTxns, detectInternalTransferIds);
      // Ids of recurring series already projected above — their occurrences are
      // known obligations, so exclude tagged transactions from discretionary
      // learning to avoid double-counting.
      const forecastSeriesIds = new Set(recurringSeriesDS.active().map(s => s.id));

      const history: HistoryTxn[] = allTxns
        .filter(t => t.account_type === 'bank')      // cash accounts only (engine scope)
        .filter(t => !isHiddenAccount(t.account_id)) // never learn from hidden accounts
        .map(t => ({
          date: (t.date || '').slice(0, 10),
          amount: effectiveAmount(t),
          category: t.category || 'Uncategorised',
          accountId: routeAccount(t.account_id),
          merchantKey: t.merchant_normalized || normaliseMerchant(t.merchant || ''),
          merchantName: t.merchant || undefined,
          isSpend: isSpendTransaction(t, { excludeIds }),
          isTransfer: isTransferTransaction(t, { excludeIds }),
          isRefund: isRefundTransaction(t),
          committed: !!(t.recurring_series_id && forecastSeriesIds.has(t.recurring_series_id)),
        }));

      const learned = learnFromHistory({ asOf, history, knownInputs: inputs });
      inputs.push(...learned.learnedInputs);
    }

    return buildCashFlowForecast({ asOf, accounts, inputs, horizons: opts?.horizons });
  },
};

// ─── SAVINGS GOALS — the Phase 4.3 report gatherer ───────────────────────────

/** The window the spare-cash figure is measured over. Long enough to average
 *  out one-off months, short enough that the forecast is still credible. */
export const GOAL_CAPACITY_DAYS = 90;

export const goalReportDS = {
  /**
   * Live values for everything a goal can be linked to.
   *
   * Hidden bank accounts are INCLUDED, unlike in the forecast: hiding an
   * account is a decision about the dashboard, and silently zeroing a goal the
   * user deliberately linked to it would be a different, much larger decision.
   */
  balances(): SourceValue[] {
    const out: SourceValue[] = [];
    for (const a of accountsDS.getAll()) {
      out.push({ type: 'account', id: a.id, value: a.display_balance ?? a.balance ?? 0 });
    }
    for (const i of investmentsDS.getAll().investments) {
      out.push({ type: 'investment', id: i.id, value: i.display_value ?? i.current_value ?? 0 });
    }
    for (const f of superDS.getAll()) {
      out.push({ type: 'super', id: f.id, value: f.balance ?? 0 });
    }
    return out;
  },

  /**
   * Spare cash the forecast expects over the next 90 days.
   *
   * This is the forecast's NET change, not its balance: the balances are
   * already counted as money saved by any goal linked to them, so funding goals
   * out of the projected closing balance would count the same dollars twice.
   * Only cash the user does not yet have can pay for what they have not yet
   * saved.
   */
  capacity(asOf: string): GoalCapacity | null {
    try {
      const forecast = forecastDS.build({ asOf, horizons: [GOAL_CAPACITY_DAYS] });
      const horizon = forecast.horizons[forecast.horizons.length - 1];
      return horizon ? { surplus: horizon.net, days: horizon.days } : null;
    } catch (err) {
      // A forecast that cannot be built is not a reason to hide the goals; the
      // report simply reports affordability as unknown.
      console.warn('[goals] forecast capacity unavailable:', err);
      return null;
    }
  },

  /**
   * The full goals report. `capacity: false` skips building the cash-flow
   * forecast — the expensive part — for callers that only need the progress
   * figures.
   */
  build(opts?: { asOf?: string; capacity?: boolean | GoalCapacity }): GoalReport {
    const asOf = opts?.asOf ?? todayInDisplayTz();

    // `getAll()` is already scoped: personal = the user's own goals, a
    // household view = the goals shared to it FROM EVERY MEMBER. The owner
    // filter that used to sit here silently dropped everyone else's shared
    // goals from the household picture — the one thing sharing exists to show.
    const goals: GoalInput[] = goalsDS.getAll().map(toGoalInput);
    const contributions: ContributionInput[] = goalContributionsDS.getAll().map(toContributionInput);

    return buildGoalReport({
      asOf,
      goals,
      contributions,
      balances: this.balances(),
      // `true` (the default) builds the forecast here; `false` skips affordability
      // entirely; an object is a forecast the CALLER has already built — passing
      // it in is how alertsDS avoids building the same 90-day forecast twice.
      capacity: typeof opts?.capacity === 'object' && opts.capacity !== null
        ? opts.capacity
        : (opts?.capacity ?? true) ? this.capacity(asOf) : null,
    });
  },
};

// ─── ALERT STATE — the user's response to a derived alert or insight ─────────
//
// Phase 6.1 note: insights (utils/insights.ts) are dismissed and read exactly
// the way alerts are, so they store their state in the SAME table rather than in
// a second one that would have had the same three columns. Insight keys are
// namespaced under `insight:` and the two sides read only their own namespace
// (see `inputs` below) — otherwise each would report the other's rows as
// resolved and prune every dismissal the user has ever made.
//
// Alerts themselves are never stored. They are re-derived from the budget, goal
// and forecast engines every time `alertsDS.build()` runs, so the list can never
// drift from the numbers it describes and repeated builds cannot accumulate
// duplicates. What IS stored is the decision the engines cannot re-derive —
// dismissed, and read — keyed by the alert's own key so it follows the user from
// one device to the next.
//
// The write is an UPSERT on (user_id, alert_key). There is no create/update
// split because the client knows the key before it knows whether a row exists,
// and two devices acting on one alert must converge on one row.

export const alertStatesDS = {
  /** Every stored state belonging to the signed-in user. */
  getAll(): AlertState[] {
    const s = useStore.getState();
    const userId = s.user?.id ?? null;
    return s.alertStates.filter(a => !userId || !a.user_id || a.user_id === userId);
  },

  /**
   * The shape the alerts (or insights) engine reads. Absent fields mean "never".
   *
   * Scoped to ONE namespace, because each engine reports every stored key it
   * does not recognise as resolved. Handing the alerts engine an insight's row
   * would have it declare that row dead, and the caller would dutifully delete a
   * dismissal about something the alerts engine has never heard of.
   */
  inputs(opts: { namespace?: 'alert' | 'insight' } = {}): AlertStateInput[] {
    const wantInsights = opts.namespace === 'insight';
    return this.getAll()
      .filter(a => isInsightKey(a.alert_key) === wantInsights)
      .map(a => ({
        key: a.alert_key,
        dismissedStage: a.dismissed_stage ?? null,
        readStage: a.read_stage ?? null,
      }));
  },

  /**
   * Record a decision about one alert, merging into whatever is already stored
   * for that key — dismissing must not erase the fact that it had been read, and
   * vice versa. Local-first: the store updates immediately and the upsert is
   * queued, so a dismissal survives being made offline.
   */
  save(alertKey: string, patch: { dismissedStage?: number; readStage?: number }): AlertState {
    const s = useStore.getState();
    const userId = s.user?.id ?? null;
    const existing = s.alertStates.find(
      a => a.alert_key === alertKey && (!userId || !a.user_id || a.user_id === userId),
    );

    const now = ts();
    const merged: AlertState = {
      ...(existing ?? { id: uuid(), user_id: uid(), alert_key: alertKey, created_at: now }),
      ...(patch.dismissedStage != null
        ? { dismissed_stage: patch.dismissedStage, dismissed_at: now }
        : {}),
      ...(patch.readStage != null ? { read_stage: patch.readStage, read_at: now } : {}),
      updated_at: now,
    };

    s.setAlertStates(
      existing
        ? s.alertStates.map(a => (a === existing ? merged : a))
        : [...s.alertStates, merged],
    );

    // The whole row goes up, not a diff: the endpoint is an upsert, and a partial
    // payload would blank the field this call is not touching.
    syncWithRetry('alertState.save', {
      data: {
        alert_key: merged.alert_key,
        dismissed_stage: merged.dismissed_stage ?? null,
        dismissed_at: merged.dismissed_at ?? null,
        read_stage: merged.read_stage ?? null,
        read_at: merged.read_at ?? null,
      },
    });

    return merged;
  },

  /**
   * Drop the state of alerts whose condition has resolved.
   *
   * Not tidiness — correctness. A dismissal is a statement about a SITUATION, so
   * once the situation has passed the dismissal has to go with it, or the next
   * time the same thing happens it arrives already silenced.
   */
  prune(keys: string[]): void {
    if (keys.length === 0) return;
    const doomed = new Set(keys);
    const s = useStore.getState();
    const mine = new Set(this.getAll().filter(a => doomed.has(a.alert_key)).map(a => a.alert_key));
    if (mine.size === 0) return;

    s.setAlertStates(s.alertStates.filter(a => !mine.has(a.alert_key)));
    for (const key of mine) syncWithRetry('alertState.delete', { key });
  },
};

// ─── PROACTIVE ALERTS — the Phase 4.4 report gatherer ────────────────────────

export const alertsDS = {
  /**
   * Has enough data loaded to trust an EMPTY result?
   *
   * Everything else here is safe on a cold store — no budgets means no budget
   * alerts, which is correct. Pruning is not: on the first render after a reload
   * the store can be momentarily empty, every alert is therefore "resolved", and
   * a blind prune would delete every dismissal the user has ever made. So the
   * caller only prunes once there is something here to have been alerted about.
   */
  ready(): boolean {
    const s = useStore.getState();
    return s.accounts.length > 0 || s.transactions.length > 0
      || s.budgets.length > 0 || s.goals.length > 0;
  },

  /**
   * Every alert that currently applies.
   *
   * Consumes the existing engines and adds no arithmetic of its own: the budget
   * report (including unbudgeted categories, so every spending category is
   * visible to the unusual-spend check), the goals report, the cash-flow
   * forecast, and the adaptive learner's per-category monthly average.
   *
   * The 90-day forecast is built ONCE and handed to the goals report as its
   * capacity, rather than letting `goalReportDS` build a second identical one.
   */
  build(opts?: { asOf?: string }): AlertReport {
    const asOf = opts?.asOf ?? todayInDisplayTz();

    const forecast = forecastDS.build({ asOf, horizons: [30, 60, GOAL_CAPACITY_DAYS] });
    const horizon = forecast.horizons[forecast.horizons.length - 1];
    const capacity: GoalCapacity | null = horizon
      ? { surplus: horizon.net, days: horizon.days }
      : null;

    return buildAlerts({
      asOf,
      budget: budgetReportDS.build({ asOf, includeUnbudgeted: true }),
      goals: goalReportDS.build({ asOf, capacity: capacity ?? false }),
      forecast,
      // The SAME learned averages the budget projection leans on, so "unusual"
      // and "projected" can never be measured against different normals.
      baselineByCategory: budgetReportDS.adaptiveRates(asOf).byCategory,
      // Phase 8.2 — renewals and lapsed cover. The engine reads the report's own
      // lines, so a warning can never disagree with the Insurance page.
      insurance: insuranceReportDS.build(asOf),
      states: alertStatesDS.inputs(),
    });
  },
};

// ─── FINANCIAL INSIGHTS — the Phase 6.1 report gatherer ──────────────────────
//
// Gathers what the pure engine needs and hands it over. Every figure it passes
// in was produced by the engine that owns it — transactionCore for spend,
// income and net movement; budgetReportDS for complete months; forecastDS,
// loanReportDS, propertyReportDS and taxYearDS for the rest — so no insight can
// disagree with the page it points at. No insight arithmetic lives here.

/** The rolling window every change is measured over, and against. */
export const INSIGHT_WINDOW_DAYS = 30;

/** How many COMPLETE months a budget trend may read. Bounded by what bootstrap
 *  actually loads (RECENT_MONTHS), so it can never ask about an empty month. */
export const INSIGHT_BUDGET_MONTHS = 3;

/** Occurrences of one recurring series to read a "usual price" from. */
const INSIGHT_RECURRING_SAMPLE = 6;

/**
 * The entity an alert is already speaking about, in the insight engine's terms.
 *
 * Read off the alert's KEY rather than its title: the key's last segment is the
 * budget line key the alerts engine itself used, so this cannot drift when a
 * category is renamed or a heading is reworded.
 */
function alertEntity(alertKey: string): string | null {
  const parts = alertKey.split(':');
  const kind = parts[0];
  const last = parts[parts.length - 1];
  if (kind === 'cash-low') return 'cash';
  if (kind === 'budget-limit' || kind === 'budget-projected-over' || kind === 'unusual-spend') {
    return last === BUDGET_OVERALL_KEY ? 'spend:overall' : `category:${last}`;
  }
  return null; // a goal alert has no insight that could restate it
}

export const insightsDS = {
  /**
   * Has enough data loaded to trust an EMPTY result?
   *
   * Same guard, and the same reason, as `alertsDS.ready()`: on the first render
   * after a reload the store can be momentarily empty, every insight therefore
   * looks resolved, and a blind prune would delete every dismissal the user has
   * ever made.
   */
  ready(): boolean {
    const s = useStore.getState();
    return s.transactions.length > 0 || s.accounts.length > 0
      || s.loans.length > 0 || s.budgets.length > 0;
  },

  /**
   * The oldest date the loaded history can be trusted from.
   *
   * The user's OWN oldest transaction, not the bootstrap window. Bootstrap
   * fetches everything since RECENT_MONTHS, so it is tempting to claim that
   * whole window as covered and read an empty month inside it as a month with no
   * spending. For most people that is true; for someone who connected their bank
   * last week, or imported one recent statement, it is badly false — and it is
   * exactly those users who would be told their spending had gone up infinitely
   * against a month that simply is not in the file.
   *
   * Reading coverage off the data itself gets both cases right: a long history
   * covers as far back as it goes, and a short one admits it is short. The cost
   * is staying quiet for a household that genuinely spent nothing in an earlier
   * window, which barely exists — rent, a bill or a salary lands in every one.
   *
   * With no transactions at all there is nothing to be wrong about, so the
   * bootstrap window stands and every rule is gated on emptiness anyway.
   */
  coverageFrom(): string {
    const userId = useStore.getState().user?.id ?? null;
    let oldest: string | null = null;
    for (const t of useStore.getState().transactions) {
      if (userId && t.user_id && t.user_id !== userId) continue;
      const date = (t.date || '').slice(0, 10);
      if (!date) continue;
      if (oldest === null || date < oldest) oldest = date;
    }
    return oldest ?? isoMonthsAgo(RECENT_MONTHS);
  },

  /** The two windows a change is measured across. */
  windows(asOf: string) {
    return insightWindows(asOf, INSIGHT_WINDOW_DAYS);
  },

  /**
   * A recurring commitment's price now against its price before.
   *
   * Built from the series' OWN occurrences — the transactions its normalised
   * merchant matches, which is the same rule the series was detected with — so
   * a price rise is read off what the bank actually charged rather than off the
   * expected amount, which only changes when someone edits it.
   *
   * The old price is the MEDIAN of the charges before the latest one: a single
   * earlier charge could itself have been the anomaly, and a median of the last
   * few cannot be moved by one of them.
   */
  recurringCosts(transactions: Transaction[]): RecurringCostInput[] {
    const out: RecurringCostInput[] = [];
    for (const series of recurringSeriesDS.active()) {
      // Costs only. An income stream that went UP is good news the user already
      // knows, and the income insight covers the household total anyway.
      if ((series.expected_amount ?? 0) >= 0) continue;
      const frequency = toForecastFrequency(series.frequency);
      if (!frequency) continue; // irregular — no cadence to price a rise against

      const ids = new Set(occurrenceIdsForSeries(series, transactions));
      const charges = transactions
        .filter(t => ids.has(t.id) || t.recurring_series_id === series.id)
        .map(t => ({
          date: (t.date || '').slice(0, 10),
          amount: Math.abs(effectiveAmount(t)),
          category: t.category || null,
        }))
        .filter(c => c.date && c.amount > 0)
        .sort((a, b) => b.date.localeCompare(a.date));
      if (charges.length < 2) continue;

      const [latest, ...earlier] = charges;
      const sample = earlier.slice(0, INSIGHT_RECURRING_SAMPLE).map(c => c.amount).sort((a, b) => a - b);
      const mid = Math.floor(sample.length / 2);
      const previousAmount = sample.length % 2 ? sample[mid] : (sample[mid - 1] + sample[mid]) / 2;

      out.push({
        id: series.id,
        name: series.name,
        // The category the latest charge was FILED under, not one stored on the
        // series (there is none). It is what lets the engine notice that this
        // rise is the same money as a category's rise and say it once.
        category: latest.category,
        frequency,
        amount: latest.amount,
        previousAmount,
        history: sample.length,
        lastDate: latest.date,
      });
    }
    return out;
  },

  /**
   * The complete months a budget trend may read — never the month in progress,
   * and never a month the loaded history does not cover.
   */
  budgetHistory(asOf: string): BudgetReport[] {
    const coverage = monthKeyOf(this.coverageFrom());
    const current = asOf.slice(0, 7);
    const months: string[] = [];
    for (let back = INSIGHT_BUDGET_MONTHS; back >= 1; back--) {
      const month = addMonthsKey(current, -back);
      if (coverage && month < coverage) continue;
      months.push(month);
    }
    // `adaptive: false` deliberately: the adaptive learner exists to PROJECT the
    // rest of a month, and every month here is already over. Running it would
    // cost three passes over the whole transaction history to compute a
    // projection no trend rule reads.
    return months.map(month => budgetReportDS.build({ month, asOf, adaptive: false }));
  },

  /**
   * Every insight that currently holds.
   *
   * `alerts` is optional and, when given, silences any insight restating a live
   * alert. The caller passes the report it has ALREADY built (the Overview
   * builds one for the alert card) rather than having this build a second one —
   * two builds would be two 90-day forecasts for one screen.
   */
  build(opts?: {
    asOf?: string;
    /** Length of the window compared, in days. Defaults to the rolling 30; the
     *  review (Phase 6.2) passes its own period length so the window IS the
     *  week or month being reviewed. */
    windowDays?: number;
    /**
     * Leave out everything that describes TODAY rather than the window: the
     * forecast, and the standing loan, property and tax facts.
     *
     * Set when reading a PAST period. The forecast projects from today's
     * balances and the standing facts are today's figures, so both would answer
     * a question about March with an August number — and cost four engine builds
     * to do it.
     */
    retrospective?: boolean;
    alerts?: AlertReport | null;
  }): InsightReport {
    const asOf = opts?.asOf ?? todayInDisplayTz();
    const retrospective = opts?.retrospective ?? false;
    const { window, previousWindow } = insightWindows(asOf, opts?.windowDays ?? INSIGHT_WINDOW_DAYS);

    const userId = useStore.getState().user?.id ?? null;
    const transactions = useStore.getState().transactions
      .filter(t => !userId || !t.user_id || t.user_id === userId);

    // The SAME exclusion set and split map every other spend surface uses, so an
    // insight can never disagree with the Accounts page about what was spent.
    const spendOptions = {
      excludeIds: computeTransferExclusionIds(transactions, detectInternalTransferIds),
      splitsByTxId: transactionSplitsDS.byTransactionId(),
    };

    const inWindow = (from: string, to: string): Transaction[] =>
      transactions.filter(t => {
        const date = (t.date || '').slice(0, 10);
        return date >= from && date <= to;
      });
    const currentTxns = inWindow(window.from, window.to);
    const previousTxns = inWindow(previousWindow.from, previousWindow.to);

    const windowSpend = (rows: Transaction[]): WindowSpend => {
      const byCategory = spendByCategory(rows, spendOptions);
      let total = 0;
      for (const category in byCategory) total += byCategory[category];
      return { total, byCategory };
    };

    const windowTransactions: WindowTxn[] = currentTxns
      .map(t => ({
        id: t.id,
        date: (t.date || '').slice(0, 10),
        category: t.category || 'Uncategorised',
        merchant: t.merchant || 'Unknown',
        amount: spendAmount(t, spendOptions),
      }))
      .filter(t => t.amount > 0);

    // A forecast that cannot be built is not a reason to hide every insight —
    // the cash-flow one simply loses its forward half (see cashFlowTrend).
    let forecast: CashFlowForecast | null = null;
    if (!retrospective) {
      try {
        forecast = forecastDS.build({ asOf, horizons: [window.days] });
      } catch (err) {
        console.warn('[insights] forecast unavailable:', err);
      }
    }

    // The financial year is only looked at when the loaded history reaches its
    // start. Built here rather than passed in and rejected inside, because the
    // position is expensive and an uncovered year would only be thrown away.
    const coverageFrom = this.coverageFrom();
    const fy = financialYearOf(asOf);
    const fyStart = fyBounds(fy).start;
    const tax = !retrospective && coverageFrom <= fyStart
      ? { fy, start: fyStart, position: taxYearDS.build({ fy }) }
      : null;

    const spokenFor = (opts?.alerts?.visible ?? [])
      .map(a => alertEntity(a.key))
      .filter((entity): entity is string => entity !== null);

    return buildInsights({
      asOf,
      window,
      previousWindow,
      coverageFrom,
      spend: { current: windowSpend(currentTxns), previous: windowSpend(previousTxns) },
      income: {
        current: totalIncomeInflow(currentTxns, spendOptions),
        previous: totalIncomeInflow(previousTxns, spendOptions),
      },
      netMovement: {
        current: netMovement(currentTxns),
        previous: netMovement(previousTxns),
      },
      transactions: windowTransactions,
      recurring: this.recurringCosts(transactions),
      budgetHistory: this.budgetHistory(asOf),
      forecast,
      // Built only when there is something to build a report ABOUT. An empty
      // report costs a pass over every transaction to conclude nothing, and this
      // runs on the Overview beside four other engines.
      loans: !retrospective && useStore.getState().loans.length > 0
        ? loanReportDS.build({ today: asOf })
        : null,
      property: !retrospective && useStore.getState().properties.length > 0
        ? propertyReportDS.build(asOf)
        : null,
      // Phase 8.2 — premium movement. Same guard, same reason: no policies, no
      // report to build and nothing to conclude from it.
      insurance: !retrospective && useStore.getState().insurancePolicies.length > 0
        ? insuranceReportDS.build(asOf)
        : null,
      tax,
      states: alertStatesDS.inputs({ namespace: 'insight' }),
      spokenFor,
    });
  },
};

// ─── FINANCIAL REVIEW — the Phase 6.2 report gatherer ────────────────────────
//
// Assembles one COMPLETE period for the Phase 6.2 engine: the 6.1 insights for
// that period (built with the period's own length as the comparison window, so
// the window IS the week or month being reviewed), the period's totals from
// transactionCore, and — for the latest period only — where the forecast and the
// goals report say things are heading.
//
// Nothing is stored. A past review is re-derived from the same data every time
// it is opened, which is why paging back cannot show figures that have since
// drifted from the pages behind them.

/** How many complete periods back a user can page. */
export const REVIEW_HISTORY_PERIODS = 12;

/** The horizon the review's own risk section reads, beside the goal capacity. */
const REVIEW_FORECAST_DAYS = 30;

/**
 * The entity a live alert is speaking about, in the review's terms.
 *
 * Extends `alertEntity` with goals: an insight never talks about a goal, so 6.1
 * had nothing to suppress, but a review DOES have a goal risk and a live
 * "goal behind" alert is exactly the voice it must not duplicate.
 */
function reviewAlertEntity(alertKey: string): string | null {
  const parts = alertKey.split(':');
  if (parts[0] === 'goal-behind') return `goal:${parts.slice(1).join(':')}`;
  return alertEntity(alertKey);
}

export const reviewDS = {
  /** Same guard, and the same reason, as `insightsDS.ready()`. */
  ready(): boolean {
    return insightsDS.ready();
  },

  /**
   * The complete periods a user can actually look at, newest first.
   *
   * Bounded by coverage: paging back to a month whose transactions were never
   * loaded would offer a review that can only ever answer "not enough history".
   * A period the history reaches PART way into is kept — the engine reports it
   * as uncovered, which is the honest answer rather than a hidden one.
   */
  periods(kind: ReviewPeriodKind, opts?: { asOf?: string; count?: number }): ReviewPeriod[] {
    const asOf = opts?.asOf ?? todayInDisplayTz();
    const coverage = insightsDS.coverageFrom();
    const all = reviewPeriods(asOf, kind, opts?.count ?? REVIEW_HISTORY_PERIODS);
    const covered = all.filter(p => p.to >= coverage);
    // Never nothing: the latest complete period is always offered, even to a
    // brand-new account, because "a quiet week" is a valid review.
    return covered.length > 0 ? covered : all.slice(0, 1);
  },

  /**
   * What a period actually moved, exactly as every other spend surface counts it.
   *
   * The same canonical options as `insightsDS.build` — the shared transfer
   * exclusion set and split map — so the total at the top of a review can never
   * disagree with the insight rows underneath it.
   */
  totals(from: string, to: string): { spend: number; income: number; net: number } {
    const userId = useStore.getState().user?.id ?? null;
    const all = useStore.getState().transactions
      .filter(t => !userId || !t.user_id || t.user_id === userId);
    const spendOptions = {
      excludeIds: computeTransferExclusionIds(all, detectInternalTransferIds),
      splitsByTxId: transactionSplitsDS.byTransactionId(),
    };
    const rows = all.filter(t => {
      const date = (t.date || '').slice(0, 10);
      return date >= from && date <= to;
    });
    return {
      spend: totalSpend(rows, spendOptions),
      income: totalIncomeInflow(rows, spendOptions),
      net: netMovement(rows),
    };
  },

  /**
   * One period, reviewed.
   *
   * `periodKey` picks which one; anything unparseable, of the wrong kind, or not
   * yet finished falls back to the latest complete period rather than reviewing
   * a week that is still being lived.
   *
   * NOTE — the caller must NOT prune the insight report's `resolvedKeys` from
   * this build. A review of March derives March's insight keys, so every
   * dismissal about today would come back as "resolved" and be deleted. Pruning
   * belongs to `useInsights`, which builds the CURRENT window; `useReview`
   * deliberately does not.
   */
  build(opts?: {
    kind?: ReviewPeriodKind;
    periodKey?: string;
    asOf?: string;
    alerts?: AlertReport | null;
  }): ReviewReport {
    const asOf = opts?.asOf ?? todayInDisplayTz();
    const kind = opts?.kind ?? 'month';

    const available = reviewPeriods(asOf, kind, REVIEW_HISTORY_PERIODS);
    const latestPeriod = available[0] ?? previousCompletePeriod(asOf, kind);
    const requested = opts?.periodKey ? reviewPeriodFor(opts.periodKey) : null;
    const period = requested && requested.kind === kind && requested.to < asOf
      ? requested
      : latestPeriod;
    const latest = period.key === latestPeriod.key;

    // The insight window IS the period: `asOf` is its last day and the window is
    // exactly as long as it is, so what the review reports as "this month" is
    // the same month the insights were measured over.
    const insights = insightsDS.build({
      asOf: period.to,
      windowDays: period.days,
      // A past period is read retrospectively — no forecast, no standing facts.
      retrospective: !latest,
      // Alert suppression is about what is being shouted NOW, so it only applies
      // to the review that is also about now. Filtering a March review by
      // today's alerts would silently delete March's history.
      alerts: latest ? (opts?.alerts ?? null) : null,
    });

    // ── Where things are heading — the latest review only ──
    let forecast: CashFlowForecast | null = null;
    let goals: GoalReport | null = null;
    if (latest) {
      try {
        // ONE forecast for both jobs, built the way alertsDS builds its own: the
        // widest horizon is the goals' capacity, and the review's risk section
        // reads the same projection rather than a second, differing one.
        forecast = forecastDS.build({
          asOf,
          horizons: [REVIEW_FORECAST_DAYS, GOAL_CAPACITY_DAYS],
        });
      } catch (err) {
        console.warn('[review] forecast unavailable:', err);
      }
      const horizon = forecast?.horizons[forecast.horizons.length - 1];
      goals = goalReportDS.build({
        asOf,
        capacity: horizon ? { surplus: horizon.net, days: horizon.days } : false,
      });
    }

    const spokenFor = (opts?.alerts?.visible ?? [])
      .map(a => reviewAlertEntity(a.key))
      .filter((entity): entity is string => entity !== null);

    return buildReview({
      period,
      latest,
      asOf,
      coverageFrom: insightsDS.coverageFrom(),
      // What the user would be shown: a dismissed insight stays dismissed in the
      // review, because it is the same observation and they have already said so.
      insights: insights.visible as Insight[],
      comparedWith: insights.previousWindow,
      totals: {
        current: this.totals(period.from, period.to),
        previous: this.totals(insights.previousWindow.from, insights.previousWindow.to),
      },
      forecast,
      goals,
      alertEntities: spokenFor,
      // Insights the 6.1 engine already dropped for the same reason, so the
      // review's pointer at the alert card counts everything it stands for.
      alreadySuppressed: insights.suppressedByAlert,
    });
  },
};

/** The last complete period before `asOf` — the floor `periods()` can never fall
 *  below, kept here so `build` always has a period to fall back to. */
function previousCompletePeriod(asOf: string, kind: ReviewPeriodKind): ReviewPeriod {
  return reviewPeriods(asOf, kind, 1)[0] ?? periodContaining(asOf, kind);
}

// ═══════════════════════════════════════════════════════════════════════════
//  ASK LEDGER (Phase 9.1)
// ═══════════════════════════════════════════════════════════════════════════
//
// A natural-language front door onto the engines that were already here. It
// adds NO arithmetic: every figure an answer states is produced by the same
// builder the corresponding screen reads — budgetReportDS for a budget
// question, forecastDS for a forecast one, loanReportDS for an offset,
// taxYearDS for deductions, goalReportDS for a goal — so an answer can never
// disagree with the page it links to.
//
// Three properties hold by construction rather than by prompt:
//
//   READ-ONLY   Nothing below writes to the store, queues a sync, or calls a
//               mutator. Asking a question cannot change a record.
//
//   SCOPED      Every read goes through a `*DS` getter, which is already
//               scope- and ownership-filtered. A household question answers
//               from the rows shared to that household; a personal one from
//               the user's own. Another user's private rows are not reachable
//               from here because they are not reachable from those getters.
//
//   GROUNDED    The AI's only inputs are the question and a list of NAMES
//               (utils/askIntent). It returns an intent, which is validated
//               against a closed vocabulary before anything is computed, and
//               its prose is checked against the computed figures before it is
//               shown (utils/askAnswer). It never sees a total and never
//               supplies one.

/** Days of forward cash-flow an "outlook" question reports on. */
const ASK_FORECAST_DAYS = 90;
/** Days ahead a "what's due" question looks. */
const ASK_BILL_WINDOW_DAYS = 30;
/** How many rows a breakdown lists before it stops. */
const ASK_BREAKDOWN_LIMIT = 6;

/** Spend rows in a window, with the canonical exclusion set applied. */
function askSpendRows(from: string, to: string): { rows: Transaction[]; opts: { excludeIds: Set<string>; splitsByTxId: Map<string, TransactionSplit[]> } } {
  const all = transactionsDS.getAll();
  const opts = {
    excludeIds: computeTransferExclusionIds(all, detectInternalTransferIds),
    splitsByTxId: transactionSplitsDS.byTransactionId(),
  };
  const rows = all.filter(t => {
    const d = (t.date || '').slice(0, 10);
    return d >= from && d <= to;
  });
  return { rows, opts };
}

/**
 * The window a period is compared against.
 *
 * For a NAMED period this is the same period one cycle back, truncated to the
 * same point in it: "this month" (1–24 August) compares against 1–24 July, not
 * against the 24 days immediately before it. The rolling version straddles two
 * months, so it answers a different question from the one that was asked — and
 * a comparison the user didn't ask for is worse than none.
 *
 * A rolling window ("the last 30 days") genuinely IS rolling, so it compares
 * against the 30 days before it. All-time has nothing before it.
 */
function askPreviousWindow(period: AskPeriod): { from: string; to: string } | null {
  if (period.kind === 'all-time') return null;

  const elapsed = Math.max(1, daysInclusive(period.from, period.to));

  if (period.kind === 'month') {
    const [y, m] = period.from.split('-').map(Number);
    const py = m === 1 ? y - 1 : y;
    const pm = m === 1 ? 12 : m - 1;
    const from = `${py}-${String(pm).padStart(2, '0')}-01`;
    // Truncated to the same number of days, and never past that month's end —
    // 1–31 March compares against 1–28 February, not against 1–31.
    const monthEnd = new Date(Date.UTC(py, pm, 0)).getUTCDate();
    const to = `${py}-${String(pm).padStart(2, '0')}-${String(Math.min(elapsed, monthEnd)).padStart(2, '0')}`;
    return { from, to };
  }

  if (period.kind === 'calendar-year' || period.kind === 'financial-year') {
    return { from: shiftYearISO(period.from, -1), to: shiftYearISO(period.to, -1) };
  }

  const to = shiftISO(period.from, -1);
  return { from: shiftISO(to, -(elapsed - 1)), to };
}

/** The same calendar date a year earlier. 29 February falls back to the 28th. */
function shiftYearISO(date: string, years: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const targetYear = y + years;
  const monthEnd = new Date(Date.UTC(targetYear, m, 0)).getUTCDate();
  return `${targetYear}-${String(m).padStart(2, '0')}-${String(Math.min(d, monthEnd)).padStart(2, '0')}`;
}

function shiftISO(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1));
  t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
}

function daysInclusive(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 1;
  return Math.floor((b - a) / 86_400_000) + 1;
}

function askCurrency(): string {
  return useStore.getState().user?.currency_preference ?? 'AUD';
}

/** Categories, largest first, as slices of a window's spend. */
function askCategorySlices(rows: Transaction[], opts: SpendOptions, total: number): CategorySlice[] {
  const byCategory = spendByCategory(rows, opts);
  const counts = new Map<string, number>();
  for (const t of rows) {
    if (!isSpendTransaction(t, opts)) continue;
    const key = (t.category || UNCATEGORISED);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Object.entries(byCategory)
    .filter(([, v]) => Math.abs(v) > 0.005)
    .map(([category, value]) => ({
      category,
      total: round2(value),
      share: total > 0 ? round2((value / total) * 100) : 0,
      count: counts.get(category) ?? 0,
    }))
    .sort((a, b) => b.total - a.total);
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}


/**
 * Should the answer compare against the previous window, and what must it admit?
 *
 * Three cases, and the middle one is why this is a function rather than an `if`:
 *   • the history covers the whole comparison window → compare, say nothing;
 *   • it covers PART of it → compare, and say where the comparison starts. A
 *     partly-loaded window silently reported as a full one is how "your
 *     spending doubled" gets said about a month that was never loaded;
 *   • it covers none of it → no comparison at all. Reporting an unseen window
 *     as zero is the one thing that must never happen.
 */
function askComparison(
  period: AskPeriod,
  coverage: string,
): { window: { from: string; to: string } | null; gap: AskGap | null } {
  const prev = askPreviousWindow(period);
  if (!prev) return { window: null, gap: null };
  if (prev.to < coverage) return { window: null, gap: null };
  if (prev.from >= coverage) return { window: prev, gap: null };
  return {
    window: { from: coverage, to: prev.to },
    gap: {
      kind: 'partial-history',
      message: `The comparison covers ${coverage} to ${prev.to} — Ledger's history does not reach back to ${prev.from}.`,
      to: '/accounts',
    },
  };
}

export const askDS = {
  /**
   * Everything a question is allowed to NAME, from the user's own data.
   *
   * Scope-filtered like everything else, which is what makes slot resolution
   * safe: a goal that isn't in this view cannot be named, so a question can
   * never be answered from a record the user isn't entitled to see.
   */
  vocabulary(): AskVocabulary {
    const s = useStore.getState();
    const categories = mergeCategories([
      ...customCategoriesDS.names(),
      ...transactionsDS.getAll().map(t => (t.category ?? '').trim()).filter(Boolean),
    ]);
    return {
      categories,
      goals: goalsDS.getAll().map(g => ({ id: g.id, name: g.name })),
      loans: scoped(s.loans).map(l => ({ id: l.id, name: l.name })),
      // A property with no name yet cannot be named in a question, so it is
      // left out rather than given a placeholder that could be matched on.
      properties: propertiesDS.getAll()
        .filter(p => (p.name ?? '').trim())
        .map(p => ({ id: p.id, name: (p.name ?? '').trim() })),
      accounts: accountsDS.getAll().map(a => ({ id: a.id, name: a.name })),
      financialYears: taxYearDS.financialYears(),
    };
  },

  /** Today, in the user's display timezone — every answer's `asOf`. */
  today(): string {
    return todayInDisplayTz();
  },

  /** Read the question with no AI involved. The default path. */
  interpret(question: string, opts?: { asOf?: string }): AskIntent {
    return matchIntent(question, this.vocabulary(), opts?.asOf ?? todayInDisplayTz());
  },

  /**
   * Read the question, letting a model propose the intent.
   *
   * The proposal is put through `sanitiseIntent`, which validates it against
   * the closed intent list and this user's own vocabulary — so the model can
   * only ever pick from what Ledger can answer about data the user has. A
   * failed or unavailable call is not an error: the rules match stands.
   */
  async interpretWithAI(question: string, opts?: { asOf?: string }): Promise<AskIntent> {
    const asOf = opts?.asOf ?? todayInDisplayTz();
    const vocab = this.vocabulary();
    const fallback = matchIntent(question, vocab, asOf);
    try {
      const res = await overviewApi.askInterpret({
        question,
        vocabulary: vocabularyForModel(vocab),
      });
      if (!res || res.error || !res.intent) return fallback;
      return sanitiseIntent(res.intent, question, vocab, asOf, fallback);
    } catch (err) {
      console.warn('[ask] interpret failed, using rules:', (err as Error).message);
      return fallback;
    }
  },

  /**
   * Answer an interpreted question from Ledger's engines.
   *
   * Synchronous and side-effect free. Every branch ends in a builder that
   * already exists; this only chooses which one and re-shapes its output into
   * figures, sources, links and gaps.
   */
  answerFor(intent: AskIntent, opts?: { asOf?: string }): AskAnswer {
    const asOf = opts?.asOf ?? todayInDisplayTz();
    const currency = askCurrency();
    const scope = currentScope();
    const ctx = householdContext();
    const household = activeHousehold(ctx);
    const gaps: AskGap[] = gapsForUnresolved(intent.unresolved);

    const built = buildAskFacts(intent, asOf);
    const scopeNote = scopeGap(scope, household?.name ?? null, inAnyHousehold(ctx));
    if (scopeNote) built.gaps.push(scopeNote);

    return {
      question: intent.question,
      intent: intent.name,
      interpretation: intent.source,
      confidence: intent.confidence,
      facts: built.facts,
      headline: describeAnswer(built.facts, currency),
      figures: built.figures,
      sources: built.sources,
      gaps: [...gaps, ...built.gaps],
      period: built.period ?? intent.period,
      scope,
      scopeLabel: scope === 'household' ? (household?.name ?? 'Household') : 'My finances',
      asOf,
    };
  },

  /** Read and answer in one call, with no AI. */
  answer(question: string, opts?: { asOf?: string }): AskAnswer {
    return this.answerFor(this.interpret(question, opts), opts);
  },

  /**
   * The prose the user reads.
   *
   * Ledger's own sentence is computed first and is what gets shown unless a
   * model's rewording passes `checkPhrasing` — every number in it appearing in
   * the answer's own figures. A rejected rewording is recorded, not retried:
   * the fallback is a correct sentence, so there is nothing to recover from.
   */
  async phrase(answer: AskAnswer): Promise<{ text: string; source: 'ledger' | 'ai'; rejected?: number[] }> {
    try {
      const res = await overviewApi.askPhrase({
        question: answer.question,
        intent: answer.intent,
        // Figures only — the model is given what to SAY, never the data to
        // compute from, and never a raw transaction.
        statement: answer.headline,
        figures: answer.figures.map(f => ({ label: f.label, value: f.value, kind: f.kind })),
        currency: askCurrency(),
      });
      if (!res || res.error || !res.text) return { text: answer.headline, source: 'ledger' };
      return resolvePhrasing(answer, res.text);
    } catch (err) {
      console.warn('[ask] phrasing failed, using Ledger prose:', (err as Error).message);
      return { text: answer.headline, source: 'ledger' };
    }
  },

  /**
   * Suggested questions, drawn from what this user actually HAS.
   *
   * Never a fixed list: offering "how much is my offset saving" to somebody
   * with no offset teaches them the wrong thing about their own ledger.
   */
  suggestions(): string[] {
    const today = todayInDisplayTz();
    const vocab = this.vocabulary();
    const out: string[] = [];

    const { rows, opts } = askSpendRows(shiftISO(today, -90), today);
    const spendCategory = askCategorySlices(rows, opts, totalSpend(rows, opts))[0]?.category;

    if (spendCategory) out.push(`How much did I spend on ${spendCategory} this year?`);
    if (accountsDS.getAll().length) out.push('Why is my forecast dropping?');
    if (scoped(useStore.getState().loans).some(l => l.offset_account_id || (l.offset_balance ?? 0) > 0)) {
      out.push('How much interest is my offset saving?');
    }
    if (vocab.financialYears.length) out.push('What deductions do I have?');
    if (vocab.goals.length) {
      out.push(vocab.goals.length === 1
        ? `Am I on track for ${vocab.goals[0].name}?`
        : 'Am I on track for my goals?');
    }
    if (useStore.getState().budgets.length) out.push('How am I tracking against my budget?');
    if (out.length < 4) out.push('What changed in my spending recently?');
    return out.slice(0, 5);
  },
};

/** What one answer is made of, before scope and slot gaps are folded in. */
interface BuiltAsk {
  facts: AskFacts;
  figures: AskFigure[];
  sources: AskSource[];
  gaps: AskGap[];
  period: AskPeriod | null;
}

const TX_LINK = '/accounts?tab=transactions';

/**
 * Compute one question's answer.
 *
 * Every branch is the same shape: pick the engine that owns this question, ask
 * it, and re-present its output. The only logic here is presentation and the
 * honest reporting of what the engine could NOT answer.
 */
function buildAskFacts(intent: AskIntent, asOf: string): BuiltAsk {
  const currency = askCurrency();
  const gaps: AskGap[] = [];

  const spendPeriod = intent.period ?? defaultSpendPeriod(asOf);
  const coverage = insightsDS.coverageFrom();

  switch (intent.name) {
    // ── Spending ────────────────────────────────────────────────────────────
    case 'spend-total':
    case 'spend-top': {
      const { rows, opts } = askSpendRows(spendPeriod.from, spendPeriod.to);
      const total = round2(totalSpend(rows, opts));
      const categories = askCategorySlices(rows, opts, total);
      const count = rows.filter(t => isSpendTransaction(t, opts)).length;

      const comparison = askComparison(spendPeriod, coverage);
      let previousTotal: number | null = null;
      if (comparison.window) {
        const before = askSpendRows(comparison.window.from, comparison.window.to);
        previousTotal = round2(totalSpend(before.rows, before.opts));
        if (comparison.gap) gaps.push(comparison.gap);
      }

      const gap = coverageGap(spendPeriod, coverage);
      if (gap) gaps.push(gap);
      if (count === 0) {
        gaps.push({
          kind: 'no-data',
          message: `No transactions are recorded between ${spendPeriod.from} and ${spendPeriod.to}.`,
          to: TX_LINK,
        });
      }

      const facts: AskFacts = intent.name === 'spend-top'
        ? { kind: 'spend-top', period: spendPeriod, total, count, categories: categories.slice(0, ASK_BREAKDOWN_LIMIT) }
        : {
          kind: 'spend-total', period: spendPeriod, total, count,
          categories: categories.slice(0, ASK_BREAKDOWN_LIMIT),
          previousTotal,
          delta: previousTotal === null ? null : round2(total - previousTotal),
        };

      const figures: AskFigure[] = [
        { key: 'total', label: `Spent ${spendPeriod.label}`, value: total, kind: 'money', emphasis: true },
        { key: 'count', label: 'Transactions', value: count, kind: 'count' },
        ...categories.slice(0, ASK_BREAKDOWN_LIMIT).map(c => ({
          key: `cat:${c.category}`,
          label: c.category,
          value: c.total,
          kind: 'money' as const,
          note: `${Math.round(c.share)}% · ${c.count} transaction${c.count === 1 ? '' : 's'}`,
        })),
      ];
      if (previousTotal !== null) {
        figures.splice(1, 0, {
          key: 'previous', label: 'Previous period', value: previousTotal, kind: 'money',
          tone: total > previousTotal ? 'bad' : 'good',
        });
      }

      return {
        facts, figures, gaps, period: spendPeriod,
        sources: [{
          kind: 'transactions',
          label: `${count} transaction${count === 1 ? '' : 's'} between ${spendPeriod.from} and ${spendPeriod.to}`,
          detail: 'Transfers between your own accounts and refunds are already netted out.',
          to: TX_LINK,
          count,
        }],
      };
    }

    case 'spend-category': {
      const category = intent.category!;
      const { rows, opts } = askSpendRows(spendPeriod.from, spendPeriod.to);
      const totalSpendAll = round2(totalSpend(rows, opts));
      const inCategory = rows.filter(t => (t.category ?? '').trim().toLowerCase() === category.trim().toLowerCase());
      const total = round2(totalSpend(inCategory, opts));
      const count = inCategory.filter(t => isSpendTransaction(t, opts)).length;

      const merchantTotals = new Map<string, { total: number; count: number }>();
      for (const t of inCategory) {
        if (!isSpendTransaction(t, opts)) continue;
        const name = (t.merchant || '').trim() || 'Unnamed';
        const cur = merchantTotals.get(name) ?? { total: 0, count: 0 };
        cur.total = round2(cur.total + spendAmount(t, opts));
        cur.count += 1;
        merchantTotals.set(name, cur);
      }
      const merchants: MerchantSlice[] = [...merchantTotals.entries()]
        .map(([merchant, v]) => ({ merchant, total: v.total, count: v.count }))
        .sort((a, b) => b.total - a.total)
        .slice(0, ASK_BREAKDOWN_LIMIT);

      const comparison = askComparison(spendPeriod, coverage);
      let previousTotal: number | null = null;
      if (comparison.window) {
        const before = askSpendRows(comparison.window.from, comparison.window.to);
        const beforeRows = before.rows.filter(t => (t.category ?? '').trim().toLowerCase() === category.trim().toLowerCase());
        previousTotal = round2(totalSpend(beforeRows, before.opts));
        if (comparison.gap) gaps.push(comparison.gap);
      }

      const months = daysInclusive(spendPeriod.from, spendPeriod.to) / 30.4375;
      const perMonth = months >= 1.5 ? round2(total / months) : null;

      const gap = coverageGap(spendPeriod, coverage);
      if (gap) gaps.push(gap);
      if (count === 0) {
        gaps.push({
          kind: 'no-data',
          message: `No ${category} transactions are recorded between ${spendPeriod.from} and ${spendPeriod.to}. If you file this spending under a different category, the answer will be there instead.`,
          to: TX_LINK,
        });
      }

      const facts: AskFacts = {
        kind: 'spend-category',
        period: spendPeriod,
        category,
        total,
        count,
        share: totalSpendAll > 0 ? round2((total / totalSpendAll) * 100) : 0,
        totalSpend: totalSpendAll,
        merchants,
        previousTotal,
        delta: previousTotal === null ? null : round2(total - previousTotal),
        perMonth,
      };

      const figures: AskFigure[] = [
        { key: 'total', label: `${category} · ${spendPeriod.label}`, value: total, kind: 'money', emphasis: true },
        { key: 'count', label: 'Transactions', value: count, kind: 'count' },
        { key: 'share', label: 'Share of all spending', value: facts.share, kind: 'percent' },
      ];
      if (perMonth !== null) figures.push({ key: 'permonth', label: 'Average per month', value: perMonth, kind: 'money' });
      if (previousTotal !== null) {
        figures.push({
          key: 'previous', label: 'Previous period', value: previousTotal, kind: 'money',
          tone: total > previousTotal ? 'bad' : 'good',
        });
      }
      for (const m of merchants) {
        figures.push({
          key: `merchant:${m.merchant}`, label: m.merchant, value: m.total, kind: 'money',
          note: `${m.count} transaction${m.count === 1 ? '' : 's'}`,
        });
      }

      return {
        facts, figures, gaps, period: spendPeriod,
        sources: [{
          kind: 'transactions',
          label: `${count} ${category} transaction${count === 1 ? '' : 's'}`,
          detail: `Between ${spendPeriod.from} and ${spendPeriod.to}, net of refunds and internal transfers.`,
          to: `/accounts?tab=transactions&category=${encodeURIComponent(category)}`,
          count,
        }],
      };
    }

    // ── Forecast ────────────────────────────────────────────────────────────
    case 'forecast-outlook': {
      const accounts = accountsDS.getAll().filter(a => !a.hidden);
      if (accounts.length === 0) {
        return {
          facts: { kind: 'unknown', reason: 'Ledger needs at least one bank account to project a cash-flow forecast, and none is set up yet.' },
          figures: [], sources: [], period: null,
          gaps: [{ kind: 'no-data', message: 'No bank accounts are connected or added, so there is no balance to project from.', to: '/accounts' }],
        };
      }

      const forecast = forecastDS.build({ asOf, horizons: [30, 60, ASK_FORECAST_DAYS] });
      const horizon = forecast.horizons[forecast.horizons.length - 1];
      if (!horizon) {
        return {
          facts: { kind: 'unknown', reason: 'The cash-flow forecast could not be built from the data currently loaded.' },
          figures: [], sources: [], period: null,
          gaps: [{ kind: 'no-data', message: 'Nothing recurring is on file to project — add income, bills or subscriptions.', to: '/forecast' }],
        };
      }

      const outflows = forecast.events
        .filter(e => e.amount < 0 && !e.isTransfer)
        .sort((a, b) => a.amount - b.amount)
        .slice(0, ASK_BREAKDOWN_LIMIT)
        .map(e => ({ name: e.name, amount: round2(Math.abs(e.amount)), date: e.date, type: e.sourceType }));

      // The first day the running balance goes negative — the whole point of the
      // question when somebody asks why the forecast is dropping.
      let running = forecast.openingTotal;
      let negativeFrom: string | null = null;
      for (const e of forecast.events) {
        if (e.date > horizon.date) break;
        running = round2(running + e.amount);
        if (running < 0) { negativeFrom = e.date; break; }
      }

      const uncertainCount = forecast.events.filter(e => e.confidence < 0.999).length;

      const facts: AskFacts = {
        kind: 'forecast-outlook',
        asOf,
        horizonDays: horizon.days,
        opening: round2(horizon.openingBalance),
        closing: round2(horizon.projectedBalance),
        net: round2(horizon.net),
        inflow: round2(horizon.inflow),
        outflow: round2(Math.abs(horizon.outflow)),
        lowestBalance: round2(horizon.lowestBalance),
        lowestDate: horizon.lowestDate || null,
        negativeFrom,
        biggestOutflows: outflows,
        uncertainCount,
      };

      if (negativeFrom) {
        gaps.push({
          kind: 'conflict',
          message: `The projection goes below zero on ${negativeFrom}. It assumes every scheduled movement lands as recorded.`,
          to: '/forecast',
        });
      }
      if (uncertainCount > 0) {
        gaps.push({
          kind: 'incomplete-record',
          message: `${uncertainCount} projected movement${uncertainCount === 1 ? ' is' : 's are'} estimated from your history rather than scheduled, so the closing figure is an estimate.`,
          to: '/forecast',
        });
      }
      if (forecast.events.length === 0) {
        gaps.push({
          kind: 'no-data',
          message: 'Nothing recurring is on file, so the projection is just today\'s balances carried forward.',
          to: '/forecast',
        });
      }

      return {
        facts,
        gaps,
        period: null,
        figures: [
          { key: 'closing', label: `Projected in ${horizon.days} days`, value: round2(horizon.projectedBalance), kind: 'money', emphasis: true, tone: horizon.net < 0 ? 'bad' : 'good' },
          { key: 'opening', label: 'Today', value: round2(horizon.openingBalance), kind: 'money' },
          { key: 'net', label: 'Net change', value: round2(horizon.net), kind: 'money', tone: horizon.net < 0 ? 'bad' : 'good' },
          { key: 'in', label: 'Coming in', value: round2(horizon.inflow), kind: 'money', tone: 'good' },
          { key: 'out', label: 'Going out', value: round2(Math.abs(horizon.outflow)), kind: 'money', tone: 'bad' },
          { key: 'low', label: 'Low point', value: round2(horizon.lowestBalance), kind: 'money', note: horizon.lowestDate || undefined, tone: horizon.lowestBalance < 0 ? 'bad' : 'neutral' },
          ...outflows.map(o => ({
            key: `out:${o.name}:${o.date}`,
            label: o.name,
            value: o.amount,
            kind: 'money' as const,
            note: `${o.type.replace(/_/g, ' ')} · ${o.date}`,
          })),
        ],
        sources: [
          {
            kind: 'forecast',
            label: `${forecast.events.length} projected movement${forecast.events.length === 1 ? '' : 's'} across ${accounts.length} account${accounts.length === 1 ? '' : 's'}`,
            detail: 'Income, bills, subscriptions, loan repayments and detected recurring costs, de-duplicated.',
            to: '/forecast',
            count: forecast.events.length,
          },
          {
            kind: 'account',
            label: `Opening balances from ${accounts.length} account${accounts.length === 1 ? '' : 's'}`,
            to: '/accounts',
            count: accounts.length,
          },
        ],
      };
    }

    // ── Budgets ─────────────────────────────────────────────────────────────
    case 'budget-status': {
      const report = budgetReportDS.build({ asOf });
      const lines: BudgetLineFact[] = report.categories.map(l => ({
        category: l.name,
        limit: round2(l.effectiveLimit),
        spent: round2(l.spent),
        projected: round2(l.projected),
        remaining: round2(l.remaining),
        status: l.status,
      }));
      const over = lines.filter(l => l.remaining < 0);

      if (lines.length === 0 && !report.overall) {
        gaps.push({
          kind: 'no-data',
          message: 'You have no budgets set, so there is no cap to measure this month against.',
          to: '/',
        });
      }
      if (report.unbudgetedSpend > 0.005) {
        gaps.push({
          kind: 'incomplete-record',
          message: `${formatCurrency(round2(report.unbudgetedSpend), currency)} of this month's spending is in categories with no budget, so it isn't counted above.`,
          to: '/',
        });
      }

      const facts: AskFacts = {
        kind: 'budget-status',
        month: report.month,
        monthLabel: budgetMonthLabel(report.month),
        budgeted: round2(report.totals.budgeted),
        spent: round2(report.totals.spent),
        remaining: round2(report.totals.remaining),
        projected: round2(report.totals.projected),
        over,
        lines,
      };

      return {
        facts, gaps, period: null,
        figures: [
          { key: 'spent', label: `Spent in ${budgetMonthLabel(report.month)}`, value: round2(report.totals.spent), kind: 'money', emphasis: true },
          { key: 'budgeted', label: 'Budgeted', value: round2(report.totals.budgeted), kind: 'money' },
          { key: 'remaining', label: 'Remaining', value: round2(report.totals.remaining), kind: 'money', tone: report.totals.remaining < 0 ? 'bad' : 'good' },
          { key: 'projected', label: 'Projected month end', value: round2(report.totals.projected), kind: 'money', tone: report.totals.projected > report.totals.budgeted ? 'bad' : 'neutral' },
          ...lines.slice(0, ASK_BREAKDOWN_LIMIT).map(l => ({
            key: `budget:${l.category}`,
            label: l.category,
            value: l.spent,
            kind: 'money' as const,
            tone: (l.remaining < 0 ? 'bad' : 'neutral') as 'bad' | 'neutral',
            note: `of ${formatCurrency(l.limit, currency)} · projected ${formatCurrency(l.projected, currency)}`,
          })),
        ],
        sources: [{
          kind: 'budget',
          label: `${lines.length} category budget${lines.length === 1 ? '' : 's'} for ${budgetMonthLabel(report.month)}`,
          detail: `Measured over ${report.daysElapsed} of ${report.daysInMonth} days.`,
          to: '/',
          count: lines.length,
        }],
      };
    }

    // ── Goals ───────────────────────────────────────────────────────────────
    case 'goal-progress': {
      const report = goalReportDS.build({ asOf });
      const all: GoalFact[] = report.lines.map(l => ({
        id: l.id,
        name: l.name,
        target: round2(l.targetAmount),
        saved: round2(l.saved),
        percent: round2(l.progressPct),
        status: l.status,
        // Three-valued on purpose. 'unknown' and 'no-deadline' are NOT "no":
        // one means there is no forecast to judge against and the other means
        // there is no date to be late for, and reporting either as off-track
        // would be Ledger inventing a verdict it doesn't have.
        onTrack: l.status === 'complete' || l.status === 'on-track'
          ? true
          : l.status === 'behind' || l.status === 'overdue' || l.status === 'at-risk'
            ? false
            : null,
        targetDate: l.targetDate,
        projectedDate: l.projectedDate,
        requiredPerMonth: l.requiredPerMonth,
        shortfall: round2(l.shortfallPerMonth),
      }));

      const focusName = intent.goal?.name ?? null;
      const goals = focusName ? all.filter(g => g.name === focusName) : all;

      if (all.length === 0) {
        gaps.push({ kind: 'no-data', message: 'You have no savings goals in Ledger.', to: '/' });
      }
      if (focusName && goals.length === 0) {
        gaps.push({ kind: 'unresolved', message: `No goal called "${focusName}" is in this view.`, to: '/' });
      }
      for (const g of goals) {
        if (!g.targetDate) {
          gaps.push({
            kind: 'incomplete-record',
            message: `"${g.name}" has no target date, so Ledger can say how far along it is but not whether it lands on time.`,
            to: '/',
          });
        }
      }
      if (report.monthlyCapacity === null && goals.length > 0) {
        gaps.push({
          kind: 'incomplete-record',
          message: 'The cash-flow forecast could not be built, so "on track" is judged from the dates alone rather than from what you can afford.',
          to: '/forecast',
        });
      }
      for (const l of report.lines) {
        if (l.brokenLinks.length && goals.some(g => g.id === l.id)) {
          gaps.push({
            kind: 'conflict',
            message: `"${l.name}" is linked to ${l.brokenLinks.length} account or holding Ledger can no longer find, so its saved figure may be understated.`,
            to: '/',
          });
        }
      }

      const facts: AskFacts = {
        kind: 'goal-progress',
        asOf,
        goals,
        focus: focusName,
        totalTarget: round2(goals.reduce((s, g) => s + g.target, 0)),
        totalSaved: round2(goals.reduce((s, g) => s + g.saved, 0)),
        surplus: report.monthlyCapacity,
        surplusDays: report.monthlyCapacity === null ? null : 30,
      };

      const figures: AskFigure[] = [];
      if (goals.length === 1) {
        const g = goals[0];
        figures.push(
          { key: 'saved', label: `Saved toward ${g.name}`, value: g.saved, kind: 'money', emphasis: true },
          { key: 'target', label: 'Target', value: g.target, kind: 'money' },
          { key: 'percent', label: 'Progress', value: g.percent, kind: 'percent' },
        );
        if (g.targetDate) figures.push({ key: 'targetdate', label: 'Target date', value: g.targetDate, kind: 'date' });
        if (g.projectedDate) figures.push({ key: 'projected', label: 'Projected to land', value: g.projectedDate, kind: 'date', tone: g.onTrack === false ? 'bad' : 'good' });
        if (g.requiredPerMonth !== null) figures.push({ key: 'required', label: 'Needed per month', value: round2(g.requiredPerMonth), kind: 'money' });
      } else {
        figures.push(
          { key: 'saved', label: 'Saved across all goals', value: facts.totalSaved, kind: 'money', emphasis: true },
          { key: 'target', label: 'Total target', value: facts.totalTarget, kind: 'money' },
          ...goals.map(g => ({
            key: `goal:${g.id}`,
            label: g.name,
            value: g.saved,
            kind: 'money' as const,
            tone: (g.onTrack === false ? 'bad' : g.onTrack ? 'good' : 'neutral') as 'bad' | 'good' | 'neutral',
            note: `of ${formatCurrency(g.target, currency)} · ${Math.round(g.percent)}%`,
          })),
        );
      }
      if (report.monthlyCapacity !== null) {
        figures.push({
          key: 'capacity', label: 'Spare cash per month (forecast)', value: round2(report.monthlyCapacity), kind: 'money',
          tone: report.monthlyCapacity < 0 ? 'bad' : 'good',
        });
      }

      return {
        facts, figures, gaps, period: null,
        sources: [
          { kind: 'goal', label: `${goals.length} goal${goals.length === 1 ? '' : 's'}`, to: '/', count: goals.length },
          ...(report.monthlyCapacity !== null
            ? [{ kind: 'forecast' as const, label: '90-day cash-flow forecast', detail: 'Supplies the spare cash the goals are funded from.', to: '/forecast' }]
            : []),
        ],
      };
    }

    // ── Loans ───────────────────────────────────────────────────────────────
    case 'loan-offset': {
      const report = loanReportDS.build({ today: asOf });
      const named = intent.loan ? report.rows.filter(r => r.id === intent.loan!.id) : report.rows;
      const withOffset = named.filter(r => r.offsetBalance > 0 || r.offsetIsLinked);

      if (report.rows.length === 0) {
        gaps.push({ kind: 'no-data', message: 'You have no loans in Ledger, so there is no interest for an offset to save.', to: '/loans' });
      } else if (withOffset.length === 0) {
        gaps.push({
          kind: 'no-data',
          message: 'None of your loans has an offset account or an offset balance recorded.',
          to: '/loans',
        });
      }

      const loans: OffsetFact[] = withOffset.map(r => ({
        loanId: r.id,
        loanName: r.name,
        balance: round2(r.balance),
        offset: round2(r.offsetBalance),
        effectiveBalance: round2(r.effectiveBalance),
        rate: r.rate,
        savingPerYear: round2(r.offsetSavingPerYear),
        savingPerMonth: round2(r.offsetSavingPerMonth),
        accountName: r.offsetAccount?.name ?? null,
        linked: r.offsetIsLinked,
        linkBroken: r.offsetLinkBroken,
      }));

      for (const l of loans) {
        if (l.linkBroken) {
          gaps.push({
            kind: 'conflict',
            message: `"${l.loanName}" is linked to an offset account Ledger can no longer find, so it is offsetting nothing until it is re-linked.`,
            to: '/loans',
          });
        }
        if (l.rate === 0) {
          gaps.push({
            kind: 'incomplete-record',
            message: `"${l.loanName}" has no interest rate on file, so Ledger cannot price what its offset saves.`,
            to: '/loans',
          });
        }
      }

      const facts: AskFacts = {
        kind: 'loan-offset',
        loans,
        totalOffset: round2(loans.reduce((s, l) => s + l.offset, 0)),
        totalSavingPerYear: round2(loans.reduce((s, l) => s + l.savingPerYear, 0)),
        totalSavingPerMonth: round2(loans.reduce((s, l) => s + l.savingPerMonth, 0)),
      };

      return {
        facts, gaps, period: null,
        figures: [
          { key: 'peryear', label: 'Interest saved per year', value: facts.totalSavingPerYear, kind: 'money', emphasis: true, tone: 'good' },
          { key: 'permonth', label: 'Per month', value: facts.totalSavingPerMonth, kind: 'money', tone: 'good' },
          { key: 'offset', label: 'Sitting in offset', value: facts.totalOffset, kind: 'money' },
          ...loans.map(l => ({
            key: `loan:${l.loanId}`,
            label: l.loanName,
            value: l.savingPerYear,
            kind: 'money' as const,
            note: `${formatCurrency(l.offset, currency)} offsetting ${formatCurrency(l.balance, currency)} at ${l.rate}%${l.accountName ? ` · ${l.accountName}` : ''}`,
          })),
        ],
        sources: [
          {
            kind: 'loan',
            label: `${loans.length} loan${loans.length === 1 ? '' : 's'} with an offset`,
            detail: 'Interest is priced on the balance net of offset, at the rate in force today.',
            to: '/loans',
            count: loans.length,
          },
          ...loans.filter(l => l.linked && l.accountName).map(l => ({
            kind: 'account' as const,
            label: `${l.accountName} — live balance offsetting ${l.loanName}`,
            to: '/accounts',
          })),
        ],
      };
    }

    case 'loan-payoff': {
      const report = loanReportDS.build({ today: asOf });
      const rows = intent.loan ? report.rows.filter(r => r.id === intent.loan!.id) : report.rows;

      if (report.rows.length === 0) {
        gaps.push({ kind: 'no-data', message: 'You have no loans in Ledger.', to: '/loans' });
      }

      const loans: LoanPayoffFact[] = rows.map(r => ({
        loanId: r.id,
        loanName: r.name,
        balance: round2(r.balance),
        rate: r.rate,
        repayment: round2(r.repayment),
        frequency: r.frequency,
        monthsToPayoff: r.monthsToPayoff,
        payoffDate: r.payoffDate,
        interestPerYear: round2(r.interestPerYear),
        contractEndDate: r.contractEndDate,
        monthsAheadOfContract: r.monthsAheadOfContract,
      }));

      for (const l of loans) {
        if (!l.payoffDate) {
          gaps.push({
            kind: 'incomplete-record',
            message: `"${l.loanName}" has no repayment or term on file, so Ledger cannot project when it clears.`,
            to: '/loans',
          });
        }
      }

      const facts: AskFacts = {
        kind: 'loan-payoff',
        loans,
        totalBalance: round2(loans.reduce((s, l) => s + l.balance, 0)),
        totalInterestPerYear: round2(loans.reduce((s, l) => s + l.interestPerYear, 0)),
        debtFreeDate: report.totals.debtFreeDate,
      };

      return {
        facts, gaps, period: null,
        figures: [
          { key: 'balance', label: 'Owing', value: facts.totalBalance, kind: 'money', emphasis: true },
          { key: 'interest', label: 'Interest per year', value: facts.totalInterestPerYear, kind: 'money', tone: 'bad' },
          ...(facts.debtFreeDate ? [{ key: 'free', label: 'Debt-free', value: facts.debtFreeDate, kind: 'date' as const, tone: 'good' as const }] : []),
          ...loans.map(l => ({
            key: `loan:${l.loanId}`,
            label: l.loanName,
            value: l.balance,
            kind: 'money' as const,
            note: `${l.rate}% · ${formatCurrency(l.repayment, currency)} ${l.frequency}${l.payoffDate ? ` · clears ${l.payoffDate}` : ''}`,
          })),
        ],
        sources: [{
          kind: 'loan',
          label: `${loans.length} loan${loans.length === 1 ? '' : 's'}`,
          detail: 'Projected at the rate and repayment recorded today, including any extra repayments.',
          to: '/loans',
          count: loans.length,
        }],
      };
    }

    // ── Tax ─────────────────────────────────────────────────────────────────
    case 'tax-deductions': {
      const fy = intent.fy ?? fyOf(asOf);
      const position = taxYearDS.build({ fy });
      const view = position.deductions;

      const categories: DeductionSlice[] = position.deductionCategories.map(c => ({
        category: c.category,
        total: round2(c.total),
        share: round2(c.share),
        count: c.lineCount,
      }));

      if (view.lineCount === 0) {
        gaps.push({
          kind: 'no-data',
          message: `Nothing is flagged as deductible for FY ${fy}. Deductions come from transactions you tick as deductible and from entries you add on the Tax page.`,
          to: '/tax',
        });
      }
      if (view.suspectedDuplicates.length) {
        gaps.push({
          kind: 'conflict',
          message: `${view.suspectedDuplicates.length} deduction${view.suspectedDuplicates.length === 1 ? ' looks' : 's look'} like a duplicate of a transaction already counted. Ledger has counted each once and left them flagged for you to confirm.`,
          to: '/tax',
        });
      }
      if (view.refundedTotal > 0.005) {
        gaps.push({
          kind: 'incomplete-record',
          message: `${formatCurrency(round2(view.refundedTotal), currency)} has been refunded against these claims and is already netted off the total.`,
          to: '/tax',
        });
      }
      if (view.countedInRental.length) {
        gaps.push({
          kind: 'incomplete-record',
          message: `${view.countedInRental.length} expense${view.countedInRental.length === 1 ? ' is' : 's are'} claimed by the rental schedule instead, so they are counted there rather than twice.`,
          to: '/tax',
        });
      }

      const facts: AskFacts = {
        kind: 'tax-deductions',
        fy,
        total: round2(view.total),
        lineCount: view.lineCount,
        manualTotal: round2(view.manualTotal),
        transactionTotal: round2(view.transactionTotal),
        rentalTotal: round2(view.externalTotal),
        businessTotal: round2(view.businessTotal),
        personalTotal: round2(view.personalTotal),
        refundedTotal: round2(view.refundedTotal),
        categories: categories.slice(0, ASK_BREAKDOWN_LIMIT),
        suspectedDuplicates: view.suspectedDuplicates.length,
      };

      return {
        facts, gaps, period: null,
        figures: [
          { key: 'total', label: `Deductions FY ${fy}`, value: facts.total, kind: 'money', emphasis: true },
          { key: 'lines', label: 'Lines', value: facts.lineCount, kind: 'count' },
          { key: 'manual', label: 'Entered by hand', value: facts.manualTotal, kind: 'money' },
          { key: 'transactions', label: 'From transactions', value: facts.transactionTotal, kind: 'money' },
          ...(facts.rentalTotal ? [{ key: 'rental', label: 'From the rental schedule', value: facts.rentalTotal, kind: 'money' as const }] : []),
          ...(facts.businessTotal ? [{ key: 'business', label: 'Business', value: facts.businessTotal, kind: 'money' as const }] : []),
          ...facts.categories.map(c => ({
            key: `ded:${c.category}`,
            label: c.category,
            value: c.total,
            kind: 'money' as const,
            note: `${Math.round(c.share)}% · ${c.count} line${c.count === 1 ? '' : 's'}`,
          })),
        ],
        sources: [{
          kind: 'tax',
          label: `${view.lineCount} deduction line${view.lineCount === 1 ? '' : 's'} for FY ${fy}`,
          detail: 'Manual entries, deductible transactions and the rental schedule, de-duplicated and net of refunds.',
          to: '/tax',
          count: view.lineCount,
        }],
      };
    }

    case 'tax-position': {
      const fy = intent.fy ?? fyOf(asOf);
      const position = taxYearDS.build({ fy });

      if (position.assessableIncome === 0 && position.deductibleExpenses === 0) {
        gaps.push({
          kind: 'no-data',
          message: `Ledger has no income or deductions recorded for FY ${fy}.`,
          to: '/tax',
        });
      }
      for (const note of position.notes) {
        gaps.push({ kind: note.kind === 'duplicate' ? 'conflict' : 'incomplete-record', message: note.message, to: '/tax' });
      }

      const facts: AskFacts = {
        kind: 'tax-position',
        fy,
        assessableIncome: round2(position.assessableIncome),
        deductibleExpenses: round2(position.deductibleExpenses),
        estimatedTaxableIncome: round2(position.estimatedTaxableIncome),
        taxWithheld: round2(position.taxWithheld),
        notes: position.notes.map(n => n.message),
      };

      return {
        facts, gaps, period: null,
        figures: [
          { key: 'taxable', label: `Estimated taxable income FY ${fy}`, value: facts.estimatedTaxableIncome, kind: 'money', emphasis: true },
          { key: 'income', label: 'Assessable income', value: facts.assessableIncome, kind: 'money' },
          { key: 'deductions', label: 'Deductions', value: facts.deductibleExpenses, kind: 'money' },
          { key: 'withheld', label: 'Tax withheld', value: facts.taxWithheld, kind: 'money' },
        ],
        sources: [{
          kind: 'tax',
          label: `FY ${fy} position`,
          detail: 'Income, capital gains, rent and deductions as Ledger has them. Not tax advice, and no tax is calculated here.',
          to: '/tax',
        }],
      };
    }

    // ── Income ──────────────────────────────────────────────────────────────
    case 'income-total': {
      const period = intent.period ?? spendPeriod;
      const { rows, opts } = askSpendRows(period.from, period.to);
      const total = round2(totalIncomeInflow(rows, opts));
      const inflowRows = rows.filter(t => incomeInflowAmount(t, opts) > 0);

      const bySource = new Map<string, { total: number; count: number }>();
      for (const t of inflowRows) {
        const name = (t.merchant || '').trim() || 'Unnamed';
        const cur = bySource.get(name) ?? { total: 0, count: 0 };
        cur.total = round2(cur.total + incomeInflowAmount(t, opts));
        cur.count += 1;
        bySource.set(name, cur);
      }
      const sources: MerchantSlice[] = [...bySource.entries()]
        .map(([merchant, v]) => ({ merchant, total: v.total, count: v.count }))
        .sort((a, b) => b.total - a.total)
        .slice(0, ASK_BREAKDOWN_LIMIT);

      const gap = coverageGap(period, coverage);
      if (gap) gaps.push(gap);
      if (inflowRows.length === 0) {
        gaps.push({
          kind: 'no-data',
          message: `No money-in transactions are recorded between ${period.from} and ${period.to}.`,
          to: TX_LINK,
        });
      }
      const entries = incomeDS.getAll().entries.filter(e => {
        const d = (e.date || '').slice(0, 10);
        return d >= period.from && d <= period.to;
      });
      if (entries.length) {
        gaps.push({
          kind: 'incomplete-record',
          message: `${entries.length} income entr${entries.length === 1 ? 'y is' : 'ies are'} also recorded for this period. The figure above counts money that landed in your accounts, so an entry with no matching deposit isn't in it.`,
          to: '/income',
        });
      }

      return {
        facts: { kind: 'income-total', period, total, count: inflowRows.length, sources },
        gaps,
        period,
        figures: [
          { key: 'total', label: `Received ${period.label}`, value: total, kind: 'money', emphasis: true, tone: 'good' },
          { key: 'count', label: 'Payments', value: inflowRows.length, kind: 'count' },
          ...sources.map(s => ({
            key: `src:${s.merchant}`, label: s.merchant, value: s.total, kind: 'money' as const,
            note: `${s.count} payment${s.count === 1 ? '' : 's'}`,
          })),
        ],
        sources: [{
          kind: 'income',
          label: `${inflowRows.length} incoming transaction${inflowRows.length === 1 ? '' : 's'}`,
          detail: 'Transfers between your own accounts are excluded.',
          to: TX_LINK,
          count: inflowRows.length,
        }],
      };
    }

    // ── Net worth ───────────────────────────────────────────────────────────
    case 'net-worth': {
      const scope = currentScope();
      const snapshot = calculateNetWorth(scope);
      const ctx = householdContext();
      const household = activeHousehold(ctx);
      const assets = round2(snapshot.bank_balance + snapshot.investments + snapshot.super + snapshot.property);
      const liabilities = round2(snapshot.credit_card_debt + snapshot.loans);

      if (assets === 0 && liabilities === 0) {
        gaps.push({ kind: 'no-data', message: 'Nothing is recorded yet to add up.', to: '/accounts' });
      }
      if (scope === 'household') {
        gaps.push({
          kind: 'scope',
          message: 'Investments and super stay personal — a household view counts the accounts, cards, loans and properties shared to it.',
          to: '/settings',
        });
      }

      return {
        facts: {
          kind: 'net-worth',
          asOf,
          net: round2(snapshot.net_worth),
          assets,
          liabilities,
          bank: round2(snapshot.bank_balance),
          investments: round2(snapshot.investments),
          superBalance: round2(snapshot.super),
          property: round2(snapshot.property),
          loans: round2(snapshot.loans),
          cardDebt: round2(snapshot.credit_card_debt),
          scope,
          householdName: household?.name ?? null,
        },
        gaps,
        period: null,
        figures: [
          { key: 'net', label: 'Net worth', value: round2(snapshot.net_worth), kind: 'money', emphasis: true },
          { key: 'bank', label: 'Bank', value: round2(snapshot.bank_balance), kind: 'money' },
          { key: 'investments', label: 'Investments', value: round2(snapshot.investments), kind: 'money' },
          { key: 'super', label: 'Super', value: round2(snapshot.super), kind: 'money' },
          { key: 'property', label: 'Property', value: round2(snapshot.property), kind: 'money' },
          { key: 'loans', label: 'Loans', value: round2(snapshot.loans), kind: 'money', tone: 'bad' },
          { key: 'cards', label: 'Card debt', value: round2(snapshot.credit_card_debt), kind: 'money', tone: 'bad' },
        ],
        sources: [
          { kind: 'net-worth', label: 'Accounts, cards, investments, super, property and loans', to: '/' },
          { kind: 'account', label: 'Balances as recorded today', to: '/accounts' },
        ],
      };
    }

    // ── Bills ───────────────────────────────────────────────────────────────
    case 'bills-upcoming': {
      const to = shiftISO(asOf, ASK_BILL_WINDOW_DAYS);
      const bills: BillFact[] = billsDS.getAll()
        .filter(b => !b.is_paid)
        .filter(b => {
          const d = (b.due_date || '').slice(0, 10);
          return d >= asOf && d <= to;
        })
        .map(b => ({
          id: b.id,
          name: b.name,
          amount: round2(b.amount),
          dueDate: (b.due_date || '').slice(0, 10),
          daysUntil: daysInclusive(asOf, (b.due_date || '').slice(0, 10)) - 1,
        }))
        .sort((a, b) => a.dueDate.localeCompare(b.dueDate));

      const overdue = billsDS.getAll().filter(b => !b.is_paid && (b.due_date || '').slice(0, 10) < asOf);
      if (overdue.length) {
        gaps.push({
          kind: 'conflict',
          message: `${overdue.length} bill${overdue.length === 1 ? ' is' : 's are'} already past due and not counted above.`,
          to: '/',
        });
      }
      if (bills.length === 0) {
        gaps.push({
          kind: 'no-data',
          message: `Nothing unpaid is due between ${asOf} and ${to}. Only bills recorded in Ledger are counted — a direct debit that isn't set up here won't appear.`,
          to: '/',
        });
      }

      return {
        facts: {
          kind: 'bills-upcoming',
          from: asOf,
          to,
          days: ASK_BILL_WINDOW_DAYS,
          total: round2(bills.reduce((s, b) => s + b.amount, 0)),
          bills,
        },
        gaps,
        period: null,
        figures: [
          { key: 'total', label: `Due in the next ${ASK_BILL_WINDOW_DAYS} days`, value: round2(bills.reduce((s, b) => s + b.amount, 0)), kind: 'money', emphasis: true },
          { key: 'count', label: 'Bills', value: bills.length, kind: 'count' },
          ...bills.slice(0, ASK_BREAKDOWN_LIMIT).map(b => ({
            key: `bill:${b.id}`, label: b.name, value: b.amount, kind: 'money' as const,
            note: `due ${b.dueDate}`,
          })),
        ],
        sources: [{
          kind: 'bill',
          label: `${bills.length} unpaid bill${bills.length === 1 ? '' : 's'}`,
          to: '/',
          count: bills.length,
        }],
      };
    }

    // ── What changed ────────────────────────────────────────────────────────
    case 'insights-changes': {
      const report = insightsDS.build({ asOf });
      const totals = reviewDS.totals(report.window.from, report.window.to);
      const before = reviewDS.totals(report.previousWindow.from, report.previousWindow.to);

      const changes: ChangeFact[] = report.visible.slice(0, ASK_BREAKDOWN_LIMIT).map(i => ({
        title: i.title,
        detail: describeInsight(i.facts, currency, report.window.days),
        amount: round2(i.monthlyImpact),
        direction: i.direction,
        to: i.link.to,
      }));

      if (report.visible.length === 0) {
        gaps.push({
          kind: 'no-data',
          message: `Nothing crossed the threshold worth reporting over the last ${report.window.days} days.`,
          to: '/',
        });
      }
      if (report.window.from < coverage) {
        gaps.push({
          kind: 'partial-history',
          message: `Ledger's history starts at ${coverage}, so the comparison window is only partly covered.`,
          to: '/accounts',
        });
      }

      return {
        facts: {
          kind: 'insights-changes',
          from: report.window.from,
          to: report.window.to,
          days: report.window.days,
          changes,
          spend: round2(totals.spend),
          previousSpend: round2(before.spend),
          delta: round2(totals.spend - before.spend),
        },
        gaps,
        period: null,
        figures: [
          { key: 'spend', label: `Spent in the last ${report.window.days} days`, value: round2(totals.spend), kind: 'money', emphasis: true },
          { key: 'previous', label: 'Window before', value: round2(before.spend), kind: 'money' },
          ...changes.map((c, i) => ({
            key: `change:${i}`,
            label: c.title,
            value: c.amount,
            kind: 'money' as const,
            tone: (c.direction === 'worsening' ? 'bad' : c.direction === 'improving' ? 'good' : 'neutral') as 'bad' | 'good' | 'neutral',
            note: c.detail,
          })),
        ],
        sources: [{
          kind: 'insight',
          label: `${report.visible.length} insight${report.visible.length === 1 ? '' : 's'} over ${report.window.from} to ${report.window.to}`,
          detail: 'Derived fresh from your transactions, budgets, loans and tax position — never stored.',
          to: '/',
          count: report.visible.length,
        }],
      };
    }

    // ── Nothing to answer from ──────────────────────────────────────────────
    case 'unknown':
    default:
      return {
        facts: {
          kind: 'unknown',
          reason: 'Ledger could not tell what that question is asking for. It can answer about spending, income, budgets, your cash-flow forecast, savings goals, loans and offsets, bills due, deductions and your tax position, net worth, and what has changed recently.',
        },
        figures: [],
        sources: [],
        period: null,
        gaps: [{
          kind: 'unsupported',
          message: 'Try naming what you want to know about — a category, a goal, a loan, or a period like "this month".',
        }],
      };
  }
}

/** "August 2026" from `2026-08`. */
function budgetMonthLabel(monthKey: string): string {
  const [y, m] = monthKey.split('-').map(Number);
  const names = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
  return y && m ? `${names[m - 1]} ${y}` : monthKey;
}
