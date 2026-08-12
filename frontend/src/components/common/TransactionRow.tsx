import { useEffect, useRef, useState } from 'react';
import { useStore } from '../../store';
import { accountIdMatches } from '../../services/dataService';
import { formatCurrency, formatDate } from '../../utils/format';
import { useAllCategories } from '../../utils/categories';
import SplitModal from './SplitModal';
import type { CorrectionScope } from '../../utils/corrections';
import type { Transaction, BankAccount, CreditCard } from '../../types';

// Emoji per category, used for the little avatar on each transaction row.
export const TX_EMOJI: Record<string, string> = {
  Groceries: '🛒', Dining: '🍔', Entertainment: '🎬', Fuel: '⛽',
  Travel: '✈️', Transport: '🚗', Fitness: '💪', Health: '💊',
  Electronics: '💻', Insurance: '🛡️', Utilities: '⚡', Rent: '🏠',
  Telecommunications: '📱', Dividends: '💰',
};

/** Resolve a transaction's owning account/card name, tolerating local↔server id swaps. */
export function resolveAccountName(
  tx: { account_id: string; account_type: 'bank' | 'credit_card' | 'loan' },
  accounts: BankAccount[],
  creditCards: CreditCard[],
): string | null {
  const matches = (a: { id: string; localId?: string; serverId?: string }) =>
    accountIdMatches(tx.account_id, a);
  if (tx.account_type === 'credit_card') return creditCards.find(matches)?.name ?? null;
  return accounts.find(matches)?.name ?? null;
}

/**
 * Phase 2B learn-from-corrections chooser. After the user picks a new category or
 * renames a merchant we ask HOW WIDELY the correction should apply — the three
 * options map 1:1 to `applyCorrection`'s scopes:
 *
 *   'only'     → just this transaction (creates no rule/alias)
 *   'future'   → also teach a rule/alias so future matches classify the same way
 *   'existing' → that, PLUS retro-apply to matching transactions already stored
 *
 * Deliberately tiny: a label + three buttons, styled like the category menu.
 */
