/**
 * PRE-MARKET STRESS TEST — the synthetic world.
 *
 * Four users, three overlapping households, one direct-share graph, and a
 * deliberately awkward set of money: negative balances, a $1 account, a $40m
 * account, duplicate names, foreign currency, future-dated and decade-old rows,
 * expired policies, deleted linked records, split transactions, refunds,
 * transfers and credit-card repayments.
 *
 * NOTHING HERE TOUCHES A REAL USER. Every id is `u-`/`hh-` prefixed and every
 * row is invented. The store is seeded in-process; the sync layer is mocked by
 * each test file before this module is imported.
 *
 *   Mara   (u-mara)  high earner. Home + investment property, SMSF, shares,
 *                    offset, redraw, big Amex. In HH_HOME and HH_INV.
 *   Dev    (u-dev)   Mara's partner. HECS, card debt, thin assets.
 *                    In HH_HOME (member) and HH_FAM (owner).
 *   Nina   (u-nina)  sole trader, USD income, negative balance.
 *                    In HH_INV (member) and HH_FAM (viewer).
 *   Theo   (u-theo)  retired. In HH_HOME (viewer) and HH_FAM (member).
 */

import type {
  BankAccount, CreditCard, Transaction, Loan, LoanEvent, Property, Budget, Goal,
  GoalContribution, Bill, Subscription, Investment, InvestmentSale, SuperFund, SmsfFund,
  IncomeEntry, Household, HouseholdMember, InsurancePolicy, InsurancePremiumRecord,
  LedgerDocument, RecordShare, TransactionSplit, RecurringSeries,
  CreditCardStatement, PendingPayment,
} from '../types';

// ── Identities ───────────────────────────────────────────────────────────────
export const MARA = 'u-mara';
export const DEV = 'u-dev';
export const NINA = 'u-nina';
export const THEO = 'u-theo';

export const HH_HOME = 'hh-home';   // Mara(owner) Dev(member) Theo(viewer)
export const HH_INV = 'hh-inv';     // Mara(owner) Nina(member)
export const HH_FAM = 'hh-fam';     // Dev(owner) Theo(member) Nina(viewer)

/** The clock every dated figure in this world is written against. */
export const TODAY = '2026-08-25';
export const MONTH = '2026-08';

export const USERS: Record<string, { id: string; email: string; name: string }> = {
  [MARA]: { id: MARA, email: 'mara@example.test', name: 'Mara Quinn' },
  [DEV]: { id: DEV, email: 'dev@example.test', name: 'Dev Patel' },
  [NINA]: { id: NINA, email: 'nina@example.test', name: 'Nina Okoro' },
  [THEO]: { id: THEO, email: 'theo@example.test', name: 'Theo Blake' },
};

export const households: Household[] = [
  { id: HH_HOME, name: 'Quinn–Patel Home', created_by: MARA, currency: 'AUD' },
  { id: HH_INV, name: 'Coastal Investment Group', created_by: MARA, currency: 'AUD' },
  { id: HH_FAM, name: 'Patel Family', created_by: DEV, currency: 'AUD' },
];

const mem = (
  household_id: string, user_id: string, role: HouseholdMember['role'],
  status: HouseholdMember['status'] = 'active',
): HouseholdMember => ({
  id: `m-${household_id}-${user_id}`, household_id, user_id, role, status,
  email: USERS[user_id]?.email ?? null, name: USERS[user_id]?.name ?? null,
});

export const members: HouseholdMember[] = [
  mem(HH_HOME, MARA, 'owner'), mem(HH_HOME, DEV, 'member'), mem(HH_HOME, THEO, 'viewer'),
  mem(HH_INV, MARA, 'owner'), mem(HH_INV, NINA, 'member'),
  mem(HH_FAM, DEV, 'owner'), mem(HH_FAM, THEO, 'member'), mem(HH_FAM, NINA, 'viewer'),
  // A removed member — must grant nothing, anywhere.
  mem(HH_INV, THEO, 'member', 'removed'),
];

// ── Bank accounts ────────────────────────────────────────────────────────────
const acc = (o: Partial<BankAccount> & Pick<BankAccount, 'id' | 'user_id' | 'name' | 'balance'>): BankAccount => ({
  institution: 'CBA', account_type: 'transaction', currency: 'AUD', is_manual: true,
  household_ids: [], ...o,
} as BankAccount);

export const accounts: BankAccount[] = [
  // Mara
  acc({ id: 'acc-joint', user_id: MARA, name: 'Joint Everyday', balance: 24_500, household_ids: [HH_HOME] }),
  acc({ id: 'acc-offset', user_id: MARA, name: 'Offset', balance: 150_000, household_ids: [HH_HOME], account_type: 'savings' }),
  acc({ id: 'acc-mara-saver', user_id: MARA, name: 'Private Saver', balance: 88_000, account_type: 'savings' }),
  acc({
    id: 'acc-mara-usd', user_id: MARA, name: 'US Brokerage Cash', balance: 12_000,
    currency: 'USD', display_balance: 18_240, display_currency: 'AUD', conversion_rate: 1.52,
    institution: 'Interactive Brokers',
  }),
  acc({ id: 'acc-hidden', user_id: MARA, name: 'Closed 2019 account', balance: 999_999, hidden: true }),
  acc({ id: 'acc-inv-prop', user_id: MARA, name: 'Coastal rent account', balance: 4_200, household_ids: [HH_INV] }),
  // Duplicate NAME, different row — a name collision must never become an identity collision.
  acc({ id: 'acc-joint-2', user_id: MARA, name: 'Joint Everyday', balance: 1, institution: 'ING' }),
  // Dev
  acc({ id: 'acc-dev-everyday', user_id: DEV, name: 'Everyday', balance: 640.55, household_ids: [HH_HOME, HH_FAM] }),
  acc({ id: 'acc-dev-overdrawn', user_id: DEV, name: 'Overdrawn', balance: -1_820.40 }),
  // Nina
  acc({ id: 'acc-nina-biz', user_id: NINA, name: 'Business account', balance: 32_100, household_ids: [HH_INV] }),
  acc({ id: 'acc-nina-zero', user_id: NINA, name: 'Empty', balance: 0 }),
  // Theo — a very large legacy balance to test formatting/precision
  acc({ id: 'acc-theo-est', user_id: THEO, name: 'Estate account', balance: 41_250_000.37, household_ids: [HH_FAM] }),
];

// ── Credit cards ─────────────────────────────────────────────────────────────
const card = (o: Partial<CreditCard> & Pick<CreditCard, 'id' | 'user_id' | 'name' | 'balance_owing'>): CreditCard => ({
  institution: 'Amex', credit_limit: 10_000, currency: 'AUD', is_manual: true, household_ids: [], ...o,
} as CreditCard);

