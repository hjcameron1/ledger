import axios from 'axios';
import { useStore } from '../store';
import { isDemoSession } from '../config/demo';

// VITE_API_URL points at the backend: the Render URL in production, and
// http://localhost:3001 in development (see frontend/.env.development). If unset,
// it falls back to '' so relative '/api' paths resolve against the current origin.
// Exported so non-axios callers (raw fetch in dataService) hit the same backend.
export const API_BASE = import.meta.env.VITE_API_URL ?? '';

// Nothing may hang forever: the Render free tier cold-starts in up to ~a
// minute, so the default budget covers that and no more. Slow-by-design calls
// (document upload/extract, AI classify) override this per request.
const DEFAULT_TIMEOUT_MS = 60_000;
const api = axios.create({ baseURL: `${API_BASE}/api`, timeout: DEFAULT_TIMEOUT_MS });

// ── "Waking the server" notice ────────────────────────────────────────────────
// A request that is still pending after SLOW_MS almost always means the backend
// is cold-starting. Flag it in the store so the UI can say so instead of
// looking frozen; clear the flag once no slow request remains outstanding.
const SLOW_MS = 6_000;
let slowRequestCount = 0;
interface SlowMark { timer: ReturnType<typeof setTimeout>; fired: boolean }
const slowMarks = new WeakMap<object, SlowMark>();

function beginSlowWatch(config: object): void {
  const mark: SlowMark = {
    fired: false,
    timer: setTimeout(() => {
      mark.fired = true;
      slowRequestCount++;
      useStore.getState().setApiWaking(true);
    }, SLOW_MS),
  };
  slowMarks.set(config, mark);
}

function endSlowWatch(config: object | undefined): void {
  const mark = config && slowMarks.get(config);
  if (!mark) return;
  clearTimeout(mark.timer);
  if (mark.fired) {
    slowRequestCount = Math.max(0, slowRequestCount - 1);
    if (slowRequestCount === 0) useStore.getState().setApiWaking(false);
  }
}

// Everything outside /auth/* requires a real session. Without this gate, a
// demo session or a signed-out load with stale state fires the whole bootstrap
// burst (~30 parallel requests) at the backend just to collect 401s — console
// noise, wasted cold-start time, and a logout stampede. Rejecting locally is
// silent and instant; every caller already handles a failed request.
class AuthGateError extends Error {
  isAuthGate = true;
  constructor() { super('Not signed in — request not sent.'); }
}
export function isAuthGateError(err: unknown): boolean {
  return !!(err as { isAuthGate?: boolean })?.isAuthGate;
}

// One shared abort scope per auth epoch: when a 401 logs the session out, every
// other request of the same parallel burst (bootstrap fires ~30 at once) is
// aborted instead of each coming back as its own 401.
let authEpoch = new AbortController();

api.interceptors.request.use((config) => {
  const token = useStore.getState().token;
  const isPublic = (config.url ?? '').startsWith('/auth');
  if (!isPublic && (!token || isDemoSession(token))) {
    return Promise.reject(new AuthGateError());
  }
  if (token) config.headers.Authorization = `Bearer ${token}`;
  if (!isPublic && !config.signal) config.signal = authEpoch.signal;
  beginSlowWatch(config);
  return config;
});

