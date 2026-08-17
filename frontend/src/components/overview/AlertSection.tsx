import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Card from '../common/Card';
import { useStore } from '../../store';
import { alertsDS, alertStatesDS } from '../../services/dataService';
import { formatCurrency, formatDate } from '../../utils/format';
import type { Alert, AlertFacts, AlertSeverity } from '../../utils/alerts';

/**
 * Phase 4.4 — proactive alerts (UI).
 *
 * The card holds NO arithmetic and no thresholds. `alertsDS.build()` runs the
 * Phase 4.4 engine over the reports the budget, goal and forecast engines have
 * already produced, and hands back a sorted list; everything below is
 * formatting, an action per row, and the decision about how many rows to show.
 *
 * Two things are worth knowing about how it behaves:
 *
 *  • Nothing is stored. The list is re-derived on every render pass triggered by
 *    the data it depends on, so an alert disappears the moment the situation it
 *    describes does — no "resolve" button, no stale rows.
 *  • Dismissing is not deleting. It records the alert's stage, and the engine
 *    brings the alert back if the situation crosses into a worse one. That is
 *    why the dismiss control says "Dismiss" and not "Never show again".
 *
 * Self-hides when there is nothing to say, so a healthy month costs no space.
 */

const MAX_ROWS = 4;

const SEVERITY_STYLE: Record<AlertSeverity, { dot: string; border: string; text: string }> = {
  critical: {
    dot: 'bg-[#ef4444]',
    border: 'border-[#ef4444]/30 bg-[#ef4444]/[0.04]',
    text: 'text-[#ef4444]',
  },
  warning: {
    dot: 'bg-[#f59e0b]',
    border: 'border-[#f59e0b]/30 bg-[#f59e0b]/[0.04]',
    text: 'text-[#9b8b3b] dark:text-[#d4c15e]',
  },
  info: {
    dot: 'bg-brand',
    border: 'border-zinc-200 dark:border-zinc-800',
    text: 'text-zinc-500 dark:text-zinc-400',
  },
};

/**
 * The sentence under an alert's heading.
 *
 * The engine decided WHICH figures may be quoted; this decides how they read in
 * the user's currency and date format. Same split as `describeMessage` in
 * GoalSection — currency never crosses into a pure module.
 */
export function describeAlert(facts: AlertFacts, currency: string): string {
  const money = (n: number) => formatCurrency(n, currency);

  switch (facts.kind) {
    case 'budget-limit':
      return facts.over > 0
        ? `${money(facts.spent)} spent against a ${money(facts.limit)} cap — ${money(facts.over)} over.`
        : `${money(facts.spent)} of ${money(facts.limit)} used, ${money(facts.remaining)} left.`;

    case 'budget-projected-over':
      return `${money(facts.spent)} of ${money(facts.limit)} so far, heading for ${money(facts.projected)} `
        + `by month end — ${money(facts.by)} over.`;

    case 'goal-behind':
      if (facts.daysPast > 0) {
        return `${money(facts.remaining)} short, ${facts.daysPast} day${facts.daysPast === 1 ? '' : 's'} past the target date.`;
      }
      return facts.allocatedPerMonth > 0
        ? `Needs ${money(facts.requiredPerMonth)}/mo but only ${money(facts.allocatedPerMonth)}/mo is spare `
          + `— ${money(facts.shortfallPerMonth)}/mo short.`
        : `Needs ${money(facts.requiredPerMonth)}/mo and your forecast frees up nothing for it.`;

    case 'cash-low':
      return facts.lowest < 0
        ? `Projected to reach ${money(facts.lowest)} on ${formatDate(facts.lowestDate)}.`
        : `Projected to dip to ${money(facts.lowest)} on ${formatDate(facts.lowestDate)}, `
          + `under the ${money(facts.buffer)} buffer for your usual outgoings.`;

    case 'unusual-spend':
      return `Heading for ${money(facts.projected)} this month against a usual ${money(facts.baseline)} `
        + `— about ${facts.multiple.toFixed(1)}× normal.`;
  }
}

/**
 * Rebuild the alert list whenever anything it is derived from changes.
 *
 * The dependency list is the store slices the four engines read. It deliberately
 * includes `alertStates`: dismissing an alert has to remove it from the list in
 * the same tick, and the engine — not the component — is what decides that.
 */
