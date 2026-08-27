import { describe, it, expect } from 'vitest';
import {
  propertyNetWorthValue,
  propertyNetWorthTotal,
  type NetWorthLoanRow,
  type NetWorthPropertyRow,
} from './netWorthSnapshot';

/**
 * The server's half of the property/mortgage rule.
 *
 * There are two engines that decide what a house does to net worth — this one and
 * the browser's (frontend/src/utils/property.ts) — and the failure that matters is
 * them disagreeing. So the cases below are deliberately the SAME cases the client
 * engine is tested on, asserting the same numbers, using the worked example:
 *
 *     a $1,000,000 house with $800,000 owing moves net worth by $200,000.
 *
 * The mortgage is subtracted once and only once. Normally the loans total does it,
 * because a mortgage is an ordinary loan row. When that loan is switched out of
 * net worth the loans total skips it, so the property subtracts it instead —
 * otherwise net worth reports a mortgaged house as though it were owned outright.
 */

const prop = (o: Partial<NetWorthPropertyRow> = {}): NetWorthPropertyRow => ({
  current_value: 1_000_000,
  ownership_percent: 100,
  include_in_net_worth: true,
  loan_id: null,
  ...o,
});

const mortgage = (o: Partial<NetWorthLoanRow> = {}): NetWorthLoanRow => ({
  id: 'm1',
  current_balance: 800_000,
  include_in_net_worth: true,
  ...o,
});

/** The loan lookup computeNetWorth builds, from a list of loans. */
const index = (loans: NetWorthLoanRow[]) =>
  new Map<string, NetWorthLoanRow>(loans.map(l => [String(l.id), l]));

describe('what one property contributes to net worth', () => {
  it('an unencumbered house contributes its whole value', () => {
    expect(propertyNetWorthValue(prop(), index([]))).toBe(1_000_000);
  });

  it('a mortgaged house contributes its whole value, and the LOANS total nets the debt', () => {
    // The property must not net it here as well — that would take the same
    // $800,000 off twice and report $200,000 of equity as −$600,000.
    const v = propertyNetWorthValue(prop({ loan_id: 'm1' }), index([mortgage()]));
    expect(v).toBe(1_000_000);
    expect(v - 800_000).toBe(200_000);   // …once the loans term has had its turn
  });

  it('a mortgage switched OUT of net worth is netted here instead', () => {
    const v = propertyNetWorthValue(
      prop({ loan_id: 'm1' }),
      index([mortgage({ include_in_net_worth: false })]),
    );
    expect(v).toBe(200_000);   // and the loans total adds nothing back
  });

  it('legacy loans, with the flag never set, count as included', () => {
    // Rows saved before the column existed read null/undefined. Treating those as
    // excluded would net every old mortgage twice.
    for (const flag of [null, undefined]) {
      const v = propertyNetWorthValue(
        prop({ loan_id: 'm1' }),
        index([mortgage({ include_in_net_worth: flag as null | undefined })]),
      );
      expect(v).toBe(1_000_000);
    }
  });

  it('ownership scales the value and never the loan', () => {
    expect(propertyNetWorthValue(prop({ ownership_percent: 50 }), index([]))).toBe(500_000);
    // Half the house, all of the debt: the loan row is what the user signed for.
    expect(propertyNetWorthValue(
      prop({ ownership_percent: 50, loan_id: 'm1' }),
      index([mortgage({ include_in_net_worth: false })]),
    )).toBe(-300_000);
  });

  it('a missing or nonsense ownership share is read as the whole property', () => {
    expect(propertyNetWorthValue(prop({ ownership_percent: null }), index([]))).toBe(1_000_000);
    expect(propertyNetWorthValue(prop({ ownership_percent: 'abc' as unknown as number }), index([]))).toBe(1_000_000);
    // A typo'd 1000% would otherwise multiply net worth by ten.
    expect(propertyNetWorthValue(prop({ ownership_percent: 1000 }), index([]))).toBe(1_000_000);
    expect(propertyNetWorthValue(prop({ ownership_percent: -20 }), index([]))).toBe(0);
  });

  it('a property opted out contributes nothing, and leaves its debt to the loans', () => {
    // Switching an asset off is not a claim that the money owed against it
    // stopped being owed, so this must NOT return −800,000.
    expect(propertyNetWorthValue(
      prop({ include_in_net_worth: false, loan_id: 'm1' }),
      index([mortgage()]),
    )).toBe(0);
    expect(propertyNetWorthValue(
      prop({ include_in_net_worth: false, loan_id: 'm1' }),
      index([mortgage({ include_in_net_worth: false })]),
    )).toBe(0);
  });

  it('an SMSF property already inside its fund balance adds nothing of its own', () => {
    // The fund has to be one the caller has LOADED (finding N3). Deferring to a
    // fund nothing can resolve is how a house came to be counted by nobody: the
    // client had no SMSF slice at all, so it zeroed the property on the strength
    // of a balance that was not in its net worth either.
    const held = prop({ held_by: 'smsf', smsf_fund_id: 'f1', counted_in_fund_balance: true });
    expect(propertyNetWorthValue(held, index([]), new Set(['f1']))).toBe(0);
  });

  it('…and an SMSF property whose fund is NOT loaded counts itself', () => {
    const held = prop({ held_by: 'smsf', smsf_fund_id: 'gone', counted_in_fund_balance: true });
    expect(propertyNetWorthValue(held, index([]), new Set(['f1']))).toBe(1_000_000);
    expect(propertyNetWorthValue(held, index([]))).toBe(1_000_000);
  });

  it('…but still nets an uncounted mortgage: a fund balance is a value, not equity', () => {
    const held = prop({
      held_by: 'smsf', smsf_fund_id: 'f1', counted_in_fund_balance: true, loan_id: 'm1',
    });
    const funds = new Set(['f1']);
    expect(propertyNetWorthValue(held, index([mortgage({ include_in_net_worth: false })]), funds)).toBe(-800_000);
    // With the loan counted, the loans total does it and this stays out of the way.
    expect(propertyNetWorthValue(held, index([mortgage()]), funds)).toBe(0);
  });

  it('an SMSF property the fund does NOT list is counted here', () => {
    const held = prop({ held_by: 'smsf', smsf_fund_id: 'f1', counted_in_fund_balance: false });
    expect(propertyNetWorthValue(held, index([]))).toBe(1_000_000);
  });

  it('a personally-held property is never treated as in-fund, whatever ids it carries', () => {
    // Pre-migration rows can have a stale fund id with held_by back at 'personal'.
    const p = prop({ held_by: 'personal', smsf_fund_id: 'f1', counted_in_fund_balance: true });
    expect(propertyNetWorthValue(p, index([]))).toBe(1_000_000);
  });

  it('a loan_id pointing at nothing is treated as unencumbered', () => {
    // A deleted loan leaves no balance to trust; inventing one is worse than
    // reporting the house on its own.
    expect(propertyNetWorthValue(prop({ loan_id: 'gone' }), index([mortgage()]))).toBe(1_000_000);
  });

  it('a property with no value on file contributes nothing rather than NaN', () => {
    expect(propertyNetWorthValue(prop({ current_value: null }), index([]))).toBe(0);
    expect(propertyNetWorthValue(prop({ current_value: '750000' }), index([]))).toBe(750_000);
  });
});