api.interceptors.response.use(
  (r) => {
    endSlowWatch(r.config);
    return r;
  },
  (err) => {
    endSlowWatch(err.config);
    // A timed-out request has no response body for catch-blocks to display, so
    // every form would fall back to a blank "Something went wrong". Synthesize
    // the message they all read (no status — the sync queue must keep treating
    // a timeout as retryable, and nothing branches on response presence).
    if (err.code === 'ECONNABORTED' && !err.response) {
      err.response = {
        data: { error: 'The server took too long to respond — it may just be waking up. Please try again in a moment.' },
      };
    }
    const state = useStore.getState();
    // Don't log out demo/guest sessions — they have no real token. The
    // `state.token` check is the logout latch: the first 401 of a parallel
    // burst clears the token synchronously, so the remaining 26 responses of
    // the same burst fall through instead of each calling logout() again.
    if (err.response?.status === 401 && state.token && !isDemoSession(state.token)) {
      // Grace window: the backend (Render free tier) may cold-start and emit
      // transient 401s for the burst of parallel bootstrap requests fired right
      // after login. Logging out on those bounces the user straight back to the
      // login screen (the "took 5 goes to log in" symptom). Within 20s of a
      // successful auth we ride out the transient instead of nuking the session;
      // a genuinely invalid token will still 401 on the next action and log out.
      const sinceAuth = Date.now() - (state.lastAuthMs || 0);
      if (sinceAuth > 20000) {
        state.logout();
        authEpoch.abort();
        authEpoch = new AbortController();
      } else {
        console.warn('[api] 401 within post-login grace window — not logging out (likely backend cold start)');
      }
    }
    return Promise.reject(err);
  }
);

// Auth
export const authApi = {
  register: (data: { email: string; password: string; name: string }) =>
    api.post('/auth/register', data).then(r => r.data),
  login: (data: { email: string; password: string }) =>
    api.post('/auth/login', data).then(r => r.data),
  verifyEmail: (data: { email: string; code: string }) =>
    api.post('/auth/verify-email', data).then(r => r.data),
  resendVerification: (data: { email: string }) =>
    api.post('/auth/resend-verification', data).then(r => r.data),
};

// Phase 7.1 — households. Unlike the money endpoints these are NOT local-first:
// a household is shared with other people, so its truth is the server's and every
// call here is awaited rather than queued. Sharing a ROW, by contrast, is just a
// column on a record the user already has, and rides the existing update kinds.
export const householdsApi = {
  /** Households, members and invitations in one round trip — everything the
   *  client needs to build its context. */
  getAll: () => api.get('/households').then(r => r.data),
  create: (data: { name: string; currency?: string }) =>
    api.post('/households', data).then(r => r.data),
  update: (id: string, data: { name?: string; currency?: string }) =>
    api.put(`/households/${id}`, data).then(r => r.data),
  remove: (id: string) => api.delete(`/households/${id}`).then(r => r.data),

  getMembers: (id: string) => api.get(`/households/${id}/members`).then(r => r.data),
  setRole: (id: string, memberId: string, role: string) =>
    api.patch(`/households/${id}/members/${memberId}`, { role }).then(r => r.data),
  removeMember: (id: string, memberId: string) =>
    api.delete(`/households/${id}/members/${memberId}`).then(r => r.data),
  leave: (id: string) => api.post(`/households/${id}/leave`).then(r => r.data),
  transfer: (id: string, memberId: string) =>
    api.post(`/households/${id}/transfer`, { memberId }).then(r => r.data),

  invite: (id: string, data: { email: string; role: string }) =>
    api.post(`/households/${id}/invitations`, data).then(r => r.data),
  revokeInvite: (id: string, inviteId: string) =>
    api.delete(`/households/${id}/invitations/${inviteId}`).then(r => r.data),
  acceptInvite: (code: string) =>
    api.post(`/households/invitations/${code}/accept`).then(r => r.data),
  declineInvite: (code: string) =>
    api.post(`/households/invitations/${code}/decline`).then(r => r.data),

  // Phase 7.2 — the standing join link. Rotating it invalidates the old one, so
  // "regenerate" and "revoke the last one" are the same single call.
  regenerateCode: (id: string, data?: { role?: string }) =>
    api.post(`/households/${id}/code`, data ?? {}).then(r => r.data),
  revokeCode: (id: string) => api.delete(`/households/${id}/code`).then(r => r.data),
  /** Join by link. Mints a MEMBERSHIP — the code itself grants nothing. */
  join: (code: string) => api.post('/households/join', { code }).then(r => r.data),

  // Change requests — a member's edit/delete of YOUR shared row, waiting for
  // your yes or no. The household already sees their version; answering only
  // decides whether your own record follows.
  changeRequests: () => api.get('/households/change-requests').then(r => r.data),
  respondToChangeRequest: (id: string, accept: boolean) =>
    api.post(`/households/change-requests/${id}/respond`, { accept }).then(r => r.data),
};

