/**
 * Phase 5.4 — the capital-gains engine.
 *
 * The arithmetic is checked against the ATO's own worked examples where they
 * exist ("How to calculate your CGT", QC 104071), and against the rules where
 * they don't. The cases that matter most are the ones a spreadsheet gets wrong:
 * a partial sale out of several parcels bought at different times, the order
 * losses are applied in, and the exact day the 50% discount starts.
 */

import { describe, it, expect } from 'vitest';
import {
  anniversaryOf,
  assetKeyOf,
  buildCapitalGains,
  buildCapitalGainsPosition,
  cgtAssetClassOf,
  daysHeld,
  matchDisposals,
  ownedTwelveMonths,
  type CgtDisposal,
  type CgtParcel,
} from './capitalGains';

const parcel = (o: Partial<CgtParcel> & { id: string }): CgtParcel => ({
  investmentId: null,
  label: 'Commonwealth Bank',
  ticker: 'CBA',
  assetType: 'stock',
  quantity: 100,
  costBase: 1_000,
  acquiredDate: '2020-01-01',
  ...o,
});

const disposal = (o: Partial<CgtDisposal> & { id: string }): CgtDisposal => ({
  investmentId: null,
  label: 'Commonwealth Bank',
  ticker: 'CBA',
  assetType: 'stock',
  quantity: 100,
  proceeds: 2_000,
  fees: 0,
  costBase: 0,
  acquiredDate: null,
  saleDate: '2024-09-01',
  currency: 'AUD',
  parcelIds: null,
  ...o,
});

/** The one call the app makes. */
const build = (
  fy: string,
  disposals: CgtDisposal[],
  parcels: CgtParcel[] = [],
  opening?: { fy: string; ordinary: number; collectable: number },
) => buildCapitalGains({ fy, disposals, parcels, opening: opening ?? null });

// ─── The twelve-month test ───────────────────────────────────────────────────

describe('the CGT discount starts twelve months AND A DAY after acquisition', () => {
  it('takes the anniversary, not a day count', () => {
    expect(anniversaryOf('2023-07-01')).toBe('2024-07-01');
    expect(anniversaryOf('2024-03-15')).toBe('2025-03-15');
  });

  it('clamps 29 February to 28 February — a leap day has no anniversary', () => {
    expect(anniversaryOf('2024-02-29')).toBe('2025-02-28');
    // …and four years on it exists again.
    expect(anniversaryOf('2024-02-29', 4)).toBe('2028-02-29');
  });

  it('refuses the anniversary itself and allows the day after', () => {
    expect(ownedTwelveMonths('2024-07-01', '2025-07-01')).toBe(false);
    expect(ownedTwelveMonths('2024-07-01', '2025-07-02')).toBe(true);
  });

  it('is not fooled by a leap year, which a 365-day count is', () => {
    // 1 Jul 2023 → 1 Jul 2024 is 366 days, and is still not twelve months and a
    // day. The old `heldDays > 365` rule granted the discount here.
    expect(daysHeld('2023-07-01', '2024-07-01')).toBe(366);
    expect(ownedTwelveMonths('2023-07-01', '2024-07-01')).toBe(false);
    expect(ownedTwelveMonths('2023-07-01', '2024-07-02')).toBe(true);
  });

  it('handles the leap-day anniversary the same way', () => {
    expect(ownedTwelveMonths('2024-02-29', '2025-02-28')).toBe(false);
    expect(ownedTwelveMonths('2024-02-29', '2025-03-01')).toBe(true);
  });

  it('says "unknown", not "no", when there is no acquisition date', () => {
    expect(ownedTwelveMonths(null, '2025-07-02')).toBeNull();
    expect(daysHeld(null, '2025-07-02')).toBeNull();
  });
});

// ─── Asset classes ───────────────────────────────────────────────────────────

describe('collectables are the ATO\'s list, not everything unusual', () => {
  it.each([
    ['art', 'collectable'],
    ['wine', 'collectable'],
    ['jewellery', 'collectable'],
    ['stock', 'ordinary'],
    ['crypto', 'ordinary'],
    // Bullion is bought for its metal content, not as a collection.
    ['precious_metal', 'ordinary'],
    [null, 'ordinary'],
  ])('%s is %s', (type, expected) => {
    expect(cgtAssetClassOf(type as string | null)).toBe(expected);
  });
});

describe('an asset key never merges two different holdings', () => {
  it('prefers the holding id, then the ticker, then the name', () => {
    expect(assetKeyOf({ investmentId: 'inv-1', ticker: 'CBA', label: 'CBA' })).toBe('inv:inv-1');
    expect(assetKeyOf({ investmentId: null, ticker: 'cba', label: 'Anything' })).toBe('tkr:CBA');
    expect(assetKeyOf({ investmentId: null, ticker: null, label: 'Rare Coin' })).toBe('nam:rare coin');
  });
});

