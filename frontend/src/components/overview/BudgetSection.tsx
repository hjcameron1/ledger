import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../../store';
import {
  budgetSettingsDS, budgetLinesDS, customCategoriesDS,
  billsDS, subscriptionsDS, transactionsDS, accountIdMatches,
} from '../../services/dataService';
import { payrollApi } from '../../services/api';
import { onTrackAnnualFromPayslips, type PayslipCore } from '../../utils/payroll';
import { formatCurrency } from '../../utils/format';
import Card from '../common/Card';
import Modal from '../common/Modal';
import Button from '../common/Button';
import Input, { Toggle } from '../common/Input';
import type { BudgetPeriod, BudgetIncomeBasis, BudgetLine, Transaction } from '../../types';

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

// A distinguishable, theme-agnostic palette for per-category colour coding
// (donut slices + legend swatches in the detail view).
const PALETTE = [
  '#6366f1', '#22c55e', '#f59e0b', '#ef4444', '#06b6d4',
  '#a855f7', '#ec4899', '#14b8a6', '#f97316', '#3b82f6',
  '#84cc16', '#eab308',
];
const colourFor = (i: number) => PALETTE[i % PALETTE.length];

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

/** Transactions filed under a category within a window, newest first. */
function txnsForCategory(
  transactions: Transaction[], category: string, start: Date, end?: Date,
): Transaction[] {
  const key = category.trim().toLowerCase();
  return transactions
    .filter(t => {
      if ((t.category ?? '').trim().toLowerCase() !== key) return false;
      const amt = t.display_amount ?? t.amount ?? 0;
      if (amt >= 0) return false; // outflow only
      const d = new Date(t.date);
      if (d < start) return false;
      if (end && d >= end) return false;
      return true;
    })
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
}

