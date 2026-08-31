/**
 * PRE-LAUNCH AUDIT — a fresh synthetic world, independent of every other one.
 *
 * Four users, three OVERLAPPING households, direct grants in both permissions,
 * a revoked grant, a removed membership, rows shared into TWO households at
 * once, transactions on shared accounts, and one of every shareable entity.
 *
 * Deliberately NOT reusing `frontend/src/stress/world.ts`: that world is what
 * the existing suites already agree with, so re-running it proves only that
 * nothing regressed. This one is written from the product rules instead, and
 * every expectation in the audit is computed from these declarations by an
 * ORACLE that never calls the application's own code.
 *
 * Ids are UUID-shaped because the routers validate `z.string().uuid()`.
 */

const uid = (n: number, tag: string) =>
  `${tag}${'0'.repeat(Math.max(0, 8 - tag.length))}-0000-4000-8000-${String(n).padStart(12, '0')}`;

// ── Identities ───────────────────────────────────────────────────────────────

export const ADA = uid(1, 'aaaaaaaa');
export const BO = uid(2, 'bbbbbbbb');
export const CY = uid(3, 'cccccccc');
export const DI = uid(4, 'dddddddd');

export const USERS = [
  { id: ADA, email: 'ada@audit.test', name: 'Ada', currency_preference: 'AUD' },
  { id: BO, email: 'bo@audit.test', name: 'Bo', currency_preference: 'AUD' },
  { id: CY, email: 'cy@audit.test', name: 'Cy', currency_preference: 'AUD' },
  { id: DI, email: 'di@audit.test', name: 'Di', currency_preference: 'AUD' },
];

export const HH_RIVER = uid(11, 'e1111111');   // Ada owner · Bo member · Cy viewer
export const HH_COAST = uid(12, 'e2222222');   // Bo owner · Ada member · Di member
export const HH_KIN = uid(13, 'e3333333');     // Cy owner · Di member

export const HOUSEHOLDS = [
  { id: HH_RIVER, name: 'Riverside', created_by: ADA, currency: 'AUD' },
  { id: HH_COAST, name: 'Coast Partners', created_by: BO, currency: 'AUD' },
  { id: HH_KIN, name: 'Kin', created_by: CY, currency: 'AUD' },
];

export interface Membership {
  household_id: string; user_id: string;
  role: 'owner' | 'admin' | 'member' | 'viewer';
  status: 'active' | 'removed' | 'left';
}

export const MEMBERSHIPS: Membership[] = [
  { household_id: HH_RIVER, user_id: ADA, role: 'owner', status: 'active' },
  { household_id: HH_RIVER, user_id: BO, role: 'member', status: 'active' },
  { household_id: HH_RIVER, user_id: CY, role: 'viewer', status: 'active' },
  // A removed member must grant nothing, anywhere.
  { household_id: HH_RIVER, user_id: DI, role: 'member', status: 'removed' },

  { household_id: HH_COAST, user_id: BO, role: 'owner', status: 'active' },
  { household_id: HH_COAST, user_id: ADA, role: 'member', status: 'active' },
  { household_id: HH_COAST, user_id: DI, role: 'member', status: 'active' },

  { household_id: HH_KIN, user_id: CY, role: 'owner', status: 'active' },
  { household_id: HH_KIN, user_id: DI, role: 'member', status: 'active' },
];

// ── The money ────────────────────────────────────────────────────────────────
//
// Every id below is named for what it is, so a failure message reads.

export const A_EVERYDAY = uid(101, 'a1111111');   // Ada, shared → RIVER
export const A_SAVER = uid(102, 'a1111111');      // Ada, private, directly granted to Cy (view)
export const A_USD = uid(103, 'a1111111');        // Ada, USD, directly granted to Di (edit)
export const A_HIDDEN = uid(104, 'a1111111');     // Ada, hidden, never shared
export const B_EVERYDAY = uid(105, 'b1111111');   // Bo, shared → COAST
export const B_PRIVATE = uid(106, 'b1111111');    // Bo, private, directly granted to Ada (edit) — revoked mid-audit
export const C_EVERYDAY = uid(107, 'c1111111');   // Cy, shared → KIN
export const C_PRIVATE = uid(108, 'c1111111');    // Cy, private; a REVOKED grant to Ada exists from the start
export const D_JOINT = uid(109, 'd1111111');      // Di, shared → COAST *and* KIN (one row, two households)
export const D_PRIVATE = uid(110, 'd1111111');    // Di, private

