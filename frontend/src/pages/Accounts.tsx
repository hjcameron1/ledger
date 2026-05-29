import { useState, useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import Layout from '../components/layout/Layout';
import { useStore } from '../store';
import {
  accountsDS, creditCardsDS, transactionsDS, subscriptionsDS,
  parseDocument, basiqDS, pendingPaymentsDS,
} from '../services/dataService';
import { autoCategory, formatCurrency, formatDate, daysUntil } from '../utils/format';
import {
  detectRecurringPatterns, findMatchingSubscription, findCrossAccountDuplicate,
  normaliseMerchant, isPatternDismissed, dismissPattern, clearDismissedForAccount,
  type RecurringPattern,
} from '../utils/recurringDetection';
import type { CreditCard } from '../types';
import Card from '../components/common/Card';
import Modal from '../components/common/Modal';
import Button from '../components/common/Button';
import Input, { Select, Toggle } from '../components/common/Input';

const ACCOUNT_TYPES = [
  { value: 'Everyday', label: 'Everyday' },
  { value: 'Savings', label: 'Savings' },
  { value: 'Offset', label: 'Offset' },
  { value: 'High Yield Savings', label: 'High Yield Savings' },
  { value: 'Transaction', label: 'Transaction' },
  { value: 'Joint', label: 'Joint' },
  { value: 'Term Deposit', label: 'Term Deposit' },
  { value: 'Foreign Currency', label: 'Foreign Currency' },
  { value: 'Business', label: 'Business' },
  { value: 'Other', label: 'Other' },
];

const TABS = ['Accounts', 'Credit Cards', 'Subscriptions', 'Transactions'] as const;
type Tab = typeof TABS[number];

export default function Accounts() {
  const {
    user, accounts, setAccounts, creditCards, setCreditCards,
    transactions, setTransactions, subscriptions, setSubscriptions,
    pendingPayments, setPendingPayments,
    basiqUserId, setBasiqUserId,
  } = useStore();

  const [searchParams] = useSearchParams();
  const [activeTab, setActiveTab] = useState<Tab>('Accounts');
  const [addAccountOpen, setAddAccountOpen] = useState(false);
  const [addCardOpen, setAddCardOpen] = useState(false);
  const [addSubOpen, setAddSubOpen] = useState(false);
  const [addTxOpen, setAddTxOpen] = useState(false);
  const [txSearch, setTxSearch] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState<{ type: 'account' | 'card' | 'sub'; id: string } | null>(null);
  const [linkedSubsPrompt, setLinkedSubsPrompt] = useState<{
    accountId: string;
    type: 'account' | 'card';
    subNames: string[];
    subIds: string[];
  } | null>(null);
  const [expandedCardId, setExpandedCardId] = useState<string | null>(null);
  const [uploadCardOpen, setUploadCardOpen] = useState<string | null>(null);
  const [subUploadOpen, setSubUploadOpen] = useState(false);
  const [markPaidCardId, setMarkPaidCardId] = useState<string | null>(null);
  const [detailAccountId, setDetailAccountId] = useState<string | null>(null);
  const [detailCardId, setDetailCardId] = useState<string | null>(null);

  // Duplicate / recurring detection
  type DuplicatePrompt = { message: string; onAddAnyway: () => void };
  type RecurringPrompt = { merchant: string; amount: number; onSubscribe: () => void; onKeep: () => void };
  const [duplicatePrompt, setDuplicatePrompt] = useState<DuplicatePrompt | null>(null);
  const [recurringPrompt, setRecurringPrompt] = useState<RecurringPrompt | null>(null);

  // Background recurring-pattern detection — queue approach
  const bgActiveRef  = useRef(false);                         // true while a queue is showing
  const [bgPatterns, setBgPatterns]   = useState<RecurringPattern[]>([]);
  const [bgPatternIdx, setBgPatternIdx] = useState(0);
  const [toast, setToast] = useState<string | null>(null);

  // Basiq live-sync state
  const [basiqConnectOpen, setBasiqConnectOpen] = useState(false);
  const [basiqMobile, setBasiqMobile] = useState('');
  const [basiqConnecting, setBasiqConnecting] = useState(false);
  const [basiqSyncing, setBasiqSyncing] = useState(false);
  const [basiqMsg, setBasiqMsg] = useState<{ text: string; type: 'success' | 'error' | 'info' } | null>(null);

  /** Step 1 – open Basiq consent UI in a new tab */
  const handleConnectBank = async () => {
    const email = user?.email ?? 'demo@ledger.app';
    // Normalise mobile: allow 04xxxxxxxx → +614xxxxxxxx
    const mobile = basiqMobile.trim().replace(/^0/, '+61');
    if (!mobile || !/^\+\d{10,15}$/.test(mobile)) {
      setBasiqMsg({ text: 'Please enter a valid mobile number (e.g. 0412 345 678)', type: 'error' });
      return;
    }
    setBasiqConnecting(true);
    setBasiqMsg(null);
    try {
      const { basiqUserId: uid, authLink } = await basiqDS.connect(email, mobile);
      setBasiqUserId(uid);
      setBasiqConnectOpen(false);
      window.open(authLink, '_blank', 'noopener,noreferrer');
      setBasiqMsg({ text: 'Bank consent page opened in a new tab. Connect your bank, then click "Sync live balances" below.', type: 'info' });
    } catch (err) {
      setBasiqMsg({ text: err instanceof Error ? err.message : 'Connection failed', type: 'error' });
    } finally {
      setBasiqConnecting(false);
    }
  };

  /** Step 2 – pull live accounts & transactions, merge into store */
  const handleSyncBasiq = async () => {
    if (!basiqUserId) return;
    setBasiqSyncing(true);
    setBasiqMsg(null);
    try {
      // Fetch accounts from Basiq
      const { bankAccounts: liveBankAccounts, creditCards: liveCreditCards } =
        await basiqDS.fetchAccounts(basiqUserId);

      // ── Merge bank accounts ──────────────────────────────────────────────
      // Match by basiq_account_id first, then BSB+account_number fallback
      const mergedAccounts = [...accounts];
      const newAccountCount = { current: 0 };

      for (const live of liveBankAccounts) {
        const idx = mergedAccounts.findIndex(a =>
          a.basiq_account_id === live.basiq_account_id ||
          (a.bsb && a.account_number && a.bsb === live.bsb && a.account_number === live.account_number)
        );
        // null → undefined for optional BankAccount fields
        const liveNorm = {
          ...live,
          bsb: live.bsb ?? undefined,
          account_number: live.account_number ?? undefined,
        };
        if (idx >= 0) {
          // Update existing: override balance & live-sync fields, keep local id/user_id
          mergedAccounts[idx] = {
            ...mergedAccounts[idx],
            ...liveNorm,
            id: mergedAccounts[idx].id,
            user_id: mergedAccounts[idx].user_id,
            updated_at: new Date().toISOString(),
          };
        } else {
          // New account discovered via Basiq
          newAccountCount.current++;
          mergedAccounts.push({
            ...liveNorm,
            id: crypto.randomUUID(),
            user_id: user?.id ?? 'local',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          });
        }
      }
      setAccounts(mergedAccounts);

      // ── Merge credit cards ───────────────────────────────────────────────
      const mergedCards = [...creditCards];

      for (const live of liveCreditCards) {
        const idx = mergedCards.findIndex(c => c.basiq_account_id === live.basiq_account_id);
        if (idx >= 0) {
          mergedCards[idx] = {
            ...mergedCards[idx],
            ...live,
            id: mergedCards[idx].id,
            user_id: mergedCards[idx].user_id,
            updated_at: new Date().toISOString(),
          };
        } else {
          mergedCards.push({
            ...live,
            id: crypto.randomUUID(),
            user_id: user?.id ?? 'local',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          });
        }
      }
      setCreditCards(mergedCards);

      // ── Fetch & merge transactions (best-effort) ─────────────────────────
      let newTxnCount = 0;
      let txnError = false;
      try {
        const liveTxns = await basiqDS.fetchTransactions(basiqUserId);

        // Map Basiq account IDs → local account IDs
        const basiqToLocalId = new Map<string, string>(
          mergedAccounts.filter(a => a.basiq_account_id).map(a => [a.basiq_account_id!, a.id])
        );

        // Skip transactions we've already imported
        const existingBasiqIds = new Set(transactions.map(t => t.basiq_tx_id).filter(Boolean));

        const newTxns = liveTxns
          .filter(t => !existingBasiqIds.has(t.basiq_tx_id))
          .map(t => ({
            id: crypto.randomUUID(),
            user_id: user?.id ?? 'local',
            account_id: basiqToLocalId.get(t.account_id) ?? t.account_id,
            account_type: 'bank' as const,
            date: t.date,
            merchant: t.merchant,
            amount: t.amount,
            currency: t.currency,
            category: t.category ?? autoCategory(t.merchant),
            notes: undefined,
            is_duplicate_flagged: false,
            is_subscription: false,
            basiq_tx_id: t.basiq_tx_id,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          }));

        if (newTxns.length > 0) {
          // Use transactionsDS.add for each new tx so reconciliation runs automatically
          for (const tx of newTxns) {
            transactionsDS.add({
              account_id: tx.account_id,
              account_type: tx.account_type,
              date: tx.date,
              merchant: tx.merchant,
              amount: tx.amount,
              currency: tx.currency,
              category: tx.category,
              is_duplicate_flagged: tx.is_duplicate_flagged,
              is_subscription: tx.is_subscription,
              basiq_tx_id: tx.basiq_tx_id,
            });
          }
          setTransactions(transactionsDS.getAll());
          setPendingPayments(pendingPaymentsDS.getAll());
        }
        newTxnCount = newTxns.length;
      } catch {
        txnError = true;
      }

      // ── Build result message ─────────────────────────────────────────────
      const parts = [
        `${liveBankAccounts.length} account${liveBankAccounts.length !== 1 ? 's' : ''} synced`,
        liveCreditCards.length ? `${liveCreditCards.length} card${liveCreditCards.length !== 1 ? 's' : ''}` : null,
        newAccountCount.current ? `${newAccountCount.current} new account${newAccountCount.current !== 1 ? 's' : ''} added` : null,
        !txnError ? `${newTxnCount} new transaction${newTxnCount !== 1 ? 's' : ''}` : 'transactions unavailable',
      ].filter(Boolean);

      setBasiqMsg({ text: parts.join(' · '), type: 'success' });
    } catch (err) {
      setBasiqMsg({ text: err instanceof Error ? err.message : 'Sync failed', type: 'error' });
    } finally {
      setBasiqSyncing(false);
    }
  };

  const currency = user?.currency_preference ?? 'AUD';
  const totalBank = accounts.reduce((s, a) => s + a.balance, 0);
  const totalCC   = creditCards.reduce((s, c) => s + c.balance_owing, 0);

  useEffect(() => {
    const add = searchParams.get('add');
    if (add === 'bank')         { setActiveTab('Accounts');      setAddAccountOpen(true); }
    if (add === 'credit-card')  { setActiveTab('Credit Cards');  setAddCardOpen(true);    }
    if (add === 'subscription') { setActiveTab('Subscriptions'); setAddSubOpen(true);     }
    if (add === 'transaction')  { setActiveTab('Transactions');  setAddTxOpen(true);      }
  }, [searchParams]);

  // Background recurring-payment detection — runs 800ms after transactions change.
  // Collects ALL undismissed patterns and queues them for display one-at-a-time.
  useEffect(() => {
    if (transactions.length < 2) return;
    const timer = setTimeout(() => {
      if (bgActiveRef.current) return; // already showing a queue — don't reset
      const all = detectRecurringPatterns(transactions, subscriptions);
      const undismissed = all.filter(p => !isPatternDismissed(p));
      if (undismissed.length > 0) {
        bgActiveRef.current = true;
        setBgPatterns(undismissed);
        setBgPatternIdx(0);
      }
    }, 800);
    return () => clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transactions.length, subscriptions.length]);

  // Auto-dismiss toast after 4 seconds
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const displayedTransactions = transactionsDS.getAll({ search: txSearch || undefined });

  const subMonthly = subscriptions.reduce((s, sub) => {
    const m: Record<string, number> = { weekly: 4.33, fortnightly: 2.17, monthly: 1, quarterly: 0.333, annually: 0.083 };
    return s + sub.amount * (m[sub.frequency] ?? 1);
  }, 0);

  /** Actually remove the account/card (and optionally its linked subscriptions). */
  const performAccountDelete = (id: string, type: 'account' | 'card', deleteLinkedSubs: boolean) => {
    if (deleteLinkedSubs) {
      subscriptions
        .filter(s => s.account_id === id)
        .forEach(s => subscriptionsDS.remove(s.id));
      setSubscriptions(subscriptionsDS.getAll());
    }
    clearDismissedForAccount(id);
    if (type === 'account') {
      accountsDS.remove(id);
      setAccounts(accountsDS.getAll());
    } else {
      creditCardsDS.remove(id);
      setCreditCards(creditCardsDS.getAll());
    }
  };

  const handleDelete = () => {
    if (!deleteConfirm) return;
    if (deleteConfirm.type === 'sub') {
      subscriptionsDS.remove(deleteConfirm.id);
      setSubscriptions(subscriptionsDS.getAll());
      setDeleteConfirm(null);
      return;
    }
    // Account or card — check for linked subscriptions first
    const linked = subscriptions.filter(s => s.account_id === deleteConfirm.id);
    if (linked.length > 0) {
      setLinkedSubsPrompt({
        accountId: deleteConfirm.id,
        type: deleteConfirm.type,
        subNames: linked.map(s => s.name),
        subIds: linked.map(s => s.id),
      });
      setDeleteConfirm(null);
      return;
    }
    // No linked subs — proceed directly
    performAccountDelete(deleteConfirm.id, deleteConfirm.type, false);
    setDeleteConfirm(null);
  };

  return (
    <Layout>
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-semibold mb-4">Accounts</h1>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Card padding="sm">
            <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">Total Bank Balance</p>
            <p className="text-xl font-semibold amount mt-1">{formatCurrency(totalBank, currency)}</p>
          </Card>
          {totalCC > 0 && (
            <>
              <Card padding="sm">
                <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">Credit Card Owing</p>
                <p className="text-xl font-semibold amount text-[#ef4444] mt-1">{formatCurrency(totalCC, currency)}</p>
              </Card>
              <Card padding="sm">
                <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">Net Available</p>
                <p className={`text-xl font-semibold amount mt-1 ${totalBank - totalCC < 0 ? 'text-[#ef4444]' : ''}`}>
                  {formatCurrency(totalBank - totalCC, currency)}
                </p>
              </Card>
            </>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-[#e5e5e5] dark:border-[#2a2a2a] mb-6 overflow-x-auto">
        {TABS.map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-2.5 text-sm font-medium whitespace-nowrap transition-all duration-150 border-b-2
              ${activeTab === tab
                ? 'text-[#3b7dd8] border-[#3b7dd8]'
                : 'text-[#6b6b6b] dark:text-[#a0a0a0] border-transparent hover:text-[#0f0f0f] dark:hover:text-[#f5f5f5]'}`}
          >
            {tab}
            {tab === 'Transactions' && displayedTransactions.length > 0 && (
              <span className="ml-1.5 badge bg-[#f5f5f5] dark:bg-[#2a2a2a] text-[#6b6b6b] dark:text-[#a0a0a0]">{displayedTransactions.length}</span>
            )}
          </button>
        ))}
      </div>

      {/* ── ACCOUNTS TAB ── */}
      {activeTab === 'Accounts' && (
        <div>
          {/* Basiq status banner */}
          {basiqMsg && (
            <div className={`mb-4 px-3 py-2.5 rounded-[8px] text-sm flex items-start justify-between gap-2
              ${basiqMsg.type === 'success' ? 'bg-[#22c55e]/10 text-[#22c55e]' :
                basiqMsg.type === 'error'   ? 'bg-[#ef4444]/10 text-[#ef4444]' :
                                              'bg-[#3b7dd8]/10 text-[#3b7dd8]'}`}>
              <span>{basiqMsg.text}</span>
              <button onClick={() => setBasiqMsg(null)} className="opacity-60 hover:opacity-100 flex-shrink-0">✕</button>
            </div>
          )}

          <div className="flex justify-between items-center mb-4 gap-2 flex-wrap">
            <h2 className="font-semibold">Bank Accounts ({accounts.length})</h2>
            <div className="flex gap-2 flex-wrap">
              {/* Live sync controls */}
              {basiqUserId ? (
                <>
                  <Button
                    variant="secondary" size="sm"
                    onClick={handleSyncBasiq}
                    disabled={basiqSyncing}
                  >
                    {basiqSyncing ? '⏳ Syncing…' : '↻ Sync live balances'}
                  </Button>
                  <button
                    onClick={async () => {
                      try {
                        const mobile = basiqMobile.trim().replace(/^0/, '+61');
                        const link = await basiqDS.getAuthLink(basiqUserId, mobile || undefined);
                        window.open(link, '_blank', 'noopener,noreferrer');
                        setBasiqMsg({ text: 'Consent page opened. Add another bank, then sync.', type: 'info' });
                      } catch { /* ignore */ }
                    }}
                    className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0] hover:underline px-1"
                    title="Add another bank"
                  >
                    + Add bank
                  </button>
                </>
              ) : (
                <Button
                  variant="secondary" size="sm"
                  onClick={() => setBasiqConnectOpen(true)}
                >
                  🔗 Connect live bank
                </Button>
              )}
              <Button variant="primary" size="sm" onClick={() => setAddAccountOpen(true)}>+ Add Account</Button>
            </div>
          </div>
          {accounts.length === 0 ? (
            <EmptyState icon="🏦" title="No bank accounts" description="Add your first bank account to get started." onAdd={() => setAddAccountOpen(true)} />
          ) : (
            <div className="space-y-3">
              {accounts.map(acc => (
                <Card key={acc.id} onClick={() => setDetailAccountId(acc.id)} className="cursor-pointer hover:shadow-md transition-shadow">
                  <div className="flex items-start justify-between">
                    <div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <h3 className="font-medium">{acc.name}</h3>
                        <span className="badge bg-[#f5f5f5] dark:bg-[#2a2a2a] text-[#6b6b6b] dark:text-[#a0a0a0]">{acc.account_type}</span>
                      </div>
                      <p className="text-sm text-[#6b6b6b] dark:text-[#a0a0a0]">{acc.institution}</p>
                      {acc.bsb && <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0] mt-0.5">BSB: {acc.bsb} · ACC: {acc.account_number}</p>}
                    </div>
                    <div className="text-right ml-4 flex-shrink-0">
                      <p className="text-lg font-semibold amount">{formatCurrency(acc.balance, acc.currency)}</p>
                      {acc.currency !== currency && <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">{acc.currency}</p>}
                    </div>
                  </div>
                  <div className="flex items-center justify-between mt-3 pt-3 border-t border-[#e5e5e5] dark:border-[#2a2a2a]">
                    <span className={`text-xs ${!acc.is_manual ? 'text-[#22c55e]' : 'text-[#6b6b6b] dark:text-[#a0a0a0]'}`}>
                      {!acc.is_manual ? '● Live sync' : 'Manual entry'}
                    </span>
                    <button onClick={e => { e.stopPropagation(); setDeleteConfirm({ type: 'account', id: acc.id }); }} className="text-xs text-[#ef4444] hover:underline">Remove</button>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── CREDIT CARDS TAB ── */}
      {activeTab === 'Credit Cards' && (
        <div>
          <div className="flex justify-between items-center mb-4">
            <h2 className="font-semibold">Credit Cards ({creditCards.length})</h2>
            <Button variant="primary" size="sm" onClick={() => setAddCardOpen(true)}>+ Add Card</Button>
          </div>
          {creditCards.length === 0 ? (
            <EmptyState icon="💳" title="No credit cards" description="Add a credit card to track utilisation and due dates." onAdd={() => setAddCardOpen(true)} />
          ) : (
            <div className="space-y-3">
              {creditCards.map(card => {
                const utilisation = card.credit_limit > 0 ? (card.balance_owing / card.credit_limit) * 100 : 0;
                const dueInDays = card.due_date ? daysUntil(card.due_date) : null;
                const cardTxns = [...transactions]
                  .filter(t => t.account_id === card.id && t.account_type === 'credit_card')
                  .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
                const isExpanded = expandedCardId === card.id;
                const cardPayments = pendingPayments.filter(p => p.credit_card_id === card.id);
                const hasPending = cardPayments.some(p => p.status === 'pending');
                const isPaidInFull = card.balance_owing <= 0;
                const lastPayment = card.last_payment_amount != null ? card.last_payment_amount : null;
                return (
                  <Card key={card.id} onClick={() => setDetailCardId(card.id)} className="cursor-pointer hover:shadow-md transition-shadow">
                    <div className="flex items-start justify-between mb-3">
                      <div>
                        <div className="flex items-center gap-2 flex-wrap">
                          <h3 className="font-medium">{card.name}</h3>
                          {isPaidInFull && (
                            <span className="badge bg-[#22c55e]/15 text-[#22c55e]">Paid in full</span>
                          )}
                          {!isPaidInFull && hasPending && (
                            <span className="badge bg-[#f59e0b]/15 text-[#f59e0b]">Payment pending</span>
                          )}
                        </div>
                        <p className="text-sm text-[#6b6b6b] dark:text-[#a0a0a0]">{card.institution}</p>
                        {lastPayment != null && card.last_payment_date && (
                          <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0] mt-0.5">
                            Last payment: {formatCurrency(lastPayment, card.currency)} on {formatDate(card.last_payment_date)}
                          </p>
                        )}
                        {!isPaidInFull && lastPayment != null && (
                          <p className="text-xs text-[#f59e0b] mt-0.5">
                            Partially paid — {formatCurrency(card.balance_owing, card.currency)} remaining
                          </p>
                        )}
                      </div>
                      <div className="text-right">
                        <p className={`text-lg font-semibold amount ${isPaidInFull ? 'text-[#22c55e]' : 'text-[#ef4444]'}`}>
                          {formatCurrency(card.balance_owing, card.currency)}
                        </p>
                        <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">of {formatCurrency(card.credit_limit, card.currency)} limit</p>
                      </div>
                    </div>
                    <div className="mb-2">
                      <div className="flex justify-between text-xs mb-1">
                        <span className="text-[#6b6b6b] dark:text-[#a0a0a0]">Utilisation</span>
                        <span className={utilisation > 75 ? 'text-[#ef4444]' : utilisation > 50 ? 'text-[#f59e0b]' : 'text-[#22c55e]'}>{utilisation.toFixed(0)}%</span>
                      </div>
                      <div className="h-1.5 bg-[#e5e5e5] dark:bg-[#2a2a2a] rounded-full overflow-hidden">
                        <div className={`h-full rounded-full ${utilisation > 75 ? 'bg-[#ef4444]' : utilisation > 50 ? 'bg-[#f59e0b]' : 'bg-[#22c55e]'}`} style={{ width: `${Math.min(100, utilisation)}%` }} />
                      </div>
                    </div>
                    <div className="flex items-center justify-between text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">
                      {card.minimum_payment ? <span>Min: {formatCurrency(card.minimum_payment, card.currency)}</span> : <span />}
                      <div className="flex items-center gap-3">
                        {dueInDays !== null && (
                          <span className={dueInDays <= 7 ? 'text-[#ef4444] font-medium' : ''}>
                            Due: {formatDate(card.due_date!)} {dueInDays <= 7 ? '⚠️' : ''}
                          </span>
                        )}
                        {!isPaidInFull && !hasPending && (
                          <button
                            onClick={e => { e.stopPropagation(); setMarkPaidCardId(card.id); }}
                            className="text-[#3b7dd8] hover:underline font-medium"
                          >
                            Mark as paid
                          </button>
                        )}
                        <button
                          onClick={e => { e.stopPropagation(); setExpandedCardId(isExpanded ? null : card.id); }}
                          className="text-[#3b7dd8] hover:underline"
                        >
                          {isExpanded ? 'Hide' : `Transactions${cardTxns.length ? ` (${cardTxns.length})` : ''}`}
                        </button>
                        <button
                          onClick={e => { e.stopPropagation(); setUploadCardOpen(card.id); }}
                          className="text-[#3b7dd8] hover:underline"
                        >
                          Upload statement
                        </button>
                        <button onClick={e => { e.stopPropagation(); setDeleteConfirm({ type: 'card', id: card.id }); }} className="text-[#ef4444] hover:underline">Remove</button>
                      </div>
                    </div>
                    {/* ── Statement panel ── */}
                    {isExpanded && (
                      <div className="mt-3 pt-3 border-t border-[#e5e5e5] dark:border-[#2a2a2a]">
                        {cardTxns.length === 0 ? (
                          <div className="text-center py-4">
                            <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0] mb-2">No statement transactions yet</p>
                            <Button variant="secondary" size="sm" onClick={e => { e.stopPropagation(); setUploadCardOpen(card.id); }}>Upload statement</Button>
                          </div>
                        ) : (
                          <>
                            <div className="space-y-px max-h-52 overflow-y-auto">
                              {cardTxns.slice(0, 30).map(tx => (
                                <div key={tx.id} className="flex items-center justify-between px-1 py-1.5 text-xs rounded hover:bg-[#f5f5f5] dark:hover:bg-[#1a1a1a]">
                                  <div>
                                    <p className="font-medium">{tx.merchant}</p>
                                    <p className="text-[#6b6b6b] dark:text-[#a0a0a0]">{formatDate(tx.date)} · {tx.category}</p>
                                  </div>
                                  <span className={tx.amount < 0 ? 'text-[#ef4444]' : 'text-[#22c55e]'}>
                                    {tx.amount < 0 ? '-' : '+'}{formatCurrency(Math.abs(tx.amount), tx.currency)}
                                  </span>
                                </div>
                              ))}
                              {cardTxns.length > 30 && (
                                <p className="text-xs text-center text-[#6b6b6b] dark:text-[#a0a0a0] py-1.5">
                                  +{cardTxns.length - 30} more — see Transactions tab
                                </p>
                              )}
                            </div>
                            <div className="mt-2 text-right">
                              <button onClick={e => { e.stopPropagation(); setUploadCardOpen(card.id); }} className="text-xs text-[#3b7dd8] hover:underline">
                                Upload another statement
                              </button>
                            </div>
                          </>
                        )}
                      </div>
                    )}
                  </Card>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ── SUBSCRIPTIONS TAB ── */}
      {activeTab === 'Subscriptions' && (
        <div>
          <div className="flex justify-between items-center mb-2">
            <h2 className="font-semibold">Subscriptions</h2>
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" onClick={() => setSubUploadOpen(true)}>Import from statement</Button>
              <Button variant="primary" size="sm" onClick={() => setAddSubOpen(true)}>+ Add</Button>
            </div>
          </div>
          <p className="text-sm text-[#6b6b6b] dark:text-[#a0a0a0] mb-4">
            {subscriptions.length} active · {formatCurrency(subMonthly, currency)}/month · {formatCurrency(subMonthly * 12, currency)}/year
          </p>
          {subscriptions.length === 0 ? (
            <EmptyState icon="🔄" title="No subscriptions" description="Subscriptions are auto-detected from transactions, or add them manually." onAdd={() => setAddSubOpen(true)} />
          ) : (
            <div className="space-y-2">
              {subscriptions.map(sub => (
                <div key={sub.id} className="flex items-center justify-between p-3 card">
                  <div>
                    <p className="font-medium text-sm">{sub.name}</p>
                    <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">
                      {sub.category} · {sub.frequency}
                      {sub.next_charge_date && ` · Next: ${formatDate(sub.next_charge_date)}`}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-semibold amount">{formatCurrency(sub.amount, sub.currency)}</span>
                    <button onClick={() => setDeleteConfirm({ type: 'sub', id: sub.id })} className="text-xs text-[#6b6b6b] hover:text-[#ef4444] transition-colors">✕</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── TRANSACTIONS TAB ── */}
      {activeTab === 'Transactions' && (
        <div>
          <div className="mb-4 flex gap-3">
            <input className="input flex-1" placeholder="Search transactions…" value={txSearch} onChange={e => setTxSearch(e.target.value)} />
            <Button variant="primary" size="sm" onClick={() => setAddTxOpen(true)}>+ Add</Button>
          </div>
          {displayedTransactions.length === 0 ? (
            <div className="text-center py-12">
              <p className="text-sm text-[#6b6b6b] dark:text-[#a0a0a0] mb-4">{txSearch ? 'No matching transactions' : 'No transactions yet'}</p>
              {!txSearch && <Button variant="secondary" size="sm" onClick={() => setAddTxOpen(true)}>+ Add Transaction</Button>}
            </div>
          ) : (
            <div className="space-y-px">
              {displayedTransactions.map(tx => {
                const EMOJI: Record<string, string> = {
                  Groceries: '🛒', Dining: '🍔', Entertainment: '🎬', Fuel: '⛽',
                  Travel: '✈️', Transport: '🚗', Fitness: '💪', Health: '💊',
                  Electronics: '💻', Insurance: '🛡️', Utilities: '⚡', Rent: '🏠',
                };
                return (
                  <div key={tx.id} className={`flex items-center justify-between px-3 py-3 rounded-[8px] hover:bg-[#f5f5f5] dark:hover:bg-[#1a1a1a] transition-colors ${tx.is_duplicate_flagged ? 'border-l-2 border-[#f59e0b]' : ''}`}>
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 rounded-full bg-[#f5f5f5] dark:bg-[#2a2a2a] flex items-center justify-center text-sm flex-shrink-0">
                        {EMOJI[tx.category] ?? '💳'}
                      </div>
                      <div>
                        <p className="text-sm font-medium">{tx.merchant}</p>
                        <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">
                          {formatDate(tx.date)} · {tx.category}
                          {tx.is_duplicate_flagged && <span className="ml-1 text-[#f59e0b]">⚠ Possible duplicate</span>}
                        </p>
                      </div>
                    </div>
                    <span className={`text-sm font-semibold amount ${tx.amount < 0 ? 'text-[#ef4444]' : 'text-[#22c55e]'}`}>
                      {tx.amount < 0 ? '-' : '+'}{formatCurrency(Math.abs(tx.amount), tx.currency)}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ── MODALS ── */}
      <AddAccountModal
        isOpen={addAccountOpen}
        onClose={() => setAddAccountOpen(false)}
        onSave={(formData, doAdd) => {
          const dup = accounts.find(a =>
            (formData.bsb && formData.account_number && a.bsb === formData.bsb && a.account_number === formData.account_number) ||
            (a.name.toLowerCase() === formData.name.toLowerCase() && a.institution.toLowerCase() === formData.institution.toLowerCase())
          );
          const finish = () => { doAdd(); setAddAccountOpen(false); setAccounts(accountsDS.getAll()); setTransactions(transactionsDS.getAll()); };
          if (dup) {
            setDuplicatePrompt({ message: `This looks like a duplicate of "${dup.name}" (${dup.institution}).`, onAddAnyway: finish });
          } else {
            finish();
          }
        }}
      />

      <AddCreditCardModal
        isOpen={addCardOpen}
        onClose={() => setAddCardOpen(false)}
        onSave={(formData, doAdd) => {
          const dup = creditCards.find(c =>
            c.name.toLowerCase() === formData.name.toLowerCase() && c.institution.toLowerCase() === formData.institution.toLowerCase()
          );
          const finish = () => { doAdd(); setAddCardOpen(false); setCreditCards(creditCardsDS.getAll()); setTransactions(transactionsDS.getAll()); };
          if (dup) {
            setDuplicatePrompt({ message: `This looks like a duplicate of "${dup.name}" (${dup.institution}).`, onAddAnyway: finish });
          } else {
            finish();
          }
        }}
      />

      <AddSubscriptionModal
        isOpen={addSubOpen}
        onClose={() => setAddSubOpen(false)}
        onSave={(data) => {
          const d = data as Parameters<typeof subscriptionsDS.add>[0];
          const dup = subscriptions.find(s => s.name.toLowerCase() === d.name.toLowerCase());
          const doAdd = () => {
            subscriptionsDS.add(d);
            setSubscriptions(subscriptionsDS.getAll());
            setAddSubOpen(false);
          };
          if (dup) {
            setDuplicatePrompt({ message: `A subscription named "${dup.name}" already exists.`, onAddAnyway: doAdd });
          } else {
            doAdd();
          }
        }}
      />

      <AddTransactionModal
        isOpen={addTxOpen}
        onClose={() => setAddTxOpen(false)}
        accounts={accounts}
        onSave={(data) => {
          const d = data as Parameters<typeof transactionsDS.add>[0];

          // ── 1. Check if this matches an existing subscription ──────────────
          const matchedSub = findMatchingSubscription(
            { merchant: d.merchant, amount: d.amount },
            subscriptions
          );
          if (matchedSub) {
            transactionsDS.add({ ...d, is_subscription: true });
            setTransactions(transactionsDS.getAll());
            setAddTxOpen(false);
            setToast(`Matched to subscription: ${matchedSub.name}`);
            return;
          }

          const doAdd = () => {
            transactionsDS.add(d);
            setTransactions(transactionsDS.getAll());
            setAddTxOpen(false);
          };

          // ── 2. Exact same-account duplicate check ──────────────────────────
          const exactDup = transactions.find(t =>
            t.account_id === d.account_id && t.merchant === d.merchant &&
            Math.abs(t.amount - d.amount) < 0.01 && t.date === d.date
          );
          if (exactDup) {
            setDuplicatePrompt({
              message: `A transaction for "${d.merchant}" of the same amount on the same date already exists.`,
              onAddAnyway: doAdd,
            });
            return;
          }

          // ── 3. Cross-account duplicate check ──────────────────────────────
          const crossDup = findCrossAccountDuplicate(
            { merchant: d.merchant, amount: d.amount, date: d.date, account_id: d.account_id ?? '' },
            transactions,
            (id) => accounts.find(a => a.id === id)?.name ?? creditCards.find(c => c.id === id)?.name ?? null
          );
          if (crossDup) {
            setDuplicatePrompt({
              message: `A payment to "${d.merchant}" for ${formatCurrency(Math.abs(d.amount), d.currency)} on ${formatDate(d.date)} already exists on "${crossDup.account}". Possible duplicate charge across two accounts?`,
              onAddAnyway: doAdd,
            });
            return;
          }

          // ── 4. Recurring-payment prompt (same merchant + similar amount, 2+ dates) ──
          const similar = transactions.filter(t =>
            t.merchant.toLowerCase() === d.merchant.toLowerCase() &&
            Math.abs(Math.abs(t.amount) - Math.abs(d.amount)) / Math.max(Math.abs(d.amount), 0.01) <= 0.02
          );
          const uniqueDates = new Set(similar.map(t => t.date));
          if (uniqueDates.size >= 2) {
            const absAmt = Math.abs(d.amount);
            const dates = [...uniqueDates].sort();
            const gaps = dates.slice(1).map((d2, i) =>
              (new Date(d2).getTime() - new Date(dates[i]).getTime()) / 86400000
            );
            const avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
            const freq = avgGap <= 10 ? 'weekly' : avgGap <= 20 ? 'fortnightly' : avgGap <= 45 ? 'monthly' : avgGap <= 100 ? 'quarterly' : 'annually';
            setRecurringPrompt({
              merchant: d.merchant,
              amount: absAmt,
              onSubscribe: () => {
                // Check subscription deduplication before creating
                const existingSub = subscriptions.find(s =>
                  normaliseMerchant(s.name) === normaliseMerchant(d.merchant) &&
                  Math.abs(s.amount - absAmt) / Math.max(s.amount, 0.01) <= 0.02
                );
                if (existingSub) {
                  setToast(`Already tracking ${existingSub.name} as a subscription — transactions linked.`);
                  setRecurringPrompt(null);
                  setAddTxOpen(false);
                  return;
                }
                subscriptionsDS.add({
                  name: d.merchant,
                  amount: absAmt,
                  currency: d.currency,
                  frequency: freq,
                  next_charge_date: d.date,
                  category: d.category || autoCategory(d.merchant),
                  is_auto_detected: false,
                });
                setSubscriptions(subscriptionsDS.getAll());
                setRecurringPrompt(null);
                setAddTxOpen(false);
              },
              onKeep: () => { setRecurringPrompt(null); doAdd(); },
            });
            return;
          }

          doAdd();
        }}
      />

      {/* Upload card statement */}
      {uploadCardOpen && (() => {
        const card = creditCards.find(c => c.id === uploadCardOpen);
        if (!card) return null;
        return (
          <UploadCardStatementModal
            isOpen={true}
            onClose={() => setUploadCardOpen(null)}
            card={card}
            onSaved={() => {
              setCreditCards(creditCardsDS.getAll());
              setTransactions(transactionsDS.getAll());
              setUploadCardOpen(null);
            }}
          />
        );
      })()}

      {/* Account detail modal */}
      {detailAccountId && (() => {
        const acc = accounts.find(a => a.id === detailAccountId);
        if (!acc) return null;
        return (
          <AccountDetailModal
            account={acc}
            transactions={transactions.filter(t => t.account_id === acc.id && t.account_type === 'bank')}
            currency={currency}
            onClose={() => setDetailAccountId(null)}
            onDeleteTx={(id) => { transactionsDS.remove(id); setTransactions(transactionsDS.getAll()); }}
            onCategoryChange={(id, category) => { transactionsDS.update(id, { category }); setTransactions(transactionsDS.getAll()); }}
          />
        );
      })()}

      {/* Credit card detail modal */}
      {detailCardId && (() => {
        const card = creditCards.find(c => c.id === detailCardId);
        if (!card) return null;
        return (
          <CardDetailModal
            card={card}
            transactions={transactions.filter(t => t.account_id === card.id && t.account_type === 'credit_card')}
            onClose={() => setDetailCardId(null)}
            onDeleteTx={(id) => { transactionsDS.remove(id); setTransactions(transactionsDS.getAll()); }}
            onCategoryChange={(id, category) => { transactionsDS.update(id, { category }); setTransactions(transactionsDS.getAll()); }}
          />
        );
      })()}

      {/* Mark credit card as paid */}
      {markPaidCardId && (() => {
        const card = creditCards.find(c => c.id === markPaidCardId);
        if (!card) return null;
        return (
          <MarkAsPaidModal
            isOpen={true}
            onClose={() => setMarkPaidCardId(null)}
            card={card}
            accounts={accounts}
            onSave={(amount, bankAccountId) => {
              pendingPaymentsDS.add({
                credit_card_id: card.id,
                bank_account_id: bankAccountId || undefined,
                amount,
              });
              setPendingPayments(pendingPaymentsDS.getAll());
              setMarkPaidCardId(null);
            }}
          />
        );
      })()}

      {/* Import subscriptions from statement */}
      <SubscriptionImportModal
        isOpen={subUploadOpen}
        onClose={() => setSubUploadOpen(false)}
        existingNames={new Set(subscriptions.map(s => s.name.toLowerCase()))}
        onImport={(selected) => {
          for (const sub of selected) {
            subscriptionsDS.add({
              name: sub.name,
              amount: sub.amount,
              currency: 'AUD',
              frequency: sub.frequency,
              next_charge_date: sub.next_charge_date ?? new Date().toISOString().split('T')[0],
              category: sub.category,
              is_auto_detected: false,
            });
          }
          setSubscriptions(subscriptionsDS.getAll());
          setSubUploadOpen(false);
        }}
      />

      {/* Delete confirm */}
      <Modal isOpen={!!deleteConfirm} onClose={() => setDeleteConfirm(null)} title="Confirm Removal" size="sm">
        <p className="text-sm text-[#6b6b6b] dark:text-[#a0a0a0] mb-4">Are you sure you want to remove this? This cannot be undone.</p>
        <div className="flex gap-3">
          <Button variant="secondary" onClick={() => setDeleteConfirm(null)} fullWidth>Cancel</Button>
          <Button variant="danger" onClick={handleDelete} fullWidth>Remove</Button>
        </div>
      </Modal>

      {/* Linked subscriptions prompt */}
      <Modal isOpen={!!linkedSubsPrompt} onClose={() => setLinkedSubsPrompt(null)} title="Linked Subscriptions" size="sm">
        {linkedSubsPrompt && (
          <>
            <p className="text-sm text-[#6b6b6b] dark:text-[#a0a0a0] mb-3">
              {linkedSubsPrompt.subNames.length} subscription{linkedSubsPrompt.subNames.length > 1 ? 's are' : ' is'} linked to this account:
            </p>
            <ul className="mb-4 space-y-1">
              {linkedSubsPrompt.subNames.map(name => (
                <li key={name} className="text-sm font-medium text-[#1a1a1a] dark:text-white pl-2 border-l-2 border-[#6c47ff]">{name}</li>
              ))}
            </ul>
            <p className="text-sm text-[#6b6b6b] dark:text-[#a0a0a0] mb-4">Delete them too, or keep them?</p>
            <div className="flex gap-3">
              <Button variant="secondary" onClick={() => setLinkedSubsPrompt(null)} fullWidth>Cancel</Button>
              <Button variant="secondary" onClick={() => {
                performAccountDelete(linkedSubsPrompt.accountId, linkedSubsPrompt.type, false);
                setLinkedSubsPrompt(null);
              }} fullWidth>Keep subscriptions</Button>
              <Button variant="danger" onClick={() => {
                performAccountDelete(linkedSubsPrompt.accountId, linkedSubsPrompt.type, true);
                setLinkedSubsPrompt(null);
              }} fullWidth>Delete all</Button>
            </div>
          </>
        )}
      </Modal>

      {/* Duplicate detection prompt */}
      <Modal isOpen={!!duplicatePrompt} onClose={() => setDuplicatePrompt(null)} title="Possible duplicate" size="sm">
        <p className="text-sm text-[#6b6b6b] dark:text-[#a0a0a0] mb-4">{duplicatePrompt?.message} Add anyway or discard?</p>
        <div className="flex gap-3">
          <Button variant="secondary" onClick={() => setDuplicatePrompt(null)} fullWidth>Discard</Button>
          <Button variant="primary" onClick={() => { duplicatePrompt?.onAddAnyway(); setDuplicatePrompt(null); }} fullWidth>Add anyway</Button>
        </div>
      </Modal>

      {/* Recurring payment prompt */}
      <Modal isOpen={!!recurringPrompt} onClose={() => { recurringPrompt?.onKeep(); }} title="Recurring payment detected" size="sm">
        <p className="text-sm text-[#6b6b6b] dark:text-[#a0a0a0] mb-4">
          Looks like a recurring payment to <strong>{recurringPrompt?.merchant}</strong>. Add as a subscription instead?
        </p>
        <div className="flex gap-3">
          <Button variant="secondary" onClick={() => recurringPrompt?.onKeep()} fullWidth>Keep as transaction</Button>
          <Button variant="primary" onClick={() => recurringPrompt?.onSubscribe()} fullWidth>Add as subscription</Button>
        </div>
      </Modal>

      {/* ── Background recurring-pattern queue modal ── */}
      {(() => {
        const pattern = bgPatterns[bgPatternIdx];
        if (!pattern) return null;
        const total = bgPatterns.length;
        const current = bgPatternIdx + 1;

        const advance = () => {
          const nextIdx = bgPatternIdx + 1;
          if (nextIdx >= bgPatterns.length) {
            // Queue exhausted
            bgActiveRef.current = false;
            setBgPatterns([]);
            setBgPatternIdx(0);
          } else {
            setBgPatternIdx(nextIdx);
          }
        };

        return (
          <Modal
            isOpen
            onClose={advance}
            title={`Recurring payment detected${total > 1 ? ` — ${current} of ${total}` : ''}`}
            size="sm"
          >
            {total > 1 && (
              <div className="flex gap-1 mb-4">
                {bgPatterns.map((_, i) => (
                  <div
                    key={i}
                    className={`h-1 flex-1 rounded-full ${i < current ? 'bg-[#3b7dd8]' : 'bg-[#e5e5e5] dark:bg-[#2a2a2a]'}`}
                  />
                ))}
              </div>
            )}
            <p className="text-sm text-[#6b6b6b] dark:text-[#a0a0a0] mb-1">
              We noticed <strong>{pattern.displayMerchant}</strong> charges{' '}
              <strong>{formatCurrency(pattern.amount, 'AUD')}</strong>{' '}
              <strong>{pattern.frequency}</strong> ({pattern.transactionIds.length} transactions).
            </p>
            <p className="text-sm text-[#6b6b6b] dark:text-[#a0a0a0] mb-5">
              Add it as a subscription to track it automatically?
            </p>
            <div className="flex gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  // Skip for now — don't permanently dismiss
                  advance();
                }}
              >
                Skip
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  // Permanently ignore — store in localStorage scoped to accountId
                  dismissPattern(pattern);
                  advance();
                }}
              >
                Ignore
              </Button>
              <Button
                variant="primary"
                size="sm"
                fullWidth
                onClick={() => {
                  // Subscription deduplication check
                  const existingSub = subscriptions.find(s =>
                    normaliseMerchant(s.name) === pattern.merchant &&
                    Math.abs(s.amount - pattern.amount) / Math.max(s.amount, 0.01) <= 0.02
                  );
                  dismissPattern(pattern);
                  advance();
                  if (existingSub) {
                    setToast(`Already tracking ${existingSub.name} as a subscription — transactions linked.`);
                    return;
                  }
                  subscriptionsDS.add({
                    name: pattern.displayMerchant,
                    amount: pattern.amount,
                    currency: 'AUD',
                    frequency: pattern.frequency,
                    next_charge_date: new Date().toISOString().split('T')[0],
                    category: autoCategory(pattern.displayMerchant),
                    is_auto_detected: true,
                  });
                  setSubscriptions(subscriptionsDS.getAll());
                  setToast(`Added ${pattern.displayMerchant} as a ${pattern.frequency} subscription.`);
                }}
              >
                Add subscription
              </Button>
            </div>
          </Modal>
        );
      })()}

      {/* Toast notification */}
      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[200] px-5 py-3 bg-[#1a1a1a] dark:bg-[#f0f0f0] text-white dark:text-[#0f0f0f] rounded-[10px] shadow-xl text-sm font-medium max-w-sm text-center pointer-events-none">
          {toast}
        </div>
      )}

      {/* Basiq connect modal */}
      <Modal isOpen={basiqConnectOpen} onClose={() => { setBasiqConnectOpen(false); setBasiqMsg(null); }} title="Connect live bank" size="sm">
        <p className="text-sm text-[#6b6b6b] dark:text-[#a0a0a0] mb-4">
          Securely connect your bank via Basiq Open Banking. You'll be redirected to your bank's consent page to authorise read-only access.
        </p>
        {basiqMsg && (
          <div className={`mb-3 px-3 py-2 rounded-[8px] text-xs ${basiqMsg.type === 'error' ? 'bg-[#ef4444]/10 text-[#ef4444]' : 'bg-[#3b7dd8]/10 text-[#3b7dd8]'}`}>
            {basiqMsg.text}
          </div>
        )}
        <div className="space-y-4">
          <Input
            label="Mobile number"
            value={basiqMobile}
            onChange={e => setBasiqMobile(e.target.value)}
            placeholder="0412 345 678"
            type="tel"
          />
          <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">
            Used by Basiq to verify your identity during the bank consent flow. Australian mobile numbers only.
          </p>
        </div>
        <div className="flex gap-3 mt-5">
          <Button variant="secondary" onClick={() => setBasiqConnectOpen(false)} fullWidth>Cancel</Button>
          <Button variant="primary" onClick={handleConnectBank} disabled={basiqConnecting} fullWidth>
            {basiqConnecting ? '⏳ Connecting…' : 'Connect bank →'}
          </Button>
        </div>
      </Modal>
    </Layout>
  );
}

// ─── helpers ────────────────────────────────────────────────────────────────

function EmptyState({ icon, title, description, onAdd }: { icon: string; title: string; description: string; onAdd: () => void }) {
  return (
    <div className="text-center py-12">
      <div className="text-4xl mb-3">{icon}</div>
      <h3 className="font-medium mb-1">{title}</h3>
      <p className="text-sm text-[#6b6b6b] dark:text-[#a0a0a0] mb-4">{description}</p>
      <Button variant="secondary" size="sm" onClick={onAdd}>+ Add</Button>
    </div>
  );
}

// ─── Types shared by upload modals ──────────────────────────────────────────

interface ParsedBankTx { date: string; merchant: string; amount: number; type?: string; }
interface ParsedCardTx { date: string; merchant: string; amount: number; category?: string; }
interface ParsedSubscription {
  name: string; amount: number; frequency: string;
  next_charge_date: string | null; category: string;
}

// ─── Account Detail Modal ────────────────────────────────────────────────────

const TX_EMOJI: Record<string, string> = {
  Groceries: '🛒', Dining: '🍔', Entertainment: '🎬', Fuel: '⛽',
  Travel: '✈️', Transport: '🚗', Fitness: '💪', Health: '💊',
  Electronics: '💻', Insurance: '🛡️', Utilities: '⚡', Rent: '🏠',
  Telecommunications: '📱', Dividends: '💰',
};

const TX_CATEGORIES = [
  'Food', 'Transport', 'Shopping', 'Bills', 'Entertainment',
  'Health', 'Income', 'Transfer', 'Other',
  'Groceries', 'Dining', 'Fuel', 'Travel', 'Fitness',
  'Electronics', 'Insurance', 'Utilities', 'Rent', 'Telecommunications', 'Dividends',
];

function TransactionRow({ tx, onDelete, onCategoryChange }: {
  tx: import('../types').Transaction;
  onDelete: (id: string) => void;
  onCategoryChange: (id: string, category: string) => void;
}) {
  const [catOpen, setCatOpen] = useState(false);
  return (
    <div className="flex items-center justify-between px-2 py-2.5 rounded-[8px] hover:bg-[#f5f5f5] dark:hover:bg-[#252525] transition-colors group">
      <div className="flex items-center gap-3 min-w-0">
        <div className="w-8 h-8 rounded-full bg-[#f5f5f5] dark:bg-[#2a2a2a] flex items-center justify-center text-sm flex-shrink-0">
          {TX_EMOJI[tx.category] ?? '💳'}
        </div>
        <div className="min-w-0">
          <p className="text-sm font-medium truncate">{tx.merchant}</p>
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">{formatDate(tx.date)}</span>
            <span className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">·</span>
            <div className="relative">
              <button
                onClick={() => setCatOpen(o => !o)}
                className="text-xs px-1.5 py-0.5 rounded-[4px] bg-[#e5e5e5] dark:bg-[#2a2a2a] hover:bg-[#d5d5d5] dark:hover:bg-[#333] transition-colors"
              >
                {tx.category || 'Uncategorised'}
              </button>
              {catOpen && (
                <div className="absolute left-0 top-full mt-1 z-50 bg-white dark:bg-[#1a1a1a] border border-[#e5e5e5] dark:border-[#2a2a2a] rounded-[8px] shadow-lg py-1 min-w-[140px]">
                  {TX_CATEGORIES.map(cat => (
                    <button
                      key={cat}
                      onClick={() => { onCategoryChange(tx.id, cat); setCatOpen(false); }}
                      className={`w-full text-left px-3 py-1.5 text-xs hover:bg-[#f5f5f5] dark:hover:bg-[#252525] ${tx.category === cat ? 'font-semibold text-[#3b7dd8]' : ''}`}
                    >
                      {cat}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2 flex-shrink-0 ml-3">
        <span className={`text-sm font-semibold amount ${tx.amount < 0 ? 'text-[#ef4444]' : 'text-[#22c55e]'}`}>
          {tx.amount < 0 ? '-' : '+'}{formatCurrency(Math.abs(tx.amount), tx.currency)}
        </span>
        <button
          onClick={() => onDelete(tx.id)}
          className="opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded hover:bg-[#ef4444]/10 text-[#ef4444]"
          title="Delete transaction"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
          </svg>
        </button>
      </div>
    </div>
  );
}

function AccountDetailModal({ account, transactions, currency, onClose, onDeleteTx, onCategoryChange }: {
  account: import('../types').BankAccount;
  transactions: import('../types').Transaction[];
  currency: string;
  onClose: () => void;
  onDeleteTx: (id: string) => void;
  onCategoryChange: (id: string, category: string) => void;
}) {
  const [search, setSearch] = useState('');

  const sorted = [...transactions].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  const filtered = search
    ? sorted.filter(t => t.merchant.toLowerCase().includes(search.toLowerCase()))
    : sorted;

  const now = new Date();
  const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const thisYearStart  = new Date(now.getFullYear(), 0, 1);

  const spentMonth = sorted
    .filter(t => new Date(t.date) >= thisMonthStart && t.amount < 0)
    .reduce((s, t) => s + Math.abs(t.amount), 0);
  const spentYear = sorted
    .filter(t => new Date(t.date) >= thisYearStart && t.amount < 0)
    .reduce((s, t) => s + Math.abs(t.amount), 0);

  return (
    <Modal isOpen onClose={onClose} size="xl" title={account.name}>
      {/* Summary strip */}
      <div className="grid grid-cols-3 gap-3 mb-5">
        <div className="p-3 rounded-[10px] bg-[#f5f5f5] dark:bg-[#252525]">
          <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0] mb-0.5">Balance</p>
          <p className="font-semibold amount">{formatCurrency(account.balance, account.currency)}</p>
        </div>
        <div className="p-3 rounded-[10px] bg-[#f5f5f5] dark:bg-[#252525]">
          <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0] mb-0.5">Spent this month</p>
          <p className="font-semibold amount text-[#ef4444]">{formatCurrency(spentMonth, currency)}</p>
        </div>
        <div className="p-3 rounded-[10px] bg-[#f5f5f5] dark:bg-[#252525]">
          <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0] mb-0.5">Spent this year</p>
          <p className="font-semibold amount text-[#ef4444]">{formatCurrency(spentYear, currency)}</p>
        </div>
      </div>

      {/* Account meta */}
      <div className="flex flex-wrap gap-2 mb-5 text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">
        <span className="badge bg-[#f5f5f5] dark:bg-[#2a2a2a]">{account.institution}</span>
        <span className="badge bg-[#f5f5f5] dark:bg-[#2a2a2a]">{account.account_type}</span>
        {account.bsb && <span className="badge bg-[#f5f5f5] dark:bg-[#2a2a2a]">BSB {account.bsb}</span>}
        {account.account_number && <span className="badge bg-[#f5f5f5] dark:bg-[#2a2a2a]">ACC {account.account_number}</span>}
        <span className={`badge ${account.is_manual ? 'bg-[#f5f5f5] dark:bg-[#2a2a2a]' : 'bg-[#22c55e]/10 text-[#22c55e]'}`}>
          {account.is_manual ? 'Manual' : '● Live sync'}
        </span>
      </div>

      {/* Transaction list */}
      <div className="mb-3">
        <input
          className="input w-full"
          placeholder="Search transactions…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          autoFocus
        />
      </div>
      <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0] mb-2">
        {filtered.length} transaction{filtered.length !== 1 ? 's' : ''}{search ? ' matching' : ''}
      </p>
      {filtered.length === 0 ? (
        <div className="text-center py-10 text-sm text-[#6b6b6b] dark:text-[#a0a0a0]">
          {search ? 'No matching transactions' : 'No transactions yet'}
        </div>
      ) : (
        <div className="space-y-px">
          {filtered.map(tx => (
            <TransactionRow key={tx.id} tx={tx} onDelete={onDeleteTx} onCategoryChange={onCategoryChange} />
          ))}
        </div>
      )}
    </Modal>
  );
}

// ─── Card Detail Modal ────────────────────────────────────────────────────────

function CardDetailModal({ card, transactions, onClose, onDeleteTx, onCategoryChange }: {
  card: CreditCard;
  transactions: import('../types').Transaction[];
  onClose: () => void;
  onDeleteTx: (id: string) => void;
  onCategoryChange: (id: string, category: string) => void;
}) {
  const [search, setSearch] = useState('');

  const sorted = [...transactions].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  const filtered = search
    ? sorted.filter(t => t.merchant.toLowerCase().includes(search.toLowerCase()))
    : sorted;

  const now = new Date();
  const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const thisYearStart  = new Date(now.getFullYear(), 0, 1);

  const spentMonth = sorted
    .filter(t => new Date(t.date) >= thisMonthStart && t.amount < 0)
    .reduce((s, t) => s + Math.abs(t.amount), 0);
  const spentYear = sorted
    .filter(t => new Date(t.date) >= thisYearStart && t.amount < 0)
    .reduce((s, t) => s + Math.abs(t.amount), 0);

  const utilisation = card.credit_limit > 0 ? (card.balance_owing / card.credit_limit) * 100 : 0;
  const isPaidInFull = card.balance_owing <= 0;

  return (
    <Modal isOpen onClose={onClose} size="xl" title={card.name}>
      {/* Summary strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
        <div className="p-3 rounded-[10px] bg-[#f5f5f5] dark:bg-[#252525]">
          <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0] mb-0.5">Balance owing</p>
          <p className={`font-semibold amount ${isPaidInFull ? 'text-[#22c55e]' : 'text-[#ef4444]'}`}>
            {formatCurrency(card.balance_owing, card.currency)}
          </p>
        </div>
        <div className="p-3 rounded-[10px] bg-[#f5f5f5] dark:bg-[#252525]">
          <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0] mb-0.5">Credit limit</p>
          <p className="font-semibold amount">{formatCurrency(card.credit_limit, card.currency)}</p>
        </div>
        <div className="p-3 rounded-[10px] bg-[#f5f5f5] dark:bg-[#252525]">
          <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0] mb-0.5">Spent this month</p>
          <p className="font-semibold amount text-[#ef4444]">{formatCurrency(spentMonth, card.currency)}</p>
        </div>
        <div className="p-3 rounded-[10px] bg-[#f5f5f5] dark:bg-[#252525]">
          <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0] mb-0.5">Spent this year</p>
          <p className="font-semibold amount text-[#ef4444]">{formatCurrency(spentYear, card.currency)}</p>
        </div>
      </div>

      {/* Utilisation bar */}
      <div className="mb-4">
        <div className="flex justify-between text-xs mb-1">
          <span className="text-[#6b6b6b] dark:text-[#a0a0a0]">Utilisation</span>
          <span className={utilisation > 75 ? 'text-[#ef4444]' : utilisation > 50 ? 'text-[#f59e0b]' : 'text-[#22c55e]'}>
            {utilisation.toFixed(0)}%
          </span>
        </div>
        <div className="h-2 bg-[#e5e5e5] dark:bg-[#2a2a2a] rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all ${utilisation > 75 ? 'bg-[#ef4444]' : utilisation > 50 ? 'bg-[#f59e0b]' : 'bg-[#22c55e]'}`}
            style={{ width: `${Math.min(100, utilisation)}%` }}
          />
        </div>
      </div>

      {/* Card meta */}
      <div className="flex flex-wrap gap-2 mb-5 text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">
        <span className="badge bg-[#f5f5f5] dark:bg-[#2a2a2a]">{card.institution}</span>
        {card.minimum_payment != null && (
          <span className="badge bg-[#f5f5f5] dark:bg-[#2a2a2a]">Min. {formatCurrency(card.minimum_payment, card.currency)}</span>
        )}
        {card.due_date && (
          <span className={`badge ${daysUntil(card.due_date) <= 7 ? 'bg-[#ef4444]/10 text-[#ef4444]' : 'bg-[#f5f5f5] dark:bg-[#2a2a2a]'}`}>
            Due {formatDate(card.due_date)}
          </span>
        )}
        {card.last_payment_amount != null && card.last_payment_date && (
          <span className="badge bg-[#22c55e]/10 text-[#22c55e]">
            Last paid {formatCurrency(card.last_payment_amount, card.currency)} · {formatDate(card.last_payment_date)}
          </span>
        )}
        {isPaidInFull && <span className="badge bg-[#22c55e]/10 text-[#22c55e]">Paid in full</span>}
      </div>

      {/* Transaction list */}
      <div className="mb-3">
        <input
          className="input w-full"
          placeholder="Search transactions…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          autoFocus
        />
      </div>
      <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0] mb-2">
        {filtered.length} transaction{filtered.length !== 1 ? 's' : ''}{search ? ' matching' : ''}
      </p>
      {filtered.length === 0 ? (
        <div className="text-center py-10 text-sm text-[#6b6b6b] dark:text-[#a0a0a0]">
          {search ? 'No matching transactions' : 'No statement transactions yet'}
        </div>
      ) : (
        <div className="space-y-px">
          {filtered.map(tx => (
            <TransactionRow key={tx.id} tx={tx} onDelete={onDeleteTx} onCategoryChange={onCategoryChange} />
          ))}
        </div>
      )}
    </Modal>
  );
}

// ─── Mark as Paid Modal ──────────────────────────────────────────────────────

function MarkAsPaidModal({ isOpen, onClose, card, accounts, onSave }: {
  isOpen: boolean; onClose: () => void;
  card: CreditCard;
  accounts: { id: string; name: string; institution: string }[];
  onSave: (amount: number, bankAccountId: string) => void;
}) {
  const [amount, setAmount] = useState(card.balance_owing.toFixed(2));
  const [bankAccountId, setBankAccountId] = useState(accounts[0]?.id ?? '');

  // Reset when card changes
  useEffect(() => {
    setAmount(card.balance_owing.toFixed(2));
    setBankAccountId(accounts[0]?.id ?? '');
  }, [card.id]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = parseFloat(amount);
    if (!parsed || parsed <= 0) return;
    onSave(parsed, bankAccountId);
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={`Mark as paid — ${card.name}`} size="sm">
      <p className="text-sm text-[#6b6b6b] dark:text-[#a0a0a0] mb-4">
        A payment pending record will be created. The bank account balance won't change until the transaction is detected and auto-reconciled.
      </p>
      <form onSubmit={handleSubmit} className="space-y-4">
        <Input
          label="Amount paid"
          type="number"
          step="0.01"
          prefix="$"
          value={amount}
          onChange={e => setAmount(e.target.value)}
          required
        />
        {accounts.length > 0 && (
          <Select
            label="Paid from account"
            value={bankAccountId}
            onChange={e => setBankAccountId(e.target.value)}
            options={[
              { value: '', label: 'Unknown / not specified' },
              ...accounts.map(a => ({ value: a.id, label: `${a.name} (${a.institution})` })),
            ]}
          />
        )}
        <div className="flex gap-3 pt-2">
          <Button variant="secondary" type="button" onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" fullWidth>Record payment</Button>
        </div>
      </form>
    </Modal>
  );
}

// ─── Add Account Modal ───────────────────────────────────────────────────────

function AddAccountModal({ isOpen, onClose, onSave }: {
  isOpen: boolean; onClose: () => void;
  onSave: (formData: { name: string; institution: string; bsb?: string; account_number?: string }, doAdd: () => void) => void;
}) {
  const [form, setForm] = useState({ name: '', institution: '', account_type: 'Everyday', balance: '', currency: 'AUD', bsb: '', account_number: '' });
  const [uploading, setUploading] = useState(false);
  const [uploadMsg, setUploadMsg] = useState('');
  const [parsedTransactions, setParsedTransactions] = useState<ParsedBankTx[]>([]);

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true); setUploadMsg(''); setParsedTransactions([]);
    const { parsed, error } = await parseDocument(file, 'bank_statement');
    setUploading(false);
    if (error) { setUploadMsg(error); return; }
    if (parsed?.accounts && Array.isArray(parsed.accounts) && parsed.accounts[0]) {
      const acc = parsed.accounts[0] as Record<string, unknown>;
      setForm(f => ({
        ...f,
        name:           String(acc.name ?? f.name),
        institution:    String(acc.institution ?? f.institution),
        account_type:   String(acc.account_type ?? f.account_type),
        balance:        String(acc.balance ?? f.balance),
        currency:       String(acc.currency ?? f.currency),
        bsb:            String(acc.bsb ?? f.bsb),
        account_number: String(acc.account_number ?? f.account_number),
      }));
      const txns = (acc.transactions as ParsedBankTx[]) ?? [];
      setParsedTransactions(txns);
      const txMsg = txns.length ? ` · ${txns.length} transaction${txns.length !== 1 ? 's' : ''} detected` : '';
      setUploadMsg(`Document parsed${txMsg} — please review the details below.`);
    }
    e.target.value = '';
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const formSnapshot = { name: form.name, institution: form.institution, bsb: form.bsb || undefined, account_number: form.account_number || undefined };
    const capturedForm = { ...form };
    const capturedTxns = [...parsedTransactions];
    const doAdd = () => {
      const acc = accountsDS.add({
        name: capturedForm.name, institution: capturedForm.institution, account_type: capturedForm.account_type,
        balance: parseFloat(capturedForm.balance) || 0, currency: capturedForm.currency,
        bsb: capturedForm.bsb || undefined, account_number: capturedForm.account_number || undefined,
        is_manual: true,
      });
      if (capturedTxns.length) {
        const existing = transactionsDS.getAll();
        for (const tx of capturedTxns) {
          const normalizedAmt = tx.type === 'credit' ? Math.abs(tx.amount) : -Math.abs(tx.amount);
          const isDup = existing.some(ex =>
            ex.date === tx.date && ex.merchant === tx.merchant && Math.abs(ex.amount - normalizedAmt) < 0.01
          );
          if (!isDup) {
            transactionsDS.add({
              account_id: acc.id, account_type: 'bank', date: tx.date, merchant: tx.merchant,
              amount: normalizedAmt, currency: acc.currency, category: autoCategory(tx.merchant),
              is_duplicate_flagged: false, is_subscription: false,
            });
          }
        }
      }
    };
    setForm({ name: '', institution: '', account_type: 'Everyday', balance: '', currency: 'AUD', bsb: '', account_number: '' });
    setUploadMsg('');
    setParsedTransactions([]);
    onSave(formSnapshot, doAdd);
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Add Bank Account">
      <label className="w-full flex items-center justify-center gap-2 px-4 py-3 mb-4 rounded-[8px] border-2 border-dashed border-[#e5e5e5] dark:border-[#2a2a2a] hover:border-[#3b7dd8]/40 cursor-pointer transition-colors">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
        <span className="text-sm text-[#6b6b6b] dark:text-[#a0a0a0]">{uploading ? 'Reading document…' : 'Upload statement (PDF / image) to auto-fill'}</span>
        <input type="file" accept=".pdf,image/*" className="hidden" onChange={handleUpload} />
      </label>
      {uploadMsg && (
        <div className={`mb-4 px-3 py-2 rounded-[8px] text-xs ${uploadMsg.includes('requires') ? 'bg-[#f59e0b]/10 text-[#f59e0b]' : 'bg-[#22c55e]/10 text-[#22c55e]'}`}>
          {uploadMsg}
        </div>
      )}
      <form onSubmit={handleSubmit} className="space-y-4">
        <Input label="Account name" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. CommBank Everyday" required />
        <Input label="Institution" value={form.institution} onChange={e => setForm(f => ({ ...f, institution: e.target.value }))} placeholder="e.g. CommBank" required />
        <Select label="Account type" value={form.account_type} onChange={e => setForm(f => ({ ...f, account_type: e.target.value }))} options={ACCOUNT_TYPES} />
        <div className="grid grid-cols-2 gap-3">
          <Input label="Balance" type="number" step="0.01" prefix="$" value={form.balance} onChange={e => setForm(f => ({ ...f, balance: e.target.value }))} required />
          <Input label="Currency" value={form.currency} onChange={e => setForm(f => ({ ...f, currency: e.target.value.toUpperCase() }))} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Input label="BSB (optional)" value={form.bsb} onChange={e => setForm(f => ({ ...f, bsb: e.target.value }))} placeholder="012-345" />
          <Input label="Account number" value={form.account_number} onChange={e => setForm(f => ({ ...f, account_number: e.target.value }))} />
        </div>
        <div className="flex gap-3 pt-2">
          <Button variant="secondary" type="button" onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" fullWidth>Add Account</Button>
        </div>
      </form>
    </Modal>
  );
}

