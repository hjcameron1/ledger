import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../../store';
import {
  budgetSettingsDS, budgetLinesDS, customCategoriesDS, billsDS,
} from '../../services/dataService';
import { payrollApi } from '../../services/api';
import { onTrackAnnualFromPayslips, type PayslipCore } from '../../utils/payroll';
import { formatCurrency } from '../../utils/format';
import { useAllCategories } from '../../utils/categories';
import Card from '../common/Card';
import Modal from '../common/Modal';
import Button from '../common/Button';
import Input, { Select } from '../common/Input';
import type { BudgetPeriod, BudgetIncomeBasis, BudgetLine } from '../../types';

// ─────────────────────────────────────────────────────────────────────────────
//  Budget — single-level, zero-based.
//
//  A budget is just a list of categories, each with a planned amount for the
//  chosen period. Real spending is tracked automatically from transactions.
//  Recurring bills & subscriptions are folded into the planned amounts at
//  setup time (Auto-build) rather than living as a separate list. This mirrors
//  how Monarch / Copilot / EveryDollar work and removes the nested "items"
//  model that caused the earlier orphan/import bugs.
//
//  Storage: we reuse `budget_lines`, but only ever use category rows
//  (is_category_budget = true). A one-time migration flattens any legacy
//  two-level data into clean category rows.
// ─────────────────────────────────────────────────────────────────────────────

// ── Period maths ─────────────────────────────────────────────────────────────
const PERIODS_PER_YEAR: Record<BudgetPeriod, number> = { weekly: 52, fortnightly: 26, monthly: 12 };
const PERIOD_DAYS: Record<BudgetPeriod, number> = { weekly: 7, fortnightly: 14, monthly: 30.44 };
const PERIOD_LABEL: Record<BudgetPeriod, string> = { weekly: 'week', fortnightly: 'fortnight', monthly: 'month' };

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

// ── Income ───────────────────────────────────────────────────────────────────
// Payslips aren't in the global store, so fetch them on demand. Lets the
// "projected" basis match the Income page's headline figure.
function usePayslips(): PayslipCore[] {
  const [payslips, setPayslips] = useState<PayslipCore[]>([]);
  useEffect(() => {
    payrollApi.getAll()
      .then(d => setPayslips((d.payslips ?? []) as PayslipCore[]))
      .catch(() => { /* best-effort */ });
  }, []);
  return payslips;
}

function resolveIncome(
  basis: BudgetIncomeBasis, period: BudgetPeriod,
  ctx: { manualIncome: number; payslips: PayslipCore[]; projectedAnnual: number; incomeEntries: { date: string; amount?: number; display_amount?: number }[] },
): number {
  if (basis === 'manual') return ctx.manualIncome || 0;
  if (basis === 'projected') {
    const fromPayslips = onTrackAnnualFromPayslips(ctx.payslips, true);
    const annual = fromPayslips > 0 ? fromPayslips : ctx.projectedAnnual;
    return annual / PERIODS_PER_YEAR[period];
  }
  // average of actual pays over the last 90 days
  const since = new Date(); since.setDate(since.getDate() - 90);
  const recent = ctx.incomeEntries.filter(e => new Date(e.date) >= since);
  const total = recent.reduce((sum, e) => sum + (e.display_amount ?? e.amount ?? 0), 0);
  return (total / 90) * PERIOD_DAYS[period];
}

// ── Category helpers ─────────────────────────────────────────────────────────
const round = (n: number) => Math.round(n);

/** All budget categories (single-level model). */
function categoriesOf(lines: BudgetLine[]): BudgetLine[] {
  return lines.filter(l => l.is_category_budget);
}

/** Find or create a category row by name (case-insensitive). */
function ensureCategory(name: string, amount = 0): BudgetLine {
  const clean = name.trim() || 'Other';
  const existing = budgetLinesDS.getAll().find(
    l => l.is_category_budget && l.name.toLowerCase() === clean.toLowerCase(),
  );
  if (existing) return existing;
  customCategoriesDS.add(clean);
  return budgetLinesDS.add({
    type: 'expense', name: clean, category: clean, amount,
    source: 'manual', source_ref_id: null, is_category_budget: true,
  });
}

