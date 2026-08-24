/**
 * Phase 9.1 — Ask Ledger: the ANSWER. PURE.
 *
 * Every question Ask Ledger answers ends here, as an `AskAnswer`: the figures
 * Ledger's own engines computed, the records they came from, the deep links to
 * go and check them, and — just as importantly — the GAPS: what Ledger doesn't
 * know and therefore didn't answer.
 *
 * Three laws, each enforced by code in this file rather than by a prompt:
 *
 *   1. **The numbers are Ledger's.** `AskFacts` is built by `askDS` from the
 *      same engines the screens read (budgeting, cashFlowForecast, loanEngine,
 *      taxYear, savingsGoals, insights). Nothing here computes a financial
 *      figure and nothing here accepts one from outside.
 *
 *   2. **The AI may only re-word what is already true.** `describeAnswer()` is
 *      the deterministic sentence, and it is the DEFAULT. When a model rephrases
 *      it, `checkPhrasing()` compares every number in the model's prose against
 *      `citedValues()` — the closed set of figures this answer is allowed to
 *      state. A single number that isn't in that set fails the check and the
 *      deterministic sentence is used instead. A model therefore cannot invent
 *      a figure, however confidently it writes.
 *
 *   3. **Missing data is an answer.** No transactions, no budget, a goal with
 *      no target date, an offset linked to a deleted account, a category the
 *      user doesn't have — each becomes an `AskGap` the UI shows. Ask Ledger
 *      never fills a hole with an estimate and never says nothing.
 *
 * READ-ONLY by construction: this module and `askDS.answer()` import no
 * mutator. Asking a question can change nothing.
 */

import type { AskIntentName, AskPeriod, UnresolvedSlot } from './askIntent';
import { formatCurrency } from './format';

// ─── Presentation-ready pieces ───────────────────────────────────────────────

export type FigureKind = 'money' | 'percent' | 'count' | 'date' | 'text' | 'months';

export interface AskFigure {
  /** Stable key — the UI's react key, and what tests assert on. */
  key: string;
  label: string;
  value: number | string;
  kind: FigureKind;
  /** The headline figure the answer is really about. At most one per answer. */
  emphasis?: boolean;
  /** Whether this reads as good or bad news. Presentation only. */
  tone?: 'good' | 'bad' | 'neutral';
  /** Extra context, e.g. "across 42 transactions". */
  note?: string;
}

/** Where a figure came from, and how to go and look at it. */
export interface AskSource {
  kind:
    | 'transactions' | 'budget' | 'goal' | 'loan' | 'forecast' | 'tax'
    | 'bill' | 'account' | 'insight' | 'property' | 'income' | 'net-worth';
  label: string;
  detail?: string;
  /** An in-app path, ready for `navigate()`. Absent when there is no screen. */
  to?: string;
  /** How many records this source stands for, when it stands for records. */
  count?: number;
}

export type AskGapKind =
  /** Nothing at all to answer from. */
  | 'no-data'
  /** The history doesn't reach back as far as the question. */
  | 'partial-history'
  /** The question named something the user doesn't have. */
  | 'unresolved'
  /** The engine could answer, but a needed input is missing (no target date…). */
  | 'incomplete-record'
  /** Two records disagree — reported, never silently reconciled. */
  | 'conflict'
  /** Ledger cannot answer this question at all. */
  | 'unsupported'
  /** The answer is scoped, and the user may be expecting a different scope. */
  | 'scope';

export interface AskGap {
  kind: AskGapKind;
  message: string;
  /** Where the user would go to fix it. */
  to?: string;
}

// ─── Facts, one shape per question ───────────────────────────────────────────

export interface CategorySlice {
  category: string;
  total: number;
  /** Share of the window's spend, 0–100. */
  share: number;
  count: number;
}

export interface MerchantSlice {
  merchant: string;
  total: number;
  count: number;
}