function ScopeChooser({ label, onPick }: {
  label: string;
  onPick: (scope: CorrectionScope) => void;
}) {
  const opts: { scope: CorrectionScope; text: string; hint: string }[] = [
    { scope: 'only', text: 'This transaction only', hint: 'Just this one' },
    { scope: 'future', text: 'Apply to future matching', hint: 'Remember for next time' },
    { scope: 'existing', text: 'Apply to matching existing', hint: 'Update past ones too' },
  ];
  return (
    <div className="py-1 min-w-[190px]">
      <p className="px-3 py-1 text-[11px] font-medium text-zinc-500 dark:text-zinc-400 truncate">{label}</p>
      {opts.map(o => (
        <button
          key={o.scope}
          onClick={() => onPick(o.scope)}
          className="w-full text-left px-3 py-1.5 hover:bg-zinc-100 dark:hover:bg-zinc-800"
        >
          <span className="block text-xs">{o.text}</span>
          <span className="block text-[10px] text-zinc-400 dark:text-zinc-500">{o.hint}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * A tiny stacked-card indicator that a transaction is split across categories.
 * Purely decorative (the split action lives on the row's right-side icon) — it
 * mirrors the layered "deck" look used by the Bills & Reminders overflow stacker:
 * 2–3 rounded chips tucked behind each other with a diagonal offset, decreasing
 * opacity, and a subtle hover where the layers spread apart then settle back.
 *
 * Shows at most 3 layers regardless of the exact split count (3+ all read as 3).
 */
function SplitStack({ count }: { count: number }) {
  const [hover, setHover] = useState(false);
  const layers = Math.min(Math.max(count, 2), 3); // always looks like a deck (≥2)
  return (
    <span
      className="relative inline-flex flex-shrink-0"
      style={{ width: 22, height: 14 }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={`Split across ${count} categories — budgets use the split lines`}
      aria-label={`Split across ${count} categories`}
    >
      {Array.from({ length: layers }).map((_, i) => {
        // Front layer (i=0) sits flat bottom-left; deeper layers peek up-and-right.
        const off = i * (hover ? 5 : 3); // spread wider on hover, then transition back
        return (
          <span
            key={i}
            className="absolute rounded-[3px] border border-[#8b5cf6]/45 bg-[#8b5cf6]/15 transition-transform duration-300 ease-out"
            style={{
              width: 13,
              height: 9,
              left: 0,
              bottom: 0,
              zIndex: layers - i,
              opacity: 1 - i * 0.28,
              transform: `translate(${off}px, ${-off}px)`,
            }}
          />
        );
      })}
    </span>
  );
}

/**
 * A single transaction line with an inline, click-to-change category chip, an
 * (optional) click-to-rename merchant, and a hover-to-reveal delete button.
 * Shared by the Accounts detail modals, the Accounts › Transactions tab, and the
 * budget's per-category breakdown so the correction affordance is identical
 * everywhere.
 *
 * `onCategoryChange` / `onMerchantChange` receive a SCOPE so the caller can route
 * through `transactionsDS.applyCorrection(id, {…}, scope)`. `onMerchantChange` is
 * optional — omit it to hide the rename affordance (e.g. read-only surfaces).
 */
export function TransactionRow({ tx, onDelete, onCategoryChange, onMerchantChange, isTransfer }: {
  tx: Transaction;
  onDelete: (id: string) => void;
  onCategoryChange: (id: string, category: string, scope: CorrectionScope) => void;
  onMerchantChange?: (id: string, merchant: string, scope: CorrectionScope) => void;
  isTransfer?: boolean;
}) {
  const [catOpen, setCatOpen] = useState(false);
  // The just-picked category awaiting a scope choice (null = show the category list).
  const [pendingCat, setPendingCat] = useState<string | null>(null);
  const catRef = useRef<HTMLDivElement>(null);

  const [editingMerchant, setEditingMerchant] = useState(false);
  const [merchantDraft, setMerchantDraft] = useState('');
  // The just-renamed merchant awaiting a scope choice.
  const [pendingMerchant, setPendingMerchant] = useState<string | null>(null);
  const merchantRef = useRef<HTMLDivElement>(null);

  // Split editor (Phase 2C) — self-contained so every TransactionRow surface gets
  // the Split affordance with no extra wiring.
  const [splitOpen, setSplitOpen] = useState(false);

  const { accounts, creditCards, transactionSplits } = useStore();
  const allCategories = useAllCategories();
  const accountName = resolveAccountName(tx, accounts, creditCards);
  const splitCount = transactionSplits.reduce((n, s) => (s.transaction_id === tx.id ? n + 1 : n), 0);

  // Close this row's category menu (and reset its pending scope choice) when a
  // click lands outside it — so opening another menu leaves only one open.
  useEffect(() => {
    if (!catOpen) return;
    const onDown = (e: MouseEvent) => {
      if (catRef.current && !catRef.current.contains(e.target as Node)) {
        setCatOpen(false);
        setPendingCat(null);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [catOpen]);

  // Same, for the merchant rename input / its scope chooser.
  useEffect(() => {
    if (!editingMerchant && pendingMerchant === null) return;
    const onDown = (e: MouseEvent) => {
      if (merchantRef.current && !merchantRef.current.contains(e.target as Node)) {
        setEditingMerchant(false);
        setPendingMerchant(null);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [editingMerchant, pendingMerchant]);

  const commitMerchant = () => {
    const v = merchantDraft.trim();
    setEditingMerchant(false);
    if (!v || v === tx.merchant) return; // unchanged / empty → no correction
    setPendingMerchant(v);
  };

  return (
    <div className="flex items-center justify-between px-2 py-2.5 rounded-[8px] hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors group">
      <div className="flex items-center gap-3 min-w-0">
        <div className="w-8 h-8 rounded-full bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center text-sm flex-shrink-0">
          {TX_EMOJI[tx.category] ?? '💳'}
        </div>
        <div className="min-w-0">
          {/* Merchant — display, or (when editable) click-to-rename with a scope prompt. */}
          <div className="relative" ref={merchantRef}>
            {editingMerchant ? (
              <input
                autoFocus
                value={merchantDraft}
                onChange={e => setMerchantDraft(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') commitMerchant();
                  else if (e.key === 'Escape') { setEditingMerchant(false); setMerchantDraft(''); }
                }}
                onBlur={commitMerchant}
                className="text-sm font-medium bg-transparent border-b border-brand outline-none w-full max-w-[200px]"
              />
            ) : (
              <div className="flex items-center gap-1 min-w-0">
                <p className="text-sm font-medium truncate">{tx.merchant}</p>
                {onMerchantChange && (
                  <button
                    onClick={() => { setMerchantDraft(tx.merchant); setEditingMerchant(true); setCatOpen(false); }}
                    className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded text-zinc-400 hover:text-brand flex-shrink-0"
                    title="Rename merchant"
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                    </svg>
                  </button>
                )}
              </div>
            )}
            {onMerchantChange && pendingMerchant !== null && (
              <div className="absolute left-0 top-full mt-1 z-50 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-[8px] shadow-lg">
                <ScopeChooser
                  label={`Rename to “${pendingMerchant}”`}
                  onPick={(scope) => {
                    onMerchantChange(tx.id, pendingMerchant, scope);
                    setPendingMerchant(null);
                  }}
                />
              </div>
            )}
          </div>
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-xs text-zinc-500 dark:text-zinc-400">{formatDate(tx.date)}</span>
            {tx.source === 'manual' && (
              <span
                className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-400 dark:text-zinc-500"
                title="You added this transaction manually — everything else was imported automatically"
              >
                manual
              </span>
            )}
            {(tx.reconcile_state === 'conflict' || tx.reconcile_state === 'pending') && (
              <span
                className="w-1.5 h-1.5 rounded-full bg-[#f59e0b] inline-block"
                title={tx.reconcile_state === 'conflict'
                  ? 'Looks like a possible duplicate of a synced transaction — see this account for review'
                  : "Waiting to be confirmed against your bank sync"}
              />
            )}
            {isTransfer && (
              <span
                className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-brand/10 text-brand"
                title="Money moved between your own accounts — not counted as spending"
              >
                🔄 Transfer
              </span>
            )}
            {splitCount > 0 && <SplitStack count={splitCount} />}
            <span className="text-xs text-zinc-500 dark:text-zinc-400">·</span>
            <div className="relative" ref={catRef}>
              <button
                onClick={() => { setCatOpen(o => !o); setPendingCat(null); }}
                className="text-xs px-1.5 py-0.5 rounded-[4px] bg-zinc-200 dark:bg-zinc-800 hover:bg-zinc-300 dark:hover:bg-[#333] transition-colors"
              >
                {tx.category || 'Uncategorised'}
              </button>
              {catOpen && (
                <div className="absolute left-0 top-full mt-1 z-50 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-[8px] shadow-lg min-w-[140px] max-h-64 overflow-y-auto">
                  {pendingCat === null ? (
                    <div className="py-1">
                      {allCategories.map(cat => (
                        <button
                          key={cat}
                          onClick={() => {
                            if (cat === tx.category) { setCatOpen(false); return; }
                            setPendingCat(cat); // ask for scope before applying
                          }}
                          className={`w-full text-left px-3 py-1.5 text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800 ${tx.category === cat ? 'font-semibold text-brand' : ''}`}
                        >
                          {cat}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <ScopeChooser
                      label={`Set “${pendingCat}”`}
                      onPick={(scope) => {
                        onCategoryChange(tx.id, pendingCat, scope);
                        setPendingCat(null);
                        setCatOpen(false);
                      }}
                    />
                  )}
                </div>
              )}
            </div>
          </div>
          {accountName && (
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5 truncate">{accountName}</p>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2 flex-shrink-0 ml-3">
        <span className={`text-sm font-semibold amount ${tx.amount < 0 ? 'text-[#ef4444]' : 'text-[#22c55e]'}`}>
          {tx.amount < 0 ? '-' : '+'}{formatCurrency(Math.abs(tx.display_amount ?? tx.amount), tx.display_currency ?? tx.currency)}
        </span>
        <button
          onClick={() => setSplitOpen(true)}
          className={`${splitCount > 0 ? 'opacity-100 text-[#8b5cf6]' : 'opacity-0 group-hover:opacity-100 text-zinc-400 hover:text-[#8b5cf6]'} transition-opacity p-1 rounded hover:bg-[#8b5cf6]/10`}
          title={splitCount > 0 ? 'Edit split' : 'Split across categories'}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>
          </svg>
        </button>
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
      {splitOpen && <SplitModal tx={tx} isOpen={splitOpen} onClose={() => setSplitOpen(false)} />}
    </div>
  );
}