export const creditCards: CreditCard[] = [
  card({ id: 'cc-mara-amex', user_id: MARA, name: 'Amex Platinum', balance_owing: 8_412.90, credit_limit: 30_000, household_ids: [HH_HOME], minimum_payment: 260, due_date: '2026-09-05' }),
  card({ id: 'cc-mara-zero', user_id: MARA, name: 'Backup Visa', balance_owing: 0, credit_limit: 5_000 }),
  card({ id: 'cc-dev-visa', user_id: DEV, name: 'Everyday Visa', balance_owing: 6_930.10, credit_limit: 7_000, household_ids: [HH_FAM], minimum_payment: 210, due_date: '2026-08-28' }),
  // Over-limit / credit-balance edge cases.
  card({ id: 'cc-nina-biz', user_id: NINA, name: 'Business card', balance_owing: -430.25, credit_limit: 15_000 }),
  card({ id: 'cc-theo-old', user_id: THEO, name: 'Old card', balance_owing: 12_500, credit_limit: 10_000 }),
];

// ── Loans ────────────────────────────────────────────────────────────────────
const loan = (o: Partial<Loan> & Pick<Loan, 'id' | 'user_id' | 'name' | 'current_balance'>): Loan => ({
  loan_type: 'mortgage', original_amount: 900_000, interest_rate: 6.04,
  minimum_repayment: 4_800, repayment_frequency: 'monthly', next_due_date: '2026-09-01',
  include_in_net_worth: true, household_ids: [], start_date: '2019-03-01', term_months: 360,
  ...o,
} as Loan);

export const loans: Loan[] = [
  loan({
    id: 'loan-home', user_id: MARA, name: 'Home mortgage', current_balance: 780_400,
    household_ids: [HH_HOME], offset_account_id: 'acc-offset', redraw_available: 42_000,
    extra_repayment: 500, rate_type: 'variable',
  }),
  loan({
    id: 'loan-inv', user_id: MARA, name: 'Coastal investment loan', current_balance: 520_000,
    household_ids: [HH_INV], interest_rate: 6.34, interest_only_until: '2027-06-30',
    minimum_repayment: 2_747, original_amount: 520_000, rate_type: 'fixed',
    fixed_until: '2027-06-30', revert_rate: 6.9,
  }),
  loan({
    id: 'loan-dev-hecs', user_id: DEV, name: 'HECS-HELP', loan_type: 'hecs',
    current_balance: 41_200, original_amount: 58_000, interest_rate: null as unknown as number,
    minimum_repayment: 0, repayment_frequency: 'fortnightly',
  }),
  loan({
    id: 'loan-dev-car', user_id: DEV, name: 'Car loan', loan_type: 'car',
    current_balance: 18_400, original_amount: 32_000, interest_rate: 9.45,
    minimum_repayment: 640, household_ids: [HH_FAM], term_months: 60, start_date: '2024-02-01',
  }),
  // Opted OUT of net worth — the property must net it instead.
  loan({
    id: 'loan-nina-biz', user_id: NINA, name: 'Business loan', loan_type: 'personal',
    current_balance: 96_000, original_amount: 120_000, interest_rate: 11.2,
    include_in_net_worth: false, minimum_repayment: 1_100,
  }),
  // Fully repaid, still on file.
  loan({ id: 'loan-theo-done', user_id: THEO, name: 'Paid off', current_balance: 0, original_amount: 250_000, minimum_repayment: 0 }),
];

export const loanEvents: LoanEvent[] = [
  { id: 'le-1', user_id: MARA, loan_id: 'loan-home', kind: 'repayment', amount: 4_800, date: '2026-08-01' },
  { id: 'le-2', user_id: MARA, loan_id: 'loan-home', kind: 'extra_repayment', amount: 10_000, date: '2026-07-15' },
  { id: 'le-3', user_id: MARA, loan_id: 'loan-home', kind: 'redraw', amount: 3_000, date: '2026-08-10' },
  { id: 'le-4', user_id: MARA, loan_id: 'loan-home', kind: 'rate_change', amount: 0, rate: 6.29, date: '2026-11-01' },
  { id: 'le-5', user_id: DEV, loan_id: 'loan-dev-car', kind: 'repayment', amount: 640, date: '2026-08-05' },
  // An event pointing at a loan that no longer exists.
  { id: 'le-orphan', user_id: DEV, loan_id: 'loan-deleted', kind: 'repayment', amount: 900, date: '2026-08-05' },
];

// ── Super / SMSF ─────────────────────────────────────────────────────────────
/** Self-managed funds. A real slice now — a property held in one defers to it
 *  only if the fund is actually there, so a fixture that names an SMSF has to
 *  BE one. `balance` is the fund's assets summed, as the API returns them. */
export const smsfFunds: SmsfFund[] = [
  {
    id: 'smsf-mara', user_id: MARA, name: 'Quinn Family SMSF', balance: 1_640_000,
    include_in_net_worth: true,
  },
];

export const superFunds: SuperFund[] = [
  {
    id: 'super-mara', user_id: MARA, fund_name: 'Australian Super', balance: 412_800,
    employer_contributions: 24_000, personal_contributions: 15_000,
    include_in_investments: true, include_in_net_worth: true,
  },
  {
    id: 'super-dev', user_id: DEV, fund_name: 'Hostplus', balance: 88_400,
    employer_contributions: 9_800, personal_contributions: 0,
    include_in_investments: true, include_in_net_worth: true,
  },
  // Opted OUT of net worth.
  {
    id: 'super-theo', user_id: THEO, fund_name: 'Legacy fund', balance: 260_000,
    employer_contributions: 0, personal_contributions: 0,
    include_in_investments: false, include_in_net_worth: false,
  },
];

// ── Properties ───────────────────────────────────────────────────────────────
const prop = (o: Partial<Property> & Pick<Property, 'id' | 'user_id' | 'current_value'>): Property => ({
  name: null, address_unit: null, address_street: '1 Test St', address_suburb: 'Bondi',
  address_state: 'NSW', address_postcode: '2026', address_country: 'Australia',
  property_type: 'home', held_by: 'personal', purchase_price: 800_000,
  ownership_percent: 100, include_in_net_worth: true, household_ids: [], loan_id: null,
  ...o,
} as Property);

