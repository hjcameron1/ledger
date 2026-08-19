/**
 * The offset engine's behaviour, as opposed to its data (taxOffsets.audit.test.ts
 * checks the numbers against the ATO's own tables).
 *
 * The cases that matter most are the ones where two similar-looking figures are
 * NOT interchangeable: the three income bases, the tier test versus the amount
 * the surcharge is charged on, and entitlement versus what a non-refundable
 * offset can actually be set against.
 */

import { describe, it, expect } from 'vitest';
import {
  buildOffsetPosition,
  rebateIncomeFrom,
  surchargeIncomeFrom,
  daysInFinancialYear,
  type OffsetPosition,
} from './taxOffsets';
import { emptyTaxProfile, type TaxProfile } from './taxProfile';
import {
  emptyRepaymentIncomeAdjustments,
  repaymentIncomeFrom,
  type RepaymentIncomeAdjustments,
} from './repaymentIncome';
import { estimateTaxForFY } from './taxRates';

function profile(p: Partial<TaxProfile> = {}): TaxProfile {
  return { ...emptyTaxProfile(), ...p };
}

function adjustments(a: Partial<RepaymentIncomeAdjustments> = {}): RepaymentIncomeAdjustments {
  return { ...emptyRepaymentIncomeAdjustments(), ...a };
}

/**
 * Build a position the way the page does: the income tax comes from the REAL
 * rate engine for the same year, never a stubbed number, so the cap on
 * non-refundable offsets is checked against tax that actually exists.
 */
function build(opts: {
  fy?: string;
  taxableIncome: number;
  profile?: Partial<TaxProfile>;
  adjustments?: Partial<RepaymentIncomeAdjustments>;
}): OffsetPosition {
  const fy = opts.fy ?? '2024-2025';
  const estimate = estimateTaxForFY(fy, opts.taxableIncome);
  return buildOffsetPosition({
    fy,
    taxableIncome: opts.taxableIncome,
    incomeTax: estimate?.incomeTax ?? null,
    adjustments: adjustments(opts.adjustments),
    profile: profile(opts.profile),
  });
}

const kinds = (p: OffsetPosition) => p.warnings.map(w => w.kind);

// ─── The three income bases ──────────────────────────────────────────────────

describe('the three income bases are not interchangeable', () => {
  const a = adjustments({
    reportableFringeBenefits: 10_000,
    totalNetInvestmentLoss: 4_000,
    reportableSuperContributions: 6_000,
    exemptForeignEmploymentIncome: 8_000,
    assessableFHSSReleased: 2_000,
  });

  it('rebate income leaves out exempt foreign employment income', () => {
    // 100,000 − 2,000 FHSS + 10,000 + 4,000 + 6,000
    expect(rebateIncomeFrom(100_000, a)).toBe(118_000);
  });

  it('income for surcharge purposes adds it back', () => {
    expect(surchargeIncomeFrom(100_000, a)).toBe(126_000);
  });

  it('income for surcharge purposes equals repayment income, because the ATO defines them the same way', () => {
    // Not a coincidence to be tidied away: if either definition ever moves, this
    // is the test that stops the other one following it silently. Compared over
    // incomes that exceed the FHSS release, since a released amount larger than
    // the taxable income it sits inside cannot occur.
    for (const income of [20_000, 95_000, 250_000]) {
      expect(surchargeIncomeFrom(income, a)).toBe(repaymentIncomeFrom(income, a).total);
    }
  });

  it('all three are taxable income when nothing was supplied', () => {
    expect(rebateIncomeFrom(80_000, null)).toBe(80_000);
    expect(surchargeIncomeFrom(80_000, null)).toBe(80_000);
  });

  it('never goes negative, however large the FHSS release', () => {
    expect(rebateIncomeFrom(1_000, adjustments({ assessableFHSSReleased: 50_000 }))).toBe(0);
    expect(surchargeIncomeFrom(-5_000, a)).toBeGreaterThanOrEqual(0);
  });
});

describe('the length of a financial year', () => {
  it('is decided by the February inside it, not the July it starts in', () => {
    // FY 2023-24 runs into February 2024, a leap February. FY 2024-25 does not.
    expect(daysInFinancialYear('2023-2024')).toBe(366);
    expect(daysInFinancialYear('2024-2025')).toBe(365);
    expect(daysInFinancialYear('2027-2028')).toBe(366);
    expect(daysInFinancialYear('2019-2020')).toBe(366);
  });
});

