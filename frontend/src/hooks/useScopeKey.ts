import { useStore } from '../store';

/**
 * One string that changes exactly when the answer to "which rows are in scope?"
 * can change — the Personal/Household switch and which household is active.
 *
 * Put it in the deps of any memo that performs a scoped read (`*DS.getAll()`,
 * `scopeRows`, a report build). The store slices those memos already depend on
 * do NOT move when the user flips the scope switch — the rows are the same
 * superset, only the narrowing changed — so without this dep the memo keeps
 * serving the OLD scope's rows. That was exactly the bug that left investments
 * and loans on screen in households they were never shared with.
 */
export function useScopeKey(): string {
  return useStore(s => `${s.financeScope}:${s.activeHouseholdId ?? ''}`);
}