export interface GoalFact {
  id: string;
  name: string;
  target: number;
  saved: number;
  /** 0–100, capped at 100 for display; `saved/target` may exceed it. */
  percent: number;
  status: string;
  onTrack: boolean | null;
  targetDate: string | null;
  projectedDate: string | null;
  requiredPerMonth: number | null;
  shortfall: number;
}

export interface OffsetFact {
  loanId: string;
  loanName: string;
  balance: number;
  offset: number;
  effectiveBalance: number;
  rate: number;
  savingPerYear: number;
  savingPerMonth: number;
  accountName: string | null;
  linked: boolean;
  linkBroken: boolean;
}

export interface LoanPayoffFact {
  loanId: string;
  loanName: string;
  balance: number;
  rate: number;
  repayment: number;
  frequency: string;
  monthsToPayoff: number | null;
  payoffDate: string | null;
  interestPerYear: number;
  contractEndDate: string | null;
  monthsAheadOfContract: number | null;
}

export interface DeductionSlice {
  category: string;
  total: number;
  share: number;
  count: number;
}

export interface ForecastMovement {
  name: string;
  amount: number;
  date: string;
  type: string;
}

export interface BudgetLineFact {
  category: string;
  limit: number;
  spent: number;
  projected: number;
  remaining: number;
  status: string;
}

export interface BillFact {
  id: string;
  name: string;
  amount: number;
  dueDate: string;
  daysUntil: number;
}

export interface ChangeFact {
  title: string;
  detail: string;
  amount: number;
  direction: 'improving' | 'worsening' | 'neutral';
  to?: string;
}

export type AskFacts =
  | {
    kind: 'spend-total';
    period: AskPeriod;
    total: number;
    count: number;
    categories: CategorySlice[];
    previousTotal: number | null;
    delta: number | null;
  }
  | {
    kind: 'spend-category';
    period: AskPeriod;
    category: string;
    total: number;
    count: number;
    /** Share of ALL spend in the window, 0–100. */
    share: number;
    totalSpend: number;
    merchants: MerchantSlice[];
    previousTotal: number | null;
    delta: number | null;
    /** Average per month across the window, when it spans more than one. */
    perMonth: number | null;
  }
  | {
    kind: 'spend-top';
    period: AskPeriod;
    total: number;
    count: number;
    categories: CategorySlice[];
  }
  | {
    kind: 'forecast-outlook';
    asOf: string;
    horizonDays: number;
    opening: number;
    closing: number;
    net: number;
    inflow: number;
    outflow: number;
    lowestBalance: number;
    lowestDate: string | null;
    /** First day the projection goes below zero, when it does. */
    negativeFrom: string | null;
    biggestOutflows: ForecastMovement[];
    /** Movements the engine is less than certain about. */
    uncertainCount: number;
  }
  | {
    kind: 'budget-status';
    month: string;
    monthLabel: string;
    budgeted: number;
    spent: number;
    remaining: number;
    projected: number;
    over: BudgetLineFact[];
    lines: BudgetLineFact[];
  }
  | {
    kind: 'goal-progress';
    asOf: string;
    goals: GoalFact[];
    /** Named in the question, when one was. */
    focus: string | null;
    /**
     * The question named a goal Ledger could not confidently place.
     *
     * When this is set, `goals` is EMPTY on purpose: the answer is about the
     * name that couldn't be found, not about whichever goals happen to exist.
     * Reporting the only goal, or the nearest one, would read as an answer to
     * a question nobody asked.
     */
    unmatched: {
      requested: string;
      /** What it might have meant — offered, never chosen. */
      suggestions: string[];
      /** The goals the user does have, in this scope. */
      available: string[];
    } | null;
    totalTarget: number;
    totalSaved: number;
    /** Spare cash the forecast expects, when it could be built. */
    surplus: number | null;
    surplusDays: number | null;
  }
  | {
    kind: 'loan-offset';
    loans: OffsetFact[];
    totalOffset: number;
    totalSavingPerYear: number;
    totalSavingPerMonth: number;
  }
  | {
    kind: 'loan-payoff';
    loans: LoanPayoffFact[];
    totalBalance: number;
    totalInterestPerYear: number;
    debtFreeDate: string | null;
  }
  | {
    kind: 'tax-deductions';
    fy: string;
    total: number;
    lineCount: number;
    manualTotal: number;
    transactionTotal: number;
    rentalTotal: number;
    businessTotal: number;
    personalTotal: number;
    refundedTotal: number;
    categories: DeductionSlice[];
    suspectedDuplicates: number;
  }
  | {
    kind: 'tax-position';
    fy: string;
    assessableIncome: number;
    deductibleExpenses: number;
    estimatedTaxableIncome: number;
    taxWithheld: number;
    notes: string[];
  }
  | {
    kind: 'income-total';
    period: AskPeriod;
    total: number;
    count: number;
    sources: MerchantSlice[];
  }
  | {
    kind: 'net-worth';
    asOf: string;
    net: number;
    assets: number;
    liabilities: number;
    bank: number;
    investments: number;
    superBalance: number;
    property: number;
    loans: number;
    cardDebt: number;
    scope: 'personal' | 'household';
    householdName: string | null;
  }
  | {
    kind: 'bills-upcoming';
    from: string;
    to: string;
    days: number;
    total: number;
    bills: BillFact[];
  }
  | {
    kind: 'insights-changes';
    from: string;
    to: string;
    days: number;
    changes: ChangeFact[];
    spend: number;
    previousSpend: number;
    delta: number;
  }
  | {
    kind: 'unknown';
    /** What Ledger understood, so the user can rephrase usefully. */
    reason: string;
  };

