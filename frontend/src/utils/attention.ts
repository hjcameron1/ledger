/**
 * One list, instead of three cards.
 *
 * The Overview used to stack "Needs your attention" (alerts), "What changed"
 * (insights) and "Needs review" (the import queue) as three separate cards, each
 * with its own heading, its own subtitle, its own unread pill, its own dot
 * colours and its own row chrome. Individually each was fine; together they were
 * roughly thirty lines of competing boxes at the top of the page, and the effect
 * of thirty things shouting is that none of them is heard.
 *
 * This module merges them into ONE ranked feed, in two tiers:
 *
 *   • `act`  — something is wrong, or something is waiting on you. Alerts, worst
 *              first (the engine already sorted them), then the review queue,
 *              because tidying up an import is not the same as being over a cap.
 *   • `know` — nothing to do, but the picture moved. Insights, best-ranked first.
 *
 * The split is the whole point: a card that mixes "your cash goes negative on
 * Tuesday" with "groceries are up 4%" teaches the reader to skim past both.
 *
 * PURE — no store, no React, no currency. It orders and caps; the component
 * formats. That keeps "which of these do I show, and in what order" testable
 * without a DOM, which is exactly the decision that was going wrong.
 */

import type { Alert } from './alerts';
import type { Insight } from './insights';

export type AttentionTone = 'critical' | 'warning' | 'good' | 'neutral';
export type AttentionTier = 'act' | 'know';

/** What a row is really pointing at, so the card can format it properly. */
export type AttentionSource =
  | { kind: 'alert'; alert: Alert }
  | { kind: 'insight'; insight: Insight }
  | { kind: 'review'; count: number };

export interface AttentionItem {
  /** Stable across rebuilds — the underlying alert/insight key, or 'review'. */
  key: string;
  tier: AttentionTier;
  tone: AttentionTone;
  /** Short heading. Never contains money — the card formats every figure. */
  title: string;
  /** Where tapping the row goes. */
  to: string;
  unread: boolean;
  /**
   * What to record when the row is opened or dismissed, or null when there is
   * nothing to record (the review queue is resolved by working through it, not
   * by being read).
   */
  stage: number | null;
  source: AttentionSource;
}

export interface AttentionFeed {
  act: AttentionItem[];
  know: AttentionItem[];
  /** Rows worth a badge: unread alerts and insights, never the review queue. */
  unreadCount: number;
  /** Everything the feed holds, both tiers. */
  total: number;
}

/**
 * How many rows each tier shows before "Show all".
 *
 * Three is not arbitrary: it is about as many separate situations as anyone
 * holds in their head at once, and it keeps the whole card under a phone screen
 * so the net-worth chart below it is still on the page.
 */
export const ACT_ROWS = 3;
export const KNOW_ROWS = 3;

/**
 * With nothing to act on, the "what changed" tier gets the room the alerts
 * would have taken — a quiet week should still be readable, not a stub.
 */
export const KNOW_ROWS_ALONE = 5;

const ALERT_TONE: Record<Alert['severity'], AttentionTone> = {
  critical: 'critical',
  warning: 'warning',
  info: 'neutral',
};

const INSIGHT_TONE: Record<Insight['direction'], AttentionTone> = {
  worsening: 'warning',
  improving: 'good',
  neutral: 'neutral',
};

/** The one row standing in for the whole import queue. */
export const REVIEW_KEY = 'review-queue';
export const REVIEW_LINK = '/accounts?tab=review';

export interface AttentionInput {
  /** Already filtered to what the user should see (report.visible). */
  alerts: Alert[];
  /** Already filtered and ranked (report.visible). */
  insights: Insight[];
  /** Transactions the importer wasn't sure about. 0 hides the row. */
  reviewCount: number;
  /** Settings → dashboard widgets. A hidden tier contributes nothing. */
  showAlerts?: boolean;
  showInsights?: boolean;
}

export function buildAttentionFeed(input: AttentionInput): AttentionFeed {
  const showAlerts = input.showAlerts !== false;
  const showInsights = input.showInsights !== false;

  const act: AttentionItem[] = [];

  if (showAlerts) {
    for (const alert of input.alerts) {
      act.push({
        key: alert.key,
        tier: 'act',
        tone: ALERT_TONE[alert.severity],
        title: alert.title,
        to: alert.link.to,
        unread: alert.unread,
        stage: alert.stage,
        source: { kind: 'alert', alert },
      });
    }
  }

  // Last in `act`, whatever its size: a hundred uncategorised imports is still
  // housekeeping, and a single overdrawn account is still money.
  if (input.reviewCount > 0) {
    act.push({
      key: REVIEW_KEY,
      tier: 'act',
      tone: 'neutral',
      title: input.reviewCount === 1
        ? '1 transaction to check'
        : `${input.reviewCount} transactions to check`,
      to: REVIEW_LINK,
      unread: false,
      stage: null,
      source: { kind: 'review', count: input.reviewCount },
    });
  }

  const know: AttentionItem[] = showInsights
    ? input.insights.map(insight => ({
      key: insight.key,
      tier: 'know' as const,
      tone: INSIGHT_TONE[insight.direction],
      title: insight.title,
      to: insight.link.to,
      unread: insight.unread,
      stage: insight.stage,
      source: { kind: 'insight' as const, insight },
    }))
    : [];

  const unreadCount = act.filter(i => i.unread).length + know.filter(i => i.unread).length;

  return { act, know, unreadCount, total: act.length + know.length };
}

/** How many `know` rows fit, given whether anything needs acting on. */
export function knowLimit(actCount: number): number {
  return actCount === 0 ? KNOW_ROWS_ALONE : KNOW_ROWS;
}

/**
 * What the card actually renders. Collapsed it shows the top of each tier;
 * expanded it shows everything, and `hidden` is what the "Show all" line counts.
 */
export function visibleFeed(feed: AttentionFeed, expanded: boolean): {
  act: AttentionItem[]; know: AttentionItem[]; hidden: number;
} {
  if (expanded) return { act: feed.act, know: feed.know, hidden: 0 };
  const act = feed.act.slice(0, ACT_ROWS);
  const know = feed.know.slice(0, knowLimit(feed.act.length));
  return { act, know, hidden: feed.total - act.length - know.length };
}
