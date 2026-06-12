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
import type {
  BudgetPeriod, BudgetIncomeBasis, BudgetLineType, BudgetLine,
} from '../../types';

// ── Period maths ─────────────────────────────────────────────────────────────
const PERIODS_PER_YEAR: Record<BudgetPeriod, number> = { weekly: 52, fortnightly: 26, monthly: 12 };
const PERIOD_DAYS: Record<BudgetPeriod, number> = { weekly: 7, fortnightly: 14, monthly: 30.44 };
const PERIOD_LABEL: Record<BudgetPeriod, string> = { weekly: 'week', fortnightly: 'fortnight', monthly: 'month' };

// How often a source item recurs, expressed as occurrences per year, so any
// bill/subscription frequency can be normalised onto the budget's period.
function freqPerYear(freq?: string | null): number {
  switch ((freq ?? '').toLowerCase()) {
    case 'daily': return 365;
    case 'weekly': return 52;
    case 'fortnightly': case 'biweekly': return 26;
    case 'monthly': return 12;
    case 'quarterly': return 4;
    case 'yearly': case 'annually': case 'annual': return 1;
    default: return 12; // assume monthly when unknown
  }
}

/** Convert an amount recurring at `freq` into the budget period's equivalent. */
function toPeriod(amount: number, freq: string | null | undefined, period: BudgetPeriod): number {
  const perYear = amount * freqPerYear(freq);
  return perYear / PERIODS_PER_YEAR[period];
}

// Start of the current tracking window: calendar month for monthly, trailing
// N days for the shorter periods (where calendar alignment is ambiguous).
function windowStart(period: BudgetPeriod): Date {
  const now = new Date();
  if (period === 'monthly') return new Date(now.getFullYear(), now.getMonth(), 1);
  const d = new Date(now);
  d.setDate(d.getDate() - (period === 'weekly' ? 7 : 14));
  return d;
}

const LINE_TYPES: { value: BudgetLineType; label: string }[] = [
  { value: 'expense', label: 'Expense' },
  { value: 'bill', label: 'Bill' },
  { value: 'recurring', label: 'Recurring expense' },
  { value: 'pay', label: 'Pay / income' },
  { value: 'saving', label: 'Saving' },
];
const TYPE_LABEL: Record<BudgetLineType, string> = Object.fromEntries(
  LINE_TYPES.map(t => [t.value, t.label]),
) as Record<BudgetLineType, string>;

// Pay/income/saving lines are money set aside or earned, not spend to track
// against — only these "outgoing" types count toward the budgeted-spend total.
const SPEND_TYPES = new Set<BudgetLineType>(['expense', 'bill', 'recurring']);

