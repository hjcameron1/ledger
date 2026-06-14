import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../../store';
import {
  budgetSettingsDS, budgetLinesDS, customCategoriesDS,
  billsDS, subscriptionsDS, transactionsDS,
} from '../../services/dataService';
import { payrollApi } from '../../services/api';
import { onTrackAnnualFromPayslips, type PayslipCore } from '../../utils/payroll';
import { formatCurrency } from '../../utils/format';
import Card from '../common/Card';
import Modal from '../common/Modal';
import Button from '../common/Button';
import Input, { Toggle } from '../common/Input';
import type { BudgetPeriod, BudgetIncomeBasis, BudgetLine } from '../../types';

// ─────────────────────────────────────────────────────────────────────────────
//  Budget — a simple top-to-bottom plan.
//
//    1. Period            — weekly / fortnightly / monthly.
//    2. Income            — from recent paychecks, a yearly estimate, or custom.
//    3. Categories        — Health / Transportation / Groceries to start, each
//                           with a spending Goal. Add / rename / delete freely.
//    4. Bills & recurring — pull in your recurring payments (and search past
//                           transactions for ones we missed), file each under a
//                           category, optionally give a single bill its own goal.
//    5. Reporting         — earned this period, goal vs spent per category, and
//                           a comparison against the period before.
//
//  Storage: categories are `budget_lines` rows (is_category_budget = true, with
//  amount = the category Goal). A bill / subscription is "filed" under a category
//  by setting its own `category` field, so its spend rolls up automatically.
//  Per-bill goals are a light client-side overlay (no schema change).
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CATEGORIES = ['Health', 'Transportation', 'Groceries'];

// ── Period maths ─────────────────────────────────────────────────────────────
const PERIODS_PER_YEAR: Record<BudgetPeriod, number> = { weekly: 52, fortnightly: 26, monthly: 12 };
const PERIOD_DAYS: Record<BudgetPeriod, number> = { weekly: 7, fortnightly: 14, monthly: 30.44 };
const PERIOD_LABEL: Record<BudgetPeriod, string> = { weekly: 'week', fortnightly: 'fortnight', monthly: 'month' };
const round = (n: number) => Math.round(n);

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

/** The current tracking window: calendar month for monthly, trailing N days otherwise. */
function windowStart(period: BudgetPeriod): Date {
  const now = new Date();
  if (period === 'monthly') return new Date(now.getFullYear(), now.getMonth(), 1);
  const d = new Date(now);
  d.setDate(d.getDate() - (period === 'weekly' ? 7 : 14));
  return d;
}

/** The window immediately before the current one — for "vs last period". */
function prevWindow(period: BudgetPeriod): { start: Date; end: Date } {
  const now = new Date();
  if (period === 'monthly') {
    return {
      start: new Date(now.getFullYear(), now.getMonth() - 1, 1),
      end: new Date(now.getFullYear(), now.getMonth(), 1),
    };
  }
  const days = period === 'weekly' ? 7 : 14;
  const end = new Date(now); end.setDate(end.getDate() - days);
  const start = new Date(end); start.setDate(start.getDate() - days);
  return { start, end };
}

// ── Income ───────────────────────────────────────────────────────────────────
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
  // 'average' — actual pays received over the last 90 days, scaled to the period.
  const since = new Date(); since.setDate(since.getDate() - 90);
  const recent = ctx.incomeEntries.filter(e => new Date(e.date) >= since);
  const total = recent.reduce((sum, e) => sum + (e.display_amount ?? e.amount ?? 0), 0);
  return (total / 90) * PERIOD_DAYS[period];
}

// ── Categories ───────────────────────────────────────────────────────────────
function categoriesOf(lines: BudgetLine[]): BudgetLine[] {
  return lines.filter(l => l.is_category_budget);
}

/** Find or create a category row by name (case-insensitive). amount = its Goal. */
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

// ── Per-bill goal overlay (client-side, no schema change) ────────────────────
const BILL_GOALS_KEY = 'budget_bill_goals';
function readBillGoals(): Record<string, number> {
  try { return JSON.parse(localStorage.getItem(BILL_GOALS_KEY) || '{}'); } catch { return {}; }
}
function writeBillGoals(map: Record<string, number>): void {
  try { localStorage.setItem(BILL_GOALS_KEY, JSON.stringify(map)); } catch { /* ignore */ }
}