// ─── Add Credit Card Modal ───────────────────────────────────────────────────

function AddCreditCardModal({ isOpen, onClose, onSave }: { isOpen: boolean; onClose: () => void; onSave: (formData: { name: string; institution: string }, doAdd: () => void) => void }) {
  const [form, setForm] = useState({ name: '', institution: '', balance_owing: '', credit_limit: '', minimum_payment: '', due_date: '', currency: 'AUD' });
  const [uploading, setUploading] = useState(false);
  const [uploadMsg, setUploadMsg] = useState('');
  const [parsedTransactions, setParsedTransactions] = useState<ParsedCardTx[]>([]);

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true); setUploadMsg(''); setParsedTransactions([]);
    const { parsed, error } = await parseDocument(file, 'credit_card_statement');
    setUploading(false);
    if (error) { setUploadMsg(error); return; }
    if (parsed) {
      const p = parsed as Record<string, unknown>;
      setForm(f => ({
        ...f,
        name:            String(p.card_name        ?? f.name),
        institution:     String(p.institution      ?? f.institution),
        balance_owing:   String(p.closing_balance  ?? f.balance_owing),
        credit_limit:    String(p.credit_limit      ?? f.credit_limit),
        minimum_payment: String(p.minimum_payment  ?? f.minimum_payment),
        due_date:        String(p.due_date          ?? f.due_date),
      }));
      const txns = (p.transactions as ParsedCardTx[]) ?? [];
      setParsedTransactions(txns);
      const txMsg = txns.length ? ` · ${txns.length} transaction${txns.length !== 1 ? 's' : ''} detected` : '';
      setUploadMsg(`Document parsed${txMsg} — please review the details below.`);
    }
    e.target.value = '';
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const formSnapshot = { name: form.name, institution: form.institution };
    const capturedForm = { ...form };
    const capturedTxns = [...parsedTransactions];
    const doAdd = () => {
      const card = creditCardsDS.add({
        name: capturedForm.name, institution: capturedForm.institution,
        balance_owing:   parseFloat(capturedForm.balance_owing) || 0,
        credit_limit:    parseFloat(capturedForm.credit_limit) || 0,
        minimum_payment: capturedForm.minimum_payment ? parseFloat(capturedForm.minimum_payment) : undefined,
        due_date:        capturedForm.due_date || undefined,
        currency: capturedForm.currency,
        is_manual: true,
      });
      if (capturedTxns.length) {
        const existing = transactionsDS.getAll();
        for (const tx of capturedTxns) {
          const normalizedAmt = -Math.abs(tx.amount);
          const isDup = existing.some(ex =>
            ex.date === tx.date && ex.merchant === tx.merchant && Math.abs(ex.amount - normalizedAmt) < 0.01
          );
          if (!isDup) {
            transactionsDS.add({
              account_id: card.id, account_type: 'credit_card', date: tx.date, merchant: tx.merchant,
              amount: normalizedAmt, currency: card.currency, category: tx.category ?? autoCategory(tx.merchant),
              is_duplicate_flagged: false, is_subscription: false,
            });
          }
        }
      }
    };
    setForm({ name: '', institution: '', balance_owing: '', credit_limit: '', minimum_payment: '', due_date: '', currency: 'AUD' });
    setUploadMsg('');
    setParsedTransactions([]);
    onSave(formSnapshot, doAdd);
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Add Credit Card">
      <label className="w-full flex items-center justify-center gap-2 px-4 py-3 mb-4 rounded-[8px] border-2 border-dashed border-[#e5e5e5] dark:border-[#2a2a2a] hover:border-[#3b7dd8]/40 cursor-pointer transition-colors">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
        <span className="text-sm text-[#6b6b6b] dark:text-[#a0a0a0]">{uploading ? 'Reading document…' : 'Upload statement (PDF / image) to auto-fill'}</span>
        <input type="file" accept=".pdf,image/*" className="hidden" onChange={handleUpload} />
      </label>
      {uploadMsg && (
        <div className={`mb-4 px-3 py-2 rounded-[8px] text-xs ${uploadMsg.includes('failed') || uploadMsg.includes('error') ? 'bg-[#ef4444]/10 text-[#ef4444]' : 'bg-[#22c55e]/10 text-[#22c55e]'}`}>
          {uploadMsg}
        </div>
      )}
      <form onSubmit={handleSubmit} className="space-y-4">
        <Input label="Card name" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. ANZ Rewards Black" required />
        <Input label="Institution" value={form.institution} onChange={e => setForm(f => ({ ...f, institution: e.target.value }))} placeholder="e.g. ANZ" required />
        <div className="grid grid-cols-2 gap-3">
          <Input label="Balance owing" type="number" step="0.01" prefix="$" value={form.balance_owing} onChange={e => setForm(f => ({ ...f, balance_owing: e.target.value }))} required />
          <Input label="Credit limit" type="number" step="0.01" prefix="$" value={form.credit_limit} onChange={e => setForm(f => ({ ...f, credit_limit: e.target.value }))} required />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Input label="Min. payment" type="number" step="0.01" prefix="$" value={form.minimum_payment} onChange={e => setForm(f => ({ ...f, minimum_payment: e.target.value }))} />
          <Input label="Due date" type="date" value={form.due_date} onChange={e => setForm(f => ({ ...f, due_date: e.target.value }))} />
        </div>
        <div className="flex gap-3 pt-2">
          <Button variant="secondary" type="button" onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" fullWidth>Add Card</Button>
        </div>
      </form>
    </Modal>
  );
}

