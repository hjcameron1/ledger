/**
 * How the user is currently LOOKING at the Forecast — remembered for this
 * browser session only.
 *
 * Picking an account on the Forecast page and then visiting Accounts used to
 * throw the choice away, because the page keeps it in component state and every
 * route change unmounts the page. Persisting it in `localStorage` would fix the
 * navigation case and break a more important one: a viewing filter is not a
 * setting, and finding the app still filtered to one account weeks later — with
 * the headline projection quietly describing a fraction of your money — is worse
 * than re-picking it. `sessionStorage` is exactly the lifetime wanted: it
 * survives navigation and remounts, and dies with the tab.
 *
 * PURE apart from the storage calls, which are individually guarded — Safari in
 * private mode throws on access, and a remembered filter is never worth a crash.
 */

/** Session key for the Forecast account filter. */
export const FORECAST_SCOPE_KEY = 'ledger:forecast:scope';

/** The value meaning "everything", and the fallback whenever a scope is unusable. */
export const ALL_ACCOUNTS = 'all';

export function readSessionPref(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;   // private mode / storage disabled
  }
}

export function writeSessionPref(key: string, value: string | null): void {
  try {
    if (value == null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, value);
  } catch {
    /* the filter just won't survive this navigation */
  }
}

/**
 * Which account the Forecast should show, given what was remembered and what
 * exists right now.
 *
 * Falls back to all accounts whenever the remembered one is not a real option —
 * it was deleted, hidden, or belongs to a different user on a shared device.
 * Showing a stale account's forecast, or an empty one, would both be worse than
 * showing the household total.
 *
 * IMPORTANT: an empty `options` list means the accounts have not loaded yet, not
 * that the account is gone. The remembered value is KEPT in that case, so a
 * mid-load render can't quietly reset the user's choice.
 */
export function resolveForecastScope(
  stored: string | null | undefined, options: { value: string }[],
): string {
  const want = (stored ?? '').trim();
  if (!want) return ALL_ACCOUNTS;
  if (options.length === 0) return want;
  return options.some(o => o.value === want) ? want : ALL_ACCOUNTS;
}

/** The remembered account for this session, or all accounts. */
export function readForecastScope(): string {
  return readSessionPref(FORECAST_SCOPE_KEY) ?? ALL_ACCOUNTS;
}

/** Remember the account the user just chose, for the rest of this session. */
export function writeForecastScope(scope: string): void {
  writeSessionPref(FORECAST_SCOPE_KEY, scope || ALL_ACCOUNTS);
}
