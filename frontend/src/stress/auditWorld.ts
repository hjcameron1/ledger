/**
 * PRE-LAUNCH AUDIT — the client's own fresh world.
 *
 * The same four users and three overlapping households the server audit uses
 * (`backend/src/test/prelaunchAudit.world.ts`), written here in the client's
 * types so the two tiers can be held to the SAME topology from both sides.
 *
 * Deliberately separate from `world.ts`: that one is the world the existing
 * suites already agree with. A second, independently-written world is the only
 * way a sweep can fail for a reason other than "somebody changed a number".
 */
import type {
  BankAccount, CreditCard, Transaction, Loan, Property, Budget, Goal, Bill,
  Investment, SuperFund, IncomeEntry, Household, HouseholdMember,
  InsurancePolicy, LedgerDocument, RecordShare, GoalContribution,
} from '../types';

export const ADA = 'u-ada';
export const BO = 'u-bo';
export const CY = 'u-cy';
export const DI = 'u-di';

export const HH_RIVER = 'hh-river';   // Ada owner · Bo member · Cy viewer
export const HH_COAST = 'hh-coast';   // Bo owner · Ada member · Di member
export const HH_KIN = 'hh-kin';       // Cy owner · Di member

export const EVERYONE = [ADA, BO, CY, DI];
export const HOUSEHOLDS_ALL = [HH_RIVER, HH_COAST, HH_KIN];

/** Which households each user can legitimately switch into. */
export const SCOPES_OF: Record<string, string[]> = {
  [ADA]: [HH_RIVER, HH_COAST],
  [BO]: [HH_RIVER, HH_COAST],
  [CY]: [HH_RIVER, HH_KIN],
  [DI]: [HH_COAST, HH_KIN],
};

export const TODAY = '2026-08-25';

export const USERS: Record<string, { id: string; email: string; name: string }> = {
  [ADA]: { id: ADA, email: 'ada@audit.test', name: 'Ada' },
  [BO]: { id: BO, email: 'bo@audit.test', name: 'Bo' },
  [CY]: { id: CY, email: 'cy@audit.test', name: 'Cy' },
  [DI]: { id: DI, email: 'di@audit.test', name: 'Di' },
};

export const households: Household[] = [
  { id: HH_RIVER, name: 'Riverside', created_by: ADA, currency: 'AUD' },
  { id: HH_COAST, name: 'Coast Partners', created_by: BO, currency: 'AUD' },
  { id: HH_KIN, name: 'Kin', created_by: CY, currency: 'AUD' },
];

const mem = (
  household_id: string, user_id: string, role: HouseholdMember['role'],
  status: HouseholdMember['status'] = 'active',
): HouseholdMember => ({
  id: `m-${household_id}-${user_id}`, household_id, user_id, role, status,
  email: USERS[user_id]?.email ?? null, name: USERS[user_id]?.name ?? null,
});

export const members: HouseholdMember[] = [
  mem(HH_RIVER, ADA, 'owner'), mem(HH_RIVER, BO, 'member'), mem(HH_RIVER, CY, 'viewer'),
  mem(HH_RIVER, DI, 'member', 'removed'),           // grants nothing, anywhere
  mem(HH_COAST, BO, 'owner'), mem(HH_COAST, ADA, 'member'), mem(HH_COAST, DI, 'member'),
  mem(HH_KIN, CY, 'owner'), mem(HH_KIN, DI, 'member'),
];

// ── Accounts ─────────────────────────────────────────────────────────────────

const acc = (o: Partial<BankAccount> & Pick<BankAccount, 'id' | 'user_id' | 'name' | 'balance'>): BankAccount =>
  ({ institution: 'CBA', account_type: 'transaction', currency: 'AUD', is_manual: true, household_ids: [], ...o } as unknown as BankAccount);