// ─── The ATO's own worked examples ───────────────────────────────────────────

describe("the ATO's worked examples reproduce exactly", () => {
  it('Rhi: a single asset, $70,000 gain, $35,000 net capital gain', () => {
    // Bought for $500,000 + $16,200 of purchase costs, sold for $600,000 less
    // $13,800 of sale costs. The ATO puts sale costs in the cost base; Ledger
    // takes them off the proceeds, which is the same subtraction.
    const p = build('2025-2026', [
      disposal({
        id: 'd1', label: 'Investment property', ticker: null, assetType: 'other',
        quantity: 1, proceeds: 600_000, fees: 13_800, saleDate: '2026-06-04',
      }),
    ], [
      parcel({
        id: 'p1', label: 'Investment property', ticker: null, assetType: 'other',
        quantity: 1, costBase: 516_200, acquiredDate: '2021-06-04',
      }),
    ]);
    expect(p.grossGainsTotal).toBe(70_000);
    expect(p.discount).toBe(35_000);
    expect(p.netCapitalGain).toBe(35_000);
  });

  it('Rhi again, plus a $4,500 share loss: $32,750', () => {
    const p = build('2025-2026', [
      disposal({
        id: 'd1', label: 'Investment property', ticker: null, assetType: 'other',
        quantity: 1, proceeds: 600_000, fees: 13_800, saleDate: '2026-06-04',
      }),
      disposal({
        id: 'd2', label: 'Shares', ticker: 'ABC', quantity: 1_000,
        proceeds: 5_500, fees: 0, saleDate: '2026-05-01',
      }),
    ], [
      parcel({
        id: 'p1', label: 'Investment property', ticker: null, assetType: 'other',
        quantity: 1, costBase: 516_200, acquiredDate: '2021-06-04',
      }),
      parcel({ id: 'p2', label: 'Shares', ticker: 'ABC', quantity: 1_000, costBase: 10_000, acquiredDate: '2024-01-01' }),
    ]);
    expect(p.currentYearLosses.ordinary).toBe(4_500);
    expect(p.gainsAfterLossesTotal).toBe(65_500);
    expect(p.discount).toBe(32_750);
    expect(p.netCapitalGain).toBe(32_750);
  });
});

// ─── Parcels and partial sales ───────────────────────────────────────────────

describe('a partial sale takes cost out of the parcel, not off an average', () => {
  it('40 of 100 units takes 40% of the parcel cost and leaves the rest', () => {
    const p = build('2024-2025',
      [disposal({ id: 'd1', quantity: 40, proceeds: 800 })],
      [parcel({ id: 'p1', quantity: 100, costBase: 1_000, acquiredDate: '2020-01-01' })],
    );
    const [event] = p.events;
    expect(event.allocations).toHaveLength(1);
    expect(event.allocations[0].costBase).toBe(400);
    expect(event.gain).toBe(400);
    expect(p.netCapitalGain).toBe(200); // discounted
    expect(p.remainders).toEqual([
      { parcelId: 'p1', quantityRemaining: 60, costBaseRemaining: 600, quantitySold: 40 },
    ]);
  });

  it('two sales out of one parcel consume it once, not twice', () => {
    const p = build('2024-2025', [
      disposal({ id: 'd1', quantity: 60, proceeds: 900, saleDate: '2024-08-01' }),
      disposal({ id: 'd2', quantity: 40, proceeds: 700, saleDate: '2025-02-01' }),
    ], [parcel({ id: 'p1', quantity: 100, costBase: 1_000, acquiredDate: '2020-01-01' })]);
    expect(p.remainders[0].quantityRemaining).toBe(0);
    expect(p.remainders[0].costBaseRemaining).toBe(0);
    // 900 − 600 = 300, and 700 − 400 = 300.
    expect(p.grossGainsTotal).toBe(600);
    expect(p.netCapitalGain).toBe(300);
  });
});

