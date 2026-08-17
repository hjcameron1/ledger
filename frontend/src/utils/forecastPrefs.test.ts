import { describe, it, expect, beforeEach, vi } from 'vitest';

// sessionStorage doesn't exist in this runtime; the whole point of the module is
// that it survives navigation and dies with the tab, so it is modelled as a map
// that the "close the tab" test throws away.
let store = new Map<string, string>();
vi.stubGlobal('sessionStorage', {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => { store.set(k, String(v)); },
  removeItem: (k: string) => { store.delete(k); },
  clear: () => store.clear(),
  key: () => null,
  get length() { return store.size; },
});

import {
  FORECAST_SCOPE_KEY, ALL_ACCOUNTS,
  readForecastScope, writeForecastScope, resolveForecastScope,
  readSessionPref, writeSessionPref,
} from './forecastPrefs';

const OPTIONS = [
  { value: 'all' }, { value: 'acc-everyday' }, { value: 'acc-savings' },
];

beforeEach(() => { store = new Map(); });

// ═════════════════════════════════════════════════════════════════════════════
//  Surviving navigation
// ═════════════════════════════════════════════════════════════════════════════
describe('the chosen account persists for the session', () => {
  it('comes back after the page is left and re-entered', () => {
    writeForecastScope('acc-savings');
    // A route change unmounts Forecast entirely; the next mount re-reads this.
    expect(readForecastScope()).toBe('acc-savings');
    expect(resolveForecastScope(readForecastScope(), OPTIONS)).toBe('acc-savings');
  });

  it('starts on all accounts when nothing has been chosen', () => {
    expect(readForecastScope()).toBe(ALL_ACCOUNTS);
    expect(resolveForecastScope(readForecastScope(), OPTIONS)).toBe('all');
  });

  it('follows the user when they change their mind', () => {
    writeForecastScope('acc-everyday');
    writeForecastScope('acc-savings');
    expect(readForecastScope()).toBe('acc-savings');
  });

  it('is forgotten when the session ends', () => {
    writeForecastScope('acc-savings');
    store = new Map();          // new tab / browser restart
    expect(readForecastScope()).toBe(ALL_ACCOUNTS);
  });

  it('lives in sessionStorage, NOT localStorage', () => {
    // A viewing filter must not outlive the session: returning weeks later to a
    // headline that quietly describes one account is worse than re-picking it.
    writeForecastScope('acc-savings');
    expect(store.get(FORECAST_SCOPE_KEY)).toBe('acc-savings');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Falling back safely
// ═════════════════════════════════════════════════════════════════════════════
describe('resolveForecastScope', () => {
  it('falls back to all accounts when the account has gone', () => {
    expect(resolveForecastScope('acc-deleted', OPTIONS)).toBe(ALL_ACCOUNTS);
  });

  it('falls back for an empty or missing value', () => {
    expect(resolveForecastScope(null, OPTIONS)).toBe(ALL_ACCOUNTS);
    expect(resolveForecastScope('   ', OPTIONS)).toBe(ALL_ACCOUNTS);
  });

  it('KEEPS the choice while the account list is still loading', () => {
    // An empty list means "not loaded yet", not "your account is gone". Resetting
    // here would wipe the selection on every cold render before the fetch lands.
    expect(resolveForecastScope('acc-savings', [])).toBe('acc-savings');
  });

  it('passes through the unallocated bucket when the engine offers it', () => {
    expect(resolveForecastScope('__unallocated__', [...OPTIONS, { value: '__unallocated__' }]))
      .toBe('__unallocated__');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Storage that refuses to work
// ═════════════════════════════════════════════════════════════════════════════
describe('when sessionStorage throws', () => {
  it('degrades to no memory rather than breaking the page', () => {
    // Safari in private mode throws on access. A remembered filter is never
    // worth a blank Forecast.
    vi.stubGlobal('sessionStorage', {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
      removeItem: () => { throw new Error('denied'); },
    });
    expect(() => writeSessionPref('k', 'v')).not.toThrow();
    expect(readSessionPref('k')).toBeNull();
    expect(readForecastScope()).toBe(ALL_ACCOUNTS);
  });
});
