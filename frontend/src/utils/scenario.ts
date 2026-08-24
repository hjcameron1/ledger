/**
 * Phase 9.2 — What-if scenarios (pure engine).
 *
 * A scenario is a QUESTION, never a change. It describes hypothetical money
 * decisions — a pay rise, spending less on groceries, a new gym membership, an
 * extra $300 a fortnight off the mortgage, more in the offset, a monthly
 * transfer into the house deposit, a $9,000 car — and this module works out what
 * each one would mean.
 *
 * ── The one rule that makes the answers trustworthy ──────────────────────────
 * This module adds NO arithmetic about money. It does not project a balance,
 * amortise a loan, cap a budget or date a goal. It turns a scenario into the
 * INPUTS the four engines already take:
 *
 *   cash flow   utils/cashFlowForecast  ← extra / altered `RecurringInput`s
 *   loans       utils/loanEngine        ← an extra repayment, a bigger offset
 *   budgets     utils/budgeting         ← a monthly rate delta, scheduled outflows
 *   goals       utils/savingsGoals      ← a monthly commitment to one goal
 *
 * The DS layer runs each engine twice — once on the real inputs, once on the
 * scenario's — and this module compares the two outputs. So a scenario can never
 * disagree with the screen it is testing: the "before" column IS the Forecast,
 * Loans, Budgets and Goals pages, computed by the same builders.
 *
 * ── Resolution happens once ─────────────────────────────────────────────────
 * A percentage is meaningless on its own: "10% less on groceries" needs to know
 * what groceries normally cost. `resolveScenario` turns every change into
 * concrete dollars ONCE, against baselines the DS gathered, and every engine is
 * then fed from that single resolved figure. A 10% cut therefore moves the cash
 * projection and the budget projection by the SAME number of dollars, rather
 * than by two independently-derived ones that would quietly disagree.
 *
 * When a baseline is missing — no learned spend for a category, an income
 * stream Ledger has never seen — a percentage resolves to nothing and says so
 * (`gap`). It is never guessed at.
 *
 * ── What money does NOT move ────────────────────────────────────────────────
 * Parking more in an offset, or committing a month's savings to a goal, moves
 * the user's own money between the user's own accounts. The forecast engine's
 * own rule is that an internal transfer changes no household cash, so neither
 * of those changes the cash projection — they change what the money is DOING
 * (interest charged, goal reached sooner). Every scenario that leans on this
 * says so out loud in its notes rather than leaving the user to notice a
 * balance that didn't move.
 *
 * READ-ONLY by construction: nothing here writes, and nothing here can. Turning
 * a scenario into real records is a separate, explicit act (`scenarioDS.apply`),
 * which is why `applicability()` below reports what applying WOULD write
 * without doing any of it.
 */
import {
  addDays, addMonths, generateOccurrences, round2,
  type AccountBalanceInput, type CashFlowForecast, type ForecastFrequency,
  type HorizonTotal, type RecurringInput,
} from './cashFlowForecast';
import { monthlyEquivalent } from './adaptiveForecast';
import { daysInMonthKey } from './budgeting';
import type { BudgetReport, BudgetReportLine, BudgetStatus } from './budgeting';
import type { GoalLine, GoalReport, GoalStatus } from './savingsGoals';
import type { LoanReport, LoanRow } from './loanEngine';
import type { RepaymentFrequency } from '../types';

// ─── What a scenario is made of ──────────────────────────────────────────────

/** Cadences a scenario can describe. The forecast engine's own set. */
export type ScenarioFrequency = ForecastFrequency;

export type ScenarioChangeKind =
  | 'income'
  | 'spending'
  | 'recurring-expense'
  | 'one-off'
  | 'extra-repayment'
  | 'lump-sum'
  | 'offset'
  | 'savings-contribution';

export interface ScenarioChangeBase {
  id: string;
  kind: ScenarioChangeKind;
  /** The user's own words for this change. Never derived from the numbers. */
  label?: string;
  /** Unticked: kept in the scenario, left out of the run. */
  enabled?: boolean;
}

/** A pay rise or a pay cut. */
export interface IncomeChange extends ScenarioChangeBase {
  kind: 'income';
  /** The income stream this applies to; null = every recurring income. */
  incomeId: string | null;
  mode: 'percent' | 'amount';
  /** percent: +10 is a 10% rise, −10 a cut. amount: a signed MONTHLY delta. */
  value: number;
  /** When the new money starts. Null = straight away. */
  startDate: string | null;
}

/** Spending more or less, overall or in one category. */
export interface SpendingChange extends ScenarioChangeBase {
  kind: 'spending';
  /** The category this applies to; null = everyday (variable) spending. */
  category: string | null;
  mode: 'percent' | 'amount';
  /** percent: −15 is spending 15% less. amount: a signed MONTHLY delta, where
   *  +300 means spending $300 a month MORE. */
  value: number;
}

/** A new commitment — a gym membership, a second car's insurance. */
export interface RecurringExpenseChange extends ScenarioChangeBase {
  kind: 'recurring-expense';
  name: string;
  /** A positive magnitude. This is a cost; the sign is the engine's business. */
  amount: number;
  frequency: ScenarioFrequency;
  category: string | null;
  /** First charge. Null = from today. */
  startDate: string | null;
}

