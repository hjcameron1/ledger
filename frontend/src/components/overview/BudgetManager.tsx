/**
 * Phase 4.2 — the budget EDITOR.
 *
 * Everything that writes a budget lives here, and every write goes through
 * `budgetsDS` (which upserts by category, so the same category can never end
 * up with two caps) — there is no second place a spending goal is stored any
 * more. The Phase 4.1 planner (`budget_lines`) is read exactly once, to import
 * its goals, and is never written to again.
 */

import { useMemo, useState } from 'react';
import { useStore } from '../../store';
import {
  budgetsDS, customCategoriesDS, billsDS, subscriptionsDS, transactionsDS,
} from '../../services/dataService';
import { useAllCategories, BASE_TX_CATEGORIES } from '../../utils/categories';
import { budgetableCategories, type BudgetView } from '../../utils/budgetView';
import { sameCategory, tidyCategoryName } from '../../utils/categoryResolve';
import { splitDisplay } from '../../utils/transactionSplits';
import { formatCurrency } from '../../utils/format';
import Modal from '../common/Modal';
import Button from '../common/Button';
import AddCategoryField from '../common/AddCategoryField';
import Input, { Toggle } from '../common/Input';
import { TransactionRow } from '../common/TransactionRow';
import {
  BudgetBar, BudgetFigures, RolloverNote, TONE_TEXT, describeMessage,
  allTxnsForCategory, useAccountLookup, importPlanGoals, pendingPlanGoals,
} from './budgetShared';

// ─────────────────────────────────────────────────────────────────────────────

