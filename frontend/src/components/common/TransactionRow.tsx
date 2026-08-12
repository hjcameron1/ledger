import { useEffect, useRef, useState } from 'react';
import { useStore } from '../../store';
import { accountIdMatches } from '../../services/dataService';
import { formatCurrency, formatDate } from '../../utils/format';
import { useAllCategories } from '../../utils/categories';
import SplitModal from './SplitModal';
import TaxModal from './TaxModal';
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
 * The layered "peek" cards that turn the normal category chip into a small deck
 * when a transaction is split across categories. They sit BEHIND the real chip
 * (negative z-index inside the chip's isolated stacking context) and poke a few
 * px out its bottom edge — the same notification-stack look as Bills & Reminders,
 * scaled right down. The nominated category name stays on the front chip; these
 * only signal "there are more categories underneath". On row hover the layers
 * ease down a touch (spread), then settle back on mouse-out. Purely decorative —
 * the split ACTION is the branch icon on the right; this is never a second icon.
 *
 * One peek for a 2-way split, two for 3+ (deeper = narrower, lower, fainter).
 */
function SplitDeck({ count }: { count: number }) {
  const peeks = Math.min(count - 1, 2); // 2 splits → 1 peek, 3+ → 2
  return (
    <>
      {Array.from({ length: peeks }).map((_, i) => (
        <span
          key={i}
          aria-hidden
          className="pointer-events-none absolute left-1/2 -translate-x-1/2 rounded-[4px] bg-zinc-200 dark:bg-zinc-700 border border-zinc-300 dark:border-zinc-600 transition-transform duration-300 ease-out group-hover:translate-y-[2px]"
          style={{
            zIndex: -1 - i,
            top: 2 + i,           // tucked behind the chip — never pokes above it
            bottom: -(3 + i * 3), // only the bottom edge sticks out
            width: `${82 - i * 12}%`,
            opacity: 1 - i * 0.25,
          }}
        />
      ))}
    </>
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

  // Tax metadata editor (Phase 2D.1) — same self-contained pattern as Split, so
  // every surface gets the tax affordance for free.
  const [taxOpen, setTaxOpen] = useState(false);

  // Row actions overflow menu (⋯). Groups the per-row actions — Tax details,
  // Split, Delete — behind one always-visible, labelled control so each is
  // discoverable (including on touch, where the old hover-only icons never
  // appeared). Self-contained like the modals above.
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

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

  // Close the actions overflow menu on any outside click.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [menuOpen]);

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
            {tx.transaction_type === 'refund' && (
              <span
                className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-[#22c55e]/10 text-[#22c55e]"
                title="Matched refund — credited back against the original purchase, so it reduces that category's spend and is never counted as income."
              >
                ↩ Refund
              </span>
            )}
            {tx.is_tax_deductible && (
              <span
                className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-[#0ea5e9]/10 text-[#0284c7] dark:text-[#38bdf8]"
                title={[
                  'Marked tax deductible',
                  tx.deduction_category ? `· ${tx.deduction_category}` : '',
                  tx.entity ? `· ${tx.entity}` : '',
                ].filter(Boolean).join(' ')}
              >
                🧾 Deductible
              </span>
            )}
            <span className="text-xs text-zinc-500 dark:text-zinc-400">·</span>
            {/* `isolate` gives the split "deck" its own stacking context so the
                peek cards (z-index −1) sit behind this chip but above the row.
                `inline-flex` makes the box hug the chip exactly (no inline-block
                leading above it) so the deck can only poke out the bottom. */}
            <div className={`relative isolate inline-flex ${catOpen ? 'z-50' : ''}`} ref={catRef}>
              {splitCount > 1 && <SplitDeck count={splitCount} />}
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
        {/* When this row is tax-deductible, a subtle always-on receipt tint on the
            ⋯ button hints the metadata exists; otherwise the menu is where every
            per-row action now lives (labelled + touch-reachable). */}
        <div className="relative" ref={menuRef}>
          <button
            onClick={() => setMenuOpen(o => !o)}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            className={`${tx.is_tax_deductible ? 'text-[#0284c7] dark:text-[#38bdf8]' : 'text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200'} opacity-70 group-hover:opacity-100 transition-opacity p-1 rounded hover:bg-zinc-200 dark:hover:bg-zinc-700`}
            title="Transaction actions"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/>
            </svg>
          </button>
          {menuOpen && (
            <div
              role="menu"
              className="absolute right-0 top-full mt-1 z-50 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-[8px] shadow-lg min-w-[190px] py-1"
            >
              <button
                role="menuitem"
                onClick={() => { setMenuOpen(false); setTaxOpen(true); }}
                className="w-full flex items-center gap-2 text-left px-3 py-1.5 text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0 text-[#0284c7] dark:text-[#38bdf8]">
                  <path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z"/>
                  <path d="M8 8h8"/><path d="M8 12h8"/><path d="M8 16h5"/>
                </svg>
                <span>{tx.is_tax_deductible ? 'Edit tax details' : 'Tax details'}</span>
                {tx.is_tax_deductible && <span className="ml-auto text-[10px] text-[#0284c7] dark:text-[#38bdf8]">🧾</span>}
              </button>
              <button
                role="menuitem"
                onClick={() => { setMenuOpen(false); setSplitOpen(true); }}
                className="w-full flex items-center gap-2 text-left px-3 py-1.5 text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0 text-brand">
                  <line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>
                </svg>
                <span>{splitCount > 0 ? 'Edit split' : 'Split across categories'}</span>
              </button>
              <div className="my-1 border-t border-zinc-100 dark:border-zinc-800" />
              <button
                role="menuitem"
                onClick={() => { setMenuOpen(false); onDelete(tx.id); }}
                className="w-full flex items-center gap-2 text-left px-3 py-1.5 text-xs text-[#ef4444] hover:bg-[#ef4444]/10"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="flex-shrink-0">
                  <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
                </svg>
                <span>Delete transaction</span>
              </button>
            </div>
          )}
        </div>
      </div>
      {splitOpen && <SplitModal tx={tx} isOpen={splitOpen} onClose={() => setSplitOpen(false)} />}
      {taxOpen && <TaxModal tx={tx} isOpen={taxOpen} onClose={() => setTaxOpen(false)} />}
    </div>
  );
}
