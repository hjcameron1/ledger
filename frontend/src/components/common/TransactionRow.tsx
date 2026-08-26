import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../store';
import { accountIdMatches } from '../../services/dataService';
import { formatCurrency, formatDate } from '../../utils/format';
import { useAllCategories } from '../../utils/categories';
import { splitDisplay, needsSplitDecision, type SplitCategoryChoice } from '../../utils/transactionSplits';
import SplitModal from './SplitModal';
import TaxModal from './TaxModal';
import ResponsibilityModal from './ResponsibilityModal';
import { transactionHouseholds, canAttribute } from '../../services/dataService';
import { hasAttribution, paidBy } from '../../utils/sharedSpending';
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
          <span className="block text-[10px] text-zinc-500 dark:text-zinc-400">{o.hint}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * Asked when someone re-files a transaction that is ALREADY split.
 *
 * Budgets and reports read the split lines, not the transaction's category
 * column — so silently accepting the new category would leave the old division
 * running underneath and the screen naming a category nothing counts. Rather
 * than guess, ask, in the three terms the situation actually has:
 *
 *   Replace — the new category takes the whole amount; the split goes.
 *   Keep    — the split still decides the reporting; the pick becomes the
 *             fallback category (and teaches the scope chosen next).
 *   Edit    — neither: open the split editor with the new category ready to
 *             take a share.
 *
 * Shown BEFORE the scope chooser, because "Edit split" answers the question
 * without ever needing a scope.
 */