describe('a sale spanning several parcels is several CGT outcomes', () => {
  const parcels = [
    parcel({ id: 'old', quantity: 50, costBase: 500, acquiredDate: '2022-01-01' }),
    parcel({ id: 'new', quantity: 50, costBase: 900, acquiredDate: '2024-06-01' }),
  ];

  it('goes oldest first and discounts only the half that earned it', () => {
    const p = build('2024-2025',
      [disposal({ id: 'd1', quantity: 80, proceeds: 1_600, saleDate: '2024-09-01' })],
      parcels,
    );
    const [event] = p.events;
    expect(event.allocations.map(a => [a.parcelId, a.quantity, a.costBase, a.proceeds, a.discountEligible]))
      .toEqual([
        ['old', 50, 500, 1_000, true],
        ['new', 30, 540, 600, false],
      ]);
    expect(p.grossGains.discount).toBe(500);
    expect(p.grossGains.other).toBe(60);
    expect(p.discount).toBe(250);
    expect(p.netCapitalGain).toBe(310);
  });

  it('respects a parcel the user nominated instead', () => {
    const p = build('2024-2025',
      [disposal({ id: 'd1', quantity: 50, proceeds: 1_000, saleDate: '2024-09-01', parcelIds: ['new'] })],
      parcels,
    );
    const [event] = p.events;
    expect(event.allocations[0].parcelId).toBe('new');
    expect(event.allocations[0].costBase).toBe(900);
    expect(event.allocations[0].discountEligible).toBe(false);
    expect(p.netCapitalGain).toBe(100);
  });

  it('cannot sell a parcel bought after the sale date', () => {
    const p = build('2023-2024',
      [disposal({ id: 'd1', quantity: 50, proceeds: 1_000, costBase: 400, saleDate: '2023-09-01' })],
      // Both parcels here post-date the sale, so neither can be drawn on.
      [parcel({ id: 'later', quantity: 50, costBase: 900, acquiredDate: '2024-06-01' })],
    );
    expect(p.events[0].allocations[0].source).toBe('recorded');
    expect(p.events[0].allocations[0].costBase).toBe(400);
    expect(p.events[0].hadParcels).toBe(false);
  });

  it('leaves an undated parcel until last, so a datable one can be discounted', () => {
    const p = build('2024-2025',
      [disposal({ id: 'd1', quantity: 50, proceeds: 1_000, saleDate: '2024-09-01' })],
      [
        parcel({ id: 'undated', quantity: 50, costBase: 500, acquiredDate: null }),
        parcel({ id: 'dated', quantity: 50, costBase: 500, acquiredDate: '2021-01-01' }),
      ],
    );
    expect(p.events[0].allocations[0].parcelId).toBe('dated');
    expect(p.netCapitalGain).toBe(250);
  });

  it('apportions proceeds so the parts always add back to the whole', () => {
    const p = build('2024-2025',
      [disposal({ id: 'd1', quantity: 3, proceeds: 1_000, saleDate: '2024-09-01' })],
      [
        parcel({ id: 'a', quantity: 1, costBase: 100, acquiredDate: '2020-01-01' }),
        parcel({ id: 'b', quantity: 1, costBase: 100, acquiredDate: '2020-02-01' }),
        parcel({ id: 'c', quantity: 1, costBase: 100, acquiredDate: '2020-03-01' }),
      ],
    );
    const parts = p.events[0].allocations.map(a => a.proceeds);
    expect(parts).toEqual([333.33, 333.33, 333.34]);
    expect(parts.reduce((s, x) => s + x, 0)).toBeCloseTo(1_000, 10);
  });
});

describe('what happens when the parcels do not cover the sale', () => {
  it('falls back to the cost base recorded on the sale itself', () => {
    const p = build('2024-2025',
      [disposal({ id: 'd1', quantity: 100, proceeds: 2_000, costBase: 1_200, acquiredDate: '2020-01-01' })],
      [],
    );
    expect(p.events[0].allocations[0].source).toBe('recorded');
    expect(p.netCapitalGain).toBe(400); // (2000 − 1200) discounted
    expect(p.warnings.map(w => w.kind)).toContain('unparcelled-units');
  });

  it('says so loudly when more units were sold than were ever bought', () => {
    const p = build('2024-2025',
      [disposal({ id: 'd1', quantity: 80, proceeds: 1_600, costBase: 800, acquiredDate: '2020-01-01' })],
      [parcel({ id: 'p1', quantity: 50, costBase: 500, acquiredDate: '2020-01-01' })],
    );
    const [event] = p.events;
    expect(event.hadParcels).toBe(true);
    expect(event.unparcelledQuantity).toBe(30);
    // 30 of the 80 units, so 30/80 of the recorded cost base.
    expect(event.allocations[1].costBase).toBe(300);
    const over = p.warnings.find(w => w.kind === 'over-disposed');
    expect(over?.severity).toBe('warn');
  });

  it('taxes the whole proceeds when there is no cost base anywhere, and says so', () => {
    const p = build('2024-2025', [disposal({ id: 'd1', proceeds: 2_000, costBase: 0 })], []);
    expect(p.events[0].allocations[0].source).toBe('unmatched');
    expect(p.grossGainsTotal).toBe(2_000);
    const w = p.warnings.find(x => x.kind === 'cost-base-missing');
    expect(w?.amount).toBe(2_000);
    expect(w?.severity).toBe('warn');
  });

  it('refuses the discount without an acquisition date, and names what it cost', () => {
    const p = build('2024-2025',
      [disposal({ id: 'd1', proceeds: 2_000, costBase: 1_000, acquiredDate: null })],
      [],
    );
    expect(p.grossGains.discount).toBe(0);
    expect(p.grossGains.other).toBe(1_000);
    expect(p.netCapitalGain).toBe(1_000);
    const w = p.warnings.find(x => x.kind === 'acquisition-date-missing');
    expect(w?.amount).toBe(1_000);
  });
});