// ── One-time migration from the legacy two-level model ───────────────────────
// Old data had item rows (is_category_budget = false) carrying amounts, plus
// category rows with caps. Flatten: each category's planned amount becomes the
// greater of its existing cap and the sum of its items; then drop the items.
const MIGRATION_FLAG = 'budget_v2_migrated';
function migrateLegacyOnce(): void {
  try {
    if (localStorage.getItem(MIGRATION_FLAG)) return;
  } catch { /* ignore */ }

  const all = budgetLinesDS.getAll();
  const items = all.filter(l => !l.is_category_budget);

  if (items.length > 0) {
    // Sum item amounts by their category name.
    const sumByCat: Record<string, number> = {};
    for (const it of items) {
      const key = (it.category?.trim() || 'Other');
      sumByCat[key] = (sumByCat[key] ?? 0) + (it.amount || 0);
    }
    // Ensure a category exists for each, bumping its planned amount if the
    // folded-in items exceed the current cap.
    for (const [name, sum] of Object.entries(sumByCat)) {
      const cat = ensureCategory(name);
      if (sum > (cat.amount || 0)) budgetLinesDS.update(cat.id, { amount: round(sum) });
    }
    // Remove the now-redundant item rows.
    for (const it of items) budgetLinesDS.remove(it.id);
  }

  try { localStorage.setItem(MIGRATION_FLAG, '1'); } catch { /* ignore */ }
}

// ── Auto-build suggestions ───────────────────────────────────────────────────
// Propose a starting planned amount per category from (a) average actual spend
// over the last 90 days and (b) recurring commitments (recurring bills + subs).
// We take the max of the two so a category isn't under-funded, and avoid double
// counting when a bill already shows up as a transaction.
interface Suggestion { category: string; suggested: number; spend: number; recurring: number }

