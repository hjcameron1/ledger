/**
 * Canonical recurrence engine (backend).
 *
 * ONE place that answers "given a due date and a frequency, when is the next
 * occurrence?". Both the bill tick-off route and the loan→bill mirror route go
 * through this so a recurring item can never be left sitting in the past — the
 * root cause of a bill/reminder/mortgage that "keeps coming up over and over".
 *
 * Mirrors the frontend's nextOccurrence() semantics (calendar months for
 * monthly/quarterly, calendar years for annual) so both ends agree.
 */

/** Advance a Date IN PLACE by exactly one period. Unknown/irregular → not present. */
export const FREQ_ADVANCE: Record<string, (d: Date) => void> = {
  weekly: (d) => d.setDate(d.getDate() + 7),
  fortnightly: (d) => d.setDate(d.getDate() + 14),
  monthly: (d) => d.setMonth(d.getMonth() + 1),
  quarterly: (d) => d.setMonth(d.getMonth() + 3),
  annually: (d) => d.setFullYear(d.getFullYear() + 1),
  yearly: (d) => d.setFullYear(d.getFullYear() + 1),
};

/** Today at UTC midnight — the comparison basis for a 'YYYY-MM-DD' due date
 *  (which `new Date(str)` parses as UTC midnight). */
export function utcToday(): Date {
  const t = new Date();
  t.setUTCHours(0, 0, 0, 0);
  return t;
}

/**
 * The next occurrence of a recurring item as a 'YYYY-MM-DD' string, or null when
 * the frequency isn't one we can advance (irregular/unknown — no defined "next").
 *
 * Always moves AT LEAST one period past `fromISO` (the occurrence just handled),
 * then keeps skipping any further missed periods until the result is no longer in
 * the past. So whether an item is due today or overdue by six months, the answer
 * is the first date that isn't already overdue — never a still-overdue date that
 * would immediately re-surface. This is what makes tick-off work for ANY gap.
 */
export function nextOccurrence(
  fromISO: string,
  frequency: string | null | undefined,
  today: Date = utcToday(),
): string | null {
  const advance = frequency ? FREQ_ADVANCE[frequency.toLowerCase()] : undefined;
  if (!advance) return null;
  const next = new Date(fromISO);
  if (isNaN(next.getTime())) return null;
  advance(next);                       // the current occurrence is handled — move on
  while (next < today) advance(next);  // skip every further missed period
  return next.toISOString().split('T')[0];
}

/**
 * If a due date is already in the past, roll it forward to the next non-overdue
 * occurrence; otherwise leave it as-is. Used to self-heal a schedule (e.g. a
 * loan's next_due_date) that has drifted into the past. Returns the (possibly
 * unchanged) 'YYYY-MM-DD' string, or null when it can't be advanced.
 */
export function healOverdue(
  dueISO: string,
  frequency: string | null | undefined,
  today: Date = utcToday(),
): string | null {
  const due = new Date(dueISO);
  if (isNaN(due.getTime())) return null;
  if (due >= today) return dueISO;
  return nextOccurrence(dueISO, frequency, today);
}
