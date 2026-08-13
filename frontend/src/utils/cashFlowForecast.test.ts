import { describe, it, expect } from 'vitest';
import {
  buildCashFlowForecast,
  generateOccurrences,
  dedupeInputs,
  round2,
  UNALLOCATED,
  type RecurringInput,
  type AccountBalanceInput,
} from './cashFlowForecast';

// Fixed "today" for every test so all projected dates are deterministic.
const ASOF = '2026-08-13';

function input(p: Partial<RecurringInput> & { id: string; amount: number }): RecurringInput {
  return {
    sourceType: 'bill',
    name: 'Thing',
    frequency: 'monthly',
    anchorDate: '2026-08-20',
    accountId: 'everyday',
    confidence: 1,
    ...p,
  };
}

const everyday: AccountBalanceInput = { accountId: 'everyday', name: 'Everyday', balance: 1000 };
const savings: AccountBalanceInput = { accountId: 'savings', name: 'Savings', balance: 5000 };

function acct(id: string, projections: import('./cashFlowForecast').AccountProjection[]) {
  return projections.find(a => a.accountId === id)!;
}

// ─── date stepping & occurrence generation ────────────────────────────────────

describe('generateOccurrences — dates & frequencies', () => {
  it('weekly steps by 7 days and stays within the window', () => {
    const dates = generateOccurrences(
      { anchorDate: '2026-08-15', frequency: 'weekly' },
      ASOF,
      '2026-09-13', // 31 days
    );
    expect(dates).toEqual(['2026-08-15', '2026-08-22', '2026-08-29', '2026-09-05', '2026-09-12']);
  });

  it('fortnightly steps by 14 days', () => {
    const dates = generateOccurrences(
      { anchorDate: '2026-08-14', frequency: 'fortnightly' },
      ASOF,
      '2026-10-13',
    );
    expect(dates).toEqual(['2026-08-14', '2026-08-28', '2026-09-11', '2026-09-25', '2026-10-09']);
  });

  it('monthly keeps day-of-month across calendar months', () => {
    const dates = generateOccurrences(
      { anchorDate: '2026-08-31', frequency: 'monthly' },
      ASOF,
      '2026-11-30',
    );
    // 31 Aug → clamps to 30 Sep / 31 Oct / 30 Nov (no drift, no spill into next month)
    expect(dates).toEqual(['2026-08-31', '2026-09-30', '2026-10-31', '2026-11-30']);
  });

  it('quarterly and annually advance by calendar months', () => {
    expect(
      generateOccurrences({ anchorDate: '2026-09-01', frequency: 'quarterly' }, ASOF, '2027-09-01'),
    ).toEqual(['2026-09-01', '2026-12-01', '2027-03-01', '2027-06-01', '2027-09-01']);
    expect(
      generateOccurrences({ anchorDate: '2026-09-01', frequency: 'annually' }, ASOF, '2028-12-31'),
    ).toEqual(['2026-09-01', '2027-09-01', '2028-09-01']);
  });

  it('fast-forwards a past anchor to the first future occurrence', () => {
    const dates = generateOccurrences(
      { anchorDate: '2026-01-10', frequency: 'monthly' },
      ASOF,
      '2026-10-13',
    );
    expect(dates).toEqual(['2026-09-10', '2026-10-10']);
  });

  it('excludes occurrences dated on asOf (already in the balance) and includes strictly-future ones', () => {
    const dates = generateOccurrences(
      { anchorDate: ASOF, frequency: 'weekly' },
      ASOF,
      addDaysStr(ASOF, 21),
    );
    expect(dates[0]).toBe(addDaysStr(ASOF, 7)); // the asOf-dated one is dropped
  });

  it('once yields only the anchor when it falls in the window', () => {
    expect(
      generateOccurrences({ anchorDate: '2026-08-20', frequency: 'once' }, ASOF, '2026-09-13'),
    ).toEqual(['2026-08-20']);
    expect(
      generateOccurrences({ anchorDate: '2026-12-01', frequency: 'once' }, ASOF, '2026-09-13'),
    ).toEqual([]);
  });

  it('skipAnchor skips the current cycle but keeps the following ones', () => {
    expect(
      generateOccurrences(
        { anchorDate: '2026-08-20', frequency: 'monthly', skipAnchor: true },
        ASOF,
        '2026-10-31',
      ),
    ).toEqual(['2026-09-20', '2026-10-20']);
    // once + skipAnchor → nothing
    expect(
      generateOccurrences({ anchorDate: '2026-08-20', frequency: 'once', skipAnchor: true }, ASOF, '2026-12-31'),
    ).toEqual([]);
  });
});

