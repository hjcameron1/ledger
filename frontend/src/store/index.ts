import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  User, BankAccount, CreditCard, Transaction, Investment,
  Bill, Goal, Notification, NetWorthSnapshot, Budget,
  IncomeEntry, SuperFund, Subscription, PendingPayment,
} from '../types';
import type { RecurringPattern } from '../utils/recurringDetection';

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

  // Identity of the user whose data is currently cached in localStorage. Used to
  // detect a user switch on a shared device so one user's data can never merge
  // into — or sync up under — another user's account.
  dataOwnerId: string | null;
  setDataOwnerId: (id: string | null) => void;

  // Theme
  theme: 'light' | 'dark';
  setTheme: (theme: 'light' | 'dark') => void;

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
  incomeEntries: IncomeEntry[];
  setIncomeEntries: (entries: IncomeEntry[]) => void;
  projectedAnnual: number;
  setProjectedAnnual: (amount: number) => void;
  bills: Bill[];
  setBills: (bills: Bill[]) => void;
  goals: Goal[];
  setGoals: (goals: Goal[]) => void;
  budgets: Budget[];
  setBudgets: (budgets: Budget[]) => void;
  notifications: Notification[];
  setNotifications: (notifications: Notification[]) => void;
  netWorth: NetWorthSnapshot | null;
  setNetWorth: (nw: NetWorthSnapshot) => void;
  netWorthHistory: { recorded_date: string; total_value: number }[];
  setNetWorthHistory: (history: { recorded_date: string; total_value: number }[]) => void;

  // Pending payments
  pendingPayments: PendingPayment[];
  setPendingPayments: (payments: PendingPayment[]) => void;

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
      setAuth: (user, token) => set({ user, token }),
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

      theme: 'light',
      setTheme: (theme) => {
        set({ theme });
        if (theme === 'dark') {
          document.documentElement.classList.add('dark');
        } else {
          document.documentElement.classList.remove('dark');
        }
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
      incomeEntries: [],
      setIncomeEntries: (incomeEntries) => set({ incomeEntries }),
      projectedAnnual: 0,
      setProjectedAnnual: (projectedAnnual) => set({ projectedAnnual }),
      bills: [],
      setBills: (bills) => set({ bills }),
      goals: [],
      setGoals: (goals) => set({ goals }),
      budgets: [],
      setBudgets: (budgets) => set({ budgets }),
      notifications: [],
      setNotifications: (notifications) => set({ notifications }),
      netWorth: null,
      setNetWorth: (netWorth) => set({ netWorth }),
      netWorthHistory: [],
      setNetWorthHistory: (netWorthHistory) => set({ netWorthHistory }),

      pendingPayments: [],
      setPendingPayments: (pendingPayments) => set({ pendingPayments }),

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
        budgets: state.budgets,
        netWorthHistory: state.netWorthHistory,
        notifications: state.notifications,
        pendingPayments: state.pendingPayments,
        basiqUserId: state.basiqUserId,
        idMap: state.idMap,
        pendingSyncQueue: state.pendingSyncQueue,
      }),
    }
  )
);