export const accounts: BankAccount[] = [
  acc({ id: 'a-everyday', user_id: ADA, name: 'Ada Everyday', balance: 12_000, household_ids: [HH_RIVER] }),
  acc({ id: 'a-saver', user_id: ADA, name: 'Ada Saver', balance: 45_000, account_type: 'savings' }),
  acc({
    id: 'a-usd', user_id: ADA, name: 'Ada USD', balance: 10_000, currency: 'USD',
    display_balance: 15_000, display_currency: 'AUD', conversion_rate: 1.5, institution: 'IBKR',
  }),
  acc({ id: 'a-hidden', user_id: ADA, name: 'Ada Closed', balance: 99_000, hidden: true }),
  acc({ id: 'b-everyday', user_id: BO, name: 'Bo Everyday', balance: 8_000, institution: 'NAB', household_ids: [HH_COAST] }),
  acc({ id: 'b-private', user_id: BO, name: 'Bo Private', balance: 1_500, institution: 'NAB', account_type: 'savings' }),
  acc({ id: 'c-everyday', user_id: CY, name: 'Cy Everyday', balance: 3_000, institution: 'Up', household_ids: [HH_KIN] }),
  acc({ id: 'c-private', user_id: CY, name: 'Cy Private', balance: 22_000, institution: 'Up', account_type: 'savings' }),
  // ONE row, TWO households.
  acc({ id: 'd-joint', user_id: DI, name: 'Di Joint', balance: 700, institution: 'ING', household_ids: [HH_COAST, HH_KIN] }),
  acc({ id: 'd-private', user_id: DI, name: 'Di Private', balance: 6_400, institution: 'ING', account_type: 'savings' }),
];

const card = (o: Partial<CreditCard> & Pick<CreditCard, 'id' | 'user_id' | 'name' | 'balance_owing'>): CreditCard =>
  ({ institution: 'Amex', credit_limit: 10_000, currency: 'AUD', household_ids: [], ...o } as unknown as CreditCard);

export const creditCards: CreditCard[] = [
  // In BOTH Riverside and Coast — Bo is in both, and must see it once.
  card({ id: 'a-card', user_id: ADA, name: 'Ada Amex', balance_owing: 2_000, credit_limit: 20_000, household_ids: [HH_RIVER, HH_COAST] }),
  card({ id: 'b-card', user_id: BO, name: 'Bo Visa', balance_owing: 900, institution: 'NAB', credit_limit: 8_000 }),
  card({ id: 'd-card', user_id: DI, name: 'Di Mastercard', balance_owing: 350, institution: 'ING', credit_limit: 5_000, household_ids: [HH_KIN] }),
];

// ── Transactions ─────────────────────────────────────────────────────────────

const tx = (
  id: string, user_id: string, account_id: string, merchant: string,
  amount: number, date = '2026-08-10', category = 'groceries',
): Transaction => ({
  id, user_id, account_id, merchant, amount, date, category,
  currency: 'AUD', account_type: 'bank', household_ids: [],
} as unknown as Transaction);

export const transactions: Transaction[] = [
  tx('t-a-1', ADA, 'a-everyday', 'Woolworths', -120.5),
  tx('t-a-2', ADA, 'a-everyday', 'Coles', -64.2),
  tx('t-a-3', ADA, 'a-everyday', 'Salary', 9_000, '2026-08-01', 'income'),
  tx('t-a-saver', ADA, 'a-saver', 'Interest', 30, '2026-08-05', 'other'),
  { ...tx('t-a-usd', ADA, 'a-usd', 'Amazon', -55, '2026-08-06', 'shopping'), currency: 'USD', display_amount: -82.5, conversion_rate: 1.5 } as unknown as Transaction,
  tx('t-a-hidden', ADA, 'a-hidden', 'Old charge', -10, '2026-08-02', 'other'),
  { ...tx('t-a-loose', ADA, 'a-hidden', 'Shared one-off', -400, '2026-08-12', 'home'), household_ids: [HH_RIVER] } as unknown as Transaction,
  tx('t-b-1', BO, 'b-everyday', 'Bunnings', -210, '2026-08-11', 'home'),
  tx('t-b-2', BO, 'b-everyday', 'Consulting', 4_000, '2026-08-01', 'income'),
  tx('t-b-private', BO, 'b-private', 'Transfer in', 500, '2026-08-03', 'other'),
  tx('t-c-1', CY, 'c-everyday', 'Feed store', -300, '2026-08-09', 'other'),
  tx('t-d-1', DI, 'd-joint', 'Shared groceries', -88, '2026-08-08'),
  tx('t-d-2', DI, 'd-private', 'Chemist', -22, '2026-08-07', 'health'),
  tx('t-d-card', DI, 'd-card', 'Fuel', -70, '2026-08-13', 'transport'),
];

// ── Loans, property, holdings ────────────────────────────────────────────────

