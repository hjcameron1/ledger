import { useMemo, useState } from 'react';
import { useStore } from '../../store';
import {
  budgetSettingsDS, budgetLinesDS, customCategoriesDS, billsDS,
} from '../../services/dataService';
import { formatCurrency } from '../../utils/format';
import { useAllCategories } from '../../utils/categories';
import Card from '../common/Card';
import Modal from '../common/Modal';
import Button from '../common/Button';
import Input, { Select } from '../common/Input';
import type { BudgetPeriod, BudgetIncomeBasis, BudgetLine } from '../../types';

// ── Period maths ─────────────────────────────────────────────────────────────
const PERIODS_PER_YEAR: Record<BudgetPeriod, number> = { weekly: 52, fortnightly: 26, monthly: 12 };
const PERIOD_DAYS: Record<BudgetPeriod, number> = { weekly: 7, fortnightly: 14, monthly: 30.44 };
const PERIOD_LABEL: Record<BudgetPeriod, string> = { weekly: 'week', fortnightly: 'fortnight', monthly: 'month' };

// How often a source item recurs, as occurrences per year, so any bill/sub
// frequency can be normalised onto the budget's period.
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

/** Convert an amount recurring at `freq` into the budget period's equivalent. */
function toPeriod(amount: number, freq: string | null | undefined, period: BudgetPeriod): number {
  return (amount * freqPerYear(freq)) / PERIODS_PER_YEAR[period];
}

// Start of the current tracking window: calendar month for monthly, trailing
// N days for the shorter periods.
function windowStart(period: BudgetPeriod): Date {
  const now = new Date();
  if (period === 'monthly') return new Date(now.getFullYear(), now.getMonth(), 1);
  const d = new Date(now);
  d.setDate(d.getDate() - (period === 'weekly' ? 7 : 14));
  return d;
}

// Split budget_lines into the two roles of the category-centric model.
function splitLines(lines: BudgetLine[]) {
  const categories = lines.filter(l => l.is_category_budget);
  const items = lines.filter(l => !l.is_category_budget);
  const itemsByCat: Record<string, BudgetLine[]> = {};
  for (const it of items) {
    const key = it.category ?? '';
    (itemsByCat[key] ??= []).push(it);
  }
  return { categories, items, itemsByCat };
}