function buildSuggestions(
  period: BudgetPeriod,
  ctx: {
    transactions: { date: string; category?: string | null; display_amount?: number; amount?: number }[];
    bills: { amount: number; frequency?: string; is_recurring: boolean; category?: string | null }[];
    subs: { display_amount?: number; amount: number; frequency: string; category?: string | null }[];
  },
): Suggestion[] {
  const map: Record<string, { spend: number; recurring: number }> = {};
  const bump = (cat: string, key: 'spend' | 'recurring', v: number) => {
    const name = (cat || 'Other').trim() || 'Other';
    (map[name] ??= { spend: 0, recurring: 0 })[key] += v;
  };

  // Average actual spend per period over the last 90 days.
  const since = new Date(); since.setDate(since.getDate() - 90);
  const periodsIn90 = 90 / PERIOD_DAYS[period];
  for (const t of ctx.transactions) {
    if (!t.category) continue;
    if (new Date(t.date) < since) continue;
    const amt = t.display_amount ?? t.amount ?? 0;
    if (amt >= 0) continue; // outflow only
    bump(t.category, 'spend', Math.abs(amt) / periodsIn90);
  }

  // Recurring commitments → per-period equivalent.
  for (const b of ctx.bills) {
    if (!b.is_recurring) continue;
    bump(b.category ?? 'Bills', 'recurring', toPeriod(b.amount, b.frequency, period));
  }
  for (const s of ctx.subs) {
    bump(s.category ?? 'Subscriptions', 'recurring', toPeriod(s.display_amount ?? s.amount, s.frequency, period));
  }

  return Object.entries(map)
    .map(([category, v]) => ({ category, spend: v.spend, recurring: v.recurring, suggested: round(Math.max(v.spend, v.recurring)) }))
    .filter(s => s.suggested > 0)
    .sort((a, b) => b.suggested - a.suggested);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Card (Overview)
// ─────────────────────────────────────────────────────────────────────────────
export default function BudgetSection({ currency }: { currency: string }) {
  const settings = useStore(s => s.budgetSettings);
  const lines = useStore(s => s.budgetLines);
  const transactions = useStore(s => s.transactions);
  const incomeEntries = useStore(s => s.incomeEntries);
  const projectedAnnual = useStore(s => s.projectedAnnual);

  const [builderOpen, setBuilderOpen] = useState(false);
  const payslips = usePayslips();

  // Flatten any legacy two-level data once, up front.
  useEffect(() => { migrateLegacyOnce(); }, []);

  const period: BudgetPeriod = settings?.period ?? 'monthly';
  const categories = useMemo(() => categoriesOf(lines), [lines]);

  const income = useMemo(() => {
    if (!settings) return 0;
    return resolveIncome(settings.income_basis, period, {
      manualIncome: settings.income_amount || 0, payslips, projectedAnnual, incomeEntries,
    });
  }, [settings, projectedAnnual, incomeEntries, payslips, period]);

  // Actual spend per category for the current window.
  const spendByCategory = useMemo(() => {
    const start = windowStart(period);
    const map: Record<string, number> = {};
    for (const t of transactions) {
      if (!t.category) continue;
      if (new Date(t.date) < start) continue;
      const amt = t.display_amount ?? t.amount ?? 0;
      if (amt >= 0) continue;
      map[t.category] = (map[t.category] ?? 0) + Math.abs(amt);
    }
    return map;
  }, [transactions, period]);

  const totalPlanned = categories.reduce((sum, c) => sum + (c.amount || 0), 0);
  const totalSpent = categories.reduce((sum, c) => sum + (spendByCategory[c.name] ?? 0), 0);
  // "Left to spend" is grounded in INCOME — what's actually left of your pay this
  // period after what you've already spent — not merely the sum of category caps.
  const leftToSpend = income - totalSpent;

  // ── Empty state ──
  if (!settings || categories.length === 0) {
    return (
      <>
        <Card padding="none" className="p-5">
          <div className="flex items-center justify-between mb-1">
            <h2 className="text-base font-semibold">Budget</h2>
          </div>
          <p className="text-sm text-[#6b6b6b] dark:text-[#a0a0a0] mb-4">
            Give every dollar a job. Set a plan for each category and we'll track your spending
            against it — your recurring bills and subscriptions are folded in automatically.
          </p>
          <button
            onClick={() => setBuilderOpen(true)}
            className="w-full py-3 border border-dashed border-[#e5e5e5] dark:border-[#2a2a2a] rounded-[12px] text-sm text-[#6b6b6b] dark:text-[#a0a0a0] hover:border-[#3b7dd8]/40 hover:text-[#3b7dd8] transition-all"
          >
            + Set up your budget
          </button>
        </Card>
        {builderOpen && <BudgetBuilder onClose={() => setBuilderOpen(false)} currency={currency} payslips={payslips} />}
      </>
    );
  }

  const overallPct = income > 0 ? Math.min(100, (totalSpent / income) * 100) : 0;
  const overBudget = income > 0 && totalSpent > income;

  return (
    <>
      <Card padding="none" className="p-5">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-base font-semibold">Budget</h2>
          <button onClick={() => setBuilderOpen(true)} className="text-xs text-[#3b7dd8] hover:underline">Adjust</button>
        </div>

        {/* Hero: left to spend this period */}
        <div className="rounded-[12px] bg-[#f5f5f5] dark:bg-[#1f1f1f] px-4 py-3.5 mb-4">
          <p className="text-[11px] uppercase tracking-wide text-[#6b6b6b] dark:text-[#a0a0a0]">
            Left to spend this {PERIOD_LABEL[period]}
          </p>
          <p className={`text-2xl font-bold mt-0.5 ${overBudget ? 'text-[#ef4444]' : 'text-[#0f0f0f] dark:text-white'}`}>
            {formatCurrency(leftToSpend, currency)}
          </p>
          <div className="mt-2.5 h-2 rounded-full bg-[#e5e5e5] dark:bg-[#2a2a2a] overflow-hidden">
            <div className={`h-full rounded-full ${overBudget ? 'bg-[#ef4444]' : 'bg-[#3b7dd8]'}`} style={{ width: `${overallPct}%` }} />
          </div>
          <div className="flex items-center justify-between mt-1.5 text-[11px] text-[#6b6b6b] dark:text-[#a0a0a0]">
            <span>{formatCurrency(totalSpent, currency)} spent</span>
            <span>{formatCurrency(income, currency)} income</span>
          </div>
        </div>

        {/* Per-category progress */}
        <div className="space-y-2.5">
          {[...categories]
            .sort((a, b) => (spendByCategory[b.name] ?? 0) - (spendByCategory[a.name] ?? 0))
            .map(cat => {
              const actual = spendByCategory[cat.name] ?? 0;
              const cap = cat.amount || 0;
              const pct = cap > 0 ? Math.min(100, (actual / cap) * 100) : 0;
              const over = actual > cap && cap > 0;
              const near = !over && cap > 0 && actual / cap >= 0.85;
              const bar = over ? 'bg-[#ef4444]' : near ? 'bg-[#f59e0b]' : 'bg-[#3b7dd8]';
              return (
                <div key={cat.id}>
                  <div className="flex items-center justify-between text-sm mb-1">
                    <span className="font-medium truncate">{cat.name}</span>
                    <span className={`text-xs flex-shrink-0 ml-2 ${over ? 'text-[#ef4444]' : 'text-[#6b6b6b] dark:text-[#a0a0a0]'}`}>
                      {formatCurrency(actual, currency)} / {formatCurrency(cap, currency)}
                    </span>
                  </div>
                  <div className="h-1.5 rounded-full bg-[#e5e5e5] dark:bg-[#2a2a2a] overflow-hidden">
                    <div className={`h-full rounded-full ${bar}`} style={{ width: `${pct}%` }} />
                  </div>
                </div>
              );
            })}
        </div>

        <div className="mt-4 pt-3 border-t border-[#e5e5e5] dark:border-[#2a2a2a] flex items-center justify-between text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">
          <span>Planned across categories</span>
          <span className="font-medium text-[#0f0f0f] dark:text-white">{formatCurrency(totalPlanned, currency)}</span>
        </div>
      </Card>

      {builderOpen && <BudgetBuilder onClose={() => setBuilderOpen(false)} currency={currency} payslips={payslips} />}
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Builder modal
// ─────────────────────────────────────────────────────────────────────────────
function BudgetBuilder({ onClose, currency, payslips }: { onClose: () => void; currency: string; payslips: PayslipCore[] }) {
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

  const categories = useMemo(() => categoriesOf(lines), [lines]);

  const income = useMemo(() =>
    resolveIncome(basis, period, {
      manualIncome: parseFloat(manualIncome) || 0, payslips, projectedAnnual, incomeEntries,
    }),
    [basis, manualIncome, projectedAnnual, incomeEntries, payslips, period]);

  const totalPlanned = categories.reduce((sum, c) => sum + (c.amount || 0), 0);
  const leftToAssign = income - totalPlanned;

  // Ensure a settings row exists the first time the builder opens (so the card
  // leaves its empty state). Only writes when none exists yet — subsequent
  // opens don't trigger a needless sync.
  useEffect(() => {
    if (!settings) {
      budgetSettingsDS.save({ period, income_basis: basis, income_amount: parseFloat(manualIncome) || 0 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saveSettings = (patch: Partial<{ period: BudgetPeriod; income_basis: BudgetIncomeBasis; income_amount: number }>) => {
    budgetSettingsDS.save({ period, income_basis: basis, income_amount: parseFloat(manualIncome) || 0, ...patch });
  };

  // Auto-build: only offer categories not already present.
  const existingNames = new Set(categories.map(c => c.name.toLowerCase()));
  const suggestions = useMemo(
    () => buildSuggestions(period, { transactions, bills: billsDS.getAll(), subs: subscriptions })
      .filter(s => !existingNames.has(s.category.toLowerCase())),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [period, transactions, subscriptions, lines],
  );

  const applyAutoBuild = () => {
    for (const s of suggestions) ensureCategory(s.category, s.suggested);
  };

  const addCategory = () => {
    const name = newCategory.trim();
    if (!name) return;
    ensureCategory(name);
    setNewCategory('');
  };

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

        {basis === 'manual' && (
          <Input
            label={`Income per ${PERIOD_LABEL[period]}`}
            type="number"
            value={manualIncome}
            onChange={e => setManualIncome(e.target.value)}
            onBlur={() => saveSettings({ income_amount: parseFloat(manualIncome) || 0 })}
            placeholder="e.g. 2000"
          />
        )}

        {/* Zero-based banner */}
        <div className="rounded-[12px] bg-[#f5f5f5] dark:bg-[#1f1f1f] px-4 py-3">
          <div className="flex items-center justify-between text-sm">
            <span className="text-[#6b6b6b] dark:text-[#a0a0a0]">Income / {PERIOD_LABEL[period]}</span>
            <span className="font-medium">{formatCurrency(income, currency)}</span>
          </div>
          <div className="flex items-center justify-between text-sm mt-1">
            <span className="text-[#6b6b6b] dark:text-[#a0a0a0]">Planned</span>
            <span className="font-medium">{formatCurrency(totalPlanned, currency)}</span>
          </div>
          <div className="flex items-center justify-between text-sm mt-1.5 pt-1.5 border-t border-[#e5e5e5] dark:border-[#2a2a2a]">
            <span className="font-medium">Left to assign</span>
            <span className={`font-semibold ${leftToAssign < 0 ? 'text-[#ef4444]' : 'text-[#22c55e]'}`}>
              {formatCurrency(leftToAssign, currency)}
            </span>
          </div>
        </div>

        {/* Auto-build */}
        {suggestions.length > 0 && (
          <button
            onClick={applyAutoBuild}
            className="w-full flex items-center justify-between rounded-[12px] border border-[#3b7dd8]/30 bg-[#3b7dd8]/5 px-4 py-3 text-left hover:bg-[#3b7dd8]/10 transition-colors"
          >
            <div className="min-w-0">
              <p className="text-sm font-medium text-[#3b7dd8]">
                {categories.length === 0 ? 'Auto-build my budget' : 'Add suggested categories'}
              </p>
              <p className="text-[11px] text-[#6b6b6b] dark:text-[#a0a0a0] truncate">
                {suggestions.length} {suggestions.length === 1 ? 'category' : 'categories'} from your spending &amp; recurring bills
              </p>
            </div>
            <span className="text-[#3b7dd8] text-lg flex-shrink-0 ml-3">+</span>
          </button>
        )}

        {/* Categories */}
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-[#6b6b6b] dark:text-[#a0a0a0] mb-2">
            Categories — planned per {PERIOD_LABEL[period]}
          </h3>
          <div className="space-y-1.5 max-h-[320px] overflow-y-auto">
            {categories.length === 0 && (
              <p className="text-sm text-[#6b6b6b] dark:text-[#a0a0a0] py-2">
                No categories yet — tap Auto-build above, or add one below.
              </p>
            )}
            {categories.map(cat => (
              <div key={cat.id} className="flex items-center gap-2 rounded-[8px] border border-[#e5e5e5] dark:border-[#2a2a2a] px-3 py-2">
                <span className="text-sm font-medium truncate min-w-0 flex-1">{cat.name}</span>
                <input
                  type="number"
                  defaultValue={cat.amount || ''}
                  onBlur={e => budgetLinesDS.update(cat.id, { amount: parseFloat(e.target.value) || 0 })}
                  className="w-24 text-right text-sm bg-transparent border border-[#e5e5e5] dark:border-[#2a2a2a] rounded-[6px] px-2 py-1"
                  placeholder="0"
                />
                <button
                  onClick={() => budgetLinesDS.remove(cat.id)}
                  className="text-[#ef4444] hover:opacity-70 text-lg leading-none px-1"
                  title="Remove category"
                >×</button>
              </div>
            ))}
          </div>

          {/* Add category */}
          <div className="flex items-end gap-2 mt-2">
            <div className="flex-1">
              <Input
                label="Add category"
                value={newCategory}
                onChange={e => setNewCategory(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') addCategory(); }}
                placeholder="e.g. Groceries, Fun, Health"
                list="budget-category-suggestions"
              />
              <datalist id="budget-category-suggestions">
                {allCategories.map(c => <option key={c} value={c} />)}
              </datalist>
            </div>
            <Button variant="secondary" onClick={addCategory} disabled={!newCategory.trim()}>Add</Button>
          </div>
        </div>

        <div className="flex justify-end">
          <Button onClick={onClose}>Done</Button>
        </div>
      </div>
    </Modal>
  );
}
