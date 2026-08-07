import { useEffect, useRef, useState } from 'react';
import { useStore } from '../../store';
import { accountIdMatches } from '../../services/dataService';
import { formatCurrency, formatDate } from '../../utils/format';
import { useAllCategories } from '../../utils/categories';
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
 * A single transaction line with an inline, click-to-change category chip and a
 * hover-to-reveal delete button. Shared by the Accounts detail modals, the
 * Accounts › Transactions tab, and the budget's per-category breakdown so the
 * "click the category and pick a new one" affordance is identical everywhere.
 */
export function TransactionRow({ tx, onDelete, onCategoryChange, isTransfer }: {
  tx: Transaction;
  onDelete: (id: string) => void;
  onCategoryChange: (id: string, category: string) => void;
  isTransfer?: boolean;
}) {
  const [catOpen, setCatOpen] = useState(false);
  const catRef = useRef<HTMLDivElement>(null);
  const { accounts, creditCards } = useStore();
  const allCategories = useAllCategories();
  const accountName = resolveAccountName(tx, accounts, creditCards);

  // Close this row's category menu when a click lands anywhere outside it — so
  // opening another row's menu (or clicking away) leaves only one menu open.
  useEffect(() => {
    if (!catOpen) return;
    const onDown = (e: MouseEvent) => {
      if (catRef.current && !catRef.current.contains(e.target as Node)) setCatOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [catOpen]);
  return (
    <div className="flex items-center justify-between px-2 py-2.5 rounded-[8px] hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors group">
      <div className="flex items-center gap-3 min-w-0">
        <div className="w-8 h-8 rounded-full bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center text-sm flex-shrink-0">
          {TX_EMOJI[tx.category] ?? '💳'}
        </div>
        <div className="min-w-0">
          <p className="text-sm font-medium truncate">{tx.merchant}</p>
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-xs text-zinc-500 dark:text-zinc-400">{formatDate(tx.date)}</span>
            {isTransfer && (
              <span
                className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-brand/10 text-brand"
                title="Money moved between your own accounts — not counted as spending"
              >
                🔄 Transfer
              </span>
            )}
            <span className="text-xs text-zinc-500 dark:text-zinc-400">·</span>
            <div className="relative" ref={catRef}>
              <button
                onClick={() => setCatOpen(o => !o)}
                className="text-xs px-1.5 py-0.5 rounded-[4px] bg-zinc-200 dark:bg-zinc-800 hover:bg-zinc-300 dark:hover:bg-[#333] transition-colors"
              >
                {tx.category || 'Uncategorised'}
              </button>
              {catOpen && (
                <div className="absolute left-0 top-full mt-1 z-50 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-[8px] shadow-lg py-1 min-w-[140px] max-h-64 overflow-y-auto">
                  {allCategories.map(cat => (
                    <button
                      key={cat}
                      onClick={() => { onCategoryChange(tx.id, cat); setCatOpen(false); }}
                      className={`w-full text-left px-3 py-1.5 text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800 ${tx.category === cat ? 'font-semibold text-brand' : ''}`}
                    >
                      {cat}
                    </button>
                  ))}
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
