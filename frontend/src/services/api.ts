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
    // Don't log out demo/guest sessions — they have no real token
    if (err.response?.status === 401 && useStore.getState().token !== 'demo-token') {
      useStore.getState().logout();
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
  getBills: () => api.get('/overview/bills').then(r => r.data),
  createBill: (data: object) => api.post('/overview/bills', data).then(r => r.data),
  updateBill: (id: string, data: object) => api.put(`/overview/bills/${id}`, data).then(r => r.data),
  payBill: (id: string) => api.patch(`/overview/bills/${id}/pay`).then(r => r.data),
  deleteBill: (id: string) => api.delete(`/overview/bills/${id}`).then(r => r.data),
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
};

// Investments
export const investmentsApi = {
  getInvestments: () => api.get('/investments').then(r => r.data),
  createInvestment: (data: object) => api.post('/investments', data).then(r => r.data),
  updateInvestment: (id: string, data: object) => api.put(`/investments/${id}`, data).then(r => r.data),
  deleteInvestment: (id: string) => api.delete(`/investments/${id}`).then(r => r.data),
  searchTicker: (q: string, market: string) => api.get('/investments/search', { params: { q, market } }).then(r => r.data),
  getPrice: (ticker: string, market: string) => api.get(`/investments/price/${ticker}`, { params: { market } }).then(r => r.data),
  getSuper: () => api.get('/investments/super').then(r => r.data),
  createSuper: (data: object) => api.post('/investments/super', data).then(r => r.data),
  updateSuper: (id: string, data: object) => api.put(`/investments/super/${id}`, data).then(r => r.data),
};

// Income
export const incomeApi = {
  getIncome: () => api.get('/income').then(r => r.data),
  createIncome: (data: object) => api.post('/income', data).then(r => r.data),
  updateIncome: (id: string, data: object) => api.put(`/income/${id}`, data).then(r => r.data),
  deleteIncome: (id: string) => api.delete(`/income/${id}`).then(r => r.data),
  approveIncome: (id: string) => api.post(`/income/${id}/approve`).then(r => r.data),
  getTax: (fy?: string) => api.get('/income/tax', { params: { fy } }).then(r => r.data),
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