export const properties: Property[] = [
  prop({
    id: 'prop-home', user_id: MARA, name: 'Home', current_value: 1_850_000,
    purchase_price: 1_100_000, purchase_date: '2019-03-01', loan_id: 'loan-home',
    household_ids: [HH_HOME], property_type: 'home',
  }),
  prop({
    id: 'prop-inv', user_id: MARA, name: 'Coastal unit', current_value: 920_000,
    purchase_price: 610_000, purchase_date: '2021-09-15', loan_id: 'loan-inv',
    ownership_percent: 50, property_type: 'investment', household_ids: [HH_INV],
    address_street: '12 Ocean Pde', address_suburb: 'Coolangatta', address_state: 'QLD', address_postcode: '4225',
    rent_match_terms: ['Coastal Realty'], rent_account_id: 'acc-inv-prop',
    expected_rent_amount: 780, expected_rent_frequency: 'weekly',
    match_account_ids: ['acc-inv-prop'],
    property_expenses: [
      { id: 'pe-1', name: 'Strata', kind: 'strata', expected_amount: 1_150, frequency: 'quarterly', match_terms: ['Ocean Strata'] },
      { id: 'pe-2', name: 'Council rates', kind: 'council', expected_amount: 620, frequency: 'quarterly', match_terms: ['Gold Coast City'] },
    ],
  }),
  // Held in the SMSF whose balance already carries it.
  prop({
    id: 'prop-smsf', user_id: MARA, name: 'Warehouse', current_value: 1_200_000,
    purchase_price: 900_000, held_by: 'smsf', smsf_fund_id: 'smsf-mara',
    counted_in_fund_balance: true, property_type: 'commercial',
  }),
  // Mortgaged by a loan opted OUT of net worth — the property nets it.
  prop({
    id: 'prop-nina', user_id: NINA, name: 'Shopfront', current_value: 430_000,
    purchase_price: 380_000, loan_id: 'loan-nina-biz', property_type: 'commercial',
    household_ids: [HH_INV],
  }),
  // Excluded from net worth entirely.
  prop({
    id: 'prop-theo', user_id: THEO, name: 'Farm', current_value: 2_400_000,
    purchase_price: 300_000, include_in_net_worth: false, property_type: 'land',
  }),
  // Points at a loan row that does not exist.
  prop({
    id: 'prop-dev-orphan', user_id: DEV, name: 'Old flat', current_value: 505_000,
    purchase_price: 505_000, loan_id: 'loan-deleted', household_ids: [HH_FAM],
  }),
];

// ── Investments ──────────────────────────────────────────────────────────────
const inv = (o: Partial<Investment> & Pick<Investment, 'id' | 'user_id' | 'name' | 'current_value'>): Investment => ({
  market: 'ASX', asset_type: 'etf', shares_owned: 100, cost_basis: 0, current_price: 0,
  currency: 'AUD', native_currency: 'AUD', is_dividend_paying: true, household_ids: [],
  ...o,
} as Investment);

export const investments: Investment[] = [
  inv({ id: 'inv-vas', user_id: MARA, name: 'Vanguard Australian Shares', ticker: 'VAS', shares_owned: 1_400, cost_basis: 112_000, current_price: 101.4, current_value: 141_960 }),
  inv({ id: 'inv-cba', user_id: MARA, name: 'Commonwealth Bank', ticker: 'CBA', asset_type: 'stock', shares_owned: 300, cost_basis: 28_500, current_price: 178.2, current_value: 53_460 }),
  inv({
    id: 'inv-vts', user_id: MARA, name: 'Vanguard Total US', ticker: 'VTS', market: 'NYSE',
    shares_owned: 400, cost_basis: 60_000, cost_basis_currency: 'USD', current_price: 310.5,
    current_value: 124_200, currency: 'USD', native_currency: 'USD',
    display_value: 188_784, display_cost: 91_200, display_currency: 'AUD', conversion_rate: 1.52,
  }),
  inv({ id: 'inv-btc', user_id: MARA, name: 'Bitcoin', ticker: 'BTC', asset_type: 'crypto', market: 'CRYPTO', shares_owned: 0.85, cost_basis: 42_000, current_price: 148_000, current_value: 125_800, is_dividend_paying: false }),
  inv({ id: 'inv-gold', user_id: MARA, name: 'Gold bullion', asset_type: 'precious_metal', market: 'METAL', shares_owned: 500, metal_unit: 'grams', cost_basis: 38_000, current_price: 158, current_value: 79_000, is_dividend_paying: false }),
  // Zero-price / unpriced private holding.
  inv({ id: 'inv-private', user_id: MARA, name: 'Startup equity', asset_type: 'private', market: 'PRIVATE', shares_owned: 10_000, cost_basis: 50_000, current_price: 0, current_value: 0, is_dividend_paying: false }),
  inv({ id: 'inv-dev-etf', user_id: DEV, name: 'Betashares A200', ticker: 'A200', shares_owned: 210, cost_basis: 25_000, current_price: 141.1, current_value: 29_631 }),
  inv({ id: 'inv-nina-eth', user_id: NINA, name: 'Ethereum', ticker: 'ETH', asset_type: 'crypto', market: 'CRYPTO', shares_owned: 12, cost_basis: 61_000, current_price: 4_120, current_value: 49_440, is_dividend_paying: false }),
];

export const investmentSales: InvestmentSale[] = [
  // Long-held → 50% discount eligible.
  {
    id: 'sale-vas', user_id: MARA, investment_id: 'inv-vas', name: 'Vanguard Australian Shares',
    ticker: 'VAS', asset_type: 'etf', market: 'ASX', quantity: 200, proceeds: 20_280, fees: 19.95,
    cost_basis: 14_000, acquired_date: '2021-02-10', sale_date: '2026-03-04',
    gain: 6_260.05, held_days: 1_848, discount_eligible: true, currency: 'AUD',
  },
  // Held < 12 months → no discount.
  {
    id: 'sale-btc', user_id: MARA, investment_id: 'inv-btc', name: 'Bitcoin', ticker: 'BTC',
    asset_type: 'crypto', market: 'CRYPTO', quantity: 0.15, proceeds: 22_200, fees: 60,
    cost_basis: 9_600, acquired_date: '2025-11-20', sale_date: '2026-05-18',
    gain: 12_540, held_days: 179, discount_eligible: false, currency: 'AUD',
  },
  // A realised LOSS.
  {
    id: 'sale-dev', user_id: DEV, investment_id: 'inv-dev-etf', name: 'Betashares A200',
    ticker: 'A200', asset_type: 'etf', market: 'ASX', quantity: 40, proceeds: 4_900, fees: 9.5,
    cost_basis: 6_400, acquired_date: '2024-08-01', sale_date: '2026-02-02',
    gain: -1_509.5, held_days: 550, discount_eligible: true, currency: 'AUD',
  },
  // Sale of an investment row that has since been deleted.
  {
    id: 'sale-orphan', user_id: MARA, investment_id: 'inv-deleted', name: 'Delisted Co',
    ticker: 'DEL', asset_type: 'stock', market: 'ASX', quantity: 1_000, proceeds: 0, fees: 0,
    cost_basis: 12_000, acquired_date: '2018-05-01', sale_date: '2026-06-30',
    gain: -12_000, held_days: 2_982, discount_eligible: true, currency: 'AUD',
  },
];

