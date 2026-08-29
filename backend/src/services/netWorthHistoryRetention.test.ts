/**
 * The retention POLICY, on its own: which readings survive a compaction and which
 * do not, with no database anywhere near it.
 *
 * Everything here is about one promise — that compacting history cannot change what
 * the history says. The chart draws one point per local day, and that point is the
 * day's last reading; so if compaction keeps every bucket's last reading, the drawn
 * line is identical before and after. The high and the low are kept on top of that,
 * which is what stops a month of readings from collapsing into a flat line through
 * the middle of a crash.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../utils/supabase', () => ({
  supabase: { from: () => { throw new Error('the policy does not read the database'); } },
  getSupabase: () => { throw new Error('not used here'); },
  upsertTolerant: () => { throw new Error('not used here'); },
}));

import { planBuckets } from './netWorthHistoryRetention';
import { localBucketKey, localBucketRangeMs, floorToBucketMs, localDayKey } from './netWorthHistoryReader';

const SYD = 'Australia/Sydney';
const row = (iso: string, total: number) => ({ recorded_at: iso, total_value: total });

describe('local calendar buckets', () => {
  it('tiles the timeline: one bucket ends exactly where the next begins', () => {
    // Across the April daylight-saving change in Sydney, where one local day is 25
    // hours long — the case a fixed 24-hour arithmetic gets wrong.
    let cursor = localBucketRangeMs('2024-04-05', SYD, 'day');
    for (let i = 0; i < 5; i++) {
      const key = localDayKey(new Date(cursor.endMs).toISOString(), SYD);
      const next = localBucketRangeMs(key, SYD, 'day');
      expect(next.startMs).toBe(cursor.endMs);
      cursor = next;
    }
  });

  it('measures the daylight-saving day as 25 hours, not 24', () => {
    const { startMs, endMs } = localBucketRangeMs('2024-04-07', SYD, 'day');
    expect((endMs - startMs) / 3_600_000).toBe(25);
  });

  it('runs months from the first of the month, local time', () => {
    const { startMs, endMs } = localBucketRangeMs('2024-02', SYD, 'month');
    expect(localDayKey(new Date(startMs).toISOString(), SYD)).toBe('2024-02-01');
    expect(localDayKey(new Date(endMs).toISOString(), SYD)).toBe('2024-03-01');
    expect((endMs - startMs) / 86_400_000).toBe(29); // 2024 is a leap year
  });

  it('rolls December over into the next January', () => {
    const { endMs } = localBucketRangeMs('2024-12', SYD, 'month');
    expect(localDayKey(new Date(endMs).toISOString(), SYD)).toBe('2025-01-01');
  });

  it('buckets by the owner\'s calendar, not UTC\'s', () => {
    // 22:00 UTC on the 9th is 09:00 on the 10th in Sydney.
    expect(localBucketKey('2023-01-09T22:00:00.000Z', SYD, 'day')).toBe('2023-01-10');
    expect(localBucketKey('2023-01-09T22:00:00.000Z', 'UTC', 'day')).toBe('2023-01-09');
    expect(localBucketKey('2023-01-31T22:00:00.000Z', SYD, 'month')).toBe('2023-02');
  });

  it('floors an instant onto its own bucket, so a cutoff never splits one', () => {
    const ms = Date.parse('2024-06-15T07:30:00.000Z');
    const floored = floorToBucketMs(ms, SYD, 'day');
    expect(floored).toBeLessThanOrEqual(ms);
    expect(localBucketKey(new Date(floored).toISOString(), SYD, 'day'))
      .toBe(localBucketKey(new Date(ms).toISOString(), SYD, 'day'));
    expect(floorToBucketMs(floored, SYD, 'day')).toBe(floored);
  });
});

describe('what a compacted bucket keeps', () => {
  const day = [
    row('2024-06-14T20:00:00.000Z', 100_000), // 06:00 Sydney on the 15th
    row('2024-06-14T23:00:00.000Z', 130_000), // the high
    row('2024-06-15T02:00:00.000Z', 60_000),  // the low
    row('2024-06-15T06:00:00.000Z', 110_000),
    row('2024-06-15T09:00:00.000Z', 105_000), // 19:00 Sydney — the close
  ];

  it('keeps a day\'s CLOSE, and only its close', () => {
    // Everything drawn between a fortnight and 400 days ago is a day close, so the
    // close is the whole of what a day has to keep. Its intraday extremes were on
    // no chart by then, and keeping them would triple the rows every yearly and
    // all-time read has to pull back for detail nothing draws.
    const [plan] = planBuckets(day, SYD, 'day');
    expect(plan.key).toBe('2024-06-15');
    expect(plan.keep).toEqual(['2024-06-15T09:00:00.000Z']);
    expect(plan.drop).toBe(4);
  });

  it('keeps a MONTH\'s close, high and low — the extreme is the movement', () => {
    const plan = planBuckets(day, SYD, 'month')[0];
    expect(plan.key).toBe('2024-06');
    expect(plan.keep.sort()).toEqual([
      '2024-06-14T23:00:00.000Z', // high
      '2024-06-15T02:00:00.000Z', // low
      '2024-06-15T09:00:00.000Z', // close
    ].sort());
    expect(plan.drop).toBe(2);
  });

  it('keeps the reading the chart itself would draw, at either grain', () => {
    // readPctHistory reduces a day to its LAST reading. That row has to survive, or
    // compaction moves the line.
    const drawn = day[day.length - 1].recorded_at;
    expect(planBuckets(day, SYD, 'day')[0].keep).toContain(drawn);
    expect(planBuckets(day, SYD, 'month')[0].keep).toContain(drawn);
  });

  it('drops nothing when the close, the high and the low are three different rows', () => {
    const plans = planBuckets(day.slice(1, 4), SYD, 'month'); // high, low, then the close
    expect(plans[0].drop).toBe(0);
    expect(plans[0].keep).toHaveLength(3);
  });

  it('keeps two rows, not three, when the close IS the low', () => {
    // The roles overlap far more often than they don't — a month that closes at its
    // worst point keeps two readings, and the third slot is not padded out with
    // some other row to make up the number.
    const plans = planBuckets(day.slice(0, 3), SYD, 'month'); // 100k, 130k high, 60k low+close
    expect(plans[0].keep).toHaveLength(2);
    expect(plans[0].drop).toBe(1);
  });

  it('keeps a single row as its own close, high and low at once', () => {
    const plans = planBuckets([row('2024-06-15T09:00:00.000Z', 42)], SYD, 'month');
    expect(plans[0].keep).toEqual(['2024-06-15T09:00:00.000Z']);
    expect(plans[0].drop).toBe(0);
  });

  it('preserves the shape of a crash and recovery inside one month', () => {
    // A month that opened at 1.5M, fell to 900K mid-month and closed back at 1.45M.
    // Month closes alone would draw a straight, calm line through it.
    const month = Array.from({ length: 30 }, (_, i) => {
      const v = i === 0 ? 1_500_000 : i === 14 ? 900_000 : i === 29 ? 1_450_000 : 1_400_000 + i * 100;
      return row(`2019-03-${String(i + 1).padStart(2, '0')}T09:00:00.000Z`, v);
    });
    const [plan] = planBuckets(month, SYD, 'month');
    const kept = month.filter(r => plan.keep.includes(r.recorded_at)).map(r => r.total_value);
    expect(Math.min(...kept)).toBe(900_000);   // the crash survives
    expect(Math.max(...kept)).toBe(1_500_000); // so does the peak it fell from
    expect(kept).toContain(1_450_000);         // and the close
    expect(plan.drop).toBe(27);
  });

  it('never invents a value: every kept instant is a row that was really recorded', () => {
    const real = new Set(day.map(r => r.recorded_at));
    for (const unit of ['day', 'month'] as const) {
      for (const p of planBuckets(day, SYD, unit)) {
        for (const k of p.keep) expect(real.has(k)).toBe(true);
        expect(p.instants.sort()).toEqual(day.map(r => r.recorded_at).sort());
      }
    }
  });

  it('plans one bucket per calendar day, oldest first', () => {
    const rows = Array.from({ length: 72 }, (_, i) =>
      row(new Date(Date.parse('2024-06-01T00:00:00.000Z') + i * 3_600_000).toISOString(), 1000 + i));
    const plans = planBuckets(rows, SYD, 'day');
    expect(plans.map(p => p.key)).toEqual(['2024-06-01', '2024-06-02', '2024-06-03', '2024-06-04']);
    for (let i = 1; i < plans.length; i++) expect(plans[i].startMs).toBe(plans[i - 1].endMs);
  });
});
