import { describe, it, expect } from 'vitest';
import {
  buildAttentionFeed, visibleFeed, knowLimit,
  ACT_ROWS, KNOW_ROWS, KNOW_ROWS_ALONE, REVIEW_KEY, REVIEW_LINK,
} from './attention';
import type { Alert, AlertSeverity } from './alerts';
import type { Insight, InsightDirection } from './insights';

/**
 * The merge that turned three cards into one list.
 *
 * What is worth pinning here is not the styling — it is the two decisions that
 * were going wrong on the page: WHICH tier a thing lands in, and HOW MANY of
 * them the reader is shown before being asked whether they want more.
 */

function alert(key: string, severity: AlertSeverity, over: Partial<Alert> = {}): Alert {
  return {
    key,
    kind: 'cash-low',
    stage: 2,
    severity,
    title: `Alert ${key}`,
    facts: {
      kind: 'cash-low',
      lowest: -100, lowestDate: '2026-09-03', buffer: 500, days: 30,
    },
    link: { to: '/forecast', label: 'View forecast' },
    unread: true,
    dismissed: false,
    ...over,
  } as Alert;
}

function insight(key: string, direction: InsightDirection, over: Partial<Insight> = {}): Insight {
  return {
    key: `insight:${key}`,
    kind: 'category-spend',
    entity: `category:${key}`,
    direction,
    source: 'transactions',
    stage: 1,
    title: `Insight ${key}`,
    facts: {
      kind: 'category-spend',
      category: key, current: 200, previous: 100, delta: 100, percent: 100,
    },
    impact: { amount: 100, basis: 'window' },
    monthlyImpact: 100,
    score: 100,
    window: { from: '2026-07-26', to: '2026-08-25', days: 30 },
    link: { to: '/accounts?tab=transactions', label: 'View transactions' },
    unread: true,
    dismissed: false,
    ...over,
  } as Insight;
}

describe('what lands in which tier', () => {
  it('puts every alert in "needs you" and every insight in "what changed"', () => {
    const feed = buildAttentionFeed({
      alerts: [alert('a', 'critical'), alert('b', 'warning')],
      insights: [insight('groceries', 'worsening')],
      reviewCount: 0,
    });

    expect(feed.act.map(i => i.key)).toEqual(['a', 'b']);
    expect(feed.know.map(i => i.key)).toEqual(['insight:groceries']);
    expect(feed.total).toBe(3);
  });

  it('keeps the engines\' own order — they already sorted worst/best first', () => {
    const feed = buildAttentionFeed({
      alerts: [alert('worst', 'critical'), alert('mild', 'info')],
      insights: [insight('big', 'worsening'), insight('small', 'improving')],
      reviewCount: 0,
    });

    expect(feed.act.map(i => i.key)).toEqual(['worst', 'mild']);
    expect(feed.know.map(i => i.key)).toEqual(['insight:big', 'insight:small']);
  });

  it('puts the import queue LAST in "needs you", however big it is', () => {
    const feed = buildAttentionFeed({
      alerts: [alert('a', 'info')],
      insights: [],
      reviewCount: 412,
    });

    // Housekeeping never outranks money, even at 412 rows against one info alert.
    expect(feed.act.map(i => i.key)).toEqual(['a', REVIEW_KEY]);
    expect(feed.act[1].to).toBe(REVIEW_LINK);
    expect(feed.act[1].title).toBe('412 transactions to check');
  });

  it('says "1 transaction" for one', () => {
    const feed = buildAttentionFeed({ alerts: [], insights: [], reviewCount: 1 });
    expect(feed.act[0].title).toBe('1 transaction to check');
  });

  it('has no queue row at all when nothing is waiting', () => {
    const feed = buildAttentionFeed({ alerts: [], insights: [], reviewCount: 0 });
    expect(feed.total).toBe(0);
  });
});

describe('tone', () => {
  it('maps severity and direction onto one four-colour scale', () => {
    const feed = buildAttentionFeed({
      alerts: [alert('c', 'critical'), alert('w', 'warning'), alert('i', 'info')],
      insights: [insight('down', 'worsening'), insight('up', 'improving'), insight('flat', 'neutral')],
      reviewCount: 3,
    });

    expect(feed.act.map(i => i.tone)).toEqual(['critical', 'warning', 'neutral', 'neutral']);
    expect(feed.know.map(i => i.tone)).toEqual(['warning', 'good', 'neutral']);
  });
});