// ─── A year with no offset rules ─────────────────────────────────────────────

describe('a year Ledger holds no offset rules for', () => {
  const p = buildOffsetPosition({
    fy: '2015-2016',
    taxableIncome: 60_000,
    incomeTax: 11_047,
    profile: profile({ hospitalCover: 'none', saptoEligible: true }),
  });

  it('claims nothing and charges nothing', () => {
    expect(p.ratesAvailable).toBe(false);
    expect(p.entitlements).toEqual([]);
    expect(p.appliedTotal).toBe(0);
    expect(p.surcharge).toBeNull();
    expect(p.health).toBeNull();
    expect(p.sapto).toBeNull();
  });

  it('says so rather than leaving the year looking clean', () => {
    expect(kinds(p)).toEqual(['no-offset-rates']);
  });

  it('still reports the income bases, which are the user’s own figures', () => {
    expect(p.taxableIncome).toBe(60_000);
    expect(p.rebateIncome).toBe(60_000);
  });
});

// ─── LITO, and the cap on non-refundable offsets ─────────────────────────────

describe('the low income tax offset', () => {
  it('reduces the tax on a modest income', () => {
    // 2024-25, $40,000: tax is (40,000 − 18,200) × 16c = $3,488, LITO is
    // 700 − 2,500 × 5c = $575.
    const p = build({ taxableIncome: 40_000 });
    expect(p.entitlements.map(o => [o.key, o.amount])).toEqual([['lito', 575]]);
    expect(p.appliedTotal).toBe(575);
    expect(p.unusedOffsets).toBe(0);
  });

  it('is gone above the cut-out', () => {
    expect(build({ taxableIncome: 70_000 }).entitlements).toEqual([]);
    expect(build({ taxableIncome: 95_000 }).appliedTotal).toBe(0);
  });

  it('cannot be worth more than the income tax it is set against', () => {
    // $20,000: tax is (20,000 − 18,200) × 16c = $288 and LITO is the full $700.
    // The other $412 is simply lost — offsets are not refundable and cannot
    // touch the Medicare levy.
    const p = build({ taxableIncome: 20_000 });
    expect(p.entitlementsTotal).toBe(700);
    expect(p.appliedTotal).toBe(288);
    expect(p.unusedOffsets).toBe(412);
    expect(kinds(p)).toContain('offsets-capped');
  });

  it('applies nothing at all when there is no tax to reduce', () => {
    const p = build({ taxableIncome: 15_000 });
    expect(p.entitlementsTotal).toBe(700);
    expect(p.appliedTotal).toBe(0);
    expect(p.applied).toEqual([]);
  });

  it('comes with LMITO in the years that had one', () => {
    // 2021-22, $60,000: LITO is 325 − 15,000 × 1.5c = $100, LMITO is $1,500.
    const p = build({ fy: '2021-2022', taxableIncome: 60_000 });
    expect(p.entitlements.map(o => [o.key, o.amount])).toEqual([['lmito', 1500], ['lito', 100]]);
    expect(p.entitlementsTotal).toBe(1600);
  });

  it('reproduces the ATO’s own "Jeff" example — $1,600 off a $5,092 bill', () => {
    // 2021-22, taxable income $45,000: LITO $325 + LMITO $1,275.
    const p = build({ fy: '2021-2022', taxableIncome: 45_000 });
    expect(p.entitlements.map(o => [o.key, o.amount])).toEqual([['lmito', 1275], ['lito', 325]]);
    expect(p.appliedTotal).toBe(1600);
    expect(estimateTaxForFY('2021-2022', 45_000)?.incomeTax).toBe(5092);
  });
});

// ─── SAPTO ───────────────────────────────────────────────────────────────────