function Section({ title, hint, children, action }: {
  title: string; hint?: string; children: React.ReactNode; action?: React.ReactNode;
}) {
  return (
    <section>
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">{title}</h3>
          {hint && <p className="text-[11px] text-zinc-500 dark:text-zinc-400 mt-0.5 leading-snug">{hint}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

/** A number field that commits on blur / Enter — never on every keystroke, so
 *  typing "1200" doesn't briefly persist a $1 budget. */
function AmountField({ value, onCommit, placeholder = '0', label }: {
  value: number | null; onCommit: (amount: number) => void; placeholder?: string; label?: string;
}) {
  return (
    <input
      type="number"
      inputMode="decimal"
      aria-label={label}
      defaultValue={value != null && value > 0 ? value : ''}
      key={value ?? 'empty'}
      onBlur={e => onCommit(parseFloat(e.target.value) || 0)}
      onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
      placeholder={placeholder}
      className="w-24 text-right text-sm bg-transparent border border-zinc-200 dark:border-zinc-800 rounded-[8px] px-2 py-1.5 tabular-nums focus:border-brand outline-none"
    />
  );
}

// ═════════════════════════════════════════════════════════════════════════════

export default function BudgetManager({ onClose, currency, view }: {
  onClose: () => void; currency: string; view: BudgetView;
}) {
  const subscriptions = useStore(s => s.subscriptions);
  const customCategories = useStore(s => s.customCategories);
  const userId = useStore(s => s.user?.id ?? null);
  const allCategories = useAllCategories();

  const [newCategory, setNewCategory] = useState('');
  const [newAmount, setNewAmount] = useState('');
  const [newRollover, setNewRollover] = useState(false);
  const [showRecurring, setShowRecurring] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [showManual, setShowManual] = useState(false);
  const [openTxnsFor, setOpenTxnsFor] = useState<string | null>(null);
  const [imported, setImported] = useState<number | null>(null);

  const overall = view.overall;
  const capped = view.categories;

  // Categories worth offering: everything pickable plus anything actually spent
  // in this month, minus what is already capped.
  const options = useMemo(
    () => budgetableCategories(
      allCategories,
      view.categories.reduce<Record<string, number>>(
        (acc, c) => { acc[c.name] = c.spent; return acc; },
        Object.fromEntries(view.unbudgeted.map(u => [u.name, u.spent])),
      ),
      capped.map(c => c.category ?? ''),
    ),
    [allCategories, view.categories, view.unbudgeted, capped],
  );

  const planGoals = useMemo(() => pendingPlanGoals(), [view]);

  const addBudget = () => {
    const name = newCategory.trim();
    const amount = parseFloat(newAmount) || 0;
    if (!name || amount <= 0) return;
    budgetsDS.setCategoryBudget(name, amount, { rollover: newRollover });
    setNewCategory('');
    setNewAmount('');
    setNewRollover(false);
  };

  const renameCategory = (from: string) => {
    const to = window.prompt(
      `Rename “${from}” to what?\n\nThis moves the budget, the category and ${customCategoriesDS.countTransactions(from)} loaded transaction(s).`,
      from,
    );
    if (!to || !to.trim()) return;
    // Rename onto an existing category's exact spelling where the new name is
    // deterministically the same thing ("groceries" → "Groceries"); a mere
    // resemblance is left as typed, because renaming is not the place to guess.
    const resolution = customCategoriesDS.resolve(to);
    const target = resolution.status === 'exact' || resolution.status === 'alias'
      ? resolution.canonical
      : tidyCategoryName(to);
    if (!target || sameCategory(target, from)) return;
    customCategoriesDS.rename(from, target);
  };

  const deleteCustomCategory = (id: string, name: string) => {
    const budget = budgetsDS.forCategory(name);
    const txns = customCategoriesDS.countTransactions(name);
    const warning = [
      `Delete the category “${name}”?`,
      budget ? '· its budget will be removed too' : null,
      txns > 0 ? `· ${txns} transaction(s) keep this category name` : null,
    ].filter(Boolean).join('\n');
    if (!window.confirm(warning)) return;
    if (budget) budgetsDS.remove(budget.id);
    customCategoriesDS.remove(id);
  };

  return (
    <Modal isOpen onClose={onClose} title="Budgets" size="lg">
      <div className="space-y-6">

        {/* ── Overall cap ─────────────────────────────────────────────────── */}
        <Section
          title="Overall monthly budget"
          hint="One cap across all spending, whatever the category. Optional."
        >
          <div className="rounded-[12px] border border-zinc-200 dark:border-zinc-800 px-3.5 py-3">
            <div className="flex items-center gap-3">
              <span className="text-sm flex-1 min-w-0">Cap all spending at</span>
              <AmountField
                label="Overall monthly budget"
                value={overall ? overall.baseLimit : null}
                onCommit={amount => budgetsDS.setOverallBudget(amount, { rollover: overall?.rollover })}
              />
            </div>
            {overall && (
              <>
                <div className="mt-2.5">
                  <BudgetBar bar={overall.bar} />
                  <p className={`mt-1.5 text-[11px] tabular-nums ${TONE_TEXT[overall.tone]}`}>
                    {formatCurrency(overall.spent, currency)} of {formatCurrency(overall.limit, currency)}
                    {' · '}{describeMessage(overall.message, currency)}
                  </p>
                </div>

                <div className="mt-3">
                  <BudgetFigures line={overall} currency={currency} />
                </div>

                {/* Rollover, with its own facts and nothing else's. */}
                <div className="mt-3 pt-2.5 border-t border-zinc-100 dark:border-zinc-800/60">
                  <div className="flex items-center justify-between gap-2">
                    <Toggle
                      size="sm"
                      checked={overall.rollover}
                      onChange={on => budgetsDS.setOverallBudget(overall.baseLimit, { rollover: on })}
                      label="Roll unspent (or overspent) into next month"
                    />
                    <button
                      onClick={() => overall.id && budgetsDS.remove(overall.id)}
                      className="text-[11px] text-[#ef4444] hover:underline flex-shrink-0 ml-2"
                    >Remove</button>
                  </div>
                  {overall.carry.enabled && (
                    <div className="mt-2 pl-1">
                      <RolloverNote line={overall} currency={currency} />
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </Section>

        {/* ── Category caps ───────────────────────────────────────────────── */}
        <Section
          title="Category budgets"
          hint="A monthly cap per category. Spend is the same figure Accounts shows — transfers, card repayments and refunds already handled."
          action={planGoals > 0 ? (
            <button
              onClick={() => setImported(importPlanGoals(userId))}
              className="text-xs text-brand hover:underline flex-shrink-0"
            >Import {planGoals} plan goal{planGoals === 1 ? '' : 's'}</button>
          ) : undefined}
        >
          {imported != null && (
            <p className="mb-2 text-[11px] text-brand">
              {imported > 0
                ? `Imported ${imported} goal${imported === 1 ? '' : 's'} from your old plan.`
                : 'Nothing left to import — every plan goal already has a budget.'}
            </p>
          )}

          <div className="space-y-1.5">
            {capped.length === 0 && (
              <p className="text-sm text-zinc-500 dark:text-zinc-400 py-2">
                No category budgets yet. Add one below.
              </p>
            )}

            {capped.map(line => {
              const name = line.category ?? line.name;
              const isOpen = openTxnsFor === line.key;
              return (
                <div key={line.key} className="rounded-[10px] border border-zinc-200 dark:border-zinc-800">
                  <div className="flex items-center gap-2 px-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span className="text-sm font-medium truncate">{name}</span>
                        {line.rollover && (
                          <span className="text-[10px] text-zinc-400 dark:text-zinc-500 flex-shrink-0" title="Rollover on">⟳</span>
                        )}
                      </div>
                      <p className={`text-[11px] mt-0.5 tabular-nums ${TONE_TEXT[line.tone]}`}>
                        {formatCurrency(line.spent, currency)} of {formatCurrency(line.limit, currency)}
                        {' · '}{describeMessage(line.message, currency)}
                      </p>
                    </div>
                    <AmountField
                      label={`${name} monthly budget`}
                      value={line.baseLimit}
                      onCommit={amount => budgetsDS.setCategoryBudget(name, amount, { rollover: line.rollover })}
                    />
                    <button
                      onClick={() => line.id && budgetsDS.remove(line.id)}
                      className="text-[#ef4444] hover:opacity-70 text-lg leading-none px-1 flex-shrink-0"
                      title={`Delete the ${name} budget`}
                      aria-label={`Delete the ${name} budget`}
                    >×</button>
                  </div>

                  {/* The four figures, spelled out — spend, what's left, and
                      where the month is projected to end, up or down. */}
                  <div className="px-3 pb-2.5">
                    <BudgetFigures line={line} currency={currency} />
                  </div>

                  {/* Rollover sits below its own divider and owns only the
                      carried amount and the cap that produces — the projection
                      above is a different statement entirely. */}
                  <div className="px-3 py-2 border-t border-zinc-100 dark:border-zinc-800/60">
                    <div className="flex items-center justify-between gap-2">
                      <Toggle
                        size="sm"
                        checked={line.rollover}
                        onChange={on => budgetsDS.setCategoryBudget(name, line.baseLimit, { rollover: on })}
                        label="Roll leftovers into next month"
                      />
                      <button
                        onClick={() => setOpenTxnsFor(isOpen ? null : line.key)}
                        className="text-[11px] text-zinc-500 dark:text-zinc-400 hover:text-brand transition-colors flex-shrink-0 ml-auto"
                      >
                        {isOpen ? 'Hide' : 'Transactions'} <span className={`inline-block transition-transform ${isOpen ? 'rotate-90' : ''}`}>›</span>
                      </button>
                    </div>
                    {line.carry.enabled && (
                      <div className="mt-2 pl-1">
                        <RolloverNote line={line} currency={currency} />
                      </div>
                    )}
                  </div>

                  {isOpen && <CategoryTransactions category={name} />}
                </div>
              );
            })}
          </div>

          {/* Add */}
          <div className="mt-3 rounded-[10px] border border-dashed border-zinc-200 dark:border-zinc-800 px-3 py-3">
            <div className="flex flex-col sm:flex-row sm:items-center gap-2">
              <select
                value={newCategory}
                onChange={e => setNewCategory(e.target.value)}
                aria-label="Category to budget"
                className="input appearance-none cursor-pointer flex-1 min-w-0"
              >
                <option value="">Choose a category…</option>
                {options.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  inputMode="decimal"
                  value={newAmount}
                  aria-label="Monthly amount"
                  onChange={e => setNewAmount(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') addBudget(); }}
                  placeholder="Monthly"
                  className="w-28 text-right text-sm bg-transparent border border-zinc-200 dark:border-zinc-800 rounded-[8px] px-2 py-2 tabular-nums focus:border-brand outline-none"
                />
                <Button variant="secondary" onClick={addBudget} disabled={!newCategory.trim() || !(parseFloat(newAmount) > 0)}>Add</Button>
              </div>
            </div>
            <div className="mt-2">
              <Toggle size="sm" checked={newRollover} onChange={setNewRollover} label="Roll leftovers into next month" />
            </div>
          </div>
        </Section>

        {/* ── Custom categories ───────────────────────────────────────────── */}
        <Section
          title="Your categories"
          hint="Categories you created. Renaming moves the budget and the transactions with it."
        >
          <div className="space-y-1.5">
            {customCategories.length === 0 && (
              <p className="text-sm text-zinc-500 dark:text-zinc-400">
                None yet — budgeting a category you type in creates one automatically.
              </p>
            )}
            {customCategories.map(c => (
              <div key={c.id} className="flex items-center gap-2 rounded-[8px] border border-zinc-200 dark:border-zinc-800 px-3 py-2">
                <span className="text-sm truncate flex-1">{c.name}</span>
                <button onClick={() => renameCategory(c.name)} className="text-[11px] text-brand hover:underline flex-shrink-0">Rename</button>
                <button
                  onClick={() => deleteCustomCategory(c.id, c.name)}
                  className="text-[#ef4444] hover:opacity-70 text-lg leading-none px-1 flex-shrink-0"
                  title={`Delete the ${c.name} category`}
                  aria-label={`Delete the ${c.name} category`}
                >×</button>
              </div>
            ))}
          </div>
          <NewCategoryRow />
        </Section>

        {/* ── Make sure spending lands in the right place ─────────────────── */}
        <Section
          title="Assign spending"
          hint="Budgets track whatever is filed under a category. File your recurring payments, re-file past transactions, or add cash spending."
        >
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <Button variant="secondary" onClick={() => setShowRecurring(true)}>Recurring payments</Button>
            <Button variant="secondary" onClick={() => setShowSearch(true)}>Search transactions</Button>
            <Button variant="secondary" onClick={() => setShowManual(true)} className="sm:col-span-2">+ Add cash / off-account spend</Button>
          </div>
        </Section>

        <div className="flex justify-end pt-1">
          <Button onClick={onClose}>Done</Button>
        </div>
      </div>

      {showRecurring && (
        <RecurringPicker
          onClose={() => setShowRecurring(false)}
          currency={currency}
          categories={allCategories}
          subscriptions={subscriptions}
        />
      )}
      {showSearch && (
        <TransactionSearch onClose={() => setShowSearch(false)} currency={currency} categories={allCategories} month={view.month} />
      )}
      {showManual && (
        <ManualEntry onClose={() => setShowManual(false)} currency={currency} categories={allCategories} />
      )}
    </Modal>
  );
}

/** Add a category without giving it a budget yet. */
function NewCategoryRow() {
  return <AddCategoryField />;
}

/** The transactions currently counting toward a category — re-file or delete. */
function CategoryTransactions({ category }: { category: string }) {
  const transactions = useStore(s => s.transactions);
  const splits = useStore(s => s.transactionSplits);
  const splitsByTx = useMemo(() => {
    const m = new Map<string, typeof splits>();
    for (const sp of splits) {
      const list = m.get(sp.transaction_id);
      if (list) list.push(sp); else m.set(sp.transaction_id, [sp]);
    }
    return m;
  }, [splits]);
  const txns = useMemo(
    () => allTxnsForCategory(transactions, category, splitsByTx),
    [transactions, category, splitsByTx],
  );

  if (txns.length === 0) {
    return (
      <p className="px-3.5 py-3 text-sm text-zinc-500 dark:text-zinc-400 border-t border-zinc-100 dark:border-zinc-800/60">
        Nothing is filed under this category yet.
      </p>
    );
  }
  return (
    <div className="border-t border-zinc-100 dark:border-zinc-800/60 px-1 py-1 max-h-72 overflow-y-auto divide-y divide-zinc-100 dark:divide-zinc-800/60">
      {txns.map(({ tx: t, splitAmount }) => (
        <TransactionRow
          key={t.id}
          tx={t}
          splitContext={splitAmount !== null ? { category, amount: splitAmount } : undefined}
          onCategoryChange={(id, cat, scope, splits) => { transactionsDS.applyCorrection(id, { category: cat }, scope, { splits }); }}
          onMerchantChange={(id, merchant, scope) => { transactionsDS.applyCorrection(id, { merchant }, scope); }}
          onEntityChange={(id, entity, scope) => {
            if (entity === null) transactionsDS.update(id, { entity: null });
            else transactionsDS.applyCorrection(id, { entity }, scope);
          }}
          onDelete={(id) => { transactionsDS.removeAndReverseBalance(id); }}
        />
      ))}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
//  Helpers that put spending into categories
// ═════════════════════════════════════════════════════════════════════════════

function freqPerYear(freq?: string | null): number {
  switch ((freq ?? '').toLowerCase()) {
    case 'daily': return 365;
    case 'weekly': return 52;
    case 'fortnightly': case 'biweekly': return 26;
    case 'monthly': return 12;
    case 'quarterly': return 4;
    case 'yearly': case 'annually': case 'annual': return 1;
    default: return 12;
  }
}

/** A recurring amount expressed per MONTH — the only period budgets use. */
function toMonthly(amount: number, freq: string | null | undefined): number {
  return (amount * freqPerYear(freq)) / 12;
}

interface RecurringRow {
  id: string; kind: 'bill' | 'sub'; name: string; amount: number; freq: string; category: string | null;
}

function RecurringPicker({ onClose, currency, categories, subscriptions }: {
  onClose: () => void; currency: string; categories: string[];
  subscriptions: { id: string; name: string; amount: number; display_amount?: number; frequency: string; category: string }[];
}) {
  const [tick, setTick] = useState(0);

  const rows: RecurringRow[] = useMemo(() => {
    // Subscriptions are canonical. Bills generated FROM a subscription carry
    // subscription_id and are skipped, so each payment appears once.
    const subs: RecurringRow[] = subscriptions.map(s => ({
      id: s.id, kind: 'sub' as const, name: s.name,
      amount: s.display_amount ?? s.amount, freq: s.frequency, category: s.category ?? null,
    }));
    const bills: RecurringRow[] = billsDS.getAll()
      .filter(b => b.is_recurring && !b.subscription_id)
      .map(b => ({ id: b.id, kind: 'bill' as const, name: b.name, amount: b.amount, freq: b.frequency ?? 'monthly', category: b.category ?? null }));
    const seen = new Set<string>();
    return [...subs, ...bills]
      .filter(r => { const k = r.name.trim().toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; })
      .sort((a, b) => a.name.localeCompare(b.name));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subscriptions, tick]);

  const assign = (row: RecurringRow, category: string) => {
    const cat = category || null;
    if (cat) customCategoriesDS.add(cat);
    if (row.kind === 'bill') billsDS.update(row.id, { category: cat });
    else subscriptionsDS.update(row.id, { category: cat ?? '' });
    setTick(n => n + 1);
  };

  return (
    <Modal isOpen onClose={onClose} title="Recurring payments" size="lg">
      <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-3">
        File each recurring payment under a category so its spend counts toward that budget.
      </p>
      <div className="space-y-2 max-h-[60vh] overflow-y-auto">
        {rows.length === 0 && (
          <p className="text-sm text-zinc-500 dark:text-zinc-400 py-3">
            No recurring payments found. Use “Search transactions” to file one.
          </p>
        )}
        {rows.map(row => (
          <div key={`${row.kind}-${row.id}`} className="flex flex-col sm:flex-row sm:items-center gap-2 rounded-[10px] border border-zinc-200 dark:border-zinc-800 px-3 py-2.5">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium truncate">{row.name}</p>
              <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
                {formatCurrency(row.amount, currency)} · {row.freq} · {formatCurrency(toMonthly(row.amount, row.freq), currency)}/month
              </p>
            </div>
            <select
              value={row.category ?? ''}
              onChange={e => assign(row, e.target.value)}
              aria-label={`Category for ${row.name}`}
              className="text-sm bg-transparent border border-zinc-200 dark:border-zinc-800 rounded-[6px] px-2 py-1.5 sm:max-w-[45%]"
            >
              <option value="">Unassigned</option>
              {categories.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
        ))}
      </div>
      <div className="flex justify-end mt-4">
        <Button onClick={onClose}>Done</Button>
      </div>
    </Modal>
  );
}

/** Re-file real transactions into budget categories. */
function TransactionSearch({ onClose, currency, categories, month }: {
  onClose: () => void; currency: string; categories: string[]; month: string;
}) {
  const transactions = useStore(s => s.transactions);
  const accountName = useAccountLookup();
  const [query, setQuery] = useState('');
  const [thisMonthOnly, setThisMonthOnly] = useState(true);

  const q = query.trim().toLowerCase();
  const rows = useMemo(() => transactions
    .filter(t => {
      if ((t.display_amount ?? t.amount ?? 0) >= 0) return false;      // outflow only
      if (thisMonthOnly && (t.date ?? '').slice(0, 7) !== month) return false;
      if (q && !(t.merchant || '').toLowerCase().includes(q)) return false;
      return true;
    })
    .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))
    .slice(0, 200),
    [transactions, q, thisMonthOnly, month]);

  const catSet = useMemo(() => new Set(categories.map(c => c.toLowerCase())), [categories]);
  const splits = useStore(s => s.transactionSplits);
  const splitsByTx = useMemo(() => {
    const m = new Map<string, typeof splits>();
    for (const sp of splits) {
      const list = m.get(sp.transaction_id);
      if (list) list.push(sp); else m.set(sp.transaction_id, [sp]);
    }
    return m;
  }, [splits]);

  return (
    <Modal isOpen onClose={onClose} title="Search transactions" size="lg">
      <div className="space-y-3">
        <Input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search a merchant…" autoFocus />
        <Toggle
          size="sm"
          checked={thisMonthOnly}
          onChange={setThisMonthOnly}
          label="Only this budget month"
        />
        <p className="text-[11px] text-zinc-400 dark:text-zinc-500">
          Re-filing a transaction moves it into that category's budget immediately.
        </p>

        <div className="space-y-1.5 max-h-[52vh] overflow-y-auto">
          {rows.length === 0 && (
            <p className="text-sm text-zinc-500 dark:text-zinc-400 py-3 text-center">No outgoings match.</p>
          )}
          {rows.map(t => {
            const current = (t.category && catSet.has(t.category.toLowerCase())) ? t.category : '';
            const filedAs = splitDisplay(t.category, splitsByTx.get(t.id) ?? []);
            return (
              <div key={t.id} className="flex items-center gap-2 rounded-[10px] border border-zinc-200 dark:border-zinc-800 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate">{t.merchant || 'Transaction'}</p>
                  <p className="text-[11px] text-zinc-500 dark:text-zinc-400 truncate">
                    {(t.date ?? '').slice(0, 10)} · {accountName(t.account_id)} · {formatCurrency(Math.abs(t.display_amount ?? t.amount ?? 0), currency)}
                  </p>
                </div>
                {/* A split transaction is already divided between budgets, and a
                    single dropdown has no way to ask what should happen to that
                    division. So it says where the money actually went and sends
                    the change to the one place equipped to ask — the split
                    editor on the transaction row itself. */}
                {filedAs.isSplit ? (
                  <span
                    className="text-[11px] text-zinc-500 dark:text-zinc-400 border border-dashed border-zinc-300 dark:border-zinc-700 rounded-[6px] px-2 py-1 max-w-[45%] truncate"
                    title={`Split across ${filedAs.categories.join(', ')} — change it from the transaction's own row`}
                  >
                    Split: {filedAs.categories.join(' + ')}
                  </span>
                ) : (
                <select
                  value={current}
                  onChange={e => {
                    if (e.target.value) customCategoriesDS.add(e.target.value);
                    transactionsDS.applyCorrection(t.id, { category: e.target.value }, 'only');
                  }}
                  aria-label={`Category for ${t.merchant || 'transaction'}`}
                  className={`text-sm bg-transparent border rounded-[6px] px-2 py-1 max-w-[45%] ${
                    current ? 'border-brand/50 text-brand' : 'border-zinc-200 dark:border-zinc-800 text-zinc-500 dark:text-zinc-400'
                  }`}
                >
                  <option value="">Unassigned</option>
                  {categories.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
                )}
              </div>
            );
          })}
        </div>
      </div>
      <div className="flex justify-end mt-4">
        <Button onClick={onClose}>Done</Button>
      </div>
    </Modal>
  );
}

/** A cash / off-account spend or recurring bill, so budgets see money that
 *  never touched a linked account. */
function ManualEntry({ onClose, currency, categories }: {
  onClose: () => void; currency: string; categories: string[];
}) {
  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');
  const [cat, setCat] = useState(categories[0] ?? BASE_TX_CATEGORIES[0]);
  const [recurring, setRecurring] = useState(false);

  const save = () => {
    const amt = parseFloat(amount) || 0;
    const clean = name.trim();
    if (!clean || amt <= 0 || !cat) return;
    customCategoriesDS.add(cat);
    const today = new Date().toISOString().slice(0, 10);
    if (recurring) {
      billsDS.add({
        name: clean, amount: amt, due_date: today, is_recurring: true,
        frequency: 'monthly', colour: 'grey', is_paid: false,
        calendar_synced: false, category: cat,
      });
    } else {
      // Manual entry, so allowDuplicate — ingestion still stamps source/raw/hash.
      transactionsDS.ingest({
        account_id: null as unknown as string, account_type: 'bank',
        date: today, merchant: clean, raw_description: clean, amount: -Math.abs(amt), currency,
        category: cat, category_source: 'user', is_duplicate_flagged: false, is_subscription: false,
        source: 'manual',
      }, { allowDuplicate: true });
    }
    onClose();
  };

  const valid = !!name.trim() && (parseFloat(amount) || 0) > 0 && !!cat;

  return (
    <Modal isOpen onClose={onClose} title="Add spending" size="md">
      <div className="space-y-3">
        <Input label="Name" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Market stall, Babysitter" autoFocus />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <Input label="Amount" type="number" value={amount} onChange={e => setAmount(e.target.value)} placeholder="0" />
          <div>
            <label className="label">Category</label>
            <select value={cat} onChange={e => setCat(e.target.value)} className="input appearance-none cursor-pointer">
              {categories.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
        </div>
        <Toggle checked={recurring} onChange={setRecurring} label="This repeats every month (a recurring bill)" />
        <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
          {recurring
            ? 'Added as a recurring bill under this category.'
            : 'Recorded as a one-off spend in this category this month.'}
        </p>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={save} disabled={!valid}>Add</Button>
        </div>
      </div>
    </Modal>
  );
}
