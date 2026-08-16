import { describe, it, expect } from 'vitest';
import { buildAdjustedSeries, type AdjustedInputRow, type AdjustedLiveItem } from './netWorthSnapshot';

// Helper: expand a { ts: {key: value} } shape into flat item-history rows.
function rows(spec: Record<string, Record<string, number>>, debts: Set<string> = new Set()): AdjustedInputRow[] {
  const out: AdjustedInputRow[] = [];
  for (const [recorded_at, items] of Object.entries(spec)) {
    for (const [key, value] of Object.entries(items)) {
      const [item_type, item_id] = key.split(':');
      out.push({ recorded_at, item_type, item_id, value, is_debt: debts.has(key) });
    }
  }
  return out;
}
const live = (items: Record<string, number>, debts: Set<string> = new Set()): AdjustedLiveItem[] =>
  Object.entries(items).map(([key, value]) => {
    const [item_type, item_id] = key.split(':');
    return { item_type, item_id, value, is_debt: debts.has(key) };
  });

describe('buildAdjustedSeries — structural neutralisation', () => {
  it('a brand-new account (never snapshotted) contributes 0 organic to the live headline', () => {
    const r = rows({
      '2026-01-01T00:00:00Z': { 'bank:a': 1000 },
      '2026-01-02T00:00:00Z': { 'bank:a': 1000 },
    });
    // Live now includes a freshly added account 'bank:b' with no history yet.
    const s = buildAdjustedSeries(r, live({ 'bank:a': 1000, 'bank:b': 5000 }));
    expect(s.currentBase).toBe(6000);   // b's base = its own live value ⇒ 0 organic
    expect(s.currentValue).toBe(6000);
    expect(s.carryValue).toBe(0);
    // organic = liveNw − currentBase = 0 (no spike from the add).
    expect(6000 - s.currentBase).toBe(0);
  });

  it('adding an account mid-history does not step the organic/pct line', () => {
    const r = rows({
      '2026-01-01T00:00:00Z': { 'bank:a': 1000 },
      '2026-01-02T00:00:00Z': { 'bank:a': 1000, 'bank:b': 5000 }, // b added
      '2026-01-03T00:00:00Z': { 'bank:a': 1000, 'bank:b': 5000 },
    });
    const s = buildAdjustedSeries(r);
    // Every point's organic stays ~0 despite +5000 of raw value appearing.
    expect(s.points.map(p => p.organic)).toEqual([0, 0, 0]);
    expect(s.points.map(p => p.pct)).toEqual([0, 0, 0]);
  });

  it('REPLACING an account that had lost value stays seam-free (the real bug)', () => {
    // Mirrors Harry's live data: an account first tracked at 7503 that drifted down
    // to 5564 is removed, and a fresh 7503 account is added the next snapshot. The
    // old code stepped organic by +1939 (the removed account's loss). It must not.
    const r = rows({
      // weekend: 8 items, one of them the OLD account 'bank:old' now worth 5564
      '2026-08-15T00:00:00Z': { 'bank:keep': 51749.14, 'bank:old': 5564.45 },
      // 00:53 — old account removed (7 items conceptually; here just 'keep')
      '2026-08-16T00:53:00Z': { 'bank:keep': 51749.14 },
      // 00:55 — brand-new 'bank:new' added at 7503.24
      '2026-08-16T00:55:00Z': { 'bank:keep': 51749.14, 'bank:new': 7503.24 },
    });
    // 'bank:old' was first tracked at 7503 (so it had a −1939 unrealised loss).
    r.unshift({ recorded_at: '2026-08-14T00:00:00Z', item_type: 'bank', item_id: 'old', value: 7503, is_debt: false });
    r.unshift({ recorded_at: '2026-08-14T00:00:00Z', item_type: 'bank', item_id: 'keep', value: 51749.14, is_debt: false });

    const s = buildAdjustedSeries(r, live({ 'bank:keep': 51749.14, 'bank:new': 7503.24 }));

    // The removed account's value is frozen into carry so the total is continuous.
    expect(s.carryValue).toBeCloseTo(5564.45, 2);
    // points: [0]=initial (organic 0), [1]=old declined to 5564 (−1939), [2]=old
    // removed, [3]=new added. The CONTINUITY across the remove+add is the fix: the
    // −1939 must NOT step to +1939 when the losing account leaves.
    const org = s.points.map(p => p.organic);
    expect(org[1]).toBeCloseTo(-1938.55, 1);   // old account's real unrealised loss
    expect(org[2]).toBeCloseTo(org[1], 2);     // removing it does NOT step the total
    expect(org[3]).toBeCloseTo(org[1], 2);     // adding the replacement does NOT step it

    // Live headline: liveNw + carry − currentBase ⇒ same ≈ −1939, NOT a fake +1939.
    const liveNw = 59252.38; // keep 51749.14 + new 7503.24
    const liveOrganic = (liveNw + s.carryValue) - s.currentBase;
    expect(liveOrganic).toBeCloseTo(-1938.55, 1);
  });

  it('a removed account that REAPPEARS is unfrozen (counted live again)', () => {
    const r = rows({
      '2026-01-01T00:00:00Z': { 'bank:a': 1000, 'bank:b': 500 },
      '2026-01-02T00:00:00Z': { 'bank:a': 1000 },              // b drops out
      '2026-01-03T00:00:00Z': { 'bank:a': 1000, 'bank:b': 500 }, // b returns
    });
    const s = buildAdjustedSeries(r, live({ 'bank:a': 1000, 'bank:b': 500 }));
    expect(s.carryValue).toBe(0);          // b is live again, nothing frozen
    expect(s.points[s.points.length - 1].organic).toBe(0);
  });

  it('genuine gains still register (only structural events are neutralised)', () => {
    const r = rows({
      '2026-01-01T00:00:00Z': { 'investment:x': 1000 },
      '2026-01-02T00:00:00Z': { 'investment:x': 1100 }, // real +100 gain
    });
    const s = buildAdjustedSeries(r);
    expect(s.points[1].organic).toBe(100);
    expect(s.points[1].pct).toBeCloseTo(10, 4);
  });
});