describe('the seniors and pensioners offset', () => {
  it('is nothing at all until the user says they are eligible', () => {
    const p = build({ taxableIncome: 30_000 });
    expect(p.sapto?.reason).toBe('not-eligible');
    expect(p.entitlements.map(o => o.key)).toEqual(['lito']);
  });

  it('is added on top of LITO once they do', () => {
    // 2024-25, $30,000 rebate income: SAPTO is the full $2,230 and LITO is $700,
    // against income tax of (30,000 − 18,200) × 16c = $1,888.
    const p = build({ taxableIncome: 30_000, profile: { saptoEligible: true } });
    expect(p.entitlements.map(o => [o.key, o.amount])).toEqual([['sapto', 2230], ['lito', 700]]);
    expect(p.entitlementsTotal).toBe(2930);
    expect(p.appliedTotal).toBe(1888);
    expect(p.unusedOffsets).toBe(1042);
  });

  it('runs on rebate income, not taxable income', () => {
    // The same $30,000 taxable income with $8,000 of reportable super puts the
    // rebate income at $38,000 — past the shade-out — while the income TAX is
    // unchanged, which is the whole reason the two bases are kept apart.
    const p = build({
      taxableIncome: 30_000,
      profile: { saptoEligible: true },
      adjustments: { reportableSuperContributions: 8_000 },
    });
    expect(p.rebateIncome).toBe(38_000);
    // 2,230 − (38,000 − 34,919) × 12.5c = 2,230 − 385.125 = 1,844.875, rounded up.
    expect(p.sapto?.amount).toBe(1845);
    expect(p.entitlements.find(o => o.key === 'sapto')?.detail)
      .toBe('On $38,000 rebate income, not taxable income');
  });

  it('tests a couple on half their combined income but tapers each on their own', () => {
    const p = build({
      taxableIncome: 33_650,
      profile: {
        saptoEligible: true,
        saptoStatus: 'couple',
        hasSpouse: true,
        spouseSurchargeIncome: 0,
      },
    });
    expect(p.sapto?.testedIncome).toBe(16_825);
    expect(p.sapto?.amount).toBe(1270);
  });

  it('withdraws it entirely when the couple’s combined income is too high', () => {
    const p = build({
      taxableIncome: 64_020,
      profile: {
        saptoEligible: true,
        saptoStatus: 'couple',
        hasSpouse: true,
        spouseSurchargeIncome: 25_677,
      },
    });
    expect(p.sapto?.reason).toBe('above-cut-out');
    expect(p.sapto?.amount).toBe(0);
    expect(kinds(p)).toContain('sapto-above-cut-out');
  });

  it('flags a couple’s offset claimed with no spouse recorded', () => {
    const p = build({
      taxableIncome: 30_000,
      profile: { saptoEligible: true, saptoStatus: 'couple' },
    });
    expect(kinds(p)).toContain('sapto-couple-without-spouse');
  });

  it('uses the year’s own thresholds, never a neighbouring year’s', () => {
    // $33,000 rebate income is past the 2023-24 shade-out ($32,279) and below
    // the 2024-25 one ($34,919), so the same income gives different offsets.
    const older = build({ fy: '2023-2024', taxableIncome: 33_000, profile: { saptoEligible: true } });
    const newer = build({ fy: '2024-2025', taxableIncome: 33_000, profile: { saptoEligible: true } });
    expect(older.sapto?.amount).toBe(2140);  // 2,230 − 721 × 12.5c = 2,139.875, up
    expect(newer.sapto?.amount).toBe(2230);
  });
});

// ─── The Medicare levy surcharge ─────────────────────────────────────────────

