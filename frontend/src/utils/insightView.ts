/**
 * Phase 6.1/6.2 — how an insight READS.
 *
 * The engines decide which figures an insight may quote; this decides how those
 * figures read in the user's currency and date format. It lives here rather than
 * in a card because two surfaces now render the same insight — the Overview's
 * "What changed" (6.1) and the period review (6.2) — and one insight must say
 * one thing on both. Same split as `GoalMessage` in goalView.ts: currency
 * formatting never crosses into a pure module, and no arithmetic crosses out.
 */

import { formatCurrency, formatDate } from './format';
import type { Insight, InsightFacts, InsightSource } from './insights';

/** Where the figures came from — provenance, in the user's words. */
export const SOURCE_LABEL: Record<InsightSource, string> = {
  transactions: 'From your transactions',
  budgets: 'From your budgets',
  forecast: 'From your forecast',
  loans: 'From your loans',
  property: 'From your property',
  tax: 'From your tax position',
  insurance: 'From your policies',
};

const FREQUENCY_LABEL: Record<string, string> = {
  weekly: 'a week',
  fortnightly: 'a fortnight',
  monthly: 'a month',
  quarterly: 'a quarter',
  annually: 'a year',
  once: 'one-off',
};

/**
 * WHAT changed.
 *
 * The engine decided which figures may be quoted; this decides how they read in
 * the user's currency and date format. Same split as `describeAlert` in
 * AlertSection and `GoalMessage` in goalView.ts — currency formatting never
 * crosses into a pure module.
 */
export function describeInsight(facts: InsightFacts, currency: string, windowDays: number): string {
  const money = (n: number) => formatCurrency(n, currency);
  const abs = (n: number) => money(Math.abs(n));
  const period = `the last ${windowDays} days`;

  switch (facts.kind) {
    case 'spending-change':
      return `${money(facts.current)} over ${period}, against ${money(facts.previous)} in the ${windowDays} `
        + `before — ${abs(facts.delta)} ${facts.delta > 0 ? 'more' : 'less'}.`;

    case 'category-change':
      return `${money(facts.current)} over ${period}, against ${money(facts.previous)} before `
        + `— ${abs(facts.delta)} ${facts.delta > 0 ? 'more' : 'less'}, `
        + `and ${facts.shareOfSpend.toFixed(0)}% of everything you spent.`;

    case 'income-change':
      return `${money(facts.current)} came in over ${period}, against ${money(facts.previous)} before.`;

    case 'recurring-increase':
      return `Now ${money(facts.amount)} ${FREQUENCY_LABEL[facts.frequency] ?? ''}, up from `
        + `${money(facts.previousAmount)} — charged on ${formatDate(facts.lastDate)}.`;

    case 'unusual-transaction':
      return `${facts.merchant} charged ${money(facts.amount)} on ${formatDate(facts.date)}, `
        + `against a usual ${money(facts.usual)} for ${facts.category} — about ${facts.multiple.toFixed(1)}× normal.`;

    case 'budget-trend':
      return `${money(facts.averageSpent)} a month against a ${money(facts.averageLimit)} cap, `
        + `${facts.months} months running.`;

    case 'cash-flow-trend':
      return `${money(facts.current)} net over ${period}, against ${money(facts.previous)} in the `
        + `${windowDays} before.`;

    case 'debt-progress':
      return `${money(facts.overpaymentPerMonth)} a month is going in above the contracted repayment, `
        + `with ${money(facts.balance)} left of ${money(facts.originalAmount)} `
        + `(${facts.repaidPercent.toFixed(0)}% repaid).`;

    case 'offset-benefit':
      return `${money(facts.offsetBalance)} in the offset means interest is charged on `
        + `${money(facts.effectiveBalance)} rather than the full balance.`;

    case 'property-performance':
      return `${money(facts.annualRent)} of rent a year against ${money(facts.annualExpenses)} of costs `
        + `and ${money(facts.annualMortgage)} of repayments.`;

    case 'tax-deductions':
      return `${money(facts.deductions)} claimed so far this financial year`
        + (facts.categories > 0 ? `, across ${facts.categories} categor${facts.categories === 1 ? 'y' : 'ies'}.` : '.');

    case 'insurance-premium-change': {
      const who = facts.insurer ? ` with ${facts.insurer}` : '';
      // When the cadence changed, the billed figures are not comparable — say
      // the yearly cost instead of inviting the reader to compare two numbers
      // that mean different things.
      if (facts.frequencyChanged) {
        return `Now ${money(facts.annual)} a year${who}, against ${money(facts.previousAnnual)} `
          + `before — the billing changed to ${FREQUENCY_LABEL[facts.frequency] ?? facts.frequency}.`;
      }
      const way = facts.delta > 0 ? 'up' : 'down';
      return `Now ${money(facts.amount)} ${FREQUENCY_LABEL[facts.frequency] ?? ''}${who}, `
        + `${way} from ${money(facts.previousAmount)}.`;
    }
  }
}