export const ACCOUNTS = [
  { id: A_EVERYDAY, user_id: ADA, name: 'Ada Everyday', institution: 'CBA', account_type: 'transaction', balance: 12_000, currency: 'AUD', is_manual: true },
  { id: A_SAVER, user_id: ADA, name: 'Ada Saver', institution: 'CBA', account_type: 'savings', balance: 45_000, currency: 'AUD', is_manual: true },
  { id: A_USD, user_id: ADA, name: 'Ada USD', institution: 'IBKR', account_type: 'transaction', balance: 10_000, currency: 'USD', is_manual: true },
  { id: A_HIDDEN, user_id: ADA, name: 'Ada Closed', institution: 'ANZ', account_type: 'savings', balance: 99_000, currency: 'AUD', is_manual: true, hidden: true },
  { id: B_EVERYDAY, user_id: BO, name: 'Bo Everyday', institution: 'NAB', account_type: 'transaction', balance: 8_000, currency: 'AUD', is_manual: true },
  { id: B_PRIVATE, user_id: BO, name: 'Bo Private', institution: 'NAB', account_type: 'savings', balance: 1_500, currency: 'AUD', is_manual: true },
  { id: C_EVERYDAY, user_id: CY, name: 'Cy Everyday', institution: 'Up', account_type: 'transaction', balance: 3_000, currency: 'AUD', is_manual: true },
  { id: C_PRIVATE, user_id: CY, name: 'Cy Private', institution: 'Up', account_type: 'savings', balance: 22_000, currency: 'AUD', is_manual: true },
  { id: D_JOINT, user_id: DI, name: 'Di Joint', institution: 'ING', account_type: 'transaction', balance: 700, currency: 'AUD', is_manual: true },
  { id: D_PRIVATE, user_id: DI, name: 'Di Private', institution: 'ING', account_type: 'savings', balance: 6_400, currency: 'AUD', is_manual: true },
];

export const A_CARD = uid(201, 'a2222222');   // Ada, shared → RIVER *and* COAST
export const B_CARD = uid(202, 'b2222222');   // Bo, private
export const D_CARD = uid(203, 'd2222222');   // Di, shared → KIN

export const CARDS = [
  { id: A_CARD, user_id: ADA, name: 'Ada Amex', institution: 'Amex', balance_owing: 2_000, credit_limit: 20_000, currency: 'AUD' },
  { id: B_CARD, user_id: BO, name: 'Bo Visa', institution: 'NAB', balance_owing: 900, credit_limit: 8_000, currency: 'AUD' },
  { id: D_CARD, user_id: DI, name: 'Di Mastercard', institution: 'ING', balance_owing: 350, credit_limit: 5_000, currency: 'AUD' },
];

export const A_MORTGAGE = uid(301, 'a3333333');   // Ada, shared → RIVER
export const B_CAR_LOAN = uid(302, 'b3333333');   // Bo, shared → COAST
export const C_HECS = uid(303, 'c3333333');       // Cy, private
export const D_PERSONAL = uid(304, 'd3333333');   // Di, private

export const LOANS = [
  { id: A_MORTGAGE, user_id: ADA, name: 'Riverside Mortgage', lender: 'CBA', loan_type: 'mortgage', original_amount: 500_000, current_balance: 400_000, interest_rate: 6.1, minimum_repayment: 3_000, repayment_frequency: 'monthly', next_due_date: '2026-09-15' },
  { id: B_CAR_LOAN, user_id: BO, name: 'Bo Car Loan', lender: 'NAB', loan_type: 'personal', original_amount: 30_000, current_balance: 20_000, interest_rate: 8.4, minimum_repayment: 600, repayment_frequency: 'monthly', next_due_date: '2026-09-10' },
  { id: C_HECS, user_id: CY, name: 'Cy HECS', lender: 'ATO', loan_type: 'hecs', original_amount: 40_000, current_balance: 18_000, interest_rate: 0 },
  { id: D_PERSONAL, user_id: DI, name: 'Di Personal Loan', lender: 'ING', loan_type: 'personal', original_amount: 10_000, current_balance: 4_000, interest_rate: 9.9 },
];