// ─── Losses ──────────────────────────────────────────────────────────────────

describe('losses go against the gains that are not discounted first', () => {
  const parcels = [
    parcel({ id: 'old', quantity: 50, costBase: 500, acquiredDate: '2022-01-01' }),
    parcel({ id: 'new', quantity: 50, costBase: 900, acquiredDate: '2024-06-01' }),
    parcel({ id: 'bhp', ticker: 'BHP', label: 'BHP', quantity: 10, costBase: 1_000, acquiredDate: '2020-01-01' }),
  ];
  const disposals = [
    disposal({ id: 'd1', quantity: 80, proceeds: 1_600, saleDate: '2024-09-01' }),
    disposal({ id: 'd2', ticker: 'BHP', label: 'BHP', quantity: 10, proceeds: 700, saleDate: '2024-10-01' }),
  ];

  it('spends the loss where a dollar saves a whole dollar', () => {
    const p = build('2024-2025', disposals, parcels);
    expect(p.currentYearLosses.ordinary).toBe(300);
    // $60 of undiscounted gain absorbed first, then $240 off the discounted gain.
    expect(p.lossApplications.map(l => [l.against, l.amount])).toEqual([
      ['other', 60],
      ['discount', 240],
    ]);
    expect(p.gainsAfterLosses.other).toBe(0);
    expect(p.gainsAfterLosses.discount).toBe(260);
    expect(p.netCapitalGain).toBe(130);
  });

  it('is worse the other way round, which is why the order is not arbitrary', () => {
    // Discount-first would leave 60 undiscounted + (500−300)/2 = 160.
    const p = build('2024-2025', disposals, parcels);
    expect(p.netCapitalGain).toBeLessThan(160);
  });

  it('carries the unused part forward and assesses nothing', () => {
    const p = build('2024-2025', [
      disposal({ id: 'd2', ticker: 'BHP', label: 'BHP', quantity: 10, proceeds: 200, saleDate: '2024-10-01' }),
    ], [parcel({ id: 'bhp', ticker: 'BHP', label: 'BHP', quantity: 10, costBase: 1_000, acquiredDate: '2020-01-01' })]);
    expect(p.netCapitalGain).toBe(0);
    expect(p.carriedForward.ordinary).toBe(800);
    expect(p.warnings.map(w => w.kind)).toContain('net-capital-loss');
  });
});

