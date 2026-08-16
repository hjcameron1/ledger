import { describe, it, expect } from 'vitest';
import type { Transaction, Subscription } from '../types';
import {
  detectRecurringPatterns,
  fitCadence,
  suggestFrequencyFromDates,
} from './recurringDetection';

// ─── Builders ─────────────────────────────────────────────────────────────────

let seq = 0;
function tx(partial: Partial<Transaction> & { amount: number; date: string; merchant: string }): Transaction {
  seq += 1;
  return {
    id: partial.id ?? `t${seq}`,
    user_id: 'u1',
    account_id: partial.account_id ?? 'acc1',
    account_type: 'bank',
    currency: 'AUD',
    category: 'Uncategorised',
    is_duplicate_flagged: false,
    is_subscription: false,
    // Default merchant_normalized to the lowercased merchant so tests exercise the
    // canonical-key path the same way real (Phase 2B-stamped) data would.
    merchant_normalized: partial.merchant_normalized ?? partial.merchant.toLowerCase(),
    ...partial,
  };
}

/** A run of same-merchant charges every `stepDays` from `start`, N occurrences. */
function series(opts: {
  merchant: string;
  amount: number | number[];   // fixed, or one per occurrence
  start: string;
  stepDays: number;
  count: number;
  account_id?: string;
  merchant_normalized?: string;
  extra?: Partial<Transaction>;
}): Transaction[] {
  const out: Transaction[] = [];
  const startMs = new Date(`${opts.start}T00:00:00Z`).getTime();
  for (let i = 0; i < opts.count; i++) {
    const d = new Date(startMs + i * opts.stepDays * 86400000).toISOString().split('T')[0];
    const amt = Array.isArray(opts.amount) ? opts.amount[i] : opts.amount;
    out.push(tx({
      merchant: opts.merchant, amount: amt, date: d,
      account_id: opts.account_id,
      merchant_normalized: opts.merchant_normalized ?? opts.merchant.toLowerCase(),
      ...opts.extra,
    }));
  }
  return out;
}

/** Same-merchant charges on explicit dates (for shifted-date / irregular tests). */
function onDates(merchant: string, amount: number | number[], dates: string[]): Transaction[] {
  return dates.map((date, i) =>
    tx({ merchant, amount: Array.isArray(amount) ? amount[i] : amount, date }));
}

function sub(name: string, amount: number): Subscription {
  return {
    id: `s-${name}`, name, original_name: null, amount, currency: 'AUD',
    frequency: 'monthly', next_charge_date: '2026-09-01', category: 'Entertainment',
    is_auto_detected: true,
  };
}

const detect = (txns: Transaction[], subs: Subscription[] = []) => detectRecurringPatterns(txns, subs);
const find = (txns: Transaction[], merchantContains: string, subs: Subscription[] = []) =>
  detect(txns, subs).find(p => p.displayMerchant.toLowerCase().includes(merchantContains.toLowerCase()));

// ─── Cadence primitive ────────────────────────────────────────────────────────

describe('fitCadence', () => {
  it('classifies clean weekly / fortnightly / monthly / quarterly / annual runs', () => {
    expect(fitCadence(['2026-01-01', '2026-01-08', '2026-01-15', '2026-01-22'])?.frequency).toBe('weekly');
    expect(fitCadence(['2026-01-01', '2026-01-15', '2026-01-29', '2026-02-12'])?.frequency).toBe('fortnightly');
    expect(fitCadence(['2026-01-15', '2026-02-15', '2026-03-15'])?.frequency).toBe('monthly');
    expect(fitCadence(['2026-01-10', '2026-04-10', '2026-07-10'])?.frequency).toBe('quarterly');
    expect(fitCadence(['2024-06-01', '2025-06-01'])?.frequency).toBe('annually');
  });

  it('does not call a fortnightly run "monthly" (prefers the specific period)', () => {
    expect(fitCadence(['2026-01-01', '2026-01-15', '2026-01-29'])?.frequency).toBe('fortnightly');
  });

  it('returns null for irregular / too-few dates', () => {
    expect(fitCadence(['2026-01-03', '2026-01-06', '2026-01-24', '2026-02-18'])).toBeNull();
    expect(fitCadence(['2026-01-01'])).toBeNull();
  });

  it('tolerates a skipped cycle (a missed month) without breaking the run', () => {
    // 15 Jan, 15 Feb, (skip Mar), 15 Apr, 15 May — one 2× gap among 1× gaps.
    const fit = fitCadence(['2026-01-15', '2026-02-15', '2026-04-15', '2026-05-15']);
    expect(fit?.frequency).toBe('monthly');
    expect(fit!.skipRatio).toBeGreaterThan(0);
  });
});

