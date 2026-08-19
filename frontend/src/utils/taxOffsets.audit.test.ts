/**
 * THE AUDIT — the ATO's own offset, surcharge and rebate tables, transcribed,
 * and the registry checked against them cell by cell.
 *
 * Same division of labour as taxRates.audit.test.ts: taxOffsets.test.ts proves
 * the engine is internally consistent, and cannot prove the numbers are the
 * RIGHT numbers. Each table below was copied from the ATO page named above it on
 * 19 August 2026 and is the source of truth here — if taxOffsets.ts disagrees
 * with one of these rows, taxOffsets.ts is what changes.
 *
 * The rebate percentages for 2020-21 to 2023-24 and the pre-2024-25 SAPTO
 * thresholds are no longer on the live ATO pages; they were read from the same
 * pages as they stood at the time, via the Internet Archive (snapshots of
 * 4 December 2023, 1 September 2024 and 15 April 2024 respectively).
 *
 * Sources:
 *   ato.gov.au/individuals-and-families/income-deductions-offsets-and-records/
 *     tax-offsets/low-income-tax-offset
 *   ato.gov.au/forms-and-instructions/low-and-middle-income-earner-tax-offsets
 *   ato.gov.au/individuals-and-families/income-deductions-offsets-and-records/
 *     tax-offsets/seniors-and-pensioners-tax-offset
 *   ato.gov.au/individuals-and-families/medicare-and-private-health-insurance/
 *     medicare-levy-surcharge/medicare-levy-surcharge-income-thresholds-and-rates
 *   ato.gov.au/individuals-and-families/medicare-and-private-health-insurance/
 *     private-health-insurance-rebate/income-thresholds-and-rates-for-the-
 *     private-health-insurance-rebate
 */

import { describe, it, expect } from 'vitest';
import {
  offsetSettingsFor,
  supportedOffsetYears,
  lowIncomeOffsetFor,
  saptoFor,
  surchargeThresholdsFor,
  privateHealthRebateFor,
  type FinancialYearOffsetSettings,
  type SurchargeTierKey,
} from './taxOffsets';
import { supportedTaxYears } from './taxRates';
import { emptyTaxProfile, type RebateAgeBand } from './taxProfile';

const YEARS = supportedOffsetYears();

function settings(fy: string): FinancialYearOffsetSettings {
  const s = offsetSettingsFor(fy);
  if (!s) throw new Error(`no offset settings for ${fy}`);
  return s;
}

function lito(fy: string, income: number): number {
  const o = settings(fy).lowIncomeOffsets.find(x => x.key === 'lito');
  return o ? lowIncomeOffsetFor(income, o) : 0;
}

function lmito(fy: string, income: number): number {
  const o = settings(fy).lowIncomeOffsets.find(x => x.key === 'lmito');
  return o ? lowIncomeOffsetFor(income, o) : 0;
}

// ─── ATO: the registry must cover the same years as the rate registry ────────

describe('the offset registry lines up with the rate registry', () => {
  it('covers exactly the financial years Ledger holds tax rates for', () => {
    // A year with brackets but no offsets would silently drop LITO from a real
    // estimate; a year with offsets but no brackets could never be reached.
    expect(YEARS).toEqual(supportedTaxYears());
  });

  it('never falls back to a neighbouring year', () => {
    expect(offsetSettingsFor('2015-2016')).toBeNull();
    expect(offsetSettingsFor('2019-2020')).toBeNull();
    expect(offsetSettingsFor('2028-2029')).toBeNull();
    expect(offsetSettingsFor('')).toBeNull();
    expect(offsetSettingsFor(null)).toBeNull();
  });

  it('labels every year with its own fy', () => {
    for (const fy of YEARS) expect(settings(fy).fy).toBe(fy);
  });
});

// ─── ATO: low income tax offset ──────────────────────────────────────────────
// "$37,500 or less, you will get the maximum offset of $700"
// "between $37,501 and $45,000, you will get $700 minus 5 cents for every $1
//  above $37,500"
// "between $45,001 and $66,667, you will get $325 minus 1.5 cents for every $1
//  above $45,000"

const ATO_LITO: [number, number][] = [
  [0, 700],
  [18200, 700],
  [37500, 700],
  [37501, 699.95],
  [40000, 575],       // 700 − 2,500 × 5c
  [45000, 325],       // 700 − 7,500 × 5c
  [45001, 324.985],   // 325 − 1 × 1.5c
  [50000, 250],       // 325 − 5,000 × 1.5c
  [66000, 10],        // 325 − 21,000 × 1.5c
  [66667, 0],         // the cut-out: the formula lands on nil to the half cent
  [66668, 0],
  [100000, 0],
];