// ─── Add Subscription Modal ──────────────────────────────────────────────────

function AddSubscriptionModal({ isOpen, onClose, onSave }: { isOpen: boolean; onClose: () => void; onSave: (d: object) => void }) {
  const [form, setForm] = useState({ name: '', amount: '', frequency: 'monthly', next_charge_date: '', category: 'Entertainment', currency: 'AUD' });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSave({ ...form, amount: parseFloat(form.amount) || 0 });
    setForm({ name: '', amount: '', frequency: 'monthly', next_charge_date: '', category: 'Entertainment', currency: 'AUD' });
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Add Subscription">
      <form onSubmit={handleSubmit} className="space-y-4">
        <Input label="Service name" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Netflix" required />
        <div className="grid grid-cols-2 gap-3">
          <Input label="Amount" type="number" step="0.01" prefix="$" value={form.amount} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} required />
          <Select label="Frequency" value={form.frequency} onChange={e => setForm(f => ({ ...f, frequency: e.target.value }))}
            options={[{ value: 'weekly', label: 'Weekly' }, { value: 'fortnightly', label: 'Fortnightly' }, { value: 'monthly', label: 'Monthly' }, { value: 'quarterly', label: 'Quarterly' }, { value: 'annually', label: 'Annually' }]}
          />
        </div>
        <Input label="Next charge date" type="date" value={form.next_charge_date} onChange={e => setForm(f => ({ ...f, next_charge_date: e.target.value }))} />
        <Select label="Category" value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))}
          options={[{ value: 'Entertainment', label: 'Entertainment' }, { value: 'Software', label: 'Software' }, { value: 'Fitness', label: 'Fitness' }, { value: 'News', label: 'News' }, { value: 'Telecommunications', label: 'Telco' }, { value: 'Other', label: 'Other' }]}
        />
        <div className="flex gap-3 pt-2">
          <Button variant="secondary" type="button" onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" fullWidth>Add Subscription</Button>
        </div>
      </form>
    </Modal>
  );
}

