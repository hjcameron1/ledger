/**
 * Phase 6.2 — the financial review (pure engine).
 *
 * Four things are being proved here, and they are the four ways a summary goes
 * wrong:
 *
 *   • SPARSE DATA — a period the history does not reach is reported as
 *     uncovered, never as quiet, and never with totals that look complete;
 *   • A QUIET PERIOD — when nothing cleared the 6.1 floors the review says so,
 *     rather than rendering an empty shell;
 *   • MAJOR CHANGES — the biggest movements lead, and everything else is
 *     ordered and capped behind them;
 *   • DUPLICATE SUPPRESSION — nothing an alert is already saying, nothing said
 *     twice inside one review, and no risk that a change in the same review has
 *     already delivered.
 *
 * Plus the period arithmetic every one of those rests on: only COMPLETE periods
 * are reviewable, and paging back must land on real weeks and months.
 */

import { describe, it, expect } from 'vitest';
import {
  buildReview, reviewPeriods, reviewPeriodFor, periodContaining, previousPeriod,
  nextPeriod, daysInclusive, DEFAULT_REVIEW_THRESHOLDS,
  type ReviewPeriod, type BuildReviewParams,
} from './review';
import { buildInsights, insightWindows, type Insight, type InsightKind } from './insights';
import type { CashFlowForecast, HorizonTotal } from './cashFlowForecast';
import type { GoalLine, GoalReport, GoalStatus } from './savingsGoals';

const ASOF = '2026-08-20';           // a Thursday, mid-month
const AUGUST = periodContaining(ASOF, 'month');
const JULY = previousPeriod(AUGUST);
const JUNE = previousPeriod(JULY);

// ─── Fixtures ────────────────────────────────────────────────────────────────

/**
 * An insight, as the 6.1 engine hands one over.
 *
 * Hand-built rather than derived: this file is about what the REVIEW does with a
 * ranked list, and the list's own arithmetic already has 76 tests of its own.
 * One test at the bottom runs real `buildInsights` output through `buildReview`
 * so the two shapes cannot drift apart.
 */
function insightOf(o: Partial<Insight> & { key: string }): Insight {
  const kind: InsightKind = o.kind ?? 'category-change';
  return {
    key: o.key,
    kind,
    entity: o.entity ?? `category:${o.key}`,
    direction: o.direction ?? 'worsening',
    source: o.source ?? 'transactions',
    stage: o.stage ?? 1,
    title: o.title ?? 'Something moved',
    facts: o.facts ?? {
      kind: 'category-change', category: 'Groceries',
      current: 900, previous: 600, delta: 300, percent: 50, shareOfSpend: 30,
    },
    impact: o.impact ?? { amount: 300, basis: 'window' },
    monthlyImpact: o.monthlyImpact ?? o.score ?? 300,
    score: o.score ?? 300,
    window: o.window !== undefined ? o.window : { from: JULY.from, to: JULY.to, days: JULY.days },
    link: o.link ?? { to: '/accounts?tab=transactions', label: 'View transactions' },
    unread: true,
    dismissed: false,
  };
}

function horizon(o: Partial<HorizonTotal> = {}): HorizonTotal {
  return {
    days: 90, date: '2026-11-18', inflow: 12_000, outflow: -12_000, net: 0,
    openingBalance: 10_000, projectedBalance: 10_000, lowestBalance: 8_000,
    lowestDate: '2026-09-01', ...o,
  };
}

function forecastOf(...horizons: HorizonTotal[]): CashFlowForecast {
  return {
    asOf: ASOF, horizonDays: horizons.map(h => h.days), openingTotal: 10_000,
    horizons, accounts: [], events: [], suppressed: [],
  };
}

function goalLine(o: Partial<GoalLine> & { id: string; status: GoalStatus }): GoalLine {
  return {
    name: 'House deposit', targetAmount: 50_000, targetDate: '2027-06-30',
    saved: 10_000, linkedSaved: 10_000, manualSaved: 0, reflectedTotal: 0,
    remaining: 40_000, progressPct: 20, daysRemaining: 314,
    requiredPerWeek: 900, requiredPerMonth: 3_900,
    allocatedPerMonth: 500, shortfallPerMonth: 3_400, projectedDate: null,
    capacityKnown: true, depositedTotal: 10_000, withdrawnTotal: 0,
    contributionCount: 4, brokenLinks: [], ...o,
  };
}

