import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Card from '../common/Card';
import { useStore } from '../../store';
import { alertStatesDS } from '../../services/dataService';
import { useReview } from '../../hooks/useReview';
import { describeInsight, whyInsightMatters, SOURCE_LABEL } from '../../utils/insightView';
import { formatCurrency, formatDate } from '../../utils/format';
import type { Insight, InsightDirection } from '../../utils/insights';
import type {
  ReviewPeriod, ReviewPeriodKind, ReviewReport, ReviewRisk, ReviewRiskFacts, ReviewTotals,
} from '../../utils/review';

/**
 * Phase 6.2 — the financial review (UI).
 *
 * The card holds NO arithmetic and no thresholds. `reviewDS.build()` runs the
 * Phase 6.2 engine over the Phase 6.1 insights, the period's own totals and —
 * for the latest period — the forecast and goals reports; everything below is
 * formatting, navigation and the period picker.
 *
 * The shape of the page is the shape of the answer:
 *
 *   • the period's totals, against the period before it;
 *   • the BIGGEST movements, whichever way they went;
 *   • what got worse, then what got better — both are the leftovers, so nothing
 *     is read twice;
 *   • what is coming that the period itself does not show;
 *   • and what the user could actually do next.
 *
 * A quiet period is a real answer and says so. A period the history does not
 * cover says THAT instead, because "nothing happened" and "we cannot see" are
 * different sentences and only one of them is true.
 */

const DIRECTION_STYLE: Record<InsightDirection, { dot: string; text: string }> = {
  worsening: { dot: 'bg-[#f59e0b]', text: 'text-[#9b8b3b] dark:text-[#d4c15e]' },
  improving: { dot: 'bg-[#22c55e]', text: 'text-[#22c55e]' },
  neutral: { dot: 'bg-brand', text: 'text-zinc-500 dark:text-zinc-400' },
};

const KIND_NOUN: Record<ReviewPeriodKind, string> = { week: 'week', month: 'month' };

/** "August 2026", or "10 Aug – 16 Aug 2026". */
function periodLabel(period: ReviewPeriod): string {
  if (period.kind === 'month') {
    return new Date(`${period.from}T00:00:00Z`).toLocaleDateString('en-AU', {
      month: 'long', year: 'numeric', timeZone: 'UTC',
    });
  }
  const start = new Date(`${period.from}T00:00:00Z`).toLocaleDateString('en-AU', {
    day: 'numeric', month: 'short', timeZone: 'UTC',
  });
  return `${start} – ${formatDate(period.to)}`;
}

/** WHAT the risk is, in the user's currency. Same split as `describeInsight`. */
function describeRisk(facts: ReviewRiskFacts, currency: string): string {
  const money = (n: number) => formatCurrency(n, currency);

  switch (facts.kind) {
    case 'cash-shortfall':
      return `Your cash is projected to reach ${money(facts.lowest)} on ${formatDate(facts.lowestDate)}, `
        + `from ${money(facts.openingBalance)} today.`;

    case 'cash-drain':
      return `${money(Math.abs(facts.net))} more is due out than in over the next ${facts.days} days — `
        + `${money(facts.openingBalance)} today, ${money(facts.projectedBalance)} projected.`;

    case 'goal-shortfall': {
      if (facts.overdue) {
        return `${facts.name} is still ${money(facts.remaining)} short`
          + (facts.targetDate ? `, and its date passed on ${formatDate(facts.targetDate)}.` : '.');
      }
      const needed = facts.requiredPerMonth != null ? money(facts.requiredPerMonth) : null;
      return `${facts.name} needs ${needed ?? 'more'} a month and your forecast frees up `
        + `${money(facts.allocatedPerMonth)} — ${money(facts.shortfallPerMonth)} a month short.`;
    }
  }
}