describe('collectable losses are quarantined; ordinary losses are not', () => {
  it('a loss on art cannot touch a gain on shares', () => {
    const p = build('2024-2025', [
      disposal({ id: 'art', label: 'Painting', ticker: null, assetType: 'art', quantity: 1, proceeds: 3_000, saleDate: '2024-09-01' }),
      disposal({ id: 'shares', quantity: 100, proceeds: 3_000, saleDate: '2024-09-01' }),
    ], [
      parcel({ id: 'pa', label: 'Painting', ticker: null, assetType: 'art', quantity: 1, costBase: 5_000, acquiredDate: '2020-01-01' }),
      parcel({ id: 'ps', quantity: 100, costBase: 1_000, acquiredDate: '2020-01-01' }),
    ]);
    expect(p.currentYearLosses.collectable).toBe(2_000);
    expect(p.currentYearLosses.ordinary).toBe(0);
    expect(p.lossApplications).toEqual([]);
    expect(p.netCapitalGain).toBe(1_000); // 2,000 gain, halved
    expect(p.carriedForward).toEqual({ ordinary: 0, collectable: 2_000 });
    expect(p.warnings.map(w => w.kind)).toContain('collectable-loss-quarantined');
  });

  it('a loss on shares CAN reduce a gain on art — the rule is one-way', () => {
    const p = build('2024-2025', [
      disposal({ id: 'art', label: 'Painting', ticker: null, assetType: 'art', quantity: 1, proceeds: 3_000, saleDate: '2024-09-01' }),
      disposal({ id: 'shares', quantity: 100, proceeds: 500, saleDate: '2024-09-01' }),
    ], [
      parcel({ id: 'pa', label: 'Painting', ticker: null, assetType: 'art', quantity: 1, costBase: 1_000, acquiredDate: '2020-01-01' }),
      parcel({ id: 'ps', quantity: 100, costBase: 1_000, acquiredDate: '2020-01-01' }),
    ]);
    expect(p.grossGains['collectable-discount']).toBe(2_000);
    expect(p.currentYearLosses.ordinary).toBe(500);
    expect(p.lossApplications).toEqual([
      { key: 'ordinary:current-year:collectable-discount', pool: 'ordinary', source: 'current-year', against: 'collectable-discount', amount: 500 },
    ]);
    expect(p.netCapitalGain).toBe(750);
  });

  it('ignores a collectable acquired for $500 or less, gain and all', () => {
    const p = build('2024-2025', [
      disposal({ id: 'w', label: 'Vintage bottle', ticker: null, assetType: 'wine', quantity: 1, proceeds: 1_200, saleDate: '2024-09-01' }),
    ], [
      parcel({ id: 'pw', label: 'Vintage bottle', ticker: null, assetType: 'wine', quantity: 1, costBase: 400, acquiredDate: '2020-01-01' }),
    ]);
    expect(p.events[0].allocations[0].exempt).toBe(true);
    expect(p.grossGainsTotal).toBe(0);
    expect(p.netCapitalGain).toBe(0);
    expect(p.warnings.map(w => w.kind)).toContain('collectable-exempt');
  });

  it('does not ignore one that cost more than $500', () => {
    const p = build('2024-2025', [
      disposal({ id: 'w', label: 'Vintage bottle', ticker: null, assetType: 'wine', quantity: 1, proceeds: 1_200, saleDate: '2024-09-01' }),
    ], [
      parcel({ id: 'pw', label: 'Vintage bottle', ticker: null, assetType: 'wine', quantity: 1, costBase: 501, acquiredDate: '2020-01-01' }),
    ]);
    expect(p.events[0].allocations[0].exempt).toBe(false);
    expect(p.netCapitalGain).toBe(349.5);
  });
});

// ─── Carrying losses forward ─────────────────────────────────────────────────

describe('a capital loss carries forward indefinitely, and never backwards', () => {
  const parcels = [
    parcel({ id: 'p22', ticker: 'AAA', label: 'AAA', quantity: 10, costBase: 6_000, acquiredDate: '2019-01-01' }),
    parcel({ id: 'p23', ticker: 'BBB', label: 'BBB', quantity: 10, costBase: 1_000, acquiredDate: '2023-05-01' }),
    parcel({ id: 'p24', ticker: 'CCC', label: 'CCC', quantity: 10, costBase: 5_000, acquiredDate: '2019-01-01' }),
  ];
  const disposals = [
    // FY 2022-23: a $5,000 loss.
    disposal({ id: 'l', ticker: 'AAA', label: 'AAA', quantity: 10, proceeds: 1_000, saleDate: '2022-09-01' }),
    // FY 2023-24: a $2,000 gain, held under twelve months.
    disposal({ id: 'g1', ticker: 'BBB', label: 'BBB', quantity: 10, proceeds: 3_000, saleDate: '2024-01-01' }),
    // FY 2024-25: a $10,000 gain, well over twelve months.
    disposal({ id: 'g2', ticker: 'CCC', label: 'CCC', quantity: 10, proceeds: 15_000, saleDate: '2024-09-01' }),
  ];

  it('the year of the loss assesses nothing and carries all of it', () => {
    const p = build('2022-2023', disposals, parcels);
    expect(p.netCapitalGain).toBe(0);
    expect(p.carriedForward.ordinary).toBe(5_000);
  });

  it('the next year spends what it can and carries the rest', () => {
    const p = build('2023-2024', disposals, parcels);
    expect(p.broughtForward.ordinary).toBe(5_000);
    expect(p.netCapitalGain).toBe(0);
    expect(p.carriedForward.ordinary).toBe(3_000);
  });

  it('the year after that spends the remainder BEFORE the discount', () => {
    const p = build('2024-2025', disposals, parcels);
    expect(p.broughtForward.ordinary).toBe(3_000);
    // 10,000 − 3,000 = 7,000, halved.
    expect(p.gainsAfterLossesTotal).toBe(7_000);
    expect(p.netCapitalGain).toBe(3_500);
    expect(p.carriedForwardTotal).toBe(0);
    expect(p.warnings.map(w => w.kind)).toContain('brought-forward-applied');
  });

  it('applying the loss before the discount is worth more than after it', () => {
    // After the discount it would be 5,000 − 3,000 = 2,000. The ATO's order is
    // not a formality.
    expect(build('2024-2025', disposals, parcels).netCapitalGain).toBe(3_500);
  });

  it('an opening figure off a lodged return starts the chain', () => {
    const p = build('2024-2025',
      [disposal({ id: 'g2', ticker: 'CCC', label: 'CCC', quantity: 10, proceeds: 15_000, saleDate: '2024-09-01' })],
      [parcel({ id: 'p24', ticker: 'CCC', label: 'CCC', quantity: 10, costBase: 5_000, acquiredDate: '2019-01-01' })],
      { fy: '2024-2025', ordinary: 4_000, collectable: 0 },
    );
    expect(p.broughtForward.ordinary).toBe(4_000);
    expect(p.netCapitalGain).toBe(3_000);
  });

  it('never reaches a year BEFORE the one it was measured at', () => {
    const p = build('2022-2023', disposals, parcels, { fy: '2024-2025', ordinary: 4_000, collectable: 0 });
    expect(p.broughtForward.ordinary).toBe(0);
  });

  it('keeps the collectable pool separate all the way through', () => {
    const p = build('2024-2025',
      [disposal({ id: 'art', label: 'Painting', ticker: null, assetType: 'art', quantity: 1, proceeds: 9_000, saleDate: '2024-09-01' })],
      [parcel({ id: 'pa', label: 'Painting', ticker: null, assetType: 'art', quantity: 1, costBase: 1_000, acquiredDate: '2019-01-01' })],
      { fy: '2024-2025', ordinary: 0, collectable: 2_000 },
    );
    expect(p.broughtForward.collectable).toBe(2_000);
    // 8,000 − 2,000 = 6,000, halved.
    expect(p.netCapitalGain).toBe(3_000);
  });
});