// ─── Add Transaction Modal ───────────────────────────────────────────────────

function AddTransactionModal({ isOpen, onClose, onSave, accounts }: {
  isOpen: boolean; onClose: () => void; onSave: (d: object) => void;
  accounts: { id: string; name: string }[];
}) {
  const [form, setForm] = useState({
    merchant: '', amount: '', date: new Date().toISOString().split('T')[0],
    category: '', account_id: '', account_type: 'bank' as 'bank' | 'credit_card', currency: 'AUD',
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const cat = form.category || autoCategory(form.merchant);
    onSave({
      ...form,
      amount: -Math.abs(parseFloat(form.amount) || 0), // expenses are negative
      category: cat,
      is_duplicate_flagged: false,
      is_subscription: false,
    });
    setForm({ merchant: '', amount: '', date: new Date().toISOString().split('T')[0], category: '', account_id: '', account_type: 'bank', currency: 'AUD' });
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Add Transaction" size="sm">
      <form onSubmit={handleSubmit} className="space-y-4">
        <Input label="Merchant / Description" value={form.merchant} onChange={e => setForm(f => ({ ...f, merchant: e.target.value }))} placeholder="e.g. Woolworths" required />
        <div className="grid grid-cols-2 gap-3">
          <Input label="Amount" type="number" step="0.01" prefix="$" value={form.amount} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} required />
          <Input label="Date" type="date" value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))} required />
        </div>
        <Input
          label="Category (auto-detected if blank)"
          value={form.category}
          onChange={e => setForm(f => ({ ...f, category: e.target.value }))}
          placeholder={form.merchant ? autoCategory(form.merchant) : 'e.g. Groceries'}
        />
        {accounts.length > 0 && (
          <Select label="Account (optional)" value={form.account_id} onChange={e => setForm(f => ({ ...f, account_id: e.target.value }))}
            options={[{ value: '', label: 'No account' }, ...accounts.map(a => ({ value: a.id, label: a.name }))]}
          />
        )}
        <div className="flex gap-3 pt-2">
          <Button variant="secondary" type="button" onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" fullWidth>Add Transaction</Button>
        </div>
      </form>
    </Modal>
  );
}

