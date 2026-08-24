/**
 * Phase 9.2 — What if?
 *
 * A sandbox for money decisions that have not been made. Describe the changes —
 * a pay rise, cutting back on takeaway, a gym membership, an extra $300 a
 * fortnight off the mortgage, a car — and every one of them is run through the
 * same engines the Forecast, Loans, Budgets and Goals pages read, twice: once
 * as things are, once as they would be.
 *
 * Two promises this screen makes and has to keep visibly:
 *
 *   NOTHING IS SAVED.   Editing a scenario writes nothing to Ledger. The draft
 *                       lives in this browser and nowhere else. The only thing
 *                       that changes a record is the Apply panel at the bottom,
 *                       which names every record it would touch and waits to be
 *                       asked twice.
 *
 *   BOTH COLUMNS ARE REAL.  "Before" is not a re-derivation — it is the same
 *                       builder output the other screens show. So a scenario
 *                       can never quietly disagree with the page it is testing.
 *
 * The page holds no arithmetic. Every figure below is read straight off
 * `scenarioDS.run`, which is itself only a comparison of engine output.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import Layout from '../components/layout/Layout';
import { PageHeader } from '../components/design-kit/UI';
import Card from '../components/common/Card';
import Button from '../components/common/Button';
import { useStore } from '../store';
import { useScopeKey } from '../hooks/useScopeKey';
import { scenarioDS } from '../services/dataService';
import { formatCurrency, formatDate } from '../utils/format';
import {
  emptyChange, SCENARIO_KINDS, SCENARIO_KIND_LABELS,
  type Scenario, type ScenarioChange, type ScenarioChangeKind,
  type ScenarioComparison, type ScenarioFrequency, type ScenarioNote,
} from '../utils/scenario';

const DRAFT_KEY = 'ledger.scenario.draft';

const FREQUENCIES: { value: ScenarioFrequency; label: string }[] = [
  { value: 'weekly', label: 'Weekly' },
  { value: 'fortnightly', label: 'Fortnightly' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'quarterly', label: 'Quarterly' },
  { value: 'annually', label: 'Annually' },
  { value: 'once', label: 'Once' },
];

let seq = 0;
const newId = () => `ch-${Date.now().toString(36)}-${++seq}`;

function blankScenario(): Scenario {
  return { id: `sc-${Date.now().toString(36)}`, name: 'What if…', changes: [] };
}

/** The draft this browser was last editing. Local only — never synced. */
function loadDraft(): Scenario {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return blankScenario();
    const parsed = JSON.parse(raw) as Scenario;
    if (parsed && Array.isArray(parsed.changes)) return parsed;
  } catch {
    // A corrupt draft is not worth a broken page.
  }
  return blankScenario();
}

// ── Small pieces ─────────────────────────────────────────────────────────────

const FIELD =
  'px-2.5 py-1.5 rounded-[8px] border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:border-brand';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] uppercase tracking-wide text-zinc-400 dark:text-zinc-500">{label}</span>
      {children}
    </label>
  );
}

/** A signed money figure, coloured by whether it helps or hurts. `goodWhen`
 *  says which direction is the good one — more cash is good, more spend is not. */
function Delta({ value, currency, goodWhen = 'up' }: { value: number; currency: string; goodWhen?: 'up' | 'down' }) {
  const flat = Math.abs(value) < 0.005;
  const good = goodWhen === 'up' ? value > 0 : value < 0;
  const tone = flat
    ? 'text-zinc-400 dark:text-zinc-500'
    : good ? 'text-[#16a34a]' : 'text-[#ef4444]';
  return (
    <span className={`font-medium tabular-nums ${tone}`}>
      {flat ? '—' : `${value > 0 ? '+' : '−'}${formatCurrency(Math.abs(value), currency)}`}
    </span>
  );
}