export const A_HOUSE = uid(401, 'a4444444');    // Ada, shared → RIVER, mortgaged by A_MORTGAGE
export const B_UNIT = uid(402, 'b4444444');     // Bo, private
export const C_FARM = uid(403, 'c4444444');     // Cy, shared → KIN

export const PROPERTIES = [
  { id: A_HOUSE, user_id: ADA, name: 'Riverside House', address: '1 River St', property_type: 'home', current_value: 900_000, purchase_price: 700_000, purchase_date: '2019-03-01', loan_id: A_MORTGAGE, held_by: 'personal' },
  { id: B_UNIT, user_id: BO, name: 'Bo Unit', address: '2 Coast Rd', property_type: 'investment', current_value: 550_000, purchase_price: 480_000, purchase_date: '2021-06-01', loan_id: B_CAR_LOAN, held_by: 'personal' },
  { id: C_FARM, user_id: CY, name: 'Kin Farm', address: '3 Kin Ln', property_type: 'investment', current_value: 1_200_000, purchase_price: 1_000_000, purchase_date: '2015-01-01', held_by: 'personal' },
];

export const A_SHARES = uid(501, 'a5555555');   // Ada, private
export const B_ETF = uid(502, 'b5555555');      // Bo, shared → COAST
export const C_CRYPTO = uid(503, 'c5555555');   // Cy, private
export const D_USD_STOCK = uid(504, 'd5555555');// Di, shared → KIN, USD

export const INVESTMENTS = [
  { id: A_SHARES, user_id: ADA, name: 'CBA', ticker: 'CBA.AX', asset_type: 'stock', units: 100, purchase_price: 90, current_price: 110, current_value: 11_000, cost_basis: 9_000, currency: 'AUD', market: 'ASX', acquired_date: '2023-02-01' },
  { id: B_ETF, user_id: BO, name: 'VAS', ticker: 'VAS.AX', asset_type: 'etf', units: 200, purchase_price: 85, current_price: 95, current_value: 19_000, cost_basis: 17_000, currency: 'AUD', market: 'ASX', acquired_date: '2022-05-01' },
  { id: C_CRYPTO, user_id: CY, name: 'Bitcoin', ticker: 'BTC-AUD', asset_type: 'crypto', units: 0.5, purchase_price: 40_000, current_price: 90_000, current_value: 45_000, cost_basis: 20_000, currency: 'AUD', market: 'CRYPTO', acquired_date: '2021-01-01' },
  { id: D_USD_STOCK, user_id: DI, name: 'Apple', ticker: 'AAPL', asset_type: 'stock', units: 20, purchase_price: 150, current_price: 200, current_value: 4_000, cost_basis: 3_000, currency: 'USD', market: 'NASDAQ', acquired_date: '2024-04-01' },
];

export const A_GOAL = uid(601, 'a6666666');   // Ada, shared → RIVER
export const B_GOAL = uid(602, 'b6666666');   // Bo, private
export const C_GOAL = uid(603, 'c6666666');   // Cy, shared → KIN
export const D_GOAL = uid(604, 'd6666666');   // Di, shared → COAST

export const GOALS = [
  { id: A_GOAL, user_id: ADA, name: 'Roof', target_amount: 30_000, current_amount: 12_000, target_date: '2027-06-30' },
  { id: B_GOAL, user_id: BO, name: 'Bo Emergency', target_amount: 15_000, current_amount: 5_000, target_date: '2027-01-31' },
  { id: C_GOAL, user_id: CY, name: 'Farm Fence', target_amount: 20_000, current_amount: 3_000, target_date: '2027-03-31' },
  { id: D_GOAL, user_id: DI, name: 'Coast Trip', target_amount: 6_000, current_amount: 1_200, target_date: '2026-12-01' },
];

export const A_BUDGET = uid(701, 'a7777777');   // Ada, shared → RIVER
export const B_BUDGET = uid(702, 'b7777777');   // Bo, private
export const D_BUDGET = uid(703, 'd7777777');   // Di, shared → COAST

