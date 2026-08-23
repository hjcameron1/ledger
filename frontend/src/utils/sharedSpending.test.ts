/**
 * Phase 7.2 — shared spending and responsibilities.
 *
 * The law under test: paid-by and responsibility are REPORTING metadata on the
 * one transaction that already exists. Every case below checks the two
 * invariants that make the summary trustworthy — a split distributes the money
 * and never multiplies it (shares always sum to the whole), and the paid and
 * responsible columns always total the same number, so net positions sum to
 * zero across the household.
 */

import { describe, it, expect } from 'vitest';
import type { ResponsibilityLine } from '../types';
import { buildContext } from './household';
import {
  paidBy, splitMode, validateResponsibilitySplit, responsibilityShares,
  hasAttribution, spendingContribution, memberSpending,
  type AttributedRow,
} from './sharedSpending';

// ── The cast — same couple as household.test.ts ─────────────────────────────
const ADA = 'user-ada';
const BO  = 'user-bo';
const CY  = 'user-cy';
const HH  = 'hh-1';
const OTHER_HH = 'hh-2';

const member = (user_id: string, household_id = HH, status: 'active' | 'removed' = 'active') =>
  ({ id: `m-${user_id}-${household_id}`, household_id, user_id, role: 'member' as const, status });

const COUPLE = [
  { ...member(ADA), role: 'owner' as const },
  member(BO),
];
const households = [
  { id: HH, name: 'Ada & Bo', created_by: ADA, currency: 'AUD' },
  { id: OTHER_HH, name: 'The Camerons', created_by: ADA, currency: 'AUD' },
];
const asAda = (members = COUPLE) => buildContext(ADA, households, members, HH);

/** A spend on the shared picture: negative amount = money out, Ada's unless said. */
const txn = (id: string, o: Partial<AttributedRow> = {}): AttributedRow => ({
  id, user_id: ADA, household_ids: [HH], amount: -100, ...o,
});

const split = (...lines: ResponsibilityLine[]) => lines;

// ═════════════════════════════════════════════════════════════════════════════
//  Who paid
// ═════════════════════════════════════════════════════════════════════════════