export default function BudgetSection({ currency }: { currency: string }) {
  const settings = useStore(s => s.budgetSettings);
  const lines = useStore(s => s.budgetLines);
  const transactions = useStore(s => s.transactions);
  const incomeEntries = useStore(s => s.incomeEntries);
  const projectedAnnual = useStore(s => s.projectedAnnual);

  const [builderOpen, setBuilderOpen] = useState(false);

  const period: BudgetPeriod = settings?.period ?? 'monthly';

  // Per-period income, derived from the chosen basis.
  const income = useMemo(() => {
    if (!settings) return 0;
    if (settings.income_basis === 'manual') return settings.income_amount || 0;
    if (settings.income_basis === 'projected') return projectedAnnual / PERIODS_PER_YEAR[period];
    // average of actual pays: trailing 90 days of income entries → daily rate → period
    const since = new Date(); since.setDate(since.getDate() - 90);
    const recent = incomeEntries.filter(e => new Date(e.date) >= since);
    const total = recent.reduce((sum, e) => sum + (e.display_amount ?? e.amount ?? 0), 0);
    const daily = total / 90;
    return daily * PERIOD_DAYS[period];
  }, [settings, projectedAnnual, incomeEntries, period]);

  // Actual spend per category for the current window (sum of |amount| of matching txns).
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

  const totalBudgeted = lines
    .filter(l => SPEND_TYPES.has(l.type))
    .reduce((sum, l) => sum + (l.amount || 0), 0);
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
            Plan your income and spending by category — as simple or detailed as you like.
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

        {/* Tracked category lines */}
        <div className="space-y-2.5">
          {lines.length === 0 && (
            <p className="text-sm text-[#6b6b6b] dark:text-[#a0a0a0] text-center py-3">
              No budget items yet — tap Edit to add some.
            </p>
          )}
          {lines.map(l => {
            const actual = l.category ? (spendByCategory[l.category] ?? 0) : 0;
            const pct = l.amount > 0 ? Math.min(100, (actual / l.amount) * 100) : 0;
            const over = actual > l.amount && l.amount > 0;
            const tracked = SPEND_TYPES.has(l.type) && !!l.category;
            return (
              <div key={l.id}>
                <div className="flex items-center justify-between text-sm mb-1">
                  <span className="font-medium truncate">{l.name}</span>
                  <span className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0] flex-shrink-0 ml-2">
                    {tracked
                      ? <>{formatCurrency(actual, currency)} / {formatCurrency(l.amount, currency)}</>
                      : formatCurrency(l.amount, currency)}
                  </span>
                </div>
                {tracked && (
                  <div className="h-1.5 rounded-full bg-[#e5e5e5] dark:bg-[#2a2a2a] overflow-hidden">
                    <div
                      className={`h-full rounded-full ${over ? 'bg-[#ef4444]' : 'bg-[#3b7dd8]'}`}
                      style={{ width: `${pct}%` }}
                    />
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

// ── Builder modal ────────────────────────────────────────────────────────────
function BudgetBuilder({ onClose, currency }: { onClose: () => void; currency: string }) {
  const settings = useStore(s => s.budgetSettings);
  const lines = useStore(s => s.budgetLines);
  const subscriptions = useStore(s => s.subscriptions);
  const projectedAnnual = useStore(s => s.projectedAnnual);
  const incomeEntries = useStore(s => s.incomeEntries);
  const allCategories = useAllCategories();

  const [period, setPeriod] = useState<BudgetPeriod>(settings?.period ?? 'monthly');
  const [basis, setBasis] = useState<BudgetIncomeBasis>(settings?.income_basis ?? 'projected');
  const [manualIncome, setManualIncome] = useState(String(settings?.income_amount ?? ''));

  // New-line form
  const [name, setName] = useState('');
  const [type, setType] = useState<BudgetLineType>('expense');
  const [category, setCategory] = useState('');
  const [amount, setAmount] = useState('');
  const [newCategory, setNewCategory] = useState('');

  const derivedIncome = useMemo(() => {
    if (basis === 'manual') return parseFloat(manualIncome) || 0;
    if (basis === 'projected') return projectedAnnual / PERIODS_PER_YEAR[period];
    const since = new Date(); since.setDate(since.getDate() - 90);
    const recent = incomeEntries.filter(e => new Date(e.date) >= since);
    const total = recent.reduce((sum, e) => sum + (e.display_amount ?? e.amount ?? 0), 0);
    return (total / 90) * PERIOD_DAYS[period];
  }, [basis, manualIncome, projectedAnnual, incomeEntries, period]);

  const saveSettings = (patch: Partial<{ period: BudgetPeriod; income_basis: BudgetIncomeBasis; income_amount: number }>) => {
    budgetSettingsDS.save({
      period, income_basis: basis, income_amount: parseFloat(manualIncome) || 0, ...patch,
    });
  };

  const addLine = () => {
    if (!name.trim()) return;
    budgetLinesDS.add({
      type, name: name.trim(),
      category: category || null,
      amount: parseFloat(amount) || 0,
      source: 'manual', source_ref_id: null,
    });
    setName(''); setAmount(''); setCategory('');
  };

  const addNewCategory = () => {
    const created = customCategoriesDS.add(newCategory);
    if (created) { setCategory(created.name); setNewCategory(''); }
  };

  // Import helpers — skip anything already imported (same source_ref_id).
  const importedRefs = new Set(lines.map(l => l.source_ref_id).filter(Boolean));

  const importBills = () => {
    for (const b of billsDS.getAll()) {
      if (importedRefs.has(b.id)) continue;
      budgetLinesDS.add({
        type: 'bill', name: b.name,
        category: b.category ?? null,
        amount: toPeriod(b.amount, b.is_recurring ? b.frequency : 'monthly', period),
        source: 'bill', source_ref_id: b.id,
      });
    }
  };

  const importRecurring = () => {
    for (const sub of subscriptions) {
      if (importedRefs.has(sub.id)) continue;
      budgetLinesDS.add({
        type: 'recurring', name: sub.name,
        category: sub.category ?? null,
        amount: toPeriod(sub.display_amount ?? sub.amount, sub.frequency, period),
        source: 'recurring', source_ref_id: sub.id,
      });
    }
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

        {/* Existing lines */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-[#6b6b6b] dark:text-[#a0a0a0]">Budget items</h3>
            <div className="flex gap-2">
              <button onClick={importBills} className="text-xs text-[#3b7dd8] hover:underline">Import bills</button>
              <button onClick={importRecurring} className="text-xs text-[#3b7dd8] hover:underline">Import recurring</button>
            </div>
          </div>
          <div className="space-y-1.5 max-h-[220px] overflow-y-auto">
            {lines.length === 0 && (
              <p className="text-sm text-[#6b6b6b] dark:text-[#a0a0a0] py-2">Nothing yet — add items below or import.</p>
            )}
            {lines.map(l => (
              <div key={l.id} className="flex items-center gap-2 px-3 py-2 rounded-[8px] border border-[#e5e5e5] dark:border-[#2a2a2a]">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate">{l.name}</p>
                  <p className="text-[11px] text-[#6b6b6b] dark:text-[#a0a0a0]">
                    {TYPE_LABEL[l.type]}{l.category ? ` · ${l.category}` : ''}
                  </p>
                </div>
                <input
                  type="number"
                  defaultValue={l.amount}
                  onBlur={e => budgetLinesDS.update(l.id, { amount: parseFloat(e.target.value) || 0 })}
                  className="w-24 text-right text-sm bg-transparent border border-[#e5e5e5] dark:border-[#2a2a2a] rounded-[6px] px-2 py-1"
                />
                <button onClick={() => budgetLinesDS.remove(l.id)} className="text-[#ef4444] hover:opacity-70 text-lg leading-none px-1" title="Remove">×</button>
              </div>
            ))}
          </div>
        </div>

        {/* Add a line */}
        <div className="rounded-[10px] bg-[#f5f5f5] dark:bg-[#1f1f1f] p-3 space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-[#6b6b6b] dark:text-[#a0a0a0]">Add item</h3>
          <div className="grid grid-cols-2 gap-3">
            <Input label="Name" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Groceries" />
            <Select label="Type" value={type} onChange={e => setType(e.target.value as BudgetLineType)} options={LINE_TYPES} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Select
              label="Category (tracked)"
              value={category}
              onChange={e => setCategory(e.target.value)}
              options={[{ value: '', label: '— None —' }, ...allCategories.map(c => ({ value: c, label: c }))]}
            />
            <Input label={`Amount / ${PERIOD_LABEL[period]}`} type="number" value={amount} onChange={e => setAmount(e.target.value)} placeholder="0" />
          </div>
          {/* Add a brand-new category inline */}
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <Input label="New category (optional)" value={newCategory} onChange={e => setNewCategory(e.target.value)} placeholder="Create a category…" />
            </div>
            <Button variant="secondary" onClick={addNewCategory} disabled={!newCategory.trim()}>Add</Button>
          </div>
          <Button onClick={addLine} disabled={!name.trim()} className="w-full">Add item</Button>
        </div>

        <div className="flex justify-end">
          <Button onClick={onClose}>Done</Button>
        </div>
      </div>
    </Modal>
  );
}
