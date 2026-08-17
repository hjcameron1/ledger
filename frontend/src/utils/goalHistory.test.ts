/**
 * Phase 4.3 — savings-goal history.
 *
 * The point of these tests: the running balance a user reads in the history
 * panel must equal the `saved` figure the engine shows on the card. A withdrawal
 * has to pull the balance down; a deposit into a LINKED account has to appear in
 * the list without moving it (it is already in that account's balance).
 */

import { describe, it, expect } from 'vitest';
import { buildGoalHistory, type HistoryContribution } from './goalHistory';
import type { GoalLink } from './savingsGoals';

const c = (o: Partial<HistoryContribution> & { id: string; amount: number }): HistoryContribution => ({
  date: '2026-08-01', source: null, note: null, createdAt: '2026-08-01T00:00:00Z', ...o,
});

const link = (id: string): GoalLink => ({ type: 'account', id, link_type: 'percent', link_value: 100 });

describe('goal history running balance', () => {
  it('adds deposits and subtracts withdrawals in date order', () => {
    const h = buildGoalHistory({
      contributions: [
        c({ id: 'a', amount: 500, date: '2026-08-01' }),
        c({ id: 'b', amount: 300, date: '2026-08-05' }),
        c({ id: 'w', amount: -200, date: '2026-08-10' }),
      ],
      links: [],
      openingAmount: 0,
      isLinked: false,
    });
    expect(h.counted).toBe(600);
    expect(h.deposited).toBe(800);
    expect(h.withdrawn).toBe(200);
    // rows come back newest-first
    expect(h.rows.map(r => r.id)).toEqual(['w', 'b', 'a']);
    expect(h.rows.find(r => r.id === 'w')!.runningBalance).toBe(600);
    expect(h.rows.find(r => r.id === 'b')!.runningBalance).toBe(800);
    expect(h.rows.find(r => r.id === 'a')!.runningBalance).toBe(500);
  });

  it('starts from the opening amount of an unlinked goal', () => {
    const h = buildGoalHistory({
      contributions: [c({ id: 'a', amount: 250, date: '2026-08-02' })],
      links: [],
      openingAmount: 1_000,
      isLinked: false,
    });
    expect(h.counted).toBe(1_250);
    expect(h.series[0].balance).toBe(1_000); // opening point
    expect(h.series[1].balance).toBe(1_250);
  });

  it('removing even $1 pulls the running balance down immediately', () => {
    const h = buildGoalHistory({
      contributions: [
        c({ id: 'a', amount: 100, date: '2026-08-01' }),
        c({ id: 'w', amount: -1, date: '2026-08-02' }),
      ],
      links: [],
      openingAmount: 0,
      isLinked: false,
    });
    expect(h.counted).toBe(99);
    expect(h.rows[0].id).toBe('w');
    expect(h.rows[0].runningBalance).toBe(99);
  });

  it('records a deposit into a linked account without moving the balance', () => {
    // Source matches the goal's current link → already in that balance.
    const h = buildGoalHistory({
      contributions: [
        c({ id: 'reflected', amount: 500, date: '2026-08-01', source: { type: 'account', id: 'a1' } }),
        c({ id: 'cash', amount: 200, date: '2026-08-02', source: null }),
      ],
      links: [link('a1')],
      openingAmount: 0,
      isLinked: true,
    });
    expect(h.hasReflected).toBe(true);
    expect(h.counted).toBe(200); // only the cash counts
    expect(h.rows.find(r => r.id === 'reflected')!.runningBalance).toBeNull();
    expect(h.rows.find(r => r.id === 'reflected')!.reflected).toBe(true);
    expect(h.rows.find(r => r.id === 'cash')!.runningBalance).toBe(200);
    // deposited still reports the gross movement for the record
    expect(h.deposited).toBe(700);
  });

  it('counts a withdrawal from a NON-linked account (money the goal tracked by hand)', () => {
    const h = buildGoalHistory({
      contributions: [
        c({ id: 'in', amount: 400, date: '2026-08-01', source: null }),
        c({ id: 'out', amount: -150, date: '2026-08-03', source: { type: 'account', id: 'other' } }),
      ],
      links: [link('a1')], // goal links a1, not "other"
      openingAmount: 0,
      isLinked: true,
    });
    expect(h.counted).toBe(250);
    expect(h.rows.find(r => r.id === 'out')!.reflected).toBe(false);
    expect(h.rows.find(r => r.id === 'out')!.runningBalance).toBe(250);
  });

  it('is empty and safe with no contributions', () => {
    const h = buildGoalHistory({ contributions: [], links: [], openingAmount: 0, isLinked: false });
    expect(h.rows).toEqual([]);
    expect(h.series).toEqual([]);
    expect(h.counted).toBe(0);
  });
});