function SplitChoiceChooser({ newCategory, currentLabel, onPick }: {
  newCategory: string;
  currentLabel: string;
  onPick: (choice: SplitCategoryChoice) => void;
}) {
  const opts: { choice: SplitCategoryChoice; text: string; hint: string }[] = [
    { choice: 'replace', text: `Replace split with ${newCategory}`, hint: 'All of it counts here' },
    { choice: 'keep', text: 'Keep existing split', hint: `Budgets keep using ${currentLabel}` },
    { choice: 'edit', text: 'Edit split', hint: 'Divide it yourself' },
  ];
  return (
    <div className="py-1 min-w-[210px]">
      <p className="px-3 py-1 text-[11px] font-medium text-zinc-500 dark:text-zinc-400">
        This transaction is split
      </p>
      {opts.map(o => (
        <button
          key={o.choice}
          onClick={() => onPick(o.choice)}
          className="w-full text-left px-3 py-1.5 hover:bg-zinc-100 dark:hover:bg-zinc-800"
        >
          <span className="block text-xs">{o.text}</span>
          <span className="block text-[10px] text-zinc-500 dark:text-zinc-400">{o.hint}</span>
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
 *
 * The category chip always names a category the REPORTS agree with: for a split
 * transaction that is its largest line, not the parent's dormant column (see
 * `splitDisplay`). Re-filing a split row asks what to do with the split first,
 * and passes the answer to `onCategoryChange` as its fourth argument.
 */
export function TransactionRow({ tx, onDelete, onCategoryChange, onMerchantChange, onEntityChange, isTransfer, splitContext }: {
  tx: Transaction;
  onDelete: (id: string) => void;
  onCategoryChange: (id: string, category: string, scope: CorrectionScope, splits?: SplitCategoryChoice) => void;
  onMerchantChange?: (id: string, merchant: string, scope: CorrectionScope) => void;
  /**
   * Phase 2D.2 — set (or clear) this transaction's business/personal
   * classification. `null` clears it (this row only); a value routes through
   * `applyCorrection(id, {entity}, scope)` so "future"/"existing" also teach a
   * rule. Omit to hide the classify affordance on read-only surfaces.
   */
  onEntityChange?: (id: string, entity: 'business' | 'personal' | null, scope: CorrectionScope) => void;
  isTransfer?: boolean;
  /**
   * Set when this row is listed UNDER a category (the budget drill-down), so a
   * split transaction can show the slice that category was charged rather than
   * the whole amount that left the account — otherwise a $250 row would sit
   * inside a total that only counted $140 of it.
   */
  splitContext?: { category: string; amount: number };
}) {
  const [catOpen, setCatOpen] = useState(false);
  // The just-picked category awaiting a scope choice (null = show the category list).
  const [pendingCat, setPendingCat] = useState<string | null>(null);
  // What to do with an existing split, once asked. null = not answered yet, which
  // on a split row means the split chooser is what the menu shows.
  const [splitChoice, setSplitChoice] = useState<SplitCategoryChoice | null>(null);
  const catRef = useRef<HTMLDivElement>(null);

  const [editingMerchant, setEditingMerchant] = useState(false);
  const [merchantDraft, setMerchantDraft] = useState('');
  // The just-renamed merchant awaiting a scope choice.
  const [pendingMerchant, setPendingMerchant] = useState<string | null>(null);
  const merchantRef = useRef<HTMLDivElement>(null);

  // Split editor (Phase 2C) — self-contained so every TransactionRow surface gets
  // the Split affordance with no extra wiring. `splitSeed` carries a category the
  // user picked on the chip into the editor, so "Edit split" opens with the thing
  // they were trying to file it under already waiting for a share.
  const [splitOpen, setSplitOpen] = useState(false);
  const [splitSeed, setSplitSeed] = useState<string | null>(null);

  // Tax metadata editor (Phase 2D.1) — same self-contained pattern as Split, so
  // every surface gets the tax affordance for free.
  const [taxOpen, setTaxOpen] = useState(false);

  // Who-paid / responsibility editor (Phase 7.2) — same self-contained pattern.
  // Only offered on a transaction shared with a household the user is in.
  const [respOpen, setRespOpen] = useState(false);

  // Row actions overflow menu (⋯). Groups the per-row actions — Tax details,
  // Split, Delete — behind one always-visible, labelled control so each is
  // discoverable (including on touch, where the old hover-only icons never
  // appeared). Self-contained like the modals above.
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  // The business/personal value awaiting a scope choice inside the actions menu
  // (null = show the normal action list). Mirrors the category chip's pendingCat.
  const [pendingEntity, setPendingEntity] = useState<'business' | 'personal' | null>(null);

  const { accounts, creditCards, transactionSplits, householdMembers, user } = useStore();
  const allCategories = useAllCategories();
  const accountName = resolveAccountName(tx, accounts, creditCards);

  // Phase 7.2 — shared-spending attribution. Household visibility is derived
  // from the transaction AND its account (transactionHouseholds), never from
  // the stamps this particular copy happens to carry — some surfaces render
  // rows straight from the store without the list-level account stamping, and
  // a joint-account purchase must qualify on every one of them.
  const inSharedHousehold = transactionHouseholds(tx).some(h =>
    householdMembers.some(m => m.household_id === h && m.user_id === user?.id && m.status === 'active'));
  // Viewers see the chip (it's information) but can't open the editor.
  const canAttributeTx = canAttribute(tx);
  const memberName = (userId: string | null): string => {
    if (!userId) return 'someone';
    if (userId === user?.id) return 'You';
    const m = householdMembers.find(x => x.user_id === userId);
    return m?.name || m?.email || 'a member';
  };
  const payer = paidBy(tx, user?.id);
  const respSplit = tx.responsibility_split?.length ? tx.responsibility_split : null;
  const respOne = tx.responsible_user_id ?? null;
  const attributionLabel = respSplit
    ? `${memberName(payer)} paid · split ${respSplit.length} ways`
    : respOne && respOne !== payer
      ? `${memberName(payer)} paid for ${memberName(respOne)}`
      : `Paid by ${memberName(payer)}`;
  const attributionDetail = respSplit
    ? respSplit.map(l => `${memberName(l.user_id)}: ${l.percent !== undefined ? `${l.percent}%` : formatCurrency(l.amount ?? 0, tx.currency)}`).join(' · ')
    : undefined;
  const splitLines = useMemo(
    () => transactionSplits.filter(s => s.transaction_id === tx.id),
    [transactionSplits, tx.id],
  );
  const splitCount = splitLines.length;
  // The one answer to "what is this filed as?" — the same one the reports use.
  const filedAs = splitDisplay(tx.category, splitLines);

  // Close this row's category menu (and reset its pending scope choice) when a
  // click lands outside it — so opening another menu leaves only one open.
  useEffect(() => {
    if (!catOpen) return;
    const onDown = (e: MouseEvent) => {
      if (catRef.current && !catRef.current.contains(e.target as Node)) {
        setCatOpen(false);
        setPendingCat(null);
        setSplitChoice(null);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [catOpen]);

  // Close the actions overflow menu on any outside click.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
        setPendingEntity(null);
      }
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
          {TX_EMOJI[filedAs.label] ?? '💳'}
        </div>
        <div className="min-w-0">
          {/* Merchant — display, or (when editable) click-to-rename with a scope prompt. */}
          <div className="relative" ref={merchantRef}>
            {editingMerchant ? (
              <input
                autoFocus
                aria-label="Rename merchant"
                value={merchantDraft}
                onChange={e => setMerchantDraft(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') commitMerchant();
                  // preventDefault marks Escape as handled so the enclosing modal stays open.
                  else if (e.key === 'Escape') { e.preventDefault(); setEditingMerchant(false); setMerchantDraft(''); }
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
                className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400"
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
            {(tx.entity === 'business' || tx.entity === 'personal') && (
              <span
                className={tx.entity === 'business'
                  ? 'text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-[#6366f1]/10 text-[#6366f1] dark:text-[#a5b4fc]'
                  : 'text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-[#14b8a6]/10 text-[#0d9488] dark:text-[#5eead4]'}
                title={tx.entity === 'business' ? 'Classified as a business transaction' : 'Classified as a personal transaction'}
              >
                {tx.entity === 'business' ? '💼 Business' : '👤 Personal'}
              </span>
            )}
            {/* Phase 7.2 — paid-by vs responsible-for, at a glance. Only ever an
                attribution the user (or a member) explicitly set; a plain shared
                transaction stays unbadged. Click to change it. */}
            {inSharedHousehold && hasAttribution(tx) && (
              canAttributeTx ? (
                <button
                  type="button"
                  onClick={() => setRespOpen(true)}
                  className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-[#8b5cf6]/10 text-[#7c3aed] dark:text-[#c4b5fd] hover:bg-[#8b5cf6]/20 transition-colors"
                  title={attributionDetail ?? 'Who paid, and whose spending it is — reporting only, no balance moves'}
                >
                  👥 {attributionLabel}
                </button>
              ) : (
                <span
                  className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-[#8b5cf6]/10 text-[#7c3aed] dark:text-[#c4b5fd]"
                  title={attributionDetail ?? 'Who paid, and whose spending it is'}
                >
                  👥 {attributionLabel}
                </span>
              )
            )}
            <span className="text-xs text-zinc-500 dark:text-zinc-400">·</span>
            {/* `isolate` gives the split "deck" its own stacking context so the
                peek cards (z-index −1) sit behind this chip but above the row.
                `inline-flex` makes the box hug the chip exactly (no inline-block
                leading above it) so the deck can only poke out the bottom. */}
            <div className={`relative isolate inline-flex ${catOpen ? 'z-50' : ''}`} ref={catRef}>
              {splitCount > 1 && <SplitDeck count={splitCount} />}
              <button
                onClick={() => { setCatOpen(o => !o); setPendingCat(null); setSplitChoice(null); }}
                className="text-xs px-1.5 py-0.5 rounded-[4px] bg-zinc-200 dark:bg-zinc-800 hover:bg-zinc-300 dark:hover:bg-[#333] transition-colors"
                title={filedAs.isSplit
                  ? `Split across ${filedAs.categories.join(', ')} — that is what your budgets count`
                  : undefined}
              >
                {filedAs.label}
                {filedAs.extra > 0 && (
                  <span className="text-zinc-500 dark:text-zinc-400"> +{filedAs.extra}</span>
                )}
              </button>
              {catOpen && (
                <div className="absolute left-0 top-full mt-1 z-50 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-[8px] shadow-lg min-w-[140px] max-h-64 overflow-y-auto">
                  {pendingCat === null ? (
                    <div className="py-1">
                      {allCategories.map(cat => (
                        <button
                          key={cat}
                          onClick={() => {
                            // On an unsplit row, re-picking what it already is
                            // is a no-op. On a split row it is not: the split
                            // still has to be answered for.
                            if (!filedAs.isSplit && cat === tx.category) { setCatOpen(false); return; }
                            setPendingCat(cat);
                            setSplitChoice(null);
                          }}
                          className={`w-full text-left px-3 py-1.5 text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800 ${filedAs.categories.includes(cat) ? 'font-semibold text-brand' : ''}`}
                        >
                          {cat}
                        </button>
                      ))}
                    </div>
                  ) : needsSplitDecision(splitLines, pendingCat) && splitChoice === null ? (
                    <SplitChoiceChooser
                      newCategory={pendingCat}
                      currentLabel={filedAs.categories.join(' + ')}
                      onPick={(choice) => {
                        if (choice === 'edit') {
                          // The split editor IS the answer — no scope to ask for.
                          setSplitSeed(pendingCat);
                          setPendingCat(null);
                          setCatOpen(false);
                          setSplitOpen(true);
                          return;
                        }
                        setSplitChoice(choice);
                      }}
                    />
                  ) : (
                    <ScopeChooser
                      label={`Set “${pendingCat}”`}
                      onPick={(scope) => {
                        onCategoryChange(tx.id, pendingCat, scope, splitChoice ?? undefined);
                        setPendingCat(null);
                        setSplitChoice(null);
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
        {/* Under a category, a split row is worth what THAT category was charged —
            shown with the full transaction underneath it so the bank amount is
            never hidden, only put in its place. */}
        {splitContext && filedAs.isSplit ? (
          <span className="text-right">
            <span className={`block text-sm font-semibold amount ${tx.amount < 0 ? 'text-[#ef4444]' : 'text-[#22c55e]'}`}>
              {tx.amount < 0 ? '-' : '+'}{formatCurrency(splitContext.amount, tx.display_currency ?? tx.currency)}
            </span>
            <span className="block text-[10px] text-zinc-500 dark:text-zinc-400">
              of {formatCurrency(Math.abs(tx.display_amount ?? tx.amount), tx.display_currency ?? tx.currency)} split
            </span>
          </span>
        ) : (
          <span className={`text-sm font-semibold amount ${tx.amount < 0 ? 'text-[#ef4444]' : 'text-[#22c55e]'}`}>
            {tx.amount < 0 ? '-' : '+'}{formatCurrency(Math.abs(tx.display_amount ?? tx.amount), tx.display_currency ?? tx.currency)}
          </span>
        )}
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
              {/* Classify (business vs personal) picked a value — ask how widely to
                  apply it before committing, exactly like the category chip does. */}
              {pendingEntity !== null && onEntityChange ? (
                <ScopeChooser
                  label={`Mark as ${pendingEntity === 'business' ? 'Business' : 'Personal'}`}
                  onPick={(scope) => {
                    onEntityChange(tx.id, pendingEntity, scope);
                    setPendingEntity(null);
                    setMenuOpen(false);
                  }}
                />
              ) : (
                <>
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
                    onClick={() => { setMenuOpen(false); setSplitSeed(null); setSplitOpen(true); }}
                    className="w-full flex items-center gap-2 text-left px-3 py-1.5 text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0 text-brand">
                      <line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>
                    </svg>
                    <span>{splitCount > 0 ? 'Edit split' : 'Split across categories'}</span>
                  </button>
                  {/* Phase 7.2 — who paid & who's responsible, for a transaction
                      in front of the user's household (shared itself, or riding
                      a shared account) — and only when their role may edit it. */}
                  {canAttributeTx && (
                    <button
                      role="menuitem"
                      onClick={() => { setMenuOpen(false); setRespOpen(true); }}
                      className="w-full flex items-center gap-2 text-left px-3 py-1.5 text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0 text-[#7c3aed] dark:text-[#c4b5fd]">
                        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/>
                        <path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>
                      </svg>
                      <span>{hasAttribution(tx) ? 'Edit who paid & split' : 'Who paid & split'}</span>
                    </button>
                  )}

                  {/* Business vs personal classification (Phase 2D.2). Picking a
                      value swaps this menu for the scope chooser above. */}
                  {onEntityChange && (
                    <>
                      <div className="my-1 border-t border-zinc-100 dark:border-zinc-800" />
                      <p className="px-3 pt-0.5 pb-1 text-[10px] font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Classify</p>
                      <button
                        role="menuitem"
                        onClick={() => setPendingEntity('business')}
                        className={`w-full flex items-center gap-2 text-left px-3 py-1.5 text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800 ${tx.entity === 'business' ? 'font-semibold' : ''}`}
                      >
                        <span className="flex-shrink-0">💼</span>
                        <span>Business</span>
                        {tx.entity === 'business' && <span className="ml-auto text-[#6366f1] dark:text-[#a5b4fc]">✓</span>}
                      </button>
                      <button
                        role="menuitem"
                        onClick={() => setPendingEntity('personal')}
                        className={`w-full flex items-center gap-2 text-left px-3 py-1.5 text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800 ${tx.entity === 'personal' ? 'font-semibold' : ''}`}
                      >
                        <span className="flex-shrink-0">👤</span>
                        <span>Personal</span>
                        {tx.entity === 'personal' && <span className="ml-auto text-[#0d9488] dark:text-[#5eead4]">✓</span>}
                      </button>
                      {(tx.entity === 'business' || tx.entity === 'personal') && (
                        <button
                          role="menuitem"
                          onClick={() => { setMenuOpen(false); onEntityChange(tx.id, null, 'only'); }}
                          className="w-full flex items-center gap-2 text-left px-3 py-1.5 text-xs text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                        >
                          <span className="flex-shrink-0 w-[14px] text-center">✕</span>
                          <span>Clear classification</span>
                        </button>
                      )}
                    </>
                  )}

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
                </>
              )}
            </div>
          )}
        </div>
      </div>
      {splitOpen && (
        <SplitModal
          tx={tx}
          isOpen={splitOpen}
          seedCategory={splitSeed}
          onClose={() => { setSplitOpen(false); setSplitSeed(null); }}
        />
      )}
      {taxOpen && <TaxModal tx={tx} isOpen={taxOpen} onClose={() => setTaxOpen(false)} />}
      {respOpen && <ResponsibilityModal tx={tx} isOpen={respOpen} onClose={() => setRespOpen(false)} />}
    </div>
  );
}