// ── Income ───────────────────────────────────────────────────────────────────
const income = (o: Partial<IncomeEntry> & Pick<IncomeEntry, 'id' | 'user_id' | 'source' | 'amount' | 'date'>): IncomeEntry => ({
  currency: 'AUD', category: 'Salary', is_recurring: true, frequency: 'fortnightly',
  status: 'approved', household_ids: [], ...o,
} as IncomeEntry);

export const incomeEntries: IncomeEntry[] = [
  income({ id: 'inc-mara-pay', user_id: MARA, source: 'Aurora Health — salary', amount: 7_400, date: '2026-08-14', tax_withheld: 2_540, super_contribution: 851 }),
  income({ id: 'inc-mara-rent', user_id: MARA, source: 'Coastal Realty — rent', amount: 780, date: '2026-08-21', category: 'Rental', frequency: 'weekly', household_ids: [HH_INV] }),
  income({ id: 'inc-mara-div', user_id: MARA, source: 'VAS distribution', amount: 1_820, date: '2026-07-15', category: 'Dividends', frequency: 'quarterly' }),
  income({ id: 'inc-dev-pay', user_id: DEV, source: 'Northbridge Council — wage', amount: 2_950, date: '2026-08-14', tax_withheld: 620, super_contribution: 339 }),
  income({ id: 'inc-nina-usd', user_id: NINA, source: 'US client retainer', amount: 6_000, currency: 'USD', display_amount: 9_120, display_currency: 'AUD', conversion_rate: 1.52, date: '2026-08-01', category: 'Freelance/Contractor', frequency: 'monthly' }),
  income({ id: 'inc-nina-pending', user_id: NINA, source: 'Unconfirmed invoice', amount: 4_200, date: '2026-09-10', status: 'pending', category: 'Freelance/Contractor', frequency: 'monthly' }),
  income({ id: 'inc-theo-pension', user_id: THEO, source: 'Age pension', amount: 1_100, date: '2026-08-20', category: 'Government Payments' }),
  // Ten-year-old row.
  income({ id: 'inc-old', user_id: MARA, source: 'Old job', amount: 3_100, date: '2016-06-30', is_recurring: false }),
];

// ── Transactions ─────────────────────────────────────────────────────────────
const tx = (o: Partial<Transaction> & Pick<Transaction, 'id' | 'user_id' | 'account_id' | 'date' | 'merchant' | 'amount'>): Transaction => ({
  account_type: 'bank', currency: 'AUD', category: 'Groceries',
  is_duplicate_flagged: false, is_subscription: false, household_ids: [], ...o,
} as Transaction);

/** A month of ordinary groceries/dining on an account, for budget + insight windows. */
function routine(prefix: string, userId: string, accountId: string, households: string[], months: string[]): Transaction[] {
  const out: Transaction[] = [];
  const merchants: [string, string, number][] = [
    ['Woolworths', 'Groceries', -186.4], ['Coles', 'Groceries', -142.15],
    ['Uber Eats', 'Dining', -58.9], ['Shell', 'Fuel', -92.3],
    ['Netflix', 'Entertainment', -22.99], ['Opal', 'Transport', -47.5],
  ];
  months.forEach((m, mi) => {
    merchants.forEach(([merchant, category, amount], i) => {
      const day = String(3 + i * 4).padStart(2, '0');
      out.push(tx({
        id: `${prefix}-${mi}-${i}`, user_id: userId, account_id: accountId,
        date: `${m}-${day}`, merchant, amount: amount * (1 + mi * 0.04),
        category, household_ids: households, is_subscription: merchant === 'Netflix',
      }));
    });
  });
  return out;
}