// ─── Financial-year boundaries ───────────────────────────────────────────────

describe('a disposal lands in the year of the CGT event, to the day', () => {
  const parcels = [parcel({ id: 'p1', quantity: 100, costBase: 1_000, acquiredDate: '2020-01-01' })];

  it('30 June is the old year and 1 July is the new one', () => {
    const june = build('2023-2024', [disposal({ id: 'd', proceeds: 2_000, saleDate: '2024-06-30' })], parcels);
    expect(june.events).toHaveLength(1);
    expect(june.netCapitalGain).toBe(500);

    const july = build('2023-2024', [disposal({ id: 'd', proceeds: 2_000, saleDate: '2024-07-01' })], parcels);
    expect(july.events).toHaveLength(0);
    expect(july.netCapitalGain).toBe(0);
  });

  it('reads the date as a string, so no time zone can move it', () => {
    const p = build('2024-2025', [disposal({ id: 'd', proceeds: 2_000, saleDate: '2024-07-01T23:30:00+10:00' })], parcels);
    expect(p.events[0].saleDate).toBe('2024-07-01');
    expect(p.events[0].fy).toBe('2024-2025');
  });

  it('ignores a disposal with no date rather than guessing a year for it', () => {
    const p = build('2024-2025', [disposal({ id: 'd', saleDate: '' })], parcels);
    expect(p.events).toHaveLength(0);
  });

  it('does not let a later year eat a parcel an earlier year already sold', () => {
    const { events } = matchDisposals({
      parcels: [parcel({ id: 'p1', quantity: 100, costBase: 1_000, acquiredDate: '2020-01-01' })],
      disposals: [
        disposal({ id: 'first', quantity: 100, proceeds: 2_000, saleDate: '2023-09-01' }),
        disposal({ id: 'second', quantity: 100, proceeds: 3_000, costBase: 0, saleDate: '2024-09-01' }),
      ],
    });
    expect(events[0].allocations[0].source).toBe('parcel');
    // The parcel is gone, so the second sale has nothing to cost against.
    expect(events[1].allocations[0].source).toBe('unmatched');
  });
});

// ─── Housekeeping ────────────────────────────────────────────────────────────