describe('ATO: low income tax offset', () => {
  it.each(YEARS)('%s reproduces the published LITO table', fy => {
    for (const [income, expected] of ATO_LITO) {
      expect(lito(fy, income)).toBeCloseTo(expected, 2);
    }
  });

  it('is the same $700 offset in every year Ledger covers', () => {
    // LITO is not indexed — it has not moved since 2020-21 — so a year that
    // disagreed with its neighbours would be a transcription slip, not a change.
    const shapes = new Set(YEARS.map(fy => JSON.stringify(
      settings(fy).lowIncomeOffsets.find(o => o.key === 'lito'),
    )));
    expect(shapes.size).toBe(1);
  });
});

// ─── ATO: low and middle income tax offset ───────────────────────────────────
// 2018-19 to 2020-21: $255 / $255 + 7.5c above $37,000 / $1,080 / −3c above $90,000
// 2021-22 (with the one-off $420): $675 / $675 + 7.5c / $1,500 / −3c above $90,000

const ATO_LMITO_255: [number, number][] = [
  [0, 255], [37000, 255], [37001, 255.08], [40000, 480], [48000, 1080],  // 7.5c on one dollar, to the cent
  [70000, 1080], [90000, 1080], [100000, 780], [126000, 0], [126001, 0],
];

const ATO_LMITO_675: [number, number][] = [
  [0, 675], [37000, 675], [40000, 900], [48000, 1500], [90000, 1500],
  [100000, 1200], [126000, 420], [126001, 0],
];

describe('ATO: low and middle income tax offset', () => {
  it('2020-21 reproduces the $255 / $1,080 table', () => {
    for (const [income, expected] of ATO_LMITO_255) {
      expect(lmito('2020-2021', income)).toBeCloseTo(expected, 2);
    }
  });

  it('2021-22 reproduces the $675 / $1,500 table', () => {
    for (const [income, expected] of ATO_LMITO_675) {
      expect(lmito('2021-2022', income)).toBeCloseTo(expected, 2);
    }
  });

  it('2021-22 still pays $420 at exactly $126,000 and nothing above it', () => {
    // Not a slip. The one-off cost-of-living amount was $420 and was added
    // without moving the 3c taper, so it survives all the way to the cut-out and
    // then stops dead. Anyone "fixing" this cliff would be inventing a rule.
    expect(lmito('2021-2022', 126000)).toBe(420);
    expect(lmito('2021-2022', 126001)).toBe(0);
  });

  it('ended on 30 June 2022 and appears in no year after it', () => {
    expect(settings('2020-2021').lowIncomeOffsets.map(o => o.key)).toEqual(['lito', 'lmito']);
    expect(settings('2021-2022').lowIncomeOffsets.map(o => o.key)).toEqual(['lito', 'lmito']);
    for (const fy of YEARS.filter(y => y >= '2022-2023')) {
      expect(settings(fy).lowIncomeOffsets.map(o => o.key)).toEqual(['lito']);
    }
  });
});

// ─── ATO: seniors and pensioners tax offset ──────────────────────────────────
// 2012-13 to 2023-24 | Single $2,230 / $32,279 / $50,119
//                    | Couple $1,602 / $28,974 / $41,790
//                    | Illness-separated $2,040 / $31,279 / $47,599
// 2024-25 onwards    | Single $2,230 / $34,919 / $52,759
//                    | Couple $1,602 / $30,994 / $43,810
//                    | Illness-separated $2,040 / $33,732 / $50,052
// "The tax offset reduces by $0.125 for every dollar your rebate income exceeds
//  the relevant shading-out threshold amount. We round up the amount to the
//  nearest whole dollar."

const ATO_SAPTO: Record<string, Record<string, [number, number, number]>> = {
  'to-2023-24': {
    'single': [2230, 32279, 50119],
    'couple': [1602, 28974, 41790],
    'illness-separated': [2040, 31279, 47599],
  },
  'from-2024-25': {
    'single': [2230, 34919, 52759],
    'couple': [1602, 30994, 43810],
    'illness-separated': [2040, 33732, 50052],
  },
};

