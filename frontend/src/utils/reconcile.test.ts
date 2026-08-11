import { describe, it, expect } from 'vitest';
import type { Transaction } from '../types';
import {
  classifyManualAgainstSync,
  isMissingPromptDue,
  manualAdjustment,
  merchantSimilarity,
  RECONCILE_GRACE_DAYS,
} from './reconcile';

// ── Test fixture factory ──────────────────────────────────────────────────────
let seq = 0;
function tx(partial: Partial<Transaction> & { amount: number }): Transaction {
  seq += 1;
  return {
    id: partial.id ?? `t${seq}`,
    user_id: 'u1',
    account_id: 'acc-bank',
    account_type: 'bank',
    date: '2026-08-01',
    merchant: 'Merchant',
    currency: 'AUD',
    category: 'Other',
    is_duplicate_flagged: false,
    is_subscription: false,
    source: 'manual',
    ...partial,
  };
}

const DAY = 24 * 60 * 60 * 1000;

// ═══════════════════════════════════════════════════════════════════════════════
//  classifyManualAgainstSync — exact / conflict / none
// ═══════════════════════════════════════════════════════════════════════════════
describe('classifyManualAgainstSync', () => {
  it('EXACT: same amount + merchant + date → bank authoritative', () => {
    const manual = tx({ amount: -50, merchant: 'Coles', date: '2026-08-01', source: 'manual' });
    const synced = tx({ amount: -50, merchant: 'Coles', date: '2026-08-01', source: 'basiq', basiq_tx_id: 'b1' });
    const m = classifyManualAgainstSync(manual, [synced]);
    expect(m.result).toBe('exact');
    expect(m.candidate?.id).toBe(synced.id);
  });

  it('EXACT: same event posted two days later', () => {
    const manual = tx({ amount: -50, merchant: 'Coles', date: '2026-08-01' });
    const synced = tx({ amount: -50, merchant: 'Coles', date: '2026-08-03', source: 'basiq' });
    expect(classifyManualAgainstSync(manual, [synced]).result).toBe('exact');
  });

  it('CONFLICT: amount off by a few dollars, same merchant', () => {
    const manual = tx({ amount: -503, merchant: 'Coles', date: '2026-08-01' });
    const synced = tx({ amount: -501, merchant: 'Coles', date: '2026-08-02', source: 'basiq' });
    const m = classifyManualAgainstSync(manual, [synced]);
    expect(m.result).toBe('conflict');
    expect(m.candidate?.id).toBe(synced.id);
  });

  it('CONFLICT: same amount, merchant spelled differently', () => {
    const manual = tx({ amount: -80, merchant: 'Coles', date: '2026-08-01' });
    const synced = tx({ amount: -80, merchant: 'COLES SUPERMARKET 1234', date: '2026-08-01', source: 'basiq' });
    expect(classifyManualAgainstSync(manual, [synced]).result).toBe('conflict');
  });

  it('NONE: near amount but unrelated merchant is NOT a conflict', () => {
    const manual = tx({ amount: -50, merchant: 'Coles', date: '2026-08-01' });
    const synced = tx({ amount: -51, merchant: 'Shell Petrol', date: '2026-08-01', source: 'basiq' });
    expect(classifyManualAgainstSync(manual, [synced]).result).toBe('none');
  });

  it('NONE: opposite direction never matches', () => {
    const manual = tx({ amount: -50, merchant: 'Coles', date: '2026-08-01' });
    const synced = tx({ amount: 50, merchant: 'Coles', date: '2026-08-01', source: 'basiq' });
    expect(classifyManualAgainstSync(manual, [synced]).result).toBe('none');
  });

  it('NONE: nothing comparable in the sync', () => {
    const manual = tx({ amount: -50, merchant: 'Coles', date: '2026-08-01' });
    expect(classifyManualAgainstSync(manual, []).result).toBe('none');
  });

  it('NONE: same-ish amount but well outside the date window', () => {
    const manual = tx({ amount: -50, merchant: 'Coles', date: '2026-08-01' });
    const synced = tx({ amount: -50, merchant: 'Coles', date: '2026-08-20', source: 'basiq' });
    // Beyond both the exact (±2d) and conflict (±4d) windows.
    expect(classifyManualAgainstSync(manual, [synced]).result).toBe('none');
  });

  it('prefers the closest amount when several near-twins exist', () => {
    const manual = tx({ amount: -100, merchant: 'Cafe', date: '2026-08-01' });
    const far = tx({ amount: -104, merchant: 'Cafe', date: '2026-08-01', source: 'basiq', id: 'far' });
    const near = tx({ amount: -101, merchant: 'Cafe', date: '2026-08-01', source: 'basiq', id: 'near' });
    const m = classifyManualAgainstSync(manual, [far, near]);
    expect(m.result).toBe('conflict');
    expect(m.candidate?.id).toBe('near');
  });
});