/**
 * WHY it matters — the consequence, not the measurement.
 *
 * Wherever a movement is ongoing it is annualised here: a $6-a-month
 * subscription rise and $72 a year are the same fact, and only the second one
 * ever changes anybody's mind.
 */
export function whyInsightMatters(insight: Insight, currency: string): string {
  const facts = insight.facts;
  const money = (n: number) => formatCurrency(n, currency);
  const yearly = money(Math.abs(insight.monthlyImpact) * 12);

  switch (facts.kind) {
    case 'spending-change': {
      const drivers = facts.drivers.filter(d => Math.sign(d.delta) === Math.sign(facts.delta));
      if (drivers.length > 0) {
        const named = drivers.slice(0, 2)
          .map(d => `${d.category} (${money(Math.abs(d.delta))})`)
          .join(' and ');
        return `Mostly ${named}. Kept up, that is ${yearly} a year.`;
      }
      return `Kept up, that is ${yearly} a year.`;
    }

    case 'category-change':
      return facts.delta > 0
        ? `Kept up, that is ${yearly} a year on ${facts.category} alone.`
        : `Kept up, that is ${yearly} a year back in your pocket.`;

    case 'income-change':
      return facts.delta > 0
        ? `${money(Math.abs(facts.delta))} more to put somewhere before it is spent.`
        : `${money(Math.abs(facts.delta))} less to cover the same bills.`;

    case 'recurring-increase':
      return `${money(facts.annualDelta)} a year more than it used to cost.`;

    case 'unusual-transaction':
      return `${money(insight.impact.amount)} above a usual charge — worth a look if you were not expecting it.`;

    case 'budget-trend':
      return facts.trend === 'over'
        ? `${money(facts.averageGap)} a month over the cap — ${yearly} a year. Either the cap or the spending needs to move.`
        : `${money(facts.averageGap)} a month of headroom you are not using — ${yearly} a year that could be doing something else.`;

    case 'cash-flow-trend': {
      if (facts.projectedNet == null) return `A ${money(Math.abs(facts.delta))} swing on the same measure.`;
      const low = facts.projectedLow != null ? `, dipping to ${money(facts.projectedLow)}` : '';
      return `Your forecast expects ${money(facts.projectedNet)} over the next ${facts.projectedDays} days${low}.`;
    }

    case 'debt-progress':
      return facts.monthsAhead > 0 && facts.payoffDate
        ? `That is ${facts.monthsAhead} month${facts.monthsAhead === 1 ? '' : 's'} off the loan — `
          + `clear by ${formatDate(facts.payoffDate)}.`
        : `Every extra dollar comes off the principal, so it saves interest for the rest of the term.`;

    case 'offset-benefit':
      return `${money(facts.savingPerYear)} a year of interest you are not paying (${money(facts.savingPerMonth)} a month).`;

    case 'property-performance':
      return facts.annualCashFlow >= 0
        ? `It clears ${money(facts.annualCashFlow)} a year (${money(facts.monthlyCashFlow)} a month).`
        : `It costs ${money(Math.abs(facts.annualCashFlow))} a year to hold `
          + `(${money(Math.abs(facts.monthlyCashFlow))} a month out of your own pocket).`;

    case 'tax-deductions':
      return facts.topCategory
        ? `Most of it is ${facts.topCategory} (${money(facts.topCategoryTotal)}). Every dollar here reduces what you are taxed on.`
        : `Every dollar here reduces what you are taxed on.`;

    case 'insurance-premium-change': {
      const yearlyDelta = money(Math.abs(facts.delta));
      const renewal = facts.renewalDate
        ? ` Worth comparing before it renews on ${formatDate(facts.renewalDate)}.`
        : ' Worth comparing before the next renewal.';
      return facts.delta > 0
        ? `${yearlyDelta} a year more for the same cover.${renewal}`
        : `${yearlyDelta} a year less than the cover used to cost.`;
    }
  }
}
