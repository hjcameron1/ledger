import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  User, BankAccount, CreditCard, Transaction, Investment,
  Bill, Goal, Loan, Notification, NetWorthSnapshot, Budget,
  BudgetSettings, BudgetLine, CustomCategory,
  IncomeEntry, SuperFund, Subscription, PendingPayment, CreditCardStatement, CcPaymentPrompt,
} from '../types';
import type { RecurringPattern } from '../utils/recurringDetection';
import { type Theme, applyTheme } from '../utils/theme';

// A single failed Supabase write, parked for retry. Serializable so it survives
// reloads (persisted in localStorage) and can be replayed on next app load.
export interface SyncQueueItem {
  qid: string;                       // unique queue id
  kind: string;                      // dispatch key, e.g. 'bill.create'
  payload: Record<string, unknown>;  // everything needed to replay the API call
  attempts: number;                  // how many times we've tried
  lastError?: string;
}

interface AppState {
  // Auth
  user: User | null;
  token: string | null;
  setAuth: (user: User, token: string) => void;
  logout: () => void;
  // Epoch-ms of the most recent successful auth. NOT persisted. The api 401
  // interceptor uses this to suppress auto-logout during the brief window right
  // after login, when a cold-starting backend may emit transient 401s that would
  // otherwise bounce the user straight back to the login screen.
  lastAuthMs: number;

  // Identity of the user whose data is currently cached in localStorage. Used to
  // detect a user switch on a shared device so one user's data can never merge
  // into — or sync up under — another user's account.
  dataOwnerId: string | null;
  setDataOwnerId: (id: string | null) => void;

  // Theme
  theme: Theme;
  setTheme: (theme: Theme) => void;

  // UI
  quickAddOpen: boolean;
  setQuickAddOpen: (open: boolean) => void;
  notificationsOpen: boolean;
  setNotificationsOpen: (open: boolean) => void;

  // Data
  accounts: BankAccount[];
  setAccounts: (accounts: BankAccount[]) => void;
  creditCards: CreditCard[];
  setCreditCards: (cards: CreditCard[]) => void;
  transactions: Transaction[];
  setTransactions: (txns: Transaction[]) => void;
  subscriptions: Subscription[];
  setSubscriptions: (subs: Subscription[]) => void;
  investments: Investment[];
  setInvestments: (investments: Investment[]) => void;
  superFunds: SuperFund[];
  setSuperFunds: (funds: SuperFund[]) => void;
  portfolioTotal: number;
  setPortfolioTotal: (total: number) => void;
  investmentsNextUpdate: string | null;
  setInvestmentsNextUpdate: (iso: string | null) => void;
  incomeEntries: IncomeEntry[];
  setIncomeEntries: (entries: IncomeEntry[]) => void;
  projectedAnnual: number;
  setProjectedAnnual: (amount: number) => void;
  bills: Bill[];
  setBills: (bills: Bill[]) => void;
  goals: Goal[];
  setGoals: (goals: Goal[]) => void;
  loans: Loan[];
  setLoans: (loans: Loan[]) => void;
  budgets: Budget[];
  setBudgets: (budgets: Budget[]) => void;
  budgetSettings: BudgetSettings | null;
  setBudgetSettings: (settings: BudgetSettings | null) => void;
  budgetLines: BudgetLine[];
  setBudgetLines: (lines: BudgetLine[]) => void;
  customCategories: CustomCategory[];
  setCustomCategories: (cats: CustomCategory[]) => void;
  // Built-in category names the user has switched off (legacy blocklist, kept for
  // back-compat until selectedCategories is set). Mirrored to users.ui_preferences.
  hiddenCategories: string[];
  setHiddenCategories: (names: string[]) => void;
  // The user's chosen categories (allowlist). When set, ONLY these show in every
  // category picker. null = never chosen yet → fall back to the legacy behaviour.
  selectedCategories: string[] | null;
  setSelectedCategories: (names: string[] | null) => void;
  notifications: Notification[];
  setNotifications: (notifications: Notification[]) => void;
  netWorth: NetWorthSnapshot | null;
  setNetWorth: (nw: NetWorthSnapshot) => void;
  netWorthHistory: { recorded_date: string; total_value: number }[];
  setNetWorthHistory: (history: { recorded_date: string; total_value: number }[]) => void;

  // Pending payments
  pendingPayments: PendingPayment[];
  setPendingPayments: (payments: PendingPayment[]) => void;

  // Credit card statements
  creditCardStatements: CreditCardStatement[];
  setCreditCardStatements: (statements: CreditCardStatement[]) => void;

  // Credit card payment prompts (which-card / whole-amount questions)
  ccPaymentPrompts: CcPaymentPrompt[];
  setCcPaymentPrompts: (prompts: CcPaymentPrompt[]) => void;