// ─── DIRECT SHARING (Phase 7.2) ──────────────────────────────────────────────
//
// Sight of ONE row for ONE named person. Nothing here creates, copies or moves a
// financial row: every call either mints a code, redeems one into a grant, or
// ends a grant. The row keeps its owner throughout.
export const sharesApi = {
  /** Grants given, grants held and live codes, in one round trip. */
  getAll: () => api.get('/shares').then(r => r.data),
  /** Mint a code for a row the caller owns. */
  createCode: (data: { record_type: string; record_id: string; permission?: string; label?: string }) =>
    api.post('/shares/codes', data).then(r => r.data),
  revokeCode: (id: string) => api.delete(`/shares/codes/${id}`).then(r => r.data),
  /** Redeem a code into a grant. Idempotent: a code for something the caller can
   *  already see returns the existing grant rather than a second one. */
  redeem: (code: string) => api.post('/shares/redeem', { code }).then(r => r.data),
  /** End a grant — revoke if you own the row, leave if you don't. Same call,
   *  because it is the same safe operation from either side. */
  end: (id: string) => api.delete(`/shares/${id}`).then(r => r.data),
  /** Change what a person may do with a row you own. */
  setPermission: (id: string, permission: string) =>
    api.patch(`/shares/${id}`, { permission }).then(r => r.data),
};