function addDaysStr(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().split('T')[0];
}

// ─── projected balances 30/60/90 ─────────────────────────────────────────────

describe('buildCashFlowForecast — projected balances', () => {
  it('projects a monthly salary in and monthly rent out across 30/60/90', () => {
    const inputs: RecurringInput[] = [
      input({ id: 'salary', sourceType: 'income', name: 'Salary', amount: 3000, frequency: 'monthly', anchorDate: '2026-08-25', accountId: 'everyday' }),
      input({ id: 'rent', sourceType: 'bill', name: 'Rent', amount: -1500, frequency: 'monthly', anchorDate: '2026-08-28', accountId: 'everyday' }),
    ];
    const f = buildCashFlowForecast({ asOf: ASOF, accounts: [everyday], inputs });

    expect(f.openingTotal).toBe(1000);
    // 30d: one salary (+3000) + one rent (−1500) = +1500 → 2500
    expect(f.horizons[0].days).toBe(30);
    expect(f.horizons[0].projectedBalance).toBe(2500);
    expect(f.horizons[0].inflow).toBe(3000);
    expect(f.horizons[0].outflow).toBe(-1500);
    // 60d: two of each → +3000 → 4000
    expect(f.horizons[1].projectedBalance).toBe(4000);
    // 90d: three of each → +4500 → 5500
    expect(f.horizons[2].projectedBalance).toBe(5500);
  });

  it('reports the lowest running balance (liquidity dip) before recovery', () => {
    // Big bill on day ~7, salary not until day ~40 → dips below opening first.
    const inputs: RecurringInput[] = [
      input({ id: 'bigbill', sourceType: 'bill', name: 'Insurance', amount: -800, frequency: 'once', anchorDate: addDaysStr(ASOF, 7), accountId: 'everyday' }),
      input({ id: 'pay', sourceType: 'income', name: 'Salary', amount: 2000, frequency: 'once', anchorDate: addDaysStr(ASOF, 40), accountId: 'everyday' }),
    ];
    const f = buildCashFlowForecast({ asOf: ASOF, accounts: [everyday], inputs });
    expect(f.horizons[0].lowestBalance).toBe(200); // 1000 − 800, before payday
    expect(f.horizons[0].lowestDate).toBe(addDaysStr(ASOF, 7));
    expect(f.horizons[1].projectedBalance).toBe(2200); // recovered after payday
  });

  it('rounds money to cents', () => {
    const inputs = [input({ id: 'x', sourceType: 'subscription', amount: -9.99, frequency: 'monthly', anchorDate: '2026-08-20' })];
    const f = buildCashFlowForecast({ asOf: ASOF, accounts: [everyday], inputs });
    expect(f.horizons[2].projectedBalance).toBe(round2(1000 - 9.99 * 3));
  });
});

// ─── account allocation ──────────────────────────────────────────────────────

describe('buildCashFlowForecast — account allocation', () => {
  it('attributes each movement to its own account and leaves others flat', () => {
    const inputs: RecurringInput[] = [
      input({ id: 'rent', name: 'Rent', amount: -1500, frequency: 'monthly', anchorDate: '2026-08-20', accountId: 'everyday' }),
      input({ id: 'invest', sourceType: 'subscription', name: 'Vanguard', amount: -500, frequency: 'monthly', anchorDate: '2026-08-20', accountId: 'savings' }),
    ];
    const f = buildCashFlowForecast({ asOf: ASOF, accounts: [everyday, savings], inputs });
    expect(acct('everyday', f.accounts).d30).toBe(-500);  // 1000 − 1500
    expect(acct('savings', f.accounts).d30).toBe(4500);   // 5000 − 500
    // total still adds up
    expect(f.horizons[0].projectedBalance).toBe(4000);    // 6000 − 2000
  });

  it('routes an unknown/absent account to the unallocated bucket (counts in total, not any account)', () => {
    const inputs = [input({ id: 'cc', sourceType: 'credit_card', name: 'Amex min', amount: -200, frequency: 'monthly', anchorDate: '2026-08-20', accountId: null })];
    const f = buildCashFlowForecast({ asOf: ASOF, accounts: [everyday], inputs });
    const un = acct(UNALLOCATED, f.accounts);
    expect(un.d30).toBe(-200);
    expect(acct('everyday', f.accounts).d30).toBe(1000); // untouched
    expect(f.horizons[0].projectedBalance).toBe(800);    // total still reflects it
  });
});