  // Permanent local-temp-id → server-id map. Survives reloads so that any record
  // persisted with a stale temp id can always be resolved to its canonical server id.
  idMap: Record<string, string>;
  setIdMap: (map: Record<string, string>) => void;
  addIdMapping: (tempId: string, serverId: string) => void;

  // Basiq live bank connection
  basiqUserId: string | null;
  setBasiqUserId: (id: string | null) => void;

  // Pending recurring patterns (session-only, not persisted)
  pendingRecurringCount: number;
  setPendingRecurringCount: (n: number) => void;

  // Detected-but-not-yet-reviewed recurring patterns (session-only, not persisted).
  // Produced by the global detector hook, consumed by the Accounts modal queue.
  pendingPatterns: RecurringPattern[];
  setPendingPatterns: (patterns: RecurringPattern[]) => void;

  // Detection trigger. Bumping detectionTick re-runs the global detector.
  detectionTick: number;
  triggerDetection: () => void;
  // Schedule a single detection pass 10s after a bulk import/upload settles.
  triggerDetectionPasses: () => void;

  // Flag: the next detection run should open the modal immediately (vs badge only).
  recurringShowImmediate: boolean;
  setRecurringShowImmediate: (v: boolean) => void;

  // True while the Accounts modal queue is visible — the global detector reads
  // this to avoid clobbering an in-progress review session.
  recurringModalActive: boolean;
  setRecurringModalActive: (v: boolean) => void;

  // Flag: open the recurring modal as soon as Accounts/Subscriptions is ready
  openRecurringModal: boolean;
  setOpenRecurringModal: (open: boolean) => void;

  // Dashboard widget visibility
  widgetVisibility: Record<string, boolean>;
  setWidgetVisibility: (key: string, visible: boolean) => void;

  // Failed-write retry queue (persisted) + a transient global "couldn't sync" toast.
  pendingSyncQueue: SyncQueueItem[];
  setPendingSyncQueue: (queue: SyncQueueItem[]) => void;
  enqueueSync: (item: SyncQueueItem) => void;
  dequeueSync: (qid: string) => void;
  bumpSyncAttempt: (qid: string, error: string) => void;
  syncToast: string | null;
  setSyncToast: (msg: string | null) => void;
}