describe('the Medicare levy surcharge', () => {
  it('is not charged until Ledger is told about hospital cover', () => {
    // The only place the engine deliberately does NOT take the conservative
    // direction: a four-figure charge invented for the majority who do hold
    // cover would be worse than a loud question.
    const p = build({ taxableIncome: 120_000 });
    expect(p.surcharge?.exemptReason).toBe('not-answered');
    expect(p.surcharge?.amount).toBe(0);
    expect(p.extraLiabilityTotal).toBe(0);
    const warning = p.warnings.find(w => w.kind === 'hospital-cover-unknown');
    expect(warning?.severity).toBe('warn');
    expect(warning?.amount).toBe(1500);  // 1.25% of $120,000, a full year
  });

  it('says nothing about cover when the income is below the threshold anyway', () => {
    const p = build({ taxableIncome: 80_000 });
    expect(p.surcharge?.exemptReason).toBe('below-threshold');
    expect(kinds(p)).not.toContain('hospital-cover-unknown');
  });

  it('is charged for a year with no cover', () => {
    const p = build({ taxableIncome: 120_000, profile: { hospitalCover: 'none' } });
    expect(p.surcharge?.tier).toBe('tier-2');
    expect(p.surcharge?.rate).toBe(0.0125);
    expect(p.surcharge?.amount).toBe(1500);
    expect(p.extraLiability.map(l => l.key)).toEqual(['medicare-levy-surcharge']);
    expect(kinds(p)).toContain('surcharge-applies');
  });

  it('is not charged when cover ran all year', () => {
    const p = build({ taxableIncome: 120_000, profile: { hospitalCover: 'full-year' } });
    expect(p.surcharge?.exemptReason).toBe('hospital-cover');
    expect(p.surcharge?.amount).toBe(0);
  });

  it('reproduces the ATO’s own worked example — fringe benefits choose the tier AND are charged', () => {
    // 2026-27: $90,000 taxable plus $27,000 of reportable fringe benefits is
    // $117,000 of surcharge income, which is Tier 1, and the 1% is charged on
    // the whole $117,000 — not on the $90,000 that the brackets saw.
    const p = build({
      fy: '2026-2027',
      taxableIncome: 90_000,
      profile: { hospitalCover: 'none' },
      adjustments: { reportableFringeBenefits: 27_000 },
    });
    expect(p.surcharge?.testedIncome).toBe(117_000);
    expect(p.surcharge?.tier).toBe('tier-1');
    expect(p.surcharge?.base).toBe(117_000);
    expect(p.surcharge?.amount).toBe(1170);
  });

  it('charges only the days without cover', () => {
    // 2024-25 is a 365-day year; 100 days covered leaves 265 uncovered.
    const p = build({
      taxableIncome: 120_000,
      profile: { hospitalCover: 'part-year', hospitalCoverDays: 100 },
    });
    expect(p.surcharge?.daysWithoutCover).toBe(265);
    expect(p.surcharge?.amount).toBeCloseTo((1500 * 265) / 365, 2);
    expect(kinds(p)).toContain('surcharge-part-year');
    expect(p.extraLiability[0].detail).toContain('265 days');
  });

  it('switches to family thresholds and combined income when there is a spouse', () => {
    // $100,000 alone is Tier 1 for a single. With a $120,000 spouse the couple's
    // $220,000 is still only Tier 1 on the doubled family scale.
    const single = build({ taxableIncome: 100_000, profile: { hospitalCover: 'none' } });
    expect(single.surcharge?.tier).toBe('tier-1');
    const family = build({
      taxableIncome: 100_000,
      profile: { hospitalCover: 'none', hasSpouse: true, spouseSurchargeIncome: 120_000 },
    });
    expect(family.surcharge?.familyThresholds).toBe(true);
    expect(family.surcharge?.testedIncome).toBe(220_000);
    expect(family.surcharge?.threshold).toBe(194_000);
    expect(family.surcharge?.tier).toBe('tier-1');
    expect(family.surcharge?.amount).toBe(1000);  // still 1% of the OWN $100,000
  });

  it('lifts the family threshold for each child after the first', () => {
    const p = build({
      taxableIncome: 195_000,
      profile: { hospitalCover: 'none', dependentChildren: 3 },
    });
    // 194,000 + 2 × 1,500 = 197,000, so $195,000 falls back under the threshold.
    expect(p.surcharge?.threshold).toBe(197_000);
    expect(p.surcharge?.exemptReason).toBe('below-threshold');
  });

  it('exempts a low earner whose family income is over the threshold', () => {
    // The family is well into Tier 2, but her own $20,000 is under the year's
    // Medicare levy low-income threshold, so she pays no surcharge.
    const p = build({
      taxableIncome: 20_000,
      profile: { hospitalCover: 'none', hasSpouse: true, spouseSurchargeIncome: 250_000 },
    });
    expect(p.surcharge?.tier).toBe('tier-2');
    expect(p.surcharge?.exemptReason).toBe('low-own-income');
    expect(p.surcharge?.amount).toBe(0);
  });

  it('warns when a spouse is recorded with no income', () => {
    const p = build({ taxableIncome: 100_000, profile: { hasSpouse: true, hospitalCover: 'none' } });
    expect(kinds(p)).toContain('spouse-income-missing');
  });

  it('uses the year’s own thresholds', () => {
    // $95,000 is over the 2023-24 single threshold ($93,000) and under the
    // 2024-25 one ($97,000).
    const older = build({ fy: '2023-2024', taxableIncome: 95_000, profile: { hospitalCover: 'none' } });
    const newer = build({ fy: '2024-2025', taxableIncome: 95_000, profile: { hospitalCover: 'none' } });
    expect(older.surcharge?.amount).toBe(950);
    expect(newer.surcharge?.amount).toBe(0);
  });
});