export const transactions: Transaction[] = [
  ...routine('mara', MARA, 'acc-joint', [HH_HOME], ['2026-06', '2026-07', '2026-08']),
  ...routine('dev', DEV, 'acc-dev-everyday', [HH_HOME, HH_FAM], ['2026-06', '2026-07', '2026-08']),
  ...routine('nina', NINA, 'acc-nina-biz', [HH_INV], ['2026-06', '2026-07', '2026-08']),

  // Salary inflows (income class).
  tx({ id: 'tx-pay-1', user_id: MARA, account_id: 'acc-joint', date: '2026-08-14', merchant: 'Aurora Health', amount: 7_400, category: 'Income', transaction_type: 'income', household_ids: [HH_HOME] }),
  tx({ id: 'tx-pay-2', user_id: DEV, account_id: 'acc-dev-everyday', date: '2026-08-14', merchant: 'Northbridge Council', amount: 2_950, category: 'Income', transaction_type: 'income', household_ids: [HH_HOME, HH_FAM] }),

  // ── Internal transfer, both legs. Must never count as spend OR income.
  tx({ id: 'tx-tfr-out', user_id: MARA, account_id: 'acc-joint', date: '2026-08-05', merchant: 'Transfer to Offset', amount: -5_000, category: 'Transfers', transaction_type: 'transfer', is_transfer: true, transfer_pair_id: 'pair-1', household_ids: [HH_HOME] }),
  tx({ id: 'tx-tfr-in', user_id: MARA, account_id: 'acc-offset', date: '2026-08-05', merchant: 'Transfer from Everyday', amount: 5_000, category: 'Transfers', transaction_type: 'transfer', is_transfer: true, transfer_pair_id: 'pair-1', household_ids: [HH_HOME] }),

  // ── Credit-card repayment: bank leg + card leg. One debt movement, not two spends.
  tx({ id: 'tx-cc-pay-bank', user_id: MARA, account_id: 'acc-joint', date: '2026-08-08', merchant: 'AMEX PAYMENT RECEIVED', amount: -3_000, category: 'Credit Card', transaction_type: 'transfer', is_transfer: true, transfer_pair_id: 'pair-cc', household_ids: [HH_HOME] }),
  tx({ id: 'tx-cc-pay-card', user_id: MARA, account_id: 'cc-mara-amex', account_type: 'credit_card', date: '2026-08-08', merchant: 'PAYMENT THANK YOU', amount: 3_000, category: 'Credit Card', transaction_type: 'transfer', is_transfer: true, transfer_pair_id: 'pair-cc', household_ids: [HH_HOME] }),

  // ── A card repayment that was NEVER classified as a transfer (the common import shape).
  tx({ id: 'tx-cc-pay-raw', user_id: DEV, account_id: 'acc-dev-everyday', date: '2026-08-12', merchant: 'VISA PAYMENT', amount: -900, category: 'Credit Card', household_ids: [HH_FAM] }),

  // ── Refund reversing an earlier purchase.
  tx({ id: 'tx-buy-jb', user_id: MARA, account_id: 'cc-mara-amex', account_type: 'credit_card', date: '2026-08-02', merchant: 'JB Hi-Fi', amount: -1_299, category: 'Electronics', household_ids: [HH_HOME] }),
  tx({ id: 'tx-refund-jb', user_id: MARA, account_id: 'cc-mara-amex', account_type: 'credit_card', date: '2026-08-09', merchant: 'JB Hi-Fi', amount: 1_299, category: 'Electronics', transaction_type: 'refund', refund_of: 'tx-buy-jb', household_ids: [HH_HOME] }),
  // Partial refund with no matched original.
  tx({ id: 'tx-refund-orphan', user_id: DEV, account_id: 'acc-dev-everyday', date: '2026-08-15', merchant: 'Qantas', amount: 240, category: 'Travel', transaction_type: 'refund', household_ids: [HH_FAM] }),

  // ── Split transaction: one $600 shop across three categories.
  tx({ id: 'tx-split-parent', user_id: MARA, account_id: 'acc-joint', date: '2026-08-11', merchant: 'Costco', amount: -600, category: 'Groceries', household_ids: [HH_HOME] }),

  // ── Responsibility-split transaction (Phase 7.2) on a shared account.
  tx({
    id: 'tx-shared-dinner', user_id: MARA, account_id: 'acc-joint', date: '2026-08-16',
    merchant: 'Icebergs', amount: -420, category: 'Dining', household_ids: [HH_HOME],
    paid_by_user_id: MARA,
    responsibility_split: [{ user_id: MARA, amount: 280 }, { user_id: DEV, amount: 140 }],
  }),
  // Attributed wholly to the partner.
  tx({ id: 'tx-dev-attributed', user_id: MARA, account_id: 'acc-joint', date: '2026-08-18', merchant: 'Anytime Fitness', amount: -89, category: 'Fitness', household_ids: [HH_HOME], responsible_user_id: DEV }),

  // ── Investment property rent + expenses (Coastal).
  tx({ id: 'tx-rent-1', user_id: MARA, account_id: 'acc-inv-prop', date: '2026-07-04', merchant: 'Coastal Realty', amount: 3_120, category: 'Rental', transaction_type: 'income', household_ids: [HH_INV] }),
  tx({ id: 'tx-rent-2', user_id: MARA, account_id: 'acc-inv-prop', date: '2026-08-04', merchant: 'Coastal Realty', amount: 3_120, category: 'Rental', transaction_type: 'income', household_ids: [HH_INV] }),
  tx({ id: 'tx-strata', user_id: MARA, account_id: 'acc-inv-prop', date: '2026-07-20', merchant: 'Ocean Strata', amount: -1_150, category: 'Bills', is_tax_deductible: true, deduction_category: 'Rental', household_ids: [HH_INV] }),
  tx({ id: 'tx-council', user_id: MARA, account_id: 'acc-inv-prop', date: '2026-08-14', merchant: 'Gold Coast City', amount: -620, category: 'Bills', is_tax_deductible: true, deduction_category: 'Rental', household_ids: [HH_INV] }),
  tx({ id: 'tx-loan-interest', user_id: MARA, account_id: 'acc-inv-prop', date: '2026-08-01', merchant: 'Interest charged — Coastal loan', amount: -2_747, category: 'Interest', transaction_type: 'interest', is_tax_deductible: true, household_ids: [HH_INV] }),

  // ── Deductions (work-related).
  tx({ id: 'tx-ded-1', user_id: MARA, account_id: 'cc-mara-amex', account_type: 'credit_card', date: '2026-09-02', merchant: 'Officeworks', amount: -420, category: 'Electronics', is_tax_deductible: true, deduction_category: 'Work equipment', household_ids: [HH_HOME] }),
  tx({ id: 'tx-ded-2', user_id: NINA, account_id: 'acc-nina-biz', date: '2026-08-06', merchant: 'Adobe', amount: -89.99, category: 'Subscriptions', is_tax_deductible: true, deduction_category: 'Software', entity: 'business', household_ids: [HH_INV] }),

  // ── Awkward rows.
  // Future-dated.
  tx({ id: 'tx-future', user_id: MARA, account_id: 'acc-joint', date: '2027-01-15', merchant: 'Qantas', amount: -4_200, category: 'Travel', household_ids: [HH_HOME] }),
  // Decade-old.
  tx({ id: 'tx-ancient', user_id: MARA, account_id: 'acc-joint', date: '2015-04-02', merchant: 'Dick Smith', amount: -899, category: 'Electronics' }),
  // Zero amount.
  tx({ id: 'tx-zero', user_id: DEV, account_id: 'acc-dev-everyday', date: '2026-08-10', merchant: 'Bank fee waived', amount: 0, category: 'Fees' }),
  // Very large.
  tx({ id: 'tx-huge', user_id: THEO, account_id: 'acc-theo-est', date: '2026-08-03', merchant: 'Estate settlement', amount: -12_500_000, category: 'Other', household_ids: [HH_FAM] }),
  // Foreign currency.
  tx({ id: 'tx-usd', user_id: NINA, account_id: 'acc-nina-biz', date: '2026-08-07', merchant: 'AWS', amount: -412.6, currency: 'USD', display_amount: -627.15, display_currency: 'AUD', conversion_rate: 1.52, category: 'Subscriptions', household_ids: [HH_INV] }),
  // Duplicate content, different id — the identity engine's problem.
  tx({ id: 'tx-dupe-a', user_id: DEV, account_id: 'acc-dev-everyday', date: '2026-08-19', merchant: 'Bunnings', amount: -156.8, category: 'Home' }),
  tx({ id: 'tx-dupe-b', user_id: DEV, account_id: 'acc-dev-everyday', date: '2026-08-19', merchant: 'Bunnings', amount: -156.8, category: 'Home' }),
  // Points at an account that does not exist.
  tx({ id: 'tx-orphan-acct', user_id: DEV, account_id: 'acc-deleted', date: '2026-08-20', merchant: 'Ghost', amount: -50, category: 'Other' }),
  // Needs review.
  tx({ id: 'tx-review', user_id: MARA, account_id: 'acc-joint', date: '2026-08-21', merchant: 'SQ *UNKNOWN', amount: -310, category: 'Uncategorised', review_status: 'needs_review', review_reason: 'uncertain_merchant', confidence: 0.31, household_ids: [HH_HOME] }),
];