describe('ATO: seniors and pensioners tax offset', () => {
  it.each(YEARS)('%s carries the published maximums and thresholds', fy => {
    const table = ATO_SAPTO[fy <= '2023-2024' ? 'to-2023-24' : 'from-2024-25'];
    const s = settings(fy).sapto;
    expect(s.taperRate).toBe(0.125);
    for (const [status, [max, shade, cut]] of Object.entries(table)) {
      const row = s.byStatus[status as keyof typeof s.byStatus];
      expect([row.maxOffset, row.shadeOut, row.cutOut]).toEqual([max, shade, cut]);
    }
  });

  it.each(YEARS)('%s has a cut-out exactly the taper distance above the shade-out', fy => {
    // maxOffset ÷ 12.5c is how far the taper runs, so the two published columns
    // have to agree. They do for every ATO row, which is a real check on both.
    const s = settings(fy).sapto;
    for (const row of Object.values(s.byStatus)) {
      expect(row.shadeOut + row.maxOffset / s.taperRate).toBeCloseTo(row.cutOut, 2);
    }
  });

  // The ATO's own worked examples, on the 2024-25 onwards table.
  const sapto = (fy: string, status: 'single' | 'couple' | 'illness-separated', income: number, spouse = 0) =>
    saptoFor({ eligible: true, status, rebateIncome: income, spouseRebateIncome: spouse, settings: settings(fy) }).amount;

  it('reproduces "José": single, $39,000 rebate income, $1,720', () => {
    // $39,000 − $34,919 = $4,081; × 0.125 = $510.125; $2,230 − $510.125 =
    // $1,719.875, rounded UP to $1,720.
    expect(sapto('2024-2025', 'single', 39000)).toBe(1720);
  });

  it('reproduces "Simon": single, $32,178, the full $2,230', () => {
    expect(sapto('2024-2025', 'single', 32178)).toBe(2230);
  });

  it('reproduces "Marko": single, $85,690, nothing', () => {
    expect(sapto('2024-2025', 'single', 85690)).toBe(0);
  });

  it('reproduces "Keith and Jean": couple, $33,650 against a nil spouse, $1,270', () => {
    // Half the combined $33,650 is $16,825, under the $43,810 cut-out, so Keith
    // is entitled — but the TAPER runs on his own $33,650, not on the half.
    expect(sapto('2024-2025', 'couple', 33650, 0)).toBe(1270);
  });

  it('reproduces "Vanh and Mai": $1,403 and the full $1,602', () => {
    expect(sapto('2024-2025', 'couple', 32590, 26780)).toBe(1403);
    expect(sapto('2024-2025', 'couple', 26780, 32590)).toBe(1602);
  });

  it('reproduces "Ying and Li Jun": the couple qualifies, only one of them gets it', () => {
    // Half of $79,697 is $39,848.50, under the cut-out, so both are entitled;
    // Ying's own $54,020 tapers her to nothing while Li Jun keeps the maximum.
    expect(sapto('2024-2025', 'couple', 54020, 25677)).toBe(0);
    expect(sapto('2024-2025', 'couple', 25677, 54020)).toBe(1602);
  });

  it('reproduces "Deb and Ivan": combined too high, neither gets it', () => {
    // Half of $89,697 is $44,848.50, above the $43,810 cut-out.
    expect(sapto('2024-2025', 'couple', 64020, 25677)).toBe(0);
    expect(sapto('2024-2025', 'couple', 25677, 64020)).toBe(0);
  });
});

// ─── ATO: Medicare levy surcharge income thresholds and rates ────────────────
// Published per year, singles and families, with rates nil / 1% / 1.25% / 1.5%.

interface AtoSurchargeRow { single: [number, number, number]; family: [number, number, number] }

const ATO_SURCHARGE: Record<string, AtoSurchargeRow> = {
  // "2014–15 to 2022–23 Income thresholds"
  '2020-2021': { single: [90000, 105000, 140000], family: [180000, 210000, 280000] },
  '2021-2022': { single: [90000, 105000, 140000], family: [180000, 210000, 280000] },
  '2022-2023': { single: [90000, 105000, 140000], family: [180000, 210000, 280000] },
  '2023-2024': { single: [93000, 108000, 144000], family: [186000, 216000, 288000] },
  '2024-2025': { single: [97000, 113000, 151000], family: [194000, 226000, 302000] },
  '2025-2026': { single: [101000, 118000, 158000], family: [202000, 236000, 316000] },
  '2026-2027': { single: [105000, 123000, 164000], family: [210000, 246000, 328000] },
  // Not published yet — 2026-27 carried forward, with a note saying so.
  '2027-2028': { single: [105000, 123000, 164000], family: [210000, 246000, 328000] },
};