describe('what a hidden Settings toggle does', () => {
  it('silences only its own tier', () => {
    const input = {
      alerts: [alert('a', 'critical')],
      insights: [insight('g', 'worsening')],
      reviewCount: 0,
    };

    expect(buildAttentionFeed({ ...input, showAlerts: false }).act).toHaveLength(0);
    expect(buildAttentionFeed({ ...input, showAlerts: false }).know).toHaveLength(1);
    expect(buildAttentionFeed({ ...input, showInsights: false }).act).toHaveLength(1);
    expect(buildAttentionFeed({ ...input, showInsights: false }).know).toHaveLength(0);
  });

  it('keeps the import queue when alerts are hidden — it is not an alert', () => {
    const feed = buildAttentionFeed({
      alerts: [alert('a', 'critical')], insights: [], reviewCount: 5, showAlerts: false,
    });
    expect(feed.act.map(i => i.key)).toEqual([REVIEW_KEY]);
  });
});

describe('unread', () => {
  it('counts unread alerts and insights, never the import queue', () => {
    const feed = buildAttentionFeed({
      alerts: [alert('a', 'critical'), alert('b', 'warning', { unread: false })],
      insights: [insight('g', 'worsening')],
      reviewCount: 9,
    });

    expect(feed.unreadCount).toBe(2);
    expect(feed.act.find(i => i.key === REVIEW_KEY)!.unread).toBe(false);
  });
});

describe('how much is shown before the reader is asked', () => {
  it('shows at most three of each tier, and counts the rest', () => {
    const feed = buildAttentionFeed({
      alerts: [alert('1', 'critical'), alert('2', 'critical'), alert('3', 'warning'), alert('4', 'warning')],
      insights: [insight('a', 'worsening'), insight('b', 'worsening'), insight('c', 'improving'), insight('d', 'improving')],
      reviewCount: 0,
    });

    const shown = visibleFeed(feed, false);
    expect(shown.act).toHaveLength(ACT_ROWS);
    expect(shown.know).toHaveLength(KNOW_ROWS);
    expect(shown.hidden).toBe(8 - ACT_ROWS - KNOW_ROWS);
  });

  it('gives "what changed" the extra room when there is nothing to act on', () => {
    const insights = Array.from({ length: 8 }, (_, i) => insight(`i${i}`, 'neutral'));
    const feed = buildAttentionFeed({ alerts: [], insights, reviewCount: 0 });

    expect(knowLimit(0)).toBe(KNOW_ROWS_ALONE);
    expect(visibleFeed(feed, false).know).toHaveLength(KNOW_ROWS_ALONE);
    // …and takes it back the moment something needs acting on.
    const withAlert = buildAttentionFeed({ alerts: [alert('a', 'critical')], insights, reviewCount: 0 });
    expect(visibleFeed(withAlert, false).know).toHaveLength(KNOW_ROWS);
  });

  it('hides nothing once expanded', () => {
    const feed = buildAttentionFeed({
      alerts: [alert('1', 'critical'), alert('2', 'critical'), alert('3', 'warning'), alert('4', 'warning')],
      insights: [insight('a', 'worsening'), insight('b', 'worsening'), insight('c', 'improving'), insight('d', 'improving')],
      reviewCount: 0,
    });

    const shown = visibleFeed(feed, true);
    expect(shown.act).toHaveLength(4);
    expect(shown.know).toHaveLength(4);
    expect(shown.hidden).toBe(0);
  });

  it('never reports a negative remainder when both tiers fit', () => {
    const feed = buildAttentionFeed({
      alerts: [alert('1', 'critical')], insights: [insight('a', 'improving')], reviewCount: 0,
    });
    expect(visibleFeed(feed, false).hidden).toBe(0);
  });
});

describe('what a row carries back', () => {
  it('carries the stage to record against, and null where there is nothing to record', () => {
    const feed = buildAttentionFeed({
      alerts: [alert('a', 'critical', { stage: 3 })],
      insights: [insight('g', 'worsening', { stage: 2 })],
      reviewCount: 4,
    });

    expect(feed.act[0].stage).toBe(3);
    expect(feed.know[0].stage).toBe(2);
    // The queue is resolved by working through it, not by being read or dismissed.
    expect(feed.act.find(i => i.key === REVIEW_KEY)!.stage).toBeNull();
  });

  it('keeps the underlying object so the card can format its own figures', () => {
    const a = alert('a', 'critical');
    const i = insight('g', 'worsening');
    const feed = buildAttentionFeed({ alerts: [a], insights: [i], reviewCount: 0 });

    expect(feed.act[0].source).toEqual({ kind: 'alert', alert: a });
    expect(feed.know[0].source).toEqual({ kind: 'insight', insight: i });
    // Titles are the engines' own — no money is added on the way through.
    expect(feed.act[0].title).toBe(a.title);
    expect(feed.know[0].title).toBe(i.title);
  });

  it('links each row where its engine said to', () => {
    const feed = buildAttentionFeed({
      alerts: [alert('a', 'critical')], insights: [insight('g', 'worsening')], reviewCount: 0,
    });
    expect(feed.act[0].to).toBe('/forecast');
    expect(feed.know[0].to).toBe('/accounts?tab=transactions');
  });
});