/** One big purchase, or one windfall. */
export interface OneOffChange extends ScenarioChangeBase {
  kind: 'one-off';
  name: string;
  /** Positive = money out (a purchase). Negative = money in (a windfall). */
  amount: number;
  date: string;
  category: string | null;
}

/** Paying more than the minimum off a loan, every period. */
export interface ExtraRepaymentChange extends ScenarioChangeBase {
  kind: 'extra-repayment';
  loanId: string;
  /** On top of whatever already leaves the account each period. */
  amountPerPeriod: number;
}

/**
 * One payment straight off a loan's balance — the "what if I put $1,000 on the
 * car loan right now" question.
 *
 * Deliberately dateless: it is money paid TODAY. A lump sum with a date would
 * have to be projected as a balance that falls later, and `buildLoanReport`
 * amortises from the balance it is given as at today — so a future date would
 * report a saving that starts too early. Ask for a future payment and Ledger
 * answers the question it can actually answer, saying so.
 */
export interface LumpSumChange extends ScenarioChangeBase {
  kind: 'lump-sum';
  loanId: string;
  /** A positive magnitude — money OFF the loan. */
  amount: number;
}

/** Parking more (or less) in a loan's offset account. */
export interface OffsetChange extends ScenarioChangeBase {
  kind: 'offset';
  loanId: string;
  /** Signed: + puts more in, − takes money back out. */
  delta: number;
}

/** Committing a monthly amount to one savings goal. */
export interface SavingsContributionChange extends ScenarioChangeBase {
  kind: 'savings-contribution';
  goalId: string;
  monthlyAmount: number;
}

export type ScenarioChange =
  | IncomeChange
  | SpendingChange
  | RecurringExpenseChange
  | OneOffChange
  | ExtraRepaymentChange
  | LumpSumChange
  | OffsetChange
  | SavingsContributionChange;

export interface Scenario {
  id: string;
  name: string;
  changes: ScenarioChange[];
}

/** Human labels for the kinds — what a change is called when its own words are gone. */
export const SCENARIO_KIND_LABELS: Record<ScenarioChangeKind, string> = {
  income: 'Income change',
  spending: 'Spending change',
  'recurring-expense': 'New recurring expense',
  'one-off': 'One-off purchase',
  'extra-repayment': 'Extra loan repayment',
  'lump-sum': 'Lump sum off a loan',
  offset: 'Offset change',
  'savings-contribution': 'Savings contribution',
};

export const SCENARIO_KINDS: ScenarioChangeKind[] = [
  'income', 'spending', 'recurring-expense', 'one-off',
  'extra-repayment', 'lump-sum', 'offset', 'savings-contribution',
];

// ─── Notes: assumptions, warnings, and what Ledger doesn't know ──────────────

export interface ScenarioNote {
  /** `assumption` — how the change was read. `warning` — it does less than
   *  asked, or costs more than there is. `gap` — a baseline Ledger hasn't got,
   *  so part of the change resolved to nothing. */
  kind: 'assumption' | 'warning' | 'gap';
  /** The change it belongs to, or null for the scenario as a whole. */
  changeId: string | null;
  text: string;
}

// ─── Baselines the DS gathers before anything is resolved ───────────────────

export interface ScenarioLoanFacts {
  id: string;
  name: string;
  frequency: RepaymentFrequency;
  nextDueDate: string | null;
  /** The scheduled repayment on file. Zero means the forecast has no line for
   *  this loan at all — see the extra-repayment case below. */
  repayment: number;
  balance: number;
  /** The offset in force now — a linked account's live balance, or the typed
   *  figure. Resolved by the caller, as everywhere else in this codebase. */
  offsetBalance: number;
  /** True when the offset tracks a real account rather than a typed number.
   *  Such an offset cannot be changed by editing the loan — the money has to
   *  actually move — which is why `applicability` refuses to write it. */
  offsetIsLinked: boolean;
}

export interface ScenarioBaselines {
  asOf: string;
  /** The month the budget comparison covers (`YYYY-MM`). */
  month: string;
  /** Monthly income per income-entry id, from the forecast's own inputs. */
  monthlyIncomeById: Record<string, number>;
  /** Every recurring income, per month. */
  monthlyIncomeTotal: number;
  /** Typical monthly spend per category, as the budget engine learned it. */
  monthlySpendByCategory: Record<string, number>;
  /** Everyday variable spend per month — what "spending" with no category means. */
  monthlyDiscretionary: number;
  loans: ScenarioLoanFacts[];
  goals: { id: string; name: string }[];
}

// ─── One change, resolved into concrete engine inputs ───────────────────────

export interface ResolvedChange {
  change: ScenarioChange;
  /** Signed monthly effect on CASH: + more, − less. Zero when the money only
   *  moves between the user's own accounts (offsets, savings transfers). */
  monthlyCash: number;
  /** Extra forecast inputs this change contributes. */
  inputs: RecurringInput[];
  /** A change to the typical MONTHLY spend of a category (null = overall). */
  rateDelta: { category: string | null; amount: number } | null;
  /** Money landing in the report month that history cannot already know about. */
  scheduled: { category: string | null; amount: number } | null;
  loan: { loanId: string; extraPerPeriod: number; offsetDelta: number; balanceDelta: number } | null;
  goal: { goalId: string; monthlyAmount: number } | null;
  notes: ScenarioNote[];
}