describe('the position holds together whatever it is given', () => {
  it('is all zeros for a year with nothing in it', () => {
    const p = build('2024-2025', [], []);
    expect(p.netCapitalGain).toBe(0);
    expect(p.proceeds).toBe(0);
    expect(p.carriedForwardTotal).toBe(0);
    expect(p.events).toEqual([]);
  });

  it('always states what it does not model', () => {
    expect(build('2024-2025', [], []).notes.join(' ')).toMatch(/main-residence exemption/);
  });

  it('says announced changes exist for 2026-27 onwards, and applies none of them', () => {
    expect(build('2025-2026', [], []).warnings.map(w => w.kind)).not.toContain('announced-changes');
    const later = build('2026-2027', [], []);
    expect(later.warnings.map(w => w.kind)).toContain('announced-changes');
    expect(later.notes.join(' ')).toMatch(/2026–27 Federal Budget/);
  });

  it('warns when disposals in different currencies were added together', () => {
    const p = build('2024-2025', [
      disposal({ id: 'a', currency: 'AUD', saleDate: '2024-09-01' }),
      disposal({ id: 'b', ticker: 'AAPL', label: 'Apple', currency: 'USD', saleDate: '2024-10-01' }),
    ], []);
    expect(p.warnings.map(w => w.kind)).toContain('mixed-currency');
  });

  /**
   * FINDING (Low) — FIXED. The check counted DISTINCT currencies among the
   * disposals, which could never fire from Ledger's own Sell dialog (it stamps
   * one currency on everything) and stayed silent in the case that matters: a
   * whole year of US-dollar figures added into an Australian-dollar return.
   * Two rows agreeing with each other says nothing about whether they agree with
   * the total they are going into. It is now measured against the currency the
   * year is REPORTED in.
   */
  it('catches a whole year recorded in the wrong currency, not just a disagreement', () => {
    const usdOnly = [
      disposal({ id: 'a', currency: 'USD', saleDate: '2024-09-01' }),
      disposal({ id: 'b', currency: 'USD', saleDate: '2024-10-01' }),
    ];
    // The old check: one distinct currency, so nothing to say.
    expect(build('2024-2025', usdOnly, []).warnings.map(w => w.kind)).not.toContain('mixed-currency');
    // Told what the return is in, the same rows are obviously wrong.
    const p = buildCapitalGains({
      fy: '2024-2025', disposals: usdOnly, parcels: [], reportingCurrency: 'AUD',
    });
    const w = p.warnings.find(x => x.kind === 'mixed-currency');
    expect(w?.count).toBe(1);
    expect(w?.message).toContain('USD');
    expect(w?.message).toContain('AUD total');
  });

  it('says nothing when every disposal is in the currency being reported', () => {
    const p = buildCapitalGains({
      fy: '2024-2025',
      disposals: [disposal({ id: 'a', currency: 'AUD' }), disposal({ id: 'b', currency: 'aud' })],
      parcels: [],
      reportingCurrency: 'AUD',
    });
    expect(p.warnings.map(w => w.kind)).not.toContain('mixed-currency');
  });

  it('names every off-currency it found, once each', () => {
    const p = buildCapitalGains({
      fy: '2024-2025',
      disposals: [
        disposal({ id: 'a', currency: 'AUD' }),
        disposal({ id: 'b', currency: 'USD', saleDate: '2024-10-01' }),
        disposal({ id: 'c', currency: 'USD', saleDate: '2024-11-01' }),
        disposal({ id: 'd', currency: 'GBP', saleDate: '2024-12-01' }),
      ],
      parcels: [],
      reportingCurrency: 'AUD',
    });
    const w = p.warnings.find(x => x.kind === 'mixed-currency');
    expect(w?.count).toBe(2);
    expect(w?.message).toContain('GBP, USD');
  });
});

// ─── Foreign currency is not a share priced in it ────────────────────────────

/**
 * FINDING (Low) — FIXED. Nothing distinguished a foreign-currency CASH balance
 * from an asset priced in foreign currency, so disposing of US dollars held in a
 * brokerage account was assessed as an ordinary capital gain — and, held over a
 * year, given the 50% discount. Under the foreign exchange rules the gain is
 * ORDINARY INCOME, taxed in full.
 *
 * Ledger does not assess Div 775 (it needs an election, a balance test and a
 * per-withdrawal record Ledger does not hold), so the disposal stays in the
 * position where it is at least counted — leaving it out would understate
 * income — but the discount is refused and the treatment is named.
 */