export default function ReviewSection({ currency }: { currency: string }) {
  // Closed by default — see the card below for why.
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<ReviewPeriodKind>('month');
  const [periodKey, setPeriodKey] = useState<string | null>(null);
  const { report, periods } = useReview({ kind, periodKey });
  const navigate = useNavigate();
  // An account with no transactions in it has no period to review. Every other
  // empty state here is a real answer ("a quiet month", "not loaded"); this one
  // is just an empty app, so the card stays out of the way entirely.
  const hasHistory = useStore(s => s.transactions.length > 0);

  // Where the period being shown sits in the list, so the arrows know what is
  // on either side of it. Older is DOWN the list: `periods` is newest first.
  const index = useMemo(
    () => Math.max(0, periods.findIndex(p => p.key === report.period.key)),
    [periods, report.period.key],
  );
  const older = periods[index + 1] ?? null;
  const newer = index > 0 ? periods[index - 1] : null;

  const noun = KIND_NOUN[report.period.kind];

  if (!hasHistory) return null;

  const switchKind = (next: ReviewPeriodKind) => {
    // The key belongs to the old kind — drop it, so the toggle lands on the
    // latest review of the kind asked for rather than on nothing.
    setKind(next);
    setPeriodKey(null);
  };

  // The period's headline, for the closed state: which period, and what it came
  // to. Enough to decide whether to open it, which is the only question a
  // collapsed card has to answer.
  const summary = report.totals
    ? `${periodLabel(report.period)} · ${formatCurrency(report.totals.spend, currency)} spent, `
      + `${formatCurrency(report.totals.income, currency)} in`
    : periodLabel(report.period);

  return (
    <Card padding="none" className="mb-4 overflow-hidden">
      {/* Closed by default, and closed it is ONE line. The full review is a
          deliberate read — a period picker, a totals grid and five groups of
          rows — and it has no business sitting permanently open above the fold
          next to everything else the Overview is already saying. */}
      <button
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        className="w-full px-5 py-4 flex items-center justify-between gap-3 text-left hover:bg-zinc-50 dark:hover:bg-zinc-900/40 transition-colors"
      >
        <div className="min-w-0">
          <h2 className="text-base font-semibold flex items-center gap-2 flex-wrap">
            <span>Your {noun} in review</span>
            {!report.latest && (
              <span className="text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400">
                Past {noun}
              </span>
            )}
          </h2>
          <p className="text-[11px] text-zinc-500 dark:text-zinc-400 mt-0.5 truncate">
            {summary}
          </p>
        </div>
        <span
          aria-hidden
          className={`flex-shrink-0 text-zinc-300 dark:text-zinc-600 transition-transform duration-200 ${open ? 'rotate-90' : ''}`}
        >
          &rsaquo;
        </span>
      </button>

      {open && (
        <div className="px-5 pb-5 border-t border-zinc-100 dark:border-zinc-800/60 pt-4">
          <div className="flex items-center justify-between gap-2 mb-3 flex-wrap">
            <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
              {report.comparedWith
                ? <>Against {formatDate(report.comparedWith.from)} – {formatDate(report.comparedWith.to)}</>
                : <>{periodLabel(report.period)}</>}
            </p>
            <div className="flex items-center gap-2 flex-shrink-0">
              <div className="flex rounded-lg border border-zinc-200 dark:border-zinc-800 overflow-hidden">
                {(['week', 'month'] as ReviewPeriodKind[]).map(k => (
                  <button
                    key={k}
                    onClick={() => switchKind(k)}
                    className={`text-[11px] px-2.5 py-1 transition-colors ${
                      kind === k
                        ? 'bg-brand text-white'
                        : 'text-zinc-500 dark:text-zinc-400 hover:text-brand'
                    }`}
                  >
                    {k === 'week' ? 'Weekly' : 'Monthly'}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => older && setPeriodKey(older.key)}
                  disabled={!older}
                  title={older ? `Review ${periodLabel(older)}` : 'No earlier review'}
                  className="w-7 h-7 rounded-lg border border-zinc-200 dark:border-zinc-800 text-zinc-500 dark:text-zinc-400 disabled:opacity-30 hover:text-brand transition-colors"
                >
                  &lsaquo;
                </button>
                <button
                  onClick={() => newer && setPeriodKey(newer.key)}
                  disabled={!newer}
                  title={newer ? `Review ${periodLabel(newer)}` : 'This is the latest review'}
                  className="w-7 h-7 rounded-lg border border-zinc-200 dark:border-zinc-800 text-zinc-500 dark:text-zinc-400 disabled:opacity-30 hover:text-brand transition-colors"
                >
                  &rsaquo;
                </button>
              </div>
            </div>
          </div>

          {!report.covered ? (
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              Not enough history loaded to review this {noun}. {report.skipped[0]}
            </p>
          ) : (
            <ReviewBody report={report} currency={currency} navigate={navigate} noun={noun} />
          )}
        </div>
      )}
    </Card>
  );
}

function ReviewBody({ report, currency, navigate, noun }: {
  report: ReviewReport;
  currency: string;
  navigate: (to: string) => void;
  noun: string;
}) {
  const windowDays = report.period.days;

  const open = (insight: Insight) => {
    // Reading it here is reading it — recorded at the CURRENT stage, so the same
    // movement growing later still counts as news on the insight card.
    alertStatesDS.save(insight.key, { readStage: insight.stage });
    navigate(insight.link.to);
  };

  return (
    <>
      {report.totals && <Totals totals={report.totals} currency={currency} />}

      {report.quiet ? (
        <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-3">
          A quiet {noun} — nothing moved far enough from your usual to be worth reporting.
        </p>
      ) : (
        <div className="space-y-4 mt-4">
          <Group title="Biggest changes" items={report.biggest} currency={currency}
            windowDays={windowDays} onOpen={open} />

          {report.risks.length > 0 && (
            <div>
              <GroupHeading title="Upcoming risks" hint="What this period does not show yet" />
              <div className="space-y-2">
                {report.risks.map(risk => (
                  <RiskRow key={risk.key} risk={risk} currency={currency}
                    onOpen={() => navigate(risk.link.to)} />
                ))}
              </div>
            </div>
          )}

          <Group title="What worsened" items={report.worsened} currency={currency}
            windowDays={windowDays} onOpen={open} />
          <Group title="What improved" items={report.improved} currency={currency}
            windowDays={windowDays} onOpen={open} />

          {report.actions.length > 0 && (
            <div>
              <GroupHeading title="Worth doing" />
              <div className="space-y-1.5">
                {report.actions.map(action => (
                  <button
                    key={action.key}
                    onClick={() => navigate(action.to)}
                    className="w-full text-left rounded-[10px] border border-zinc-200 dark:border-zinc-800 px-3 py-2 hover:border-brand transition-colors"
                  >
                    <span className="text-xs font-medium text-brand">{action.label} →</span>
                    <span className="block text-[11px] text-zinc-500 dark:text-zinc-400 mt-0.5">
                      {action.reason}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* What is NOT in the review, and why. Each of these is an omission the
          user would otherwise read as "nothing to report". */}
      <div className="mt-4 space-y-1">
        {report.omitted > 0 && (
          <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
            And {report.omitted} smaller change{report.omitted === 1 ? '' : 's'} — see What changed.
          </p>
        )}
        {report.suppressed.alerts > 0 && (
          <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
            {report.suppressed.alerts} more {report.suppressed.alerts === 1 ? 'is' : 'are'} already in
            Needs your attention, so {report.suppressed.alerts === 1 ? 'it is' : 'they are'} not repeated here.
          </p>
        )}
        {report.skipped.map(note => (
          <p key={note} className="text-[11px] text-zinc-500 dark:text-zinc-400">{note}</p>
        ))}
      </div>
    </>
  );
}

/** The period's own figures, against the period it was compared with. */
function Totals({ totals, currency }: { totals: ReviewTotals; currency: string }) {
  const money = (n: number) => formatCurrency(n, currency);

  const rows: { label: string; value: number; delta: number; goodWhenUp: boolean }[] = [
    { label: 'Spent', value: totals.spend, delta: totals.spendDelta, goodWhenUp: false },
    { label: 'Money in', value: totals.income, delta: totals.incomeDelta, goodWhenUp: true },
    { label: 'Net', value: totals.net, delta: totals.netDelta, goodWhenUp: true },
  ];

  return (
    <div className="grid grid-cols-3 gap-2">
      {rows.map(row => {
        const good = row.delta === 0 ? null : (row.delta > 0) === row.goodWhenUp;
        return (
          <div key={row.label} className="rounded-[10px] bg-zinc-50 dark:bg-zinc-900/40 px-3 py-2">
            <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{row.label}</p>
            <p className="text-sm font-semibold amount mt-0.5">{money(row.value)}</p>
            <p className={`text-[11px] mt-0.5 ${
              good === null
                ? 'text-zinc-500 dark:text-zinc-400'
                : good ? 'text-[#22c55e]' : 'text-[#9b8b3b] dark:text-[#d4c15e]'
            }`}>
              {row.delta === 0
                ? 'no change'
                : `${row.delta > 0 ? '+' : '−'}${money(Math.abs(row.delta))}`}
            </p>
          </div>
        );
      })}
    </div>
  );
}

function GroupHeading({ title, hint }: { title: string; hint?: string }) {
  return (
    <p className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400 mb-1.5">
      {title}
      {hint && <span className="ml-2 font-normal normal-case tracking-normal">{hint}</span>}
    </p>
  );
}

function Group({ title, items, currency, windowDays, onOpen }: {
  title: string;
  items: Insight[];
  currency: string;
  windowDays: number;
  onOpen: (insight: Insight) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div>
      <GroupHeading title={title} />
      <div className="space-y-2">
        {items.map(insight => (
          <ReviewRow key={insight.key} insight={insight} currency={currency}
            windowDays={windowDays} onOpen={() => onOpen(insight)} />
        ))}
      </div>
    </div>
  );
}

function ReviewRow({ insight, currency, windowDays, onOpen }: {
  insight: Insight;
  currency: string;
  windowDays: number;
  onOpen: () => void;
}) {
  const style = DIRECTION_STYLE[insight.direction];

  return (
    <div className="rounded-[10px] border border-zinc-200 dark:border-zinc-800 px-3 py-2.5">
      <div className="flex items-start gap-2.5">
        <span className={`mt-[6px] w-2 h-2 rounded-full flex-shrink-0 ${style.dot}`} />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{insight.title}</p>
          <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
            {describeInsight(insight.facts, currency, windowDays)}
          </p>
          <p className={`text-xs mt-1 ${style.text}`}>
            {whyInsightMatters(insight, currency)}
          </p>
          <div className="flex items-center gap-3 mt-1.5 flex-wrap">
            <button onClick={onOpen} className="text-xs text-brand hover:underline font-medium">
              {insight.link.label} →
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

function RiskRow({ risk, currency, onOpen }: {
  risk: ReviewRisk;
  currency: string;
  onOpen: () => void;
}) {
  const dot = risk.severity === 'high' ? 'bg-[#ef4444]' : 'bg-[#f59e0b]';

  return (
    <div className="rounded-[10px] border border-zinc-200 dark:border-zinc-800 px-3 py-2.5">
      <div className="flex items-start gap-2.5">
        <span className={`mt-[6px] w-2 h-2 rounded-full flex-shrink-0 ${dot}`} />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{risk.title}</p>
          <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
            {describeRisk(risk.facts, currency)}
          </p>
          <div className="flex items-center gap-3 mt-1.5 flex-wrap">
            <button onClick={onOpen} className="text-xs text-brand hover:underline font-medium">
              {risk.link.label} →
            </button>
            <span className="text-[10px] text-zinc-400 dark:text-zinc-600">
              {risk.source === 'forecast' ? 'From your forecast' : 'From your goals'}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