const ZERO: Omit<ResolvedChange, 'change'> = {
  monthlyCash: 0, inputs: [], rateDelta: null, scheduled: null, loan: null, goal: null, notes: [],
};

/** Money, as a number a sentence can carry without a currency symbol. */
function money(n: number): string {
  const abs = Math.abs(round2(n));
  return abs.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function note(kind: ScenarioNote['kind'], changeId: string | null, text: string): ScenarioNote {
  return { kind, changeId, text };
}

/** The changes a run actually includes: enabled, in the order given. */
export function activeChanges(scenario: Scenario): ScenarioChange[] {
  return scenario.changes.filter(c => c.enabled !== false);
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Case-insensitive category lookup — categories are typed by hand. */
function rateFor(rates: Record<string, number>, category: string): number {
  if (rates[category] != null) return num(rates[category]);
  const hit = Object.keys(rates).find(k => k.toLowerCase() === category.toLowerCase());
  return hit ? num(rates[hit]) : 0;
}

/**
 * Turn one change into engine inputs and concrete dollars.
 *
 * Every percentage is resolved HERE, against `base`, so the same dollar figure
 * reaches the cash projection and the budget projection. A percentage with no
 * baseline behind it resolves to zero and reports a gap — Ledger does not
 * invent a typical month it has never seen.
 */
export function resolveChange(change: ScenarioChange, base: ScenarioBaselines): ResolvedChange {
  const out: ResolvedChange = { ...ZERO, change, inputs: [], notes: [] };
  const id = change.id;

  switch (change.kind) {
    case 'income': {
      let monthly: number;
      if (change.mode === 'amount') {
        monthly = num(change.value);
      } else {
        const baseline = change.incomeId
          ? num(base.monthlyIncomeById[change.incomeId])
          : base.monthlyIncomeTotal;
        if (baseline <= 0) {
          out.notes.push(note('gap', id, change.incomeId
            ? 'Ledger has no recurring amount on file for that income, so a percentage has nothing to work from. Enter the change as an amount instead.'
            : 'Ledger has no recurring income on file, so a percentage has nothing to work from. Enter the change as an amount instead.'));
          return out;
        }
        monthly = baseline * (num(change.value) / 100);
      }
      monthly = round2(monthly);
      if (!monthly) return out;

      const startDate = change.startDate || base.asOf;
      out.monthlyCash = monthly;
      out.inputs.push({
        id: `scenario:${id}`,
        sourceType: 'income',
        name: change.label || (monthly > 0 ? 'Pay rise' : 'Pay cut'),
        amount: monthly,
        frequency: 'monthly',
        anchorDate: startDate,
        accountId: null,
        confidence: 1,
      });
      out.notes.push(note('assumption', id,
        `Counted as ${monthly > 0 ? 'an extra' : 'a drop of'} ${money(monthly)} a month${change.startDate ? ` from ${change.startDate}` : ''}, before tax. Ledger does not re-work your tax position from a scenario.`));
      return out;
    }

    case 'spending': {
      let monthly: number; // signed change in SPEND: + spends more
      if (change.mode === 'amount') {
        monthly = num(change.value);
      } else {
        const baseline = change.category
          ? rateFor(base.monthlySpendByCategory, change.category)
          : base.monthlyDiscretionary;
        if (baseline <= 0) {
          out.notes.push(note('gap', id, change.category
            ? `Ledger hasn't learned a typical monthly spend for ${change.category}, so a percentage has nothing to work from. Enter the change as an amount instead.`
            : "Ledger hasn't learned a typical month of everyday spending yet, so a percentage has nothing to work from. Enter the change as an amount instead."));
          return out;
        }
        monthly = baseline * (num(change.value) / 100);
      }
      monthly = round2(monthly);
      if (!monthly) return out;

      out.monthlyCash = -monthly;
      out.rateDelta = { category: change.category, amount: monthly };
      out.inputs.push({
        id: `scenario:${id}`,
        sourceType: 'learned_spend',
        name: change.label || (monthly > 0 ? 'Spending more' : 'Spending less'),
        amount: -monthly,
        frequency: 'monthly',
        anchorDate: base.asOf,
        accountId: null,
        confidence: 0.8,
        category: change.category,
      });
      out.notes.push(note('assumption', id,
        `A spending change only reaches the days still to come, so this month moves by less than ${money(monthly)} — a full month moves by the whole amount.`));
      return out;
    }

    case 'recurring-expense': {
      const amount = Math.abs(num(change.amount));
      if (!amount) return out;
      const startDate = change.startDate || base.asOf;
      const monthly = round2(monthlyEquivalent(amount, change.frequency));

      out.monthlyCash = -monthly;
      out.inputs.push({
        id: `scenario:${id}`,
        sourceType: 'subscription',
        name: change.name || change.label || 'New expense',
        amount: -amount,
        frequency: change.frequency,
        anchorDate: startDate,
        accountId: null,
        confidence: 1,
        category: change.category,
      });
      // A commitment that does not exist yet is nowhere in the transaction
      // history the budget's rate was learned from, so it is scheduled money
      // rather than a rate change: adding it to the rate as well would count it
      // twice the moment the first charge lands.
      const due = occurrencesInMonth(
        { anchorDate: startDate, frequency: change.frequency }, base.asOf, base.month,
      );
      if (due > 0) out.scheduled = { category: change.category, amount: round2(due * amount) };
      if (change.frequency === 'once') {
        out.notes.push(note('assumption', id, 'A one-off cadence charges once, on its start date.'));
      }
      return out;
    }

    case 'one-off': {
      const amount = num(change.amount);
      if (!amount || !change.date) return out;
      out.monthlyCash = 0; // a single event, not a rate — see monthlyCashChange
      out.inputs.push({
        id: `scenario:${id}`,
        sourceType: 'subscription',
        name: change.name || change.label || 'One-off',
        amount: -amount,
        frequency: 'once',
        anchorDate: change.date,
        accountId: null,
        confidence: 1,
        category: change.category,
      });
      if (monthKeyOf(change.date) === base.month && change.date > base.asOf) {
        out.scheduled = { category: change.category, amount: round2(amount) };
      }
      if (change.date <= base.asOf) {
        out.notes.push(note('warning', id,
          'That date has already passed, so the cash projection — which only runs forward — leaves it out.'));
      }
      return out;
    }

    case 'extra-repayment': {
      const extra = Math.abs(num(change.amountPerPeriod));
      const loan = base.loans.find(l => l.id === change.loanId);
      if (!loan) {
        out.notes.push(note('gap', id, 'That loan is no longer in Ledger, so this change was left out.'));
        return out;
      }
      if (!extra) return out;

      out.loan = { loanId: loan.id, extraPerPeriod: extra, offsetDelta: 0, balanceDelta: 0 };
      out.monthlyCash = -round2(monthlyEquivalent(extra, loan.frequency));
      // The repayment is real cash leaving a real account, so it belongs in the
      // projection as well as in the loan. The DS folds it into the loan's own
      // forecast input when there is one — but the forecast only carries a loan
      // that has BOTH a due date and a repayment amount on file. Without either,
      // there is no line to fold into, and the extra would silently cost the
      // user nothing.
      if (!loan.nextDueDate || !loan.repayment) {
        out.inputs.push({
          id: `scenario:${id}`,
          sourceType: 'loan',
          name: `${loan.name} (extra repayment)`,
          amount: -extra,
          frequency: loan.frequency,
          anchorDate: base.asOf,
          accountId: null,
          confidence: 1,
        });
        out.notes.push(note('assumption', id,
          `${loan.name} has no ${loan.nextDueDate ? 'repayment amount' : 'next due date'} on file, so the extra repayment is projected from today.`));
      }
      return out;
    }

    case 'lump-sum': {
      const amount = round2(Math.abs(num(change.amount)));
      const loan = base.loans.find(l => l.id === change.loanId);
      if (!loan) {
        out.notes.push(note('gap', id, 'That loan is no longer in Ledger, so this change was left out.'));
        return out;
      }
      if (!amount) return out;

      // More than is owed cannot come off the loan. The projection is capped at
      // the balance, and the difference is reported rather than quietly kept.
      const applied = Math.min(amount, loan.balance);
      out.loan = { loanId: loan.id, extraPerPeriod: 0, offsetDelta: 0, balanceDelta: -applied };
      // A single payment, not a rate: it belongs in the horizons, not in the
      // per-month figure. The projection starts from today's balances, which
      // already include everything dated today, so the money leaves tomorrow —
      // the first day the projection can carry it.
      out.inputs.push({
        id: `scenario:${id}`,
        sourceType: 'loan',
        name: `${loan.name} (lump sum)`,
        amount: -applied,
        frequency: 'once',
        anchorDate: addDays(base.asOf, 1),
        accountId: null,
        confidence: 1,
      });
      out.notes.push(note('assumption', id,
        `Counted as ${money(applied)} paid off ${loan.name} today, straight off the balance.`));
      if (applied < amount) {
        out.notes.push(note('warning', id,
          `${loan.name} only has ${money(loan.balance)} owing, so ${money(amount - applied)} of that would have nowhere to go.`));
      }
      return out;
    }

    case 'offset': {
      const delta = round2(num(change.delta));
      const loan = base.loans.find(l => l.id === change.loanId);
      if (!loan) {
        out.notes.push(note('gap', id, 'That loan is no longer in Ledger, so this change was left out.'));
        return out;
      }
      if (!delta) return out;

      out.loan = { loanId: loan.id, extraPerPeriod: 0, offsetDelta: delta, balanceDelta: 0 };
      // Money in an offset is still the user's money, sitting in the user's own
      // account. Moving it there changes what interest is charged, not how much
      // cash the household has — the same rule the forecast applies to every
      // other transfer between own accounts.
      out.notes.push(note('assumption', id,
        'Money moved into an offset is still your money, so the cash projection is unchanged — only the interest is.'));
      if (delta > 0 && delta > loan.balance - loan.offsetBalance) {
        out.notes.push(note('warning', id,
          `An offset only saves interest on what is owed. ${loan.name} has ${money(Math.max(0, loan.balance - loan.offsetBalance))} left to offset, and anything past that saves nothing.`));
      }
      return out;
    }

    case 'savings-contribution': {
      const monthly = round2(Math.abs(num(change.monthlyAmount)));
      const goal = base.goals.find(g => g.id === change.goalId);
      if (!goal) {
        out.notes.push(note('gap', id, 'That goal is no longer in Ledger, so this change was left out.'));
        return out;
      }
      if (!monthly) return out;

      out.goal = { goalId: goal.id, monthlyAmount: monthly };
      out.notes.push(note('assumption', id,
        `Saving is money moved between your own accounts, so the cash projection is unchanged — what moves is when ${goal.name} lands.`));
      return out;
    }
  }
}

/** Resolve every enabled change in the scenario, in order. */
export function resolveScenario(scenario: Scenario, base: ScenarioBaselines): ResolvedChange[] {
  return activeChanges(scenario).map(c => resolveChange(c, base));
}

/** `YYYY-MM` of a date, or null. */
function monthKeyOf(date: string): string | null {
  return /^\d{4}-\d{2}/.test(date) ? date.slice(0, 7) : null;
}

/** How many times a cadence charges between `asOf` (exclusive) and month end. */
function occurrencesInMonth(
  input: { anchorDate: string; frequency: ScenarioFrequency },
  asOf: string,
  month: string,
): number {
  const end = `${month}-${String(daysInMonthKey(month)).padStart(2, '0')}`;
  if (end <= asOf) return 0;
  return generateOccurrences(input, asOf, end).length;
}

// ─── Feeding the engines ────────────────────────────────────────────────────

/**
 * The forecast's inputs, with the scenario folded in.
 *
 * Extra repayments are merged INTO the loan's own input rather than added
 * beside it, so a loan is one line in the projection whether or not a scenario
 * is running — two lines would read as two payments.
 */
export function scenarioForecastInputs(
  baseInputs: RecurringInput[],
  resolved: ResolvedChange[],
): RecurringInput[] {
  const extraByLoan = new Map<string, number>();
  for (const r of resolved) {
    if (r.loan?.extraPerPeriod) {
      extraByLoan.set(r.loan.loanId, (extraByLoan.get(r.loan.loanId) ?? 0) + r.loan.extraPerPeriod);
    }
  }

  const merged = baseInputs.map(input => {
    if (input.sourceType !== 'loan') return input;
    const loanId = input.id.startsWith('loan:') ? input.id.slice('loan:'.length) : null;
    const extra = loanId ? extraByLoan.get(loanId) : undefined;
    if (!extra) return input;
    extraByLoan.delete(loanId!); // handled here; no standalone input needed
    return { ...input, amount: round2(input.amount - Math.abs(extra)) };
  });

  return [...merged, ...resolved.flatMap(r => r.inputs)];
}

/** Learned monthly rates, with the scenario's spending changes folded in. */
export interface ScenarioBudgetProjection {
  monthlyRateByCategory: Record<string, number>;
  overallMonthlyRate: number;
  scheduledByCategory: Record<string, number>;
  scheduledOverall: number;
}

export function scenarioBudgetProjection(
  rates: { byCategory: Record<string, number>; overall: number },
  resolved: ResolvedChange[],
): ScenarioBudgetProjection {
  const byCategory: Record<string, number> = { ...rates.byCategory };
  let overall = num(rates.overall);
  const scheduledByCategory: Record<string, number> = {};
  let scheduledOverall = 0;

  for (const r of resolved) {
    if (r.rateDelta) {
      const { category, amount } = r.rateDelta;
      if (category) {
        const key = Object.keys(byCategory).find(k => k.toLowerCase() === category.toLowerCase()) ?? category;
        byCategory[key] = round2(Math.max(0, num(byCategory[key]) + amount));
      }
      // The overall cap measures every dollar, so a category change moves it too.
      overall = round2(Math.max(0, overall + amount));
    }
    if (r.scheduled) {
      const { category, amount } = r.scheduled;
      if (category) {
        scheduledByCategory[category] = round2(num(scheduledByCategory[category]) + amount);
      }
      scheduledOverall = round2(scheduledOverall + amount);
    }
  }

  return { monthlyRateByCategory: byCategory, overallMonthlyRate: overall, scheduledByCategory, scheduledOverall };
}

/** Per-loan adjustments, summed so two changes to one loan compose. */
export interface ScenarioLoanAdjustment {
  extraPerPeriod: number;
  offsetDelta: number;
  /** Signed change to the balance owing. Negative = paid down. */
  balanceDelta: number;
}

export function scenarioLoanAdjustments(resolved: ResolvedChange[]): Map<string, ScenarioLoanAdjustment> {
  const out = new Map<string, ScenarioLoanAdjustment>();
  for (const r of resolved) {
    if (!r.loan) continue;
    const cur = out.get(r.loan.loanId) ?? { extraPerPeriod: 0, offsetDelta: 0, balanceDelta: 0 };
    out.set(r.loan.loanId, {
      extraPerPeriod: round2(cur.extraPerPeriod + r.loan.extraPerPeriod),
      offsetDelta: round2(cur.offsetDelta + r.loan.offsetDelta),
      balanceDelta: round2(cur.balanceDelta + r.loan.balanceDelta),
    });
  }
  return out;
}

/** Monthly money earmarked per goal, summed across changes. */
export function scenarioGoalCommitments(resolved: ResolvedChange[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of resolved) {
    if (!r.goal) continue;
    out[r.goal.goalId] = round2(num(out[r.goal.goalId]) + r.goal.monthlyAmount);
  }
  return out;
}

// ─── Before vs after ────────────────────────────────────────────────────────

export interface ScenarioCashLine {
  days: number;
  date: string;
  before: HorizonTotal;
  after: HorizonTotal;
  /** after − before, on the figures a person actually reads. */
  netChange: number;
  balanceChange: number;
  lowestChange: number;
  /** True when the scenario is what takes this horizon's low point below zero. */
  newlyNegative: boolean;
}

export interface ScenarioLoanSide {
  payoffDate: string | null;
  monthsToPayoff: number | null;
  totalInterest: number;
  periodOutlay: number;
  effectiveBalance: number;
  interestPerYear: number;
}

export interface ScenarioLoanLine {
  id: string;
  name: string;
  before: ScenarioLoanSide;
  after: ScenarioLoanSide;
  /** Months the payoff moves forward. Positive = sooner. */
  monthsSaved: number | null;
  /** Interest avoided over the life of the loan. Positive = saved. */
  interestSaved: number;
  /** Change in what leaves the account each period. */
  outlayChange: number;
}

export interface ScenarioBudgetSide {
  effectiveLimit: number;
  spent: number;
  projected: number;
  projectedRemaining: number;
  status: BudgetStatus;
}

export interface ScenarioBudgetLine {
  key: string;
  name: string;
  category: string | null;
  before: ScenarioBudgetSide;
  after: ScenarioBudgetSide;
  projectedChange: number;
  /**
   * True when the scenario is what puts this budget on course to break its cap.
   *
   * Measured on PROJECTED remaining, not on `status`: a budget is only 'over'
   * once the money has actually been spent, and a scenario cannot change what
   * has already happened. What it can change is where the month lands — which
   * is the thing the user is asking about.
   */
  newlyOver: boolean;
  /** True when the scenario is what brings the month back inside the cap. */
  newlyUnder: boolean;
}

export interface ScenarioGoalSide {
  projectedDate: string | null;
  allocatedPerMonth: number;
  requiredPerMonth: number | null;
  shortfallPerMonth: number;
  status: GoalStatus;
}

export interface ScenarioGoalLine {
  id: string;
  name: string;
  before: ScenarioGoalSide;
  after: ScenarioGoalSide;
  /** Days the projected finish moves forward. Positive = sooner. Null when
   *  either side has no projected date to compare. */
  daysEarlier: number | null;
  /** True when the scenario is what makes the target date reachable. */
  newlyOnTrack: boolean;
  /** True when the scenario is what makes it unreachable. */
  newlyOffTrack: boolean;
}

export interface ScenarioComparison {
  asOf: string;
  month: string;
  scenario: Scenario;
  resolved: ResolvedChange[];
  cash: ScenarioCashLine[];
  loans: ScenarioLoanLine[];
  budgets: ScenarioBudgetLine[];
  goals: ScenarioGoalLine[];
  /** The scenario's ongoing effect on cash, per month. Excludes one-offs, which
   *  are a single event rather than a rate — they show up in the horizons. */
  monthlyCashChange: number;
  /** Every one-off in the scenario, netted. Positive = money out. */
  oneOffTotal: number;
  /** True when nothing in the scenario moved a single figure. */
  unchanged: boolean;
  notes: ScenarioNote[];
}

const EPS = 0.005;

function loanSide(row: LoanRow): ScenarioLoanSide {
  return {
    payoffDate: row.payoffDate,
    monthsToPayoff: row.monthsToPayoff,
    totalInterest: row.projection.totalInterest,
    periodOutlay: row.periodOutlay,
    effectiveBalance: row.effectiveBalance,
    interestPerYear: row.interestPerYear,
  };
}

function budgetSide(line: BudgetReportLine): ScenarioBudgetSide {
  return {
    effectiveLimit: line.effectiveLimit,
    spent: line.spent,
    projected: line.projected,
    projectedRemaining: line.projectedRemaining,
    status: line.status,
  };
}

function goalSide(line: GoalLine): ScenarioGoalSide {
  return {
    projectedDate: line.projectedDate,
    allocatedPerMonth: line.allocatedPerMonth,
    requiredPerMonth: line.requiredPerMonth,
    shortfallPerMonth: line.shortfallPerMonth,
    status: line.status,
  };
}

/** Whole days between two ISO dates; null when either is missing. */
function daysApart(from: string | null, to: string | null): number | null {
  if (!from || !to) return null;
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86400000);
}

function allBudgetLines(report: BudgetReport): BudgetReportLine[] {
  return [...(report.overall ? [report.overall] : []), ...report.categories];
}

export interface CompareParams {
  scenario: Scenario;
  resolved: ResolvedChange[];
  asOf: string;
  month: string;
  before: { forecast: CashFlowForecast; loans: LoanReport; budgets: BudgetReport; goals: GoalReport };
  after: { forecast: CashFlowForecast; loans: LoanReport; budgets: BudgetReport; goals: GoalReport };
}

/**
 * Put the two runs side by side.
 *
 * A row appears when the scenario MOVED it, or when the scenario names that
 * record by hand — an extra repayment the loan cannot use still deserves its
 * row, saying so, rather than vanishing as though nothing had been asked.
 */
export function buildScenarioComparison(p: CompareParams): ScenarioComparison {
  const { before, after, resolved } = p;

  const cash: ScenarioCashLine[] = before.forecast.horizons.map((b, i) => {
    const a = after.forecast.horizons[i] ?? b;
    return {
      days: b.days,
      date: b.date,
      before: b,
      after: a,
      netChange: round2(a.net - b.net),
      balanceChange: round2(a.projectedBalance - b.projectedBalance),
      lowestChange: round2(a.lowestBalance - b.lowestBalance),
      newlyNegative: b.lowestBalance >= 0 && a.lowestBalance < 0,
    };
  });

  const namedLoans = new Set(resolved.map(r => r.loan?.loanId).filter(Boolean) as string[]);
  const loans: ScenarioLoanLine[] = [];
  for (const b of before.loans.rows) {
    const a = after.loans.rows.find(r => r.id === b.id);
    if (!a) continue;
    const bs = loanSide(b);
    const as = loanSide(a);
    const moved = bs.payoffDate !== as.payoffDate
      || Math.abs(as.totalInterest - bs.totalInterest) > EPS
      || Math.abs(as.periodOutlay - bs.periodOutlay) > EPS
      || Math.abs(as.effectiveBalance - bs.effectiveBalance) > EPS;
    if (!moved && !namedLoans.has(b.id)) continue;
    loans.push({
      id: b.id,
      name: b.name,
      before: bs,
      after: as,
      monthsSaved: bs.monthsToPayoff != null && as.monthsToPayoff != null
        ? round2(bs.monthsToPayoff - as.monthsToPayoff)
        : null,
      interestSaved: round2(bs.totalInterest - as.totalInterest),
      outlayChange: round2(as.periodOutlay - bs.periodOutlay),
    });
  }

  const beforeBudgets = allBudgetLines(before.budgets);
  const afterBudgets = allBudgetLines(after.budgets);
  const budgets: ScenarioBudgetLine[] = [];
  for (const b of beforeBudgets) {
    const a = afterBudgets.find(l => l.key === b.key);
    if (!a) continue;
    if (Math.abs(a.projected - b.projected) <= EPS && a.status === b.status) continue;
    budgets.push({
      key: b.key,
      name: b.name,
      category: b.category,
      before: budgetSide(b),
      after: budgetSide(a),
      projectedChange: round2(a.projected - b.projected),
      newlyOver: b.projectedRemaining >= 0 && a.projectedRemaining < 0,
      newlyUnder: b.projectedRemaining < 0 && a.projectedRemaining >= 0,
    });
  }

  const namedGoals = new Set(resolved.map(r => r.goal?.goalId).filter(Boolean) as string[]);
  const goals: ScenarioGoalLine[] = [];
  for (const b of before.goals.lines) {
    const a = after.goals.lines.find(l => l.id === b.id);
    if (!a) continue;
    const bs = goalSide(b);
    const as = goalSide(a);
    const moved = bs.projectedDate !== as.projectedDate
      || bs.status !== as.status
      || Math.abs(as.allocatedPerMonth - bs.allocatedPerMonth) > EPS;
    if (!moved && !namedGoals.has(b.id)) continue;
    const onTrack = (s: GoalStatus) => s === 'on-track' || s === 'complete';
    goals.push({
      id: b.id,
      name: b.name,
      before: bs,
      after: as,
      daysEarlier: bs.projectedDate && as.projectedDate
        ? daysApart(as.projectedDate, bs.projectedDate)
        : null,
      newlyOnTrack: !onTrack(bs.status) && onTrack(as.status),
      newlyOffTrack: onTrack(bs.status) && !onTrack(as.status),
    });
  }

  const monthlyCashChange = round2(resolved.reduce((s, r) => s + r.monthlyCash, 0));
  // Money that moves ONCE — a purchase, or a payment straight off a loan. Both
  // are single events rather than rates, so neither belongs in the per-month
  // figure; they show up in the horizons and here.
  const oneOffTotal = round2(
    resolved.reduce((s, r) => {
      if (r.change.kind === 'one-off') return s + num(r.change.amount);
      if (r.change.kind === 'lump-sum') return s + Math.abs(num(r.change.amount));
      return s;
    }, 0),
  );

  const notes: ScenarioNote[] = resolved.flatMap(r => r.notes);

  // A commitment bigger than the cash the forecast expects to have spare is
  // still projected — the user may well mean to fund it by other means — but it
  // is never left unsaid.
  const committed = Object.values(scenarioGoalCommitments(resolved)).reduce((s, n) => s + n, 0);
  const capacity = after.goals.monthlyCapacity;
  if (committed > 0 && capacity != null && committed > Math.max(0, capacity) + EPS) {
    notes.push(note('warning', null,
      `You have committed ${money(committed)} a month to your goals, and the forecast expects ${money(Math.max(0, capacity))} a month spare. The rest has to come from somewhere else.`));
  }

  const unchanged = cash.every(c => Math.abs(c.balanceChange) <= EPS)
    && loans.length === 0 && budgets.length === 0 && goals.length === 0;

  return {
    asOf: p.asOf,
    month: p.month,
    scenario: p.scenario,
    resolved,
    cash, loans, budgets, goals,
    monthlyCashChange,
    oneOffTotal,
    unchanged,
    notes,
  };
}

// ─── Applying a scenario for real ───────────────────────────────────────────

/**
 * Whether a change can be written into Ledger, and what writing it would do.
 *
 * A scenario is a question; applying is a different act entirely, and the user
 * is told exactly which records would be created or edited BEFORE any of it
 * happens. Some changes have no record to write — a decision to spend less is a
 * decision, not a row — and saying so plainly is better than inventing a
 * transaction to represent an intention.
 */
export interface ScenarioApplicability {
  changeId: string;
  canApply: boolean;
  /** What applying would do, in the user's terms. Always populated. */
  description: string;
}

export function applicability(change: ScenarioChange, base: ScenarioBaselines): ScenarioApplicability {
  const no = (description: string): ScenarioApplicability => ({ changeId: change.id, canApply: false, description });
  const yes = (description: string): ScenarioApplicability => ({ changeId: change.id, canApply: true, description });

  switch (change.kind) {
    case 'spending':
      return no('Spending less is a decision, not a record. Ledger will see it in your transactions as it happens — there is nothing to save.');
    case 'savings-contribution':
      return no('Ledger records contributions when the money moves. Add the deposit against the goal once it has.');
    case 'income': {
      if (!change.incomeId) return no('Add the new pay to Income once it lands — Ledger records income you have actually received.');
      const monthly = num(base.monthlyIncomeById[change.incomeId]);
      if (monthly <= 0) return no('Ledger has no recurring amount on file for that income to change.');
      return yes('Updates the amount on that recurring income entry.');
    }
    case 'recurring-expense': {
      if (!change.amount) return no('Nothing to save: the amount is zero.');
      return yes(`Creates a recurring ${change.frequency} expense called "${change.name || 'New expense'}".`);
    }
    case 'one-off': {
      if (!change.amount || !change.date) return no('Nothing to save: a one-off needs an amount and a date.');
      if (num(change.amount) < 0) return no('Money coming in is recorded as income once it arrives, not as a bill.');
      return yes(`Adds a bill for "${change.name || 'One-off'}" due ${change.date}.`);
    }
    case 'extra-repayment': {
      const loan = base.loans.find(l => l.id === change.loanId);
      if (!loan) return no('That loan is no longer in Ledger.');
      if (!change.amountPerPeriod) return no('Nothing to save: the amount is zero.');
      return yes(`Sets a standing extra repayment on ${loan.name}.`);
    }
    case 'lump-sum': {
      const loan = base.loans.find(l => l.id === change.loanId);
      if (!loan) return no('That loan is no longer in Ledger.');
      if (!change.amount) return no('Nothing to save: the amount is zero.');
      const paid = Math.min(Math.abs(num(change.amount)), loan.balance);
      if (paid <= 0) return no(`${loan.name} has nothing owing to pay off.`);
      return yes(`Takes ${money(paid)} off the balance recorded against ${loan.name}, leaving ${money(loan.balance - paid)} owing.`);
    }
    case 'offset': {
      const loan = base.loans.find(l => l.id === change.loanId);
      if (!loan) return no('That loan is no longer in Ledger.');
      if (loan.offsetIsLinked) {
        return no(`${loan.name}'s offset tracks a real account, so it changes when the money actually moves — Ledger will not type a balance over it.`);
      }
      if (!change.delta) return no('Nothing to save: the amount is zero.');
      return yes(`Changes the offset recorded against ${loan.name}.`);
    }
  }
}

/** A scenario is worth applying when at least one of its changes can be. */
export function applicableChanges(scenario: Scenario, base: ScenarioBaselines): ScenarioApplicability[] {
  return activeChanges(scenario).map(c => applicability(c, base));
}

// ─── Odds and ends the UI needs and should not re-derive ────────────────────

/** A blank change of the given kind, ready to be filled in. */
export function emptyChange(kind: ScenarioChangeKind, id: string, asOf: string): ScenarioChange {
  switch (kind) {
    case 'income':
      return { id, kind, label: '', incomeId: null, mode: 'percent', value: 5, startDate: null };
    case 'spending':
      return { id, kind, label: '', category: null, mode: 'percent', value: -10 };
    case 'recurring-expense':
      return { id, kind, label: '', name: '', amount: 0, frequency: 'monthly', category: null, startDate: null };
    case 'one-off':
      return { id, kind, label: '', name: '', amount: 0, date: addMonths(asOf, 1), category: null };
    case 'extra-repayment':
      return { id, kind, label: '', loanId: '', amountPerPeriod: 0 };
    case 'lump-sum':
      return { id, kind, label: '', loanId: '', amount: 0 };
    case 'offset':
      return { id, kind, label: '', loanId: '', delta: 0 };
    case 'savings-contribution':
      return { id, kind, label: '', goalId: '', monthlyAmount: 0 };
  }
}


export type { AccountBalanceInput };
