import { useState, useEffect, useRef, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import Layout from '../components/layout/Layout';
import { useStore } from '../store';
import {
  accountsDS, creditCardsDS, transactionsDS, subscriptionsDS,
  parseDocument, basiqDS, pendingPaymentsDS, billsDS,
  cardReminderBillName, cardReminderAmount,
  accountIdMatches, accountIdVariants, loadOlderTransactions,
  creditCardStatementsDS, ccPaymentPromptsDS,
} from '../services/dataService';
import { autoCategory, formatCurrency, formatDate, daysUntil } from '../utils/format';
import { BASE_TX_CATEGORIES, useAllCategories } from '../utils/categories';
import {
  findMatchingSubscription, findCrossAccountDuplicate,
  normaliseMerchant, clearSessionSkips, calcNextChargeDate,
  sessionSkipPattern, dismissPatternPermanently, detectInternalTransferIds,
  type RecurringPattern,
} from '../utils/recurringDetection';
import type { CreditCard, CreditCardStatement, Subscription, Transaction, Bill } from '../types';
import Card from '../components/common/Card';
import Modal from '../components/common/Modal';
import Button from '../components/common/Button';
import Input, { Select } from '../components/common/Input';

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
    creditCardStatements, ccPaymentPrompts,
    bills, setBills,
    basiqUserId, setBasiqUserId,
    pendingRecurringCount, setPendingRecurringCount,
    pendingPatterns, setPendingPatterns,
    triggerDetection, triggerDetectionPasses,
    setRecurringShowImmediate, setRecurringModalActive,
    openRecurringModal, setOpenRecurringModal,
  } = useStore();

  const [searchParams] = useSearchParams();
  // Transactions that are just money moved between the user's own accounts —
  // excluded from per-account spend totals (computed from the FULL set so the
  // matching credit leg on another account is visible).
  const internalTransferIds = useMemo(() => detectInternalTransferIds(transactions), [transactions]);
  const [activeTab, setActiveTab] = useState<Tab>('Accounts');
  const [addAccountOpen, setAddAccountOpen] = useState(false);
  const [addCardOpen, setAddCardOpen] = useState(false);
  const [addSubOpen, setAddSubOpen] = useState(false);
  const [addTxOpen, setAddTxOpen] = useState(false);
  const [txSearch, setTxSearch] = useState('');
  // "Load older transactions" control state. The bootstrap only loads the last
  // 3 months for instant startup; older history is fetched on demand.
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [allHistoryLoaded, setAllHistoryLoaded] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<{ type: 'account' | 'card' | 'sub'; id: string } | null>(null);
  const [linkedSubsPrompt, setLinkedSubsPrompt] = useState<{
    accountId: string;
    accountName: string;
    type: 'account' | 'card';
    subs: import('../types').Subscription[];
  } | null>(null);
  // Set of subscription ids ticked for deletion in the linked-subs modal
  const [linkedSubsChecked, setLinkedSubsChecked] = useState<Set<string>>(new Set());
  const [expandedCardId, setExpandedCardId] = useState<string | null>(null);
  const [uploadCardOpen, setUploadCardOpen] = useState<string | null>(null);
  const [subUploadOpen, setSubUploadOpen] = useState(false);
  const [markPaidCardId, setMarkPaidCardId] = useState<string | null>(null);
  // Statement pending the pay-confirmation dialog
  const [payStatement, setPayStatement] = useState<CreditCardStatement | null>(null);
  // Cards whose older statements have been lazy-loaded
  const [showAllStatementsFor, setShowAllStatementsFor] = useState<Set<string>>(new Set());
  const [detailAccountId, setDetailAccountId] = useState<string | null>(null);
  const [detailCardId, setDetailCardId] = useState<string | null>(null);
  const [detailSubId, setDetailSubId] = useState<string | null>(null);

  // Duplicate / recurring detection
  type DuplicatePrompt = { message: string; onAddAnyway: () => void };
  type RecurringPrompt = { merchant: string; amount: number; onSubscribe: () => void; onKeep: () => void };
  const [duplicatePrompt, setDuplicatePrompt] = useState<DuplicatePrompt | null>(null);
  const [recurringPrompt, setRecurringPrompt] = useState<RecurringPrompt | null>(null);

  // Recurring-pattern review queue (display only). Detection itself now runs
  // globally in useRecurringDetection (mounted in App.tsx) and writes
  // pendingPatterns / pendingRecurringCount to the store. This page only
  // displays the modal queue and badge — it does not run detection.
  const bgActiveRef  = useRef(false);                         // true while a queue is showing
  const prevTabRef = useRef<Tab>('Accounts');                 // tracks last active tab to detect navigation
  const [bgPatterns, setBgPatterns]   = useState<RecurringPattern[]>([]);
  const [bgPatternIdx, setBgPatternIdx] = useState(0);
  const [bgSubName, setBgSubName] = useState('');             // editable name for current pattern
  const [bgAmount, setBgAmount] = useState('');               // editable amount (string for the input) for current pattern
  const [bgNameEditing, setBgNameEditing] = useState(false); // is the name field in edit mode
  const [alsoAddToBills, setAlsoAddToBills] = useState(false);
  const alsoAddToBillsRef = useRef(false);  // mirrors state — safe to read after advance() queues a reset
  const handleBillsToggleChange = (newValue: boolean) => {
    alsoAddToBillsRef.current = newValue;
    setAlsoAddToBills(newValue);
  };
  const [payMethod, setPayMethod] = useState<'auto' | 'manual'>('manual'); // bill payment method
  const payMethodRef = useRef<'auto' | 'manual'>('manual'); // mirrors state — safe to read after advance()
  const [toast, setToast] = useState<string | null>(null);

  // Inline rename state for subscriptions list
  const [renamingSubId, setRenamingSubId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  // Basiq live-sync state
  const [basiqConnectOpen, setBasiqConnectOpen] = useState(false);
  const [basiqMobile, setBasiqMobile] = useState('');
  const [basiqConnecting, setBasiqConnecting] = useState(false);
  const [basiqSyncing, setBasiqSyncing] = useState(false);
  const [basiqMsg, setBasiqMsg] = useState<{ text: string; type: 'success' | 'error' | 'info' } | null>(null);
  const [basiqConsentExpired, setBasiqConsentExpired] = useState(false);
  const [basiqReconnecting, setBasiqReconnecting] = useState(false);

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
    setBasiqConsentExpired(false);
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
      const msg = err instanceof Error ? err.message : 'Sync failed';
      if (msg === 'consent_expired') {
        setBasiqConsentExpired(true);
        setBasiqMsg(null);
      } else {
        setBasiqMsg({ text: msg, type: 'error' });
      }
    } finally {
      setBasiqSyncing(false);
    }
  };

  /** Re-consent flow: get a fresh auth link for the existing Basiq user and open it. */
  const handleReconnectBasiq = async () => {
    if (!basiqUserId) return;
    setBasiqReconnecting(true);
    try {
      const mobile = basiqMobile.trim().replace(/^0/, '+61');
      const link = await basiqDS.getAuthLink(basiqUserId, mobile || undefined);
      window.open(link, '_blank', 'noopener,noreferrer');
      setBasiqConsentExpired(false);
      setBasiqMsg({ text: 'Consent page opened. Reconnect your bank, then sync again.', type: 'info' });
    } catch (err) {
      setBasiqMsg({ text: err instanceof Error ? err.message : 'Reconnect failed', type: 'error' });
    } finally {
      setBasiqReconnecting(false);
    }
  };

  /** TEMPORARY: clear a stale Basiq user id (DB + local) then reload. */
  const handleResetBasiq = async () => {
    try {
      await basiqDS.disconnect();
    } catch (err) {
      console.error('[basiq] reset failed:', err);
    } finally {
      setBasiqUserId(null);
      window.location.reload();
    }
  };

  const currency = user?.currency_preference ?? 'AUD';
  const totalBank = accounts.reduce((s, a) => s + (a.display_balance ?? a.balance), 0);
  const totalCC   = creditCards.reduce((s, c) => s + (c.display_balance_owing ?? c.balance_owing), 0);

  useEffect(() => {
    const add = searchParams.get('add');
    if (add === 'bank')         { setActiveTab('Accounts');      setAddAccountOpen(true); }
    if (add === 'credit-card')  { setActiveTab('Credit Cards');  setAddCardOpen(true);    }
    if (add === 'subscription') { setActiveTab('Subscriptions'); setAddSubOpen(true);     }
    if (add === 'transaction')  { setActiveTab('Transactions');  setAddTxOpen(true);      }
    if (searchParams.get('tab') === 'subscriptions') { setActiveTab('Subscriptions'); }
  }, [searchParams]);

  // Hydrate basiqUserId from the database (source of truth) on mount, so a
  // cleared localStorage or a new device recovers the Basiq connection. The
  // persisted Zustand value is just a cache.
  useEffect(() => {
    let cancelled = false;
    basiqDS.me()
      .then(id => { if (!cancelled && id) setBasiqUserId(id); })
      .catch(err => console.error('[basiq] hydrate failed:', err));
    return () => { cancelled = true; };
  }, [setBasiqUserId]);

  // Helper: open the modal review queue from the store's pendingPatterns.
  // Detection itself runs globally (useRecurringDetection in App.tsx); this only
  // displays the resulting patterns. Returns true if a queue was opened.
  const openQueueFromPending = (): boolean => {
    if (pendingPatterns.length === 0) return false;
    bgActiveRef.current = true;
    setRecurringModalActive(true);
    setBgPatterns(pendingPatterns);
    setBgPatternIdx(0);
    setBgSubName(pendingPatterns[0].displayMerchant);
    setBgAmount(pendingPatterns[0].amount.toFixed(2));
    // Fresh queue — guarantee toggle/payMethod start clean (no stale ref leak).
    alsoAddToBillsRef.current = false;
    setAlsoAddToBills(false);
    payMethodRef.current = 'manual';
    setPayMethod('manual');
    setPendingPatterns([]);
    setPendingRecurringCount(0);
    return true;
  };

  // Auto-open the recurring modal when the user navigates TO the Subscriptions tab
  // and there are pending patterns (in store) or a pending count (from a prior
  // detection run). Detection no longer lives here — it runs globally.
  useEffect(() => {
    const justNavigated = prevTabRef.current !== 'Subscriptions' && activeTab === 'Subscriptions';
    prevTabRef.current = activeTab;

    if (!justNavigated) return;
    if (bgActiveRef.current) return;

    // Case 1 — patterns already detected and waiting in the store
    if (openQueueFromPending()) return;

    // Case 2 — count is set but patterns were lost — re-run detection globally
    if (pendingRecurringCount > 0) {
      setPendingRecurringCount(0);
      setRecurringShowImmediate(true);
      triggerDetection();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, pendingPatterns.length, pendingRecurringCount]);

  // Open the recurring modal when the user clicks a recurring notification in TopBar,
  // or when the global detector requests an immediate open. The store flag is set
  // by TopBar (before navigating here) or by useRecurringDetection.
  useEffect(() => {
    if (!openRecurringModal) return;
    setOpenRecurringModal(false);
    if (bgActiveRef.current) return;

    // If patterns are waiting in the store, open directly
    if (openQueueFromPending()) return;

    // Otherwise re-run detection globally so the modal is shown immediately
    setPendingRecurringCount(0);
    setRecurringShowImmediate(true);
    triggerDetection();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openRecurringModal]);

  // Auto-dismiss toast after 4 seconds
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const displayedTransactions = transactionsDS.getAll({ search: txSearch || undefined });

  const subMonthly = subscriptions.reduce((s, sub) => {
    const m: Record<string, number> = { weekly: 4.33, fortnightly: 2.17, monthly: 1, quarterly: 0.333, annually: 0.083 };
    return s + (sub.display_amount ?? sub.amount) * (m[sub.frequency] ?? 1);
  }, 0);

  /**
   * Actually remove the account/card after the user has confirmed.
   * `toDelete`  — subscription ids to fully remove
   * `toUnlink`  — subscription ids to keep but set account_id → null
   */
  const performAccountDelete = (
    id: string,
    type: 'account' | 'card',
    toDelete: string[],
    toUnlink: string[],
  ) => {
    toDelete.forEach(sid => subscriptionsDS.remove(sid));
    toUnlink.forEach(sid => subscriptionsDS.update(sid, { account_id: undefined }));
    if (toDelete.length > 0 || toUnlink.length > 0) setSubscriptions(subscriptionsDS.getAll());

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
    // Account or card — check for linked subscriptions first.
    // Build the full set of IDs this account is known by (handles the local→server
    // ID swap: a sub/transaction may still reference an older variant of the id).
    const acctRecord =
      deleteConfirm.type === 'account'
        ? accounts.find(a => a.id === deleteConfirm.id)
        : creditCards.find(c => c.id === deleteConfirm.id);
    const accIds = acctRecord
      ? accountIdVariants(acctRecord)
      : new Set([deleteConfirm.id]);

    // Merchants (normalised) from every transaction belonging to this account.
    const accountTxMerchants = new Set(
      transactions
        .filter(t => accIds.has(t.account_id))
        .map(t => normaliseMerchant(t.merchant))
    );

    // Merchants (normalised) from pending recurring patterns sourced from this account.
    const pendingMerchants = new Set(
      pendingPatterns
        .filter(p => !!p.accountId && accIds.has(p.accountId))
        .map(p => normaliseMerchant(p.displayMerchant))
    );

    // Combine all three matching methods, deduplicated by subscription id.
    const linkedMap = new Map<string, import('../types').Subscription>();
    for (const s of subscriptions) {
      const byAccountId = !!s.account_id && accIds.has(s.account_id);
      const byTxMerchant =
        accountTxMerchants.has(normaliseMerchant(s.name)) ||
        (!!s.original_name && accountTxMerchants.has(normaliseMerchant(s.original_name)));
      const byPendingPattern =
        pendingMerchants.has(normaliseMerchant(s.name)) ||
        (!!s.original_name && pendingMerchants.has(normaliseMerchant(s.original_name)));
      if (byAccountId || byTxMerchant || byPendingPattern) linkedMap.set(s.id, s);
    }
    const linked = [...linkedMap.values()];
    if (linked.length > 0) {
      // Resolve account name for the modal title
      const accountName =
        deleteConfirm.type === 'account'
          ? (accounts.find(a => a.id === deleteConfirm.id)?.name ?? 'this account')
          : (creditCards.find(c => c.id === deleteConfirm.id)?.name ?? 'this card');
      const allIds = new Set(linked.map(s => s.id));
      setLinkedSubsPrompt({
        accountId: deleteConfirm.id,
        accountName,
        type: deleteConfirm.type,
        subs: linked,
      });
      setLinkedSubsChecked(allIds);     // all ticked by default
      setDeleteConfirm(null);
      return;
    }
    // No linked subs — proceed directly
    performAccountDelete(deleteConfirm.id, deleteConfirm.type, [], []);
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
            {tab === 'Subscriptions' && pendingRecurringCount > 0 && (
              <span className="ml-1.5 inline-flex items-center justify-center min-w-[18px] h-[18px] bg-[#ef4444] text-white text-[10px] font-bold rounded-full px-1">
                {pendingRecurringCount}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* ── ACCOUNTS TAB ── */}
      {activeTab === 'Accounts' && (
        <div>
          {/* Consent-expired banner with reconnect action */}
          {basiqConsentExpired && (
            <div className="mb-4 px-3 py-2.5 rounded-[8px] text-sm flex items-start justify-between gap-3 bg-[#f59e0b]/10 text-[#f59e0b]">
              <span>Your bank connection has expired. Reconnect to keep syncing live balances and transactions.</span>
              <button
                onClick={handleReconnectBasiq}
                disabled={basiqReconnecting}
                className="flex-shrink-0 px-3 py-1 rounded-[6px] bg-[#f59e0b] text-white text-xs font-semibold disabled:opacity-60"
              >
                {basiqReconnecting ? '⏳ Reconnecting…' : 'Reconnect'}
              </button>
            </div>
          )}

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
                  {/* TEMP: clear a stale Basiq user id, then reload. Remove later. */}
                  <button
                    onClick={handleResetBasiq}
                    className="text-xs text-[#ef4444] hover:underline px-1"
                    title="Clear stale Basiq connection"
                  >
                    Reset Basiq Connection
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
                      <p className="text-lg font-semibold amount">{formatCurrency(acc.display_balance ?? acc.balance, currency)}</p>
                      {acc.currency !== currency && <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">{formatCurrency(acc.balance, acc.currency)}</p>}
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
                  .filter(t => accountIdMatches(t.account_id, card) && t.account_type === 'credit_card')
                  .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
                const isExpanded = expandedCardId === card.id;
                const cardPayments = pendingPayments.filter(p => p.credit_card_id === card.id);
                const hasPending = cardPayments.some(p => p.status === 'pending');
                const isPaidInFull = card.balance_owing <= 0;
                const allCardStatements = creditCardStatements
                  .filter(st => st.credit_card_id === card.id)
                  .sort((a, b) => (b.period_end ?? '').localeCompare(a.period_end ?? ''));
                const showAllStmts = showAllStatementsFor.has(card.id);
                const visibleStatements = showAllStmts ? allCardStatements : allCardStatements.slice(0, 3);
                const lastPayment = card.last_payment_amount != null ? (card.display_last_payment_amount ?? card.last_payment_amount) : null;
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
                            Last payment: {formatCurrency(lastPayment, currency)} on {formatDate(card.last_payment_date)}
                          </p>
                        )}
                        {!isPaidInFull && lastPayment != null && (
                          <p className="text-xs text-[#f59e0b] mt-0.5">
                            Partially paid — {formatCurrency(card.display_balance_owing ?? card.balance_owing, currency)} remaining
                          </p>
                        )}
                      </div>
                      <div className="text-right">
                        <p className={`text-lg font-semibold amount ${isPaidInFull ? 'text-[#22c55e]' : 'text-[#ef4444]'}`}>
                          {formatCurrency(card.display_balance_owing ?? card.balance_owing, currency)}
                        </p>
                        <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">of {formatCurrency(card.display_credit_limit ?? card.credit_limit, currency)} limit</p>
                        {card.currency !== currency && <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">{formatCurrency(card.balance_owing, card.currency)}</p>}
                      </div>
                    </div>
                    <div className="mb-2">
                      <div className="flex justify-between text-xs mb-1">
                        <span className="text-[#6b6b6b] dark:text-[#a0a0a0]">Utilisation <span className="opacity-70">· this statement</span></span>
                        <span className={utilisation > 75 ? 'text-[#ef4444]' : utilisation > 50 ? 'text-[#f59e0b]' : 'text-[#22c55e]'}>{utilisation.toFixed(0)}%</span>
                      </div>
                      <div className="h-1.5 bg-[#e5e5e5] dark:bg-[#2a2a2a] rounded-full overflow-hidden">
                        <div className={`h-full rounded-full ${utilisation > 75 ? 'bg-[#ef4444]' : utilisation > 50 ? 'bg-[#f59e0b]' : 'bg-[#22c55e]'}`} style={{ width: `${Math.min(100, utilisation)}%` }} />
                      </div>
                    </div>
                    <div className="flex items-center justify-between text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">
                      {card.minimum_payment ? <span>Min: {formatCurrency(card.display_minimum_payment ?? card.minimum_payment, currency)}</span> : <span />}
                      <div className="flex items-center gap-3">
                        {dueInDays !== null && (
                          <span className={dueInDays <= 7 ? 'text-[#ef4444] font-medium' : ''}>
                            Due: {formatDate(card.due_date!)} {dueInDays <= 7 ? '⚠️' : ''}
                          </span>
                        )}
                        {!isPaidInFull && !hasPending && allCardStatements.length === 0 && (
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
                    {/* ── Statements (latest 3, older lazy-loaded) ── */}
                    {allCardStatements.length > 0 && (
                      <div className="mt-3 pt-3 border-t border-[#e5e5e5] dark:border-[#2a2a2a] space-y-1">
                        <p className="text-xs font-medium text-[#6b6b6b] dark:text-[#a0a0a0] mb-1">Statements</p>
                        {visibleStatements.map(st => {
                          const remaining = Math.max(0, (st.closing_balance ?? 0) - (st.amount_paid ?? 0));
                          const badge = st.status === 'paid'
                            ? { txt: 'Paid', cls: 'bg-[#22c55e]/15 text-[#22c55e]' }
                            : st.status === 'partial'
                            ? { txt: 'Partial', cls: 'bg-[#f59e0b]/15 text-[#f59e0b]' }
                            : { txt: 'Unpaid', cls: 'bg-[#ef4444]/15 text-[#ef4444]' };
                          return (
                            <div key={st.id} className="flex items-center justify-between px-1 py-1.5 text-xs rounded hover:bg-[#f5f5f5] dark:hover:bg-[#1a1a1a]">
                              <div className="min-w-0">
                                <p className="font-medium truncate">
                                  {formatStatementPeriod(st)}
                                </p>
                                <p className="text-[#6b6b6b] dark:text-[#a0a0a0]">
                                  {formatCurrency(st.display_closing_balance ?? st.closing_balance, currency)}
                                  {st.status === 'partial' && ` · ${formatCurrency(remaining, currency)} left`}
                                  {st.due_date && ` · due ${formatDate(st.due_date)}`}
                                </p>
                              </div>
                              <div className="flex items-center gap-2 shrink-0">
                                <span className={`badge ${badge.cls}`}>{badge.txt}</span>
                                {st.status !== 'paid' && (
                                  <button
                                    onClick={e => { e.stopPropagation(); setPayStatement(st); }}
                                    className="text-[#3b7dd8] hover:underline font-medium"
                                    title="Mark statement paid"
                                  >
                                    ✓ Paid
                                  </button>
                                )}
                              </div>
                            </div>
                          );
                        })}
                        {!showAllStmts && allCardStatements.length > 3 && (
                          <button
                            onClick={async e => {
                              e.stopPropagation();
                              const oldest = allCardStatements[allCardStatements.length - 1];
                              if (oldest?.period_end) await creditCardStatementsDS.loadOlder(card.id, oldest.period_end);
                              setShowAllStatementsFor(prev => new Set(prev).add(card.id));
                            }}
                            className="text-xs text-[#3b7dd8] hover:underline pt-1"
                          >
                            Show older statements
                          </button>
                        )}
                      </div>
                    )}

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
                                    {tx.amount < 0 ? '-' : '+'}{formatCurrency(Math.abs(tx.display_amount ?? tx.amount), currency)}
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
            <div className="flex gap-2 flex-wrap">
              <Button
                variant="secondary" size="sm"
                onClick={() => {
                  clearSessionSkips();
                  bgActiveRef.current = false;
                  setRecurringModalActive(false);
                  setPendingPatterns([]);
                  setPendingRecurringCount(0);
                  setRecurringShowImmediate(true);
                  triggerDetection();
                }}
              >
                Find recurring payments
              </Button>
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
                <div
                  key={sub.id}
                  className="flex items-center justify-between p-3 card cursor-pointer"
                  onClick={(e) => {
                    // Open detail view only when the click did NOT originate from an
                    // existing interactive element (rename button, rename form/input,
                    // amount, or the ✕ delete button). Purely additive — existing
                    // handlers keep working untouched.
                    if ((e.target as HTMLElement).closest('button, form, input')) return;
                    setDetailSubId(sub.id);
                  }}
                >
                  <div className="flex-1 min-w-0 mr-3">
                    {renamingSubId === sub.id ? (
                      /* ── Inline rename input ── */
                      <form
                        onSubmit={e => {
                          e.preventDefault();
                          const v = renameValue.trim();
                          if (v) subscriptionsDS.rename(sub.id, v);
                          setSubscriptions(subscriptionsDS.getAll());
                          setRenamingSubId(null);
                        }}
                        className="flex items-center gap-2"
                      >
                        <input
                          autoFocus
                          className="input text-sm flex-1"
                          value={renameValue}
                          onChange={e => setRenameValue(e.target.value)}
                          onBlur={() => {
                            const v = renameValue.trim();
                            if (v) subscriptionsDS.rename(sub.id, v);
                            setSubscriptions(subscriptionsDS.getAll());
                            setRenamingSubId(null);
                          }}
                          onKeyDown={e => { if (e.key === 'Escape') setRenamingSubId(null); }}
                        />
                      </form>
                    ) : (
                      /* ── Display name (click to rename) ── */
                      <button
                        className="text-left w-full group"
                        onClick={() => { setRenamingSubId(sub.id); setRenameValue(sub.name); }}
                        title="Click to rename"
                      >
                        <p className="font-medium text-sm group-hover:text-[#3b7dd8] transition-colors">
                          {sub.name}
                          {sub.original_name && sub.original_name !== sub.name && (
                            <span className="ml-1 font-normal text-[#9b9b9b] dark:text-[#666]">
                              ({sub.original_name})
                            </span>
                          )}
                        </p>
                      </button>
                    )}
                    <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0] mt-0.5">
                      {sub.category} · {sub.frequency}
                      {sub.next_charge_date && ` · Next: ${formatDate(sub.next_charge_date)}`}
                    </p>
                  </div>
                  <div className="flex items-center gap-3 flex-shrink-0">
                    <span className="text-sm font-semibold amount">{formatCurrency(sub.display_amount ?? sub.amount, sub.display_currency ?? sub.currency)}</span>
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
                        {(() => {
                          const accountName = resolveAccountName(tx, accounts, creditCards);
                          return accountName ? (
                            <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0] truncate">{accountName}</p>
                          ) : null;
                        })()}
                      </div>
                    </div>
                    <span className={`text-sm font-semibold amount ${tx.amount < 0 ? 'text-[#ef4444]' : 'text-[#22c55e]'}`}>
                      {tx.amount < 0 ? '-' : '+'}{formatCurrency(Math.abs(tx.display_amount ?? tx.amount), currency)}
                    </span>
                  </div>
                );
              })}
              {/* Load older history on demand — hidden while searching (search
                  already queries the full local set) and once we hit the start. */}
              {!txSearch && (
                <div className="pt-4 flex justify-center">
                  {allHistoryLoaded ? (
                    <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">All transactions loaded</p>
                  ) : (
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={loadingOlder}
                      onClick={async () => {
                        setLoadingOlder(true);
                        try {
                          const added = await loadOlderTransactions();
                          setTransactions(transactionsDS.getAll());
                          if (added === 0) setAllHistoryLoaded(true);
                        } catch {
                          setToast('Could not load older transactions');
                        } finally {
                          setLoadingOlder(false);
                        }
                      }}
                    >
                      {loadingOlder ? 'Loading…' : 'Load older transactions'}
                    </Button>
                  )}
                </div>
              )}
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
          const finish = (existing?: import('../types').BankAccount) => { doAdd(existing); clearSessionSkips(); setAddAccountOpen(false); setAccounts(accountsDS.getAll()); setTransactions(transactionsDS.getAll()); triggerDetectionPasses(); };
          if (dup) {
            // Import the statement's transactions into the existing account rather
            // than creating a duplicate (which would orphan its transactions later).
            setDuplicatePrompt({ message: `This matches your existing account "${dup.name}" (${dup.institution}). Its transactions will be imported into that account.`, onAddAnyway: () => finish(dup) });
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
          const finish = (existing?: CreditCard) => { doAdd(existing); clearSessionSkips(); setAddCardOpen(false); setCreditCards(creditCardsDS.getAll()); setTransactions(transactionsDS.getAll()); setBills(billsDS.getAll()); triggerDetectionPasses(); };
          if (dup) {
            // Import into the existing card rather than creating a duplicate.
            setDuplicatePrompt({ message: `This matches your existing card "${dup.name}" (${dup.institution}). Its transactions will be imported into that card.`, onAddAnyway: () => finish(dup) });
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

      {(() => {
        const detailSub = detailSubId ? subscriptions.find(s => s.id === detailSubId) : null;
        return detailSub ? (
          <SubscriptionDetailModal
            sub={detailSub}
            transactions={transactions}
            bills={bills}
            onClose={() => setDetailSubId(null)}
            onChanged={() => { setSubscriptions(subscriptionsDS.getAll()); setBills(billsDS.getAll()); }}
            onDeleted={() => {
              subscriptionsDS.remove(detailSub.id);
              setSubscriptions(subscriptionsDS.getAll());
              setBills(billsDS.getAll());
              setDetailSubId(null);
            }}
          />
        ) : null;
      })()}

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
                  original_name: null,
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
            onClose={() => { const reopen = uploadCardOpen; setUploadCardOpen(null); if (reopen) setDetailCardId(reopen); }}
            card={card}
            onSaved={() => {
              clearSessionSkips();
              setCreditCards(creditCardsDS.getAll());
              setTransactions(transactionsDS.getAll());
              setBills(billsDS.getAll());
              triggerDetectionPasses();
              const reopen = uploadCardOpen;
              setUploadCardOpen(null);
              if (reopen) setDetailCardId(reopen);
            }}
          />
        );
      })()}

      {/* Account detail modal */}
      {detailAccountId && (() => {
        const acc = accounts.find(a => a.id === detailAccountId);
        if (!acc) return null;
        const accIds = accountIdVariants(acc);
        return (
          <AccountDetailModal
            account={acc}
            transactions={transactions.filter(t => accIds.has(t.account_id) && t.account_type === 'bank')}
            internalTransferIds={internalTransferIds}
            currency={currency}
            onClose={() => setDetailAccountId(null)}
            onDeleteTx={(id) => { transactionsDS.remove(id); setTransactions(transactionsDS.getAll()); }}
            onCategoryChange={(id, category) => { transactionsDS.update(id, { category }); setTransactions(transactionsDS.getAll()); }}
            onRename={(name) => { accountsDS.update(acc.id, { name }); setAccounts(accountsDS.getAll()); }}
            onAddTransaction={(d) => {
              const signed = d.direction === 'in' ? Math.abs(d.amount) : -Math.abs(d.amount);
              transactionsDS.add({
                account_id: acc.id, account_type: 'bank', date: d.date,
                merchant: d.merchant, amount: signed, currency: acc.currency,
                category: d.category || autoCategory(d.merchant),
                is_duplicate_flagged: false, is_subscription: false,
              });
              setTransactions(transactionsDS.getAll());
            }}
            onImportTransactions={(txns) => {
              // Dedup on date + signed amount + account_type (same rule as the add
              // flow) so re-uploading a statement never piles up duplicates.
              const existing = transactionsDS.getAll();
              let added = 0;
              for (const tx of txns) {
                const normalizedAmt = tx.type === 'credit' ? Math.abs(tx.amount) : -Math.abs(tx.amount);
                const isDup = existing.some(ex =>
                  ex.account_type === 'bank' && ex.date === tx.date && Math.abs(ex.amount - normalizedAmt) < 0.01
                );
                if (isDup) continue;
                transactionsDS.add({
                  account_id: acc.id, account_type: 'bank', date: tx.date, merchant: tx.merchant,
                  amount: normalizedAmt, currency: acc.currency, category: autoCategory(tx.merchant),
                  is_duplicate_flagged: false, is_subscription: false,
                });
                added++;
              }
              if (added) setTransactions(transactionsDS.getAll());
              return added;
            }}
          />
        );
      })()}

      {/* Credit card detail modal */}
      {detailCardId && (() => {
        const card = creditCards.find(c => c.id === detailCardId);
        if (!card) return null;
        const cardIds = accountIdVariants(card);
        return (
          <CardDetailModal
            card={card}
            transactions={transactions.filter(t => cardIds.has(t.account_id) && t.account_type === 'credit_card')}
            statements={creditCardStatements
              .filter(st => st.credit_card_id === card.id)
              .sort((a, b) => (b.period_end ?? '').localeCompare(a.period_end ?? ''))}
            internalTransferIds={internalTransferIds}
            onClose={() => setDetailCardId(null)}
            onDeleteTx={(id) => { transactionsDS.remove(id); setTransactions(transactionsDS.getAll()); }}
            onCategoryChange={(id, category) => { transactionsDS.update(id, { category }); setTransactions(transactionsDS.getAll()); }}
            onPayStatement={(st) => setPayStatement(st)}
            onAddStatement={() => { setDetailCardId(null); setUploadCardOpen(card.id); }}
            onAddTransaction={(d) => {
              transactionsDS.add({
                account_id: card.id, account_type: 'credit_card', date: d.date,
                merchant: d.merchant, amount: -Math.abs(d.amount), currency: card.currency,
                category: d.category || autoCategory(d.merchant),
                is_duplicate_flagged: false, is_subscription: false,
              });
              setTransactions(transactionsDS.getAll());
            }}
            onLoadOlder={(before) => creditCardStatementsDS.loadOlder(card.id, before)}
            onEnsureStatement={() => creditCardStatementsDS.add({
              credit_card_id: card.id,
              closing_balance: card.balance_owing,
              period_label: 'Current statement',
              due_date: card.due_date ?? null,
              source: 'manual',
              currency: card.currency,
            })}
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

      {/* Confirm marking a statement paid */}
      <Modal isOpen={!!payStatement} onClose={() => setPayStatement(null)} title="Mark statement as paid?" size="sm">
        {payStatement && (() => {
          const cardName = creditCards.find(c => c.id === payStatement.credit_card_id)?.name ?? 'this card';
          const remaining = Math.max(0, (payStatement.closing_balance ?? 0) - (payStatement.amount_paid ?? 0));
          return (
            <>
              <p className="text-sm text-[#6b6b6b] dark:text-[#a0a0a0] mb-5">
                Confirm you've paid the {formatCurrency(remaining, currency)} owing on the{' '}
                {payStatement.period_label || (payStatement.period_end ? formatDate(payStatement.period_end) : '')} statement
                for {cardName}? The card stays — only this statement is marked paid.
              </p>
              <div className="flex gap-3">
                <Button variant="secondary" fullWidth onClick={() => setPayStatement(null)}>Cancel</Button>
                <Button variant="primary" fullWidth onClick={() => { creditCardStatementsDS.markPaid(payStatement.id); setPayStatement(null); }}>Mark paid</Button>
              </div>
            </>
          );
        })()}
      </Modal>

      {/* Credit-card payment prompts (which-card / whole-amount) */}
      {ccPaymentPrompts.length > 0 && (() => {
        const prompt = ccPaymentPrompts[0];
        const amountStr = formatCurrency(prompt.amount, currency);
        if (prompt.kind === 'which-card') {
          const candidates = creditCards.filter(c => (prompt.candidate_card_ids ?? []).includes(c.id));
          return (
            <Modal isOpen={true} onClose={() => ccPaymentPromptsDS.dismiss(prompt.id)} title="Which card was this payment for?" size="sm">
              <p className="text-sm text-[#6b6b6b] dark:text-[#a0a0a0] mb-4">
                We saw a {amountStr} payment to "{prompt.merchant}" but couldn't tell which card it clears.
              </p>
              <div className="space-y-2">
                {candidates.map(c => (
                  <Button key={c.id} variant="secondary" fullWidth onClick={() => ccPaymentPromptsDS.resolveWhichCard(prompt.id, c.id)}>
                    {c.name} — {c.institution}
                  </Button>
                ))}
                <Button variant="secondary" fullWidth onClick={() => ccPaymentPromptsDS.dismiss(prompt.id)}>Not a card payment</Button>
              </div>
            </Modal>
          );
        }
        // whole-amount
        const cardName = creditCards.find(c => c.id === prompt.card_id)?.name ?? 'your card';
        return (
          <Modal isOpen={true} onClose={() => ccPaymentPromptsDS.dismiss(prompt.id)} title="Was this the whole amount?" size="sm">
            <p className="text-sm text-[#6b6b6b] dark:text-[#a0a0a0] mb-4">
              We saw a {amountStr} payment to {cardName} but there's no statement for it yet. Did this clear the full balance?
            </p>
            <div className="flex gap-3">
              <Button variant="secondary" fullWidth onClick={() => ccPaymentPromptsDS.dismiss(prompt.id)}>Not now</Button>
              <Button variant="primary" fullWidth onClick={() => ccPaymentPromptsDS.resolveWholeAmount(prompt.id, true)}>
                Yes, paid in full
              </Button>
            </div>
            <p className="text-xs text-center text-[#6b6b6b] dark:text-[#a0a0a0] mt-3">
              If not, upload the statement instead and the {amountStr} will apply against it.
            </p>
          </Modal>
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
              original_name: null,
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
      <Modal
        isOpen={!!linkedSubsPrompt}
        onClose={() => setLinkedSubsPrompt(null)}
        title={linkedSubsPrompt ? `Subscriptions linked to ${linkedSubsPrompt.accountName}` : ''}
        size="sm"
      >
        {linkedSubsPrompt && (() => {
          const { accountId, type, subs } = linkedSubsPrompt;

          const toggleSub = (id: string) => {
            setLinkedSubsChecked(prev => {
              const next = new Set(prev);
              if (next.has(id)) next.delete(id); else next.add(id);
              return next;
            });
          };

          // Delete ticked subscriptions, unlink (keep) unticked ones, then delete the account.
          const confirmDelete = () => {
            const toDelete = subs.filter(s => linkedSubsChecked.has(s.id)).map(s => s.id);
            const toUnlink = subs.filter(s => !linkedSubsChecked.has(s.id)).map(s => s.id);
            performAccountDelete(accountId, type, toDelete, toUnlink);
            setLinkedSubsPrompt(null);
          };

          // Keep all subscriptions (just unlink them), then delete the account.
          const confirmKeepAll = () => {
            const toUnlink = subs.map(s => s.id);
            performAccountDelete(accountId, type, [], toUnlink);
            setLinkedSubsPrompt(null);
          };

          const freqMap: Record<string, number> = { weekly: 4.33, fortnightly: 2.17, monthly: 1, quarterly: 0.333, annually: 0.083 };

          return (
            <>
              <p className="text-sm text-[#6b6b6b] dark:text-[#a0a0a0] mb-3">
                The following subscriptions are linked to this account. Tick the ones you want to delete — unticked subscriptions will be kept.
              </p>
              <div className="space-y-2 mb-5">
                {subs.map(sub => {
                  const checked = linkedSubsChecked.has(sub.id);
                  const monthly = (sub.display_amount ?? sub.amount) * (freqMap[sub.frequency] ?? 1);
                  return (
                    <label
                      key={sub.id}
                      className="flex items-start gap-3 p-3 rounded-[8px] border border-[#e5e5e5] dark:border-[#2a2a2a] cursor-pointer hover:bg-[#f5f5f5] dark:hover:bg-[#1a1a1a] transition-colors"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleSub(sub.id)}
                        className="mt-0.5 accent-[#ef4444] flex-shrink-0"
                      />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-[#1a1a1a] dark:text-[#f0f0f0]">
                          {sub.name}
                          {sub.original_name && sub.original_name !== sub.name && (
                            <span className="ml-1 font-normal text-[#9b9b9b] dark:text-[#666]">({sub.original_name})</span>
                          )}
                        </p>
                        <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">
                          {formatCurrency(sub.display_amount ?? sub.amount, sub.display_currency ?? sub.currency)} {sub.frequency}
                          {' · '}{formatCurrency(monthly, sub.display_currency ?? sub.currency)}/mo
                        </p>
                      </div>
                    </label>
                  );
                })}
              </div>
              <div className="flex gap-2">
                <Button variant="secondary" size="sm" onClick={() => setLinkedSubsPrompt(null)}>Cancel</Button>
                <Button
                  variant="secondary"
                  size="sm"
                  fullWidth
                  onClick={confirmKeepAll}
                >
                  Keep all
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  fullWidth
                  onClick={confirmDelete}
                >
                  Delete account
                </Button>
              </div>
            </>
          );
        })()}
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
            bgActiveRef.current = false;
            setRecurringModalActive(false);
            setBgPatterns([]);
            setBgPatternIdx(0);
            setBgSubName('');
            setBgAmount('');
            setBgNameEditing(false);
            alsoAddToBillsRef.current = false;
            setAlsoAddToBills(false);
            payMethodRef.current = 'manual';
            setPayMethod('manual');
            triggerDetection();
          } else {
            setBgPatternIdx(nextIdx);
            setBgSubName(bgPatterns[nextIdx].displayMerchant);
            setBgAmount(bgPatterns[nextIdx].amount.toFixed(2));
            setBgNameEditing(false);
            alsoAddToBillsRef.current = false;
            setAlsoAddToBills(false);
            payMethodRef.current = 'manual';
            setPayMethod('manual');
          }
        };

        // X close button: session-skip this pattern so it doesn't re-show
        // within the same browser session, then move to the next item.
        const skip = () => {
          sessionSkipPattern(pattern);
          advance();
        };

        // Most-recent transaction date for this pattern (sorted asc, last item)
        const lastTxDate = pattern.matchingTransactions[pattern.matchingTransactions.length - 1]?.date
          ?? new Date().toISOString().split('T')[0];
        const nextChargeDate = calcNextChargeDate(lastTxDate, pattern.frequency);

        // Do the underlying transaction amounts actually differ? If they're all the
        // same we pre-fill the amount and stay quiet about it; if they vary we ask
        // the user which amount to record, defaulting to the detected average.
        const txAmounts = pattern.matchingTransactions.map(t => Math.abs(t.amount));
        const minAmt = Math.min(...txAmounts);
        const maxAmt = Math.max(...txAmounts);
        const amountsVary = (maxAmt - minAmt) > 0.005;
        // Parsed, validated amount the user will actually save (falls back to the
        // detected average if the field is blank or non-numeric).
        const parsedBgAmount = parseFloat(bgAmount);
        const chosenAmount = Number.isFinite(parsedBgAmount) && parsedBgAmount > 0
          ? parsedBgAmount
          : pattern.amount;

        return (
          <Modal
            isOpen
            onClose={skip}
            title={`Recurring payment detected${total > 1 ? ` — ${current} of ${total}` : ''}`}
            size="md"
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

            {/* Summary line */}
            <p className="text-sm text-[#6b6b6b] dark:text-[#a0a0a0] mb-2">
              {pattern.frequency === 'irregular'
                ? <>Detected <strong>irregular recurring</strong> charge of{' '}<strong>{formatCurrency(pattern.amount, 'AUD')}</strong> avg — add as subscription?</>
                : <>Detected <strong>{pattern.frequency}</strong> charge of{' '}<strong>{formatCurrency(pattern.amount, 'AUD')}</strong> avg, next due{' '}
                    <strong>{new Date(nextChargeDate).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' })}</strong> — add as subscription?</>
              }
            </p>

            {/* Soft nudge — detection is reliable but not infallible, so prompt a glance */}
            <p className="text-xs text-[#9b8b3b] dark:text-[#d4c15e] mb-3 flex items-start gap-1.5">
              <svg className="w-3.5 h-3.5 flex-shrink-0 mt-px" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
              <span>This is almost always right, but just in case — have a quick look at the frequency and next due date before adding.</span>
            </p>

            {/* Editable subscription name — label-style until clicked */}
            <div className="mb-4">
              <label className="block text-xs font-medium text-[#6b6b6b] dark:text-[#a0a0a0] mb-1">
                Subscription name
              </label>
              {bgNameEditing ? (
                <input
                  autoFocus
                  className="input w-full text-sm"
                  value={bgSubName}
                  onChange={e => setBgSubName(e.target.value)}
                  onBlur={() => setBgNameEditing(false)}
                  onKeyDown={e => { if (e.key === 'Enter' || e.key === 'Escape') setBgNameEditing(false); }}
                  placeholder="e.g. Gym, Netflix, Spotify…"
                />
              ) : (
                <button
                  type="button"
                  className="w-full flex items-center justify-between px-3 py-2 rounded-[8px] border border-[#e5e5e5] dark:border-[#2a2a2a] bg-[#fafafa] dark:bg-[#1a1a1a] hover:border-[#3b7dd8] transition-colors group text-left"
                  onClick={() => setBgNameEditing(true)}
                  title="Click to rename"
                >
                  <span className="text-sm text-[#1a1a1a] dark:text-[#f0f0f0]">
                    {bgSubName || pattern.displayMerchant}
                  </span>
                  {/* Pencil icon */}
                  <svg className="w-3.5 h-3.5 text-[#9b9b9b] group-hover:text-[#3b7dd8] flex-shrink-0 ml-2 transition-colors" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                  </svg>
                </button>
              )}
            </div>

            {/* Editable amount — prompt when amounts vary, quietly pre-filled when they don't */}
            <div className="mb-4">
              <label className="block text-xs font-medium text-[#6b6b6b] dark:text-[#a0a0a0] mb-1">
                {amountsVary ? 'Amount to record' : 'Amount'}
              </label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-[#9b9b9b] pointer-events-none">$</span>
                <input
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  min="0"
                  className="input w-full text-sm pl-7"
                  value={bgAmount}
                  onChange={e => setBgAmount(e.target.value)}
                  placeholder={pattern.amount.toFixed(2)}
                />
              </div>
              {amountsVary && (
                <p className="text-xs text-[#9b8b3b] dark:text-[#d4c15e] mt-1.5">
                  These payments range from {formatCurrency(minAmt, 'AUD')} to {formatCurrency(maxAmt, 'AUD')}.
                  We've suggested the {formatCurrency(pattern.amount, 'AUD')} average — edit it if you'd prefer a different amount.
                </p>
              )}
            </div>

            {/* Evidence table */}
            <div className="rounded-[8px] border border-[#e5e5e5] dark:border-[#2a2a2a] overflow-hidden mb-4">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-[#f5f5f5] dark:bg-[#1e1e1e]">
                    <th className="text-left px-3 py-2 font-medium text-[#6b6b6b] dark:text-[#a0a0a0]">Date</th>
                    <th className="text-left px-3 py-2 font-medium text-[#6b6b6b] dark:text-[#a0a0a0]">Merchant</th>
                    <th className="text-right px-3 py-2 font-medium text-[#6b6b6b] dark:text-[#a0a0a0]">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {pattern.matchingTransactions.map((tx, i) => (
                    <tr key={tx.id} className={i % 2 === 0 ? '' : 'bg-[#fafafa] dark:bg-[#1a1a1a]'}>
                      <td className="px-3 py-2 text-[#1a1a1a] dark:text-[#f0f0f0] whitespace-nowrap">
                        {new Date(tx.date).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' })}
                      </td>
                      <td className="px-3 py-2 text-[#1a1a1a] dark:text-[#f0f0f0] truncate max-w-[160px]">{tx.merchant}</td>
                      <td className="px-3 py-2 text-right text-[#d94c4c] dark:text-[#f87171] whitespace-nowrap">
                        {formatCurrency(Math.abs(tx.amount), 'AUD')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Also add to bills toggle */}
            <div
              className="flex items-center gap-2 mb-5 cursor-pointer select-none"
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); handleBillsToggleChange(!alsoAddToBills); }}
            >
              <div
                className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${alsoAddToBills ? 'bg-[#3b7dd8]' : 'bg-[#d1d5db] dark:bg-[#4b5563]'}`}
              >
                <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform ${alsoAddToBills ? 'translate-x-4' : 'translate-x-0.5'}`} />
              </div>
              <span className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">Also add to bills/reminders</span>
            </div>

            {/* Payment method: Auto vs Manual (only relevant when adding to bills) */}
            {alsoAddToBills && (
              <div className="flex items-center justify-between gap-3 mb-5">
                <span className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">Payment method</span>
                <div className="inline-flex rounded-[8px] border border-[#e5e5e5] dark:border-[#2a2a2a] overflow-hidden">
                  <button
                    type="button"
                    onClick={() => { payMethodRef.current = 'auto'; setPayMethod('auto'); }}
                    className={`flex items-center gap-1 px-3 py-1.5 text-xs font-medium transition-colors ${payMethod === 'auto' ? 'bg-[#22c55e] text-white' : 'text-[#6b6b6b] dark:text-[#a0a0a0] hover:bg-[#f5f5f5] dark:hover:bg-[#1a1a1a]'}`}
                  >
                    ⚡ Auto
                  </button>
                  <button
                    type="button"
                    onClick={() => { payMethodRef.current = 'manual'; setPayMethod('manual'); }}
                    className={`px-3 py-1.5 text-xs font-medium transition-colors ${payMethod === 'manual' ? 'bg-[#3b7dd8] text-white' : 'text-[#6b6b6b] dark:text-[#a0a0a0] hover:bg-[#f5f5f5] dark:hover:bg-[#1a1a1a]'}`}
                  >
                    Manual
                  </button>
                </div>
              </div>
            )}

            <div className="flex gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  // Session-only skip — re-surfaces on page reload. No permanent memory.
                  sessionSkipPattern(pattern);
                  advance();
                }}
              >
                Ignore
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  // "Not a regular payment" — the user is telling us this is NOT a
                  // recurring charge. We permanently dismiss the pattern so it never
                  // re-surfaces, but we NEVER delete the underlying transactions.
                  dismissPatternPermanently(pattern);
                  sessionSkipPattern(pattern);
                  advance();
                  setToast(`Won't ask about ${pattern.displayMerchant} again.`);
                }}
              >
                Not a regular payment
              </Button>
              <Button
                variant="primary"
                size="sm"
                fullWidth
                onClick={() => {
                  const savedName = bgSubName.trim() || pattern.displayMerchant;
                  // Subscription deduplication — must match BOTH name AND amount (within 2%).
                  // For transfer-like merchants use raw case-insensitive comparison so
                  // "Transfer xx1368 $400" and "Transfer xx2319 $200" are never confused.
                  const isTransferPattern = pattern.merchant.startsWith('TRANSFER::');
                  const rawDisplay = pattern.displayMerchant.toUpperCase().trim();
                  const existingSub = subscriptions.find(s => {
                    const amtMatch = Math.abs(s.amount - chosenAmount) / Math.max(s.amount, 0.01) <= 0.02;
                    if (!amtMatch) return false;
                    if (isTransferPattern) {
                      return s.name.toUpperCase().trim() === rawDisplay ||
                        (!!s.original_name && s.original_name.toUpperCase().trim() === rawDisplay);
                    }
                    return normaliseMerchant(s.name) === normaliseMerchant(pattern.displayMerchant) ||
                      (!!s.original_name && normaliseMerchant(s.original_name) === normaliseMerchant(pattern.displayMerchant));
                  });
                  // Capture ref values BEFORE advance() resets them
                  const shouldAddToBills = alsoAddToBillsRef.current;
                  const billAutoPay = payMethodRef.current === 'auto';
                  advance();
                  if (existingSub) {
                    setToast(`Already tracking ${existingSub.name} as a subscription — transactions linked.`);
                    return;
                  }
                  subscriptionsDS.add({
                    name: savedName,
                    original_name: savedName !== pattern.displayMerchant ? pattern.displayMerchant : null,
                    amount: chosenAmount,
                    currency: 'AUD',
                    frequency: pattern.frequency,
                    next_charge_date: nextChargeDate,
                    category: autoCategory(pattern.displayMerchant),
                    is_auto_detected: true,
                    account_id: pattern.accountId,
                  });
                  setSubscriptions(subscriptionsDS.getAll());
                  if (shouldAddToBills) {
                    billsDS.add({
                      name: savedName,
                      amount: chosenAmount,
                      due_date: nextChargeDate,
                      is_recurring: true,
                      frequency: pattern.frequency,
                      colour: 'grey',
                      is_paid: false,
                      auto_pay: billAutoPay,
                      calendar_synced: false,
                    });
                    setBills(billsDS.getAll());
                  }
                  setToast(`Added ${savedName} as a ${pattern.frequency} subscription${shouldAddToBills ? ' + bill' : ''}.`);
                }}
              >
                Add Subscription / Recurring Bill
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

const TX_CATEGORIES = BASE_TX_CATEGORIES;

/**
 * Ensure an account's display name is the product/account type, not the holder's
 * personal name. Statement parsers sometimes return "HARRY JAMES CAMERON" as the
 * account name — when the value looks like a person's name (or is empty) fall back
 * to "<institution> <account_type>".
 */
function sanitizeAccountName(
  rawName: string,
  institution: string,
  accountType: string,
  accountNumber?: string,
): string {
  const name = (rawName ?? '').trim();
  const at = (accountType ?? '').trim();
  const inst = (institution ?? '').trim();
  const num = (accountNumber ?? '').replace(/\s/g, '');

  // Priority fallback chain:
  //  1. institution + account type (e.g. "CommBank Smart Access")
  //  2. "Account XXXX" using last 4 digits of account number
  //  3. institution alone
  const instAt = inst && at ? `${inst} ${at}` : (at || '');
  const last4 = num.length >= 4 ? `Account ${num.slice(-4)}` : '';
  const fallback = instAt || last4 || inst;

  // Looks like a person's name: 2+ all-caps/title words, letters only (no digits,
  // no product keywords like "Access", "Account", "Savings", "Everyday").
  const productKeywords = /(access|account|saver|savings|everyday|spend|transaction|offset|complete|streamline|orange|smart|cheque|checking|debit)/i;
  const looksLikePerson =
    !!name &&
    !/\d/.test(name) &&
    name.split(/\s+/).length >= 2 &&
    !productKeywords.test(name) &&
    name === name.toUpperCase();

  if ((!name || looksLikePerson) && fallback) return fallback;
  return name;
}

/** Resolve a transaction's owning account/card name, tolerating local↔server id swaps. */
function resolveAccountName(
  tx: { account_id: string; account_type: 'bank' | 'credit_card' },
  accounts: import('../types').BankAccount[],
  creditCards: CreditCard[],
): string | null {
  const matches = (a: { id: string; localId?: string; serverId?: string }) =>
    accountIdMatches(tx.account_id, a);
  if (tx.account_type === 'credit_card') return creditCards.find(matches)?.name ?? null;
  return accounts.find(matches)?.name ?? null;
}

function TransactionRow({ tx, onDelete, onCategoryChange, isTransfer }: {
  tx: import('../types').Transaction;
  onDelete: (id: string) => void;
  onCategoryChange: (id: string, category: string) => void;
  isTransfer?: boolean;
}) {
  const [catOpen, setCatOpen] = useState(false);
  const { accounts, creditCards } = useStore();
  const allCategories = useAllCategories();
  const accountName = resolveAccountName(tx, accounts, creditCards);
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
            {isTransfer && (
              <span
                className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-[#3b7dd8]/10 text-[#3b7dd8]"
                title="Money moved between your own accounts — not counted as spending"
              >
                🔄 Transfer
              </span>
            )}
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
                  {allCategories.map(cat => (
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
          {accountName && (
            <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0] mt-0.5 truncate">{accountName}</p>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2 flex-shrink-0 ml-3">
        <span className={`text-sm font-semibold amount ${tx.amount < 0 ? 'text-[#ef4444]' : 'text-[#22c55e]'}`}>
          {tx.amount < 0 ? '-' : '+'}{formatCurrency(Math.abs(tx.display_amount ?? tx.amount), tx.display_currency ?? tx.currency)}
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

function AccountDetailModal({ account, transactions, internalTransferIds, currency, onClose, onDeleteTx, onCategoryChange, onRename, onAddTransaction, onImportTransactions }: {
  account: import('../types').BankAccount;
  transactions: import('../types').Transaction[];
  internalTransferIds: Set<string>;
  currency: string;
  onClose: () => void;
  onDeleteTx: (id: string) => void;
  onCategoryChange: (id: string, category: string) => void;
  onRename: (name: string) => void;
  onAddTransaction: (d: { date: string; merchant: string; amount: number; category: string; direction: 'in' | 'out' }) => void;
  onImportTransactions: (txns: ParsedBankTx[]) => number;
}) {
  const [search, setSearch] = useState('');
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(account.name);
  // Statements (monthly periods) the user has expanded — mirrors CardDetailModal.
  const [expandedStmtKeys, setExpandedStmtKeys] = useState<Set<string>>(new Set());
  const toggleStmt = (key: string) =>
    setExpandedStmtKeys(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  const [showAllStmts, setShowAllStmts] = useState(false);
  const [showAddTx, setShowAddTx] = useState(false);
  const [txForm, setTxForm] = useState({ date: new Date().toISOString().split('T')[0], merchant: '', amount: '', category: '', direction: 'out' as 'in' | 'out' });
  const [uploading, setUploading] = useState(false);
  const [uploadMsg, setUploadMsg] = useState('');

  const saveName = () => {
    const next = nameDraft.trim();
    if (next && next !== account.name) onRename(next);
    setEditingName(false);
  };

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true); setUploadMsg('');
    const { parsed, error } = await parseDocument(file, 'bank_statement');
    setUploading(false);
    e.target.value = '';
    if (error) { setUploadMsg(error); return; }
    const acc0 = (parsed as { accounts?: Record<string, unknown>[] } | null)?.accounts?.[0];
    const txns = (acc0?.transactions as ParsedBankTx[]) ?? [];
    if (!txns.length) { setUploadMsg('No transactions found in that document.'); return; }
    const added = onImportTransactions(txns);
    setUploadMsg(added > 0
      ? `Imported ${added} new transaction${added !== 1 ? 's' : ''}.`
      : 'No new transactions — they were already imported.');
  };

  const sorted = [...transactions].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  // Group transactions into monthly "statements" (YYYY-MM), newest first. Banks
  // have no closing-balance statement records like credit cards, so the calendar
  // month is the natural billing period.
  const monthKeys: string[] = [];
  const monthSeen = new Set<string>();
  for (const t of sorted) {
    const key = (t.date ?? '').slice(0, 7);
    if (key && !monthSeen.has(key)) { monthSeen.add(key); monthKeys.push(key); }
  }
  const monthLabel = (key: string) => {
    const [y, m] = key.split('-').map(Number);
    return new Date(y, (m ?? 1) - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  };

  // When statements are expanded, only show transactions inside those months.
  const openKeys = monthKeys.filter(k => expandedStmtKeys.has(k));
  const inWindow = openKeys.length
    ? sorted.filter(t => openKeys.includes((t.date ?? '').slice(0, 7)))
    : sorted;
  const filtered = search
    ? inWindow.filter(t => t.merchant.toLowerCase().includes(search.toLowerCase()))
    : inWindow;

  const now = new Date();
  const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const thisYearStart  = new Date(now.getFullYear(), 0, 1);

  const spentMonth = sorted
    .filter(t => new Date(t.date) >= thisMonthStart && t.amount < 0 && !internalTransferIds.has(t.id))
    .reduce((s, t) => s + Math.abs(t.display_amount ?? t.amount), 0);
  const inMonth = sorted
    .filter(t => new Date(t.date) >= thisMonthStart && t.amount > 0 && !internalTransferIds.has(t.id))
    .reduce((s, t) => s + Math.abs(t.display_amount ?? t.amount), 0);
  const spentYear = sorted
    .filter(t => new Date(t.date) >= thisYearStart && t.amount < 0 && !internalTransferIds.has(t.id))
    .reduce((s, t) => s + Math.abs(t.display_amount ?? t.amount), 0);

  return (
    <Modal isOpen onClose={onClose} size="xl" title={account.name}>
      {/* Editable account name — renaming propagates everywhere via account_id */}
      <div className="mb-4">
        {editingName ? (
          <div className="flex items-center gap-2">
            <input
              className="input flex-1"
              value={nameDraft}
              autoFocus
              onChange={e => setNameDraft(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') saveName(); if (e.key === 'Escape') { setNameDraft(account.name); setEditingName(false); } }}
            />
            <Button variant="primary" size="sm" type="button" onClick={saveName}>Save</Button>
            <Button variant="secondary" size="sm" type="button" onClick={() => { setNameDraft(account.name); setEditingName(false); }}>Cancel</Button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => { setNameDraft(account.name); setEditingName(true); }}
            className="flex items-center gap-2 text-left group"
            title="Click to rename this account"
          >
            <span className="text-base font-semibold text-[#1a1a1a] dark:text-[#f0f0f0]">{account.name}</span>
            <svg className="w-3.5 h-3.5 text-[#9b9b9b] group-hover:text-[#3b7dd8] transition-colors" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
            </svg>
          </button>
        )}
      </div>

      {/* Summary strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
        <div className="p-3 rounded-[10px] bg-[#f5f5f5] dark:bg-[#252525]">
          <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0] mb-0.5">Balance</p>
          <p className="font-semibold amount">{formatCurrency(account.display_balance ?? account.balance, currency)}</p>
        </div>
        <div className="p-3 rounded-[10px] bg-[#f5f5f5] dark:bg-[#252525]">
          <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0] mb-0.5">In this month</p>
          <p className="font-semibold amount text-[#22c55e]">{formatCurrency(inMonth, currency)}</p>
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

      {/* ── Statements (newest first) ── */}
      <div className="mb-6">
        <div className="flex items-center justify-between mb-2">
          <h4 className="text-sm font-semibold">Statements</h4>
          <label className={`inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-[8px] border border-[#e5e5e5] dark:border-[#2a2a2a] cursor-pointer hover:border-[#3b7dd8]/40 ${uploading ? 'opacity-60 pointer-events-none' : ''}`}>
            <span>{uploading ? 'Reading…' : '+ Upload statement'}</span>
            <input type="file" accept=".pdf,image/*" className="hidden" onChange={handleUpload} />
          </label>
        </div>
        {uploadMsg && (
          <div className="mb-2 px-3 py-2 rounded-[8px] text-xs bg-[#3b7dd8]/10 text-[#3b7dd8]">{uploadMsg}</div>
        )}
        {monthKeys.length === 0 ? (
          <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0] py-2">No statements yet — upload a PDF or add a transaction below.</p>
        ) : (
          <>
          <div className="space-y-1.5">
            {(showAllStmts ? monthKeys : monthKeys.slice(0, 3)).map(key => {
              const stmtTxns = sorted.filter(t => (t.date ?? '').slice(0, 7) === key);
              const moneyIn = stmtTxns
                .filter(t => t.amount > 0 && !internalTransferIds.has(t.id))
                .reduce((s, t) => s + Math.abs(t.display_amount ?? t.amount), 0);
              const moneyOut = stmtTxns
                .filter(t => t.amount < 0 && !internalTransferIds.has(t.id))
                .reduce((s, t) => s + Math.abs(t.display_amount ?? t.amount), 0);
              const net = moneyIn - moneyOut;
              const isOpen = expandedStmtKeys.has(key);
              return (
                <div key={key} className="rounded-[10px] border border-[#e5e5e5] dark:border-[#2a2a2a] overflow-hidden">
                  <button
                    onClick={() => toggleStmt(key)}
                    className="w-full flex items-center justify-between px-3 py-2.5 text-left hover:bg-[#f5f5f5] dark:hover:bg-[#1a1a1a]"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">{monthLabel(key)}</p>
                      <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">
                        {stmtTxns.length} transaction{stmtTxns.length !== 1 ? 's' : ''} · {formatCurrency(moneyOut, currency)} out
                      </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className={`badge ${net >= 0 ? 'bg-[#22c55e]/15 text-[#22c55e]' : 'bg-[#ef4444]/15 text-[#ef4444]'}`}>
                        {net >= 0 ? '+' : '-'}{formatCurrency(Math.abs(net), currency)}
                      </span>
                      <span className="text-[#6b6b6b] dark:text-[#a0a0a0] text-xs">{isOpen ? '▲' : '▼'}</span>
                    </div>
                  </button>
                  {isOpen && (
                    <div className="px-3 pb-3 pt-1 border-t border-[#e5e5e5] dark:border-[#2a2a2a] text-xs space-y-1.5">
                      <div className="grid grid-cols-3 gap-2">
                        <div>
                          <p className="text-[#6b6b6b] dark:text-[#a0a0a0]">Money in</p>
                          <p className="font-medium amount text-[#22c55e]">{formatCurrency(moneyIn, currency)}</p>
                        </div>
                        <div>
                          <p className="text-[#6b6b6b] dark:text-[#a0a0a0]">Money out</p>
                          <p className="font-medium amount text-[#ef4444]">{formatCurrency(moneyOut, currency)}</p>
                        </div>
                        <div>
                          <p className="text-[#6b6b6b] dark:text-[#a0a0a0]">Net</p>
                          <p className={`font-medium amount ${net >= 0 ? 'text-[#22c55e]' : 'text-[#ef4444]'}`}>{formatCurrency(net, currency)}</p>
                        </div>
                      </div>
                      <p className="text-[#6b6b6b] dark:text-[#a0a0a0] pt-1">
                        {stmtTxns.length} transaction{stmtTxns.length !== 1 ? 's' : ''} in this period — see list below
                      </p>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          {!showAllStmts && monthKeys.length > 3 && (
            <button onClick={() => setShowAllStmts(true)} className="text-xs text-[#3b7dd8] hover:underline mt-2">
              Show older statements
            </button>
          )}
          </>
        )}
      </div>

      {/* Transaction list */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2 min-w-0">
          <h4 className="text-sm font-semibold">Transactions</h4>
          {openKeys.length === 1 && (
            <span className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0] truncate">· {monthLabel(openKeys[0])}</span>
          )}
          {openKeys.length > 1 && (
            <span className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0] truncate">· {openKeys.length} statements</span>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {openKeys.length > 0 && (
            <Button variant="secondary" size="sm" onClick={() => setExpandedStmtKeys(new Set())}>All statements</Button>
          )}
          <Button variant="secondary" size="sm" onClick={() => setShowAddTx(v => !v)}>
            {showAddTx ? 'Cancel' : '+ Add transaction'}
          </Button>
        </div>
      </div>
      {showAddTx && (
        <div className="mb-3 p-3 rounded-[10px] border border-[#e5e5e5] dark:border-[#2a2a2a] space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <Input label="Date" type="date" value={txForm.date} onChange={e => setTxForm(f => ({ ...f, date: e.target.value }))} />
            <Input label="Amount" type="number" step="0.01" prefix="$" value={txForm.amount} onChange={e => setTxForm(f => ({ ...f, amount: e.target.value }))} />
          </div>
          <Select
            label="Direction"
            value={txForm.direction}
            onChange={e => setTxForm(f => ({ ...f, direction: e.target.value as 'in' | 'out' }))}
            options={[{ value: 'out', label: 'Money out (spent)' }, { value: 'in', label: 'Money in (received)' }]}
          />
          <Input label="Merchant" value={txForm.merchant} onChange={e => setTxForm(f => ({ ...f, merchant: e.target.value }))} placeholder="e.g. Woolworths" />
          <Input label="Category (optional)" value={txForm.category} onChange={e => setTxForm(f => ({ ...f, category: e.target.value }))} placeholder="auto-detected if blank" />
          <Button
            variant="primary" size="sm" fullWidth
            onClick={() => {
              const amt = parseFloat(txForm.amount);
              if (!txForm.merchant.trim() || Number.isNaN(amt)) return;
              onAddTransaction({ date: txForm.date, merchant: txForm.merchant.trim(), amount: amt, category: txForm.category.trim(), direction: txForm.direction });
              setTxForm({ date: new Date().toISOString().split('T')[0], merchant: '', amount: '', category: '', direction: 'out' });
              setShowAddTx(false);
            }}
          >
            Add transaction
          </Button>
        </div>
      )}
      <div className="mb-3">
        <input
          className="input w-full"
          placeholder="Search transactions…"
          value={search}
          onChange={e => setSearch(e.target.value)}
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
            <TransactionRow key={tx.id} tx={tx} onDelete={onDeleteTx} onCategoryChange={onCategoryChange} isTransfer={internalTransferIds.has(tx.id)} />
          ))}
        </div>
      )}
    </Modal>
  );
}

// ─── Card Detail Modal ────────────────────────────────────────────────────────

function CardDetailModal({ card, transactions, statements, internalTransferIds, onClose, onDeleteTx, onCategoryChange, onPayStatement, onAddStatement, onAddTransaction, onLoadOlder, onEnsureStatement }: {
  card: CreditCard;
  transactions: import('../types').Transaction[];
  statements: CreditCardStatement[];
  internalTransferIds: Set<string>;
  onClose: () => void;
  onDeleteTx: (id: string) => void;
  onCategoryChange: (id: string, category: string) => void;
  onPayStatement: (st: CreditCardStatement) => void;
  onAddStatement: () => void;
  onAddTransaction: (d: { date: string; merchant: string; amount: number; category: string }) => void;
  onLoadOlder: (before: string) => void;
  onEnsureStatement: () => void;
}) {
  const [search, setSearch] = useState('');
  const [expandedStmtIds, setExpandedStmtIds] = useState<Set<string>>(new Set());
  const toggleStmt = (id: string) =>
    setExpandedStmtIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  const [showAllStmts, setShowAllStmts] = useState(false);
  const [showAddTx, setShowAddTx] = useState(false);
  const [txForm, setTxForm] = useState({ date: new Date().toISOString().split('T')[0], merchant: '', amount: '', category: '' });
  const currency = card.display_currency ?? card.currency;

  // Existing cards may have a balance but no statement record yet. Backfill a
  // "Current statement" once on open so there's always something to see/tick.
  useEffect(() => {
    if (statements.length === 0 && card.balance_owing > 0) onEnsureStatement();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card.id, statements.length]);

  const sorted = [...transactions].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  // When statements are expanded, only show transactions inside their billing
  // windows (the union, so several can be open at once).
  const openStatements = statements.filter(s => expandedStmtIds.has(s.id));
  const openWindows = openStatements.map(st => {
    const i = statements.findIndex(s => s.id === st.id);
    const upper = st.period_end ?? '';
    const lower = (statements[i + 1]?.period_end) ?? st.period_start ?? '';
    return { upper, lower };
  });

  const inWindow = openWindows.length
    ? sorted.filter(t => openWindows.some(w =>
        (!w.upper || t.date <= w.upper) && (!w.lower || t.date > w.lower)))
    : sorted;
  const filtered = search
    ? inWindow.filter(t => t.merchant.toLowerCase().includes(search.toLowerCase()))
    : inWindow;

  const now = new Date();
  const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const thisYearStart  = new Date(now.getFullYear(), 0, 1);

  const spentMonth = sorted
    .filter(t => new Date(t.date) >= thisMonthStart && t.amount < 0 && !internalTransferIds.has(t.id))
    .reduce((s, t) => s + Math.abs(t.display_amount ?? t.amount), 0);
  const spentYear = sorted
    .filter(t => new Date(t.date) >= thisYearStart && t.amount < 0 && !internalTransferIds.has(t.id))
    .reduce((s, t) => s + Math.abs(t.display_amount ?? t.amount), 0);

  const utilisation = card.credit_limit > 0 ? (card.balance_owing / card.credit_limit) * 100 : 0;
  const isPaidInFull = card.balance_owing <= 0;

  return (
    <Modal isOpen onClose={onClose} size="xl" title={card.name}>
      {/* Summary strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
        <div className="p-3 rounded-[10px] bg-[#f5f5f5] dark:bg-[#252525]">
          <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0] mb-0.5">Balance owing</p>
          <p className={`font-semibold amount ${isPaidInFull ? 'text-[#22c55e]' : 'text-[#ef4444]'}`}>
            {formatCurrency(card.display_balance_owing ?? card.balance_owing, currency)}
          </p>
        </div>
        <div className="p-3 rounded-[10px] bg-[#f5f5f5] dark:bg-[#252525]">
          <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0] mb-0.5">Credit limit</p>
          <p className="font-semibold amount">{formatCurrency(card.display_credit_limit ?? card.credit_limit, currency)}</p>
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

      {/* Utilisation bar */}
      <div className="mb-4">
        <div className="flex justify-between text-xs mb-1">
          <span className="text-[#6b6b6b] dark:text-[#a0a0a0]">Utilisation <span className="opacity-70">· this statement</span></span>
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
          <span className="badge bg-[#f5f5f5] dark:bg-[#2a2a2a]">Min. {formatCurrency(card.display_minimum_payment ?? card.minimum_payment, currency)}</span>
        )}
        {card.due_date && (
          <span className={`badge ${daysUntil(card.due_date) <= 7 ? 'bg-[#ef4444]/10 text-[#ef4444]' : 'bg-[#f5f5f5] dark:bg-[#2a2a2a]'}`}>
            Due {formatDate(card.due_date)}
          </span>
        )}
        {card.last_payment_amount != null && card.last_payment_date && (
          <span className="badge bg-[#22c55e]/10 text-[#22c55e]">
            Last paid {formatCurrency(card.display_last_payment_amount ?? card.last_payment_amount, currency)} · {formatDate(card.last_payment_date)}
          </span>
        )}
        {isPaidInFull && <span className="badge bg-[#22c55e]/10 text-[#22c55e]">Paid in full</span>}
      </div>

      {/* ── Statements (newest first) ── */}
      <div className="mb-6">
        <div className="flex items-center justify-between mb-2">
          <h4 className="text-sm font-semibold">Statements</h4>
          <Button variant="secondary" size="sm" onClick={onAddStatement}>+ Add statement</Button>
        </div>
        {statements.length === 0 ? (
          <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0] py-2">No statements yet — upload a PDF to add one.</p>
        ) : (
          <>
          <div className="space-y-1.5">
            {(showAllStmts ? statements : statements.slice(0, 3)).map((st, i, arr) => {
              // Transactions in this statement's window: after the previous (older)
              // statement's closing date, up to and including this one's.
              const upper = st.period_end ?? '';
              const lower = (arr[i + 1]?.period_end) ?? st.period_start ?? '';
              const stmtTxns = sorted.filter(t =>
                t.amount < 0 && !internalTransferIds.has(t.id) &&
                (!upper || t.date <= upper) && (!lower || t.date > lower)
              );
              const spent = stmtTxns.reduce((s, t) => s + Math.abs(t.display_amount ?? t.amount), 0);
              const remaining = Math.max(0, (st.closing_balance ?? 0) - (st.amount_paid ?? 0));
              const badge = st.status === 'paid'
                ? { txt: 'Paid', cls: 'bg-[#22c55e]/15 text-[#22c55e]' }
                : st.status === 'partial'
                ? { txt: 'Partial', cls: 'bg-[#f59e0b]/15 text-[#f59e0b]' }
                : { txt: 'Unpaid', cls: 'bg-[#ef4444]/15 text-[#ef4444]' };
              const isOpen = expandedStmtIds.has(st.id);
              return (
                <div key={st.id} className="rounded-[10px] border border-[#e5e5e5] dark:border-[#2a2a2a] overflow-hidden">
                  <button
                    onClick={() => toggleStmt(st.id)}
                    className="w-full flex items-center justify-between px-3 py-2.5 text-left hover:bg-[#f5f5f5] dark:hover:bg-[#1a1a1a]"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">
                        {formatStatementPeriod(st)}
                      </p>
                      <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">
                        {formatCurrency(st.display_closing_balance ?? st.closing_balance, currency)} total
                        {st.status === 'paid' && st.paid_at
                          ? ` · paid ${formatDate(st.paid_at)}`
                          : st.status === 'partial'
                          ? ` · ${formatCurrency(remaining, currency)} left`
                          : ''}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className={`badge ${badge.cls}`}>{badge.txt}</span>
                      <span className="text-[#6b6b6b] dark:text-[#a0a0a0] text-xs">{isOpen ? '▲' : '▼'}</span>
                    </div>
                  </button>
                  {isOpen && (
                    <div className="px-3 pb-3 pt-1 border-t border-[#e5e5e5] dark:border-[#2a2a2a] text-xs space-y-1.5">
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <p className="text-[#6b6b6b] dark:text-[#a0a0a0]">Statement total</p>
                          <p className="font-medium amount">{formatCurrency(st.display_closing_balance ?? st.closing_balance, currency)}</p>
                        </div>
                        <div>
                          <p className="text-[#6b6b6b] dark:text-[#a0a0a0]">Spent this period</p>
                          <p className="font-medium amount text-[#ef4444]">{formatCurrency(spent, currency)}</p>
                        </div>
                        <div>
                          <p className="text-[#6b6b6b] dark:text-[#a0a0a0]">Amount paid</p>
                          <p className="font-medium amount text-[#22c55e]">{formatCurrency(st.display_amount_paid ?? st.amount_paid ?? 0, currency)}</p>
                        </div>
                        {st.minimum_payment != null && (
                          <div>
                            <p className="text-[#6b6b6b] dark:text-[#a0a0a0]">Minimum payment</p>
                            <p className="font-medium amount">{formatCurrency(st.minimum_payment, currency)}</p>
                          </div>
                        )}
                        <div>
                          <p className="text-[#6b6b6b] dark:text-[#a0a0a0]">{st.status === 'paid' ? 'Paid on' : st.due_date ? 'Due' : 'Status'}</p>
                          <p className="font-medium">
                            {st.status === 'paid' && st.paid_at ? formatDate(st.paid_at)
                              : st.due_date ? formatDate(st.due_date)
                              : badge.txt}
                          </p>
                        </div>
                      </div>
                      {st.status !== 'paid' && (
                        <div className="pt-1.5">
                          <Button variant="primary" size="sm" onClick={() => onPayStatement(st)}>
                            ✓ Mark paid
                          </Button>
                        </div>
                      )}
                      {stmtTxns.length > 0 && (
                        <p className="text-[#6b6b6b] dark:text-[#a0a0a0] pt-1">
                          {stmtTxns.length} transaction{stmtTxns.length !== 1 ? 's' : ''} in this period — see list below
                        </p>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          {!showAllStmts && statements.length > 3 && (
            <button
              onClick={() => {
                const oldest = statements[statements.length - 1];
                if (oldest?.period_end) onLoadOlder(oldest.period_end);
                setShowAllStmts(true);
              }}
              className="text-xs text-[#3b7dd8] hover:underline mt-2"
            >
              Show older statements
            </button>
          )}
          </>
        )}
      </div>

      {/* Transaction list */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2 min-w-0">
          <h4 className="text-sm font-semibold">Transactions</h4>
          {openStatements.length === 1 && (
            <span className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0] truncate">
              · {formatStatementPeriod(openStatements[0])}
            </span>
          )}
          {openStatements.length > 1 && (
            <span className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0] truncate">
              · {openStatements.length} statements
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {openStatements.length > 0 && (
            <Button variant="secondary" size="sm" onClick={() => setExpandedStmtIds(new Set())}>
              All statements
            </Button>
          )}
          <Button variant="secondary" size="sm" onClick={() => setShowAddTx(v => !v)}>
            {showAddTx ? 'Cancel' : '+ Add transaction'}
          </Button>
        </div>
      </div>
      {showAddTx && (
        <div className="mb-3 p-3 rounded-[10px] border border-[#e5e5e5] dark:border-[#2a2a2a] space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <Input label="Date" type="date" value={txForm.date} onChange={e => setTxForm(f => ({ ...f, date: e.target.value }))} />
            <Input label="Amount" type="number" step="0.01" prefix="$" value={txForm.amount} onChange={e => setTxForm(f => ({ ...f, amount: e.target.value }))} />
          </div>
          <Input label="Merchant" value={txForm.merchant} onChange={e => setTxForm(f => ({ ...f, merchant: e.target.value }))} placeholder="e.g. Woolworths" />
          <Input label="Category (optional)" value={txForm.category} onChange={e => setTxForm(f => ({ ...f, category: e.target.value }))} placeholder="auto-detected if blank" />
          <Button
            variant="primary" size="sm" fullWidth
            onClick={() => {
              const amt = parseFloat(txForm.amount);
              if (!txForm.merchant.trim() || Number.isNaN(amt)) return;
              onAddTransaction({ date: txForm.date, merchant: txForm.merchant.trim(), amount: amt, category: txForm.category.trim() });
              setTxForm({ date: new Date().toISOString().split('T')[0], merchant: '', amount: '', category: '' });
              setShowAddTx(false);
            }}
          >
            Add transaction
          </Button>
        </div>
      )}
      <div className="mb-3">
        <input
          className="input w-full"
          placeholder="Search transactions…"
          value={search}
          onChange={e => setSearch(e.target.value)}
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
            <TransactionRow key={tx.id} tx={tx} onDelete={onDeleteTx} onCategoryChange={onCategoryChange} isTransfer={internalTransferIds.has(tx.id)} />
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
  onSave: (formData: { name: string; institution: string; bsb?: string; account_number?: string }, doAdd: (existing?: import('../types').BankAccount) => void) => void;
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
      const institution = String(acc.institution ?? '');
      const accountType = String(acc.account_type ?? '');
      const accountNumber = String(acc.account_number ?? '');
      const cleanName = sanitizeAccountName(
        acc.name != null ? String(acc.name) : '',
        institution,
        accountType,
        accountNumber,
      );
      setForm(f => ({
        ...f,
        name:           cleanName || String(acc.name ?? f.name),
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
    const doAdd = (existing?: import('../types').BankAccount) => {
      // When the account already exists, import the parsed transactions INTO it
      // instead of creating a second account instance. Creating duplicate accounts
      // is what historically spawned orphan transactions (transactions tied to an
      // account instance that later gets deleted/deduped).
      const acc = existing ?? accountsDS.add({
        name: capturedForm.name, institution: capturedForm.institution, account_type: capturedForm.account_type,
        balance: parseFloat(capturedForm.balance) || 0, currency: capturedForm.currency,
        bsb: capturedForm.bsb || undefined, account_number: capturedForm.account_number || undefined,
        is_manual: true,
      });
      if (capturedTxns.length) {
        const existing = transactionsDS.getAll();
        for (const tx of capturedTxns) {
          const normalizedAmt = tx.type === 'credit' ? Math.abs(tx.amount) : -Math.abs(tx.amount);
          // Dedup on date + signed amount + account_type, NOT merchant: re-parsing
          // the same statement often yields slightly different merchant strings
          // (e.g. "ANTHROPIC SAN FRANCISCO" vs "ANTHROPIC SAN FRANCISCO CA USA …"),
          // which an exact-merchant check misses, letting re-uploads pile up dupes.
          // Signed amount keeps a +420/-420 transfer pair correctly distinct.
          const isDup = existing.some(ex =>
            ex.account_type === 'bank' && ex.date === tx.date && Math.abs(ex.amount - normalizedAmt) < 0.01
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

function AddCreditCardModal({ isOpen, onClose, onSave }: { isOpen: boolean; onClose: () => void; onSave: (formData: { name: string; institution: string }, doAdd: (existing?: CreditCard) => void) => void }) {
  const [form, setForm] = useState({ name: '', institution: '', balance_owing: '', credit_limit: '', minimum_payment: '', due_date: '', currency: 'AUD' });
  const [uploading, setUploading] = useState(false);
  const [uploadMsg, setUploadMsg] = useState('');
  const [parsedTransactions, setParsedTransactions] = useState<ParsedCardTx[]>([]);
  const [parsedStatement, setParsedStatement] = useState<{ closing_balance?: number; minimum_payment?: number; due_date?: string; statement_period?: string } | null>(null);
  const [addReminder, setAddReminder] = useState(true);
  const [step, setStep] = useState<'card' | 'statement'>('card');
  const [stmtForm, setStmtForm] = useState({ closing_balance: '', minimum_payment: '', period_label: '', due_date: '' });

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
      // Capture the statement itself so we can offer to add it as a statement record.
      const closing = p.closing_balance != null ? Number(p.closing_balance) : undefined;
      if (closing != null && !Number.isNaN(closing)) {
        const minPay = p.minimum_payment != null ? Number(p.minimum_payment) : undefined;
        setParsedStatement({ closing_balance: closing, minimum_payment: minPay != null && !Number.isNaN(minPay) ? minPay : undefined, due_date: p.due_date ? String(p.due_date) : undefined, statement_period: p.statement_period ? String(p.statement_period) : undefined });
      } else {
        setParsedStatement(null);
      }
      const txMsg = txns.length ? ` · ${txns.length} transaction${txns.length !== 1 ? 's' : ''} detected` : '';
      setUploadMsg(`Document parsed${txMsg} — please review the details below.`);
    }
    e.target.value = '';
  };

  // Step 1 → if a statement was parsed, move to the confirm-statement step;
  // otherwise create the card straight away.
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (parsedStatement?.closing_balance != null) {
      setStmtForm({
        closing_balance: String(parsedStatement.closing_balance),
        minimum_payment: parsedStatement.minimum_payment != null ? String(parsedStatement.minimum_payment) : '',
        period_label: parsedStatement.statement_period ?? '',
        due_date: parsedStatement.due_date ?? form.due_date ?? '',
      });
      setStep('statement');
      return;
    }
    commit(null);
  };

  const commit = (statement: { closing_balance: number; minimum_payment?: number; period_label: string; due_date: string } | null) => {
    const formSnapshot = { name: form.name, institution: form.institution };
    const capturedForm = { ...form };
    const capturedTxns = [...parsedTransactions];
    const capturedReminder = addReminder;
    const capturedStatement = statement;
    const doAdd = (existing?: CreditCard) => {
      // Reuse the existing card when it already exists — import transactions into
      // it rather than creating a duplicate card instance (the source of orphans).
      const card = existing ?? creditCardsDS.add({
        name: capturedForm.name, institution: capturedForm.institution,
        balance_owing:   parseFloat(capturedForm.balance_owing) || 0,
        credit_limit:    parseFloat(capturedForm.credit_limit) || 0,
        minimum_payment: capturedForm.minimum_payment ? parseFloat(capturedForm.minimum_payment) : undefined,
        due_date:        capturedForm.due_date || undefined,
        currency: capturedForm.currency,
        is_manual: true,
      });
      // Optional payment reminder bill (only when a due date is set and the toggle is
      // on) — skip for an existing card to avoid creating a duplicate reminder bill.
      if (!existing && capturedReminder && card.due_date) {
        billsDS.add({
          name: cardReminderBillName(card.name),
          amount: cardReminderAmount(card),
          due_date: card.due_date,
          is_recurring: true,
          frequency: 'monthly',
          colour: 'red',
          is_paid: false,
          calendar_synced: false,
        });
      }
      if (capturedTxns.length) {
        const existing = transactionsDS.getAll();
        for (const tx of capturedTxns) {
          const normalizedAmt = -Math.abs(tx.amount);
          // Dedup on date + amount + account_type, NOT merchant (see bank-account
          // import above): re-parsing a statement yields varying merchant strings,
          // so an exact-merchant check lets the same charge re-import as a dupe.
          const isDup = existing.some(ex =>
            ex.account_type === 'credit_card' && ex.date === tx.date && Math.abs(ex.amount - normalizedAmt) < 0.01
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
      // Create the statement record from the uploaded PDF (if the user opted in),
      // dated to its real billing period so an older upload isn't treated as current.
      // balance_owing is then derived from the card's unpaid statements.
      if (capturedStatement) {
        const { start, end } = parseStatementPeriod(capturedStatement.period_label || undefined);
        const periodEnd = end ?? capturedStatement.due_date ?? new Date().toISOString().split('T')[0];
        creditCardStatementsDS.add({
          credit_card_id: card.id,
          closing_balance: capturedStatement.closing_balance,
          minimum_payment: capturedStatement.minimum_payment ?? null,
          period_label: capturedStatement.period_label || null,
          period_start: start ?? null,
          period_end: periodEnd,
          due_date: capturedStatement.due_date || null,
          source: 'statement',
          currency: card.currency,
        });
      }
    };
    setForm({ name: '', institution: '', balance_owing: '', credit_limit: '', minimum_payment: '', due_date: '', currency: 'AUD' });
    setUploadMsg('');
    setParsedTransactions([]);
    setParsedStatement(null);
    setStep('card');
    setAddReminder(true);
    onSave(formSnapshot, doAdd);
  };

  // ── Step 2: confirm the statement parsed from the PDF ──────────────────────
  if (step === 'statement') {
    return (
      <Modal isOpen={isOpen} onClose={onClose} title="Confirm statement">
        <p className="text-sm text-[#6b6b6b] dark:text-[#a0a0a0] mb-4">
          We found a statement on the document used to create <span className="font-medium text-[#0f0f0f] dark:text-[#f5f5f5]">{form.name || 'this card'}</span>. Confirm its details to add it as the card's statement.
        </p>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <Input label="Statement total" type="number" step="0.01" prefix="$" value={stmtForm.closing_balance} onChange={e => setStmtForm(f => ({ ...f, closing_balance: e.target.value }))} required />
            <Input label="Minimum payment" type="number" step="0.01" prefix="$" value={stmtForm.minimum_payment} onChange={e => setStmtForm(f => ({ ...f, minimum_payment: e.target.value }))} />
          </div>
          <Input label="Statement period" value={stmtForm.period_label} onChange={e => setStmtForm(f => ({ ...f, period_label: e.target.value }))} placeholder="e.g. 1 Mar 2026 - 31 Mar 2026" />
          <Input label="Due date" type="date" value={stmtForm.due_date} onChange={e => setStmtForm(f => ({ ...f, due_date: e.target.value }))} />
          <div className="flex gap-3 pt-2">
            <Button variant="secondary" type="button" onClick={() => commit(null)}>Skip statement</Button>
            <Button
              variant="primary" type="button" fullWidth
              onClick={() => {
                const cb = parseFloat(stmtForm.closing_balance);
                const mp = parseFloat(stmtForm.minimum_payment);
                commit(Number.isNaN(cb) ? null : { closing_balance: cb, minimum_payment: Number.isNaN(mp) ? undefined : mp, period_label: stmtForm.period_label, due_date: stmtForm.due_date });
              }}
            >
              Add statement
            </Button>
          </div>
        </div>
      </Modal>
    );
  }

  // ── Step 1: card details ───────────────────────────────────────────────────
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
        <Input label="Credit limit" type="number" step="0.01" prefix="$" value={form.credit_limit} onChange={e => setForm(f => ({ ...f, credit_limit: e.target.value }))} required />
        <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">Balance owing, minimum payment and due date come from the card's statements — you'll confirm those next when a statement is detected.</p>
        {form.due_date && (
          <label className="flex items-center justify-between gap-3 p-3 rounded-[8px] border border-[#e5e5e5] dark:border-[#2a2a2a] cursor-pointer">
            <span className="text-sm text-[#0f0f0f] dark:text-[#f5f5f5]">Add payment reminder to Bills &amp; Reminders</span>
            <button
              type="button"
              role="switch"
              aria-checked={addReminder}
              onClick={() => setAddReminder(v => !v)}
              className={`relative inline-flex items-center w-10 h-5 rounded-full transition-colors duration-200 flex-shrink-0 ${addReminder ? 'bg-[#3b7dd8]' : 'bg-[#e5e5e5] dark:bg-[#2a2a2a]'}`}
            >
              <span className={`w-4 h-4 bg-white rounded-full shadow-sm transition-transform duration-200 ${addReminder ? 'translate-x-5' : 'translate-x-0.5'}`} />
            </button>
          </label>
        )}
        <div className="flex gap-3 pt-2">
          <Button variant="secondary" type="button" onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" fullWidth>{parsedStatement?.closing_balance != null ? 'Next: confirm statement' : 'Add Card'}</Button>
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

// ─── Subscription Detail Modal ───────────────────────────────────────────────

const SUB_FREQ_OPTIONS = [
  { value: 'weekly', label: 'Weekly' },
  { value: 'fortnightly', label: 'Fortnightly' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'quarterly', label: 'Quarterly' },
  { value: 'annually', label: 'Annually' },
  { value: 'irregular', label: 'Irregular' },
];

function SubscriptionDetailModal({ sub, transactions, bills, onClose, onChanged, onDeleted }: {
  sub: Subscription;
  transactions: Transaction[];
  bills: Bill[];
  onClose: () => void;
  onChanged: () => void;
  onDeleted: () => void;
}) {
  // The bill linked to this subscription, found by STABLE id — not name — so
  // renames / re-adds / duplicate names never break the link. Falls back to an
  // exact name match only for legacy bills created before subscription_id existed.
  const nameLower = sub.name.toLowerCase().trim();
  const linkedBill =
    bills.find(b => b.subscription_id === sub.id) ??
    bills.find(b => !b.subscription_id && b.name.toLowerCase().trim() === nameLower);

  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [form, setForm] = useState({
    name: sub.name,
    amount: String(sub.amount),
    frequency: sub.frequency,
    next_charge_date: sub.next_charge_date ?? '',
    category: sub.category ?? '',
    also_in_bills: !!linkedBill,
    auto_pay: linkedBill?.auto_pay ?? false,
  });

  // Matching transaction history — normalised merchant equals the subscription's
  // original (raw) name, falling back to the display name when no original exists.
  const matchKey = normaliseMerchant(sub.original_name || sub.name);
  const history = transactions
    .filter(t => normaliseMerchant(t.merchant) === matchKey)
    .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));

  const startEditing = () => {
    setForm({
      name: sub.name,
      amount: String(sub.amount),
      frequency: sub.frequency,
      next_charge_date: sub.next_charge_date ?? '',
      category: sub.category ?? '',
      also_in_bills: !!linkedBill,
      auto_pay: linkedBill?.auto_pay ?? false,
    });
    setEditing(true);
  };

  const saveEdits = () => {
    const newName = form.name.trim() || sub.name;
    const newAmount = parseFloat(form.amount) || 0;
    subscriptionsDS.update(sub.id, {
      name: newName,
      amount: newAmount,
      frequency: form.frequency,
      next_charge_date: form.next_charge_date,
      category: form.category.trim(),
    });
    // Sync the linked bill to match the "Also in Bills & Reminders" toggle.
    // The link is by stable subscription_id — never by name — so this is simply:
    // toggle on  → ensure exactly one bill exists for this subscription
    // toggle off → ensure none exists.
    const existing =
      billsDS.findBySubscription(sub.id) ??
      // Adopt a legacy name-linked bill (created before subscription_id existed)
      // so we update it in place instead of creating a duplicate.
      bills.find(b => !b.is_paid && !b.subscription_id && b.name.toLowerCase().trim() === sub.name.toLowerCase().trim());

    if (form.also_in_bills) {
      const billData = {
        name: newName,
        amount: newAmount,
        due_date: form.next_charge_date,
        is_recurring: true,
        frequency: form.frequency,
        colour: 'grey' as const,
        is_paid: false,
        auto_pay: form.auto_pay,
        subscription_id: sub.id,
        calendar_synced: false,
      };
      if (existing) {
        billsDS.update(existing.id, billData);
      } else {
        billsDS.addLinked(billData);
      }
    } else if (existing) {
      // Toggle turned off — remove whatever bill is linked to this subscription.
      billsDS.removeBySubscription(sub.id);
      if (!existing.subscription_id) billsDS.remove(existing.id); // legacy name-linked
    }
    onChanged();
    setEditing(false);
  };

  return (
    <Modal isOpen onClose={onClose} title="Subscription details" size="md">
      {/* ── Name (editable with pencil) ── */}
      <div className="mb-4">
        {editing ? (
          <Input
            label="Subscription name"
            value={form.name}
            onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
          />
        ) : (
          <button
            type="button"
            onClick={startEditing}
            className="flex items-center gap-2 text-left group"
            title="Click to edit"
          >
            <span className="text-lg font-semibold text-[#1a1a1a] dark:text-[#f0f0f0]">{sub.name}</span>
            <svg className="w-3.5 h-3.5 text-[#9b9b9b] group-hover:text-[#3b7dd8] transition-colors" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
            </svg>
          </button>
        )}
        {!editing && sub.original_name && sub.original_name !== sub.name && (
          <p className="text-xs text-[#9b9b9b] dark:text-[#666] mt-0.5">{sub.original_name}</p>
        )}
      </div>

      {/* ── Detail / edit fields ── */}
      {editing ? (
        <div className="space-y-3 mb-4">
          {sub.original_name && sub.original_name !== sub.name && (
            <div>
              <label className="block text-xs font-medium text-[#6b6b6b] dark:text-[#a0a0a0] mb-1">Original name</label>
              <p className="text-xs text-[#9b9b9b] dark:text-[#666] px-3 py-2 rounded-[8px] bg-[#f5f5f5] dark:bg-[#1e1e1e] border border-[#e5e5e5] dark:border-[#2a2a2a]">{sub.original_name}</p>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <Input label="Amount" type="number" step="0.01" prefix="$" value={form.amount} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} />
            <Select label="Frequency" value={form.frequency} onChange={e => setForm(f => ({ ...f, frequency: e.target.value }))} options={SUB_FREQ_OPTIONS} />
          </div>
          <Input label="Next due date" type="date" value={form.next_charge_date} onChange={e => setForm(f => ({ ...f, next_charge_date: e.target.value }))} />
          <Input label="Category" value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))} placeholder="e.g. Entertainment" />

          {/* Also in Bills & Reminders toggle */}
          <div
            className="flex items-center gap-2 cursor-pointer select-none"
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); setForm(f => ({ ...f, also_in_bills: !f.also_in_bills })); }}
          >
            <div className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${form.also_in_bills ? 'bg-[#3b7dd8]' : 'bg-[#d1d5db] dark:bg-[#4b5563]'}`}>
              <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform ${form.also_in_bills ? 'translate-x-4' : 'translate-x-0.5'}`} />
            </div>
            <span className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">Also in bills &amp; reminders</span>
          </div>

          {/* Payment method: Auto vs Manual (only relevant when in bills) */}
          {form.also_in_bills && (
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">Payment method</span>
              <div className="inline-flex rounded-[8px] border border-[#e5e5e5] dark:border-[#2a2a2a] overflow-hidden">
                <button
                  type="button"
                  onClick={() => setForm(f => ({ ...f, auto_pay: true }))}
                  className={`flex items-center gap-1 px-3 py-1.5 text-xs font-medium transition-colors ${form.auto_pay ? 'bg-[#22c55e] text-white' : 'text-[#6b6b6b] dark:text-[#a0a0a0] hover:bg-[#f5f5f5] dark:hover:bg-[#1a1a1a]'}`}
                >
                  ⚡ Auto
                </button>
                <button
                  type="button"
                  onClick={() => setForm(f => ({ ...f, auto_pay: false }))}
                  className={`px-3 py-1.5 text-xs font-medium transition-colors ${!form.auto_pay ? 'bg-[#3b7dd8] text-white' : 'text-[#6b6b6b] dark:text-[#a0a0a0] hover:bg-[#f5f5f5] dark:hover:bg-[#1a1a1a]'}`}
                >
                  Manual
                </button>
              </div>
            </div>
          )}

          <div className="flex gap-2 pt-1">
            <Button variant="secondary" size="sm" type="button" onClick={() => setEditing(false)}>Cancel</Button>
            <Button variant="primary" size="sm" type="button" fullWidth onClick={saveEdits}>Save changes</Button>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-3 mb-4">
          <div className="rounded-[8px] border border-[#e5e5e5] dark:border-[#2a2a2a] p-3">
            <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">Amount</p>
            <p className="text-sm font-semibold mt-0.5">{formatCurrency(sub.display_amount ?? sub.amount, sub.display_currency ?? sub.currency)}</p>
          </div>
          <div className="rounded-[8px] border border-[#e5e5e5] dark:border-[#2a2a2a] p-3">
            <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">Frequency</p>
            <p className="text-sm font-semibold mt-0.5 capitalize">{sub.frequency}</p>
          </div>
          <div className="rounded-[8px] border border-[#e5e5e5] dark:border-[#2a2a2a] p-3">
            <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">Next due</p>
            <p className="text-sm font-semibold mt-0.5">{sub.next_charge_date ? formatDate(sub.next_charge_date) : '—'}</p>
          </div>
        </div>
      )}

      {/* ── Auto / Manual payment badge ── */}
      {!editing && (
        <div className="mb-4">
          {linkedBill ? (
            linkedBill.auto_pay ? (
              <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium bg-[#dcfce7] text-[#16a34a] dark:bg-[#14532d] dark:text-[#86efac]">⚡ Auto pay</span>
            ) : (
              <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium bg-[#dbeafe] text-[#2563eb] dark:bg-[#1e3a5f] dark:text-[#93c5fd]">Manual pay</span>
            )
          ) : (
            <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium bg-[#f5f5f5] text-[#6b6b6b] dark:bg-[#2a2a2a] dark:text-[#a0a0a0]">Not in bills</span>
          )}
          <span className="ml-2 text-xs text-[#9b9b9b] dark:text-[#666]">{sub.category}</span>
        </div>
      )}

      {/* ── Transaction history ── */}
      <div className="mb-4">
        <p className="text-xs font-medium text-[#6b6b6b] dark:text-[#a0a0a0] mb-2">
          Transaction history ({history.length})
        </p>
        {history.length === 0 ? (
          <p className="text-xs text-[#9b9b9b] dark:text-[#666] py-3 text-center border border-[#e5e5e5] dark:border-[#2a2a2a] rounded-[8px]">
            No matching transactions found.
          </p>
        ) : (
          <div className="rounded-[8px] border border-[#e5e5e5] dark:border-[#2a2a2a] overflow-hidden max-h-56 overflow-y-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-[#f5f5f5] dark:bg-[#1e1e1e]">
                  <th className="text-left px-3 py-2 font-medium text-[#6b6b6b] dark:text-[#a0a0a0]">Date</th>
                  <th className="text-left px-3 py-2 font-medium text-[#6b6b6b] dark:text-[#a0a0a0]">Merchant</th>
                  <th className="text-right px-3 py-2 font-medium text-[#6b6b6b] dark:text-[#a0a0a0]">Amount</th>
                </tr>
              </thead>
              <tbody>
                {history.map((tx, i) => (
                  <tr key={tx.id} className={i % 2 === 0 ? '' : 'bg-[#fafafa] dark:bg-[#1a1a1a]'}>
                    <td className="px-3 py-2 whitespace-nowrap text-[#1a1a1a] dark:text-[#f0f0f0]">{formatDate(tx.date)}</td>
                    <td className="px-3 py-2 truncate max-w-[160px] text-[#1a1a1a] dark:text-[#f0f0f0]">{tx.merchant}</td>
                    <td className="px-3 py-2 text-right whitespace-nowrap text-[#d94c4c] dark:text-[#f87171]">{formatCurrency(Math.abs(tx.display_amount ?? tx.amount), tx.display_currency ?? tx.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Actions ── */}
      <div className="flex gap-2 pt-1">
        {confirmDelete ? (
          <>
            <span className="flex-1 text-xs text-[#6b6b6b] dark:text-[#a0a0a0] self-center">Delete this subscription?</span>
            <Button variant="secondary" size="sm" type="button" onClick={() => setConfirmDelete(false)}>Cancel</Button>
            <Button variant="danger" size="sm" type="button" onClick={onDeleted}>Confirm delete</Button>
          </>
        ) : (
          <>
            {!editing && <Button variant="secondary" size="sm" type="button" onClick={startEditing}>Edit</Button>}
            <Button variant="danger" size="sm" type="button" onClick={() => setConfirmDelete(true)}>Delete</Button>
            <Button variant="primary" size="sm" type="button" fullWidth onClick={onClose}>Close</Button>
          </>
        )}
      </div>
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

/** Turn a statement-period label ("1 Mar 2026 - 31 Mar 2026", "01/03/2026 to
 *  31/03/2026", or a single date) into ISO start/end dates. */
/** Render a statement's period consistently regardless of which parser
 *  produced period_label (formats vary, e.g. "1 Mar 2026 - 31 Mar 2026" vs
 *  "2026-04-11 - 2026-05-10"). Prefer the parsed period_start/period_end. */
function formatStatementPeriod(st: { period_label?: string | null; period_start?: string | null; period_end?: string | null }): string {
  if (st.period_start && st.period_end) return `${formatDate(st.period_start)} - ${formatDate(st.period_end)}`;
  if (st.period_label) return st.period_label;
  if (st.period_end) return formatDate(st.period_end);
  return 'Statement';
}

function parseStatementPeriod(label?: string | null): { start?: string; end?: string } {
  if (!label) return {};

  // Already-ISO range, e.g. "2026-04-11 - 2026-05-10" or "2026-04-11 to 2026-05-10".
  const isoRange = label.match(/(\d{4}-\d{2}-\d{2}).*?(\d{4}-\d{2}-\d{2})/);
  if (isoRange) return { start: isoRange[1], end: isoRange[2] };

  // Single ISO date.
  const isoSingle = label.trim().match(/^(\d{4}-\d{2}-\d{2})$/);
  if (isoSingle) return { end: isoSingle[1] };

  const toIso = (raw: string, fallbackYear?: string): string | undefined => {
    const s = raw.trim();
    const dmy = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/);
    if (dmy) {
      let [, d, m, y] = dmy;
      if (y.length === 2) y = '20' + y;
      return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
    }
    // "May 11" has no year — Date.parse would default to 2001, so borrow the
    // year from the other end of the range when this part doesn't have one.
    const target = fallbackYear && !/\d{4}/.test(s) ? `${s}, ${fallbackYear}` : s;
    const t = Date.parse(target);
    if (isNaN(t)) return undefined;
    // Re-anchor to UTC midnight of the parsed *local* date — Date.parse gives
    // local midnight, and toISOString() on that can roll back a day in
    // timezones ahead of UTC (e.g. AEST).
    const d = new Date(t);
    return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())).toISOString().split('T')[0];
  };

  // Split on a hyphen/en-dash/em-dash only when surrounded by whitespace, or
  // on "to" — bare hyphens inside dates (e.g. "1-3-2026") are left alone.
  const parts = label.split(/\s+(?:-|–|—|to)\s+/i).filter(Boolean);
  if (parts.length >= 2) {
    const last = parts[parts.length - 1];
    const fallbackYear = last.match(/\d{4}/)?.[0];
    return { start: toIso(parts[0], fallbackYear), end: toIso(last) };
  }
  if (parts.length === 1) return { end: toIso(parts[0]) };
  return {};
}

function UploadCardStatementModal({ isOpen, onClose, card, onSaved }: {
  isOpen: boolean; onClose: () => void;
  card: CreditCard;
  onSaved: () => void;
}) {
  const { transactions: allTransactions, setTransactions, creditCardStatements } = useStore();
  const [uploading, setUploading] = useState(false);
  const [msg, setMsg] = useState('');
  const [msgType, setMsgType] = useState<'success' | 'error' | 'info'>('info');
  const [parsed, setParsed] = useState<{
    closing_balance?: number; credit_limit?: number;
    minimum_payment?: number; due_date?: string;
    statement_period?: string;
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

    // Create the statement for this billing cycle, dated to its real period so
    // each upload lands in the right month. balance_owing is recomputed from the
    // card's unpaid statements inside statementsDS.add().
    if (parsed.closing_balance != null) {
      const { start, end } = parseStatementPeriod(parsed.statement_period);
      const periodEnd = end ?? parsed.due_date ?? new Date().toISOString().split('T')[0];
      const periodMonth = periodEnd.slice(0, 7); // YYYY-MM

      // Is this the newest statement on the card? Only the newest one's
      // minimum_payment / due_date should propagate up to the card meta —
      // uploading an older statement must not clobber the current values.
      const newerExists = creditCardStatements.some(
        st => st.credit_card_id === card.id &&
              st.period_label !== 'Current statement' &&
              (st.period_end ?? '') > periodEnd,
      );

      // Re-uploading the same month's statement updates it rather than duplicating.
      // Ignore the placeholder "Current statement" so a real upload sits beside it.
      const existing = creditCardStatements.find(
        st => st.credit_card_id === card.id &&
              st.period_label !== 'Current statement' &&
              (st.period_end ?? '').slice(0, 7) === periodMonth,
      );
      if (existing) {
        creditCardStatementsDS.update(existing.id, {
          closing_balance: parsed.closing_balance,
          minimum_payment: parsed.minimum_payment ?? existing.minimum_payment,
          period_label: parsed.statement_period ?? existing.period_label,
          period_start: start ?? existing.period_start,
          period_end: periodEnd,
          due_date: parsed.due_date ?? existing.due_date,
        });
      } else {
        creditCardStatementsDS.add({
          credit_card_id: card.id,
          closing_balance: parsed.closing_balance,
          minimum_payment: parsed.minimum_payment ?? null,
          period_label: parsed.statement_period ?? null,
          period_start: start ?? null,
          period_end: periodEnd,
          due_date: parsed.due_date ?? null,
          source: 'statement',
          currency: card.currency,
        });
      }

      // Update card-level metadata. credit_limit is statement-agnostic so always
      // apply it; minimum_payment / due_date only from the newest statement.
      const updates: Partial<CreditCard> = {};
      if (parsed.credit_limit != null && parsed.credit_limit > 0) updates.credit_limit = parsed.credit_limit;
      if (!newerExists) {
        if (parsed.minimum_payment != null) updates.minimum_payment = parsed.minimum_payment;
        if (parsed.due_date) updates.due_date = parsed.due_date;
      }
      if (Object.keys(updates).length > 0) creditCardsDS.update(card.id, updates);
    } else {
      // No statement in this doc — still capture standalone card metadata.
      const updates: Partial<CreditCard> = {};
      if (parsed.credit_limit != null && parsed.credit_limit > 0) updates.credit_limit = parsed.credit_limit;
      if (parsed.minimum_payment != null) updates.minimum_payment = parsed.minimum_payment;
      if (parsed.due_date) updates.due_date = parsed.due_date;
      if (Object.keys(updates).length > 0) creditCardsDS.update(card.id, updates);
    }

    // Add transactions, skipping dupes.
    let added = 0;
    if (parsed.transactions?.length) {
      // Snapshot of transactions that existed BEFORE this import. We dedup re-uploads
      // against this snapshot only (date + amount + account_type, NOT merchant, since
      // re-parsing yields varying merchant strings). We deliberately do NOT fold rows
      // added during THIS import back into the snapshot, so two genuinely-different
      // same-amount, same-day purchases within one statement are both kept.
      const preExisting = [...allTransactions];
      for (const tx of parsed.transactions) {
        const normalizedAmt = -Math.abs(tx.amount);
        const isDup = preExisting.some(e =>
          e.account_type === 'credit_card' && e.date === tx.date && Math.abs(e.amount - normalizedAmt) < 0.01
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
