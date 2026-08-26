/**
 * Onboarding state — where a new user is up to, and which in-app guidance
 * they've seen. Lives under the `onboarding` key of `users.ui_preferences`, so
 * it follows the account across refreshes, logins and devices exactly like the
 * category and bill preferences do.
 *
 * `patchUiPrefs` merges TOP-LEVEL keys only, so this module owns the nested
 * merge for the `onboarding` object: read the current object, spread the patch
 * over it, write the whole object back. Every writer goes through
 * `patchOnboarding` for that reason.
 *
 * Demo sessions have no server row — loads come back empty and writes are
 * silently dropped by the API layer, which is the intended behaviour: demo
 * mode never enters, resumes or records real-user onboarding.
 */

import { loadUiPrefs, patchUiPrefs } from './uiPreferences';

/** The wizard's resumable steps, in order. */
export const WIZARD_STEPS = ['welcome', 'profile', 'account', 'done'] as const;
export type WizardStep = typeof WIZARD_STEPS[number];

/** Keys for the contextual walkthrough prompts inside the app. */
export type HintKey = 'overview' | 'transactions' | 'forecast' | 'ask';

export interface OnboardingState {
  /** Where the setup wizard is up to — resume point after refresh/login. */
  step?: WizardStep;
  /** True once the wizard finishes: arms the in-app hints + setup checklist.
   *  Never set for pre-existing users or demo sessions, so neither group is
   *  retro-shown a walkthrough. */
  guidance?: boolean;
  /** Hint prompts the user has dismissed. */
  dismissedHints?: HintKey[];
  /** True once the Overview setup checklist has been hidden. */
  checklistDismissed?: boolean;
}

/** The current onboarding object (empty for demo / offline / brand-new). */
export async function loadOnboarding(): Promise<OnboardingState> {
  const prefs = await loadUiPrefs();
  const ob = prefs.onboarding;
  return (ob && typeof ob === 'object') ? ob as OnboardingState : {};
}

/** Merge `patch` into the onboarding object and persist it. Best-effort. */
export async function patchOnboarding(patch: Partial<OnboardingState>): Promise<void> {
  const current = await loadOnboarding();
  await patchUiPrefs({ onboarding: { ...current, ...patch } });
}

/** Record a dismissed hint (idempotent). */
export async function dismissHint(key: HintKey): Promise<void> {
  const current = await loadOnboarding();
  const dismissed = current.dismissedHints ?? [];
  if (dismissed.includes(key)) return;
  await patchOnboarding({ dismissedHints: [...dismissed, key] });
}