describe('the property line of net worth', () => {
  it('sums each property under its own rule', () => {
    const properties = [
      prop({ loan_id: 'counted' }),                                   // 1,000,000
      prop({ loan_id: 'skipped' }),                                   //   200,000
      prop({ ownership_percent: 50, loan_id: null }),                 //   500,000
      prop({ include_in_net_worth: false }),                          //         0
      prop({ held_by: 'smsf', smsf_fund_id: 'f1', counted_in_fund_balance: true }), // 0
    ];
    const loans = [
      mortgage({ id: 'counted' }),
      mortgage({ id: 'skipped', include_in_net_worth: false }),
    ];
    expect(propertyNetWorthTotal(properties, loans, new Set(['f1']))).toBe(1_700_000);
  });

  it('nets a mortgage the loans total skips ONCE, however many houses secure it', () => {
    // FINDING N4. The rule was asked per property and kept no record, so two
    // houses against one skipped loan each subtracted the whole balance and the
    // portfolio read 800,000 short. The picker refuses to link one loan twice,
    // but a second device or a pre-guard row can still write the shape.
    const properties = [
      prop({ id: 'a', loan_id: 'skipped' }),
      prop({ id: 'b', loan_id: 'skipped' }),
    ];
    const loans = [mortgage({ id: 'skipped', include_in_net_worth: false })];
    expect(propertyNetWorthTotal(properties, loans)).toBe(2_000_000 - 800_000);
  });

  it('and a property switched OFF does not use up the netting its neighbour needs', () => {
    // An excluded property contributes nothing, so it must not claim the loan:
    // otherwise the house next door finds it already netted and the debt leaves
    // net worth altogether.
    const properties = [
      prop({ id: 'off', include_in_net_worth: false, loan_id: 'skipped' }),
      prop({ id: 'on', loan_id: 'skipped' }),
    ];
    const loans = [mortgage({ id: 'skipped', include_in_net_worth: false })];
    expect(propertyNetWorthTotal(properties, loans)).toBe(1_000_000 - 800_000);
  });

  it('is 0, not NaN, for a user with no properties', () => {
    expect(propertyNetWorthTotal([], [])).toBe(0);
    expect(propertyNetWorthTotal(null, null)).toBe(0);
    // The property tables 400 on databases where the migration hasn't run, which
    // reaches here as null — that must degrade to "no properties", not zero out
    // the whole net worth with a NaN.
    expect(propertyNetWorthTotal(undefined, [mortgage()])).toBe(0);
  });

  it('rounds to the cent so the total never carries float dust', () => {
    expect(propertyNetWorthTotal([prop({ current_value: 1_000_000, ownership_percent: 33.33 })], []))
      .toBe(333_300);
  });
});