// ── One-time migration from the legacy two-level model ───────────────────────
const MIGRATION_FLAG = 'budget_v2_migrated';
function migrateLegacyOnce(): void {
  try { if (localStorage.getItem(MIGRATION_FLAG)) return; } catch { /* ignore */ }
  const all = budgetLinesDS.getAll();
  const items = all.filter(l => !l.is_category_budget);
  if (items.length > 0) {
    const sumByCat: Record<string, number> = {};
    for (const it of items) {
      const key = (it.category?.trim() || 'Other');
      sumByCat[key] = (sumByCat[key] ?? 0) + (it.amount || 0);
    }
    for (const [name, sum] of Object.entries(sumByCat)) {
      const cat = ensureCategory(name);
      if (sum > (cat.amount || 0)) budgetLinesDS.update(cat.id, { amount: round(sum) });
    }
    for (const it of items) budgetLinesDS.remove(it.id);
  }
  try { localStorage.setItem(MIGRATION_FLAG, '1'); } catch { /* ignore */ }
}

// ── Spend per category over a date window ────────────────────────────────────
function spendByCategoryBetween(
  transactions: { date: string; category?: string | null; display_amount?: number; amount?: number }[],
  start: Date, end?: Date,
): Record<string, number> {
  const map: Record<string, number> = {};
  for (const t of transactions) {
    if (!t.category) continue;
    const d = new Date(t.date);
    if (d < start) continue;
    if (end && d >= end) continue;
    const amt = t.display_amount ?? t.amount ?? 0;
    if (amt >= 0) continue; // outflow only
    map[t.category] = (map[t.category] ?? 0) + Math.abs(amt);
  }
  return map;
}