function useAlerts() {
  const transactions = useStore(s => s.transactions);
  const budgets = useStore(s => s.budgets);
  const goals = useStore(s => s.goals);
  const goalContributions = useStore(s => s.goalContributions);
  const accounts = useStore(s => s.accounts);
  const bills = useStore(s => s.bills);
  const alertStates = useStore(s => s.alertStates);

  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick(t => t + 1), []);

  const report = useMemo(
    () => alertsDS.build(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [transactions, budgets, goals, goalContributions, accounts, bills, alertStates, tick],
  );

  // The report depends on today's date as much as on the data, and nothing tells
  // us midnight has passed. Re-check on tab focus, as the budget card does.
  useEffect(() => {
    const onFocus = () => refresh();
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [refresh]);

  // Drop stored dismissals whose situation has passed, so the same problem
  // recurring is heard rather than silently suppressed. Guarded on `ready()`:
  // before data loads, EVERY alert looks resolved and a blind prune would wipe
  // every dismissal the user has ever made.
  useEffect(() => {
    if (report.resolvedKeys.length > 0 && alertsDS.ready()) {
      alertStatesDS.prune(report.resolvedKeys);
    }
  }, [report]);

  return report;
}

export default function AlertSection({ currency }: { currency: string }) {
  const report = useAlerts();
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState(false);

  const alerts = report.visible;

  // Nothing wrong: stay out of the way entirely.
  if (alerts.length === 0) return null;

  const shown = expanded ? alerts : alerts.slice(0, MAX_ROWS);
  const hidden = alerts.length - shown.length;

  const markAllRead = () => {
    for (const a of alerts) {
      if (a.unread) alertStatesDS.save(a.key, { readStage: a.stage });
    }
  };

  return (
    <Card padding="none" className="mb-4 p-5">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold flex items-center gap-2">
            Needs your attention
            {report.unreadCount > 0 && (
              <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-[#ef4444]/15 text-[#ef4444]">
                {report.unreadCount} new
              </span>
            )}
          </h2>
          <p className="text-[11px] text-zinc-500 dark:text-zinc-400 mt-0.5">
            From your budgets, goals and cash-flow forecast.
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
        {shown.map(alert => (
          <AlertRow
            key={alert.key}
            alert={alert}
            currency={currency}
            onOpen={() => {
              // Opening an alert is reading it — recorded at the CURRENT stage, so
              // the same alert getting worse later counts as news again.
              alertStatesDS.save(alert.key, { readStage: alert.stage });
              navigate(alert.link.to);
            }}
            onDismiss={() => alertStatesDS.save(alert.key, { dismissedStage: alert.stage })}
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
      {expanded && alerts.length > MAX_ROWS && (
        <button
          onClick={() => setExpanded(false)}
          className="mt-3 w-full text-[11px] text-zinc-400 dark:text-zinc-500 hover:text-brand transition-colors"
        >
          Show less
        </button>
      )}
    </Card>
  );
}

function AlertRow({ alert, currency, onOpen, onDismiss }: {
  alert: Alert;
  currency: string;
  onOpen: () => void;
  onDismiss: () => void;
}) {
  const style = SEVERITY_STYLE[alert.severity];

  return (
    <div className={`rounded-[10px] border px-3 py-2.5 ${style.border}`}>
      <div className="flex items-start gap-2.5">
        <span className={`mt-[6px] w-2 h-2 rounded-full flex-shrink-0 ${style.dot}`} />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium flex items-center gap-1.5 flex-wrap">
            <span className="min-w-0">{alert.title}</span>
            {alert.unread && (
              <span className="text-[9px] font-semibold uppercase tracking-wide text-brand flex-shrink-0">
                New
              </span>
            )}
          </p>
          <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
            {describeAlert(alert.facts, currency)}
          </p>
          {/* Actions wrap under the text on a narrow screen rather than
              squeezing the sentence into a column two words wide. */}
          <div className="flex items-center gap-3 mt-1.5">
            <button onClick={onOpen} className="text-xs text-brand hover:underline font-medium">
              {alert.link.label} →
            </button>
            <button
              onClick={onDismiss}
              className="text-xs text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-300 transition-colors"
              title="Hide this until it gets worse"
            >
              Dismiss
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
