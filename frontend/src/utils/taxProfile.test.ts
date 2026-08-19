/**
 * The profile is the only place a user's own answers enter the tax engines, so
 * what it does with a BAD answer matters as much as what it does with a good
 * one. Two rules are tested here above all others:
 *
 *   • every relief defaults to off, so an untouched profile can only understate
 *     a refund;
 *   • hospital cover is the one exception and defaults to 'unknown', which is
 *     not the same answer as 'none' and must never collapse into it.
 */

import { describe, it, expect } from 'vitest';
import {
  emptyTaxProfile,
  normaliseTaxProfile,
  hasTaxProfile,
  hasHealthPolicy,
  TAX_PROFILE_GROUPS,
  type TaxProfile,
} from './taxProfile';

describe('the empty profile', () => {
  it('claims nothing and answers nothing', () => {
    const p = emptyTaxProfile();
    expect(p).toEqual({
      hasSpouse: false,
      spouseSurchargeIncome: 0,
      dependentChildren: 0,
      hospitalCover: 'unknown',
      hospitalCoverDays: 0,
      saptoEligible: false,
      saptoStatus: 'single',
      healthAgeBand: 'under-65',
      premiumsFirstPeriod: 0,
      premiumsSecondPeriod: 0,
      rebateReceived: 0,
    });
  });

  it('is not "no cover" — those are different answers', () => {
    // 'unknown' means Ledger has not been told; 'none' means the surcharge
    // applies. Collapsing the first into the second invents a four-figure bill.
    expect(emptyTaxProfile().hospitalCover).toBe('unknown');
    expect(emptyTaxProfile().hospitalCover).not.toBe('none');
  });

  it('reads as untouched', () => {
    expect(hasTaxProfile(emptyTaxProfile())).toBe(false);
    expect(hasTaxProfile(null)).toBe(false);
    expect(hasTaxProfile(undefined)).toBe(false);
  });
});

describe('normalising whatever came out of storage', () => {
  it('turns nothing into the empty profile', () => {
    expect(normaliseTaxProfile(null)).toEqual(emptyTaxProfile());
    expect(normaliseTaxProfile(undefined)).toEqual(emptyTaxProfile());
    expect(normaliseTaxProfile({})).toEqual(emptyTaxProfile());
    expect(normaliseTaxProfile('rubbish')).toEqual(emptyTaxProfile());
  });

  it('drops keys it does not know', () => {
    const p = normaliseTaxProfile({ hasSpouse: true, secretRate: 0.99 });
    expect(p).toEqual({ ...emptyTaxProfile(), hasSpouse: true });
    expect('secretRate' in p).toBe(false);
  });

  it('only accepts a real boolean for a toggle', () => {
    // A stringly-typed 'false' out of a form must not read as true.
    expect(normaliseTaxProfile({ hasSpouse: 'false' }).hasSpouse).toBe(false);
    expect(normaliseTaxProfile({ hasSpouse: 1 }).hasSpouse).toBe(false);
    expect(normaliseTaxProfile({ saptoEligible: true }).saptoEligible).toBe(true);
  });

  it('falls back rather than guessing at an unrecognised choice', () => {
    expect(normaliseTaxProfile({ hospitalCover: 'maybe' }).hospitalCover).toBe('unknown');
    expect(normaliseTaxProfile({ saptoStatus: 'widowed' }).saptoStatus).toBe('single');
    expect(normaliseTaxProfile({ healthAgeBand: '80-plus' }).healthAgeBand).toBe('under-65');
    expect(normaliseTaxProfile({ hospitalCover: 'part-year' }).hospitalCover).toBe('part-year');
  });

  it('zeroes a negative, NaN or infinite amount', () => {
    const p = normaliseTaxProfile({
      spouseSurchargeIncome: -5000,
      premiumsFirstPeriod: Number.NaN,
      premiumsSecondPeriod: Number.POSITIVE_INFINITY,
      rebateReceived: '  ',
    });
    expect([p.spouseSurchargeIncome, p.premiumsFirstPeriod, p.premiumsSecondPeriod, p.rebateReceived])
      .toEqual([0, 0, 0, 0]);
  });

  it('reads a numeric string and rounds money to the cent', () => {
    const p = normaliseTaxProfile({ spouseSurchargeIncome: '82500.456', premiumsFirstPeriod: '1200.5' });
    expect(p.spouseSurchargeIncome).toBe(82500.46);
    expect(p.premiumsFirstPeriod).toBe(1200.5);
  });

  it('makes a child count a whole number', () => {
    expect(normaliseTaxProfile({ dependentChildren: 2.7 }).dependentChildren).toBe(2);
    expect(normaliseTaxProfile({ dependentChildren: -1 }).dependentChildren).toBe(0);
    expect(normaliseTaxProfile({ dependentChildren: 500 }).dependentChildren).toBe(20);
  });

  it('keeps cover days only while the answer is "part of the year"', () => {
    // A stale day count sitting under "yes, all year" would contradict the very
    // answer beside it, so it is dropped rather than carried.
    expect(normaliseTaxProfile({ hospitalCover: 'part-year', hospitalCoverDays: 200 }).hospitalCoverDays).toBe(200);
    expect(normaliseTaxProfile({ hospitalCover: 'full-year', hospitalCoverDays: 200 }).hospitalCoverDays).toBe(0);
    expect(normaliseTaxProfile({ hospitalCover: 'none', hospitalCoverDays: 200 }).hospitalCoverDays).toBe(0);
    expect(normaliseTaxProfile({ hospitalCover: 'unknown', hospitalCoverDays: 200 }).hospitalCoverDays).toBe(0);
  });

  it('caps cover days at a leap financial year', () => {
    expect(normaliseTaxProfile({ hospitalCover: 'part-year', hospitalCoverDays: 900 }).hospitalCoverDays).toBe(366);
  });
});