export const transactionSplits: TransactionSplit[] = [
  { id: 'sp-1', user_id: MARA, transaction_id: 'tx-split-parent', category: 'Groceries', amount: 380 },
  { id: 'sp-2', user_id: MARA, transaction_id: 'tx-split-parent', category: 'Home', amount: 150 },
  { id: 'sp-3', user_id: MARA, transaction_id: 'tx-split-parent', category: 'Health', amount: 70 },
];

// ── Bills & subscriptions ────────────────────────────────────────────────────
const bill = (o: Partial<Bill> & Pick<Bill, 'id' | 'user_id' | 'name' | 'amount' | 'due_date'>): Bill => ({
  is_recurring: true, frequency: 'monthly', colour: 'grey', is_paid: false,
  calendar_synced: false, household_ids: [], kind: 'bill', ...o,
} as Bill);

export const bills: Bill[] = [
  bill({ id: 'bill-power', user_id: MARA, name: 'Electricity', amount: 340, due_date: '2026-09-02', household_ids: [HH_HOME], category: 'Utilities', account_id: 'acc-joint', account_type: 'bank', responsible_user_id: DEV }),
  bill({ id: 'bill-water', user_id: MARA, name: 'Sydney Water', amount: 210, due_date: '2026-08-18', household_ids: [HH_HOME], category: 'Utilities' }),   // OVERDUE
  bill({ id: 'bill-strata', user_id: MARA, name: 'Ocean Strata', amount: 1_150, due_date: '2026-10-01', frequency: 'quarterly', household_ids: [HH_INV] }),
  bill({ id: 'bill-mortgage', user_id: MARA, name: 'Home mortgage repayment', amount: 4_800, due_date: '2026-09-01', household_ids: [HH_HOME], loan_id: 'loan-home' }),
  bill({ id: 'bill-netflix', user_id: MARA, name: 'Netflix', amount: 22.99, due_date: '2026-09-03', subscription_id: 'sub-netflix', household_ids: [HH_HOME] }),
  bill({ id: 'bill-dev-visa', user_id: DEV, name: 'Visa minimum', amount: 210, due_date: '2026-08-28', household_ids: [HH_FAM], account_id: 'cc-dev-visa', account_type: 'credit_card' }),
  bill({ id: 'bill-rego', user_id: DEV, name: 'Car rego', amount: 890, due_date: '2027-02-14', frequency: 'yearly', is_recurring: true }),
  // A reminder with no amount.
  bill({ id: 'bill-reminder', user_id: THEO, name: 'Call the accountant', amount: 0, due_date: '2026-09-09', kind: 'reminder', is_recurring: false }),
  // Already paid.
  bill({ id: 'bill-paid', user_id: NINA, name: 'Internet', amount: 89, due_date: '2026-08-05', is_paid: true, paid_at: '2026-08-05' }),
  // Duplicate name, different owner.
  bill({ id: 'bill-power-2', user_id: DEV, name: 'Electricity', amount: 118, due_date: '2026-09-02', household_ids: [HH_FAM] }),
];

export const subscriptions: Subscription[] = [
  { id: 'sub-netflix', user_id: MARA, name: 'Netflix', original_name: 'NETFLIX.COM', amount: 22.99, currency: 'AUD', frequency: 'monthly', next_charge_date: '2026-09-03', account_id: 'acc-joint', category: 'Entertainment', is_auto_detected: true },
  { id: 'sub-spotify', user_id: MARA, name: 'Spotify', original_name: 'SPOTIFY AB', amount: 16.99, currency: 'AUD', frequency: 'monthly', next_charge_date: '2026-09-07', account_id: 'acc-joint', category: 'Entertainment', is_auto_detected: true },
  { id: 'sub-adobe', user_id: NINA, name: 'Adobe CC', original_name: 'ADOBE', amount: 89.99, currency: 'AUD', frequency: 'monthly', next_charge_date: '2026-09-06', account_id: 'acc-nina-biz', category: 'Subscriptions', is_auto_detected: false },
  // Points at an account that is not visible to its owner's current scope.
  { id: 'sub-ghost', user_id: DEV, name: 'Old gym', original_name: 'GYM', amount: 79, currency: 'AUD', frequency: 'monthly', next_charge_date: '2026-09-01', account_id: 'acc-deleted', category: 'Fitness', is_auto_detected: true },
];

export const recurringSeries: RecurringSeries[] = [
  { id: 'rs-netflix', user_id: MARA, merchant_normalized: 'NETFLIX', name: 'Netflix', kind: 'subscription', frequency: 'monthly', expected_amount: 22.99, last_transaction_date: '2026-08-19', next_expected_date: '2026-09-19', account_id: 'acc-joint', status: 'active' },
  { id: 'rs-rent', user_id: MARA, merchant_normalized: 'COASTAL REALTY', name: 'Coastal Realty rent', kind: 'income', frequency: 'monthly', expected_amount: 3_120, last_transaction_date: '2026-08-04', next_expected_date: '2026-09-04', account_id: 'acc-inv-prop', status: 'active' },
];

// ── Budgets, goals ───────────────────────────────────────────────────────────
export const budgets: Budget[] = [
  { id: 'bud-groceries', user_id: MARA, scope: 'category', category: 'Groceries', limit_amount: 900, period: 'monthly', rollover_enabled: true, active: true, household_ids: [HH_HOME] },
  { id: 'bud-dining', user_id: MARA, scope: 'category', category: 'Dining', limit_amount: 300, period: 'monthly', rollover_enabled: false, active: true, household_ids: [HH_HOME] },
  { id: 'bud-overall', user_id: MARA, scope: 'overall', category: null, limit_amount: 6_000, period: 'monthly', rollover_enabled: false, active: true },
  { id: 'bud-dev-fuel', user_id: DEV, scope: 'category', category: 'Fuel', limit_amount: 200, period: 'monthly', rollover_enabled: false, active: true, household_ids: [HH_FAM] },
  // Zero-limit and retired budgets.
  { id: 'bud-zero', user_id: DEV, scope: 'category', category: 'Entertainment', limit_amount: 0, period: 'monthly', rollover_enabled: false, active: true },
  { id: 'bud-retired', user_id: NINA, scope: 'category', category: 'Travel', limit_amount: 500, period: 'monthly', rollover_enabled: false, active: false },
  // Duplicate category cap for the SAME user — should not be counted twice.
  { id: 'bud-groceries-dup', user_id: MARA, scope: 'category', category: 'groceries', limit_amount: 400, period: 'monthly', rollover_enabled: false, active: true },
];

