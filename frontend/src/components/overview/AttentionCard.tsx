import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Card from '../common/Card';
import { useStore } from '../../store';
import { alertStatesDS } from '../../services/dataService';
import { useAlerts } from '../../hooks/useAlerts';
import { useInsights } from '../../hooks/useInsights';
import { reviewCount } from '../../utils/reviewQueue';
import { getReviewCutoff, isAfterReviewCutoff } from '../../utils/reviewCutoff';
import { describeAlert } from '../../utils/alertView';
import { describeInsight } from '../../utils/insightView';
import { buildAttentionFeed, visibleFeed } from '../../utils/attention';
import type { AttentionItem, AttentionTone } from '../../utils/attention';

/**
 * The top of the Overview: everything the user needs to know right now, in ONE
 * card.
 *
 * This replaces three stacked cards — "Needs your attention" (alerts), "What
 * changed" (insights) and an embedded "Needs review" transaction queue. Each was
 * reasonable alone; together they put four headings, four subtitles, four unread
 * pills and about thirty lines of bordered boxes above the fold, and the reader's
 * only workable response to thirty competing boxes is to skip all of them.
 *
 * What changed, and why:
 *
 *  • ONE card, two labelled tiers. "Needs you" is what is wrong or waiting;
 *    "What changed" is the picture moving. Mixing the two is what made an
 *    overdrawn account read like a 4% rise in groceries.
 *  • ONE sentence per row. The provenance line, the second "why it matters"
 *    sentence and the per-row link label are gone from here — they still live in
 *    the period review below, which is the slow, deliberate read where they
 *    belong. Here, the whole row is the link.
 *  • Rows are hairlines, not boxes. Four bordered, tinted boxes inside a bordered
 *    card is three borders too many; severity now shows as a single small dot.
 *  • The import queue is one row, not an editable list. Working through it is a
 *    job, and it has a page: Accounts → Needs Review.
 *
 * The ordering, tiering and capping live in `utils/attention.ts` and are tested
 * there. Everything below is formatting, navigation and one piece of state.
 */

const TONE_DOT: Record<AttentionTone, string> = {
  critical: 'bg-[#ef4444]',
  warning: 'bg-[#f59e0b]',
  good: 'bg-[#22c55e]',
  neutral: 'bg-zinc-300 dark:bg-zinc-600',
};

