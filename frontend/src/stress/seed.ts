/**
 * Seeding for the pre-market stress test. Imported by every stress file AFTER
 * that file has mocked `./services/syncQueue` (vi.mock is hoisted, so the order
 * in the source does not matter).
 */
import { useStore } from '../store';
import { documentsDS } from '../services/dataService';
import { documentsApi } from '../services/api';
import { vi } from 'vitest';
import {
  USERS, households, members, visibleTo, TODAY,
} from './world';
import type { LedgerDocument } from '../types';

export interface Seed {
  as: string;
  scope?: 'personal' | 'household';
  active?: string | null;
  /** Slices to override after the world is loaded. */
  patch?: Record<string, unknown>;
}

/** Load the world as `as` would legitimately receive it. */
export function seedAs(o: Seed) {
  const v = visibleTo(o.as);
  const u = USERS[o.as];
  useStore.setState({
    user: {
      id: u.id, email: u.email, name: u.name, currency_preference: 'AUD',
      theme: 'system', plan: 'premium', onboarding_complete: true,
    } as never,
    token: 'stress-token',
    dataOwnerId: o.as,
    households,
    householdMembers: members,
    householdInvitations: [],
    financeScope: o.scope ?? 'personal',
    activeHouseholdId: o.active ?? null,

    accounts: v.accounts,
    creditCards: v.creditCards,
    transactions: v.transactions,
    subscriptions: v.subscriptions,
    investments: v.investments,
    investmentSales: v.investmentSales,
    superFunds: v.superFunds,
    incomeEntries: v.incomeEntries,
    bills: v.bills,
    goals: v.goals,
    goalContributions: v.goalContributions,
    loans: v.loans,
    loanEvents: v.loanEvents,
    properties: v.properties,
    insurancePolicies: v.insurancePolicies,
    insurancePremiumHistory: v.insurancePremiumHistory,
    budgets: v.budgets,
    recordShares: v.recordShares,
    shareCodes: [],
    recurringSeries: v.recurringSeries,
    transactionSplits: v.transactionSplits,
    creditCardStatements: v.creditCardStatements,
    pendingPayments: v.pendingPayments,
    ccPaymentPrompts: [],

    alertStates: [],
    budgetSettings: null,
    budgetLines: [],
    customCategories: [],
    merchants: [],
    merchantAliases: [],
    transactionRules: [],
    billSubExclusions: [],
    hiddenCategories: [],
    selectedCategories: null,
    categoryAliases: {},
    notifications: [],
    netWorth: null,
    netWorthHistory: [],
    idMap: {},
    pendingSyncQueue: [],
    basiqUserId: null,
    ...(o.patch ?? {}),
  } as never);
  return v;
}

/** Put this user's document vault in front of the client, as the server would. */
export async function seedDocuments(docs: LedgerDocument[]) {
  vi.spyOn(documentsApi, 'getAll').mockResolvedValue(docs as never);
  vi.spyOn(documentsApi, 'facts').mockResolvedValue([] as never);
  documentsDS.reset();
  await documentsDS.refresh();
}

export const AS_OF = TODAY;

/** Install a jsdom-free localStorage. Call from vi.hoisted in each test file. */
export function installLocalStorage() {
  const mem = new Map<string, string>();
  (globalThis as unknown as { localStorage: unknown }).localStorage = {
    getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
    setItem: (k: string, v: string) => { mem.set(k, String(v)); },
    removeItem: (k: string) => { mem.delete(k); },
    clear: () => mem.clear(),
    key: () => null,
    get length() { return mem.size; },
  };
}