// ─── The answer ──────────────────────────────────────────────────────────────

export interface AskAnswer {
  /** The question, verbatim. */
  question: string;
  intent: AskIntentName;
  /** How the question was understood. Always shown — never a black box. */
  interpretation: 'rules' | 'ai';
  confidence: number;
  facts: AskFacts;
  /** The deterministic sentence. Replaced by AI prose only after `checkPhrasing`. */
  headline: string;
  figures: AskFigure[];
  sources: AskSource[];
  gaps: AskGap[];
  /** The window the answer covers, when it has one. */
  period: AskPeriod | null;
  /** 'personal' or the household the answer was computed in. */
  scope: 'personal' | 'household';
  scopeLabel: string;
  /** ISO timestamp-free date the answer was computed for. */
  asOf: string;
}

// ─── Formatting helpers ──────────────────────────────────────────────────────

function money(n: number, currency: string): string {
  return formatCurrency(Math.abs(n) < 0.005 ? 0 : n, currency);
}

function pct(n: number): string {
  return `${Math.round(n)}%`;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function dateLabel(iso: string | null): string {
  if (!iso) return 'an unknown date';
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  const months = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
  return `${d} ${months[m - 1]} ${y}`;
}

function list(items: string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

// ─── The deterministic sentence ──────────────────────────────────────────────

/**
 * State the answer in plain English, from the facts alone.
 *
 * This is what the user reads when no model is available, and it is the
 * yardstick every model rephrasing is measured against. It states figures and
 * nothing else: no advice, no speculation about causes the engines didn't
 * identify, and no number that isn't in `facts`.
 */
export function describeAnswer(facts: AskFacts, currency: string): string {
  switch (facts.kind) {
    case 'spend-total': {
      if (facts.count === 0) {
        return `Ledger has no spending recorded for ${facts.period.label}.`;
      }
      const top = facts.categories[0];
      const base = `You spent ${money(facts.total, currency)} ${facts.period.label}, across ${plural(facts.count, 'transaction')}.`;
      const lead = top ? ` The largest category was ${top.category} at ${money(top.total, currency)}.` : '';
      const move = facts.delta === null
        ? ''
        : ` That is ${money(Math.abs(facts.delta), currency)} ${facts.delta >= 0 ? 'more' : 'less'} than the period before.`;
      return base + lead + move;
    }

    case 'spend-category': {
      if (facts.count === 0) {
        return `Ledger has no ${facts.category} spending recorded for ${facts.period.label}.`;
      }
      const base = `You spent ${money(facts.total, currency)} on ${facts.category} ${facts.period.label}, across ${plural(facts.count, 'transaction')}.`;
      const share = facts.totalSpend > 0
        ? ` That is ${pct(facts.share)} of everything you spent in that window.`
        : '';
      const rate = facts.perMonth !== null
        ? ` It averages ${money(facts.perMonth, currency)} a month.`
        : '';
      const move = facts.delta === null
        ? ''
        : ` The period before came to ${money(facts.previousTotal ?? 0, currency)}.`;
      return base + share + rate + move;
    }

    case 'spend-top': {
      if (facts.categories.length === 0) {
        return `Ledger has no spending recorded for ${facts.period.label}.`;
      }
      const named = facts.categories.slice(0, 3)
        .map(c => `${c.category} ${money(c.total, currency)}`);
      return `You spent ${money(facts.total, currency)} ${facts.period.label}. The biggest categories were ${list(named)}.`;
    }

    case 'forecast-outlook': {
      const direction = facts.net < 0 ? 'falls' : facts.net > 0 ? 'rises' : 'holds';
      const base = `Over the next ${plural(facts.horizonDays, 'day')} your projected balance ${direction} from ${money(facts.opening, currency)} to ${money(facts.closing, currency)} — ${money(facts.inflow, currency)} coming in against ${money(facts.outflow, currency)} going out.`;
      const low = facts.lowestDate
        ? ` The low point is ${money(facts.lowestBalance, currency)} on ${dateLabel(facts.lowestDate)}.`
        : '';
      const negative = facts.negativeFrom
        ? ` It goes below zero from ${dateLabel(facts.negativeFrom)}.`
        : '';
      const drivers = facts.biggestOutflows.length
        ? ` The largest outgoings are ${list(facts.biggestOutflows.slice(0, 3).map(o => `${o.name} ${money(o.amount, currency)}`))}.`
        : '';
      return base + low + negative + drivers;
    }

    case 'budget-status': {
      if (facts.lines.length === 0) {
        return `You have no budgets set, so there is nothing to track ${facts.monthLabel} against.`;
      }
      const base = `In ${facts.monthLabel} you have spent ${money(facts.spent, currency)} of ${money(facts.budgeted, currency)} budgeted, leaving ${money(facts.remaining, currency)}. Ledger projects ${money(facts.projected, currency)} by month end.`;
      const over = facts.over.length
        ? ` ${plural(facts.over.length, 'budget')} ${facts.over.length === 1 ? 'is' : 'are'} over: ${list(facts.over.map(l => l.category))}.`
        : ' No budget is over its cap.';
      return base + over;
    }

    case 'goal-progress': {
      // Asked about a goal that isn't there. Say so — and only that.
      if (facts.unmatched) {
        const { requested, suggestions, available } = facts.unmatched;
        const head = `You have no goal called "${requested}".`;
        if (suggestions.length) return `${head} Did you mean ${list(suggestions)}?`;
        if (available.length) {
          return `${head} Your goal${available.length === 1 ? ' is' : 's are'} ${list(available)}.`;
        }
        return `${head} You have no savings goals in Ledger yet.`;
      }
      if (facts.goals.length === 0) {
        return 'You have no savings goals in Ledger yet.';
      }
      if (facts.goals.length === 1 || facts.focus) {
        const g = facts.goals.find(x => x.name === facts.focus) ?? facts.goals[0];
        const base = `${g.name}: ${money(g.saved, currency)} of ${money(g.target, currency)} saved, ${pct(g.percent)} of the way there.`;
        const track = g.onTrack === null
          ? ' Ledger cannot say whether it lands on time — see below.'
          : g.onTrack
            ? ` At the current rate it lands${g.targetDate ? ` before ${dateLabel(g.targetDate)}` : ''}, so you are on track.`
            : ` At the current rate it does not land${g.targetDate ? ` by ${dateLabel(g.targetDate)}` : ' on time'}, so you are not on track.`;
        const need = g.requiredPerMonth
          ? ` Getting there needs ${money(g.requiredPerMonth, currency)} a month.`
          : '';
        return base + track + need;
      }
      const onTrack = facts.goals.filter(g => g.onTrack === true).length;
      const off = facts.goals.filter(g => g.onTrack === false);
      const base = `Across ${plural(facts.goals.length, 'goal')} you have saved ${money(facts.totalSaved, currency)} of ${money(facts.totalTarget, currency)}. ${onTrack} ${onTrack === 1 ? 'is' : 'are'} on track.`;
      const behind = off.length ? ` Behind: ${list(off.map(g => g.name))}.` : '';
      return base + behind;
    }

    case 'loan-offset': {
      if (facts.loans.length === 0) {
        return 'None of your loans has an offset account, so no interest is being offset.';
      }
      const broken = facts.loans.filter(l => l.linkBroken);
      if (facts.totalOffset === 0 && broken.length === 0) {
        return 'Your offset accounts are empty, so they are saving no interest right now.';
      }
      const one = facts.loans.length === 1 ? facts.loans[0] : null;
      const base = one
        ? `${money(one.offset, currency)} offsetting ${one.loanName} saves ${money(one.savingPerYear, currency)} of interest a year — ${money(one.savingPerMonth, currency)} a month — by reducing what the ${one.rate}% rate is charged on from ${money(one.balance, currency)} to ${money(one.effectiveBalance, currency)}.`
        : `Your offsets hold ${money(facts.totalOffset, currency)} and save ${money(facts.totalSavingPerYear, currency)} of interest a year — ${money(facts.totalSavingPerMonth, currency)} a month.`;
      const warn = broken.length
        ? ` ${list(broken.map(l => l.loanName))} ${broken.length === 1 ? 'points' : 'point'} at an account Ledger can no longer find, so ${broken.length === 1 ? 'it is' : 'they are'} offsetting nothing.`
        : '';
      return base + warn;
    }

    case 'loan-payoff': {
      if (facts.loans.length === 0) return 'You have no loans in Ledger.';
      const one = facts.loans.length === 1 ? facts.loans[0] : null;
      if (one) {
        const when = one.payoffDate
          ? `clears on ${dateLabel(one.payoffDate)}`
          : 'has no projected payoff date on file';
        return `${one.loanName} owes ${money(one.balance, currency)} at ${one.rate}% and ${when}. It costs ${money(one.interestPerYear, currency)} of interest a year at today's balance.`;
      }
      const free = facts.debtFreeDate ? ` You are debt-free on ${dateLabel(facts.debtFreeDate)}.` : '';
      return `Across ${plural(facts.loans.length, 'loan')} you owe ${money(facts.totalBalance, currency)}, costing ${money(facts.totalInterestPerYear, currency)} of interest a year.${free}`;
    }

    case 'tax-deductions': {
      if (facts.lineCount === 0) {
        return `You have no deductions recorded for FY ${facts.fy}.`;
      }
      const base = `You have ${money(facts.total, currency)} of deductions for FY ${facts.fy}, across ${plural(facts.lineCount, 'line')}.`;
      const split = ` ${money(facts.manualTotal, currency)} entered by hand, ${money(facts.transactionTotal, currency)} from flagged transactions${facts.rentalTotal ? `, ${money(facts.rentalTotal, currency)} from the rental schedule` : ''}.`;
      const top = facts.categories.length
        ? ` The largest categories are ${list(facts.categories.slice(0, 3).map(c => `${c.category} ${money(c.total, currency)}`))}.`
        : '';
      const dupes = facts.suspectedDuplicates
        ? ` ${plural(facts.suspectedDuplicates, 'possible duplicate')} still needs review.`
        : '';
      return base + split + top + dupes;
    }

    case 'tax-position': {
      return `For FY ${facts.fy} Ledger has ${money(facts.assessableIncome, currency)} of assessable income and ${money(facts.deductibleExpenses, currency)} of deductions, giving an estimated taxable income of ${money(facts.estimatedTaxableIncome, currency)}. ${money(facts.taxWithheld, currency)} has been withheld.`;
    }

    case 'income-total': {
      if (facts.count === 0) {
        return `Ledger has no income recorded for ${facts.period.label}.`;
      }
      const top = facts.sources[0];
      return `You received ${money(facts.total, currency)} ${facts.period.label}, across ${plural(facts.count, 'payment')}.${top ? ` The largest source was ${top.merchant} at ${money(top.total, currency)}.` : ''}`;
    }

    case 'net-worth': {
      return `Your ${facts.scope === 'household' ? 'household ' : ''}net worth is ${money(facts.net, currency)} — ${money(facts.assets, currency)} of assets against ${money(facts.liabilities, currency)} of debt.`;
    }

    case 'bills-upcoming': {
      if (facts.bills.length === 0) {
        return `Nothing is due in the next ${plural(facts.days, 'day')}.`;
      }
      const next = facts.bills[0];
      return `${plural(facts.bills.length, 'bill')} totalling ${money(facts.total, currency)} ${facts.bills.length === 1 ? 'is' : 'are'} due in the next ${plural(facts.days, 'day')}. Next up is ${next.name}, ${money(next.amount, currency)} on ${dateLabel(next.dueDate)}.`;
    }

    case 'insights-changes': {
      if (facts.changes.length === 0) {
        return `Nothing notable changed in the last ${plural(facts.days, 'day')}. You spent ${money(facts.spend, currency)}, against ${money(facts.previousSpend, currency)} in the window before.`;
      }
      const named = facts.changes.slice(0, 3).map(c => c.title);
      return `Spending over the last ${plural(facts.days, 'day')} came to ${money(facts.spend, currency)}, against ${money(facts.previousSpend, currency)} before. The changes worth knowing about: ${list(named)}.`;
    }

    case 'unknown':
      return facts.reason;
  }
}

// ─── The guard on AI prose ───────────────────────────────────────────────────

/**
 * Every numeric value this answer is ALLOWED to state.
 *
 * Built from the figures the engines produced, plus the dates and counts the
 * answer legitimately mentions. `checkPhrasing` tests a model's sentence
 * against exactly this set — so the set is the answer's whole factual budget.
 */
export function citedValues(answer: AskAnswer): number[] {
  const out: number[] = [];
  const push = (v: unknown) => {
    if (typeof v === 'number' && Number.isFinite(v)) out.push(v);
  };

  for (const f of answer.figures) {
    if (typeof f.value === 'number') push(f.value);
    else for (const n of numbersIn(String(f.value))) push(n);
  }

  // Facts carry more than the headline figures — every leaf number in them is
  // Ledger's own, so all of them are fair to quote.
  const walk = (value: unknown, depth = 0) => {
    if (depth > 6) return;
    if (typeof value === 'number') { push(value); return; }
    if (typeof value === 'string') { for (const n of numbersIn(value)) push(n); return; }
    if (Array.isArray(value)) { for (const v of value) walk(v, depth + 1); return; }
    if (value && typeof value === 'object') {
      for (const v of Object.values(value as Record<string, unknown>)) walk(v, depth + 1);
    }
  };
  walk(answer.facts);

  if (answer.period) {
    for (const n of numbersIn(`${answer.period.from} ${answer.period.to} ${answer.period.label}`)) push(n);
  }
  for (const n of numbersIn(answer.question)) push(n);
  for (const n of numbersIn(answer.asOf)) push(n);

  return out;
}

/**
 * Numbers appearing in a string: `$1,234.56`, `12%`, `2026-08-24`, `42`.
 *
 * The lookbehind stops the hyphen in a date being read as a minus sign, which
 * would turn `2026-08-24` into the year and two negative numbers and let a
 * fabricated `-8` match a real `8` through the absolute-value comparison below.
 */
export function numbersIn(text: string): number[] {
  const out: number[] = [];
  const re = /(?<![\d.])-?\d[\d,]*(?:\.\d+)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const n = Number(m[0].replace(/,/g, ''));
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

/**
 * Two figures are "the same number" when they agree to the cent, or round to
 * the same whole unit — a model writing "$1,235" for 1234.56 is quoting.
 *
 * Deliberately TIGHT. A percentage tolerance was tried and removed: at 0.5% of
 * a five-figure total it let a genuinely invented number through, and worse, it
 * let "in 2024" pass as a rounding of the year 2026. There is no cost to being
 * strict here — a rejected rewording costs the user nothing, because the
 * fallback is Ledger's own correct sentence.
 */
function matches(candidate: number, allowed: number): boolean {
  const a = Math.abs(candidate);
  const b = Math.abs(allowed);
  if (Math.abs(a - b) < 0.005) return true;
  return Math.round(a) === Math.round(b);
}

export interface PhrasingCheck {
  ok: boolean;
  /** The numbers in the prose that this answer never computed. */
  invented: number[];
}

/**
 * Does this prose only state figures the answer actually holds?
 *
 * The structural stop on a model inventing money. Numbers between 0 and 100
 * that the answer doesn't hold are still rejected — "about 30% of your
 * spending" is exactly the kind of plausible fabrication this exists to catch.
 * Small counting words the prose needs to be readable ("the top 3") are allowed
 * only when they are integers under 13 AND the answer holds a list at least
 * that long, so a count can never smuggle in a dollar figure.
 */
export function checkPhrasing(prose: string, answer: AskAnswer): PhrasingCheck {
  const allowed = citedValues(answer);
  const listLengths = maxListLength(answer.facts);
  const invented: number[] = [];

  for (const n of numbersIn(prose)) {
    if (allowed.some(a => matches(n, a))) continue;
    if (Number.isInteger(n) && n > 0 && n <= 12 && n <= listLengths) continue;
    invented.push(n);
  }

  return { ok: invented.length === 0, invented };
}

/** The longest list inside the facts — the ceiling on "the top N" phrasing. */
function maxListLength(facts: AskFacts): number {
  let max = 0;
  const walk = (value: unknown, depth = 0) => {
    if (depth > 6) return;
    if (Array.isArray(value)) {
      if (value.length > max) max = value.length;
      for (const v of value) walk(v, depth + 1);
      return;
    }
    if (value && typeof value === 'object') {
      for (const v of Object.values(value as Record<string, unknown>)) walk(v, depth + 1);
    }
  };
  walk(facts);
  return max;
}

/**
 * Choose the prose the user reads.
 *
 * The model's sentence only wins if it passes the number check AND actually
 * says something; anything else falls back to the deterministic sentence, with
 * the reason recorded so the UI can say the answer was written by Ledger.
 */
export function resolvePhrasing(
  answer: AskAnswer,
  aiProse: string | null | undefined,
): { text: string; source: 'ledger' | 'ai'; rejected?: number[] } {
  const candidate = (aiProse ?? '').trim();
  if (!candidate) return { text: answer.headline, source: 'ledger' };
  // A rephrasing that is wildly longer than the facts warrant is a model
  // padding with narrative; keep it bounded.
  if (candidate.length > 1200) return { text: answer.headline, source: 'ledger' };

  const check = checkPhrasing(candidate, answer);
  if (!check.ok) return { text: answer.headline, source: 'ledger', rejected: check.invented };
  return { text: candidate, source: 'ai' };
}

// ─── Gaps ────────────────────────────────────────────────────────────────────

/** Turn slots the question reached for but Ledger couldn't place into gaps. */
/**
 * What to say about a named record that isn't there.
 *
 * Three sentences and no fourth: it doesn't exist; here is what you may have
 * meant; here is what you do have. None of them is an answer about a
 * different record.
 */
function missingRecord(kind: 'goal' | 'loan' | 'property', u: UnresolvedSlot): string {
  const head = `Ledger has no ${kind} called "${u.requested}".`;
  const suggestions = (u.suggestions ?? []).filter(Boolean);
  if (suggestions.length === 1) return `${head} Did you mean ${suggestions[0]}?`;
  if (suggestions.length > 1) return `${head} Did you mean ${list(suggestions)}?`;
  const available = (u.available ?? []).filter(Boolean);
  if (available.length) {
    return `${head} Your ${kind}${available.length === 1 ? ' is' : 's are'} ${list(available)}.`;
  }
  return `${head} You have no ${kind}s in Ledger yet.`;
}

export function gapsForUnresolved(unresolved: UnresolvedSlot[]): AskGap[] {
  const seen = new Set<string>();
  const out: AskGap[] = [];
  for (const u of unresolved) {
    const key = `${u.slot}:${u.requested.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    switch (u.slot) {
      case 'category':
        out.push({
          kind: 'unresolved',
          message: 'Ledger could not tell which category that question is about, so the answer covers all spending.',
          to: '/settings',
        });
        break;
      case 'goal':
        out.push({ kind: 'unresolved', message: missingRecord('goal', u), to: '/' });
        break;
      case 'loan':
        out.push({ kind: 'unresolved', message: missingRecord('loan', u), to: '/loans' });
        break;
      case 'property':
        out.push({ kind: 'unresolved', message: missingRecord('property', u), to: '/investments?tab=Property' });
        break;
      case 'financial-year':
        out.push({ kind: 'unresolved', message: `Ledger has no data for financial year ${u.requested}.`, to: '/tax' });
        break;
      case 'period':
        out.push({ kind: 'unresolved', message: `Ledger could not work out the period "${u.requested}".` });
        break;
    }
  }
  return out;
}

/**
 * The history gap: a question reaching back past what is loaded.
 *
 * Ledger loads a recent window of transactions on bootstrap, so a question
 * about last year can look like a year of no spending. Saying so is the whole
 * point — an answer of "$0" to "how much did I spend last year" is worse than
 * no answer at all.
 */
export function coverageGap(period: AskPeriod, coverageFrom: string): AskGap | null {
  if (period.kind === 'all-time') {
    return {
      kind: 'partial-history',
      message: `Ledger has transactions from ${dateLabel(coverageFrom)} onward — anything earlier isn't loaded, so "all time" means from that date.`,
      to: '/accounts',
    };
  }
  if (period.from >= coverageFrom) return null;
  return {
    kind: 'partial-history',
    message: `This period starts before Ledger's loaded history (${dateLabel(coverageFrom)}), so the figures cover only the part it can see.`,
    to: '/accounts',
  };
}

/** The scope note. A household answer says so; a personal one says so when the
 *  user is in a household and might have meant the other view. */
export function scopeGap(scope: 'personal' | 'household', householdName: string | null, inHousehold: boolean): AskGap | null {
  if (scope === 'household') {
    return {
      kind: 'scope',
      message: `This answer covers ${householdName ?? 'your household'} — the records shared to it, from every member.`,
      to: '/settings',
    };
  }
  if (inHousehold) {
    return {
      kind: 'scope',
      message: 'This answer covers your own records only. Switch to the household view to include what everyone has shared.',
      to: '/settings',
    };
  }
  return null;
}