describe('suggestFrequencyFromDates (manual pick-transactions helper)', () => {
  it('mirrors the detector cadence', () => {
    expect(suggestFrequencyFromDates(['2026-01-15', '2026-02-15', '2026-03-15'])).toBe('monthly');
    expect(suggestFrequencyFromDates(['2026-01-01', '2026-01-08', '2026-01-15'])).toBe('weekly');
    expect(suggestFrequencyFromDates(['2026-01-03', '2026-01-19', '2026-02-27'])).toBeNull();
  });
});

// ─── Subscriptions: fixed & changing amounts ──────────────────────────────────

describe('subscriptions', () => {
  it('detects a fixed monthly subscription with high confidence', () => {
    const p = find(series({ merchant: 'NETFLIX.COM', amount: -18.99, start: '2026-01-15', stepDays: 30, count: 4 }), 'netflix');
    expect(p).toBeDefined();
    expect(p!.frequency).toBe('monthly');
    expect(p!.direction).toBe('outflow');
    expect(p!.amount).toBeCloseTo(-18.99, 2);
    expect(p!.amountVaries).toBe(false);
    expect(p!.confidence).toBeGreaterThan(0.7);
  });

  it('still detects a subscription whose price changed over time', () => {
    // A price rise 15.99 → 17.99 → 18.99 → 18.99 is still one monthly subscription.
    const p = find(series({ merchant: 'Spotify', amount: [-15.99, -17.99, -18.99, -18.99], start: '2026-01-05', stepDays: 30, count: 4 }), 'spotify');
    expect(p).toBeDefined();
    expect(p!.frequency).toBe('monthly');
    expect(p!.confidence).toBeGreaterThan(0.6);
  });
});

// ─── Bills: variable amount, shifted dates ────────────────────────────────────

describe('bills', () => {
  it('detects a quarterly utility bill even though the amount varies a lot', () => {
    const p = find(series({ merchant: 'AGL ENERGY', amount: [-180, -260, -210], start: '2026-01-10', stepDays: 91, count: 3 }), 'agl');
    expect(p).toBeDefined();
    expect(p!.frequency).toBe('quarterly');
    expect(p!.amountVaries).toBe(true);
    expect(p!.amount).toBeLessThan(0);
  });

  it('detects a monthly bill whose charge date drifts a few days each cycle', () => {
    // Around the 15th: 15th, 14th, 17th, 16th — weekend/holiday shift.
    const p = find(onDates('COUNCIL RATES', -95, ['2026-01-15', '2026-02-14', '2026-03-17', '2026-04-16']), 'council');
    expect(p).toBeDefined();
    expect(p!.frequency).toBe('monthly');
  });
});

// ─── Salary / income ──────────────────────────────────────────────────────────

describe('salary and recurring income', () => {
  it('detects a fortnightly salary as an inflow income pattern', () => {
    const p = find(series({ merchant: 'ACME PTY LTD PAYROLL', amount: 2500, start: '2026-01-02', stepDays: 14, count: 5 }), 'acme');
    expect(p).toBeDefined();
    expect(p!.direction).toBe('inflow');
    expect(p!.frequency).toBe('fortnightly');
    expect(p!.amount).toBeGreaterThan(0);         // positive → inferKind → income
    expect(p!.confidence).toBeGreaterThan(0.7);
  });

  it('detects salary with the small pay-run variation real payslips have', () => {
    const p = find(series({ merchant: 'ACME PAYROLL', amount: [2500, 2480, 2515, 2500], start: '2026-01-02', stepDays: 14, count: 4 }), 'acme');
    expect(p).toBeDefined();
    expect(p!.direction).toBe('inflow');
  });
});

// ─── Annual ───────────────────────────────────────────────────────────────────

describe('annual', () => {
  it('detects a yearly insurance renewal from two identical charges', () => {
    const p = find(series({ merchant: 'NRMA INSURANCE', amount: -840, start: '2024-06-01', stepDays: 365, count: 2 }), 'nrma');
    expect(p).toBeDefined();
    expect(p!.frequency).toBe('annually');
  });
});

// ─── Transfers ────────────────────────────────────────────────────────────────

