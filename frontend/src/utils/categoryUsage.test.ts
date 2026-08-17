/**
 * What a category is holding up, and what deleting it will do.
 *
 * The counts here are not decoration — they are the numbers the user reads in
 * the confirmation dialog immediately before an irreversible-feeling action, so
 * an undercount is worse than no count at all.
 */

import { describe, it, expect } from 'vitest';
import type { Budget, Transaction, TransactionRule, TransactionSplit } from '../types';
import {
  countCategoryUsage, isCategoryInUse, planCategoryDeletion,
  rewriteRuleActions, undeletableReason,
} from './categoryUsage';

const budget = (o: Partial<Budget>): Budget => ({
  id: 'b', user_id: 'u', scope: 'category', category: 'Dining',
  limit_amount: 100, period: 'monthly', rollover_enabled: false, active: true, ...o,
} as Budget);

const rule = (o: Partial<TransactionRule>): TransactionRule => ({
  id: 'r', user_id: 'u', priority: 10, enabled: true,
  conditions: { merchant_contains: 'ANY' }, actions: { category: 'Dining' },
  label: null, ...o,
} as TransactionRule);

const txn = (o: Partial<Transaction>): Transaction => ({
  id: 't', user_id: 'u', category: 'Dining', amount: -10, date: '2026-08-01', ...o,
} as Transaction);

const split = (o: Partial<TransactionSplit>): TransactionSplit => ({
  id: 's', transaction_id: 'tx', category: 'Dining', amount: 10, ...o,
} as TransactionSplit);

const sources = (o: Partial<Parameters<typeof countCategoryUsage>[1]> = {}) => ({
  budgets: o.budgets ?? [], rules: o.rules ?? [],
  transactions: o.transactions ?? [], splits: o.splits ?? [],
});

