import { useCallback, useEffect, useMemo, useState } from 'react';
import { useStore } from '../store';
import { useScopeKey } from './useScopeKey';
import { insightsDS, alertStatesDS } from '../services/dataService';
import { useAlerts } from './useAlerts';
import type { InsightReport } from '../utils/insights';

/**
 * The Phase 6.1 insight list, live.
 *
 * Rebuilt whenever anything it is derived from changes — the dependency list is
 * the store slices the engines behind it read. It deliberately includes
 * `alertStates`: dismissing an insight has to remove it from the list in the
 * same tick, and the engine — not the component — is what decides that.
 *
 * It reads `useAlerts()` for one reason only: an insight must not restate what
 * an alert is already shouting about, and the alert list is the only thing that
 * knows what is currently being shouted. The build is pure, so sharing the hook
 * with the alert card costs nothing but the second pass.
 */
export function useInsights(): InsightReport {
  const transactions = useStore(s => s.transactions);
  const budgets = useStore(s => s.budgets);
  const accounts = useStore(s => s.accounts);
  const loans = useStore(s => s.loans);
  const properties = useStore(s => s.properties);
  const recurringSeries = useStore(s => s.recurringSeries);
  const transactionSplits = useStore(s => s.transactionSplits);
  const alertStates = useStore(s => s.alertStates);
  const alerts = useAlerts();
  // The build is scoped; the slices above don't move when the Personal/
  // Household switch flips, so the scope itself must be a dependency.
  const scopeKey = useScopeKey();

  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick(t => t + 1), []);

  const report = useMemo(
    () => insightsDS.build({ alerts }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [transactions, budgets, accounts, loans, properties, recurringSeries,
      transactionSplits, alertStates, alerts, scopeKey, tick],
  );

  // The report depends on today's date as much as on the data — the windows move
  // at midnight — and nothing tells us midnight has passed. Re-check on tab
  // focus, as the alert and budget cards do.
  useEffect(() => {
    const onFocus = () => refresh();
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [refresh]);

  // Drop stored dismissals whose observation has passed, so the same thing
  // happening again is heard rather than silently suppressed. Guarded on
  // `ready()`: before data loads EVERY insight looks resolved, and a blind prune
  // would wipe every dismissal the user has ever made.
  useEffect(() => {
    if (report.resolvedKeys.length > 0 && insightsDS.ready()) {
      alertStatesDS.prune(report.resolvedKeys);
    }
  }, [report]);

  return report;
}