// ─── transfers (no double-counting) ──────────────────────────────────────────

describe('buildCashFlowForecast — transfers', () => {
  it('nets an internal transfer to zero in the total but shifts money between accounts', () => {
    const inputs: RecurringInput[] = [
      input({
        id: 'sweep', sourceType: 'recurring_series', name: 'Transfer to Savings',
        amount: -400, frequency: 'monthly', anchorDate: '2026-08-20',
        accountId: 'everyday', transfer: { counterpartAccountId: 'savings' },
      }),
    ];
    const f = buildCashFlowForecast({ asOf: ASOF, accounts: [everyday, savings], inputs });
    // total household cash unchanged by the transfer
    expect(f.horizons[0].net).toBe(0);
    expect(f.horizons[0].projectedBalance).toBe(6000);
    expect(f.horizons[0].outflow).toBe(0); // transfer excluded from spend
    // but the money moved between accounts
    expect(acct('everyday', f.accounts).d30).toBe(600);  // 1000 − 400
    expect(acct('savings', f.accounts).d30).toBe(5400);  // 5000 + 400
  });

  it('a transfer to an untracked destination debits the source but is still excluded from the total', () => {
    const inputs: RecurringInput[] = [
      input({
        id: 'out', sourceType: 'recurring_series', name: 'Transfer out',
        amount: -300, frequency: 'monthly', anchorDate: '2026-08-20',
        accountId: 'everyday', transfer: { counterpartAccountId: null },
      }),
    ];
    const f = buildCashFlowForecast({ asOf: ASOF, accounts: [everyday], inputs });
    expect(f.horizons[0].net).toBe(0); // not counted as household spend
    expect(acct('everyday', f.accounts).d30).toBe(700); // source still shows the debit
  });
});

// ─── de-duplication (avoid double-counting duplicate recurring records) ───────