// Overview
export const overviewApi = {
  getNetWorth: () => api.get('/overview/net-worth').then(r => r.data),
  getNetWorthHistory: () => api.get('/overview/net-worth/history').then(r => r.data),
  getNetWorthPctHistory: (timeframe: string) => api.get('/overview/net-worth/pct-history', { params: { timeframe } }).then(r => r.data),
  getNetWorthItemChanges: (timeframe: string) => api.get('/overview/net-worth/item-changes', { params: { timeframe } }).then(r => r.data),
  getBills: () => api.get('/overview/bills').then(r => r.data),
  createBill: (data: object) => api.post('/overview/bills', data).then(r => r.data),
  updateBill: (id: string, data: object) => api.put(`/overview/bills/${id}`, data).then(r => r.data),
  payBill: (id: string) => api.patch(`/overview/bills/${id}/pay`).then(r => r.data),
  deleteBill: (id: string) => api.delete(`/overview/bills/${id}`).then(r => r.data),
  getLoans: () => api.get('/loans').then(r => r.data),
  createLoan: (data: object) => api.post('/loans', data).then(r => r.data),
  updateLoan: (id: string, data: object) => api.put(`/loans/${id}`, data).then(r => r.data),
  deleteLoan: (id: string) => api.delete(`/loans/${id}`).then(r => r.data),
  // Phase 4.2 loan movements — repayments, extra repayments, redraws and rate
  // changes against the SAME loan. There is no separate mortgage record.
  getLoanEvents: () => api.get('/loans/events').then(r => r.data),
  createLoanEvent: (data: object) => api.post('/loans/events', data).then(r => r.data),
  deleteLoanEvent: (id: string) => api.delete(`/loans/events/${id}`).then(r => r.data),
  // Phase 4.1 properties. Only the asset lives here — a property's mortgage is
  // one of the loans above, referenced by loan_id and never duplicated.
  getProperties: () => api.get('/properties').then(r => r.data),
  createProperty: (data: object) => api.post('/properties', data).then(r => r.data),
  updateProperty: (id: string, data: object) => api.put(`/properties/${id}`, data).then(r => r.data),
  deleteProperty: (id: string) => api.delete(`/properties/${id}`).then(r => r.data),
  getGoals: () => api.get('/overview/goals').then(r => r.data),
  createGoal: (data: object) => api.post('/overview/goals', data).then(r => r.data),
  updateGoal: (id: string, data: object) => api.put(`/overview/goals/${id}`, data).then(r => r.data),
  deleteGoal: (id: string) => api.delete(`/overview/goals/${id}`).then(r => r.data),
  getGoalContributions: () => api.get('/overview/goal-contributions').then(r => r.data),
  createGoalContribution: (data: object) => api.post('/overview/goal-contributions', data).then(r => r.data),
  updateGoalContribution: (id: string, data: object) => api.put(`/overview/goal-contributions/${id}`, data).then(r => r.data),
  deleteGoalContribution: (id: string) => api.delete(`/overview/goal-contributions/${id}`).then(r => r.data),
  // Phase 4.4 alert dismiss/read state. The write is an UPSERT keyed on
  // alert_key, so replaying it (offline queue, two devices) converges.
  getAlertStates: () => api.get('/overview/alert-states').then(r => r.data),
  saveAlertState: (data: object) => api.put('/overview/alert-states', data).then(r => r.data),
  // The key goes in the query string: it embeds a category name, which may
  // contain a slash, and a path segment is the wrong place for that.
  deleteAlertState: (key: string) =>
    api.delete('/overview/alert-states', { params: { key } }).then(r => r.data),
  // ── Phase 9.1 — Ask Ledger ────────────────────────────────────────────────
  // Two deliberately small calls. `askInterpret` sends the question and a list
  // of NAMES (categories, goals, loans) and gets back an intent; `askPhrase`
  // sends figures Ledger has already computed and gets back a sentence. No
  // transaction, balance or total is ever posted, and no answer is ever taken
  // from the response — see utils/askAnswer for the checks on both.
  //
  // Both resolve to `{ error }` rather than throwing when the model is
  // unavailable, because Ask Ledger answers perfectly well without it.
  askInterpret: (data: { question: string; vocabulary: object }) =>
    api.post('/overview/ask/interpret', data).then(r => r.data),
  askPhrase: (data: { question: string; intent: string; statement: string; figures: object[]; currency: string }) =>
    api.post('/overview/ask/phrase', data).then(r => r.data),
  getNotifications: () => api.get('/overview/notifications').then(r => r.data),
  markNotificationRead: (id: string) => api.patch(`/overview/notifications/${id}/read`).then(r => r.data),
  markAllRead: () => api.patch('/overview/notifications/read-all').then(r => r.data),
  getBudgets: () => api.get('/overview/budget').then(r => r.data),
  createBudget: (data: object) => api.post('/overview/budget', data).then(r => r.data),
  updateBudget: (id: string, data: object) => api.put(`/overview/budget/${id}`, data).then(r => r.data),
  deleteBudget: (id: string) => api.delete(`/overview/budget/${id}`).then(r => r.data),

  // Budget plan (settings + line items + custom categories)
  getBudgetSettings: () => api.get('/overview/budget-settings').then(r => r.data),
  saveBudgetSettings: (data: object) => api.put('/overview/budget-settings', data).then(r => r.data),
  getBudgetLines: () => api.get('/overview/budget-lines').then(r => r.data),
  createBudgetLine: (data: object) => api.post('/overview/budget-lines', data).then(r => r.data),
  updateBudgetLine: (id: string, data: object) => api.put(`/overview/budget-lines/${id}`, data).then(r => r.data),
  deleteBudgetLine: (id: string) => api.delete(`/overview/budget-lines/${id}`).then(r => r.data),
  getCustomCategories: () => api.get('/overview/custom-categories').then(r => r.data),
  createCustomCategory: (data: object) => api.post('/overview/custom-categories', data).then(r => r.data),
  deleteCustomCategory: (id: string) => api.delete(`/overview/custom-categories/${id}`).then(r => r.data),

  // Bill ↔ subscription "Different bills" exclusions (cross-device). Keyed by the
  // stable anchor `decision_key`; DELETE is by key, not id.
  getBillSubExclusions: () => api.get('/overview/bill-subscription-exclusions').then(r => r.data),
  createBillSubExclusion: (data: object) => api.post('/overview/bill-subscription-exclusions', data).then(r => r.data),
  deleteBillSubExclusion: (key: string) => api.delete(`/overview/bill-subscription-exclusions?key=${encodeURIComponent(key)}`).then(r => r.data),

  // Phase 2B — merchant recognition + rules
  getMerchants: () => api.get('/overview/merchants').then(r => r.data),
  createMerchant: (data: object) => api.post('/overview/merchants', data).then(r => r.data),
  updateMerchant: (id: string, data: object) => api.put(`/overview/merchants/${id}`, data).then(r => r.data),
  deleteMerchant: (id: string) => api.delete(`/overview/merchants/${id}`).then(r => r.data),
  getMerchantAliases: () => api.get('/overview/merchant-aliases').then(r => r.data),
  createMerchantAlias: (data: object) => api.post('/overview/merchant-aliases', data).then(r => r.data),
  deleteMerchantAlias: (id: string) => api.delete(`/overview/merchant-aliases/${id}`).then(r => r.data),
  getTransactionRules: () => api.get('/overview/transaction-rules').then(r => r.data),
  createTransactionRule: (data: object) => api.post('/overview/transaction-rules', data).then(r => r.data),
  updateTransactionRule: (id: string, data: object) => api.put(`/overview/transaction-rules/${id}`, data).then(r => r.data),
  deleteTransactionRule: (id: string) => api.delete(`/overview/transaction-rules/${id}`).then(r => r.data),

  // Phase 2C — recurring series + transaction splits
  getRecurringSeries: () => api.get('/overview/recurring-series').then(r => r.data),
  createRecurringSeries: (data: object) => api.post('/overview/recurring-series', data).then(r => r.data),
  updateRecurringSeries: (id: string, data: object) => api.put(`/overview/recurring-series/${id}`, data).then(r => r.data),
  deleteRecurringSeries: (id: string) => api.delete(`/overview/recurring-series/${id}`).then(r => r.data),
  getTransactionSplits: () => api.get('/overview/transaction-splits').then(r => r.data),
  createTransactionSplit: (data: object) => api.post('/overview/transaction-splits', data).then(r => r.data),
  deleteTransactionSplitsFor: (transactionId: string) =>
    api.delete(`/overview/transaction-splits/by-transaction/${transactionId}`).then(r => r.data),
  deleteTransactionSplit: (id: string) => api.delete(`/overview/transaction-splits/${id}`).then(r => r.data),
  // Phase 2D.3 — AI classification fallback for otherwise-uncertain transactions.
  // Explicit timeout so a stalled model call can't leave the UI stuck on
  // "Asking AI…" forever; the server echoes an `error` string when the Claude
  // call itself fails (e.g. missing key) so the UI can say so instead of silently
  // doing nothing.
  aiClassify: (data: { transactions: object[]; categories: string[]; currency?: string }) =>
    api.post('/overview/ai-classify', data, { timeout: 45000 })
      .then(r => r.data as { results: import('../utils/aiClassification').AiSuggestion[]; error?: string }),
};

