/**
 * `users.ui_preferences` — the account-level JSON blob that carries small,
 * cross-device display decisions (chosen categories, bill list length, category
 * aliases).
 *
 * It is ONE column shared by several features, so every writer has to merge
 * rather than assign: a page that PUTs only its own keys silently deletes
 * everybody else's. Settings and Overview each hand-roll that merge against a
 * ref of the last blob they read; this module is the same pattern with the blob
 * cached once for the whole app, so a feature that has no profile-loading code
 * of its own can still write a preference safely.
 */

import { settingsApi } from './api';

/** The last blob we read or wrote. Merged into on every patch. */
let cached: Record<string, unknown> = {};
let loaded = false;

/** Forget everything — call on logout / user switch so prefs can't cross accounts. */
export function resetUiPrefsCache(): void {
  cached = {};
  loaded = false;
}

/**
 * Read the profile's preferences. Cached after the first successful call; a
 * failure is not cached, so a cold backend just means the next caller retries.
 */
export async function loadUiPrefs(): Promise<Record<string, unknown>> {
  if (loaded) return cached;
  try {
    const p = await settingsApi.getProfile() as { ui_preferences?: Record<string, unknown> };
    cached = p?.ui_preferences ?? {};
    loaded = true;
  } catch {
    // Offline or a sleeping backend: the local persisted copy still applies.
  }
  return cached;
}

/**
 * Merge `patch` into the stored preferences.
 *
 * Best-effort by design: the caller has already updated local state, which is
 * persisted on this device regardless. A failed write costs cross-device sync of
 * that one preference, never the preference itself.
 */
export async function patchUiPrefs(patch: Record<string, unknown>): Promise<void> {
  await loadUiPrefs();
  cached = { ...cached, ...patch };
  try {
    await settingsApi.updateProfile({ ui_preferences: cached });
  } catch {
    /* local copy persists; next successful write carries this along */
  }
}