describe('paidBy', () => {
  it('defaults to the record owner — every pre-7.2 transaction keeps its answer', () => {
    expect(paidBy(txn('t1'))).toBe(ADA);
  });

  it('honours an explicit attribution', () => {
    expect(paidBy(txn('t1', { paid_by_user_id: BO }))).toBe(BO);
  });

  it('falls back to the given user for an ownerless local-first row', () => {
    expect(paidBy({ id: 't1', amount: -5 } as AttributedRow, CY)).toBe(CY);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Validating a split
// ═════════════════════════════════════════════════════════════════════════════

describe('validateResponsibilitySplit', () => {
  it('accepts an equal split by amount', () => {
    const v = validateResponsibilitySplit(
      split({ user_id: ADA, amount: 50 }, { user_id: BO, amount: 50 }), -100);
    expect(v.ok).toBe(true);
    expect(v.mode).toBe('amount');
  });

  it('accepts an unequal split by amount', () => {
    const v = validateResponsibilitySplit(
      split({ user_id: ADA, amount: 80.5 }, { user_id: BO, amount: 19.5 }), -100);
    expect(v.ok).toBe(true);
  });

  it('accepts percents that sum to 100, including thirds', () => {
    expect(validateResponsibilitySplit(
      split({ user_id: ADA, percent: 60 }, { user_id: BO, percent: 40 }), -100).ok).toBe(true);
    expect(validateResponsibilitySplit(
      split({ user_id: ADA, percent: 33.33 }, { user_id: BO, percent: 33.33 }, { user_id: CY, percent: 33.33 }),
      -100,
    ).ok).toBe(true);
  });

  it('refuses amounts that do not cover the whole transaction', () => {
    const v = validateResponsibilitySplit(
      split({ user_id: ADA, amount: 50 }, { user_id: BO, amount: 40 }), -100);
    expect(v.ok).toBe(false);
    expect(v.error).toBe('sum_mismatch');
    expect(v.remaining).toBe(10);
  });

  it('refuses percents that overshoot 100', () => {
    const v = validateResponsibilitySplit(
      split({ user_id: ADA, percent: 60 }, { user_id: BO, percent: 60 }), -100);
    expect(v.error).toBe('sum_mismatch');
  });

  it('refuses mixed modes, duplicate members, empty members and zero shares', () => {
    expect(validateResponsibilitySplit(
      split({ user_id: ADA, amount: 50 }, { user_id: BO, percent: 50 }), -100).error).toBe('mixed_modes');
    expect(validateResponsibilitySplit(
      split({ user_id: ADA, amount: 50 }, { user_id: ADA, amount: 50 }), -100).error).toBe('duplicate_member');
    expect(validateResponsibilitySplit(
      split({ user_id: '', amount: 100 }), -100).error).toBe('empty_member');
    expect(validateResponsibilitySplit(
      split({ user_id: ADA, amount: 100 }, { user_id: BO, amount: 0 }), -100).error).toBe('nonpositive_value');
    expect(validateResponsibilitySplit([], -100).error).toBe('no_lines');
  });

  it('validates against the magnitude — a refund splits like the purchase it reverses', () => {
    expect(validateResponsibilitySplit(
      split({ user_id: ADA, amount: 50 }, { user_id: BO, amount: 50 }), 100).ok).toBe(true);
  });

  it('tolerates cent-level float drift', () => {
    expect(validateResponsibilitySplit(
      split({ user_id: ADA, amount: 33.33 }, { user_id: BO, amount: 66.67 }), -100.001).ok).toBe(true);
  });
});

describe('splitMode', () => {
  it('names the mode, and refuses to pick one for mixed lines', () => {
    expect(splitMode(split({ user_id: ADA, amount: 1 }))).toBe('amount');
    expect(splitMode(split({ user_id: ADA, percent: 1 }))).toBe('percent');
    expect(splitMode(split({ user_id: ADA, amount: 1 }, { user_id: BO, percent: 1 }))).toBeNull();
    expect(splitMode([])).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Shares — the distribution itself
// ═════════════════════════════════════════════════════════════════════════════

describe('responsibilityShares', () => {
  it('distributes an amount split exactly', () => {
    const shares = responsibilityShares(txn('t1', {
      responsibility_split: split({ user_id: ADA, amount: 80 }, { user_id: BO, amount: 20 }),
    }));
    expect(shares).toEqual([
      { userId: ADA, amount: 80 },
      { userId: BO, amount: 20 },
    ]);
  });

  it('gives the rounding remainder to the last line — never invents or loses a cent', () => {
    const shares = responsibilityShares(txn('t1', {
      responsibility_split: split(
        { user_id: ADA, percent: 33.33 }, { user_id: BO, percent: 33.33 }, { user_id: CY, percent: 33.33 }),
    }));
    expect(shares.reduce((s, x) => s + x.amount, 0)).toBe(100);
    expect(shares[0].amount).toBe(33.33);
    expect(shares[2].amount).toBe(33.34);
  });

  it('falls back to the single responsible member without a split', () => {
    expect(responsibilityShares(txn('t1', { responsible_user_id: BO })))
      .toEqual([{ userId: BO, amount: 100 }]);
    expect(responsibilityShares(txn('t1')))
      .toEqual([{ userId: ADA, amount: 100 }]);
  });

  it('ignores an invalid split rather than rescaling it', () => {
    expect(responsibilityShares(txn('t1', {
      responsible_user_id: BO,
      responsibility_split: split({ user_id: ADA, amount: 10 }), // doesn't cover the $100
    }))).toEqual([{ userId: BO, amount: 100 }]);
  });

  it('rescales onto a supplied value — the display-currency figure', () => {
    const shares = responsibilityShares(txn('t1', {
      responsibility_split: split({ user_id: ADA, percent: 60 }, { user_id: BO, percent: 40 }),
    }), null, 250);
    expect(shares).toEqual([
      { userId: ADA, amount: 150 },
      { userId: BO, amount: 100 },
    ]);
  });
});

describe('hasAttribution', () => {
  it('is false for a plain shared transaction and true for any explicit fact', () => {
    expect(hasAttribution(txn('t1'))).toBe(false);
    expect(hasAttribution(txn('t1', { paid_by_user_id: BO }))).toBe(true);
    expect(hasAttribution(txn('t1', { responsible_user_id: BO }))).toBe(true);
    expect(hasAttribution(txn('t1', { responsibility_split: split({ user_id: BO, amount: 100 }) }))).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  What counts as spending
// ═════════════════════════════════════════════════════════════════════════════

describe('spendingContribution', () => {
  it('counts money out as positive spending', () => {
    expect(spendingContribution(txn('t1', { amount: -80 }))).toBe(80);
  });

  it('counts a matched refund as negative — it un-spends the purchase', () => {
    expect(spendingContribution(txn('t1', { amount: 30, transaction_type: 'refund' }))).toBe(-30);
  });

  it('ignores transfers and plain income', () => {
    expect(spendingContribution(txn('t1', { amount: -500, is_transfer: true }))).toBe(0);
    expect(spendingContribution(txn('t1', { amount: -500, transaction_type: 'transfer' }))).toBe(0);
    expect(spendingContribution(txn('t1', { amount: 2000 }))).toBe(0);
  });

  it('prefers the display amount so summaries stay in one currency', () => {
    expect(spendingContribution(txn('t1', { amount: -100, display_amount: -150 }))).toBe(150);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  The household summary
// ═════════════════════════════════════════════════════════════════════════════

describe('memberSpending', () => {
  it('splits paid vs responsible, and the columns always total the same', () => {
    // Ada paid $100, split 50/50 — a personal payment for a household cost.
    const rows = memberSpending([txn('t1', {
      responsibility_split: split({ user_id: ADA, amount: 50 }, { user_id: BO, amount: 50 }),
    })], asAda(), HH);
    const ada = rows.find(r => r.userId === ADA)!;
    const bo = rows.find(r => r.userId === BO)!;
    expect(ada).toMatchObject({ paid: 100, responsible: 50, net: 50 });
    expect(bo).toMatchObject({ paid: 0, responsible: 50, net: -50 });
    // The whole-household invariant: nothing double-counted, nothing leaked.
    expect(rows.reduce((s, r) => s + r.paid, 0)).toBe(rows.reduce((s, r) => s + r.responsible, 0));
    expect(rows.reduce((s, r) => s + r.net, 0)).toBe(0);
  });

  it('handles unequal and percent splits together', () => {
    const rows = memberSpending([
      txn('t1', { amount: -90, responsibility_split: split({ user_id: ADA, amount: 30 }, { user_id: BO, amount: 60 }) }),
      txn('t2', { amount: -200, paid_by_user_id: BO, responsibility_split: split({ user_id: ADA, percent: 25 }, { user_id: BO, percent: 75 }) }),
    ], asAda(), HH);
    expect(rows.find(r => r.userId === ADA)).toMatchObject({ paid: 90, responsible: 80, net: 10 });
    expect(rows.find(r => r.userId === BO)).toMatchObject({ paid: 200, responsible: 210, net: -10 });
  });

  it('a refund un-spends along the same split as the purchase', () => {
    const fifty: ResponsibilityLine[] = [{ user_id: ADA, percent: 50 }, { user_id: BO, percent: 50 }];
    const rows = memberSpending([
      txn('t1', { amount: -100, responsibility_split: fifty }),
      txn('t2', { amount: 40, transaction_type: 'refund', responsibility_split: fifty }),
    ], asAda(), HH);
    expect(rows.find(r => r.userId === ADA)).toMatchObject({ paid: 60, responsible: 30 });
    expect(rows.find(r => r.userId === BO)).toMatchObject({ paid: 0, responsible: 30 });
  });

  it('counts a joint-account transaction that inherited its stamps, unattributed', () => {
    // What withAccountStamps produces for a shared account's transaction: the
    // household ids arrive derived, with no explicit attribution — so it is
    // Bo's own spend, paid by Bo, exactly as it was before 7.2.
    const rows = memberSpending([txn('t1', { user_id: BO, amount: -75 })], asAda(), HH);
    expect(rows.find(r => r.userId === BO)).toMatchObject({ paid: 75, responsible: 75, net: 0 });
    expect(rows.find(r => r.userId === ADA)).toMatchObject({ paid: 0, responsible: 0, net: 0 });
  });

  it('every active member gets a row, zeros included', () => {
    const rows = memberSpending([], asAda(), HH);
    expect(rows.map(r => r.userId).sort()).toEqual([ADA, BO].sort());
  });

  it('only counts the household being asked about — a row in two households counts once in each, never across', () => {
    const both = txn('t1', { household_ids: [HH, OTHER_HH] });
    const onlyHere = txn('t2', { household_ids: [HH], amount: -40 });
    const members = [...COUPLE, member(ADA, OTHER_HH), member(CY, OTHER_HH)];
    const ctx = buildContext(ADA, households, members, HH);

    const here = memberSpending([both, onlyHere], ctx, HH);
    expect(here.find(r => r.userId === ADA)!.paid).toBe(140);

    const there = memberSpending([both, onlyHere], ctx, OTHER_HH);
    expect(there.find(r => r.userId === ADA)!.paid).toBe(100); // t2 is not theirs to see
    expect(there.find(r => r.userId === BO)).toBeUndefined();  // Bo isn't in that household
  });

  it('ignores private rows even when a split names a member', () => {
    // A personal (unshared) transaction naming Bo must not leak into the
    // household summary — visibility comes first, attribution second.
    const rows = memberSpending([txn('t1', {
      household_ids: [],
      responsibility_split: split({ user_id: BO, amount: 100 }),
    })], asAda(), HH);
    expect(rows.every(r => r.paid === 0 && r.responsible === 0)).toBe(true);
  });

  it('keeps a removed member\'s history — removal takes access, never the record', () => {
    // Bo was removed after the spend was attributed. The row still says what it
    // says; the summary flags them as no longer in the household.
    const rows = memberSpending([txn('t1', {
      responsibility_split: split({ user_id: ADA, amount: 50 }, { user_id: BO, amount: 50 }),
    })], asAda([{ ...member(ADA), role: 'owner' }, member(BO, HH, 'removed')]), HH);
    const bo = rows.find(r => r.userId === BO)!;
    expect(bo).toMatchObject({ responsible: 50, isMember: false });
    expect(rows.find(r => r.userId === ADA)!.isMember).toBe(true);
    // The invariant still holds with an ex-member in the sums.
    expect(rows.reduce((s, r) => s + r.net, 0)).toBe(0);
  });
});
