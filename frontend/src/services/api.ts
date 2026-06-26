import axios from 'axios';
import { useStore } from '../store';

// VITE_API_URL points at the backend: the Render URL in production, and
// http://localhost:3001 in development (see frontend/.env.development). If unset,
// it falls back to '' so relative '/api' paths resolve against the current origin.
// Exported so non-axios callers (raw fetch in dataService) hit the same backend.
export const API_BASE = import.meta.env.VITE_API_URL ?? '';
const api = axios.create({ baseURL: `${API_BASE}/api` });

api.interceptors.request.use((config) => {
  const token = useStore.getState().token;
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

api.interceptors.response.use(
  (r) => r,
  (err) => {
    const state = useStore.getState();
    // Don't log out demo/guest sessions — they have no real token
    if (err.response?.status === 401 && state.token !== 'demo-token') {
      // Grace window: the backend (Render free tier) may cold-start and emit
      // transient 401s for the burst of parallel bootstrap requests fired right
      // after login. Logging out on those bounces the user straight back to the
      // login screen (the "took 5 goes to log in" symptom). Within 20s of a
      // successful auth we ride out the transient instead of nuking the session;
      // a genuinely invalid token will still 401 on the next action and log out.
      const sinceAuth = Date.now() - (state.lastAuthMs || 0);
      if (sinceAuth > 20000) {
        state.logout();
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
  getGoals: () => api.get('/overview/goals').then(r => r.data),
  createGoal: (data: object) => api.post('/overview/goals', data).then(r => r.data),
  updateGoal: (id: string, data: object) => api.put(`/overview/goals/${id}`, data).then(r => r.data),
  deleteGoal: (id: string) => api.delete(`/overview/goals/${id}`).then(r => r.data),
  getNotifications: () => api.get('/overview/notifications').then(r => r.data),
  markNotificationRead: (id: string) => api.patch(`/overview/notifications/${id}/read`).then(r => r.data),
  markAllRead: () => api.patch('/overview/notifications/read-all').then(r => r.data),
  getBudgets: () => api.get('/overview/budget').then(r => r.data),
  createBudget: (data: object) => api.post('/overview/budget', data).then(r => r.data),
  updateBudget: (id: string, data: object) => api.put(`/overview/budget/${id}`, data).then(r => r.data),

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
};

// Accounts
export const accountsApi = {
  getAccounts: () => api.get('/accounts').then(r => r.data),
  createAccount: (data: object) => api.post('/accounts', data).then(r => r.data),
  updateAccount: (id: string, data: object) => api.put(`/accounts/${id}`, data).then(r => r.data),
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
  getSuper: () => api.get('/investments/super').then(r => r.data),
  createSuper: (data: object) => api.post('/investments/super', data).then(r => r.data),
  updateSuper: (id: string, data: object) => api.put(`/investments/super/${id}`, data).then(r => r.data),
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
