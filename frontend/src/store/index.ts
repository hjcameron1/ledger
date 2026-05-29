import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  User, BankAccount, CreditCard, Transaction, Investment,
  Bill, Goal, Notification, NetWorthSnapshot, Budget,
  IncomeEntry, SuperFund, Subscription, PendingPayment,
} from '../types';

interface AppState {
  // Auth
  user: User | null;
  token: string | null;
  setAuth: (user: User, token: string) => void;
  logout: () => void;

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

  // Basiq live bank connection
  basiqUserId: string | null;
  setBasiqUserId: (id: string | null) => void;

  // Dashboard widget visibility
  widgetVisibility: Record<string, boolean>;
  setWidgetVisibility: (key: string, visible: boolean) => void;
}

export const useStore = create<AppState>()(
  persist(
    (set) => ({
      user: null,
      token: null,
      setAuth: (user, token) => set({ user, token }),
      logout: () => set({ user: null, token: null }),

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

      basiqUserId: null,
      setBasiqUserId: (basiqUserId) => set({ basiqUserId }),

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
    }),
    {
      name: 'ledger-store',
      partialize: (state) => ({
        user: state.user,
        token: state.token,
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
      }),
    }
  )
);