export default function AttentionCard({ currency, showAlerts = true, showInsights = true }: {
  currency: string;
  showAlerts?: boolean;
  showInsights?: boolean;
}) {
  const alertReport = useAlerts();
  const insightReport = useInsights();
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState(false);

  // The import queue, counted the same way the queue itself counts it — the
  // cutoff set by "Clear all" suppresses the historical backlog, and a row
  // saying "412 transactions to check" about a backlog the user has already
  // dismissed would be worse than no row at all.
  const transactions = useStore(s => s.transactions);
  const userId = useStore(s => s.user?.id);
  const toCheck = useMemo(() => {
    const cutoff = getReviewCutoff(userId);
    return reviewCount(transactions.filter(t => isAfterReviewCutoff(t, cutoff)));
  }, [transactions, userId]);

  const feed = useMemo(
    () => buildAttentionFeed({
      alerts: alertReport.visible,
      insights: insightReport.visible,
      reviewCount: toCheck,
      showAlerts,
      showInsights,
    }),
    [alertReport.visible, insightReport.visible, toCheck, showAlerts, showInsights],
  );

  // Nothing wrong and nothing moved: stay out of the way entirely. A healthy
  // week should cost no space at all.
  if (feed.total === 0) return null;

  const shown = visibleFeed(feed, expanded);

  const detailFor = (item: AttentionItem): string => {
    switch (item.source.kind) {
      case 'alert':
        return describeAlert(item.source.alert.facts, currency);
      case 'insight':
        return describeInsight(item.source.insight.facts, currency, insightReport.window.days);
      case 'review':
        return "The importer wasn't sure about these — confirm, correct or dismiss each.";
    }
  };

  // Opening a row is reading it, recorded at the CURRENT stage, so the same
  // situation getting worse later counts as news again.
  const open = (item: AttentionItem) => {
    if (item.stage != null) alertStatesDS.save(item.key, { readStage: item.stage });
    navigate(item.to);
  };

  const dismiss = (item: AttentionItem) => {
    if (item.stage != null) alertStatesDS.save(item.key, { dismissedStage: item.stage });
  };

  const markAllRead = () => {
    for (const item of [...feed.act, ...feed.know]) {
      if (item.unread && item.stage != null) alertStatesDS.save(item.key, { readStage: item.stage });
    }
  };

  return (
    <Card padding="none" className="mb-4 overflow-hidden">
      <div className="px-5 pt-4 pb-1 flex items-center justify-between gap-3">
        <h2 className="text-base font-semibold flex items-center gap-2">
          Right now
          {feed.unreadCount > 0 && (
            <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-brand/10 text-brand">
              {feed.unreadCount} new
            </span>
          )}
        </h2>
        {feed.unreadCount > 0 && (
          <button
            onClick={markAllRead}
            className="text-[11px] text-zinc-400 dark:text-zinc-500 hover:text-brand transition-colors flex-shrink-0"
          >
            Mark all read
          </button>
        )}
      </div>

      <Tier label="Needs you" items={shown.act} detailFor={detailFor} onOpen={open} onDismiss={dismiss} />
      <Tier label="What changed" items={shown.know} detailFor={detailFor} onOpen={open} onDismiss={dismiss} />

      {shown.hidden > 0 && (
        <button
          onClick={() => setExpanded(true)}
          className="w-full px-5 py-2.5 border-t border-zinc-100 dark:border-zinc-800/60 text-[11px] text-zinc-400 dark:text-zinc-500 hover:text-brand transition-colors"
        >
          Show {shown.hidden} more
        </button>
      )}
      {expanded && (
        <>
          {/* What was NOT looked at, and why. A silent absence reads as "nothing
              to report"; this says "not enough history to tell", which is a
              different sentence. Only once the user has asked for everything —
              collapsed, it would be one more line of small print. */}
          {showInsights && insightReport.skipped.length > 0 && (
            <p className="px-5 pt-2.5 text-[11px] text-zinc-400 dark:text-zinc-500">
              {insightReport.skipped[0]}
            </p>
          )}
          <button
            onClick={() => setExpanded(false)}
            className="w-full px-5 py-2.5 mt-1 border-t border-zinc-100 dark:border-zinc-800/60 text-[11px] text-zinc-400 dark:text-zinc-500 hover:text-brand transition-colors"
          >
            Show less
          </button>
        </>
      )}
    </Card>
  );
}

/** One labelled group of rows. Renders nothing when the group is empty. */
function Tier({ label, items, detailFor, onOpen, onDismiss }: {
  label: string;
  items: AttentionItem[];
  detailFor: (item: AttentionItem) => string;
  onOpen: (item: AttentionItem) => void;
  onDismiss: (item: AttentionItem) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="mt-2">
      <p className="px-5 pb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-400 dark:text-zinc-600">
        {label}
      </p>
      {items.map(item => (
        <Row key={item.key} item={item} detail={detailFor(item)}
          onOpen={() => onOpen(item)} onDismiss={() => onDismiss(item)} />
      ))}
    </div>
  );
}

/**
 * One situation, one line of explanation, one tap.
 *
 * The row is a plain div holding two buttons rather than a button holding a
 * button — nesting them is invalid, and stopPropagation on a nested control is a
 * bug waiting for the day someone adds a keyboard handler.
 */
function Row({ item, detail, onOpen, onDismiss }: {
  item: AttentionItem;
  detail: string;
  onOpen: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="flex items-start gap-3 px-5 py-2.5 border-t border-zinc-100 dark:border-zinc-800/60 hover:bg-zinc-50 dark:hover:bg-zinc-900/40 transition-colors">
      <span
        aria-hidden
        className={`mt-[7px] w-1.5 h-1.5 rounded-full flex-shrink-0 ${TONE_DOT[item.tone]} ${item.unread ? '' : 'opacity-30'}`}
      />
      <button onClick={onOpen} className="min-w-0 flex-1 text-left">
        <span className={`block text-sm truncate ${
          item.unread ? 'font-medium' : 'font-normal text-zinc-600 dark:text-zinc-400'
        }`}>
          {item.title}
        </span>
        <span className="block text-xs text-zinc-500 dark:text-zinc-400 mt-0.5 line-clamp-2">
          {detail}
        </span>
      </button>
      {item.stage != null && (
        <button
          onClick={onDismiss}
          title="Hide this until it gets worse"
          aria-label={`Dismiss: ${item.title}`}
          className="flex-shrink-0 -mr-1 w-6 h-6 rounded-full text-zinc-300 dark:text-zinc-700 hover:text-zinc-500 dark:hover:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors leading-none"
        >
          ×
        </button>
      )}
    </div>
  );
}