export const loans: Loan[] = [
  { id: 'a-mortgage', user_id: ADA, name: 'Riverside Mortgage', lender: 'CBA', loan_type: 'mortgage', original_amount: 500_000, current_balance: 400_000, interest_rate: 6.1, minimum_repayment: 3_000, repayment_frequency: 'monthly', next_due_date: '2026-09-15', household_ids: [HH_RIVER] } as unknown as Loan,
  { id: 'b-car', user_id: BO, name: 'Bo Car Loan', lender: 'NAB', loan_type: 'personal', original_amount: 30_000, current_balance: 20_000, interest_rate: 8.4, minimum_repayment: 600, repayment_frequency: 'monthly', next_due_date: '2026-09-10', household_ids: [HH_COAST] } as unknown as Loan,
  { id: 'c-hecs', user_id: CY, name: 'Cy HECS', lender: 'ATO', loan_type: 'hecs', original_amount: 40_000, current_balance: 18_000, interest_rate: 0, household_ids: [] } as unknown as Loan,
  { id: 'd-personal', user_id: DI, name: 'Di Personal Loan', lender: 'ING', loan_type: 'personal', original_amount: 10_000, current_balance: 4_000, interest_rate: 9.9, household_ids: [] } as unknown as Loan,
];

export const properties: Property[] = [
  { id: 'a-house', user_id: ADA, name: 'Riverside House', address: '1 River St', property_type: 'home', current_value: 900_000, purchase_price: 700_000, purchase_date: '2019-03-01', loan_id: 'a-mortgage', held_by: 'personal', household_ids: [HH_RIVER] } as unknown as Property,
  { id: 'b-unit', user_id: BO, name: 'Bo Unit', address: '2 Coast Rd', property_type: 'investment', current_value: 550_000, purchase_price: 480_000, purchase_date: '2021-06-01', loan_id: 'b-car', held_by: 'personal', household_ids: [] } as unknown as Property,
  { id: 'c-farm', user_id: CY, name: 'Kin Farm', address: '3 Kin Ln', property_type: 'investment', current_value: 1_200_000, purchase_price: 1_000_000, purchase_date: '2015-01-01', held_by: 'personal', household_ids: [HH_KIN] } as unknown as Property,
];

export const investments: Investment[] = [
  { id: 'a-cba', user_id: ADA, name: 'CBA', ticker: 'CBA.AX', asset_type: 'stock', units: 100, purchase_price: 90, current_price: 110, current_value: 11_000, cost_basis: 9_000, currency: 'AUD', market: 'ASX', acquired_date: '2023-02-01', household_ids: [] } as unknown as Investment,
  { id: 'b-vas', user_id: BO, name: 'VAS', ticker: 'VAS.AX', asset_type: 'etf', units: 200, purchase_price: 85, current_price: 95, current_value: 19_000, cost_basis: 17_000, currency: 'AUD', market: 'ASX', acquired_date: '2022-05-01', household_ids: [HH_COAST] } as unknown as Investment,
  { id: 'c-btc', user_id: CY, name: 'Bitcoin', ticker: 'BTC-AUD', asset_type: 'crypto', units: 0.5, purchase_price: 40_000, current_price: 90_000, current_value: 45_000, cost_basis: 20_000, currency: 'AUD', market: 'CRYPTO', acquired_date: '2021-01-01', household_ids: [] } as unknown as Investment,
  { id: 'd-aapl', user_id: DI, name: 'Apple', ticker: 'AAPL', asset_type: 'stock', units: 20, purchase_price: 150, current_price: 200, current_value: 4_000, cost_basis: 3_000, currency: 'USD', market: 'NASDAQ', acquired_date: '2024-04-01', display_value: 6_000, conversion_rate: 1.5, household_ids: [HH_KIN] } as unknown as Investment,
];

export const superFunds: SuperFund[] = [
  { id: 's-ada', user_id: ADA, fund_name: 'AustralianSuper', member_number: 'A1', balance: 220_000, counted_in_net_worth: true } as unknown as SuperFund,
  { id: 's-bo', user_id: BO, fund_name: 'Hostplus', member_number: 'B1', balance: 90_000, counted_in_net_worth: true } as unknown as SuperFund,
  { id: 's-cy', user_id: CY, fund_name: 'Rest', member_number: 'C1', balance: 60_000, counted_in_net_worth: false } as unknown as SuperFund,
];

// ── Plans, obligations, paperwork ────────────────────────────────────────────