// Accounts
export const accountsApi = {
  getAccounts: () => api.get('/accounts').then(r => r.data),
  createAccount: (data: object) => api.post('/accounts', data).then(r => r.data),
  updateAccount: (id: string, data: object) => api.put(`/accounts/${id}`, data).then(r => r.data),
  // Transaction-driven balance move: the server adds delta to its CURRENT figure
  // (no stale absolutes), and it applies for household editors without approval.
  adjustAccountBalance: (id: string, delta: number) => api.post(`/accounts/${id}/adjust-balance`, { delta }).then(r => r.data),
  adjustCreditCardBalance: (id: string, delta: number) => api.post(`/accounts/credit-cards/${id}/adjust-balance`, { delta }).then(r => r.data),
  deleteAccount: (id: string) => api.delete(`/accounts/${id}`).then(r => r.data),
  getCreditCards: () => api.get('/accounts/credit-cards').then(r => r.data),
  createCreditCard: (data: object) => api.post('/accounts/credit-cards', data).then(r => r.data),
  deleteCreditCard: (id: string) => api.delete(`/accounts/credit-cards/${id}`).then(r => r.data),
  getTransactions: (params?: object) => api.get('/accounts/transactions', { params }).then(r => r.data),
  createTransaction: (data: object) => api.post('/accounts/transactions', data).then(r => r.data),
  updateTransaction: (id: string, data: object) => api.patch(`/accounts/transactions/${id}`, data).then(r => r.data),
  deleteTransaction: (id: string) => api.delete(`/accounts/transactions/${id}`).then(r => r.data),
  getSubscriptions: () => api.get('/accounts/subscriptions').then(r => r.data),
  createSubscription: (data: object) => api.post('/accounts/subscriptions', data).then(r => r.data),
  updateSubscription: (id: string, data: object) => api.patch(`/accounts/subscriptions/${id}`, data).then(r => r.data),
  deleteSubscription: (id: string) => api.delete(`/accounts/subscriptions/${id}`).then(r => r.data),
  getPayments: (creditCardId: string) => api.get(`/accounts/credit-cards/${creditCardId}/payments`).then(r => r.data),
  createPayment: (creditCardId: string, data: object) => api.post(`/accounts/credit-cards/${creditCardId}/payments`, data).then(r => r.data),
  updatePayment: (creditCardId: string, paymentId: string, data: object) => api.patch(`/accounts/credit-cards/${creditCardId}/payments/${paymentId}`, data).then(r => r.data),
  deletePayment: (creditCardId: string, paymentId: string) => api.delete(`/accounts/credit-cards/${creditCardId}/payments/${paymentId}`).then(r => r.data),
  updateCreditCard: (id: string, data: object) => api.patch(`/accounts/credit-cards/${id}`, data).then(r => r.data),
  getStatements: (creditCardId: string, params?: { limit?: number; before?: string }) =>
    api.get(`/accounts/credit-cards/${creditCardId}/statements`, { params }).then(r => r.data),
  createStatement: (creditCardId: string, data: object) =>
    api.post(`/accounts/credit-cards/${creditCardId}/statements`, data).then(r => r.data),
  updateStatement: (creditCardId: string, statementId: string, data: object) =>
    api.patch(`/accounts/credit-cards/${creditCardId}/statements/${statementId}`, data).then(r => r.data),
};