function BeforeAfter({ before, after }: { before: React.ReactNode; after: React.ReactNode }) {
  return (
    <span className="tabular-nums">
      <span className="text-zinc-400 dark:text-zinc-500 line-through decoration-zinc-300 dark:decoration-zinc-700">{before}</span>
      <span className="mx-1.5 text-zinc-300 dark:text-zinc-600">→</span>
      <span className="text-zinc-900 dark:text-zinc-100 font-medium">{after}</span>
    </span>
  );
}

const NOTE_STYLE: Record<ScenarioNote['kind'], { label: string; badge: string }> = {
  assumption: { label: 'How this was read', badge: 'bg-zinc-500/15 text-zinc-500' },
  warning: { label: 'Worth knowing', badge: 'bg-[#f59e0b]/15 text-[#d97706]' },
  gap: { label: "Ledger doesn't know", badge: 'bg-[#f59e0b]/15 text-[#d97706]' },
};

function Months({ value }: { value: number | null }) {
  if (value == null) return <span className="text-zinc-400">—</span>;
  const whole = Math.round(Math.abs(value));
  if (whole === 0) return <span className="text-zinc-400 dark:text-zinc-500">no change</span>;
  const years = Math.floor(whole / 12);
  const months = whole % 12;
  const text = [years ? `${years} year${years === 1 ? '' : 's'}` : '', months ? `${months} month${months === 1 ? '' : 's'}` : '']
    .filter(Boolean).join(' ');
  return (
    <span className={`font-medium ${value > 0 ? 'text-[#16a34a]' : 'text-[#ef4444]'}`}>
      {value > 0 ? `${text} sooner` : `${text} later`}
    </span>
  );
}

// ── One change, edited ───────────────────────────────────────────────────────

type Vocabulary = ReturnType<typeof scenarioDS.vocabulary>;