const ATO_SURCHARGE_RATES: [SurchargeTierKey, number][] = [
  ['base', 0], ['tier-1', 0.01], ['tier-2', 0.0125], ['tier-3', 0.015],
];

describe('ATO: Medicare levy surcharge thresholds', () => {
  it.each(YEARS)('%s reproduces the published single thresholds', fy => {
    const edges = surchargeThresholdsFor(settings(fy), { family: false, dependentChildren: 0 }).edges;
    const [base, t1, t2] = ATO_SURCHARGE[fy].single;
    expect(edges.map(e => e.to)).toEqual([base, t1, t2, null]);
  });

  it.each(YEARS)('%s reproduces the published FAMILY thresholds', fy => {
    // The registry stores the single edges and doubles them. These are the
    // family rows as the ATO prints them — an independent check on that rule.
    const edges = surchargeThresholdsFor(settings(fy), { family: true, dependentChildren: 0 }).edges;
    const [base, t1, t2] = ATO_SURCHARGE[fy].family;
    expect(edges.map(e => e.to)).toEqual([base, t1, t2, null]);
  });

  it.each(YEARS)('%s charges nil, 1%%, 1.25%% and 1.5%%', fy => {
    expect(settings(fy).surcharge.tiers.map(t => [t.key, t.rate])).toEqual(ATO_SURCHARGE_RATES);
  });

  it.each(YEARS)('%s lifts the family threshold by $1,500 per child after the first', fy => {
    const s = settings(fy);
    expect(s.surcharge.perChildIncrease).toBe(1500);
    const one = surchargeThresholdsFor(s, { family: true, dependentChildren: 1 });
    const three = surchargeThresholdsFor(s, { family: true, dependentChildren: 3 });
    expect(one.baseThreshold).toBe(ATO_SURCHARGE[fy].family[0]);
    expect(three.baseThreshold).toBe(ATO_SURCHARGE[fy].family[0] + 3000);
  });
});

// ─── ATO: private health insurance rebate percentages ────────────────────────
// One grid per period, columns base tier / tier 1 / tier 2 (tier 3 is nil),
// rows under 65 / 65–69 / 70 or over.

type Grid = Record<RebateAgeBand, [number, number, number]>;

const G_25_059: Grid = {
  'under-65': [25.059, 16.706, 8.352],
  '65-69': [29.236, 20.883, 12.529],
  '70-plus': [33.413, 25.059, 16.706],
};
const G_24_608: Grid = {
  'under-65': [24.608, 16.405, 8.202],
  '65-69': [28.710, 20.507, 12.303],
  '70-plus': [32.812, 24.608, 16.405],
};
const G_24_288: Grid = {
  'under-65': [24.288, 16.192, 8.095],
  '65-69': [28.337, 20.240, 12.143],
  '70-plus': [32.385, 24.288, 16.192],
};
const G_24_118: Grid = {
  'under-65': [24.118, 16.079, 8.038],
  '65-69': [28.139, 20.098, 12.058],
  '70-plus': [32.158, 24.118, 16.079],
};

const ATO_REBATE: Record<string, [Grid, Grid]> = {
  '2020-2021': [G_25_059, G_24_608],  // the 1 April 2021 adjustment
  '2021-2022': [G_24_608, G_24_608],
  '2022-2023': [G_24_608, G_24_608],
  '2023-2024': [G_24_608, G_24_608],
  '2024-2025': [G_24_608, G_24_288],  // the 1 April 2025 adjustment
  '2025-2026': [G_24_288, G_24_118],  // the 1 April 2026 adjustment
  '2026-2027': [G_24_118, G_24_118],  // April 2027 not published — carried
  '2027-2028': [G_24_118, G_24_118],  // neither period published — carried
};

const AGE_BANDS: RebateAgeBand[] = ['under-65', '65-69', '70-plus'];
const TIERS: SurchargeTierKey[] = ['base', 'tier-1', 'tier-2'];