// ─── The private health rebate reconciliation ────────────────────────────────

describe('the private health insurance rebate', () => {
  const statement = {
    hospitalCover: 'full-year' as const,
    premiumsFirstPeriod: 2_000,
    premiumsSecondPeriod: 700,
  };
  // 2024-25 base tier, under 65: 2,000 × 24.608% + 700 × 24.288%.
  const ENTITLED = 492.16 + 170.02;

  it('works the entitlement out period by period, because the rate changes on 1 April', () => {
    const p = build({ taxableIncome: 60_000, profile: { ...statement, rebateReceived: ENTITLED } });
    expect(p.health?.periods.map(x => x.entitled)).toEqual([492.16, 170.02]);
    expect(p.health?.entitled).toBeCloseTo(662.18, 2);
    expect(p.health?.adjustment).toBe(0);
    expect(p.extraLiability).toEqual([]);
    expect(p.refundableCredits).toEqual([]);
  });

  it('adds the excess to the bill when the insurer gave too much', () => {
    const p = build({ taxableIncome: 60_000, profile: { ...statement, rebateReceived: 900 } });
    expect(p.health?.adjustment).toBeCloseTo(237.82, 2);
    expect(p.extraLiability.map(l => l.key)).toEqual(['excess-health-rebate']);
    expect(p.extraLiabilityTotal).toBeCloseTo(237.82, 2);
    expect(kinds(p)).toContain('excess-health-rebate');
  });

  it('gives the shortfall back as a refundable credit when it gave too little', () => {
    const p = build({ taxableIncome: 60_000, profile: { ...statement, rebateReceived: 400 } });
    expect(p.health?.adjustment).toBeCloseTo(-262.18, 2);
    expect(p.refundableCredits.map(l => l.key)).toEqual(['health-rebate-shortfall']);
    expect(p.refundableCreditsTotal).toBeCloseTo(262.18, 2);
    // Refundable, so it is a CREDIT and never a non-refundable offset.
    expect(p.entitlements.map(o => o.key)).not.toContain('health-rebate-shortfall');
  });

  it('pays nothing in tier 3, so the whole rebate received comes back', () => {
    // $200,000 single is tier 3 — no rebate at any age.
    const p = build({
      taxableIncome: 200_000,
      profile: { ...statement, rebateReceived: 662.18 },
    });
    expect(p.health?.tier).toBe('tier-3');
    expect(p.health?.entitled).toBe(0);
    expect(p.extraLiabilityTotal).toBeCloseTo(662.18, 2);
  });

  it('pays more at 70 than at 64 on the same premiums', () => {
    const younger = build({ taxableIncome: 60_000, profile: statement });
    const older = build({
      taxableIncome: 60_000,
      profile: { ...statement, healthAgeBand: '70-plus' },
    });
    expect(older.health!.entitled).toBeGreaterThan(younger.health!.entitled);
    expect(older.health?.periods[0].percentage).toBe(32.812);
  });

  it('follows the family income test into a lower rebate tier', () => {
    const single = build({ taxableIncome: 100_000, profile: statement });
    expect(single.health?.tier).toBe('tier-1');
    const family = build({
      taxableIncome: 100_000,
      profile: { ...statement, hasSpouse: true, spouseSurchargeIncome: 60_000 },
    });
    // $160,000 combined is under the $194,000 family base threshold.
    expect(family.health?.tier).toBe('base');
    expect(family.health!.entitled).toBeGreaterThan(single.health!.entitled);
  });

  it('does nothing at all until a statement is entered', () => {
    const p = build({ taxableIncome: 60_000, profile: { hospitalCover: 'full-year' } });
    expect(p.health).toBeNull();
    expect(kinds(p)).toContain('health-rebate-no-premiums');
  });
});

// ─── Standing limitations ────────────────────────────────────────────────────