// ─── Upload Credit Card Statement Modal ──────────────────────────────────────

function UploadCardStatementModal({ isOpen, onClose, card, onSaved }: {
  isOpen: boolean; onClose: () => void;
  card: CreditCard;
  onSaved: () => void;
}) {
  const { transactions: allTransactions, setTransactions } = useStore();
  const [uploading, setUploading] = useState(false);
  const [msg, setMsg] = useState('');
  const [msgType, setMsgType] = useState<'success' | 'error' | 'info'>('info');
  const [parsed, setParsed] = useState<{
    closing_balance?: number; credit_limit?: number;
    minimum_payment?: number; due_date?: string;
    transactions?: ParsedCardTx[];
  } | null>(null);
  const [importing, setImporting] = useState(false);

  const reset = () => { setUploading(false); setMsg(''); setParsed(null); setImporting(false); };

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true); setMsg(''); setParsed(null);
    const { parsed: p, error } = await parseDocument(file, 'credit_card_statement');
    setUploading(false);
    if (error) { setMsg(error); setMsgType('error'); return; }
    if (p) {
      const result = p as typeof parsed;
      setParsed(result);
      const txCount = result?.transactions?.length ?? 0;
      setMsg(`Parsed · closing balance ${result?.closing_balance != null ? formatCurrency(result.closing_balance, card.currency) : 'unknown'} · ${txCount} transaction${txCount !== 1 ? 's' : ''} found`);
      setMsgType('info');
    }
    e.target.value = '';
  };

  const handleImport = () => {
    if (!parsed) return;
    setImporting(true);

    // Update card fields
    const updates: Partial<CreditCard> = {};
    if (parsed.closing_balance != null) updates.balance_owing = parsed.closing_balance;
    if (parsed.credit_limit != null && parsed.credit_limit > 0) updates.credit_limit = parsed.credit_limit;
    if (parsed.minimum_payment != null) updates.minimum_payment = parsed.minimum_payment;
    if (parsed.due_date) updates.due_date = parsed.due_date;
    if (Object.keys(updates).length > 0) creditCardsDS.update(card.id, updates);

    // Add transactions, skipping dupes
    let added = 0;
    if (parsed.transactions?.length) {
      const existing = [...allTransactions];
      for (const tx of parsed.transactions) {
        const normalizedAmt = -Math.abs(tx.amount);
        const isDup = existing.some(e =>
          e.date === tx.date && e.merchant === tx.merchant && Math.abs(e.amount - normalizedAmt) < 0.01
        );
        if (!isDup) {
          transactionsDS.add({
            account_id: card.id,
            account_type: 'credit_card',
            date: tx.date,
            merchant: tx.merchant,
            amount: normalizedAmt,
            currency: card.currency,
            category: tx.category ?? autoCategory(tx.merchant),
            is_duplicate_flagged: false,
            is_subscription: false,
          });
          existing.push({
            id: 'local', user_id: 'local', account_id: card.id, account_type: 'credit_card',
            date: tx.date, merchant: tx.merchant, amount: normalizedAmt, currency: card.currency,
            category: tx.category ?? autoCategory(tx.merchant), is_duplicate_flagged: false,
            is_subscription: false, created_at: '', updated_at: '',
          });
          added++;
        }
      }
      setTransactions(transactionsDS.getAll());
    }

    const skipped = (parsed.transactions?.length ?? 0) - added;
    setMsg(`Imported ${added} new transaction${added !== 1 ? 's' : ''}${skipped > 0 ? ` · ${skipped} duplicate${skipped !== 1 ? 's' : ''} skipped` : ''} · card updated`);
    setMsgType('success');
    setImporting(false);
    onSaved();
  };

  return (
    <Modal isOpen={isOpen} onClose={() => { reset(); onClose(); }} title={`Upload statement — ${card.name}`}>
      <label className="w-full flex items-center justify-center gap-2 px-4 py-3 mb-4 rounded-[8px] border-2 border-dashed border-[#e5e5e5] dark:border-[#2a2a2a] hover:border-[#3b7dd8]/40 cursor-pointer transition-colors">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
        <span className="text-sm text-[#6b6b6b] dark:text-[#a0a0a0]">{uploading ? 'Reading document…' : 'Upload statement (PDF / image)'}</span>
        <input type="file" accept=".pdf,image/*" className="hidden" onChange={handleUpload} disabled={uploading} />
      </label>
      {msg && (
        <div className={`mb-4 px-3 py-2 rounded-[8px] text-xs ${
          msgType === 'error' ? 'bg-[#ef4444]/10 text-[#ef4444]' :
          msgType === 'success' ? 'bg-[#22c55e]/10 text-[#22c55e]' :
          'bg-[#3b7dd8]/10 text-[#3b7dd8]'}`}>{msg}</div>
      )}
      {parsed && (
        <div className="mb-4 p-3 rounded-[8px] bg-[#f5f5f5] dark:bg-[#1a1a1a] text-xs space-y-1">
          <p className="font-medium text-sm mb-2">Changes to apply:</p>
          {parsed.closing_balance != null && <p>Balance owing → {formatCurrency(parsed.closing_balance, card.currency)}</p>}
          {parsed.credit_limit != null && parsed.credit_limit > 0 && <p>Credit limit → {formatCurrency(parsed.credit_limit, card.currency)}</p>}
          {parsed.minimum_payment != null && <p>Minimum payment → {formatCurrency(parsed.minimum_payment, card.currency)}</p>}
          {parsed.due_date && <p>Due date → {formatDate(parsed.due_date)}</p>}
          {(parsed.transactions?.length ?? 0) > 0 && <p>{parsed.transactions!.length} transaction{parsed.transactions!.length !== 1 ? 's' : ''} to import (duplicates will be skipped)</p>}
        </div>
      )}
      <div className="flex gap-3">
        <Button variant="secondary" onClick={() => { reset(); onClose(); }}>Cancel</Button>
        {parsed && (
          <Button variant="primary" onClick={handleImport} disabled={importing} fullWidth>
            {importing ? 'Importing…' : 'Apply & Import'}
          </Button>
        )}
      </div>
    </Modal>
  );
}