export const goals: Goal[] = [
  { id: 'goal-house', user_id: MARA, name: 'Renovation fund', target_amount: 120_000, current_amount: 0, target_date: '2027-12-01', household_ids: [HH_HOME], linked_sources: [{ type: 'account', id: 'acc-offset', link_type: 'percent', link_value: 40 }] },
  { id: 'goal-holiday', user_id: DEV, name: 'Japan trip', target_amount: 9_000, current_amount: 2_400, target_date: '2026-11-01', household_ids: [HH_HOME] },
  // Target already met.
  { id: 'goal-met', user_id: NINA, name: 'Emergency buffer', target_amount: 20_000, current_amount: 32_100, target_date: '2026-01-01' },
  // Linked to a deleted account.
  { id: 'goal-broken', user_id: DEV, name: 'Broken link', target_amount: 5_000, current_amount: 0, linked_sources: [{ type: 'account', id: 'acc-deleted', link_type: 'percent', link_value: 100 }] },
  // Zero target.
  { id: 'goal-zero', user_id: THEO, name: 'Zero target', target_amount: 0, current_amount: 500 },
];

export const goalContributions: GoalContribution[] = [
  { id: 'gc-1', user_id: MARA, goal_id: 'goal-house', amount: 5_000, date: '2026-06-01', source_type: 'account', source_id: 'acc-offset' },
  { id: 'gc-2', user_id: MARA, goal_id: 'goal-house', amount: 3_000, date: '2026-07-01', source_type: null, source_id: null },
  { id: 'gc-3', user_id: DEV, goal_id: 'goal-holiday', amount: 2_400, date: '2026-05-20', source_type: null, source_id: null },
  { id: 'gc-4', user_id: DEV, goal_id: 'goal-holiday', amount: -400, date: '2026-08-01', source_type: null, source_id: null },
];

// ── Insurance ────────────────────────────────────────────────────────────────
const policy = (o: Partial<InsurancePolicy> & Pick<InsurancePolicy, 'id' | 'user_id' | 'name' | 'premium_amount'>): InsurancePolicy => ({
  policy_type: 'home', insurer: 'NRMA', policy_number: null, premium_frequency: 'annually',
  start_date: '2025-09-01', renewal_date: '2026-09-01', excess: 500, coverage_amount: null,
  linked_type: null, linked_id: null, document_id: null, notes: null, active: true,
  household_ids: [], ...o,
} as InsurancePolicy);

export const insurancePolicies: InsurancePolicy[] = [
  policy({ id: 'pol-home', user_id: MARA, name: 'Home & contents', premium_amount: 2_480, linked_type: 'property', linked_id: 'prop-home', coverage_amount: 1_900_000, household_ids: [HH_HOME], renewal_date: '2026-09-04' }),  // due soon
  policy({ id: 'pol-landlord', user_id: MARA, name: 'Landlord cover', premium_amount: 1_180, policy_type: 'landlord' as InsurancePolicy['policy_type'], linked_type: 'property', linked_id: 'prop-inv', household_ids: [HH_INV], renewal_date: '2027-02-01' }),
  policy({ id: 'pol-car', user_id: DEV, name: 'Car insurance', premium_amount: 148, premium_frequency: 'monthly', policy_type: 'car' as InsurancePolicy['policy_type'], linked_type: 'loan', linked_id: 'loan-dev-car', household_ids: [HH_FAM], renewal_date: '2026-12-01' }),
  // EXPIRED.
  policy({ id: 'pol-expired', user_id: NINA, name: 'Business liability', premium_amount: 960, policy_type: 'other' as InsurancePolicy['policy_type'], renewal_date: '2026-05-01' }),
  // Inactive but retained.
  policy({ id: 'pol-inactive', user_id: THEO, name: 'Old life cover', premium_amount: 300, active: false, policy_type: 'life' as InsurancePolicy['policy_type'], renewal_date: '2025-01-01' }),
  // Linked to a record that no longer exists.
  policy({ id: 'pol-orphan', user_id: DEV, name: 'Flat contents', premium_amount: 620, linked_type: 'property', linked_id: 'prop-deleted', renewal_date: '2026-11-11' }),
  // No renewal date at all.
  policy({ id: 'pol-nodate', user_id: MARA, name: 'Travel cover', premium_amount: 210, policy_type: 'travel' as InsurancePolicy['policy_type'], renewal_date: null, start_date: null }),
];

export const insurancePremiumHistory: InsurancePremiumRecord[] = [
  { id: 'ph-1', user_id: MARA, policy_id: 'pol-home', premium_amount: 1_980, premium_frequency: 'annually', effective_date: '2025-09-01', note: null },
  { id: 'ph-2', user_id: MARA, policy_id: 'pol-home', premium_amount: 2_480, premium_frequency: 'annually', effective_date: '2026-09-01', note: null },
  { id: 'ph-3', user_id: DEV, policy_id: 'pol-car', premium_amount: 132, premium_frequency: 'monthly', effective_date: '2025-12-01', note: null },
];

// ── Documents ────────────────────────────────────────────────────────────────
const doc = (o: Partial<LedgerDocument> & Pick<LedgerDocument, 'id' | 'user_id' | 'name'>): LedgerDocument => ({
  original_filename: `${o.name}.pdf`, mime_type: 'application/pdf', size_bytes: 214_000,
  document_type: 'statement', document_date: '2026-08-01', provider: null, notes: null,
  linked_type: null, linked_id: null, household_ids: [], shared_household_ids: [], ...o,
} as LedgerDocument);

export const documents: LedgerDocument[] = [
  doc({ id: 'doc-home-loan', user_id: MARA, name: 'Home loan statement', document_type: 'loan', linked_type: 'loan', linked_id: 'loan-home', household_ids: [HH_HOME] }),
  doc({ id: 'doc-home-ins', user_id: MARA, name: 'Home insurance policy', document_type: 'insurance', linked_type: 'property', linked_id: 'prop-home', household_ids: [HH_HOME] }),
  doc({ id: 'doc-private', user_id: MARA, name: 'Private will', document_type: 'contract' }),
  doc({ id: 'doc-tax', user_id: MARA, name: 'FY2026 notice of assessment', document_type: 'tax', linked_type: 'tax_year', linked_id: '2025-2026' }),
  doc({ id: 'doc-inv-strata', user_id: MARA, name: 'Strata levy notice', document_type: 'property', linked_type: 'property', linked_id: 'prop-inv', household_ids: [HH_INV] }),
  doc({ id: 'doc-dev-payslip', user_id: DEV, name: 'Payslip Aug', document_type: 'payslip', household_ids: [HH_FAM], shared_household_ids: [HH_FAM] }),
  // Explicitly shared into a household by its owner AND linked to a record in another.
  doc({ id: 'doc-cross', user_id: MARA, name: 'Cross-filed doc', document_type: 'other', linked_type: 'property', linked_id: 'prop-inv', household_ids: [HH_INV, HH_HOME], shared_household_ids: [HH_HOME] }),
  // Linked to a record that no longer exists.
  doc({ id: 'doc-orphan', user_id: DEV, name: 'Old flat contract', document_type: 'contract', linked_type: 'property', linked_id: 'prop-deleted' }),
  // Nina's, in a household Mara is NOT in.
  doc({ id: 'doc-nina-fam', user_id: NINA, name: 'Family doc', document_type: 'other', household_ids: [HH_FAM] }),
];