export default function BudgetSection({ currency }: { currency: string }) {
  const settings = useStore(s => s.budgetSettings);
  const lines = useStore(s => s.budgetLines);
  const transactions = useStore(s => s.transactions);
  const incomeEntries = useStore(s => s.incomeEntries);
  const projectedAnnual = useStore(s => s.projectedAnnual);

  const [builderOpen, setBuilderOpen] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const period: BudgetPeriod = settings?.period ?? 'monthly';
  const { categories, itemsByCat } = useMemo(() => splitLines(lines), [lines]);

  // Per-period income, derived from the chosen basis.
  const income = useMemo(() => {
    if (!settings) return 0;
    if (settings.income_basis === 'manual') return settings.income_amount || 0;
    if (settings.income_basis === 'projected') return projectedAnnual / PERIODS_PER_YEAR[period];
    const since = new Date(); since.setDate(since.getDate() - 90);
    const recent = incomeEntries.filter(e => new Date(e.date) >= since);
    const total = recent.reduce((sum, e) => sum + (e.display_amount ?? e.amount ?? 0), 0);
    return (total / 90) * PERIOD_DAYS[period];
  }, [settings, projectedAnnual, incomeEntries, period]);

  // Actual spend per category for the current window.
  const spendByCategory = useMemo(() => {
    const start = windowStart(period);
    const map: Record<string, number> = {};
    for (const t of transactions) {
      if (!t.category) continue;
      if (new Date(t.date) < start) continue;
      map[t.category] = (map[t.category] ?? 0) + Math.abs(t.display_amount ?? t.amount ?? 0);
    }
    return map;
  }, [transactions, period]);

  const totalBudgeted = categories.reduce((sum, c) => sum + (c.amount || 0), 0);
  const remaining = income - totalBudgeted;

  // ── Empty state ──
  if (!settings) {
    return (
      <>
        <Card padding="none" className="p-5">
          <div className="flex items-center justify-between mb-1">
            <h2 className="text-base font-semibold">Budget</h2>
          </div>
          <p className="text-sm text-[#6b6b6b] dark:text-[#a0a0a0] mb-4">
            Plan your spending by category — set a budget for each, then fill in the bills,
            recurring payments and expenses that go under it.
          </p>
          <button
            onClick={() => setBuilderOpen(true)}
            className="w-full py-3 border border-dashed border-[#e5e5e5] dark:border-[#2a2a2a] rounded-[12px] text-sm text-[#6b6b6b] dark:text-[#a0a0a0] hover:border-[#3b7dd8]/40 hover:text-[#3b7dd8] transition-all"
          >
            + Set up your budget
          </button>
        </Card>
        {builderOpen && <BudgetBuilder onClose={() => setBuilderOpen(false)} currency={currency} />}
      </>
    );
  }

  const toggle = (id: string) =>
    setExpanded(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  return (
    <>
      <Card padding="none" className="p-5">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-base font-semibold">Budget</h2>
          <button onClick={() => setBuilderOpen(true)} className="text-xs text-[#3b7dd8] hover:underline">Edit</button>
        </div>

        {/* Summary row */}
        <div className="grid grid-cols-3 gap-2 mb-4">
          <Summary label={`Income / ${PERIOD_LABEL[period]}`} value={formatCurrency(income, currency)} />
          <Summary label="Budgeted" value={formatCurrency(totalBudgeted, currency)} />
          <Summary
            label="Left to budget"
            value={formatCurrency(remaining, currency)}
            tone={remaining < 0 ? 'bad' : 'good'}
          />
        </div>

        {/* Category cards */}
        <div className="space-y-2.5">
          {categories.length === 0 && (
            <p className="text-sm text-[#6b6b6b] dark:text-[#a0a0a0] text-center py-3">
              No categories yet — tap Edit to add some.
            </p>
          )}
          {categories.map(cat => {
            const items = itemsByCat[cat.name] ?? [];
            const actual = spendByCategory[cat.name] ?? 0;
            const cap = cat.amount || 0;
            const pct = cap > 0 ? Math.min(100, (actual / cap) * 100) : 0;
            const over = actual > cap && cap > 0;
            const isOpen = expanded.has(cat.id);
            return (
              <div key={cat.id} className="rounded-[10px] border border-[#e5e5e5] dark:border-[#2a2a2a] px-3 py-2.5">
                <button
                  onClick={() => items.length && toggle(cat.id)}
                  className={`w-full text-left ${items.length ? '' : 'cursor-default'}`}
                >
                  <div className="flex items-center justify-between text-sm mb-1.5">
                    <span className="font-medium truncate flex items-center gap-1.5">
                      {items.length > 0 && (
                        <span className={`text-[10px] text-[#9b9b9b] transition-transform ${isOpen ? 'rotate-90' : ''}`}>▶</span>
                      )}
                      {cat.name}
                    </span>
                    <span className={`text-xs flex-shrink-0 ml-2 ${over ? 'text-[#ef4444]' : 'text-[#6b6b6b] dark:text-[#a0a0a0]'}`}>
                      {formatCurrency(actual, currency)} / {formatCurrency(cap, currency)}
                    </span>
                  </div>
                  <div className="h-1.5 rounded-full bg-[#e5e5e5] dark:bg-[#2a2a2a] overflow-hidden">
                    <div className={`h-full rounded-full ${over ? 'bg-[#ef4444]' : 'bg-[#3b7dd8]'}`} style={{ width: `${pct}%` }} />
                  </div>
                </button>
                {isOpen && items.length > 0 && (
                  <div className="mt-2 pl-3 space-y-1 border-l border-[#e5e5e5] dark:border-[#2a2a2a]">
                    {items.map(it => (
                      <div key={it.id} className="flex items-center justify-between text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">
                        <span className="truncate">{it.name}</span>
                        <span className="flex-shrink-0 ml-2">{formatCurrency(it.amount, currency)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </Card>

      {builderOpen && <BudgetBuilder onClose={() => setBuilderOpen(false)} currency={currency} />}
    </>
  );
}

function Summary({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'bad' }) {
  const color = tone === 'bad' ? 'text-[#ef4444]' : tone === 'good' ? 'text-[#22c55e]' : '';
  return (
    <div className="rounded-[10px] bg-[#f5f5f5] dark:bg-[#1f1f1f] px-3 py-2">
      <p className="text-[10px] uppercase tracking-wide text-[#6b6b6b] dark:text-[#a0a0a0]">{label}</p>
      <p className={`text-sm font-semibold mt-0.5 ${color}`}>{value}</p>
    </div>
  );
}

// ── Collapsible section used for the import panels ───────────────────────────
function Collapsible({ title, count, children }: { title: string; count?: number; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-[10px] border border-[#e5e5e5] dark:border-[#2a2a2a]">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-3 py-2.5 text-sm font-medium"
      >
        <span className="flex items-center gap-2">
          <span className={`text-[10px] text-[#9b9b9b] transition-transform ${open ? 'rotate-90' : ''}`}>▶</span>
          {title}
          {count != null && count > 0 && (
            <span className="text-[11px] text-[#6b6b6b] dark:text-[#a0a0a0]">({count})</span>
          )}
        </span>
      </button>
      {open && <div className="px-3 pb-3">{children}</div>}
    </div>
  );
}

// ── Builder modal ────────────────────────────────────────────────────────────
function BudgetBuilder({ onClose, currency }: { onClose: () => void; currency: string }) {
  const settings = useStore(s => s.budgetSettings);
  const lines = useStore(s => s.budgetLines);
  const subscriptions = useStore(s => s.subscriptions);
  const transactions = useStore(s => s.transactions);
  const projectedAnnual = useStore(s => s.projectedAnnual);
  const incomeEntries = useStore(s => s.incomeEntries);
  const allCategories = useAllCategories();

  const [period, setPeriod] = useState<BudgetPeriod>(settings?.period ?? 'monthly');
  const [basis, setBasis] = useState<BudgetIncomeBasis>(settings?.income_basis ?? 'projected');
  const [manualIncome, setManualIncome] = useState(String(settings?.income_amount ?? ''));

  const [newCategory, setNewCategory] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // Per-category "add item" draft state, keyed by category name.
  const [itemDraft, setItemDraft] = useState<Record<string, { name: string; amount: string }>>({});

  const { categories, itemsByCat } = useMemo(() => splitLines(lines), [lines]);

  const derivedIncome = useMemo(() => {
    if (basis === 'manual') return parseFloat(manualIncome) || 0;
    if (basis === 'projected') return projectedAnnual / PERIODS_PER_YEAR[period];
    const since = new Date(); since.setDate(since.getDate() - 90);
    const recent = incomeEntries.filter(e => new Date(e.date) >= since);
    const total = recent.reduce((sum, e) => sum + (e.display_amount ?? e.amount ?? 0), 0);
    return (total / 90) * PERIOD_DAYS[period];
  }, [basis, manualIncome, projectedAnnual, incomeEntries, period]);

  const totalBudgeted = categories.reduce((sum, c) => sum + (c.amount || 0), 0);
  const leftToBudget = (basis === 'manual' ? parseFloat(manualIncome) || 0 : derivedIncome) - totalBudgeted;

  const saveSettings = (patch: Partial<{ period: BudgetPeriod; income_basis: BudgetIncomeBasis; income_amount: number }>) => {
    budgetSettingsDS.save({
      period, income_basis: basis, income_amount: parseFloat(manualIncome) || 0, ...patch,
    });
  };

  // Find an existing category row by name (case-insensitive), creating one (cap 0) if absent.
  const ensureCategory = (name: string): BudgetLine => {
    const existing = budgetLinesDS.getAll().find(l => l.is_category_budget && l.name.toLowerCase() === name.toLowerCase());
    if (existing) return existing;
    customCategoriesDS.add(name); // also surface it on transactions
    return budgetLinesDS.add({
      type: 'expense', name, category: name, amount: 0,
      source: 'manual', source_ref_id: null, is_category_budget: true,
    });
  };

  const addCategory = () => {
    const name = newCategory.trim();
    if (!name) return;
    ensureCategory(name);
    setNewCategory('');
  };

  const removeCategory = (cat: BudgetLine) => {
    // Remove the category and any items beneath it.
    for (const it of itemsByCat[cat.name] ?? []) budgetLinesDS.remove(it.id);
    budgetLinesDS.remove(cat.id);
  };

  const addItem = (catName: string) => {
    const draft = itemDraft[catName];
    if (!draft?.name.trim()) return;
    budgetLinesDS.add({
      type: 'expense', name: draft.name.trim(), category: catName,
      amount: parseFloat(draft.amount) || 0, source: 'manual', source_ref_id: null,
      is_category_budget: false,
    });
    setItemDraft(d => ({ ...d, [catName]: { name: '', amount: '' } }));
  };

  const toggle = (id: string) =>
    setExpanded(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  // Already-imported source ids, so we don't offer the same bill/sub/txn twice.
  const importedRefs = new Set(lines.map(l => l.source_ref_id).filter(Boolean));

  // Import a single source row as an item under its category (auto-creating the category).
  const importItem = (opts: {
    name: string; amount: number; category: string;
    source: BudgetLine['source']; source_ref_id: string;
  }) => {
    const cat = ensureCategory(opts.category || 'Other');
    budgetLinesDS.add({
      type: opts.source === 'recurring' ? 'recurring' : opts.source === 'bill' ? 'bill' : 'expense',
      name: opts.name, category: cat.name, amount: opts.amount,
      source: opts.source, source_ref_id: opts.source_ref_id, is_category_budget: false,
    });
  };

  const bills = billsDS.getAll().filter(b => !importedRefs.has(b.id));
  const subs = subscriptions.filter(s => !importedRefs.has(s.id));
  const recentTxns = useMemo(() => {
    const since = new Date(); since.setDate(since.getDate() - 60);
    return transactions
      .filter(t => new Date(t.date) >= since && (t.display_amount ?? t.amount ?? 0) < 0 && !importedRefs.has(t.id))
      .slice(0, 40);
  }, [transactions, lines]);

  return (
    <Modal isOpen onClose={onClose} title="Budget" size="lg">
      <div className="space-y-5">
        {/* Period + income basis */}
        <div className="grid grid-cols-2 gap-3">
          <Select
            label="Budget period"
            value={period}
            onChange={e => { const p = e.target.value as BudgetPeriod; setPeriod(p); saveSettings({ period: p }); }}
            options={[
              { value: 'weekly', label: 'Weekly' },
              { value: 'fortnightly', label: 'Fortnightly' },
              { value: 'monthly', label: 'Monthly' },
            ]}
          />
          <Select
            label="Income basis"
            value={basis}
            onChange={e => { const b = e.target.value as BudgetIncomeBasis; setBasis(b); saveSettings({ income_basis: b }); }}
            options={[
              { value: 'projected', label: 'Projected (from income)' },
              { value: 'manual', label: 'Enter manually' },
              { value: 'average', label: 'Average of actual pays' },
            ]}
          />
        </div>

        {basis === 'manual' ? (
          <Input
            label={`Income per ${PERIOD_LABEL[period]}`}
            type="number"
            value={manualIncome}
            onChange={e => setManualIncome(e.target.value)}
            onBlur={() => saveSettings({ income_amount: parseFloat(manualIncome) || 0 })}
            placeholder="e.g. 2000"
          />
        ) : (
          <p className="text-sm text-[#6b6b6b] dark:text-[#a0a0a0]">
            Estimated income: <span className="font-semibold text-[#0f0f0f] dark:text-white">{formatCurrency(derivedIncome, currency)}</span> per {PERIOD_LABEL[period]}
          </p>
        )}

        {/* Leftover banner */}
        <div className="flex items-center justify-between rounded-[10px] bg-[#f5f5f5] dark:bg-[#1f1f1f] px-3 py-2.5 text-sm">
          <span className="text-[#6b6b6b] dark:text-[#a0a0a0]">Left to budget</span>
          <span className={`font-semibold ${leftToBudget < 0 ? 'text-[#ef4444]' : 'text-[#22c55e]'}`}>
            {formatCurrency(leftToBudget, currency)}
          </span>
        </div>

        {/* Categories */}
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-[#6b6b6b] dark:text-[#a0a0a0] mb-2">Categories</h3>
          <div className="space-y-1.5 max-h-[280px] overflow-y-auto">
            {categories.length === 0 && (
              <p className="text-sm text-[#6b6b6b] dark:text-[#a0a0a0] py-2">No categories yet — add one below.</p>
            )}
            {categories.map(cat => {
              const items = itemsByCat[cat.name] ?? [];
              const isOpen = expanded.has(cat.id);
              const draft = itemDraft[cat.name] ?? { name: '', amount: '' };
              return (
                <div key={cat.id} className="rounded-[8px] border border-[#e5e5e5] dark:border-[#2a2a2a]">
                  <div className="flex items-center gap-2 px-3 py-2">
                    <button onClick={() => toggle(cat.id)} className="flex items-center gap-1.5 min-w-0 flex-1 text-left">
                      <span className={`text-[10px] text-[#9b9b9b] transition-transform ${isOpen ? 'rotate-90' : ''}`}>▶</span>
                      <span className="text-sm font-medium truncate">{cat.name}</span>
                      {items.length > 0 && <span className="text-[11px] text-[#6b6b6b] dark:text-[#a0a0a0]">({items.length})</span>}
                    </button>
                    <input
                      type="number"
                      defaultValue={cat.amount}
                      onBlur={e => budgetLinesDS.update(cat.id, { amount: parseFloat(e.target.value) || 0 })}
                      className="w-24 text-right text-sm bg-transparent border border-[#e5e5e5] dark:border-[#2a2a2a] rounded-[6px] px-2 py-1"
                      placeholder="Budget"
                    />
                    <button onClick={() => removeCategory(cat)} className="text-[#ef4444] hover:opacity-70 text-lg leading-none px-1" title="Remove category">×</button>
                  </div>
                  {isOpen && (
                    <div className="px-3 pb-3 pt-1 border-t border-[#e5e5e5] dark:border-[#2a2a2a] space-y-1.5">
                      {items.map(it => (
                        <div key={it.id} className="flex items-center gap-2">
                          <span className="text-sm min-w-0 flex-1 truncate">{it.name}</span>
                          <input
                            type="number"
                            defaultValue={it.amount}
                            onBlur={e => budgetLinesDS.update(it.id, { amount: parseFloat(e.target.value) || 0 })}
                            className="w-20 text-right text-sm bg-transparent border border-[#e5e5e5] dark:border-[#2a2a2a] rounded-[6px] px-2 py-1"
                          />
                          <button onClick={() => budgetLinesDS.remove(it.id)} className="text-[#ef4444] hover:opacity-70 text-base leading-none px-1" title="Remove item">×</button>
                        </div>
                      ))}
                      {/* Add item to this category */}
                      <div className="flex items-center gap-2 pt-1">
                        <input
                          value={draft.name}
                          onChange={e => setItemDraft(d => ({ ...d, [cat.name]: { ...draft, name: e.target.value } }))}
                          placeholder="Add an item…"
                          className="text-sm min-w-0 flex-1 bg-transparent border border-[#e5e5e5] dark:border-[#2a2a2a] rounded-[6px] px-2 py-1"
                        />
                        <input
                          type="number"
                          value={draft.amount}
                          onChange={e => setItemDraft(d => ({ ...d, [cat.name]: { ...draft, amount: e.target.value } }))}
                          placeholder="0"
                          className="w-20 text-right text-sm bg-transparent border border-[#e5e5e5] dark:border-[#2a2a2a] rounded-[6px] px-2 py-1"
                        />
                        <Button variant="secondary" onClick={() => addItem(cat.name)} disabled={!draft.name.trim()}>Add</Button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          {/* Add category */}
          <div className="flex items-end gap-2 mt-2">
            <div className="flex-1">
              <Input label="New category" value={newCategory} onChange={e => setNewCategory(e.target.value)} placeholder="e.g. Fun, Health, Groceries" />
            </div>
            <Button variant="secondary" onClick={addCategory} disabled={!newCategory.trim()}>Add</Button>
          </div>
        </div>

        {/* Imports — each its own collapsible section */}
        <div className="space-y-2">
          <Collapsible title="Import bills" count={bills.length}>
            <ImportList
              rows={bills.map(b => ({
                id: b.id, name: b.name, defaultCategory: b.category ?? 'Bills',
                amount: toPeriod(b.amount, b.is_recurring ? b.frequency : 'monthly', period),
                source: 'bill' as const,
              }))}
              categories={allCategories}
              currency={currency}
              period={period}
              onImport={importItem}
            />
          </Collapsible>
          <Collapsible title="Import recurring payments" count={subs.length}>
            <ImportList
              rows={subs.map(s => ({
                id: s.id, name: s.name, defaultCategory: s.category ?? 'Other',
                amount: toPeriod(s.display_amount ?? s.amount, s.frequency, period),
                source: 'recurring' as const,
              }))}
              categories={allCategories}
              currency={currency}
              period={period}
              onImport={importItem}
            />
          </Collapsible>
          <Collapsible title="Import expenses" count={recentTxns.length}>
            <ImportList
              rows={recentTxns.map(t => ({
                id: t.id, name: t.merchant || t.category || 'Expense',
                defaultCategory: t.category ?? 'Other',
                amount: Math.abs(t.display_amount ?? t.amount ?? 0),
                source: 'bank' as const,
              }))}
              categories={allCategories}
              currency={currency}
              period={period}
              onImport={importItem}
            />
          </Collapsible>
        </div>

        <div className="flex justify-end">
          <Button onClick={onClose}>Done</Button>
        </div>
      </div>
    </Modal>
  );
}

// A list of importable source rows, each with a category picker and Add button.
function ImportList({ rows, categories, currency, period, onImport }: {
  rows: { id: string; name: string; defaultCategory: string; amount: number; source: BudgetLine['source'] }[];
  categories: string[];
  currency: string;
  period: BudgetPeriod;
  onImport: (opts: { name: string; amount: number; category: string; source: BudgetLine['source']; source_ref_id: string }) => void;
}) {
  const [picks, setPicks] = useState<Record<string, string>>({});
  if (rows.length === 0) {
    return <p className="text-sm text-[#6b6b6b] dark:text-[#a0a0a0] py-1">Nothing left to import.</p>;
  }
  return (
    <div className="space-y-1.5 max-h-[220px] overflow-y-auto pt-1">
      {rows.map(r => {
        const cat = picks[r.id] ?? r.defaultCategory;
        const opts = categories.includes(cat) ? categories : [cat, ...categories];
        return (
          <div key={r.id} className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <p className="text-sm truncate">{r.name}</p>
              <p className="text-[11px] text-[#6b6b6b] dark:text-[#a0a0a0]">{formatCurrency(r.amount, currency)} / {PERIOD_LABEL[period]}</p>
            </div>
            <select
              value={cat}
              onChange={e => setPicks(p => ({ ...p, [r.id]: e.target.value }))}
              className="text-xs bg-transparent border border-[#e5e5e5] dark:border-[#2a2a2a] rounded-[6px] px-1.5 py-1 max-w-[110px]"
            >
              {opts.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <Button
              variant="secondary"
              onClick={() => onImport({ name: r.name, amount: r.amount, category: cat, source: r.source, source_ref_id: r.id })}
            >
              Add
            </Button>
          </div>
        );
      })}
    </div>
  );
}