describe('has-anything checks', () => {
  it('notices any single answer', () => {
    const answers: Partial<TaxProfile>[] = [
      { hasSpouse: true },
      { dependentChildren: 1 },
      { hospitalCover: 'none' },
      { saptoEligible: true },
      { premiumsFirstPeriod: 10 },
      { rebateReceived: 10 },
      { healthAgeBand: '70-plus' },
    ];
    for (const a of answers) {
      expect(hasTaxProfile(normaliseTaxProfile({ ...emptyTaxProfile(), ...a }))).toBe(true);
    }
  });

  it('separates "has a health statement" from "has answered anything"', () => {
    const spouseOnly = normaliseTaxProfile({ ...emptyTaxProfile(), hasSpouse: true });
    expect(hasTaxProfile(spouseOnly)).toBe(true);
    expect(hasHealthPolicy(spouseOnly)).toBe(false);
    expect(hasHealthPolicy(normaliseTaxProfile({ premiumsSecondPeriod: 400 }))).toBe(true);
    expect(hasHealthPolicy(normaliseTaxProfile({ rebateReceived: 400 }))).toBe(true);
  });
});

describe('the field metadata the editor renders', () => {
  it('covers every stored answer exactly once', () => {
    const keys = TAX_PROFILE_GROUPS.flatMap(g => g.fields.map(f => f.key)).sort();
    expect(keys).toEqual((Object.keys(emptyTaxProfile()) as (keyof TaxProfile)[]).sort());
  });

  it('explains every field and every group', () => {
    for (const g of TAX_PROFILE_GROUPS) {
      expect(g.title.length).toBeGreaterThan(0);
      expect(g.intro.length).toBeGreaterThan(20);
      for (const f of g.fields) {
        expect(f.help.length).toBeGreaterThan(20);
        if (f.kind === 'choice') expect((f.options ?? []).length).toBeGreaterThan(1);
      }
    }
  });

  it('hides a follow-up until the answer it depends on makes it mean something', () => {
    const empty = emptyTaxProfile();
    const fields = TAX_PROFILE_GROUPS.flatMap(g => g.fields);
    const visible = (key: keyof TaxProfile, p: TaxProfile) => {
      const f = fields.find(x => x.key === key)!;
      return !f.visibleWhen || f.visibleWhen(p);
    };
    expect(visible('spouseSurchargeIncome', empty)).toBe(false);
    expect(visible('spouseSurchargeIncome', { ...empty, hasSpouse: true })).toBe(true);
    expect(visible('hospitalCoverDays', { ...empty, hospitalCover: 'none' })).toBe(false);
    expect(visible('hospitalCoverDays', { ...empty, hospitalCover: 'part-year' })).toBe(true);
    expect(visible('saptoStatus', empty)).toBe(false);
    expect(visible('saptoStatus', { ...empty, saptoEligible: true })).toBe(true);
  });

  it('never offers "not answered" as something the user can pick', () => {
    const cover = TAX_PROFILE_GROUPS.flatMap(g => g.fields).find(f => f.key === 'hospitalCover')!;
    expect(cover.options?.map(o => o.value)).toEqual(['full-year', 'part-year', 'none']);
  });
});