describe('what the engine says about its own limits', () => {
  it('always names what it does not model, and only as information', () => {
    const p = build({ taxableIncome: 60_000 });
    const w = p.warnings.find(x => x.kind === 'offsets-not-modelled');
    expect(w?.severity).toBe('info');
    expect(w?.message).toMatch(/unused seniors offset/i);
    expect(w?.message).toMatch(/this or better/i);
  });

  it('flags a year whose figures are carried forward', () => {
    expect(kinds(build({ fy: '2026-2027', taxableIncome: 60_000 }))).toContain('provisional-offset-rates');
    expect(kinds(build({ fy: '2024-2025', taxableIncome: 60_000 }))).not.toContain('provisional-offset-rates');
  });

  it('keeps a warn for anything that could move the outcome and info for the rest', () => {
    const p = build({
      taxableIncome: 220_000,
      profile: { hospitalCover: 'none', hasSpouse: true },
    });
    const bySeverity = Object.fromEntries(p.warnings.map(w => [w.kind, w.severity]));
    expect(bySeverity['surcharge-applies']).toBe('warn');
    expect(bySeverity['spouse-income-missing']).toBe('warn');
    expect(bySeverity['offsets-not-modelled']).toBe('info');
  });
});

// ─── Invariants over every shape of input ────────────────────────────────────

const SCENARIOS: { name: string; input: Parameters<typeof build>[0] }[] = [
  { name: 'an empty year', input: { taxableIncome: 0 } },
  { name: 'a low earner', input: { taxableIncome: 22_000 } },
  { name: 'a wage earner', input: { taxableIncome: 95_000 } },
  { name: 'a high earner with no cover', input: { taxableIncome: 200_000, profile: { hospitalCover: 'none' } } },
  { name: 'a senior', input: { taxableIncome: 36_000, profile: { saptoEligible: true } } },
  {
    name: 'a family with a health statement',
    input: {
      taxableIncome: 110_000,
      profile: {
        hasSpouse: true, spouseSurchargeIncome: 95_000, dependentChildren: 2,
        hospitalCover: 'part-year', hospitalCoverDays: 200,
        premiumsFirstPeriod: 3_000, premiumsSecondPeriod: 1_000, rebateReceived: 800,
      },
    },
  },
  { name: 'an LMITO year', input: { fy: '2021-2022', taxableIncome: 55_000 } },
  { name: 'an unsupported year', input: { fy: '2015-2016', taxableIncome: 80_000 } },
];

describe.each(SCENARIOS)('invariants — $name', ({ input }) => {
  const p = build(input);

  it('never applies more offset than it is entitled to', () => {
    expect(p.appliedTotal).toBeLessThanOrEqual(p.entitlementsTotal + 0.001);
    expect(p.unusedOffsets).toBeCloseTo(p.entitlementsTotal - p.appliedTotal, 2);
    expect(p.unusedOffsets).toBeGreaterThanOrEqual(0);
  });

  it('never applies more offset than the income tax it can be set against', () => {
    const incomeTax = estimateTaxForFY(input.fy ?? '2024-2025', input.taxableIncome)?.incomeTax ?? 0;
    expect(p.appliedTotal).toBeLessThanOrEqual(incomeTax + 0.001);
  });

  it('has every group summing to its own lines', () => {
    const sum = (ls: { amount: number }[]) => Math.round(ls.reduce((s, l) => s + l.amount, 0) * 100) / 100;
    expect(sum(p.entitlements)).toBeCloseTo(p.entitlementsTotal, 2);
    expect(sum(p.applied)).toBeCloseTo(p.appliedTotal, 2);
    expect(sum(p.extraLiability)).toBeCloseTo(p.extraLiabilityTotal, 2);
    expect(sum(p.refundableCredits)).toBeCloseTo(p.refundableCreditsTotal, 2);
  });

  it('never produces a negative amount on any line', () => {
    for (const l of [...p.entitlements, ...p.applied, ...p.extraLiability, ...p.refundableCredits]) {
      expect(l.amount).toBeGreaterThanOrEqual(0);
      expect(l.detail.length).toBeGreaterThan(0);
    }
  });

  it('never has the health rebate on both sides at once', () => {
    const excess = p.extraLiability.some(l => l.key === 'excess-health-rebate');
    const shortfall = p.refundableCredits.some(l => l.key === 'health-rebate-shortfall');
    expect(excess && shortfall).toBe(false);
  });

  it('never charges a surcharge it also says is exempt', () => {
    if (p.surcharge?.exemptReason) expect(p.surcharge.amount).toBe(0);
    if ((p.surcharge?.amount ?? 0) > 0) expect(p.surcharge?.exemptReason).toBeNull();
  });

  it('explains itself', () => {
    expect(p.warnings.length).toBeGreaterThan(0);
    for (const w of p.warnings) expect(w.message.length).toBeGreaterThan(20);
  });
});