function goalReportOf(...lines: GoalLine[]): GoalReport {
  return {
    asOf: ASOF, lines, monthlyCapacity: 500, totalRequiredPerMonth: 3_900,
    unallocatedPerMonth: 0, committedPerMonth: 0, shortfallPerMonth: 3_400,
    totalTarget: 50_000, totalSaved: 10_000, completeCount: 0,
  };
}

const build = (params: Partial<BuildReviewParams> = {}) => buildReview({
  period: JULY,
  latest: true,
  asOf: ASOF,
  ...params,
});

// ═════════════════════════════════════════════════════════════════════════════
//  Periods — only complete ones, and paging back must land on real ones
// ═════════════════════════════════════════════════════════════════════════════
describe('periods', () => {
  it('bounds a calendar month by its own first and last day', () => {
    expect(AUGUST).toEqual({ kind: 'month', key: '2026-08', from: '2026-08-01', to: '2026-08-31', days: 31 });
    expect(periodContaining('2026-02-14', 'month')).toMatchObject({ to: '2026-02-28', days: 28 });
    expect(periodContaining('2028-02-14', 'month')).toMatchObject({ to: '2028-02-29', days: 29 });
  });

  it('bounds a week Monday to Sunday, whatever day it is asked about', () => {
    const fromThursday = periodContaining('2026-08-20', 'week');
    const fromSunday = periodContaining('2026-08-23', 'week');
    expect(fromThursday).toEqual({ kind: 'week', key: '2026-W34', from: '2026-08-17', to: '2026-08-23', days: 7 });
    expect(fromSunday).toEqual(fromThursday);
    // Sunday belongs to the week that STARTED, not the one about to.
    expect(periodContaining('2026-08-24', 'week').from).toBe('2026-08-24');
  });

  it('numbers a week off its own Thursday, so the New Year weeks get the right year', () => {
    // 1 Jan 2027 is a Friday: its week began in December and belongs to 2026.
    expect(periodContaining('2027-01-01', 'week').key).toBe('2026-W53');
    expect(periodContaining('2027-01-04', 'week').key).toBe('2027-W01');
  });

  it('never offers the period being lived in', () => {
    const months = reviewPeriods(ASOF, 'month', 3);
    expect(months.map(p => p.key)).toEqual(['2026-07', '2026-06', '2026-05']);

    const weeks = reviewPeriods(ASOF, 'week', 2);
    expect(weeks.map(p => p.key)).toEqual(['2026-W33', '2026-W32']);
    // The week ASOF falls in ends in the future; reviewing it would compare four
    // days with seven.
    expect(weeks.every(w => w.to < ASOF)).toBe(true);
  });

  it('offers the month just finished on its first day, and not before', () => {
    expect(reviewPeriods('2026-08-31', 'month', 1)[0].key).toBe('2026-07');
    expect(reviewPeriods('2026-09-01', 'month', 1)[0].key).toBe('2026-08');
  });

  it('pages back through contiguous periods', () => {
    const list = reviewPeriods(ASOF, 'week', 6);
    for (let i = 1; i < list.length; i++) {
      expect(nextPeriod(list[i]).key).toBe(list[i - 1].key);
      expect(daysInclusive(list[i].from, list[i].to)).toBe(7);
    }
  });

  it('round-trips a period key, and refuses one that is not a period', () => {
    expect(reviewPeriodFor('2026-07')).toEqual(JULY);
    expect(reviewPeriodFor('2026-W33')).toEqual(reviewPeriods(ASOF, 'week', 1)[0]);
    expect(reviewPeriodFor('2026-13')).toBeNull();
    expect(reviewPeriodFor('2026-W54')).toBeNull();
    // 2025 has 52 ISO weeks, so W53 of it is not a week that happened.
    expect(reviewPeriodFor('2025-W53')).toBeNull();
    expect(reviewPeriodFor('nonsense')).toBeNull();
    expect(reviewPeriodFor('')).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Sparse data — "we cannot see" is not "nothing happened"
// ═════════════════════════════════════════════════════════════════════════════
describe('sparse data', () => {
  it('reports a period the history does not reach as uncovered, not as quiet', () => {
    const report = build({
      coverageFrom: '2026-07-15',
      insights: [insightOf({ key: 'insight:a' })],
      totals: { current: { spend: 900, income: 0, net: -900 }, previous: { spend: 100, income: 0, net: -100 } },
    });

    expect(report.covered).toBe(false);
    expect(report.quiet).toBe(false);
    expect(report.biggest).toEqual([]);
    expect(report.improved).toEqual([]);
    expect(report.worsened).toEqual([]);
    expect(report.risks).toEqual([]);
    expect(report.actions).toEqual([]);
    // Real figures over a half-loaded month would look complete, so none are given.
    expect(report.totals).toBeNull();
    expect(report.skipped[0]).toContain('2026-07-15');
  });

  it('reviews a period the history reaches exactly', () => {
    const report = build({ coverageFrom: JULY.from, insights: [insightOf({ key: 'insight:a' })] });
    expect(report.covered).toBe(true);
    expect(report.biggest).toHaveLength(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  A quiet period is an answer
// ═════════════════════════════════════════════════════════════════════════════
describe('a quiet period', () => {
  it('says the period was quiet when nothing cleared the floors', () => {
    const report = build({
      totals: { current: { spend: 2_000, income: 5_000, net: 3_000 }, previous: { spend: 2_010, income: 5_000, net: 2_990 } },
    });
    expect(report.covered).toBe(true);
    expect(report.quiet).toBe(true);
    // Quiet is not empty: the totals still stand, because "nothing changed" is
    // only meaningful next to what the period actually was.
    expect(report.totals).toMatchObject({ spend: 2_000, spendDelta: -10, income: 5_000, net: 3_000 });
  });

  it('is not quiet when there is nothing to report but something is coming', () => {
    const report = build({
      forecast: forecastOf(horizon({ lowestBalance: -500, lowestDate: '2026-09-10' })),
    });
    expect(report.quiet).toBe(false);
    expect(report.risks.map(r => r.facts.kind)).toEqual(['cash-shortfall']);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Major changes — biggest first, everything else behind them
// ═════════════════════════════════════════════════════════════════════════════
describe('sections', () => {
  const many = [
    insightOf({ key: 'insight:huge', score: 900, entity: 'spend:overall', direction: 'worsening' }),
    insightOf({ key: 'insight:big', score: 700, entity: 'category:rent', direction: 'improving' }),
    insightOf({ key: 'insight:mid', score: 500, entity: 'category:dining', direction: 'worsening' }),
    insightOf({ key: 'insight:small', score: 300, entity: 'category:fuel', direction: 'improving' }),
    insightOf({ key: 'insight:tiny', score: 100, entity: 'category:pets', direction: 'worsening' }),
  ];

  it('leads with the biggest movements, whichever way they went', () => {
    const report = build({ insights: many });
    expect(report.biggest.map(i => i.key)).toEqual(['insight:huge', 'insight:big', 'insight:mid']);
  });

  it('puts every insight in exactly one section', () => {
    const report = build({ insights: many });
    const keys = [...report.biggest, ...report.improved, ...report.worsened].map(i => i.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(report.improved.map(i => i.key)).toEqual(['insight:small']);
    expect(report.worsened.map(i => i.key)).toEqual(['insight:tiny']);
  });

  it('counts what did not fit rather than dropping it silently', () => {
    const crowd = Array.from({ length: 12 }, (_, i) =>
      insightOf({ key: `insight:${i}`, entity: `category:${i}`, score: 500 - i, direction: i % 2 ? 'improving' : 'worsening' }));
    const report = build({ insights: crowd });

    const shown = report.biggest.length + report.improved.length + report.worsened.length;
    expect(report.considered).toBe(12);
    expect(report.omitted).toBe(12 - shown);
    expect(report.biggest).toHaveLength(DEFAULT_REVIEW_THRESHOLDS.maxBiggest);
    expect(report.improved).toHaveLength(DEFAULT_REVIEW_THRESHOLDS.maxImproved);
    expect(report.worsened).toHaveLength(DEFAULT_REVIEW_THRESHOLDS.maxWorsened);
  });

  it('ranks by the 6.1 score, not by the order it was handed', () => {
    const report = build({ insights: [...many].reverse() });
    expect(report.biggest.map(i => i.key)).toEqual(['insight:huge', 'insight:big', 'insight:mid']);
  });

  it('gives a neutral fact the headline or nothing — it is neither good nor bad news', () => {
    const neutral = insightOf({ key: 'insight:tax', kind: 'tax-deductions', direction: 'neutral', score: 50, entity: 'tax:FY2026', window: null });
    const report = build({ insights: [neutral] });
    expect(report.biggest.map(i => i.key)).toEqual(['insight:tax']);
    expect([...report.improved, ...report.worsened]).toEqual([]);

    const crowded = build({ insights: [...many, neutral] });
    expect(crowded.biggest.map(i => i.key)).not.toContain('insight:tax');
    expect([...crowded.improved, ...crowded.worsened].map(i => i.key)).not.toContain('insight:tax');
  });

  it('carries the period totals, with the change against what it was compared to', () => {
    const report = build({
      totals: { current: { spend: 3_000, income: 6_000, net: 3_000 }, previous: { spend: 2_000, income: 6_500, net: 4_500 } },
    });
    expect(report.totals).toEqual({
      spend: 3_000, income: 6_000, net: 3_000,
      previousSpend: 2_000, previousIncome: 6_500, previousNet: 4_500,
      spendDelta: 1_000, incomeDelta: -500, netDelta: -1_500,
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  A past review says less, and says so
// ═════════════════════════════════════════════════════════════════════════════
describe('reviewing an earlier period', () => {
  const standing = insightOf({ key: 'insight:offset', kind: 'offset-benefit', entity: 'loan:1:offset', window: null, score: 400, direction: 'improving' });
  const change = insightOf({ key: 'insight:change', score: 300 });

  it('drops standing facts, because they describe today rather than the period', () => {
    const report = buildReview({
      period: JUNE, latest: false, asOf: ASOF, insights: [standing, change],
    });
    expect(report.biggest.map(i => i.key)).toEqual(['insight:change']);
    expect(report.skipped.some(s => s.includes('Loans, property and tax'))).toBe(true);
  });

  it('keeps standing facts in the latest review', () => {
    const report = build({ insights: [standing, change] });
    expect(report.biggest.map(i => i.key)).toContain('insight:offset');
  });

  it('does not look forward from a period that is over', () => {
    const report = buildReview({
      period: JUNE, latest: false, asOf: ASOF,
      forecast: forecastOf(horizon({ lowestBalance: -2_000 })),
      goals: goalReportOf(goalLine({ id: 'g1', status: 'behind' })),
    });
    expect(report.risks).toEqual([]);
    expect(report.skipped.some(s => s.includes('Upcoming risks'))).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Upcoming risks
// ═════════════════════════════════════════════════════════════════════════════
describe('risks', () => {
  it('reports cash running out, off the forecast’s own lowest point', () => {
    const report = build({
      forecast: forecastOf(horizon({ lowestBalance: -1_250.5, lowestDate: '2026-09-14', days: 90 })),
    });
    const risk = report.risks[0];
    expect(risk.severity).toBe('high');
    expect(risk.entity).toBe('cash');
    expect(risk.facts).toMatchObject({ kind: 'cash-shortfall', lowest: -1_250.5, lowestDate: '2026-09-14' });
    expect(risk.link.to).toBe('/forecast');
  });

  it('reports a drain only when cash never actually runs out', () => {
    const drain = build({ forecast: forecastOf(horizon({ net: -3_000, lowestBalance: 500 })) });
    expect(drain.risks.map(r => r.facts.kind)).toEqual(['cash-drain']);
    expect(drain.risks[0].severity).toBe('medium');

    // Both true at once is one story told at two volumes — only the loud one runs.
    const both = build({ forecast: forecastOf(horizon({ net: -3_000, lowestBalance: -100 })) });
    expect(both.risks.map(r => r.facts.kind)).toEqual(['cash-shortfall']);
  });

  it('stays quiet about a forecast that is merely unremarkable', () => {
    expect(build({ forecast: forecastOf(horizon({ net: -100, lowestBalance: 4_000 })) }).risks).toEqual([]);
    expect(build({ forecast: null }).risks).toEqual([]);
    expect(build({ forecast: forecastOf() }).risks).toEqual([]);
  });

  it('names goals the forecast cannot fund, and leaves the rest alone', () => {
    const report = build({
      goals: goalReportOf(
        goalLine({ id: 'behind', name: 'Deposit', status: 'behind', shortfallPerMonth: 800 }),
        goalLine({ id: 'at-risk', name: 'Car', status: 'at-risk', shortfallPerMonth: 200 }),
        goalLine({ id: 'fine', name: 'Holiday', status: 'on-track', shortfallPerMonth: 0 }),
        goalLine({ id: 'done', name: 'Rainy day', status: 'complete', shortfallPerMonth: 0 }),
        // No forecast to judge against — the engine says unknown, so nothing is claimed.
        goalLine({ id: 'unknown', name: 'Boat', status: 'unknown', shortfallPerMonth: 0 }),
        // Real status, trivial gap: not worth a line in a summary.
        goalLine({ id: 'trivial', name: 'Coffee fund', status: 'behind', shortfallPerMonth: 5 }),
      ),
    });
    expect(report.risks.map(r => r.entity)).toEqual(['goal:behind', 'goal:at-risk']);
  });

  it('treats a goal whose date has passed as urgent, whatever the pace says', () => {
    const report = build({
      goals: goalReportOf(goalLine({ id: 'late', status: 'overdue', shortfallPerMonth: 0, remaining: 4_000 })),
    });
    expect(report.risks[0]).toMatchObject({ severity: 'high', entity: 'goal:late' });
    expect(report.risks[0].facts).toMatchObject({ kind: 'goal-shortfall', overdue: true, remaining: 4_000 });
  });

  it('puts the worst first and caps the list', () => {
    const report = build({
      forecast: forecastOf(horizon({ lowestBalance: -50 })),
      goals: goalReportOf(
        goalLine({ id: 'a', status: 'behind', shortfallPerMonth: 100 }),
        goalLine({ id: 'b', status: 'behind', shortfallPerMonth: 900 }),
        goalLine({ id: 'c', status: 'behind', shortfallPerMonth: 400 }),
        goalLine({ id: 'd', status: 'behind', shortfallPerMonth: 300 }),
      ),
    });
    expect(report.risks.map(r => r.entity)).toEqual(['cash', 'goal:b', 'goal:c']);
    expect(report.risks).toHaveLength(DEFAULT_REVIEW_THRESHOLDS.maxRisks);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Duplicate suppression — the whole point of a summary
// ═════════════════════════════════════════════════════════════════════════════
describe('not saying the same thing twice', () => {
  it('leaves out what a live alert is already shouting, and counts it', () => {
    const report = build({
      insights: [
        insightOf({ key: 'insight:groceries', entity: 'category:groceries', score: 800 }),
        insightOf({ key: 'insight:fuel', entity: 'category:fuel', score: 400 }),
      ],
      alertEntities: ['category:groceries'],
    });
    expect(report.biggest.map(i => i.key)).toEqual(['insight:fuel']);
    expect(report.considered).toBe(1);
    expect(report.suppressed.alerts).toBe(1);
  });

  it('counts what the insight engine had already removed for the same reason', () => {
    // 6.1 suppresses before it ranks, so those insights never arrive here. The
    // pointer at the alert card still has to stand for all of them.
    const report = build({
      insights: [insightOf({ key: 'insight:fuel', entity: 'category:fuel', score: 400 })],
      alertEntities: ['category:groceries'],
      alreadySuppressed: 2,
    });
    expect(report.suppressed.alerts).toBe(2);
    expect(report.biggest.map(i => i.key)).toEqual(['insight:fuel']);
  });

  it('leaves out a risk an alert is already shouting', () => {
    const report = build({
      forecast: forecastOf(horizon({ lowestBalance: -900 })),
      goals: goalReportOf(goalLine({ id: 'g1', status: 'behind', shortfallPerMonth: 700 })),
      alertEntities: ['cash', 'goal:g1'],
    });
    expect(report.risks).toEqual([]);
    expect(report.suppressed.alerts).toBe(2);
  });

  it('drops a risk this review already delivers as bad news', () => {
    const report = build({
      insights: [insightOf({ key: 'insight:cash', kind: 'cash-flow-trend', entity: 'cash', direction: 'worsening', score: 600 })],
      forecast: forecastOf(horizon({ net: -4_000, lowestBalance: 200 })),
    });
    expect(report.risks).toEqual([]);
    expect(report.suppressed.duplicates).toBe(1);
  });

  it('keeps the risk when the change about the same thing is GOOD news', () => {
    // "Cash flow is better than it was" and "it still runs out next month" are
    // both true, and the second one is the one that needs acting on.
    const report = build({
      insights: [insightOf({ key: 'insight:cash', kind: 'cash-flow-trend', entity: 'cash', direction: 'improving', score: 600 })],
      forecast: forecastOf(horizon({ lowestBalance: -300 })),
    });
    expect(report.risks.map(r => r.facts.kind)).toEqual(['cash-shortfall']);
    expect(report.suppressed.duplicates).toBe(0);
  });

  it('only counts a duplicate when the change actually made it into the review', () => {
    // A worsening cash insight that was crowded out of every section is not
    // saying anything, so it cannot be the reason the risk is silent.
    const crowd = Array.from({ length: 9 }, (_, i) =>
      insightOf({ key: `insight:${i}`, entity: `category:${i}`, score: 900 - i, direction: 'worsening' }));
    const report = build({
      insights: [...crowd, insightOf({ key: 'insight:cash', entity: 'cash', direction: 'worsening', score: 1 })],
      forecast: forecastOf(horizon({ lowestBalance: -300 })),
    });
    expect(report.risks.map(r => r.facts.kind)).toEqual(['cash-shortfall']);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Actions
// ═════════════════════════════════════════════════════════════════════════════
describe('actions', () => {
  it('puts one action per destination, urgent first, and remembers who asked', () => {
    const report = build({
      insights: [
        insightOf({ key: 'insight:a', entity: 'category:a', score: 500 }),
        insightOf({ key: 'insight:b', entity: 'category:b', score: 400 }),
        insightOf({
          key: 'insight:sub', kind: 'recurring-increase', entity: 'recurring:1', score: 300,
          link: { to: '/subscriptions', label: 'View subscriptions' },
        }),
      ],
      forecast: forecastOf(horizon({ lowestBalance: -100 })),
    });

    expect(report.actions.map(a => a.to)).toEqual([
      '/forecast', '/accounts?tab=transactions', '/subscriptions',
    ]);
    // Two insights pointing at one page is one action, not two.
    expect(report.actions[1].sourceKeys).toEqual(['insight:a', 'insight:b']);
    expect(report.actions.every(a => a.reason.length > 0)).toBe(true);
  });

  it('caps the list', () => {
    const report = build({
      insights: Array.from({ length: 8 }, (_, i) => insightOf({
        key: `insight:${i}`, entity: `category:${i}`, score: 500 - i,
        link: { to: `/page-${i}`, label: `Open ${i}` },
      })),
    });
    expect(report.actions).toHaveLength(DEFAULT_REVIEW_THRESHOLDS.maxActions);
  });

  it('suggests nothing when there is nothing to suggest', () => {
    expect(build().actions).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  The two engines fit together
// ═════════════════════════════════════════════════════════════════════════════
describe('with the real insight engine', () => {
  it('reviews what buildInsights actually produces', () => {
    const period: ReviewPeriod = JULY;
    const { window, previousWindow } = insightWindows(period.to, period.days);

    const insights = buildInsights({
      asOf: period.to,
      window,
      previousWindow,
      coverageFrom: '2026-01-01',
      spend: {
        current: { total: 3_000, byCategory: { Groceries: 2_000, Dining: 1_000 } },
        previous: { total: 1_500, byCategory: { Groceries: 1_000, Dining: 500 } },
      },
      income: { current: 6_000, previous: 8_000 },
    });

    const report = buildReview({
      period, latest: true, asOf: ASOF, coverageFrom: '2026-01-01',
      insights: insights.visible,
      comparedWith: insights.previousWindow,
      totals: { current: { spend: 3_000, income: 6_000, net: 3_000 }, previous: { spend: 1_500, income: 8_000, net: 6_500 } },
    });

    expect(report.quiet).toBe(false);
    expect(report.considered).toBe(insights.visible.length);
    expect(report.biggest.length).toBeGreaterThan(0);
    // Spending up and income down are both bad news, and both are real insights.
    expect([...report.biggest, ...report.worsened].map(i => i.kind))
      .toEqual(expect.arrayContaining(['income-change']));
    expect(report.comparedWith).toEqual(previousWindow);
    expect(report.actions.length).toBeGreaterThan(0);
  });
});
