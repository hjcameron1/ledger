/**
 * Demo / test mode — the "Skip for now" path on the login screen.
 *
 * A demo session is a fake local-only user (no backend row, no JWT): every API
 * call 401s silently and the app runs off the persisted local store. It exists
 * so the app can be explored and tested without creating an account.
 *
 * ── Disabling before launch ──────────────────────────────────────────────────
 * Flip DEMO_LOGIN_ENABLED to false. That removes the button from the login
 * screen; everything else keys off isDemoSession(), which stays in place so an
 * already-persisted demo session degrades gracefully (it is simply logged out
 * by the next 401 once the interceptor stops special-casing... it doesn't —
 * the interceptor keeps recognising the token so a stale demo session never
 * traps a device in a logout loop).
 */

import type { User } from '../types';

/** Kill switch: set to false to remove guest/demo access before launch. */
export const DEMO_LOGIN_ENABLED = true;

/** The sentinel token a demo session carries instead of a real JWT. */
export const DEMO_TOKEN = 'demo-token';

/** True when the given auth token belongs to the local demo session. */
export function isDemoSession(token: string | null | undefined): boolean {
  return token === DEMO_TOKEN;
}

/**
 * The fake user a demo session signs in as. `onboarding_complete: true` is
 * deliberate — demo mode goes straight into the app and NEVER enters the
 * real-user onboarding flow (no server row exists to persist progress to).
 */
export const DEMO_USER: User = {
  id: 'demo',
  email: 'demo@ledger.app',
  name: 'Harry',
  currency_preference: 'AUD',
  theme: 'light',
  plan: 'premium',
  onboarding_complete: true,
};