export const BUDGETS = [
  { id: A_BUDGET, user_id: ADA, scope: 'category', category: 'groceries', limit_amount: 1_200, period: 'monthly', rollover_enabled: true, start_month: '2026-01', active: true },
  { id: B_BUDGET, user_id: BO, scope: 'category', category: 'dining', limit_amount: 400, period: 'monthly', rollover_enabled: false, start_month: '2026-01', active: true },
  { id: D_BUDGET, user_id: DI, scope: 'overall', category: null, limit_amount: 3_000, period: 'monthly', rollover_enabled: false, start_month: '2026-01', active: true },
];

export const A_BILL = uid(801, 'a8888888');   // Ada, shared → RIVER
export const B_BILL = uid(802, 'b8888888');   // Bo, private

export const BILLS = [
  { id: A_BILL, user_id: ADA, name: 'Council Rates', amount: 640, due_date: '2026-09-20', frequency: 'quarterly', is_recurring: true, category: 'utilities', is_paid: false, kind: 'bill' },
  { id: B_BILL, user_id: BO, name: 'Bo Phone', amount: 55, due_date: '2026-09-05', frequency: 'monthly', is_recurring: true, category: 'utilities', is_paid: false, kind: 'bill' },
];

export const A_DOC = uid(901, 'a9999999');   // Ada, shared → RIVER
export const B_DOC = uid(902, 'b9999999');   // Bo, private
export const C_DOC = uid(903, 'c9999999');   // Cy, linked to C_FARM (shared → KIN) — visibility by CASCADE

export const DOCUMENTS = [
  { id: A_DOC, user_id: ADA, name: 'Rates notice.pdf', original_filename: 'Rates notice.pdf', storage_path: `${ADA}/${A_DOC}/rates.pdf`, mime: 'application/pdf', size: 10, document_type: 'statement', provider: 'Council', document_date: '2026-08-01', linked_type: null, linked_id: null, extraction_status: 'unread' },
  { id: B_DOC, user_id: BO, name: 'Bo payslip.pdf', original_filename: 'Bo payslip.pdf', storage_path: `${BO}/${B_DOC}/payslip.pdf`, mime: 'application/pdf', size: 10, document_type: 'payslip', provider: 'Employer', document_date: '2026-08-01', linked_type: null, linked_id: null, extraction_status: 'unread' },
  { id: C_DOC, user_id: CY, name: 'Farm valuation.pdf', original_filename: 'Farm valuation.pdf', storage_path: `${CY}/${C_DOC}/farm.pdf`, mime: 'application/pdf', size: 10, document_type: 'other', provider: 'Valuer', document_date: '2026-07-01', linked_type: 'property', linked_id: C_FARM, extraction_status: 'unread' },
];

export const A_INCOME = uid(1001, 'a1010101');   // Ada, shared → RIVER
export const B_INCOME = uid(1002, 'b1010101');   // Bo, private

export const INCOME = [
  { id: A_INCOME, user_id: ADA, source: 'Salary', amount: 9_000, frequency: 'monthly', type: 'salary', currency: 'AUD', is_recurring: true, next_date: '2026-09-01' },
  { id: B_INCOME, user_id: BO, source: 'Consulting', amount: 4_000, frequency: 'monthly', type: 'business', currency: 'AUD', is_recurring: true, next_date: '2026-09-01' },
];

// ── Transactions ─────────────────────────────────────────────────────────────
//
// Every account that is shared carries some, so the derived cascade is exercised
// rather than assumed. `T_A_SAVER_*` sit on a DIRECTLY granted account;
// `T_D_JOINT_*` sit on an account in two households at once.

const tx = (
  id: string, user_id: string, account_id: string,
  merchant: string, amount: number, date = '2026-08-10',
) => ({ id, user_id, account_id, merchant, amount, date, category: 'groceries', currency: 'AUD', account_type: 'bank' });