export const goals: Goal[] = [
  { id: 'a-goal', user_id: ADA, name: 'Roof', target_amount: 30_000, current_amount: 12_000, target_date: '2027-06-30', household_ids: [HH_RIVER] } as unknown as Goal,
  { id: 'b-goal', user_id: BO, name: 'Bo Emergency', target_amount: 15_000, current_amount: 5_000, target_date: '2027-01-31', household_ids: [] } as unknown as Goal,
  { id: 'c-goal', user_id: CY, name: 'Farm Fence', target_amount: 20_000, current_amount: 3_000, target_date: '2027-03-31', household_ids: [HH_KIN] } as unknown as Goal,
  { id: 'd-goal', user_id: DI, name: 'Coast Trip', target_amount: 6_000, current_amount: 1_200, target_date: '2026-12-01', household_ids: [HH_COAST] } as unknown as Goal,
];

export const goalContributions: GoalContribution[] = [
  { id: 'gc-a', user_id: ADA, goal_id: 'a-goal', amount: 2_000, date: '2026-08-01' } as unknown as GoalContribution,
  { id: 'gc-d', user_id: DI, goal_id: 'd-goal', amount: 200, date: '2026-08-02' } as unknown as GoalContribution,
];

export const budgets: Budget[] = [
  { id: 'a-budget', user_id: ADA, scope: 'category', category: 'groceries', limit_amount: 1_200, period: 'monthly', rollover_enabled: true, start_month: '2026-01', active: true, household_ids: [HH_RIVER] } as unknown as Budget,
  { id: 'b-budget', user_id: BO, scope: 'category', category: 'dining', limit_amount: 400, period: 'monthly', rollover_enabled: false, start_month: '2026-01', active: true, household_ids: [] } as unknown as Budget,
  { id: 'd-budget', user_id: DI, scope: 'overall', category: null, limit_amount: 3_000, period: 'monthly', rollover_enabled: false, start_month: '2026-01', active: true, household_ids: [HH_COAST] } as unknown as Budget,
];

export const bills: Bill[] = [
  { id: 'a-bill', user_id: ADA, name: 'Council Rates', amount: 640, due_date: '2026-09-20', frequency: 'quarterly', is_recurring: true, category: 'utilities', is_paid: false, kind: 'bill', household_ids: [HH_RIVER] } as unknown as Bill,
  { id: 'b-bill', user_id: BO, name: 'Bo Phone', amount: 55, due_date: '2026-09-05', frequency: 'monthly', is_recurring: true, category: 'utilities', is_paid: false, kind: 'bill', household_ids: [] } as unknown as Bill,
];

export const incomeEntries: IncomeEntry[] = [
  { id: 'a-income', user_id: ADA, source: 'Salary', amount: 9_000, frequency: 'monthly', type: 'salary', currency: 'AUD', is_recurring: true, date: '2026-08-01', next_date: '2026-09-01', household_ids: [HH_RIVER] } as unknown as IncomeEntry,
  { id: 'b-income', user_id: BO, source: 'Consulting', amount: 4_000, frequency: 'monthly', type: 'business', currency: 'AUD', is_recurring: true, date: '2026-08-01', next_date: '2026-09-01', household_ids: [] } as unknown as IncomeEntry,
];

export const insurancePolicies: InsurancePolicy[] = [
  { id: 'a-policy', user_id: ADA, policy_type: 'home', provider: 'AAMI', policy_number: 'H-1', premium_amount: 1_800, premium_frequency: 'annually', renewal_date: '2027-02-01', status: 'active', linked_type: 'property', linked_id: 'a-house', sum_insured: 900_000 } as unknown as InsurancePolicy,
  { id: 'b-policy', user_id: BO, policy_type: 'car', provider: 'Budget Direct', policy_number: 'C-1', premium_amount: 900, premium_frequency: 'annually', renewal_date: '2027-04-01', status: 'active', sum_insured: 30_000 } as unknown as InsurancePolicy,
];

export const documents: LedgerDocument[] = [
  { id: 'a-doc', user_id: ADA, name: 'Rates notice.pdf', document_type: 'statement', provider: 'Council', document_date: '2026-08-01', linked_type: null, linked_id: null, household_ids: [HH_RIVER], shared_household_ids: [HH_RIVER], extraction_status: 'unread' } as unknown as LedgerDocument,
  { id: 'b-doc', user_id: BO, name: 'Bo payslip.pdf', document_type: 'payslip', provider: 'Employer', document_date: '2026-08-01', linked_type: null, linked_id: null, household_ids: [], shared_household_ids: [], extraction_status: 'unread' } as unknown as LedgerDocument,
  { id: 'c-doc', user_id: CY, name: 'Farm valuation.pdf', document_type: 'other', provider: 'Valuer', document_date: '2026-07-01', linked_type: 'property', linked_id: 'c-farm', household_ids: [HH_KIN], shared_household_ids: [], extraction_status: 'unread' } as unknown as LedgerDocument,
];