/** Map any transaction's account_id → a friendly account/card name (or "Cash"). */
function useAccountLookup(): (accountId: string | null | undefined) => string {
  const accounts = useStore(s => s.accounts);
  const creditCards = useStore(s => s.creditCards);
  return useMemo(() => {
    return (accountId) => {
      if (!accountId) return 'Cash / manual';
      const bank = accounts.find(a => accountIdMatches(accountId, a));
      if (bank) return bank.name;
      const card = creditCards.find(c => accountIdMatches(accountId, c));
      if (card) return card.name;
      return 'Account';
    };
  }, [accounts, creditCards]);
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
  const [detailOpen, setDetailOpen] = useState(false);
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
          <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-4">
            Set your income, give each category a goal, and we'll track your spending against it
            — recurring bills included.
          </p>
          <button
            onClick={() => setBuilderOpen(true)}
            className="w-full py-3 border border-dashed border-zinc-200 dark:border-zinc-800 rounded-[12px] text-sm text-zinc-500 dark:text-zinc-400 hover:border-brand/40 hover:text-brand transition-all"
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
        {/* The whole card — title included — opens the breakdown; only the Adjust
            button is carved out (it stops the click from bubbling up). */}
        <div
          role="button"
          tabIndex={0}
          onClick={() => setDetailOpen(true)}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setDetailOpen(true); } }}
          className="group cursor-pointer rounded-[14px] -m-1.5 p-1.5 transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-900/40"
        >
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-base font-semibold">Budget</h2>
          <button
            onClick={e => { e.stopPropagation(); setBuilderOpen(true); }}
            className="text-xs text-brand hover:underline"
          >Adjust</button>
        </div>

        {/* Hero: left to spend, grounded in income */}
        <div className="rounded-[12px] bg-zinc-100 dark:bg-zinc-900 px-4 py-3.5 mb-4">
          <p className="text-[11px] uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            Left to spend this {PERIOD_LABEL[period]}
          </p>
          <p className={`text-2xl font-bold mt-0.5 ${overBudget ? 'text-[#ef4444]' : 'text-zinc-900 dark:text-white'}`}>
            {formatCurrency(leftToSpend, currency)}
          </p>
          <div className="mt-2.5 h-2 rounded-full bg-zinc-200 dark:bg-zinc-800 overflow-hidden">
            <div className={`h-full rounded-full ${overBudget ? 'bg-[#ef4444]' : 'bg-brand'}`} style={{ width: `${overallPct}%` }} />
          </div>
          <div className="flex items-center justify-between mt-1.5 text-[11px] text-zinc-500 dark:text-zinc-400">
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
            <span className="text-zinc-500 dark:text-zinc-400">
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
              const bar = over ? 'bg-[#ef4444]' : near ? 'bg-[#f59e0b]' : 'bg-brand';
              return (
                <div key={cat.id}>
                  <div className="flex items-center justify-between text-sm mb-1">
                    <span className="font-medium truncate">{cat.name}</span>
                    <span className={`text-xs flex-shrink-0 ml-2 ${over ? 'text-[#ef4444]' : 'text-zinc-500 dark:text-zinc-400'}`}>
                      {formatCurrency(actual, currency)} / {formatCurrency(goal, currency)}
                    </span>
                  </div>
                  <div className="relative h-1.5 rounded-full bg-zinc-200 dark:bg-zinc-800 overflow-hidden">
                    <div className={`h-full rounded-full ${bar}`} style={{ width: `${pct}%` }} />
                    {/* last-period marker */}
                    {goal > 0 && last > 0 && (
                      <div className="absolute top-0 bottom-0 w-0.5 bg-zinc-900/40 dark:bg-white/40" style={{ left: `${lastPct}%` }} title={`Last ${PERIOD_LABEL[period]}: ${formatCurrency(last, currency)}`} />
                    )}
                  </div>
                </div>
              );
            })}
        </div>

        <div className="mt-4 pt-3 border-t border-zinc-200 dark:border-zinc-800 flex items-center justify-between text-xs text-zinc-500 dark:text-zinc-400">
          <span>Earned / {PERIOD_LABEL[period]}</span>
          <span className="font-medium text-zinc-900 dark:text-white">{formatCurrency(income, currency)}</span>
        </div>
        <div className="mt-1 flex items-center justify-between text-xs text-zinc-500 dark:text-zinc-400">
          <span>Total of category goals</span>
          <span className="font-medium text-zinc-900 dark:text-white">{formatCurrency(totalGoal, currency)}</span>
        </div>

        <div className="mt-3 flex items-center justify-center gap-1 text-[11px] text-zinc-400 dark:text-zinc-500 group-hover:text-brand transition-colors">
          <span>View full breakdown</span>
          <span className="transition-transform group-hover:translate-x-0.5">→</span>
        </div>
        </div>{/* /clickable body */}
      </Card>

      {builderOpen && <BudgetBuilder onClose={() => setBuilderOpen(false)} currency={currency} payslips={payslips} />}
      {detailOpen && (
        <BudgetDetail
          onClose={() => setDetailOpen(false)}
          currency={currency}
          period={period}
          categories={categories}
          spend={spend}
          prevSpend={prevSpend}
          income={income}
          transactions={transactions}
        />
      )}
    </>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
//  Detail — a rich, read-only breakdown of the current period
// ═════════════════════════════════════════════════════════════════════════════

/** An SVG donut of each category's share of total spend. */
function Donut({ slices, centreLabel, centreSub }: {
  slices: { colour: string; value: number }[]; centreLabel: string; centreSub: string;
}) {
  const total = slices.reduce((s, x) => s + x.value, 0);
  const r = 58, cx = 80, cy = 80, sw = 22;
  const C = 2 * Math.PI * r;
  let acc = 0;
  return (
    <svg viewBox="0 0 160 160" className="w-40 h-40 -rotate-90">
      {/* track */}
      <circle cx={cx} cy={cy} r={r} fill="none" strokeWidth={sw}
        className="stroke-zinc-200 dark:stroke-zinc-800" />
      {total > 0 && slices.filter(s => s.value > 0).map((s, i) => {
        const frac = s.value / total;
        const len = frac * C;
        const dash = `${len} ${C - len}`;
        const offset = -acc * C;
        acc += frac;
        return (
          <circle key={i} cx={cx} cy={cy} r={r} fill="none" stroke={s.colour}
            strokeWidth={sw} strokeDasharray={dash} strokeDashoffset={offset} strokeLinecap="butt" />
        );
      })}
      {/* centre text (counter-rotate to upright) */}
      <g transform={`rotate(90 ${cx} ${cy})`}>
        <text x={cx} y={cy - 2} textAnchor="middle" className="fill-zinc-900 dark:fill-white"
          style={{ fontSize: 18, fontWeight: 700 }}>{centreLabel}</text>
        <text x={cx} y={cy + 15} textAnchor="middle" className="fill-zinc-400 dark:fill-zinc-500"
          style={{ fontSize: 9 }}>{centreSub}</text>
      </g>
    </svg>
  );
}