export const T_A_EVERYDAY_1 = uid(1101, 'aa111111');
export const T_A_EVERYDAY_2 = uid(1102, 'aa111111');
export const T_A_SAVER_1 = uid(1103, 'aa111111');
export const T_A_USD_1 = uid(1104, 'aa111111');
export const T_A_HIDDEN_1 = uid(1105, 'aa111111');
export const T_B_EVERYDAY_1 = uid(1106, 'bb111111');
export const T_B_PRIVATE_1 = uid(1107, 'bb111111');
export const T_C_EVERYDAY_1 = uid(1108, 'cc111111');
export const T_D_JOINT_1 = uid(1109, 'dd111111');
export const T_D_PRIVATE_1 = uid(1110, 'dd111111');
/** A transaction of Ada's that she shared into RIVER *individually* — household
 *  sharing does NOT cascade from the account, so this one is shared on its own. */
export const T_A_LOOSE = uid(1111, 'aa111111');

export const TRANSACTIONS = [
  tx(T_A_EVERYDAY_1, ADA, A_EVERYDAY, 'Woolworths', -120.5),
  tx(T_A_EVERYDAY_2, ADA, A_EVERYDAY, 'Coles', -64.2),
  tx(T_A_SAVER_1, ADA, A_SAVER, 'Interest', 30),
  { ...tx(T_A_USD_1, ADA, A_USD, 'Amazon', -55), currency: 'USD' },
  tx(T_A_HIDDEN_1, ADA, A_HIDDEN, 'Old charge', -10),
  tx(T_B_EVERYDAY_1, BO, B_EVERYDAY, 'Bunnings', -210),
  tx(T_B_PRIVATE_1, BO, B_PRIVATE, 'Transfer in', 500),
  tx(T_C_EVERYDAY_1, CY, C_EVERYDAY, 'Feed store', -300),
  tx(T_D_JOINT_1, DI, D_JOINT, 'Shared groceries', -88),
  tx(T_D_PRIVATE_1, DI, D_PRIVATE, 'Chemist', -22),
  { ...tx(T_A_LOOSE, ADA, A_HIDDEN, 'Shared one-off', -400), category: 'other' },
];

// ── Sharing: which rows sit in which households ──────────────────────────────

export interface HouseholdShare {
  record_type: string; record_id: string; household_id: string; owner_user_id: string;
}

export const RECORD_HOUSEHOLDS: HouseholdShare[] = [
  { record_type: 'account', record_id: A_EVERYDAY, household_id: HH_RIVER, owner_user_id: ADA },
  { record_type: 'account', record_id: B_EVERYDAY, household_id: HH_COAST, owner_user_id: BO },
  { record_type: 'account', record_id: C_EVERYDAY, household_id: HH_KIN, owner_user_id: CY },
  // ONE row, TWO households.
  { record_type: 'account', record_id: D_JOINT, household_id: HH_COAST, owner_user_id: DI },
  { record_type: 'account', record_id: D_JOINT, household_id: HH_KIN, owner_user_id: DI },

  // A card in two households — Bo is in both, so it must reach him exactly once.
  { record_type: 'card', record_id: A_CARD, household_id: HH_RIVER, owner_user_id: ADA },
  { record_type: 'card', record_id: A_CARD, household_id: HH_COAST, owner_user_id: ADA },
  { record_type: 'card', record_id: D_CARD, household_id: HH_KIN, owner_user_id: DI },

  { record_type: 'loan', record_id: A_MORTGAGE, household_id: HH_RIVER, owner_user_id: ADA },
  { record_type: 'loan', record_id: B_CAR_LOAN, household_id: HH_COAST, owner_user_id: BO },

  { record_type: 'property', record_id: A_HOUSE, household_id: HH_RIVER, owner_user_id: ADA },
  { record_type: 'property', record_id: C_FARM, household_id: HH_KIN, owner_user_id: CY },

  { record_type: 'investment', record_id: B_ETF, household_id: HH_COAST, owner_user_id: BO },
  { record_type: 'investment', record_id: D_USD_STOCK, household_id: HH_KIN, owner_user_id: DI },

  { record_type: 'goal', record_id: A_GOAL, household_id: HH_RIVER, owner_user_id: ADA },
  { record_type: 'goal', record_id: C_GOAL, household_id: HH_KIN, owner_user_id: CY },
  { record_type: 'goal', record_id: D_GOAL, household_id: HH_COAST, owner_user_id: DI },

  { record_type: 'budget', record_id: A_BUDGET, household_id: HH_RIVER, owner_user_id: ADA },
  { record_type: 'budget', record_id: D_BUDGET, household_id: HH_COAST, owner_user_id: DI },

  { record_type: 'bill', record_id: A_BILL, household_id: HH_RIVER, owner_user_id: ADA },

  { record_type: 'document', record_id: A_DOC, household_id: HH_RIVER, owner_user_id: ADA },

  { record_type: 'income', record_id: A_INCOME, household_id: HH_RIVER, owner_user_id: ADA },

  // A transaction shared on its own (household sharing does not cascade from the
  // account) — and its account is HIDDEN and unshared, so it is the only way in.
  { record_type: 'transaction', record_id: T_A_LOOSE, household_id: HH_RIVER, owner_user_id: ADA },
];