// ═════════════════════════════════════════════════════════════════════════════
//  Counting
// ═════════════════════════════════════════════════════════════════════════════
describe('countCategoryUsage', () => {
  it('counts budgets, rules, transactions and splits separately', () => {
    const usage = countCategoryUsage('Dining', sources({
      budgets: [budget({ id: 'b1' })],
      rules: [rule({ id: 'r1' }), rule({ id: 'r2' })],
      transactions: [txn({ id: 't1' }), txn({ id: 't2' }), txn({ id: 't3', category: 'Fuel' })],
      splits: [split({ id: 's1' })],
    }));
    expect(usage).toEqual({ budgets: 1, rules: 2, transactions: 2, splits: 1 });
  });

  it('counts by identity, not by spelling', () => {
    // Telling the user "0 transactions" and then moving 12 of them would make
    // the confirmation a lie at the moment they are trusting it.
    const usage = countCategoryUsage('Dining', sources({
      budgets: [budget({ category: 'dining' })],
      rules: [rule({ actions: { category: 'DINING!' } })],
      transactions: [txn({ category: ' dining ' })],
    }));
    expect(usage).toMatchObject({ budgets: 1, rules: 1, transactions: 1 });
  });

  it('ignores retired budgets and the overall cap', () => {
    // A retired budget is already invisible; the overall cap has no category.
    const usage = countCategoryUsage('Dining', sources({
      budgets: [
        budget({ id: 'b1', active: false }),
        budget({ id: 'b2', scope: 'overall', category: null }),
      ],
    }));
    expect(usage.budgets).toBe(0);
  });

  it('is zero for an empty name', () => {
    expect(countCategoryUsage('  ', sources({ transactions: [txn({})] })))
      .toEqual({ budgets: 0, rules: 0, transactions: 0, splits: 0 });
  });

  it('knows when nothing at all points at a category', () => {
    expect(isCategoryInUse(countCategoryUsage('Dining', sources()))).toBe(false);
    expect(isCategoryInUse(countCategoryUsage('Dining', sources({ splits: [split({})] })))).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  What may be deleted
// ═════════════════════════════════════════════════════════════════════════════
describe('undeletableReason', () => {
  it('refuses a built-in', () => {
    // Deleting one would not remove it: the next import resolves straight back
    // into the taxonomy and reintroduces it.
    expect(undeletableReason('Groceries', ['Childcare'])).toMatch(/Built-in/);
    expect(undeletableReason('groceries', ['Childcare'])).toMatch(/Built-in/);
  });

  it('refuses a name the user never created', () => {
    expect(undeletableReason('Not a category', ['Childcare'])).toMatch(/Only categories you created/);
  });

  it('allows the user\'s own category, however they spell it', () => {
    expect(undeletableReason('childcare', ['Childcare'])).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Rules
// ═════════════════════════════════════════════════════════════════════════════
describe('rewriteRuleActions', () => {
  it('re-points the category when there is somewhere to move it', () => {
    expect(rewriteRuleActions({ category: 'Dining', entity: 'personal' }, 'Food'))
      .toEqual({ actions: { category: 'Food', entity: 'personal' }, disable: false });
  });

  it('drops the category but keeps a rule that still does something', () => {
    expect(rewriteRuleActions({ category: 'Dining', entity: 'business' }, null))
      .toEqual({ actions: { entity: 'business' }, disable: false });
  });

  it('disables — never deletes — a rule left with nothing to do', () => {
    // The conditions the user wrote are worth keeping. An inert rule they can
    // re-point later beats one that vanished with their category.
    expect(rewriteRuleActions({ category: 'Dining' }, null))
      .toEqual({ actions: {}, disable: true });
  });

  it('does not count an empty tag list as doing something', () => {
    expect(rewriteRuleActions({ category: 'Dining', tags: [] }, null).disable).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  The plan
// ═════════════════════════════════════════════════════════════════════════════
describe('planCategoryDeletion', () => {
  const full = () => sources({
    budgets: [budget({ id: 'b1' }), budget({ id: 'b2', category: 'Fuel' })],
    rules: [rule({ id: 'r1' }), rule({ id: 'r2', actions: { category: 'Fuel' } })],
    transactions: [txn({ id: 't1' }), txn({ id: 't2', category: 'Fuel' })],
    splits: [split({ id: 's1', transaction_id: 'tx1' }), split({ id: 's2', transaction_id: 'tx1' })],
  });

  it('names every record that has to change, and nothing else', () => {
    const plan = planCategoryDeletion('Dining', full());
    expect(plan.budgetIds).toEqual(['b1']);
    expect(plan.ruleEdits.map(e => e.id)).toEqual(['r1']);
    expect(plan.transactionIds).toEqual(['t1']);
    // Splits are rewritten a parent at a time, so the same parent appears once.
    expect(plan.splitParentIds).toEqual(['tx1']);
  });

  it('uncategorises by default', () => {
    const plan = planCategoryDeletion('Dining', full());
    expect(plan.reassignTo).toBeNull();
    expect(plan.ruleEdits[0]).toEqual({ id: 'r1', actions: {}, disable: true });
  });

  it('re-points everything when a destination is chosen', () => {
    const plan = planCategoryDeletion('Dining', full(), { reassignTo: 'Food' });
    expect(plan.reassignTo).toBe('Food');
    expect(plan.ruleEdits[0]).toEqual({ id: 'r1', actions: { category: 'Food' }, disable: false });
  });

  it('treats "move it to itself" as a plain delete', () => {
    // Otherwise every transaction gets a pointless write, and the category row
    // is removed while its budget is re-pointed at a name that has just gone.
    expect(planCategoryDeletion('Dining', full(), { reassignTo: ' dining ' }).reassignTo).toBeNull();
  });

  it('carries the usage counts the confirmation showed', () => {
    expect(planCategoryDeletion('Dining', full()).usage)
      .toEqual({ budgets: 1, rules: 1, transactions: 1, splits: 2 });
  });
});