// Investments
export const investmentsApi = {
  getInvestments: () => api.get('/investments').then(r => r.data),
  createInvestment: (data: object) => api.post('/investments', data).then(r => r.data),
  updateInvestment: (id: string, data: object) => api.put(`/investments/${id}`, data).then(r => r.data),
  deleteInvestment: (id: string, sold = false) =>
    api.delete(`/investments/${id}`, { params: sold ? { sold: 1 } : {} }).then(r => r.data),
  getPlHistory: (timeframe: string) => api.get('/investments/pl-history', { params: { timeframe } }).then(r => r.data),
  getSales: () => api.get('/investments/sales').then(r => r.data),
  createSale: (data: object) => api.post('/investments/sales', data).then(r => r.data),
  deleteSale: (id: string) => api.delete(`/investments/sales/${id}`).then(r => r.data),
  getSuper: () => api.get('/investments/super').then(r => r.data),
  createSuper: (data: object) => api.post('/investments/super', data).then(r => r.data),
  updateSuper: (id: string, data: object) => api.put(`/investments/super/${id}`, data).then(r => r.data),
  // Stock Watchlist
  getWatchlist: () => api.get('/investments/watchlist').then(r => r.data),
  addToWatchlist: (data: object) => api.post('/investments/watchlist', data).then(r => r.data),
  updateWatchlistItem: (id: string, data: object) => api.put(`/investments/watchlist/${id}`, data).then(r => r.data),
  removeFromWatchlist: (id: string) => api.delete(`/investments/watchlist/${id}`).then(r => r.data),
};

// Regular investment plans (recurring contributions)
export const investmentPlansApi = {
  getAll: () => api.get('/investment-plans').then(r => r.data),
  getDue: () => api.get('/investment-plans/due').then(r => r.data),
  create: (data: object) => api.post('/investment-plans', data).then(r => r.data),
  update: (id: string, data: object) => api.put(`/investment-plans/${id}`, data).then(r => r.data),
  remove: (id: string) => api.delete(`/investment-plans/${id}`).then(r => r.data),
  confirm: (id: string, data: object) => api.post(`/investment-plans/${id}/confirm`, data).then(r => r.data),
};

