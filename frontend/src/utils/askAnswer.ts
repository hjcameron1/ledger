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

import type { AskIntent, AskIntentName, AskPeriod, UnresolvedSlot } from './askIntent';
import type { ScenarioApplicability, ScenarioComparison } from './scenario';
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
  /**
   * A supporting figure, shown only under "See calculation".
   *
   * The answer LEADS with the few figures that actually decide the question;
   * everything else — per-category breakdowns, per-merchant lists, component
   * balances — is still computed and still checkable, but behind one tap.
   */
  detail?: boolean;
}

/** Where a figure came from, and how to go and look at it. */
export interface AskSource {
  kind:
    | 'transactions' | 'budget' | 'goal' | 'loan' | 'forecast' | 'tax'
    | 'bill' | 'account' | 'insight' | 'property' | 'income' | 'net-worth'
    | 'insurance' | 'document';
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

/**
 * The previous hypothetical, and what this one adds on top of it.
 *
 * Every figure is a difference between two runs of the SAME engines — the
 * extra interest a bigger payment saves, the extra months it brings the payoff
 * forward, the extra money it takes to do. Nothing here is re-derived.
 */
export interface WhatIfVersus {
  /** The previous change in words: "$1,000 into the offset". */
  label: string;
  /** The loan or goal both runs moved, when they moved the same one. */
  subject: string | null;
  /** What the previous amount saved in interest, and what this one does. */
  interestSavedBefore: number | null;
  interestSavedAfter: number | null;
  /** …and the difference: what asking the bigger question actually buys. */
  extraInterestSaved: number | null;
  monthsSavedBefore: number | null;
  monthsSavedAfter: number | null;
  extraMonthsSaved: number | null;
  /** What each costs up front, and the difference. */
  costBefore: number | null;
  costAfter: number | null;
  extraCost: number | null;
}

/**
 * A record the question named that Ledger could not place.
 *
 * Carried on the FACTS rather than left as a gap beside them, because the
 * answer has to be built differently: when this is set the record list is
 * emptied, so no figure, source or link about a different record can reach the
 * user. To somebody with one loan, "all your loans" IS the loan they didn't
 * ask about.
 */
export interface UnmatchedRecord {
  requested: string;
  suggestions: string[];
  available: string[];
}

/** One policy, exactly as the insurance engine reports it. */
export interface PolicyFact {
  id: string;
  name: string;
  type: string;
  insurer: string | null;
  /** What it is billed, at `frequency`, and the same money a year and a month. */
  premium: number;
  frequency: string;
  annualPremium: number;
  monthlyPremium: number;
  renewalDate: string | null;
  daysToRenewal: number | null;
  excess: number | null;
  coverageAmount: number | null;
  status: string;
  /** What the yearly cost last moved by, when it has moved. */
  premiumChange: { delta: number; percent: number; date: string } | null;
  /** True when the policy has a document in the vault behind it. */
  hasDocument: boolean;
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
    unmatched: UnmatchedRecord | null;
    totalTarget: number;
    totalSaved: number;
    /** Spare cash the forecast expects, when it could be built. */
    surplus: number | null;
    surplusDays: number | null;
  }
  | {
    kind: 'loan-offset';
    /** A loan the question named that Ledger could not place. See `unmatched`
     *  on goal-progress: when it is set, `loans` is EMPTY on purpose. */
    unmatched: UnmatchedRecord | null;
    loans: OffsetFact[];
    totalOffset: number;
    totalSavingPerYear: number;
    totalSavingPerMonth: number;
  }
  | {
    kind: 'loan-payoff';
    unmatched: UnmatchedRecord | null;
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
    /**
     * Insurance, answered from the policies on file and — when there are none —
     * from what is sitting in the document vault.
     *
     * `documents` is metadata only: a name, a date, a provider. Ledger does not
     * read a PDF, so a policy it has never been told about is reported as an
     * uploaded document and NEVER described as cover. "You have a car policy
     * with NRMA" inferred from a filename is exactly the kind of confident
     * invention this whole feature is built not to do.
     */
    kind: 'insurance-cover';
    asOf: string;
    /** The policy the question named, when it named one. */
    focus: string | null;
    /** A name the question used that Ledger could not place. */
    unmatched: UnmatchedRecord | null;
    policies: PolicyFact[];
    totalAnnual: number;
    totalMonthly: number;
    totalCoverage: number;
    nextRenewal: { name: string; date: string; days: number } | null;
    /** Cover that has run out and has not been renewed. */
    expired: string[];
    /** Insurance documents in the vault. Named, never interpreted. */
    documents: { name: string; date: string | null; provider: string | null }[];
    /** True when the vault holds insurance paperwork and no policy is recorded. */
    documentsOnly: boolean;
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
    /**
     * A hypothetical, answered by running every engine twice.
     *
     * `comparison` holds BOTH columns — the before column is literally what the
     * Forecast, Loans, Budgets and Goals screens show right now — so nothing
     * here is re-derived and the answer cannot disagree with the pages it links
     * to. Null when the question could not be read as a change to anything, in
     * which case `reason` says so.
     */
    kind: 'what-if';
    asOf: string;
    /** How Ledger read the question. One line per change, always shown. */
    reading: string[];
    comparison: ScenarioComparison | null;
    /** Why nothing was modelled, when nothing was. */
    reason: string | null;
    /** What applying each change WOULD write. Computed; never performed. */
    applicability: ScenarioApplicability[];
    /** True when the scenario ran and moved nothing at all. */
    unchanged: boolean;
    /**
     * The hypothetical this one revises, run through the same engines.
     *
     * Set when the question was a follow-up — "what about $2,000?" after
     * "$1,000 into the offset". Somebody asking that already has the first
     * answer in front of them, and what they want to know is the DIFFERENCE.
     * Handing them the same shape of answer with different numbers in it makes
     * them diff two screens by eye, which is not an answer to what they asked.
     */
    versus: WhatIfVersus | null;
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
  interpretation: 'rules' | 'ai' | 'follow-up';
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

// ─── Lead vs detail ──────────────────────────────────────────────────────────

/** The most figures an answer may LEAD with. Everything past this is detail. */
export const ASK_LEAD_FIGURES = 4;

/**
 * Split an answer's figures into the few that answer the question and the rest.
 *
 * The builders mark breakdown figures `detail`, but the cap is enforced HERE so
 * no builder slip can turn the answer back into a dump: at most
 * `ASK_LEAD_FIGURES` lead figures survive, the emphasis figure always among
 * them, and the overflow joins the detail list in its original order.
 */
export function splitFigures(figures: AskFigure[]): { lead: AskFigure[]; detail: AskFigure[] } {
  const lead: AskFigure[] = [];
  const detail: AskFigure[] = [];
  for (const f of figures) (f.detail ? detail : lead).push(f);

  if (lead.length > ASK_LEAD_FIGURES) {
    const emphasis = lead.find(f => f.emphasis) ?? null;
    const kept = new Set<AskFigure>(emphasis ? [emphasis] : []);
    for (const f of lead) {
      if (kept.size >= ASK_LEAD_FIGURES) break;
      kept.add(f);
    }
    return {
      lead: lead.filter(f => kept.has(f)),
      detail: [...lead.filter(f => !kept.has(f)), ...detail],
    };
  }
  return { lead, detail };
}

/**
 * Split the gaps the same way.
 *
 * A gap LEADS when it changes what the answer means: nothing recorded, a name
 * that matched nothing, history that doesn't reach, a question Ledger can't
 * answer, or two records disagreeing. Advisory notes — scope reminders and
 * incomplete records that merely soften a figure — sit with the calculation.
 */
export function splitGaps(gaps: AskGap[]): { lead: AskGap[]; detail: AskGap[] } {
  const leadKinds: AskGapKind[] = ['no-data', 'unresolved', 'unsupported', 'partial-history', 'conflict'];
  return {
    lead: gaps.filter(g => leadKinds.includes(g.kind)),
    detail: gaps.filter(g => !leadKinds.includes(g.kind)),
  };
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
      const rate = facts.perMonth !== null
        ? ` It averages ${money(facts.perMonth, currency)} a month.`
        : '';
      const move = facts.delta === null
        ? ''
        : ` The period before came to ${money(facts.previousTotal ?? 0, currency)}.`;
      return base + rate + move;
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
      return base + low + negative;
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
      if (facts.unmatched) return missingNamed('goal', facts.unmatched);
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
      if (facts.unmatched) return missingNamed('loan', facts.unmatched);
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
      if (facts.unmatched) return missingNamed('loan', facts.unmatched);
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
      const top = facts.categories.length
        ? ` The largest categor${facts.categories.length === 1 ? 'y is' : 'ies are'} ${list(facts.categories.slice(0, 2).map(c => `${c.category} ${money(c.total, currency)}`))}.`
        : '';
      const dupes = facts.suspectedDuplicates
        ? ` ${plural(facts.suspectedDuplicates, 'possible duplicate')} still needs review.`
        : '';
      return base + top + dupes;
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

    case 'insurance-cover': {
      if (facts.unmatched) return missingNamed('policy', facts.unmatched);

      // Paperwork in the vault and nothing recorded. What Ledger has is a FILE
      // — it has not read it and will not pretend to have — so it says what it
      // has and what would make the question answerable.
      if (facts.documentsOnly) {
        const named = facts.documents.slice(0, 2).map(d => d.name);
        return `You have no insurance policies recorded in Ledger, so it cannot tell you what you are covered for or what it costs. There ${facts.documents.length === 1 ? 'is' : 'are'} ${plural(facts.documents.length, 'insurance document')} in your vault (${list(named)}), which Ledger stores but does not read — add the policy to have this answered from your own figures.`;
      }

      if (facts.policies.length === 0) {
        return 'You have no insurance policies recorded in Ledger, and no insurance paperwork in your document vault.';
      }

      if (facts.policies.length === 1) {
        const p = facts.policies[0];
        const parts = [
          `${p.name} costs ${money(p.annualPremium, currency)} a year — ${money(p.monthlyPremium, currency)} a month${p.insurer ? `, with ${p.insurer}` : ''}.`,
        ];
        if (p.renewalDate) {
          parts.push(p.daysToRenewal != null && p.daysToRenewal < 0
            ? `It expired on ${dateLabel(p.renewalDate)}.`
            : `It renews on ${dateLabel(p.renewalDate)}.`);
        }
        if (p.premiumChange && Math.abs(p.premiumChange.delta) >= 1) {
          parts.push(`That is ${money(Math.abs(p.premiumChange.delta), currency)} ${p.premiumChange.delta > 0 ? 'more' : 'less'} a year than it was.`);
        }
        return parts.join(' ');
      }

      const parts = [
        `You hold ${plural(facts.policies.length, 'policy', 'policies')} costing ${money(facts.totalAnnual, currency)} a year — ${money(facts.totalMonthly, currency)} a month.`,
      ];
      if (facts.nextRenewal) {
        parts.push(`${facts.nextRenewal.name} is next to renew, on ${dateLabel(facts.nextRenewal.date)}.`);
      }
      if (facts.expired.length) {
        parts.push(`${list(facts.expired)} ${facts.expired.length === 1 ? 'has' : 'have'} passed the renewal date on file.`);
      }
      return parts.slice(0, 3).join(' ');
    }

    case 'insights-changes': {
      if (facts.changes.length === 0) {
        return `Nothing notable changed in the last ${plural(facts.days, 'day')}. You spent ${money(facts.spend, currency)}, against ${money(facts.previousSpend, currency)} in the window before.`;
      }
      const named = facts.changes.slice(0, 3).map(c => c.title);
      return `Spending over the last ${plural(facts.days, 'day')} came to ${money(facts.spend, currency)}, against ${money(facts.previousSpend, currency)} before. The changes worth knowing about: ${list(named)}.`;
    }

    case 'what-if': {
      if (!facts.comparison) {
        return facts.reason
          ?? 'Ledger could not tell what to change in that question.';
      }
      const c = facts.comparison;
      const parts: string[] = [];

      if (c.unchanged) {
        return `Nothing in your ledger moves: ${facts.reading[0] ?? 'that change'} leaves the forecast, the loans, the budgets and the goals exactly where they are.`;
      }

      // The answer LEADS with what the question was about — a loan that clears
      // sooner, a goal that lands earlier — then what it costs. At most four
      // sentences; everything else is in the figures and the calculation.

      // 0. A follow-up is a COMPARISON. "What about $2,000?" is asked with the
      //    $1,000 answer still on screen, so the first thing said is what the
      //    difference between the two actually buys.
      const v = facts.versus;
      if (v) {
        const gains: string[] = [];
        if (v.extraInterestSaved != null && Math.abs(v.extraInterestSaved) >= 0.005) {
          gains.push(`${money(Math.abs(v.extraInterestSaved), currency)} ${v.extraInterestSaved > 0 ? 'more' : 'less'} interest saved`);
        }
        if (v.extraMonthsSaved != null && Math.abs(v.extraMonthsSaved) >= 1) {
          gains.push(`${plural(Math.round(Math.abs(v.extraMonthsSaved)), 'month')} ${v.extraMonthsSaved > 0 ? 'sooner' : 'later'}`);
        }
        const cost = v.extraCost != null && Math.abs(v.extraCost) >= 0.005
          ? ` It costs ${money(Math.abs(v.extraCost), currency)} ${v.extraCost > 0 ? 'more' : 'less'} up front.`
          : '';
        parts.push(gains.length
          ? `Against ${v.label}, that is ${list(gains)}${v.subject ? ` on ${v.subject}` : ''}.${cost}`
          : `Against ${v.label}, nothing Ledger projects moves any further.${cost}`);
      }

      // 1. The loans.
      for (const l of c.loans.slice(0, 1)) {
        const months = l.monthsSaved ?? 0;
        if (l.before.payoffDate && l.after.payoffDate && l.before.payoffDate !== l.after.payoffDate) {
          const sooner = months > 0;
          parts.push(
            `${l.name} clears on ${dateLabel(l.after.payoffDate)} instead of ${dateLabel(l.before.payoffDate)}`
            + (Math.abs(months) >= 1 ? `, ${plural(Math.round(Math.abs(months)), 'month')} ${sooner ? 'sooner' : 'later'}` : '')
            + (Math.abs(l.interestSaved) >= 0.005
              ? `, ${l.interestSaved > 0 ? 'saving' : 'adding'} ${money(Math.abs(l.interestSaved), currency)} of interest over its life.`
              : '.'),
          );
        } else if (Math.abs(l.interestSaved) >= 0.005) {
          parts.push(`${l.name} costs ${money(l.interestSaved, currency)} ${l.interestSaved > 0 ? 'less' : 'more'} in interest over its life.`);
        } else if (Math.abs(l.outlayChange) >= 0.005) {
          parts.push(`${l.name} takes ${money(l.outlayChange, currency)} ${l.outlayChange > 0 ? 'more' : 'less'} out of the account each period.`);
        } else {
          parts.push(`${l.name} does not move.`);
        }
      }

      // 2. The goals.
      for (const g of c.goals.slice(0, 1)) {
        if (g.daysEarlier != null && Math.abs(g.daysEarlier) >= 1 && g.after.projectedDate) {
          parts.push(`${g.name} lands on ${dateLabel(g.after.projectedDate)} instead of ${dateLabel(g.before.projectedDate)} — ${plural(Math.abs(g.daysEarlier), 'day')} ${g.daysEarlier > 0 ? 'earlier' : 'later'}.`);
        } else if (g.newlyOnTrack) {
          parts.push(`${g.name} comes back on track.`);
        } else if (g.newlyOffTrack) {
          parts.push(`${g.name} stops being on track.`);
        }
      }

      // 3. What it costs or frees up.
      if (Math.abs(c.monthlyCashChange) >= 0.005) {
        parts.push(c.monthlyCashChange > 0
          ? `It frees up ${money(c.monthlyCashChange, currency)} a month.`
          : `It costs ${money(Math.abs(c.monthlyCashChange), currency)} a month.`);
      }
      if (Math.abs(c.oneOffTotal) >= 0.005) {
        parts.push(c.oneOffTotal > 0
          ? `${money(c.oneOffTotal, currency)} goes out once.`
          : `${money(Math.abs(c.oneOffTotal), currency)} comes in once.`);
      }

      // 4. The budgets the scenario tips over or rescues.
      const over = c.budgets.filter(b => b.newlyOver).map(b => b.name);
      const under = c.budgets.filter(b => b.newlyUnder).map(b => b.name);
      if (over.length) parts.push(`It puts ${list(over)} on course to break ${over.length === 1 ? 'its cap' : 'their caps'} this month.`);
      if (under.length) parts.push(`It brings ${list(under)} back inside ${under.length === 1 ? 'its cap' : 'their caps'} this month.`);

      // 5. Where the cash lands — only when nothing above said more.
      const last = c.cash[c.cash.length - 1];
      if (last && Math.abs(last.balanceChange) >= 0.005 && parts.length < 3) {
        parts.push(`In ${last.days} days your projected balance is ${money(last.after.projectedBalance, currency)} instead of ${money(last.before.projectedBalance, currency)}.`);
      }

      if (parts.length === 0) return 'That change moves nothing Ledger projects.';
      const lead = parts.slice(0, 3);
      // The one sentence that always makes the cut, whatever else was said:
      // the change taking the projection below zero is never detail.
      if (last?.newlyNegative) {
        lead.push(`It takes the projection below zero — dipping to ${money(last.after.lowestBalance, currency)} on ${dateLabel(last.after.lowestDate)}.`);
      }
      return lead.join(' ');
    }

    case 'unknown':
      return facts.reason;
  }
}

// ─── While the answer is being worked out ────────────────────────────────────

/**
 * What to say while Ledger is answering.
 *
 * The previous answer comes OFF the screen the moment a new question is asked.
 * Leaving it up while the next one is computed reads as an answer to the
 * question just typed — the worst kind of wrong, because nothing about it
 * looks stale. This is what stands in its place, and it names the thing being
 * looked at so the wait says something true rather than spinning.
 *
 * Pure, and derived from the rules reading of the question, which is settled
 * before the first network call.
 */
export function thinkingMessage(intent: AskIntent | null): string {
  if (!intent) return 'Reading your question…';
  const named = intent.category ?? intent.goal?.name ?? intent.loan?.name
    ?? intent.policy?.name ?? intent.property?.name ?? null;
  switch (intent.name) {
    case 'what-if':
      return intent.whatIf?.followUp ? 'Comparing that with the last one…' : 'Running that scenario…';
    case 'spend-category':
      return named ? `Adding up your ${named} spending…` : 'Adding up your spending…';
    case 'spend-total':
    case 'spend-top':
      return 'Adding up your spending…';
    case 'forecast-outlook': return 'Projecting your cash flow…';
    case 'budget-status': return 'Checking your budgets…';
    case 'goal-progress': return named ? `Checking ${named}…` : 'Checking your goals…';
    case 'loan-offset': return 'Pricing your offset…';
    case 'loan-payoff': return named ? `Projecting ${named}…` : 'Projecting your loans…';
    case 'tax-deductions': return 'Going through your deductions…';
    case 'tax-position': return 'Working out your tax position…';
    case 'income-total': return 'Adding up what came in…';
    case 'net-worth': return 'Adding up what you own and owe…';
    case 'bills-upcoming': return 'Checking what is due…';
    case 'insurance-cover': return named ? `Checking your ${named} cover…` : 'Checking your insurance…';
    case 'insights-changes': return 'Looking for what changed…';
    case 'unknown':
    default:
      return 'Reading your question…';
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
type NamedKind = 'goal' | 'loan' | 'property' | 'policy';

/** What each kind is called in the plural — the app's own words for them. */
const KIND_PLURAL: Record<NamedKind, string> = {
  goal: 'savings goals', loan: 'loans', property: 'properties', policy: 'policies',
};

export function missingNamed(kind: NamedKind, u: UnmatchedRecord): string {
  const head = `Ledger has no ${kind} called "${u.requested}".`;
  const suggestions = u.suggestions.filter(Boolean);
  if (suggestions.length === 1) return `${head} Did you mean ${suggestions[0]}?`;
  if (suggestions.length > 1) return `${head} Did you mean ${list(suggestions)}?`;
  const available = u.available.filter(Boolean);
  if (available.length) {
    return `${head} Your ${available.length === 1 ? kind : KIND_PLURAL[kind]} ${available.length === 1 ? 'is' : 'are'} ${list(available)}.`;
  }
  return `${head} You have no ${KIND_PLURAL[kind]} in Ledger yet.`;
}

function missingRecord(kind: NamedKind, u: UnresolvedSlot): string {
  return missingNamed(kind, {
    requested: u.requested,
    suggestions: (u.suggestions ?? []).filter(Boolean),
    available: (u.available ?? []).filter(Boolean),
  });
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
      case 'policy':
        out.push({ kind: 'unresolved', message: missingRecord('policy', u), to: '/insurance' });
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