// ── Direct grants ────────────────────────────────────────────────────────────

export const recordShares: RecordShare[] = [
  { id: 'sh-1', record_type: 'account', record_id: 'a-saver', owner_user_id: ADA, shared_with_user_id: CY, permission: 'view', status: 'active' } as unknown as RecordShare,
  { id: 'sh-2', record_type: 'account', record_id: 'a-usd', owner_user_id: ADA, shared_with_user_id: DI, permission: 'edit', status: 'active' } as unknown as RecordShare,
  { id: 'sh-3', record_type: 'account', record_id: 'b-private', owner_user_id: BO, shared_with_user_id: ADA, permission: 'edit', status: 'active' } as unknown as RecordShare,
  // Already ended — must grant nothing at any point.
  { id: 'sh-4', record_type: 'account', record_id: 'c-private', owner_user_id: CY, shared_with_user_id: ADA, permission: 'view', status: 'revoked' } as unknown as RecordShare,
];

// ── What the server would send each user ─────────────────────────────────────
//
// Written from the product rules, not from the client engine, so the client
// engine can be checked against it rather than agreeing with itself.

export function visibleTo(userId: string) {
  const mine = new Set(members.filter(m => m.user_id === userId && m.status === 'active').map(m => m.household_id));
  const grants = recordShares.filter(g => g.status === 'active' && g.shared_with_user_id === userId);
  const grantedIds = new Set(grants.map(g => g.record_id));

  const keep = <T extends { id: string; user_id?: string; household_ids?: string[] }>(rows: T[]): T[] =>
    rows.filter(r => r.user_id === userId
      || (r.household_ids ?? []).some(h => mine.has(h))
      || grantedIds.has(r.id));

  // An account brings what happened on it, however it was shared.
  const carriers = new Set<string>([
    ...accounts.filter(a => (a.household_ids ?? []).some(h => mine.has(h))).map(a => a.id),
    ...creditCards.filter(c => (c.household_ids ?? []).some(h => mine.has(h))).map(c => c.id),
    ...grantedIds,
  ]);
  const keepTx = (rows: Transaction[]): Transaction[] =>
    rows.filter(t => t.user_id === userId
      || (t.household_ids ?? []).some(h => mine.has(h))
      || (!!t.account_id && carriers.has(t.account_id)));

  const own = <T extends { user_id?: string }>(rows: T[]): T[] => rows.filter(r => r.user_id === userId);

  const visibleGoals = keep(goals);
  const visibleProps = keep(properties);
  const visibleAccounts = keep(accounts);

  return {
    accounts: visibleAccounts,
    creditCards: keep(creditCards),
    transactions: keepTx(transactions),
    loans: keep(loans),
    properties: visibleProps,
    budgets: keep(budgets),
    goals: visibleGoals,
    bills: keep(bills),
    investments: keep(investments),
    incomeEntries: keep(incomeEntries),
    // A policy FOLLOWS what it covers — the server's linked-visibility rule.
    insurancePolicies: insurancePolicies.filter(p => p.user_id === userId
      || ((p as unknown as { linked_type?: string; linked_id?: string }).linked_type === 'property'
          && visibleProps.some(x => x.id === (p as unknown as { linked_id?: string }).linked_id))),
    goalContributions: goalContributions.filter(c => c.user_id === userId || visibleGoals.some(g => g.id === c.goal_id)),
    // A document follows what it is filed against, as well as its own shares.
    documents: documents.filter(d => d.user_id === userId
      || (d.household_ids ?? []).some(h => mine.has(h))
      || (d.linked_type === 'property' && visibleProps.some(p => p.id === d.linked_id))
      || (d.linked_type === 'account' && visibleAccounts.some(a => a.id === d.linked_id))),
    superFunds: own(superFunds),
    recordShares: recordShares.filter(g => g.owner_user_id === userId || g.shared_with_user_id === userId),
  };
}

/** Every row this user OWNS — the only thing that may enter their totals. */
export function ownedBy(userId: string) {
  const own = <T extends { user_id?: string }>(rows: T[]): T[] => rows.filter(r => r.user_id === userId);
  return {
    accounts: own(accounts), creditCards: own(creditCards), loans: own(loans),
    properties: own(properties), investments: own(investments), superFunds: own(superFunds),
    goals: own(goals), budgets: own(budgets), bills: own(bills),
  };
}