describe('transfers', () => {
  it('ignores recurring INTERNAL transfers between the user\'s own accounts', () => {
    // Each month: a -500 debit on acc1 paired with a +500 credit on acc2.
    const debits = series({ merchant: 'Transfer to Savings', amount: -500, start: '2026-01-05', stepDays: 30, count: 3, account_id: 'acc1' });
    const credits = series({ merchant: 'Transfer from Everyday', amount: 500, start: '2026-01-05', stepDays: 30, count: 3, account_id: 'acc2' });
    const patterns = detect([...debits, ...credits]);
    expect(patterns.some(p => /transfer/i.test(p.displayMerchant))).toBe(false);
  });

  it('keeps a recurring EXTERNAL transfer (e.g. rent to a landlord)', () => {
    // Only debit legs — no matching credit in the data, so it is not internal.
    const p = find(series({ merchant: 'Transfer to xx1368 Rent', amount: -1200, start: '2026-01-01', stepDays: 30, count: 3, account_id: 'acc1' }), 'rent');
    expect(p).toBeDefined();
    expect(p!.frequency).toBe('monthly');
    expect(p!.direction).toBe('outflow');
  });
});

// ─── Refunds ──────────────────────────────────────────────────────────────────

describe('refunds', () => {
  it('excludes a refund and never treats it as recurring income', () => {
    const purchases = series({ merchant: 'NETFLIX.COM', amount: -18.99, start: '2026-01-15', stepDays: 30, count: 3 });
    const refund = tx({ merchant: 'NETFLIX.COM', amount: 18.99, date: '2026-02-20', transaction_type: 'refund' });
    const patterns = detect([...purchases, refund]);
    expect(patterns.length).toBe(1);
    expect(patterns[0].direction).toBe('outflow');
    expect(patterns.some(p => p.direction === 'inflow')).toBe(false);
  });
});

// ─── False positives ──────────────────────────────────────────────────────────

describe('false positives are not surfaced', () => {
  it('does not flag irregular, varying-amount grocery shopping', () => {
    const groceries = onDates('WOOLWORTHS', [-32, -180, -47, -96, -12], ['2026-01-03', '2026-01-06', '2026-01-24', '2026-02-18', '2026-02-21']);
    expect(find(groceries, 'woolworths')).toBeUndefined();
  });

  it('does not flag two one-off purchases at the same shop as recurring', () => {
    const twoOffs = onDates('KMART', [-30, -180], ['2026-01-05', '2026-02-14']);
    expect(find(twoOffs, 'kmart')).toBeUndefined();
  });

  it('does not assert a monthly series from only two charges (needs 3)', () => {
    const twoMonthly = series({ merchant: 'SomeShop', amount: -50, start: '2026-01-10', stepDays: 30, count: 2 });
    expect(find(twoMonthly, 'someshop')).toBeUndefined();
  });
});

// ─── Suppression, dedup, ranking ──────────────────────────────────────────────

describe('suppression and hygiene', () => {
  it('does not re-suggest a merchant already tracked as a subscription', () => {
    const netflix = series({ merchant: 'NETFLIX.COM', amount: -18.99, start: '2026-01-15', stepDays: 30, count: 4, merchant_normalized: 'netflix' });
    expect(find(netflix, 'netflix', [sub('Netflix', 18.99)])).toBeUndefined();
  });

  it('emits at most one pattern per merchant+frequency and ranks by confidence', () => {
    const netflix = series({ merchant: 'NETFLIX.COM', amount: -18.99, start: '2026-01-15', stepDays: 30, count: 6 });        // strong: 6 occ
    const gym = series({ merchant: 'ANYTIME FITNESS', amount: [-60, -75, -55], start: '2026-01-02', stepDays: 30, count: 3 }); // weaker: 3 occ, varies
    const patterns = detect([...netflix, ...gym]);
    // One row per merchant (no twins).
    const keys = patterns.map(p => `${p.displayMerchant}`);
    expect(new Set(keys).size).toBe(keys.length);
    // Sorted strongest-first.
    for (let i = 1; i < patterns.length; i++) {
      expect(patterns[i - 1].confidence).toBeGreaterThanOrEqual(patterns[i].confidence);
    }
    expect(patterns[0].displayMerchant).toContain('NETFLIX');
  });

  it('honours a raised minConfidence threshold', () => {
    const gym = series({ merchant: 'ANYTIME FITNESS', amount: [-60, -75, -55], start: '2026-01-02', stepDays: 30, count: 3 });
    expect(detectRecurringPatterns(gym, [], { minConfidence: 0.99 })).toHaveLength(0);
  });
});