export interface DirectShare {
  id: string; record_type: string; record_id: string;
  owner_user_id: string; shared_with_user_id: string;
  permission: 'view' | 'edit'; status: 'active' | 'revoked' | 'left';
}

export const S_ADA_CY_SAVER = uid(2001, 'e5555555');
export const S_ADA_DI_USD = uid(2002, 'e5555555');
export const S_BO_ADA_PRIVATE = uid(2003, 'e5555555');
export const S_CY_ADA_PRIVATE = uid(2004, 'e5555555');

export const RECORD_SHARES: DirectShare[] = [
  // View-only: Cy may look at Ada's saver and its transactions, and change nothing.
  { id: S_ADA_CY_SAVER, record_type: 'account', record_id: A_SAVER, owner_user_id: ADA, shared_with_user_id: CY, permission: 'view', status: 'active' },
  // Editable: Di may correct Ada's USD account.
  { id: S_ADA_DI_USD, record_type: 'account', record_id: A_USD, owner_user_id: ADA, shared_with_user_id: DI, permission: 'edit', status: 'active' },
  // Editable, and REVOKED partway through the audit.
  { id: S_BO_ADA_PRIVATE, record_type: 'account', record_id: B_PRIVATE, owner_user_id: BO, shared_with_user_id: ADA, permission: 'edit', status: 'active' },
  // Already revoked before the audit begins — must grant nothing at any point.
  { id: S_CY_ADA_PRIVATE, record_type: 'account', record_id: C_PRIVATE, owner_user_id: CY, shared_with_user_id: ADA, permission: 'view', status: 'revoked' },
];

// ── Everything else a user owns, so screens have something to disagree about ──

export const SUPER_FUNDS = [
  { id: uid(3001, 'e6666666'), user_id: ADA, fund_name: 'AustralianSuper', member_number: 'A1', balance: 220_000, counted_in_net_worth: true },
  { id: uid(3002, 'e6666666'), user_id: BO, fund_name: 'Hostplus', member_number: 'B1', balance: 90_000, counted_in_net_worth: true },
  { id: uid(3003, 'e6666666'), user_id: CY, fund_name: 'Rest', member_number: 'C1', balance: 60_000, counted_in_net_worth: false },
];

export const INSURANCE = [
  { id: uid(3101, 'e7777777'), user_id: ADA, policy_type: 'home', provider: 'AAMI', policy_number: 'H-1', premium_amount: 1_800, premium_frequency: 'annually', renewal_date: '2027-02-01', status: 'active', linked_type: 'property', linked_id: A_HOUSE, sum_insured: 900_000 },
  { id: uid(3102, 'e7777777'), user_id: BO, policy_type: 'car', provider: 'Budget Direct', policy_number: 'C-1', premium_amount: 900, premium_frequency: 'annually', renewal_date: '2027-04-01', status: 'active', sum_insured: 30_000 },
];

/** Rates fixed for today so the real currencyService never reaches the network. */
export const EXCHANGE_RATES = (today: string) => [
  { from_currency: 'USD', to_currency: 'AUD', rate: 1.5, date: today },
  { from_currency: 'AUD', to_currency: 'USD', rate: 1 / 1.5, date: today },
  { from_currency: 'AUD', to_currency: 'AUD', rate: 1, date: today },
];