export const useStore = create<AppState>()(
  persist(
    (set, get) => ({
      user: null,
      token: null,
      lastAuthMs: 0,
      setAuth: (user, token) => set({ user, token, lastAuthMs: Date.now() }),
      // Clear auth only. We intentionally KEEP the cached data slices, the pending
      // sync queue, AND dataOwnerId in localStorage so that when the SAME user logs
      // back in their local-first data (e.g. imported transactions that may not all
      // live on the server) is still there. Cross-user isolation is enforced by the
      // dataOwnerId guard in bootstrapData(): if a DIFFERENT user logs in, that guard
      // purges every slice + the queue before any merge or sync replay. Clearing
      // dataOwnerId here would blind that guard, so it must persist through logout.
      logout: () => set({ user: null, token: null }),

      dataOwnerId: null,
      setDataOwnerId: (dataOwnerId) => set({ dataOwnerId }),

      theme: 'system',
      setTheme: (theme) => {
        set({ theme });
        applyTheme(theme);
      },

      quickAddOpen: false,
      setQuickAddOpen: (open) => set({ quickAddOpen: open }),
      notificationsOpen: false,
      setNotificationsOpen: (open) => set({ notificationsOpen: open }),

      accounts: [],
      setAccounts: (accounts) => set({ accounts }),
      creditCards: [],
      setCreditCards: (creditCards) => set({ creditCards }),
      transactions: [],
      setTransactions: (transactions) => set({ transactions }),
      subscriptions: [],
      setSubscriptions: (subscriptions) => set({ subscriptions }),
      investments: [],
      setInvestments: (investments) => set({ investments }),
      superFunds: [],
      setSuperFunds: (superFunds) => set({ superFunds }),
      portfolioTotal: 0,
      setPortfolioTotal: (portfolioTotal) => set({ portfolioTotal }),
      investmentsNextUpdate: null,
      setInvestmentsNextUpdate: (investmentsNextUpdate) => set({ investmentsNextUpdate }),
      incomeEntries: [],
      setIncomeEntries: (incomeEntries) => set({ incomeEntries }),
      projectedAnnual: 0,
      setProjectedAnnual: (projectedAnnual) => set({ projectedAnnual }),
      bills: [],
      setBills: (bills) => set({ bills }),
      goals: [],
      setGoals: (goals) => set({ goals }),
      loans: [],
      setLoans: (loans) => set({ loans }),
      budgets: [],
      setBudgets: (budgets) => set({ budgets }),
      budgetSettings: null,
      setBudgetSettings: (budgetSettings) => set({ budgetSettings }),
      budgetLines: [],
      setBudgetLines: (budgetLines) => set({ budgetLines }),
      customCategories: [],
      setCustomCategories: (customCategories) => set({ customCategories }),
      hiddenCategories: [],
      setHiddenCategories: (hiddenCategories) => set({ hiddenCategories }),
      selectedCategories: null,
      setSelectedCategories: (selectedCategories) => set({ selectedCategories }),
      notifications: [],
      setNotifications: (notifications) => set({ notifications }),
      netWorth: null,
      setNetWorth: (netWorth) => set({ netWorth }),
      netWorthHistory: [],
      setNetWorthHistory: (netWorthHistory) => set({ netWorthHistory }),

      pendingPayments: [],
      setPendingPayments: (pendingPayments) => set({ pendingPayments }),
      creditCardStatements: [],
      setCreditCardStatements: (creditCardStatements) => set({ creditCardStatements }),
      ccPaymentPrompts: [],
      setCcPaymentPrompts: (ccPaymentPrompts) => set({ ccPaymentPrompts }),

      idMap: {},
      setIdMap: (idMap) => set({ idMap }),
      addIdMapping: (tempId, serverId) =>
        set((s) => ({ idMap: { ...s.idMap, [tempId]: serverId } })),

      basiqUserId: null,
      setBasiqUserId: (basiqUserId) => set({ basiqUserId }),

      pendingRecurringCount: 0,
      setPendingRecurringCount: (pendingRecurringCount) => set({ pendingRecurringCount }),

      pendingPatterns: [],
      setPendingPatterns: (pendingPatterns) => set({ pendingPatterns }),

      detectionTick: 0,
      triggerDetection: () => set((s) => ({ detectionTick: s.detectionTick + 1 })),
      // Single detection pass 10s after a statement upload — enough time for ALL
      // transactions to be fully loaded into the store before detection runs.
      triggerDetectionPasses: () => {
        setTimeout(() => {
          set((s) => ({ detectionTick: s.detectionTick + 1 }));
        }, 10000);
      },

      recurringShowImmediate: false,
      setRecurringShowImmediate: (recurringShowImmediate) => set({ recurringShowImmediate }),

      recurringModalActive: false,
      setRecurringModalActive: (recurringModalActive) => set({ recurringModalActive }),

      openRecurringModal: false,
      setOpenRecurringModal: (openRecurringModal) => set({ openRecurringModal }),

      widgetVisibility: {
        bankAccounts: true,
        investments: true,
        creditCards: true,
        super: true,
        income: true,
        netWorthTrend: true,
        goals: true,
        budgeting: true,
        bills: true,
      },
      setWidgetVisibility: (key, visible) =>
        set((s) => ({ widgetVisibility: { ...s.widgetVisibility, [key]: visible } })),

      pendingSyncQueue: [],
      setPendingSyncQueue: (pendingSyncQueue) => set({ pendingSyncQueue }),
      enqueueSync: (item) => set((s) => ({ pendingSyncQueue: [...s.pendingSyncQueue, item] })),
      dequeueSync: (qid) =>
        set((s) => ({ pendingSyncQueue: s.pendingSyncQueue.filter((i) => i.qid !== qid) })),
      bumpSyncAttempt: (qid, error) =>
        set((s) => ({
          pendingSyncQueue: s.pendingSyncQueue.map((i) =>
            i.qid === qid ? { ...i, attempts: i.attempts + 1, lastError: error } : i
          ),
        })),
      syncToast: null,
      setSyncToast: (syncToast) => set({ syncToast }),
    }),
    {
      name: 'ledger-store',
      partialize: (state) => ({
        user: state.user,
        token: state.token,
        dataOwnerId: state.dataOwnerId,
        theme: state.theme,
        widgetVisibility: state.widgetVisibility,
        accounts: state.accounts,
        creditCards: state.creditCards,
        transactions: state.transactions,
        subscriptions: state.subscriptions,
        investments: state.investments,
        superFunds: state.superFunds,
        portfolioTotal: state.portfolioTotal,
        incomeEntries: state.incomeEntries,
        projectedAnnual: state.projectedAnnual,
        bills: state.bills,
        goals: state.goals,
        loans: state.loans,
        budgets: state.budgets,
        budgetSettings: state.budgetSettings,
        budgetLines: state.budgetLines,
        customCategories: state.customCategories,
        hiddenCategories: state.hiddenCategories,
        selectedCategories: state.selectedCategories,
        netWorthHistory: state.netWorthHistory,
        notifications: state.notifications,
        pendingPayments: state.pendingPayments,
        creditCardStatements: state.creditCardStatements,
        ccPaymentPrompts: state.ccPaymentPrompts,
        basiqUserId: state.basiqUserId,
        idMap: state.idMap,
        pendingSyncQueue: state.pendingSyncQueue,
      }),
    }
  )
);