describe('ATO: private health insurance rebate percentages', () => {
  it.each(YEARS)('%s reproduces both published rebate grids', fy => {
    const s = settings(fy);
    const [first, second] = ATO_REBATE[fy];
    expect(s.rebatePeriods).toHaveLength(2);
    for (const band of AGE_BANDS) {
      expect(s.rebatePeriods[0].grid[band]).toEqual(first[band]);
      expect(s.rebatePeriods[1].grid[band]).toEqual(second[band]);
    }
  });

  it.each(YEARS)('%s labels its periods with the 1 April split', fy => {
    const startYear = Number(fy.split('-')[0]);
    const [a, b] = settings(fy).rebatePeriods;
    expect(a.label).toBe(`1 July ${startYear} – 31 March ${startYear + 1}`);
    expect(b.label).toBe(`1 April ${startYear + 1} – 30 June ${startYear + 1}`);
  });

  it.each(YEARS)('%s pays no rebate at all in tier 3', fy => {
    const profile = {
      ...emptyTaxProfile(),
      premiumsFirstPeriod: 2000,
      premiumsSecondPeriod: 700,
      healthAgeBand: '70-plus' as RebateAgeBand,
    };
    const r = privateHealthRebateFor({ settings: settings(fy), tier: 'tier-3', profile });
    expect(r.entitled).toBe(0);
    expect(r.periods.every(p => p.percentage === 0)).toBe(true);
  });

  it.each(TIERS)('applies the published percentage for tier %s', tier => {
    // 2024-25: $3,000 of premiums in the first period, under 65.
    const profile = { ...emptyTaxProfile(), premiumsFirstPeriod: 3000 };
    const r = privateHealthRebateFor({ settings: settings('2024-2025'), tier, profile });
    const pct = G_24_608['under-65'][TIERS.indexOf(tier)];
    expect(r.periods[0].percentage).toBe(pct);
    expect(r.entitled).toBeCloseTo((3000 * pct) / 100, 2);
  });

  it('splits a year across the 1 April change — 2024-25 base tier, under 65', () => {
    // The whole reason a private health statement has two rows.
    const profile = {
      ...emptyTaxProfile(),
      premiumsFirstPeriod: 1500,   // at 24.608%
      premiumsSecondPeriod: 500,   // at 24.288%
    };
    const r = privateHealthRebateFor({ settings: settings('2024-2025'), tier: 'base', profile });
    expect(r.periods[0].entitled).toBeCloseTo(369.12, 2);
    expect(r.periods[1].entitled).toBeCloseTo(121.44, 2);
    expect(r.entitled).toBeCloseTo(490.56, 2);
  });

  it('marks the periods the ATO has not published yet', () => {
    // 2025-26 is fully published; 2026-27's April rate and both of 2027-28's are
    // carried forward, and the UI has to be able to say so.
    expect(settings('2025-2026').rebatePeriods.map(p => p.provisional === true)).toEqual([false, false]);
    expect(settings('2026-2027').rebatePeriods.map(p => p.provisional === true)).toEqual([false, true]);
    expect(settings('2027-2028').rebatePeriods.map(p => p.provisional === true)).toEqual([true, true]);
  });
});

// ─── Provenance: a carried-forward figure must say so ────────────────────────

describe('a year that borrows a figure says which one', () => {
  it('marks 2026-27 and 2027-28 as estimates and settles every earlier year', () => {
    for (const fy of YEARS.filter(y => y <= '2025-2026')) {
      expect(settings(fy).confidence).toBe('legislated');
    }
    expect(settings('2026-2027').confidence).toBe('indexed-estimate');
    expect(settings('2027-2028').confidence).toBe('indexed-estimate');
  });

  it('never leaves an indexed-estimate year without a note', () => {
    for (const fy of YEARS) {
      if (settings(fy).confidence === 'indexed-estimate') {
        expect(settings(fy).notes.length).toBeGreaterThan(0);
      }
    }
  });

  it('names the surcharge thresholds as carried in 2027-28 and not in 2026-27', () => {
    // 2026-27's thresholds ARE published; only its April rebate rate is not.
    expect(settings('2026-2027').notes.join(' ')).not.toMatch(/surcharge thresholds/i);
    expect(settings('2027-2028').notes.join(' ')).toMatch(/surcharge thresholds/i);
  });

  it('tells 2021-22 apart with its own two LMITO notes', () => {
    const notes = settings('2021-2022').notes.join(' ');
    expect(notes).toMatch(/\$420/);
    expect(notes).toMatch(/30 June 2022/);
  });
});