// Self-Managed Super Fund (SMSF)
export const smsfApi = {
  getAll: () => api.get('/smsf').then(r => r.data),
  createFund: (data: object) => api.post('/smsf/funds', data).then(r => r.data),
  updateFund: (id: string, data: object) => api.put(`/smsf/funds/${id}`, data).then(r => r.data),
  deleteFund: (id: string) => api.delete(`/smsf/funds/${id}`).then(r => r.data),
  createMember: (data: object) => api.post('/smsf/members', data).then(r => r.data),
  updateMember: (id: string, data: object) => api.put(`/smsf/members/${id}`, data).then(r => r.data),
  deleteMember: (id: string) => api.delete(`/smsf/members/${id}`).then(r => r.data),
  createAsset: (data: object) => api.post('/smsf/assets', data).then(r => r.data),
  updateAsset: (id: string, data: object) => api.put(`/smsf/assets/${id}`, data).then(r => r.data),
  deleteAsset: (id: string) => api.delete(`/smsf/assets/${id}`).then(r => r.data),
  createContribution: (data: object) => api.post('/smsf/contributions', data).then(r => r.data),
  deleteContribution: (id: string) => api.delete(`/smsf/contributions/${id}`).then(r => r.data),
};

// Payroll (payslips + expected employer-super ledger)
export const payrollApi = {
  getAll: () => api.get('/payroll').then(r => r.data),
  createPayslip: (data: object) => api.post('/payroll/payslips', data).then(r => r.data),
  deletePayslip: (id: string) => api.delete(`/payroll/payslips/${id}`).then(r => r.data),
  reconcileSuper: (data: object) => api.post('/payroll/reconcile-super', data).then(r => r.data),
};

// Income
export const incomeApi = {
  getIncome: () => api.get('/income').then(r => r.data),
  createIncome: (data: object) => api.post('/income', data).then(r => r.data),
  updateIncome: (id: string, data: object) => api.put(`/income/${id}`, data).then(r => r.data),
  deleteIncome: (id: string) => api.delete(`/income/${id}`).then(r => r.data),
  approveIncome: (id: string) => api.post(`/income/${id}/approve`).then(r => r.data),
  syncDividends: () => api.post('/income/dividends/sync').then(r => r.data) as Promise<{ created: number; checked: number }>,
  createDeduction: (data: object) => api.post('/income/tax/deductions', data).then(r => r.data),
};

// Settings
export const settingsApi = {
  getProfile: () => api.get('/settings/profile').then(r => r.data),
  updateProfile: (data: object) => api.put('/settings/profile', data).then(r => r.data),
  updateTelegram: (token: string) => api.put('/settings/telegram', { telegram_bot_token: token }).then(r => r.data),
  deleteAccount: (confirmation: string) => api.delete('/settings/account', { data: { confirmation } }).then(r => r.data),
  exportData: () => api.get('/settings/export').then(r => r.data),
  getBriefingSettings: () => api.get('/settings/briefing').then(r => r.data),
  updateBriefingSettings: (data: object) => api.put('/settings/briefing', data).then(r => r.data),
  // Ecosystem pairing: mint a one-time code to connect another app (e.g. PAssistant).
  generatePairingCode: () => api.post('/integration/link/code').then(r => r.data as { code: string; expires_at: string | null }),
  // Connected apps: current links + sync health, and disconnect.
  getConnectedApps: () => api.get('/integration/links').then(r => r.data as { links: ConnectedAppLink[] }),
  disconnectApp: (id: string) => api.delete(`/integration/links/${id}`).then(r => r.data),
};

/** A connected ecosystem app as shown in Settings → Connected Apps (no secrets). */
export interface ConnectedAppLink {
  id: string;
  app_id: string | null;   // 'passistant', …; null while a code is still pending
  status: string;          // 'pending' | 'active' | 'disconnected'
  created_at: string | null;
  redeemed_at: string | null;
  last_seen_at: string | null;
  disconnected_at: string | null; // set when the app severed the link from its end
}