// ═════════════════════════════════════════════════════════════════════════════
//  Reporting card
// ═════════════════════════════════════════════════════════════════════════════
export default function BudgetSection({ currency }: { currency: string }) {
  const settings = useStore(s => s.budgetSettings);
  const lines = useStore(s => s.budgetLines);
  const transactions = useStore(s => s.transactions);
  const incomeEntries = useStore(s => s.incomeEntries);
  const projectedAnnual = useStore(s => s.projectedAnnual);

  const [builderOpen, setBuilderOpen] = useState(false);
  const payslips = usePayslips();

  useEffect(() => { migrateLegacyOnce(); }, []);

  const period: BudgetPeriod = settings?.period ?? 'monthly';
  const categories = useMemo(() => categoriesOf(lines), [lines]);

  const income = useMemo(() => {
    if (!settings) return 0;
    return resolveIncome(settings.income_basis, period, {
      manualIncome: settings.income_amount || 0, payslips, projectedAnnual, incomeEntries,
    });
  }, [settings, projectedAnnual, incomeEntries, payslips, period]);

  const spend = useMemo(() => spendByCategoryBetween(transactions, windowStart(period)), [transactions, period]);
  const prevSpend = useMemo(() => {
    const { start, end } = prevWindow(period);
    return spendByCategoryBetween(transactions, start, end);
  }, [transactions, period]);

  const totalGoal = categories.reduce((sum, c) => sum + (c.amount || 0), 0);
  const totalSpent = categories.reduce((sum, c) => sum + (spend[c.name] ?? 0), 0);
  const prevTotalSpent = categories.reduce((sum, c) => sum + (prevSpend[c.name] ?? 0), 0);
  const leftToSpend = income - totalSpent;

  // ── Empty state ──
  if (!settings || categories.length === 0) {
    return (
      <>
        <Card padding="none" className="p-5">
          <h2 className="text-base font-semibold mb-1">Budget</h2>
          <p className="text-sm text-[#6b6b6b] dark:text-[#a0a0a0] mb-4">
            Set your income, give each category a goal, and we'll track your spending against it
            — recurring bills included.
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
  const spendDelta = totalSpent - prevTotalSpent;
  const spendDeltaPct = prevTotalSpent > 0 ? (spendDelta / prevTotalSpent) * 100 : null;

  return (
    <>
      <Card padding="none" className="p-5">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-base font-semibold">Budget</h2>
          <button onClick={() => setBuilderOpen(true)} className="text-xs text-[#3b7dd8] hover:underline">Adjust</button>
        </div>

        {/* Hero: left to spend, grounded in income */}
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
            <span>{formatCurrency(income, currency)} earned</span>
          </div>
        </div>

        {/* Month-over-month headline */}
        {spendDeltaPct !== null && (
          <div className="flex items-center gap-1.5 mb-3 text-xs">
            <span className={spendDelta > 0 ? 'text-[#ef4444]' : 'text-[#22c55e]'}>
              {spendDelta > 0 ? '▲' : '▼'} {Math.abs(spendDeltaPct).toFixed(0)}%
            </span>
            <span className="text-[#6b6b6b] dark:text-[#a0a0a0]">
              vs last {PERIOD_LABEL[period]} ({formatCurrency(prevTotalSpent, currency)})
            </span>
          </div>
        )}

        {/* Per-category: goal vs spent, with last-period marker */}
        <div className="space-y-2.5">
          {[...categories]
            .sort((a, b) => (spend[b.name] ?? 0) - (spend[a.name] ?? 0))
            .map(cat => {
              const actual = spend[cat.name] ?? 0;
              const last = prevSpend[cat.name] ?? 0;
              const goal = cat.amount || 0;
              const pct = goal > 0 ? Math.min(100, (actual / goal) * 100) : 0;
              const lastPct = goal > 0 ? Math.min(100, (last / goal) * 100) : 0;
              const over = actual > goal && goal > 0;
              const near = !over && goal > 0 && actual / goal >= 0.85;
              const bar = over ? 'bg-[#ef4444]' : near ? 'bg-[#f59e0b]' : 'bg-[#3b7dd8]';
              return (
                <div key={cat.id}>
                  <div className="flex items-center justify-between text-sm mb-1">
                    <span className="font-medium truncate">{cat.name}</span>
                    <span className={`text-xs flex-shrink-0 ml-2 ${over ? 'text-[#ef4444]' : 'text-[#6b6b6b] dark:text-[#a0a0a0]'}`}>
                      {formatCurrency(actual, currency)} / {formatCurrency(goal, currency)}
                    </span>
                  </div>
                  <div className="relative h-1.5 rounded-full bg-[#e5e5e5] dark:bg-[#2a2a2a] overflow-hidden">
                    <div className={`h-full rounded-full ${bar}`} style={{ width: `${pct}%` }} />
                    {/* last-period marker */}
                    {goal > 0 && last > 0 && (
                      <div className="absolute top-0 bottom-0 w-0.5 bg-[#0f0f0f]/40 dark:bg-white/40" style={{ left: `${lastPct}%` }} title={`Last ${PERIOD_LABEL[period]}: ${formatCurrency(last, currency)}`} />
                    )}
                  </div>
                </div>
              );
            })}
        </div>

        <div className="mt-4 pt-3 border-t border-[#e5e5e5] dark:border-[#2a2a2a] flex items-center justify-between text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">
          <span>Earned / {PERIOD_LABEL[period]}</span>
          <span className="font-medium text-[#0f0f0f] dark:text-white">{formatCurrency(income, currency)}</span>
        </div>
        <div className="mt-1 flex items-center justify-between text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">
          <span>Total of category goals</span>
          <span className="font-medium text-[#0f0f0f] dark:text-white">{formatCurrency(totalGoal, currency)}</span>
        </div>
      </Card>

      {builderOpen && <BudgetBuilder onClose={() => setBuilderOpen(false)} currency={currency} payslips={payslips} />}
    </>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
//  Builder — the guided, top-to-bottom flow
// ═════════════════════════════════════════════════════════════════════════════
function Segmented<T extends string>({ value, onChange, options }: {
  value: T; onChange: (v: T) => void; options: { value: T; label: string }[];
}) {
  return (
    <div className="grid grid-cols-3 gap-1 p-1 rounded-[10px] bg-[#f5f5f5] dark:bg-[#1f1f1f]">
      {options.map(o => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={`py-1.5 text-sm rounded-[8px] transition-colors ${
            value === o.value ? 'bg-white dark:bg-[#2a2a2a] font-medium shadow-sm' : 'text-[#6b6b6b] dark:text-[#a0a0a0]'
          }`}
        >{o.label}</button>
      ))}
    </div>
  );
}

function SectionTitle({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 mb-2.5">
      <span className="flex items-center justify-center w-5 h-5 rounded-full bg-[#3b7dd8] text-white text-[11px] font-semibold">{n}</span>
      <h3 className="text-sm font-semibold">{children}</h3>
    </div>
  );
}

function BudgetBuilder({ onClose, currency, payslips }: { onClose: () => void; currency: string; payslips: PayslipCore[] }) {
  const settings = useStore(s => s.budgetSettings);
  const lines = useStore(s => s.budgetLines);
  const subscriptions = useStore(s => s.subscriptions);
  const transactions = useStore(s => s.transactions);
  const projectedAnnual = useStore(s => s.projectedAnnual);
  const incomeEntries = useStore(s => s.incomeEntries);

  const [period, setPeriod] = useState<BudgetPeriod>(settings?.period ?? 'monthly');
  const [basis, setBasis] = useState<BudgetIncomeBasis>(settings?.income_basis ?? 'projected');
  const [manualIncome, setManualIncome] = useState(String(settings?.income_amount ?? ''));
  const [newCategory, setNewCategory] = useState('');
  const [showRecurring, setShowRecurring] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [showManual, setShowManual] = useState(false);

  const categories = useMemo(() => categoriesOf(lines), [lines]);

  // Seed Health / Transportation / Groceries and a settings row on first open.
  useEffect(() => {
    if (!settings) budgetSettingsDS.save({ period, income_basis: basis, income_amount: parseFloat(manualIncome) || 0 });
    if (categoriesOf(budgetLinesDS.getAll()).length === 0) {
      for (const name of DEFAULT_CATEGORIES) ensureCategory(name);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const income = useMemo(() =>
    resolveIncome(basis, period, {
      manualIncome: parseFloat(manualIncome) || 0, payslips, projectedAnnual, incomeEntries,
    }),
    [basis, manualIncome, projectedAnnual, incomeEntries, payslips, period]);

  const totalGoal = categories.reduce((sum, c) => sum + (c.amount || 0), 0);
  const leftToAssign = income - totalGoal;

  const saveSettings = (patch: Partial<{ period: BudgetPeriod; income_basis: BudgetIncomeBasis; income_amount: number }>) => {
    budgetSettingsDS.save({ period, income_basis: basis, income_amount: parseFloat(manualIncome) || 0, ...patch });
  };

  const addCategory = () => {
    const name = newCategory.trim();
    if (!name) return;
    ensureCategory(name);
    setNewCategory('');
  };

  const catNames = categories.map(c => c.name);

  const incomeOptions: { value: BudgetIncomeBasis; label: string; hint: string }[] = [
    { value: 'average', label: 'Recent paychecks', hint: 'Average of pay received lately' },
    { value: 'projected', label: 'Yearly estimate', hint: 'On-track annual ÷ period' },
    { value: 'manual', label: 'Custom amount', hint: 'Enter it yourself' },
  ];

  return (
    <Modal isOpen onClose={onClose} title="Your budget" size="lg">
      <div className="space-y-6">

        {/* 1 — Period */}
        <section>
          <SectionTitle n={1}>How often do you budget?</SectionTitle>
          <Segmented
            value={period}
            onChange={(p) => { setPeriod(p); saveSettings({ period: p }); }}
            options={[
              { value: 'weekly', label: 'Weekly' },
              { value: 'fortnightly', label: 'Fortnightly' },
              { value: 'monthly', label: 'Monthly' },
            ]}
          />
        </section>

        {/* 2 — Income */}
        <section>
          <SectionTitle n={2}>What's your income per {PERIOD_LABEL[period]}?</SectionTitle>
          <div className="grid grid-cols-3 gap-2">
            {incomeOptions.map(o => (
              <button
                key={o.value}
                onClick={() => { setBasis(o.value); saveSettings({ income_basis: o.value }); }}
                className={`text-left rounded-[10px] border px-3 py-2.5 transition-colors ${
                  basis === o.value
                    ? 'border-[#3b7dd8] bg-[#3b7dd8]/5'
                    : 'border-[#e5e5e5] dark:border-[#2a2a2a] hover:border-[#3b7dd8]/40'
                }`}
              >
                <p className="text-sm font-medium">{o.label}</p>
                <p className="text-[11px] text-[#6b6b6b] dark:text-[#a0a0a0] mt-0.5 leading-snug">{o.hint}</p>
              </button>
            ))}
          </div>
          {basis === 'manual' && (
            <div className="mt-2">
              <Input
                type="number"
                value={manualIncome}
                onChange={e => setManualIncome(e.target.value)}
                onBlur={() => saveSettings({ income_amount: parseFloat(manualIncome) || 0 })}
                placeholder={`Income per ${PERIOD_LABEL[period]}, e.g. 2000`}
              />
            </div>
          )}
          <div className="flex items-center justify-between mt-2.5 rounded-[10px] bg-[#f5f5f5] dark:bg-[#1f1f1f] px-4 py-2.5">
            <span className="text-sm text-[#6b6b6b] dark:text-[#a0a0a0]">You'll have to spend</span>
            <span className="text-base font-semibold">{formatCurrency(income, currency)} / {PERIOD_LABEL[period]}</span>
          </div>
        </section>

        {/* 3 — Categories & goals */}
        <section>
          <SectionTitle n={3}>Categories &amp; goals</SectionTitle>
          <div className="space-y-1.5">
            {categories.map(cat => (
              <div key={cat.id} className="flex items-center gap-2 rounded-[8px] border border-[#e5e5e5] dark:border-[#2a2a2a] px-3 py-2">
                <input
                  defaultValue={cat.name}
                  onBlur={e => {
                    const v = e.target.value.trim();
                    if (v && v !== cat.name) budgetLinesDS.update(cat.id, { name: v, category: v });
                  }}
                  className="text-sm font-medium bg-transparent min-w-0 flex-1 outline-none"
                />
                <span className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">goal</span>
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
                  title="Delete category"
                >×</button>
              </div>
            ))}
          </div>
          <div className="flex items-end gap-2 mt-2">
            <div className="flex-1">
              <Input
                value={newCategory}
                onChange={e => setNewCategory(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') addCategory(); }}
                placeholder="Add a category, e.g. Eating out"
              />
            </div>
            <Button variant="secondary" onClick={addCategory} disabled={!newCategory.trim()}>Add</Button>
          </div>
          <div className="flex items-center justify-between mt-2.5 text-sm px-1">
            <span className="text-[#6b6b6b] dark:text-[#a0a0a0]">Left to assign</span>
            <span className={`font-semibold ${leftToAssign < 0 ? 'text-[#ef4444]' : 'text-[#22c55e]'}`}>
              {formatCurrency(leftToAssign, currency)}
            </span>
          </div>
        </section>

        {/* 4 — Bills & recurring */}
        <section>
          <SectionTitle n={4}>Bills &amp; recurring payments</SectionTitle>
          <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0] mb-2.5">
            File each recurring payment under a category so it counts toward that goal.
            Paid in cash or off-account? Add it manually.
          </p>
          <div className="grid grid-cols-2 gap-2">
            <Button variant="secondary" onClick={() => setShowRecurring(true)}>Add recurring payments</Button>
            <Button variant="secondary" onClick={() => setShowSearch(true)}>Search transactions</Button>
            <Button variant="secondary" onClick={() => setShowManual(true)} className="col-span-2">+ Add manually (cash / off-account)</Button>
          </div>
        </section>

        <div className="flex justify-end pt-1">
          <Button onClick={onClose}>Done</Button>
        </div>
      </div>

      {showRecurring && (
        <RecurringPicker
          onClose={() => setShowRecurring(false)}
          currency={currency} period={period} categories={catNames}
          subscriptions={subscriptions}
        />
      )}
      {showSearch && (
        <TransactionSearch
          onClose={() => setShowSearch(false)}
          currency={currency} categories={catNames} transactions={transactions}
        />
      )}
      {showManual && (
        <ManualEntry onClose={() => setShowManual(false)} currency={currency} categories={catNames} />
      )}
    </Modal>
  );
}

// ── Manual entry: a cash / off-account bill or one-off spend ──────────────────
function ManualEntry({ onClose, currency, categories }: {
  onClose: () => void; currency: string; categories: string[];
}) {
  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');
  const [cat, setCat] = useState(categories[0] ?? '');
  const [recurring, setRecurring] = useState(false);

  const save = () => {
    const amt = parseFloat(amount) || 0;
    const clean = name.trim();
    if (!clean || amt <= 0 || !cat) return;
    ensureCategory(cat);
    const today = new Date().toISOString().slice(0, 10);
    if (recurring) {
      billsDS.add({
        name: clean, amount: amt, due_date: today, is_recurring: true,
        frequency: 'monthly', colour: 'grey', is_paid: false,
        calendar_synced: false, category: cat,
      });
    } else {
      // A one-off cash spend — recorded as a transaction (no linked account) so it
      // counts toward what you've spent in the category.
      transactionsDS.add({
        account_id: null as unknown as string, account_type: 'bank',
        date: today, merchant: clean, amount: -Math.abs(amt), currency,
        category: cat, is_duplicate_flagged: false, is_subscription: false,
      });
    }
    onClose();
  };

  const valid = name.trim() && (parseFloat(amount) || 0) > 0 && cat;

  return (
    <Modal isOpen onClose={onClose} title="Add manually" size="md">
      <div className="space-y-3">
        <Input label="Name" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Market stall, Babysitter" autoFocus />
        <div className="grid grid-cols-2 gap-2">
          <Input label="Amount" type="number" value={amount} onChange={e => setAmount(e.target.value)} placeholder="0" />
          <div>
            <label className="label">Category</label>
            <select
              value={cat}
              onChange={e => setCat(e.target.value)}
              className="input appearance-none cursor-pointer"
            >
              {categories.length === 0 && <option value="">No categories yet</option>}
              {categories.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
        </div>
        <Toggle checked={recurring} onChange={setRecurring} label="This repeats every month (a recurring bill)" />
        <p className="text-[11px] text-[#6b6b6b] dark:text-[#a0a0a0]">
          {recurring
            ? 'Added as a recurring bill under this category.'
            : 'Recorded as a one-off spend in this category for this period.'}
        </p>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={save} disabled={!valid}>Add</Button>
        </div>
      </div>
    </Modal>
  );
}

// ── Recurring payments picker ─────────────────────────────────────────────────
interface RecurringRow {
  id: string; kind: 'bill' | 'sub'; name: string; amount: number; freq: string; category: string | null;
}

function RecurringPicker({ onClose, currency, period, categories, subscriptions }: {
  onClose: () => void; currency: string; period: BudgetPeriod; categories: string[];
  subscriptions: { id: string; name: string; amount: number; display_amount?: number; frequency: string; category: string }[];
}) {
  // Re-read bills live; combine with subscriptions into one list.
  const [tick, setTick] = useState(0);
  const [billGoals, setBillGoals] = useState<Record<string, number>>(readBillGoals);

  const rows: RecurringRow[] = useMemo(() => {
    // Subscriptions are canonical. Exclude bills generated FROM a subscription
    // (they carry subscription_id) so each recurring payment appears only once.
    const subs: RecurringRow[] = subscriptions.map(s => ({
      id: s.id, kind: 'sub' as const, name: s.name, amount: s.display_amount ?? s.amount, freq: s.frequency, category: s.category ?? null,
    }));
    const bills: RecurringRow[] = billsDS.getAll()
      .filter(b => b.is_recurring && !b.subscription_id)
      .map(b => ({ id: b.id, kind: 'bill' as const, name: b.name, amount: b.amount, freq: b.frequency ?? 'monthly', category: b.category ?? null }));
    // Final safety net: de-dupe by name (subscription wins).
    const seen = new Set<string>();
    return [...subs, ...bills]
      .filter(r => { const k = r.name.trim().toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; })
      .sort((a, b) => a.name.localeCompare(b.name));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subscriptions, tick]);

  const assign = (row: RecurringRow, category: string) => {
    const cat = category || null;
    if (cat) ensureCategory(cat);
    if (row.kind === 'bill') billsDS.update(row.id, { category: cat });
    else subscriptionsDS.update(row.id, { category: cat ?? '' });
    setTick(n => n + 1);
  };

  const setGoal = (id: string, amount: number | null) => {
    const next = { ...billGoals };
    if (amount == null) delete next[id]; else next[id] = amount;
    setBillGoals(next);
    writeBillGoals(next);
  };

  return (
    <Modal isOpen onClose={onClose} title="Recurring payments" size="lg">
      <div className="space-y-2 max-h-[60vh] overflow-y-auto">
        {rows.length === 0 && (
          <p className="text-sm text-[#6b6b6b] dark:text-[#a0a0a0] py-3">
            No recurring payments found. Use “Search transactions” to add one.
          </p>
        )}
        {rows.map(row => {
          const hasGoal = row.id in billGoals;
          return (
            <div key={`${row.kind}-${row.id}`} className="rounded-[10px] border border-[#e5e5e5] dark:border-[#2a2a2a] px-3 py-2.5">
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate">{row.name}</p>
                  <p className="text-[11px] text-[#6b6b6b] dark:text-[#a0a0a0]">
                    {formatCurrency(row.amount, currency)} · {row.freq} · {formatCurrency(toPeriod(row.amount, row.freq, period), currency)}/{PERIOD_LABEL[period]}
                  </p>
                </div>
                <select
                  value={row.category ?? ''}
                  onChange={e => assign(row, e.target.value)}
                  className="text-sm bg-transparent border border-[#e5e5e5] dark:border-[#2a2a2a] rounded-[6px] px-2 py-1 max-w-[42%]"
                >
                  <option value="">Unassigned</option>
                  {categories.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div className="flex items-center justify-between mt-2">
                <Toggle
                  size="sm"
                  checked={hasGoal}
                  onChange={(on) => setGoal(row.id, on ? round(toPeriod(row.amount, row.freq, period)) : null)}
                  label="Give this bill its own goal"
                />
                {hasGoal && (
                  <input
                    type="number"
                    defaultValue={billGoals[row.id]}
                    onBlur={e => setGoal(row.id, parseFloat(e.target.value) || 0)}
                    className="w-24 text-right text-sm bg-transparent border border-[#e5e5e5] dark:border-[#2a2a2a] rounded-[6px] px-2 py-1"
                  />
                )}
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex justify-end mt-4">
        <Button onClick={onClose}>Done</Button>
      </div>
    </Modal>
  );
}

// ── Transaction search → add as a recurring expense under a category ──────────
function TransactionSearch({ onClose, currency, categories, transactions }: {
  onClose: () => void; currency: string; categories: string[];
  transactions: { id: string; date: string; merchant: string; amount: number; display_amount?: number; category: string }[];
}) {
  const [query, setQuery] = useState('');
  const [cat, setCat] = useState(categories[0] ?? '');
  const [added, setAdded] = useState<Set<string>>(new Set());

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const seen = new Set<string>();
    const out: { merchant: string; amount: number }[] = [];
    for (const t of transactions) {
      const amt = t.display_amount ?? t.amount ?? 0;
      if (amt >= 0) continue; // outflow only
      const m = (t.merchant || '').trim();
      if (!m || seen.has(m.toLowerCase())) continue;
      if (!m.toLowerCase().includes(q)) continue;
      seen.add(m.toLowerCase());
      out.push({ merchant: m, amount: Math.abs(amt) });
      if (out.length >= 12) break;
    }
    return out;
  }, [query, transactions]);

  const addAsRecurring = (merchant: string, amount: number) => {
    if (!cat) return;
    ensureCategory(cat);
    billsDS.add({
      name: merchant, amount, due_date: new Date().toISOString().slice(0, 10),
      is_recurring: true, frequency: 'monthly', colour: 'grey', is_paid: false,
      calendar_synced: false, category: cat,
    });
    setAdded(prev => new Set(prev).add(merchant));
  };

  return (
    <Modal isOpen onClose={onClose} title="Search transactions" size="lg">
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-2">
          <Input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search a merchant…" autoFocus />
          <select
            value={cat}
            onChange={e => setCat(e.target.value)}
            className="text-sm bg-transparent border border-[#e5e5e5] dark:border-[#2a2a2a] rounded-[8px] px-2"
          >
            {categories.length === 0 && <option value="">No categories yet</option>}
            {categories.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div className="space-y-1.5 max-h-[50vh] overflow-y-auto">
          {query.trim() && results.length === 0 && (
            <p className="text-sm text-[#6b6b6b] dark:text-[#a0a0a0] py-2">No matching outgoings.</p>
          )}
          {results.map(r => {
            const done = added.has(r.merchant);
            return (
              <div key={r.merchant} className="flex items-center gap-2 rounded-[8px] border border-[#e5e5e5] dark:border-[#2a2a2a] px-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate">{r.merchant}</p>
                  <p className="text-[11px] text-[#6b6b6b] dark:text-[#a0a0a0]">{formatCurrency(r.amount, currency)}</p>
                </div>
                <Button variant="secondary" onClick={() => addAsRecurring(r.merchant, r.amount)} disabled={done || !cat}>
                  {done ? 'Added' : `Add to ${cat || '…'}`}
                </Button>
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
