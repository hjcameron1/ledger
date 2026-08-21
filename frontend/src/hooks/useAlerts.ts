import { useCallback, useEffect, useMemo, useState } from 'react';
import { useStore } from '../store';
import { useScopeKey } from './useScopeKey';
import { alertsDS, alertStatesDS } from '../services/dataService';
import type { AlertReport } from '../utils/alerts';

/**
 * The Phase 4.4 alert list, live.
 *
 * Rebuilt whenever anything it is derived from changes — the dependency list is
 * the store slices the four engines read. It deliberately includes
 * `alertStates`: dismissing an alert has to remove it from the list in the same
 * tick, and the engine — not the component — is what decides that.
 *
 * Lives here rather than in the card because there are now two surfaces onto
 * the same alerts (the Overview's "Needs your attention" and the notification
 * bell), and they must be looking at ONE list. Calling it twice is free: the
 * build is pure, and both callers land on the same store data.
 */
export function useAlerts(): AlertReport {
  const transactions = useStore(s => s.transactions);
  const budgets = useStore(s => s.budgets);
  const goals = useStore(s => s.goals);
  const goalContributions = useStore(s => s.goalContributions);
  const accounts = useStore(s => s.accounts);
  const bills = useStore(s => s.bills);
  const alertStates = useStore(s => s.alertStates);
  // The build is scoped; the slices above don't move when the Personal/
  // Household switch flips, so the scope itself must be a dependency.
  const scopeKey = useScopeKey();

  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick(t => t + 1), []);

  const report = useMemo(
    () => alertsDS.build(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [transactions, budgets, goals, goalContributions, accounts, bills, alertStates, scopeKey, tick],
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