function BudgetDetail({ onClose, currency, period, categories, spend, prevSpend, income, transactions }: {
  onClose: () => void;
  currency: string;
  period: BudgetPeriod;
  categories: BudgetLine[];
  spend: Record<string, number>;
  prevSpend: Record<string, number>;
  income: number;
  transactions: Transaction[];
}) {
  const accountName = useAccountLookup();
  const [expanded, setExpanded] = useState<string | null>(null);
  const start = useMemo(() => windowStart(period), [period]);

  // Rank categories by spend; assign a stable colour by that rank.
  const ranked = useMemo(() =>
    [...categories]
      .map(c => ({ cat: c, actual: spend[c.name] ?? 0, last: prevSpend[c.name] ?? 0 }))
      .sort((a, b) => b.actual - a.actual),
    [categories, spend, prevSpend]);

  const totalSpent = ranked.reduce((s, x) => s + x.actual, 0);
  const prevTotal = ranked.reduce((s, x) => s + x.last, 0);
  const left = income - totalSpent;
  const deltaPct = prevTotal > 0 ? ((totalSpent - prevTotal) / prevTotal) * 100 : null;
  const slices = ranked.map((r, i) => ({ colour: colourFor(i), value: r.actual }));

  return (
    <Modal isOpen onClose={onClose} title="Budget breakdown" size="xl">
      <div className="space-y-5">

        {/* Summary tiles */}
        <div className="grid grid-cols-3 gap-2">
          {[
            { label: `Earned / ${PERIOD_LABEL[period]}`, value: income, tone: 'text-zinc-900 dark:text-white' },
            { label: 'Spent', value: totalSpent, tone: 'text-zinc-900 dark:text-white' },
            { label: 'Left', value: left, tone: left < 0 ? 'text-[#ef4444]' : 'text-[#22c55e]' },
          ].map(t => (
            <div key={t.label} className="rounded-[12px] bg-zinc-100 dark:bg-zinc-900 px-3 py-2.5">
              <p className="text-[10px] uppercase tracking-wide text-zinc-500 dark:text-zinc-400">{t.label}</p>
              <p className={`text-lg font-bold mt-0.5 ${t.tone}`}>{formatCurrency(t.value, currency)}</p>
            </div>
          ))}
        </div>

        {/* Donut + legend */}
        <div className="flex flex-col sm:flex-row items-center gap-4">
          <div className="flex-shrink-0">
            <Donut
              slices={slices}
              centreLabel={formatCurrency(totalSpent, currency)}
              centreSub={`spent this ${PERIOD_LABEL[period]}`}
            />
          </div>
          <div className="flex-1 w-full space-y-1.5">
            {totalSpent === 0 && (
              <p className="text-sm text-zinc-500 dark:text-zinc-400">No spending recorded this {PERIOD_LABEL[period]} yet.</p>
            )}
            {ranked.filter(r => r.actual > 0).map((r, i) => {
              const pct = totalSpent > 0 ? (r.actual / totalSpent) * 100 : 0;
              return (
                <div key={r.cat.id} className="flex items-center gap-2 text-sm">
                  <span className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ background: colourFor(i) }} />
                  <span className="font-medium truncate flex-1">{r.cat.name}</span>
                  <span className="text-zinc-500 dark:text-zinc-400 tabular-nums">{pct.toFixed(0)}%</span>
                  <span className="font-medium tabular-nums w-20 text-right">{formatCurrency(r.actual, currency)}</span>
                </div>
              );
            })}
          </div>
        </div>

        {/* This vs last period */}
        {deltaPct !== null && (
          <div className="flex items-center justify-center gap-1.5 text-xs">
            <span className={totalSpent > prevTotal ? 'text-[#ef4444]' : 'text-[#22c55e]'}>
              {totalSpent > prevTotal ? '▲' : '▼'} {Math.abs(deltaPct).toFixed(0)}%
            </span>
            <span className="text-zinc-500 dark:text-zinc-400">
              vs last {PERIOD_LABEL[period]} ({formatCurrency(prevTotal, currency)})
            </span>
          </div>
        )}

        {/* Per-category accordion → transactions inside each */}
        <div className="space-y-2">
          <p className="text-xs font-semibold text-zinc-500 dark:text-zinc-400 uppercase tracking-wide">Categories</p>
          {ranked.map((r, i) => {
            const goal = r.cat.amount || 0;
            const pct = goal > 0 ? Math.min(100, (r.actual / goal) * 100) : 0;
            const over = r.actual > goal && goal > 0;
            const near = !over && goal > 0 && r.actual / goal >= 0.85;
            const bar = over ? 'bg-[#ef4444]' : near ? 'bg-[#f59e0b]' : 'bg-brand';
            const isOpen = expanded === r.cat.id;
            const txns = isOpen ? txnsForCategory(transactions, r.cat.name, start) : [];
            const delta = r.actual - r.last;
            return (
              <div key={r.cat.id} className="rounded-[12px] border border-zinc-200 dark:border-zinc-800 overflow-hidden">
                <button
                  onClick={() => setExpanded(isOpen ? null : r.cat.id)}
                  className="w-full text-left px-3.5 py-3 hover:bg-zinc-50 dark:hover:bg-zinc-900/40 transition-colors"
                >
                  <div className="flex items-center justify-between mb-1.5">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ background: colourFor(i) }} />
                      <span className="font-medium truncate">{r.cat.name}</span>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <span className={`text-xs ${over ? 'text-[#ef4444]' : 'text-zinc-500 dark:text-zinc-400'}`}>
                        {formatCurrency(r.actual, currency)}{goal > 0 && <> / {formatCurrency(goal, currency)}</>}
                      </span>
                      <span className={`text-zinc-400 text-xs transition-transform ${isOpen ? 'rotate-90' : ''}`}>›</span>
                    </div>
                  </div>
                  <div className="h-1.5 rounded-full bg-zinc-200 dark:bg-zinc-800 overflow-hidden">
                    <div className={`h-full rounded-full ${bar}`} style={{ width: `${goal > 0 ? pct : (totalSpent > 0 ? Math.min(100, (r.actual / totalSpent) * 100) : 0)}%` }} />
                  </div>
                  {r.last > 0 && (
                    <p className="mt-1 text-[11px] text-zinc-400 dark:text-zinc-500">
                      {delta >= 0 ? '▲' : '▼'} {formatCurrency(Math.abs(delta), currency)} vs last {PERIOD_LABEL[period]}
                    </p>
                  )}
                </button>

                {isOpen && (
                  <div className="border-t border-zinc-200 dark:border-zinc-800 divide-y divide-zinc-100 dark:divide-zinc-800/60">
                    {txns.length === 0 && (
                      <p className="px-3.5 py-3 text-sm text-zinc-500 dark:text-zinc-400">
                        No transactions filed under this category this {PERIOD_LABEL[period]}.
                      </p>
                    )}
                    {txns.map(t => (
                      <div key={t.id} className="flex items-center gap-3 px-3.5 py-2.5">
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium truncate">{t.merchant || 'Transaction'}</p>
                          <p className="text-[11px] text-zinc-500 dark:text-zinc-400 truncate">
                            {new Date(t.date).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} · {accountName(t.account_id)}
                          </p>
                        </div>
                        <span className="text-sm font-medium tabular-nums flex-shrink-0">
                          {formatCurrency(Math.abs(t.display_amount ?? t.amount ?? 0), currency)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </Modal>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
//  Builder — the guided, top-to-bottom flow
// ═════════════════════════════════════════════════════════════════════════════
function Segmented<T extends string>({ value, onChange, options }: {
  value: T; onChange: (v: T) => void; options: { value: T; label: string }[];
}) {
  return (
    <div className="grid grid-cols-3 gap-1 p-1 rounded-[10px] bg-zinc-100 dark:bg-zinc-900">
      {options.map(o => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={`py-1.5 text-sm rounded-[8px] transition-colors ${
            value === o.value ? 'bg-white dark:bg-zinc-800 font-medium shadow-sm' : 'text-zinc-500 dark:text-zinc-400'
          }`}
        >{o.label}</button>
      ))}
    </div>
  );
}

function SectionTitle({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 mb-2.5">
      <span className="flex items-center justify-center w-5 h-5 rounded-full bg-brand text-white text-[11px] font-semibold">{n}</span>
      <h3 className="text-sm font-semibold">{children}</h3>
    </div>
  );
}

function BudgetBuilder({ onClose, currency, payslips }: { onClose: () => void; currency: string; payslips: PayslipCore[] }) {
  const settings = useStore(s => s.budgetSettings);
  const lines = useStore(s => s.budgetLines);
  const subscriptions = useStore(s => s.subscriptions);
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
                    ? 'border-brand bg-brand/5'
                    : 'border-zinc-200 dark:border-zinc-800 hover:border-brand/40'
                }`}
              >
                <p className="text-sm font-medium">{o.label}</p>
                <p className="text-[11px] text-zinc-500 dark:text-zinc-400 mt-0.5 leading-snug">{o.hint}</p>
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
          <div className="flex items-center justify-between mt-2.5 rounded-[10px] bg-zinc-100 dark:bg-zinc-900 px-4 py-2.5">
            <span className="text-sm text-zinc-500 dark:text-zinc-400">You'll have to spend</span>
            <span className="text-base font-semibold">{formatCurrency(income, currency)} / {PERIOD_LABEL[period]}</span>
          </div>
        </section>

        {/* 3 — Categories & goals */}
        <section>
          <SectionTitle n={3}>Categories &amp; goals</SectionTitle>
          <div className="space-y-1.5">
            {categories.map(cat => (
              <div key={cat.id} className="flex items-center gap-2 rounded-[8px] border border-zinc-200 dark:border-zinc-800 px-3 py-2">
                <input
                  defaultValue={cat.name}
                  onBlur={e => {
                    const v = e.target.value.trim();
                    if (v && v !== cat.name) budgetLinesDS.update(cat.id, { name: v, category: v });
                  }}
                  className="text-sm font-medium bg-transparent min-w-0 flex-1 outline-none"
                />
                <span className="text-xs text-zinc-500 dark:text-zinc-400">goal</span>
                <input
                  type="number"
                  defaultValue={cat.amount || ''}
                  onBlur={e => budgetLinesDS.update(cat.id, { amount: parseFloat(e.target.value) || 0 })}
                  className="w-24 text-right text-sm bg-transparent border border-zinc-200 dark:border-zinc-800 rounded-[6px] px-2 py-1"
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
            <span className="text-zinc-500 dark:text-zinc-400">Left to assign</span>
            <span className={`font-semibold ${leftToAssign < 0 ? 'text-[#ef4444]' : 'text-[#22c55e]'}`}>
              {formatCurrency(leftToAssign, currency)}
            </span>
          </div>
        </section>

        {/* 4 — Bills & recurring */}
        <section>
          <SectionTitle n={4}>Bills &amp; recurring payments</SectionTitle>
          <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-2.5">
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
          currency={currency} categories={catNames}
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
        <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
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
          <p className="text-sm text-zinc-500 dark:text-zinc-400 py-3">
            No recurring payments found. Use “Search transactions” to add one.
          </p>
        )}
        {rows.map(row => {
          const hasGoal = row.id in billGoals;
          return (
            <div key={`${row.kind}-${row.id}`} className="rounded-[10px] border border-zinc-200 dark:border-zinc-800 px-3 py-2.5">
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate">{row.name}</p>
                  <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
                    {formatCurrency(row.amount, currency)} · {row.freq} · {formatCurrency(toPeriod(row.amount, row.freq, period), currency)}/{PERIOD_LABEL[period]}
                  </p>
                </div>
                <select
                  value={row.category ?? ''}
                  onChange={e => assign(row, e.target.value)}
                  className="text-sm bg-transparent border border-zinc-200 dark:border-zinc-800 rounded-[6px] px-2 py-1 max-w-[42%]"
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
                    className="w-24 text-right text-sm bg-transparent border border-zinc-200 dark:border-zinc-800 rounded-[6px] px-2 py-1"
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

// ── Transaction search → assign real transactions to a budget category ────────
//  Lists recent outgoings (no search required), filterable by merchant and by
//  which accounts they came from. Picking a category writes straight to the
//  transaction's `category`, so it rolls up into that category's spend.
function TransactionSearch({ onClose, currency, categories }: {
  onClose: () => void; currency: string; categories: string[];
}) {
  const transactions = useStore(s => s.transactions);
  const accounts = useStore(s => s.accounts);
  const creditCards = useStore(s => s.creditCards);
  const accountName = useAccountLookup();

  const [query, setQuery] = useState('');

  // Which filter bucket a transaction belongs to: a matching account/card id, or
  // 'other' (no linked account, or an id we can't resolve to a known account).
  const bucketOf = useMemo(() => {
    const all = [...accounts, ...creditCards];
    return (accountId: string | null | undefined): string => {
      if (!accountId) return 'other';
      const hit = all.find(a => accountIdMatches(accountId, a));
      return hit ? hit.id : 'other';
    };
  }, [accounts, creditCards]);

  // Recent outgoings (last 120 days), newest first — the pool the chips filter.
  const recent = useMemo(() => {
    const since = new Date(); since.setDate(since.getDate() - 120);
    return transactions
      .filter(t => {
        const amt = t.display_amount ?? t.amount ?? 0;
        if (amt >= 0) return false;                         // outflow only
        return new Date(t.date) >= since;
      })
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  }, [transactions]);

  // Only offer chips for buckets that actually have transactions — and derive
  // them straight from the data, so nothing is silently un-filterable.
  const chips = useMemo(() => {
    const nameById = new Map<string, string>();
    for (const a of accounts) nameById.set(a.id, a.name);
    for (const c of creditCards) nameById.set(c.id, c.name);
    const order: string[] = [];
    for (const t of recent) {
      const b = bucketOf(t.account_id);
      if (!order.includes(b)) order.push(b);
    }
    return order.map(id => ({ id, name: id === 'other' ? 'Other / cash' : (nameById.get(id) ?? 'Account') }));
  }, [recent, accounts, creditCards, bucketOf]);

  // Track EXCLUDED buckets (empty = show everything). This can't go stale as
  // accounts load in, so every account's transactions show by default.
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setExcluded(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return recent
      .filter(t => {
        if (excluded.has(bucketOf(t.account_id))) return false;
        if (q && !(t.merchant || '').toLowerCase().includes(q)) return false;
        return true;
      })
      .slice(0, 100);
  }, [recent, query, excluded, bucketOf]);

  const catSet = useMemo(() => new Set(categories.map(c => c.toLowerCase())), [categories]);
  const assign = (t: Transaction, category: string) => {
    if (category) ensureCategory(category);
    transactionsDS.update(t.id, { category });
  };

  return (
    <Modal isOpen onClose={onClose} title="Search transactions" size="lg">
      <div className="space-y-3">
        <Input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search a merchant…" autoFocus />

        {/* Account filter — tick which accounts' transactions to show */}
        {chips.length > 1 && (
          <div>
            <p className="text-[11px] text-zinc-500 dark:text-zinc-400 mb-1.5">Show transactions from</p>
            <div className="flex flex-wrap gap-1.5">
              {chips.map(o => {
                const on = !excluded.has(o.id);
                return (
                  <button
                    key={o.id}
                    onClick={() => toggle(o.id)}
                    className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors ${
                      on
                        ? 'border-brand bg-brand/10 text-brand'
                        : 'border-zinc-200 dark:border-zinc-800 text-zinc-500 dark:text-zinc-400'
                    }`}
                  >
                    <span className={`w-3 h-3 rounded-[3px] flex items-center justify-center text-[9px] ${
                      on ? 'bg-brand text-white' : 'border border-zinc-300 dark:border-zinc-700'
                    }`}>{on ? '✓' : ''}</span>
                    {o.name}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <div className="space-y-1.5 max-h-[52vh] overflow-y-auto">
          {rows.length === 0 && (
            <p className="text-sm text-zinc-500 dark:text-zinc-400 py-3 text-center">
              No matching outgoings in the last 120 days.
            </p>
          )}
          {rows.map(t => {
            const current = (t.category && catSet.has(t.category.toLowerCase())) ? t.category : '';
            return (
              <div key={t.id} className="flex items-center gap-2 rounded-[10px] border border-zinc-200 dark:border-zinc-800 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate">{t.merchant || 'Transaction'}</p>
                  <p className="text-[11px] text-zinc-500 dark:text-zinc-400 truncate">
                    {new Date(t.date).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}
                    {' · '}{accountName(t.account_id)}
                    {' · '}{formatCurrency(Math.abs(t.display_amount ?? t.amount ?? 0), currency)}
                  </p>
                </div>
                <select
                  value={current}
                  onChange={e => assign(t, e.target.value)}
                  className={`text-sm bg-transparent border rounded-[6px] px-2 py-1 max-w-[45%] ${
                    current
                      ? 'border-brand/50 text-brand'
                      : 'border-zinc-200 dark:border-zinc-800 text-zinc-500 dark:text-zinc-400'
                  }`}
                >
                  <option value="">Unassigned</option>
                  {categories.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
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