function ChangeEditor({
  change, vocab, currency, onChange, onRemove,
}: {
  change: ScenarioChange;
  vocab: Vocabulary;
  currency: string;
  onChange: (next: ScenarioChange) => void;
  onRemove: () => void;
}) {
  const set = (patch: Record<string, unknown>) => onChange({ ...change, ...patch } as ScenarioChange);
  const enabled = change.enabled !== false;
  const money = (v: string) => (v === '' ? 0 : Number(v));

  return (
    <div className={`rounded-[10px] border border-zinc-200 dark:border-zinc-800 p-3 ${enabled ? '' : 'opacity-50'}`}>
      <div className="flex items-center justify-between gap-2 mb-2.5">
        <label className="flex items-center gap-2 text-sm font-medium text-zinc-900 dark:text-zinc-100">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => set({ enabled: e.target.checked })}
            className="accent-brand"
            aria-label={`Include ${SCENARIO_KIND_LABELS[change.kind]} in this scenario`}
          />
          {SCENARIO_KIND_LABELS[change.kind]}
        </label>
        <button
          type="button"
          onClick={onRemove}
          className="text-xs text-zinc-400 hover:text-[#ef4444] transition-colors"
        >
          Remove
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
        {change.kind === 'income' && (
          <>
            <Field label="Which income">
              <select
                className={FIELD}
                value={change.incomeId ?? ''}
                onChange={(e) => set({ incomeId: e.target.value || null })}
              >
                <option value="">All recurring income</option>
                {vocab.incomes.map(i => (
                  <option key={i.id} value={i.id}>{i.name}</option>
                ))}
              </select>
            </Field>
            <Field label="Change by">
              <div className="flex gap-1.5">
                <input
                  type="number"
                  className={`${FIELD} w-full`}
                  value={change.value}
                  onChange={(e) => set({ value: money(e.target.value) })}
                />
                <select
                  className={FIELD}
                  value={change.mode}
                  onChange={(e) => set({ mode: e.target.value })}
                >
                  <option value="percent">%</option>
                  <option value="amount">{currency} a month</option>
                </select>
              </div>
            </Field>
            <Field label="Starting">
              <input
                type="date"
                className={FIELD}
                value={change.startDate ?? ''}
                onChange={(e) => set({ startDate: e.target.value || null })}
              />
            </Field>
          </>
        )}

        {change.kind === 'spending' && (
          <>
            <Field label="On what">
              <select
                className={FIELD}
                value={change.category ?? ''}
                onChange={(e) => set({ category: e.target.value || null })}
              >
                <option value="">Everyday spending</option>
                {vocab.categories.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </Field>
            <Field label="Change by">
              <div className="flex gap-1.5">
                <input
                  type="number"
                  className={`${FIELD} w-full`}
                  value={change.value}
                  onChange={(e) => set({ value: money(e.target.value) })}
                />
                <select
                  className={FIELD}
                  value={change.mode}
                  onChange={(e) => set({ mode: e.target.value })}
                >
                  <option value="percent">%</option>
                  <option value="amount">{currency} a month</option>
                </select>
              </div>
            </Field>
            <p className="text-[11px] text-zinc-400 dark:text-zinc-500 self-end pb-1.5">
              A negative number means spending less.
            </p>
          </>
        )}

        {change.kind === 'recurring-expense' && (
          <>
            <Field label="What is it">
              <input
                className={FIELD}
                value={change.name}
                placeholder="Gym membership"
                onChange={(e) => set({ name: e.target.value })}
              />
            </Field>
            <Field label="Amount">
              <input
                type="number"
                className={FIELD}
                value={change.amount || ''}
                onChange={(e) => set({ amount: money(e.target.value) })}
              />
            </Field>
            <Field label="How often">
              <select className={FIELD} value={change.frequency} onChange={(e) => set({ frequency: e.target.value })}>
                {FREQUENCIES.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
              </select>
            </Field>
            <Field label="Category">
              <select
                className={FIELD}
                value={change.category ?? ''}
                onChange={(e) => set({ category: e.target.value || null })}
              >
                <option value="">No category</option>
                {vocab.categories.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </Field>
            <Field label="Starting">
              <input
                type="date"
                className={FIELD}
                value={change.startDate ?? ''}
                onChange={(e) => set({ startDate: e.target.value || null })}
              />
            </Field>
          </>
        )}

        {change.kind === 'one-off' && (
          <>
            <Field label="What is it">
              <input
                className={FIELD}
                value={change.name}
                placeholder="Car"
                onChange={(e) => set({ name: e.target.value })}
              />
            </Field>
            <Field label="Amount">
              <input
                type="number"
                className={FIELD}
                value={change.amount || ''}
                onChange={(e) => set({ amount: money(e.target.value) })}
              />
            </Field>
            <Field label="When">
              <input
                type="date"
                className={FIELD}
                value={change.date}
                onChange={(e) => set({ date: e.target.value })}
              />
            </Field>
            <Field label="Category">
              <select
                className={FIELD}
                value={change.category ?? ''}
                onChange={(e) => set({ category: e.target.value || null })}
              >
                <option value="">No category</option>
                {vocab.categories.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </Field>
            <p className="text-[11px] text-zinc-400 dark:text-zinc-500 self-end pb-1.5">
              A negative amount is money coming in.
            </p>
          </>
        )}

        {change.kind === 'extra-repayment' && (
          <>
            <Field label="Which loan">
              <select className={FIELD} value={change.loanId} onChange={(e) => set({ loanId: e.target.value })}>
                <option value="">Choose a loan</option>
                {vocab.loans.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </Field>
            <Field label="Extra each repayment">
              <input
                type="number"
                className={FIELD}
                value={change.amountPerPeriod || ''}
                onChange={(e) => set({ amountPerPeriod: money(e.target.value) })}
              />
            </Field>
            <p className="text-[11px] text-zinc-400 dark:text-zinc-500 self-end pb-1.5">
              On top of the repayment already going out
              {vocab.loans.find(l => l.id === change.loanId)
                ? ` ${vocab.loans.find(l => l.id === change.loanId)!.frequency}`
                : ''}.
            </p>
          </>
        )}

        {change.kind === 'offset' && (
          <>
            <Field label="Which loan">
              <select className={FIELD} value={change.loanId} onChange={(e) => set({ loanId: e.target.value })}>
                <option value="">Choose a loan</option>
                {vocab.loans.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </Field>
            <Field label="Change the offset by">
              <input
                type="number"
                className={FIELD}
                value={change.delta || ''}
                onChange={(e) => set({ delta: money(e.target.value) })}
              />
            </Field>
            <p className="text-[11px] text-zinc-400 dark:text-zinc-500 self-end pb-1.5">
              Your money, moved — so the balance line doesn't change, only the interest.
            </p>
          </>
        )}

        {change.kind === 'savings-contribution' && (
          <>
            <Field label="Which goal">
              <select className={FIELD} value={change.goalId} onChange={(e) => set({ goalId: e.target.value })}>
                <option value="">Choose a goal</option>
                {vocab.goals.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select>
            </Field>
            <Field label="Each month">
              <input
                type="number"
                className={FIELD}
                value={change.monthlyAmount || ''}
                onChange={(e) => set({ monthlyAmount: money(e.target.value) })}
              />
            </Field>
          </>
        )}
      </div>
    </div>
  );
}

// ── Results ──────────────────────────────────────────────────────────────────

function CashPanel({ result, currency }: { result: ScenarioComparison; currency: string }) {
  return (
    <Card padding="lg">
      <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 mb-0.5">Cash</h2>
      <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-3">
        What your bank accounts are projected to hold, and the lowest they dip to on the way.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-[11px] uppercase tracking-wide text-zinc-400 dark:text-zinc-500 text-left">
              <th className="pb-2 font-medium">Horizon</th>
              <th className="pb-2 font-medium">Projected balance</th>
              <th className="pb-2 font-medium">Change</th>
              <th className="pb-2 font-medium">Lowest point</th>
            </tr>
          </thead>
          <tbody>
            {result.cash.map(line => (
              <tr key={line.days} className="border-t border-zinc-100 dark:border-zinc-800/70">
                <td className="py-2 text-zinc-500 dark:text-zinc-400 whitespace-nowrap">
                  {line.days} days
                  <span className="ml-1.5 text-[11px] text-zinc-400 dark:text-zinc-600">{formatDate(line.date)}</span>
                </td>
                <td className="py-2">
                  <BeforeAfter
                    before={formatCurrency(line.before.projectedBalance, currency)}
                    after={formatCurrency(line.after.projectedBalance, currency)}
                  />
                </td>
                <td className="py-2"><Delta value={line.balanceChange} currency={currency} /></td>
                <td className="py-2">
                  <BeforeAfter
                    before={formatCurrency(line.before.lowestBalance, currency)}
                    after={formatCurrency(line.after.lowestBalance, currency)}
                  />
                  {line.newlyNegative && (
                    <span className="ml-2 text-[11px] px-1.5 py-0.5 rounded-full bg-[#ef4444]/15 text-[#ef4444]">
                      goes below zero
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function LoansPanel({ result, currency }: { result: ScenarioComparison; currency: string }) {
  return (
    <Card padding="lg">
      <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 mb-0.5">Loans</h2>
      <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-3">
        When each debt clears, and what it costs to get there.
      </p>
      <div className="space-y-3">
        {result.loans.map(loan => (
          <div key={loan.id} className="border-t border-zinc-100 dark:border-zinc-800/70 pt-3 first:border-0 first:pt-0">
            <div className="font-medium text-sm text-zinc-900 dark:text-zinc-100 mb-1.5">{loan.name}</div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 text-sm">
              <div>
                <div className="text-[11px] uppercase tracking-wide text-zinc-400 dark:text-zinc-500">Paid off</div>
                <BeforeAfter
                  before={loan.before.payoffDate ? formatDate(loan.before.payoffDate) : 'never'}
                  after={loan.after.payoffDate ? formatDate(loan.after.payoffDate) : 'never'}
                />
                <div className="mt-0.5"><Months value={loan.monthsSaved} /></div>
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-wide text-zinc-400 dark:text-zinc-500">Interest over its life</div>
                <BeforeAfter
                  before={formatCurrency(loan.before.totalInterest, currency)}
                  after={formatCurrency(loan.after.totalInterest, currency)}
                />
                <div className="mt-0.5 text-xs">
                  <Delta value={loan.interestSaved} currency={currency} goodWhen="up" />
                  <span className="text-zinc-400 dark:text-zinc-500 ml-1">
                    {loan.interestSaved >= 0 ? 'saved' : 'extra'}
                  </span>
                </div>
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-wide text-zinc-400 dark:text-zinc-500">Each repayment</div>
                <BeforeAfter
                  before={formatCurrency(loan.before.periodOutlay, currency)}
                  after={formatCurrency(loan.after.periodOutlay, currency)}
                />
              </div>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

function BudgetsPanel({ result, currency }: { result: ScenarioComparison; currency: string }) {
  return (
    <Card padding="lg">
      <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 mb-0.5">Budgets</h2>
      <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-3">
        Where this month lands. What you have already spent doesn't move — a scenario can only
        change what is still to come.
      </p>
      <div className="space-y-2">
        {result.budgets.map(b => (
          <div key={b.key} className="flex flex-wrap items-baseline justify-between gap-2 border-t border-zinc-100 dark:border-zinc-800/70 pt-2 first:border-0 first:pt-0">
            <div className="text-sm text-zinc-900 dark:text-zinc-100">
              {b.name}
              <span className="ml-2 text-xs text-zinc-400 dark:text-zinc-500">
                cap {formatCurrency(b.after.effectiveLimit, currency)}
              </span>
              {b.newlyOver && (
                <span className="ml-2 text-[11px] px-1.5 py-0.5 rounded-full bg-[#ef4444]/15 text-[#ef4444]">
                  heads over
                </span>
              )}
              {b.newlyUnder && (
                <span className="ml-2 text-[11px] px-1.5 py-0.5 rounded-full bg-[#16a34a]/15 text-[#16a34a]">
                  back inside
                </span>
              )}
            </div>
            <div className="text-sm">
              <BeforeAfter
                before={formatCurrency(b.before.projected, currency)}
                after={formatCurrency(b.after.projected, currency)}
              />
              <span className="ml-2"><Delta value={b.projectedChange} currency={currency} goodWhen="down" /></span>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

function GoalsPanel({ result, currency }: { result: ScenarioComparison; currency: string }) {
  return (
    <Card padding="lg">
      <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 mb-0.5">Goals</h2>
      <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-3">
        What reaches each goal every month, and when it lands.
      </p>
      <div className="space-y-2">
        {result.goals.map(g => (
          <div key={g.id} className="border-t border-zinc-100 dark:border-zinc-800/70 pt-2 first:border-0 first:pt-0">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div className="text-sm text-zinc-900 dark:text-zinc-100">
                {g.name}
                {g.newlyOnTrack && (
                  <span className="ml-2 text-[11px] px-1.5 py-0.5 rounded-full bg-[#16a34a]/15 text-[#16a34a]">
                    on track
                  </span>
                )}
                {g.newlyOffTrack && (
                  <span className="ml-2 text-[11px] px-1.5 py-0.5 rounded-full bg-[#f59e0b]/15 text-[#d97706]">
                    no longer on track
                  </span>
                )}
              </div>
              <div className="text-sm">
                <BeforeAfter
                  before={`${formatCurrency(g.before.allocatedPerMonth, currency)}/mo`}
                  after={`${formatCurrency(g.after.allocatedPerMonth, currency)}/mo`}
                />
              </div>
            </div>
            <div className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
              Finishes{' '}
              <BeforeAfter
                before={g.before.projectedDate ? formatDate(g.before.projectedDate) : 'not at this rate'}
                after={g.after.projectedDate ? formatDate(g.after.projectedDate) : 'not at this rate'}
              />
              {g.daysEarlier != null && g.daysEarlier !== 0 && (
                <span className={`ml-2 ${g.daysEarlier > 0 ? 'text-[#16a34a]' : 'text-[#ef4444]'}`}>
                  {Math.abs(g.daysEarlier)} days {g.daysEarlier > 0 ? 'sooner' : 'later'}
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

// ── Applying ─────────────────────────────────────────────────────────────────

function ApplyPanel({
  scenario, onApplied,
}: {
  scenario: Scenario;
  onApplied: (appliedIds: string[]) => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [outcome, setOutcome] = useState<{ applied: number; skipped: string[] } | null>(null);

  const checks = useMemo(() => {
    try {
      return scenarioDS.applicability(scenario);
    } catch {
      return [];
    }
  }, [scenario]);

  const byId = new Map(scenario.changes.map(c => [c.id, c]));
  const writable = checks.filter(c => c.canApply);
  const chosen = writable.filter(c => selected.has(c.changeId));

  // A change that has been edited since it was ticked must not stay ticked for
  // a write it no longer describes.
  useEffect(() => {
    setSelected(prev => new Set([...prev].filter(id => writable.some(w => w.changeId === id))));
    setConfirming(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(scenario)]);

  if (checks.length === 0) return null;

  const doApply = () => {
    const result = scenarioDS.apply(scenario, chosen.map(c => c.changeId));
    setOutcome({ applied: result.applied.length, skipped: result.skipped.map(s => s.reason) });
    setConfirming(false);
    setSelected(new Set());
    onApplied(result.applied.map(a => a.changeId));
  };

  return (
    <Card padding="lg">
      <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 mb-0.5">Make it real</h2>
      <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-3">
        Nothing above has touched your records. Tick what you have decided to actually do, and
        Ledger will write those — and only those.
      </p>

      <div className="space-y-1.5 mb-3">
        {checks.map(check => {
          const change = byId.get(check.changeId);
          if (!change) return null;
          return (
            <label
              key={check.changeId}
              className={`flex gap-2.5 items-start text-sm rounded-[8px] px-2 py-1.5 ${check.canApply ? 'cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-800/40' : 'opacity-70'}`}
            >
              <input
                type="checkbox"
                disabled={!check.canApply}
                checked={selected.has(check.changeId)}
                onChange={(e) => {
                  const next = new Set(selected);
                  if (e.target.checked) next.add(check.changeId); else next.delete(check.changeId);
                  setSelected(next);
                  setConfirming(false);
                }}
                className="mt-0.5 accent-brand"
              />
              <span>
                <span className="text-zinc-900 dark:text-zinc-100">{SCENARIO_KIND_LABELS[change.kind]}</span>
                <span className="block text-xs text-zinc-500 dark:text-zinc-400">{check.description}</span>
              </span>
            </label>
          );
        })}
      </div>

      {confirming ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-zinc-900 dark:text-zinc-100">
            Write {chosen.length} change{chosen.length === 1 ? '' : 's'} into Ledger?
          </span>
          <Button variant="primary" onClick={doApply}>Yes, apply</Button>
          <Button variant="ghost" onClick={() => setConfirming(false)}>Cancel</Button>
        </div>
      ) : (
        <Button
          variant="secondary"
          disabled={chosen.length === 0}
          onClick={() => setConfirming(true)}
        >
          {chosen.length === 0
            ? 'Nothing ticked'
            : `Apply ${chosen.length} change${chosen.length === 1 ? '' : 's'}`}
        </Button>
      )}

      {outcome && (
        <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">
          {outcome.applied > 0
            ? `${outcome.applied} change${outcome.applied === 1 ? '' : 's'} written. `
            : 'Nothing was written. '}
          {outcome.skipped.map((reason, i) => <span key={i} className="block">{reason}</span>)}
        </p>
      )}
    </Card>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function Scenarios() {
  const user = useStore(s => s.user);
  const currency = user?.currency_preference ?? 'AUD';
  const scopeKey = useScopeKey();

  // Subscribed so a scenario re-runs against records that arrived after a sync.
  const transactions = useStore(s => s.transactions);
  const loans = useStore(s => s.loans);
  const goals = useStore(s => s.goals);
  const budgets = useStore(s => s.budgets);
  const incomeEntries = useStore(s => s.incomeEntries);
  const subscriptions = useStore(s => s.subscriptions);
  const accounts = useStore(s => s.accounts);

  const [scenario, setScenario] = useState<Scenario>(loadDraft);
  const [adding, setAdding] = useState(false);

  // The draft is a sketch, kept in this browser so a refresh doesn't lose it.
  // It is not synced and it is not a record: nothing here is in Ledger.
  useEffect(() => {
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(scenario)); } catch { /* private mode */ }
  }, [scenario]);

  // Typing in a number field should not re-project the whole forecast on every
  // keystroke. The engines are fast, but not free.
  const [settled, setSettled] = useState(scenario);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setSettled(scenario), 250);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [scenario]);

  const deps = [scopeKey, transactions, loans, goals, budgets, incomeEntries, subscriptions, accounts];

  const vocab = useMemo(
    () => scenarioDS.vocabulary(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    deps,
  );

  const [result, error] = useMemo((): [ScenarioComparison | null, string | null] => {
    try {
      return [scenarioDS.run(settled), null];
    } catch (err) {
      console.error('[scenarios] run failed:', err);
      return [null, 'Ledger could not work this scenario out. The records behind it may be incomplete.'];
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settled, ...deps]);

  // Today as the ENGINES see it, so a new one-off's default date agrees with the
  // dates every figure on this page was computed against.
  const asOf = result?.asOf ?? new Date().toISOString().slice(0, 10);

  const addChange = (kind: ScenarioChangeKind) => {
    setScenario(s => ({ ...s, changes: [...s.changes, emptyChange(kind, newId(), asOf)] }));
    setAdding(false);
  };

  const updateChange = (id: string, next: ScenarioChange) =>
    setScenario(s => ({ ...s, changes: s.changes.map(c => (c.id === id ? next : c)) }));

  const removeChange = (id: string) =>
    setScenario(s => ({ ...s, changes: s.changes.filter(c => c.id !== id) }));

  // A change that has been written into Ledger is no longer hypothetical —
  // leaving it in the scenario would count it twice against the records it just
  // created.
  const dropApplied = (ids: string[]) =>
    setScenario(s => ({ ...s, changes: s.changes.filter(c => !ids.includes(c.id)) }));

  const notesByKind = (kind: ScenarioNote['kind']) => result?.notes.filter(n => n.kind === kind) ?? [];
  const orderedNotes = [...notesByKind('warning'), ...notesByKind('gap'), ...notesByKind('assumption')];

  return (
    <Layout>
      <PageHeader
        title="What if?"
        subtitle="Try a change before you make it. Nothing here touches your records."
        action={
          scenario.changes.length > 0 ? (
            <Button variant="ghost" onClick={() => setScenario(blankScenario())}>Start again</Button>
          ) : undefined
        }
      />

      <Card padding="lg" className="mb-4">
        <input
          value={scenario.name}
          onChange={(e) => setScenario(s => ({ ...s, name: e.target.value }))}
          className="w-full text-lg font-semibold bg-transparent text-zinc-900 dark:text-zinc-100 focus:outline-none border-b border-transparent focus:border-brand pb-1 mb-3"
          aria-label="Scenario name"
        />

        {scenario.changes.length === 0 && (
          <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-3">
            Add a change and Ledger will run it through your forecast, your loans, your budgets
            and your goals — side by side with how things stand now.
          </p>
        )}

        <div className="space-y-2.5">
          {scenario.changes.map(change => (
            <ChangeEditor
              key={change.id}
              change={change}
              vocab={vocab}
              currency={currency}
              onChange={(next) => updateChange(change.id, next)}
              onRemove={() => removeChange(change.id)}
            />
          ))}
        </div>

        <div className="mt-3">
          {adding ? (
            <div className="flex flex-wrap gap-1.5">
              {SCENARIO_KINDS.map(kind => (
                <button
                  key={kind}
                  type="button"
                  onClick={() => addChange(kind)}
                  className="text-xs px-2.5 py-1 rounded-full border border-zinc-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-300 hover:border-brand hover:text-brand transition-colors"
                >
                  {SCENARIO_KIND_LABELS[kind]}
                </button>
              ))}
              <button
                type="button"
                onClick={() => setAdding(false)}
                className="text-xs px-2.5 py-1 text-zinc-400 hover:text-zinc-600"
              >
                Cancel
              </button>
            </div>
          ) : (
            <Button variant="secondary" onClick={() => setAdding(true)}>Add a change</Button>
          )}
        </div>
      </Card>

      {error && (
        <Card padding="lg" className="mb-4">
          <p className="text-sm text-zinc-600 dark:text-zinc-300">{error}</p>
        </Card>
      )}

      {result && scenario.changes.length > 0 && (
        <div className="space-y-4">
          {result.unchanged ? (
            <Card padding="lg">
              <p className="text-sm text-zinc-600 dark:text-zinc-300">
                Nothing in this scenario moves a single figure yet. Fill in the amounts, or pick the
                loan, goal or income it applies to.
              </p>
            </Card>
          ) : (
            <Card padding="lg">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <div className="text-[11px] uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
                    Ongoing, per month
                  </div>
                  <div className="text-2xl mt-0.5">
                    <Delta value={result.monthlyCashChange} currency={currency} />
                  </div>
                  <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
                    What this scenario adds to, or takes out of, your cash each month.
                  </p>
                </div>
                {result.oneOffTotal !== 0 && (
                  <div>
                    <div className="text-[11px] uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
                      One-offs
                    </div>
                    <div className="text-2xl mt-0.5">
                      <Delta value={-result.oneOffTotal} currency={currency} />
                    </div>
                    <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
                      Single events, on the dates you gave them.
                    </p>
                  </div>
                )}
              </div>
            </Card>
          )}

          <CashPanel result={result} currency={currency} />
          {result.loans.length > 0 && <LoansPanel result={result} currency={currency} />}
          {result.budgets.length > 0 && <BudgetsPanel result={result} currency={currency} />}
          {result.goals.length > 0 && <GoalsPanel result={result} currency={currency} />}

          {orderedNotes.length > 0 && (
            <Card padding="lg">
              <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 mb-3">
                How Ledger read this
              </h2>
              <div className="space-y-2">
                {orderedNotes.map((n, i) => (
                  <div key={`${n.changeId ?? 'all'}-${i}`} className="flex gap-2 items-start">
                    <span className={`shrink-0 text-[11px] px-1.5 py-0.5 rounded-full ${NOTE_STYLE[n.kind].badge}`}>
                      {NOTE_STYLE[n.kind].label}
                    </span>
                    <span className="text-sm text-zinc-600 dark:text-zinc-300">{n.text}</span>
                  </div>
                ))}
              </div>
            </Card>
          )}

          <ApplyPanel scenario={settled} onApplied={dropApplied} />
        </div>
      )}
    </Layout>
  );
}