describe('dedupeInputs — duplicate recurring records', () => {
  it('suppresses a bill that mirrors a loan repayment, keeps the loan, preserves the link', () => {
    const inputs: RecurringInput[] = [
      input({ id: 'loan1', sourceType: 'loan', name: 'Car loan', amount: -450, frequency: 'monthly' }),
      input({ id: 'bill1', sourceType: 'bill', name: 'Car loan repayment', amount: -450, frequency: 'monthly', links: { loan_id: 'loan1' } }),
    ];
    const { kept, suppressed } = dedupeInputs(inputs);
    expect(kept.map(k => k.id)).toEqual(['loan1']);
    expect(suppressed).toEqual([{ id: 'bill1', sourceType: 'bill', reason: 'mirrors-loan', keptId: 'loan1' }]);
  });

  it('suppresses a bill that mirrors a subscription', () => {
    const inputs: RecurringInput[] = [
      input({ id: 'sub1', sourceType: 'subscription', name: 'Netflix', amount: -22.99, frequency: 'monthly' }),
      input({ id: 'bill1', sourceType: 'bill', name: 'Netflix', amount: -22.99, frequency: 'monthly', links: { subscription_id: 'sub1' } }),
    ];
    const { kept, suppressed } = dedupeInputs(inputs);
    expect(kept.map(k => k.id)).toEqual(['sub1']);
    expect(suppressed[0]).toMatchObject({ id: 'bill1', reason: 'mirrors-subscription', keptId: 'sub1' });
  });

  it('keeps the mirror bill when its linked record is absent (deleted)', () => {
    const inputs = [input({ id: 'bill1', sourceType: 'bill', name: 'Old loan', amount: -450, frequency: 'monthly', links: { loan_id: 'ghost' } })];
    const { kept, suppressed } = dedupeInputs(inputs);
    expect(kept.map(k => k.id)).toEqual(['bill1']);
    expect(suppressed).toEqual([]);
  });

  it('suppresses a detected series that matches a user-managed subscription (freq+amount+name)', () => {
    const inputs: RecurringInput[] = [
      input({ id: 'sub1', sourceType: 'subscription', name: 'Spotify Premium', amount: -13.99, frequency: 'monthly' }),
      input({ id: 'ser1', sourceType: 'recurring_series', name: 'SPOTIFY', amount: -13.99, frequency: 'monthly' }),
    ];
    const { kept, suppressed } = dedupeInputs(inputs);
    expect(kept.map(k => k.id)).toEqual(['sub1']);
    expect(suppressed[0]).toMatchObject({ id: 'ser1', reason: 'series-matches-subscription', keptId: 'sub1' });
  });

  it('suppresses a detected income series that matches a recurring income entry', () => {
    const inputs: RecurringInput[] = [
      input({ id: 'inc1', sourceType: 'income', name: 'ACME Payroll', amount: 3200, frequency: 'fortnightly' }),
      input({ id: 'ser1', sourceType: 'recurring_series', name: 'ACME PTY PAYROLL', amount: 3200, frequency: 'fortnightly' }),
    ];
    const { kept } = dedupeInputs(inputs);
    expect(kept.map(k => k.id)).toEqual(['inc1']);
  });

  it('does NOT merge look-alikes with different frequency, sign, or unrelated names', () => {
    const inputs: RecurringInput[] = [
      input({ id: 'sub1', sourceType: 'subscription', name: 'Gym', amount: -60, frequency: 'monthly' }),
      input({ id: 'ser1', sourceType: 'recurring_series', name: 'Gym', amount: -60, frequency: 'weekly' }),   // diff freq
      input({ id: 'ser2', sourceType: 'recurring_series', name: 'Gym refund', amount: 60, frequency: 'monthly' }), // diff sign
      input({ id: 'ser3', sourceType: 'recurring_series', name: 'Council Rates', amount: -60, frequency: 'monthly' }), // diff name
    ];
    const { kept } = dedupeInputs(inputs);
    expect(kept.map(k => k.id).sort()).toEqual(['ser1', 'ser2', 'ser3', 'sub1']);
  });

  it('end-to-end: a mirrored bill is not double-counted in the projection', () => {
    const inputs: RecurringInput[] = [
      input({ id: 'loan1', sourceType: 'loan', name: 'Car loan', amount: -450, frequency: 'monthly', anchorDate: '2026-08-20', accountId: 'everyday' }),
      input({ id: 'bill1', sourceType: 'bill', name: 'Car loan repayment', amount: -450, frequency: 'monthly', anchorDate: '2026-08-20', accountId: 'everyday', links: { loan_id: 'loan1' } }),
    ];
    const f = buildCashFlowForecast({ asOf: ASOF, accounts: [everyday], inputs });
    // Only ONE −450 lands in 30 days, not two.
    expect(f.horizons[0].outflow).toBe(-450);
    expect(f.horizons[0].projectedBalance).toBe(550);
    expect(f.suppressed.map(s => s.id)).toEqual(['bill1']);
  });
});

// ─── provenance & events ─────────────────────────────────────────────────────

describe('buildCashFlowForecast — source links & confidence preserved', () => {
  it('carries sourceType, sourceId and confidence onto every event, sorted by date', () => {
    const inputs: RecurringInput[] = [
      input({ id: 'rent', sourceType: 'bill', name: 'Rent', amount: -1500, frequency: 'monthly', anchorDate: '2026-08-28', confidence: 1 }),
      input({ id: 'sub', sourceType: 'subscription', name: 'Netflix', amount: -22.99, frequency: 'monthly', anchorDate: '2026-08-20', confidence: 0.85 }),
    ];
    const f = buildCashFlowForecast({ asOf: ASOF, accounts: [everyday], inputs });
    expect(f.events[0]).toMatchObject({ sourceId: 'sub', sourceType: 'subscription', confidence: 0.85, date: '2026-08-20' });
    expect(f.events[1]).toMatchObject({ sourceId: 'rent', sourceType: 'bill', confidence: 1, date: '2026-08-28' });
    // sorted ascending by date
    expect(f.events.map(e => e.date)).toEqual([...f.events.map(e => e.date)].sort());
  });

  it('supports a custom horizon set', () => {
    const inputs = [input({ id: 'x', sourceType: 'income', amount: 100, frequency: 'weekly', anchorDate: addDaysStr(ASOF, 1), accountId: 'everyday' })];
    const f = buildCashFlowForecast({ asOf: ASOF, accounts: [everyday], inputs, horizons: [7, 14] });
    expect(f.horizons.map(h => h.days)).toEqual([7, 14]);
    expect(f.horizons[0].projectedBalance).toBe(1100); // one weekly inflow in 7d
    expect(f.horizons[1].projectedBalance).toBe(1200); // two in 14d
  });
});