// ─── Subscription Import Modal ───────────────────────────────────────────────

function SubscriptionImportModal({ isOpen, onClose, existingNames, onImport }: {
  isOpen: boolean; onClose: () => void;
  existingNames: Set<string>;
  onImport: (selected: ParsedSubscription[]) => void;
}) {
  const [uploading, setUploading] = useState(false);
  const [msg, setMsg] = useState('');
  const [msgType, setMsgType] = useState<'success' | 'error' | 'info'>('info');
  const [parsedSubs, setParsedSubs] = useState<ParsedSubscription[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true); setMsg(''); setParsedSubs([]); setSelected(new Set());
    const { parsed, error } = await parseDocument(file, 'subscription_statement');
    setUploading(false);
    if (error) { setMsg(error); setMsgType('error'); return; }
    const subs = (parsed?.subscriptions as ParsedSubscription[]) ?? [];
    setParsedSubs(subs);
    const preSelected = new Set<number>();
    subs.forEach((s, i) => { if (!existingNames.has(s.name.toLowerCase())) preSelected.add(i); });
    setSelected(preSelected);
    setMsg(subs.length ? `Found ${subs.length} subscription${subs.length !== 1 ? 's' : ''}` : 'No subscriptions found');
    setMsgType(subs.length ? 'info' : 'error');
    e.target.value = '';
  };

  const toggle = (i: number) => setSelected(prev => {
    const next = new Set(prev);
    if (next.has(i)) next.delete(i); else next.add(i);
    return next;
  });

  const handleImport = () => {
    onImport(parsedSubs.filter((_, i) => selected.has(i)));
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Import subscriptions from statement">
      <label className="w-full flex items-center justify-center gap-2 px-4 py-3 mb-4 rounded-[8px] border-2 border-dashed border-[#e5e5e5] dark:border-[#2a2a2a] hover:border-[#3b7dd8]/40 cursor-pointer transition-colors">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
        <span className="text-sm text-[#6b6b6b] dark:text-[#a0a0a0]">{uploading ? 'Reading document…' : 'Upload statement (PDF / image)'}</span>
        <input type="file" accept=".pdf,image/*" className="hidden" onChange={handleUpload} disabled={uploading} />
      </label>
      {msg && (
        <div className={`mb-4 px-3 py-2 rounded-[8px] text-xs ${
          msgType === 'error' ? 'bg-[#ef4444]/10 text-[#ef4444]' :
          msgType === 'success' ? 'bg-[#22c55e]/10 text-[#22c55e]' :
          'bg-[#3b7dd8]/10 text-[#3b7dd8]'}`}>{msg}</div>
      )}
      {parsedSubs.length > 0 && (
        <div className="mb-4 max-h-64 overflow-y-auto space-y-1 border border-[#e5e5e5] dark:border-[#2a2a2a] rounded-[8px] p-2">
          {parsedSubs.map((sub, i) => {
            const alreadyExists = existingNames.has(sub.name.toLowerCase());
            return (
              <label key={i} className="flex items-center gap-3 p-2 rounded-[6px] hover:bg-[#f5f5f5] dark:hover:bg-[#1a1a1a] cursor-pointer">
                <input type="checkbox" checked={selected.has(i)} onChange={() => toggle(i)} className="rounded flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{sub.name}</p>
                  <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">
                    {formatCurrency(sub.amount, 'AUD')} · {sub.frequency} · {sub.category}
                    {sub.next_charge_date && ` · Next: ${formatDate(sub.next_charge_date)}`}
                  </p>
                </div>
                {alreadyExists && <span className="text-xs text-[#f59e0b] flex-shrink-0">Already added</span>}
              </label>
            );
          })}
        </div>
      )}
      <div className="flex gap-3">
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        {parsedSubs.length > 0 && (
          <Button variant="primary" onClick={handleImport} disabled={selected.size === 0} fullWidth>
            Import {selected.size} selected
          </Button>
        )}
      </div>
    </Modal>
  );
}