describe('merchantSimilarity', () => {
  it('is 1 for identical, lower for variants, ~0 for unrelated', () => {
    expect(merchantSimilarity('coles', 'coles')).toBe(1);
    expect(merchantSimilarity('coles', 'colas')).toBeGreaterThan(0.5);
    expect(merchantSimilarity('coles', 'shell')).toBeLessThan(0.5);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  isMissingPromptDue — grace period gate
// ═══════════════════════════════════════════════════════════════════════════════
describe('isMissingPromptDue', () => {
  const now = new Date('2026-08-20T00:00:00Z').getTime();
  const oldEnough = new Date(now - (RECONCILE_GRACE_DAYS + 1) * DAY).toISOString();
  const tooNew = new Date(now - 1 * DAY).toISOString();

  it('does not ask within the grace period', () => {
    const t = tx({ amount: -50, reconcile_state: 'pending', created_at: tooNew });
    expect(isMissingPromptDue(t, now, now)).toBe(false);
  });

  it('does not ask if no sync has run since the entry was added', () => {
    const t = tx({ amount: -50, reconcile_state: 'pending', created_at: oldEnough });
    const lastSyncBeforeAdd = new Date(oldEnough).getTime() - DAY;
    expect(isMissingPromptDue(t, lastSyncBeforeAdd, now)).toBe(false);
  });

  it('asks once old enough AND a sync has run since', () => {
    const t = tx({ amount: -50, reconcile_state: 'pending', created_at: oldEnough });
    const lastSyncAfterAdd = new Date(oldEnough).getTime() + DAY;
    expect(isMissingPromptDue(t, lastSyncAfterAdd, now)).toBe(true);
  });

  it('after a deferral, stays quiet until a NEWER sync happens', () => {
    const checked = new Date(now - 2 * DAY).toISOString();
    const t = tx({ amount: -50, reconcile_state: 'pending', created_at: oldEnough, reconcile_checked_at: checked });
    const syncNotNewer = new Date(checked).getTime() - DAY;
    const syncNewer = new Date(checked).getTime() + DAY;
    expect(isMissingPromptDue(t, syncNotNewer, now)).toBe(false);
    expect(isMissingPromptDue(t, syncNewer, now)).toBe(true);
  });

  it('never asks for kept / conflict / resolved states', () => {
    for (const state of ['kept', 'conflict', 'resolved'] as const) {
      const t = tx({ amount: -50, reconcile_state: state, created_at: oldEnough });
      expect(isMissingPromptDue(t, now, now)).toBe(false);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  manualAdjustment — balance layering
// ═══════════════════════════════════════════════════════════════════════════════
describe('manualAdjustment', () => {
  it('sums pending + kept signed amounts, ignores conflict/resolved/null', () => {
    const txns = [
      tx({ amount: -503, reconcile_state: 'pending' }),   // counts
      tx({ amount: 200, reconcile_state: 'kept' }),       // counts
      tx({ amount: -80, reconcile_state: 'conflict' }),   // bank twin counts it — skip
      tx({ amount: -40, reconcile_state: 'resolved' }),   // skip
      tx({ amount: -999, reconcile_state: null }),        // not a reconciling entry — skip
    ];
    expect(manualAdjustment(txns)).toBe(-303);
  });

  it('is 0 with no contributing entries', () => {
    expect(manualAdjustment([tx({ amount: -50, reconcile_state: 'conflict' })])).toBe(0);
  });
});
