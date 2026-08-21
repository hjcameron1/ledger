import { useCallback, useEffect, useMemo, useState } from 'react';
import { useStore } from '../store';
import { useScopeKey } from './useScopeKey';
import { reviewDS } from '../services/dataService';
import { useAlerts } from './useAlerts';
import type { ReviewPeriod, ReviewPeriodKind, ReviewReport } from '../utils/review';

export interface ReviewView {
  report: ReviewReport;
  /** The complete periods the user can page back through, newest first. */
  periods: ReviewPeriod[];
}

/**
 * The Phase 6.2 review of one period, live.
 *
 * Rebuilt whenever anything it is derived from changes — the dependency list is
 * the store slices the engines behind it read, plus the period being looked at.
 * `alertStates` is in there because a dismissed insight stays dismissed in the
 * review, and the engine, not the component, is what decides that.
 *
 * It reads `useAlerts()` for one reason only: a review must not paraphrase what
 * an alert is already shouting, and the alert list is the only thing that knows
 * what is currently being shouted. The build is pure, so sharing the hook with
 * the alert card costs nothing but the second pass.
 *
 * Unlike `useInsights`, this hook NEVER prunes stored insight state. A review of
 * March derives March's insight keys, so every dismissal made about today would
 * come back from that build as "resolved" — pruning it would delete the user's
 * current dismissals for the crime of looking at an old review.
 */
export function useReview(opts: { kind: ReviewPeriodKind; periodKey?: string | null }): ReviewView {
  const { kind, periodKey } = opts;

  const transactions = useStore(s => s.transactions);
  const budgets = useStore(s => s.budgets);
  const accounts = useStore(s => s.accounts);
  const loans = useStore(s => s.loans);
  const properties = useStore(s => s.properties);
  const goals = useStore(s => s.goals);
  const goalContributions = useStore(s => s.goalContributions);
  const recurringSeries = useStore(s => s.recurringSeries);
  const transactionSplits = useStore(s => s.transactionSplits);
  const alertStates = useStore(s => s.alertStates);
  const alerts = useAlerts();
  // The build is scoped; the slices above don't move when the Personal/
  // Household switch flips, so the scope itself must be a dependency.
  const scopeKey = useScopeKey();

  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick(t => t + 1), []);

  const view = useMemo<ReviewView>(
    () => ({
      report: reviewDS.build({ kind, periodKey: periodKey ?? undefined, alerts }),
      periods: reviewDS.periods(kind),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [kind, periodKey, transactions, budgets, accounts, loans, properties, goals,
      goalContributions, recurringSeries, transactionSplits, alertStates, alerts, scopeKey, tick],
  );

  // Which period is the LATEST one changes at midnight, and nothing tells us
  // midnight has passed. Re-check on tab focus, as the alert and insight cards do.
  useEffect(() => {
    const onFocus = () => refresh();
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [refresh]);

  return view;
}
