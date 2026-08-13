/**
 * Review cutoff — the "start fresh" line for the Needs Review / AI-suggestion
 * backlog.
 *
 * "Clear all" in the review UI records the current time here. From then on only
 * transactions ADDED on/after the cutoff (by `created_at`) are ever surfaced for
 * review or sent to the AI fallback — the historical backlog is dropped so the
 * feature works from new transactions only, exactly as asked.
 *
 * It is a display/scope filter, NOT a data mutation: nothing is written to the
 * database, so clearing a 1000-item backlog is instant and works offline (no
 * flood of sync writes). It's stored per-user in localStorage so it survives
 * reload and doesn't leak between accounts on a shared browser.
 *
 * PURE-ish — only touches localStorage (guarded for non-browser/SSR/test).
 */

function keyFor(userId?: string | null): string {
  return userId ? `ledger:reviewCutoff:${userId}` : 'ledger:reviewCutoff';
}

/** The current cutoff (ISO string) for this user, or null if none set. */
export function getReviewCutoff(userId?: string | null): string | null {
  try { return localStorage.getItem(keyFor(userId)); } catch { return null; }
}

/** Record "now" as the cutoff for this user; returns the ISO timestamp stored. */
export function setReviewCutoffNow(userId?: string | null): string {
  const iso = new Date().toISOString();
  try { localStorage.setItem(keyFor(userId), iso); } catch { /* ignore */ }
  return iso;
}

/** Remove the cutoff for this user (un-hide the historical backlog again). */
export function clearReviewCutoff(userId?: string | null): void {
  try { localStorage.removeItem(keyFor(userId)); } catch { /* ignore */ }
}

/**
 * Is this transaction in scope given the cutoff? True when there is no cutoff, or
 * the row was added on/after it. A row with no `created_at` is treated as
 * pre-cutoff backlog (out of scope) so "Clear all" reliably clears it.
 */
export function isAfterReviewCutoff(t: { created_at?: string | null }, cutoff: string | null): boolean {
  if (!cutoff) return true;
  if (!t.created_at) return false;
  return t.created_at >= cutoff;
}