describe('a foreign-currency cash balance', () => {
  const usdCash = (o: Partial<CgtDisposal> = {}) => disposal({
    id: 'fx', label: 'US dollar balance', ticker: null, assetType: 'cash',
    nativeCurrency: 'USD', quantity: 10_000, proceeds: 16_000, costBase: 14_000,
    acquiredDate: '2020-01-01', saleDate: '2024-09-01', ...o,
  });

  it('is refused the CGT discount however long it was held', () => {
    const p = buildCapitalGains({
      fy: '2024-2025', disposals: [usdCash()], parcels: [], reportingCurrency: 'AUD',
    });
    const e = p.events[0];
    expect(e.forex).toBe(true);
    expect(e.gain).toBe(2_000);
    expect(e.discountableGain).toBe(0);
    expect(e.otherGain).toBe(2_000);
    // Taxed in full: no discount anywhere in the year's answer.
    expect(p.discount).toBe(0);
    expect(p.netCapitalGain).toBe(2_000);
  });

  it('is still counted — the gain is not quietly dropped', () => {
    const p = buildCapitalGains({
      fy: '2024-2025', disposals: [usdCash()], parcels: [], reportingCurrency: 'AUD',
    });
    expect(p.proceeds).toBe(16_000);
    expect(p.grossGainsTotal).toBe(2_000);
  });

  it('names the treatment rather than pretending it is settled', () => {
    const p = buildCapitalGains({
      fy: '2024-2025', disposals: [usdCash()], parcels: [], reportingCurrency: 'AUD',
    });
    const w = p.warnings.find(x => x.kind === 'forex-not-capital');
    expect(w?.severity).toBe('warn');
    expect(w?.count).toBe(1);
    expect(w?.amount).toBe(2_000);
    expect(w?.message).toContain('ordinary income');
  });

  it('leaves cash in the reporting currency completely alone', () => {
    const p = buildCapitalGains({
      fy: '2024-2025',
      disposals: [usdCash({ nativeCurrency: 'AUD' })],
      parcels: [],
      reportingCurrency: 'AUD',
    });
    expect(p.events[0].forex).toBe(false);
    expect(p.events[0].discountableGain).toBe(2_000);
    expect(p.warnings.map(w => w.kind)).not.toContain('forex-not-capital');
  });

  it('leaves a US-listed SHARE alone — it is priced in dollars, it is not dollars', () => {
    const p = buildCapitalGains({
      fy: '2024-2025',
      disposals: [usdCash({ assetType: 'stock', ticker: 'AAPL' })],
      parcels: [],
      reportingCurrency: 'AUD',
    });
    expect(p.events[0].forex).toBe(false);
    expect(p.events[0].discountableGain).toBe(2_000);
  });

  it('guesses nothing when either currency is unknown', () => {
    // A holding that never recorded its currency, and a caller that never said
    // what it reports in. Both keep the behaviour they had.
    const noNative = buildCapitalGains({
      fy: '2024-2025', disposals: [usdCash({ nativeCurrency: null })],
      parcels: [], reportingCurrency: 'AUD',
    });
    expect(noNative.events[0].forex).toBe(false);
    const noReporting = buildCapitalGains({ fy: '2024-2025', disposals: [usdCash()], parcels: [] });
    expect(noReporting.events[0].forex).toBe(false);
    expect(noReporting.events[0].discountableGain).toBe(2_000);
  });

  it('never returns a negative net capital gain', () => {
    const p = buildCapitalGainsPosition({
      fy: '2024-2025',
      events: [],
      broughtForward: { ordinary: 9_999, collectable: 0 },
    });
    expect(p.netCapitalGain).toBe(0);
    expect(p.carriedForward.ordinary).toBe(9_999);
  });

  it('keeps the totals internally consistent', () => {
    const p = build('2024-2025', [
      disposal({ id: 'd1', quantity: 80, proceeds: 1_600, saleDate: '2024-09-01' }),
      disposal({ id: 'd2', ticker: 'BHP', label: 'BHP', quantity: 10, proceeds: 700, saleDate: '2024-10-01' }),
    ], [
      parcel({ id: 'old', quantity: 50, costBase: 500, acquiredDate: '2022-01-01' }),
      parcel({ id: 'new', quantity: 50, costBase: 900, acquiredDate: '2024-06-01' }),
      parcel({ id: 'bhp', ticker: 'BHP', label: 'BHP', quantity: 10, costBase: 1_000, acquiredDate: '2020-01-01' }),
    ]);
    expect(p.gainsAfterLossesTotal).toBe(p.grossGainsTotal - p.lossesApplied);
    expect(p.netCapitalGain).toBe(p.gainsAfterLossesTotal - p.discount);
    const lossesMade = p.currentYearLosses.ordinary + p.currentYearLosses.collectable
      + p.broughtForward.ordinary + p.broughtForward.collectable;
    expect(p.lossesApplied + p.carriedForwardTotal).toBe(lossesMade);
  });

  it('does not mutate the parcels it was handed', () => {
    const parcels = [parcel({ id: 'p1', quantity: 100, costBase: 1_000 })];
    const snapshot = JSON.parse(JSON.stringify(parcels));
    build('2024-2025', [disposal({ id: 'd', quantity: 40 })], parcels);
    expect(parcels).toEqual(snapshot);
  });
});