// ─── Phase 8.1 — the document vault ──────────────────────────────────────────
// Server-truth, like households: files are shared with other people and can't
// meaningfully live in a local-first store, so every call is awaited and the
// list is refetched after each change.
export const documentsApi = {
  /** Metadata for every document the caller may see (own + shared-via-link). */
  getAll: () => api.get('/documents').then(r => r.data as import('../types').LedgerDocument[]),
  /** Upload one or more files sharing one set of metadata. Each file becomes
   *  its own document, individually renameable and deletable afterwards. */
  upload: (files: File[], meta: Record<string, string>) => {
    const form = new FormData();
    for (const f of files) form.append('files', f);
    for (const [k, v] of Object.entries(meta)) form.append(k, v);
    return api.post('/documents', form, {
      headers: { 'Content-Type': 'multipart/form-data' },
      timeout: 120000,
    }).then(r => r.data as { documents: import('../types').LedgerDocument[] });
  },
  update: (id: string, data: object) =>
    api.patch(`/documents/${id}`, data).then(r => r.data as import('../types').LedgerDocument),
  remove: (id: string) => api.delete(`/documents/${id}`).then(r => r.data),
  /** The bytes, as a blob — the caller turns it into an object URL for preview,
   *  or clicks it through a temporary <a download>. Auth rides the header, so
   *  no URL to a document ever exists outside this tab. */
  getFileBlob: (id: string) =>
    api.get(`/documents/${id}/file`, { responseType: 'blob', timeout: 120000 })
      .then(r => r.data as Blob),

  // ── Phase 8.3: what the documents SAY ──────────────────────────────────────
  /** Every fact read out of every document the caller may see. One call: the
   *  facts follow their documents, so there is one visibility check, not one
   *  per document. */
  facts: () => api.get('/documents/facts')
    .then(r => r.data as import('../types').DocumentFact[]),
  /** Read one document and store what it says. Owner-only, and slow — it is a
   *  model reading a PDF. */
  extract: (id: string) =>
    api.post(`/documents/${id}/extract`, {}, { timeout: 180000 }).then(r => r.data as {
      facts: import('../types').DocumentFact[];
      discarded: { field: string; reason: string }[];
      status: 'read' | 'nothing-found';
      kept: number;
    }),
  /** The user's verdict on one reading: confirm, reject, or correct the value. */
  updateFact: (factId: string, data: { status?: string; value?: string }) =>
    api.patch(`/documents/facts/${factId}`, data)
      .then(r => r.data as import('../types').DocumentFact),
};

// ─── INSURANCE (Phase 8.2) ───────────────────────────────────────────────────
//
// Policies and their premium history in one round trip — the history is only
// useful beside the policy it prices, and two calls would let one arrive
// without the other and briefly report a change that never happened.
export const insuranceApi = {
  getAll: () => api.get('/insurance').then(r => r.data as {
    policies: import('../types').InsurancePolicy[];
    history: import('../types').InsurancePremiumRecord[];
  }),
  create: (data: object) =>
    api.post('/insurance', data).then(r => r.data as import('../types').InsurancePolicy),
  update: (id: string, data: object) =>
    api.put(`/insurance/${id}`, data).then(r => r.data as import('../types').InsurancePolicy),
  remove: (id: string) => api.delete(`/insurance/${id}`).then(r => r.data),
  /** Record what the premium became, and from when. */
  createPremiumRecord: (data: object) =>
    api.post('/insurance/history', data).then(r => r.data as import('../types').InsurancePremiumRecord),
  deletePremiumRecord: (id: string) => api.delete(`/insurance/history/${id}`).then(r => r.data),
};

// Upload
export const uploadApi = {
  parseDocument: (file: File, documentType: string) => {
    const form = new FormData();
    form.append('file', file);
    form.append('document_type', documentType);
    return api.post('/upload/parse', form, { headers: { 'Content-Type': 'multipart/form-data' } }).then(r => r.data);
  },
};

export default api;
