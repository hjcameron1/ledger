import { describe, it, expect } from 'vitest';
import { nextOccurrence, healOverdue } from './recurrence';

// A fixed "today" so the tests are deterministic regardless of when they run.
const TODAY = new Date('2026-08-12T00:00:00Z');

describe('nextOccurrence — never lands on an already-overdue date (any gap)', () => {
  it('a bill due TODAY advances exactly one period', () => {
    expect(nextOccurrence('2026-08-12', 'monthly', TODAY)).toBe('2026-09-12');
  });

  it('a bill overdue by ONE period rolls to the first future occurrence', () => {
    // due 2026-07-12 → +1mo = 2026-08-12 (== today, not < today) → stays 08-12.
    expect(nextOccurrence('2026-07-12', 'monthly', TODAY)).toBe('2026-08-12');
  });

  it('a bill overdue by MANY periods skips straight past every missed one', () => {
    // A monthly mortgage last due Feb → the next non-overdue occurrence is Sep,
    // NOT March. This is the "keeps coming back" fix: one tick, not seven.
    expect(nextOccurrence('2026-02-01', 'monthly', TODAY)).toBe('2026-09-01');
  });

  it('works the same for weekly / fortnightly / quarterly / annually', () => {
    expect(nextOccurrence('2026-06-01', 'weekly', TODAY)).toBe('2026-08-17');
    expect(nextOccurrence('2026-06-01', 'fortnightly', TODAY)).toBe('2026-08-24');
    expect(nextOccurrence('2025-01-01', 'quarterly', TODAY)).toBe('2026-10-01');
    expect(nextOccurrence('2020-05-03', 'annually', TODAY)).toBe('2027-05-03');
  });

  it('is case-insensitive and accepts the "yearly" alias', () => {
    expect(nextOccurrence('2020-05-03', 'YEARLY', TODAY)).toBe('2027-05-03');
    expect(nextOccurrence('2026-08-12', 'Monthly', TODAY)).toBe('2026-09-12');
  });

  it('returns null for a frequency it cannot advance (irregular/unknown)', () => {
    // No defined "next" → caller marks paid and creates nothing (never a same-date
    // duplicate that would instantly re-surface).
    expect(nextOccurrence('2026-02-01', 'irregular', TODAY)).toBeNull();
    expect(nextOccurrence('2026-02-01', undefined, TODAY)).toBeNull();
    expect(nextOccurrence('2026-02-01', null, TODAY)).toBeNull();
  });

  it('returns null for an unparseable date rather than throwing', () => {
    expect(nextOccurrence('not-a-date', 'monthly', TODAY)).toBeNull();
  });
});

describe('healOverdue — self-heals a drifted schedule, leaves a healthy one alone', () => {
  it('rolls a past due date forward to the first non-overdue occurrence', () => {
    expect(healOverdue('2026-02-01', 'monthly', TODAY)).toBe('2026-09-01');
  });

  it('leaves a future (or today) due date untouched', () => {
    expect(healOverdue('2026-09-01', 'monthly', TODAY)).toBe('2026-09-01');
    expect(healOverdue('2026-08-12', 'monthly', TODAY)).toBe('2026-08-12');
  });

  it('returns null when it cannot advance an overdue date', () => {
    expect(healOverdue('2026-02-01', 'irregular', TODAY)).toBeNull();
  });
});
