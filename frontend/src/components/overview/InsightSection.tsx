import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Card from '../common/Card';
import { alertStatesDS } from '../../services/dataService';
import { useInsights } from '../../hooks/useInsights';
import { describeInsight, whyInsightMatters, SOURCE_LABEL } from '../../utils/insightView';
import type { Insight, InsightDirection } from '../../utils/insights';

/**
 * Phase 6.1 — financial insights (UI).
 *
 * The card holds NO arithmetic and no thresholds. `insightsDS.build()` runs the
 * Phase 6.1 engine over the reports the transaction, budget, forecast, loan,
 * property and tax engines have already produced, and hands back a ranked list;
 * everything below is formatting, an action per row, and the decision about how
 * many rows to show.
 *
 * Each row says the same three things, in the same order, whatever kind it is:
 *
 *   • WHAT changed  — the engine's own figures, in the user's currency;
 *   • WHY it matters — the money consequence, usually annualised, because
 *     "$6 a month" and "$72 a year" are the same fact and only one of them
 *     makes anybody act;
 *   • WHERE it came from — the engine named, and a link to the page that shows
 *     the working.
 *
 * Nothing is stored. The list is re-derived on every render pass triggered by
 * the data it depends on, so an insight disappears the moment what it describes
 * does. Dismissing is not deleting: it records the insight's stage, and the
 * engine brings it back if the movement grows materially bigger.
 */

const MAX_ROWS = 4;

const DIRECTION_STYLE: Record<InsightDirection, { dot: string; text: string }> = {
  worsening: { dot: 'bg-[#f59e0b]', text: 'text-[#9b8b3b] dark:text-[#d4c15e]' },
  improving: { dot: 'bg-[#22c55e]', text: 'text-[#22c55e]' },
  neutral: { dot: 'bg-brand', text: 'text-zinc-500 dark:text-zinc-400' },
};

export default function InsightSection({ currency }: { currency: string }) {
  const report = useInsights();
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState(false);

  const insights = report.visible;

  // Nothing worth saying: stay out of the way entirely.
  if (insights.length === 0) return null;

  const shown = expanded ? insights : insights.slice(0, MAX_ROWS);
  const hidden = insights.length - shown.length;

  const markAllRead = () => {
    for (const i of insights) {
      if (i.unread) alertStatesDS.save(i.key, { readStage: i.stage });
    }
  };

  return (
    <Card padding="none" className="mb-4 p-5">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold flex items-center gap-2">
            What changed
            {report.unreadCount > 0 && (
              <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-brand/15 text-brand">
                {report.unreadCount} new
              </span>
            )}
          </h2>
          <p className="text-[11px] text-zinc-500 dark:text-zinc-400 mt-0.5">
            The last {report.window.days} days against the {report.window.days} before, plus what your
            loans, property and tax position are doing.
          </p>
        </div>
        {report.unreadCount > 0 && (
          <button
            onClick={markAllRead}
            className="text-xs text-brand hover:underline flex-shrink-0 whitespace-nowrap"
          >
            Mark all read
          </button>
        )}
      </div>

      <div className="space-y-2">
        {shown.map(insight => (
          <InsightRow
            key={insight.key}
            insight={insight}
            currency={currency}
            windowDays={report.window.days}
            onOpen={() => {
              // Opening an insight is reading it — recorded at the CURRENT stage,
              // so the same movement growing later counts as news again.
              alertStatesDS.save(insight.key, { readStage: insight.stage });
              navigate(insight.link.to);
            }}
            onDismiss={() => alertStatesDS.save(insight.key, { dismissedStage: insight.stage })}
          />
        ))}
      </div>

      {hidden > 0 && (
        <button
          onClick={() => setExpanded(true)}
          className="mt-3 w-full flex items-center justify-center gap-1 text-[11px] text-zinc-400 dark:text-zinc-500 hover:text-brand transition-colors"
        >
          <span>Show {hidden} more</span>
          <span>→</span>
        </button>
      )}
      {expanded && insights.length > MAX_ROWS && (
        <button
          onClick={() => setExpanded(false)}
          className="mt-3 w-full text-[11px] text-zinc-400 dark:text-zinc-500 hover:text-brand transition-colors"
        >
          Show less
        </button>
      )}

      {/* What was NOT looked at, and why. A silent absence reads as "nothing to
          report"; this says "not enough history to tell", which is different. */}
      {report.skipped.length > 0 && (
        <p className="mt-3 text-[11px] text-zinc-400 dark:text-zinc-500">
          {report.skipped[0]}
        </p>
      )}
    </Card>
  );
}

function InsightRow({ insight, currency, windowDays, onOpen, onDismiss }: {
  insight: Insight;
  currency: string;
  windowDays: number;
  onOpen: () => void;
  onDismiss: () => void;
}) {
  const style = DIRECTION_STYLE[insight.direction];

  return (
    <div className="rounded-[10px] border border-zinc-200 dark:border-zinc-800 px-3 py-2.5">
      <div className="flex items-start gap-2.5">
        <span className={`mt-[6px] w-2 h-2 rounded-full flex-shrink-0 ${style.dot}`} />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium flex items-center gap-1.5 flex-wrap">
            <span className="min-w-0">{insight.title}</span>
            {insight.unread && (
              <span className="text-[9px] font-semibold uppercase tracking-wide text-brand flex-shrink-0">
                New
              </span>
            )}
          </p>
          <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
            {describeInsight(insight.facts, currency, windowDays)}
          </p>
          <p className={`text-xs mt-1 ${style.text}`}>
            {whyInsightMatters(insight, currency)}
          </p>
          {/* Actions wrap under the text on a narrow screen rather than
              squeezing the sentence into a column two words wide. */}
          <div className="flex items-center gap-3 mt-1.5 flex-wrap">
            <button onClick={onOpen} className="text-xs text-brand hover:underline font-medium">
              {insight.link.label} →
            </button>
            <button
              onClick={onDismiss}
              className="text-xs text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-300 transition-colors"
              title="Hide this until it gets bigger"
            >
              Dismiss
            </button>
            <span className="text-[10px] text-zinc-400 dark:text-zinc-600">
              {SOURCE_LABEL[insight.source]}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