// ── Direct shares (Phase 7.2) ────────────────────────────────────────────────
export const recordShares: RecordShare[] = [
  // Mara lets Nina SEE her private saver. It must stay out of every total but Mara's.
  { id: 'rsh-1', record_type: 'account', record_id: 'acc-mara-saver', owner_user_id: MARA, shared_with_user_id: NINA, permission: 'view', status: 'active', record_label: 'Private Saver' },
  // Dev lets Theo EDIT his visa.
  { id: 'rsh-2', record_type: 'card', record_id: 'cc-dev-visa', owner_user_id: DEV, shared_with_user_id: THEO, permission: 'edit', status: 'active', record_label: 'Everyday Visa' },
  // A revoked grant must grant nothing.
  { id: 'rsh-3', record_type: 'account', record_id: 'acc-nina-biz', owner_user_id: NINA, shared_with_user_id: DEV, permission: 'view', status: 'revoked', ended_at: '2026-08-01', record_label: 'Business account' },
];

export const creditCardStatements: CreditCardStatement[] = [
  {
    id: 'ccs-1', user_id: MARA, credit_card_id: 'cc-mara-amex', period_label: 'Jul 2026',
    period_start: '2026-07-01', period_end: '2026-07-31', due_date: '2026-08-20',
    closing_balance: 6_240.15, minimum_payment: 190, amount_paid: 3_000, status: 'partial',
    source: 'statement', created_at: '2026-08-01', updated_at: '2026-08-08',
  },
];

export const pendingPayments: PendingPayment[] = [
  { id: 'pp-1', user_id: MARA, credit_card_id: 'cc-mara-amex', bank_account_id: 'acc-joint', amount: 3_000, status: 'reconciled', reconciled_transaction_id: 'tx-cc-pay-bank', statement_id: 'ccs-1', created_at: '2026-08-08' },
];

// ── Seeding ──────────────────────────────────────────────────────────────────

export interface SeedOptions {
  as: string;
  scope?: 'personal' | 'household';
  householdId?: string | null;
  /** Override any slice for a targeted test. */
  patch?: Record<string, unknown>;
}

/**
 * Put the whole world in the store as ONE user would legitimately have it:
 * their own rows, plus rows shared with a household they're in, plus rows
 * directly granted to them. Anything else never reaches their device, so
 * seeding it would test a situation the API cannot produce.
 */
export function visibleTo(userId: string) {
  const myHouseholds = new Set(
    members.filter(m => m.user_id === userId && m.status === 'active').map(m => m.household_id),
  );
  const grants = recordShares.filter(g => g.status === 'active' && g.shared_with_user_id === userId);
  const grantedIds = new Set(grants.map(g => g.record_id));

  const keep = <T extends { id: string; user_id?: string; household_ids?: string[] }>(rows: T[]): T[] =>
    rows.filter(r =>
      r.user_id === userId ||
      (r.household_ids ?? []).some(h => myHouseholds.has(h)) ||
      grantedIds.has(r.id));

  // Transactions come with the account they happened on, however it was shared
  // — a direct grant OR a household share. This mirrors the server's read
  // cascade exactly (backend/src/services/householdScope.ts:274): an account
  // without its transactions is a number with no explanation.
  const carriers = new Set<string>([
    ...accounts.filter(a => (a.household_ids ?? []).some(h => myHouseholds.has(h))).map(a => a.id),
    ...creditCards.filter(c => (c.household_ids ?? []).some(h => myHouseholds.has(h))).map(c => c.id),
    ...grantedIds,
  ]);
  const keepTx = (rows: Transaction[]): Transaction[] =>
    rows.filter(t =>
      t.user_id === userId ||
      (t.household_ids ?? []).some(h => myHouseholds.has(h)) ||
      (!!t.account_id && carriers.has(t.account_id)));

  const mine = <T extends { user_id?: string }>(rows: T[]): T[] => rows.filter(r => r.user_id === userId);

  return {
    accounts: keep(accounts),
    creditCards: keep(creditCards),
    loans: keep(loans),
    properties: keep(properties),
    budgets: keep(budgets),
    goals: keep(goals),
    bills: keep(bills),
    transactions: keepTx(transactions),
    investments: keep(investments),
    incomeEntries: keep(incomeEntries),
    insurancePolicies: keep(insurancePolicies),
    documents: keep(documents as unknown as { id: string; user_id?: string; household_ids?: string[] }[]) as unknown as LedgerDocument[],
    // Not shareable in their own right, but they BELONG to a row that is: a
    // split is how a shared transaction is categorised, so it travels with the
    // transaction (see GET /transaction-splits).
    transactionSplits: (() => {
      const visibleTx = new Set(keepTx(transactions).map(t => t.id));
      return transactionSplits.filter(sp => visibleTx.has(sp.transaction_id));
    })(),
    // A contribution's visibility follows its GOAL — a shared goal's progress is
    // meaningless without the money moved toward it (see GET /goal-contributions).
    goalContributions: (() => {
      const visibleGoals = new Set(keep(goals).map(g => g.id));
      return goalContributions.filter(c => c.user_id === userId || visibleGoals.has(c.goal_id));
    })(),
    // Never shareable — personal by construction.
    superFunds: mine(superFunds),
    smsfFunds: mine(smsfFunds),
    investmentSales: mine(investmentSales),
    loanEvents: mine(loanEvents),
    subscriptions: mine(subscriptions),
    recurringSeries: mine(recurringSeries),
    insurancePremiumHistory: mine(insurancePremiumHistory),
    creditCardStatements: mine(creditCardStatements),
    pendingPayments: mine(pendingPayments),
    recordShares: recordShares.filter(g => g.owner_user_id === userId || g.shared_with_user_id === userId),
  };
}
