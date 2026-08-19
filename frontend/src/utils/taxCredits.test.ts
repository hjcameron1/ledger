/**
 * Phase 5.2 — the tax payments and credits Ledger cannot derive.
 *
 * The storage rule these tests exist to hold: a bad value can only ever read as
 * ZERO. A corrupt bucket must understate what has been paid (making a refund
 * look smaller) and must never invent a payment the user never made.
 */
import { describe, it, expect } from 'vitest';
import {
  TAX_CREDIT_FIELDS,
  emptyTaxCredits,
  normaliseTaxCredits,
  hasTaxCredits,
  totalTaxCredits,
  grossUpFor,
} from './taxCredits';

describe('the empty record', () => {
  it('is every field at zero', () => {
    expect(emptyTaxCredits()).toEqual({ paygInstalments: 0, frankingCredits: 0, otherTaxPaid: 0 });
    expect(hasTaxCredits(emptyTaxCredits())).toBe(false);
    expect(totalTaxCredits(emptyTaxCredits())).toBe(0);
    expect(grossUpFor(emptyTaxCredits())).toBe(0);
  });

  it('is what null, undefined and rubbish all read as', () => {
    for (const bad of [null, undefined, 'nope', 42, [], { byFY: {} }]) {
      expect(normaliseTaxCredits(bad)).toEqual(emptyTaxCredits());
      expect(hasTaxCredits(normaliseTaxCredits(bad))).toBe(false);
    }
  });
});

describe('normalisation', () => {
  it('keeps positive numbers and rounds to the cent', () => {
    expect(normaliseTaxCredits({ paygInstalments: 4_000, frankingCredits: 428.571, otherTaxPaid: 12.5 }))
      .toEqual({ paygInstalments: 4_000, frankingCredits: 428.57, otherTaxPaid: 12.5 });
  });

  it('reads a numeric string, because a form gives strings', () => {
    expect(normaliseTaxCredits({ paygInstalments: '3500.25' }).paygInstalments).toBe(3_500.25);
  });

  it('zeroes anything that is not a positive finite number', () => {
    const out = normaliseTaxCredits({
      paygInstalments: -900, frankingCredits: NaN, otherTaxPaid: Infinity,
    });
    expect(out).toEqual(emptyTaxCredits());
  });

  it('drops keys it does not know', () => {
    const out = normaliseTaxCredits({ paygInstalments: 100, medicareRefund: 5_000 }) as unknown as Record<string, number>;
    expect(out.medicareRefund).toBeUndefined();
    expect(totalTaxCredits(out as never)).toBe(100);
  });
});

describe('totals', () => {
  it('adds every field', () => {
    expect(totalTaxCredits({ paygInstalments: 4_000, frankingCredits: 700, otherTaxPaid: 250 }))
      .toBe(4_950);
  });

  it('has anything entered', () => {
    expect(hasTaxCredits({ paygInstalments: 0, frankingCredits: 0, otherTaxPaid: 0.01 })).toBe(true);
    expect(hasTaxCredits(null)).toBe(false);
  });
});

describe('the gross-up', () => {
  it('is the franking credits and nothing else', () => {
    expect(grossUpFor({ paygInstalments: 4_000, frankingCredits: 700, otherTaxPaid: 250 })).toBe(700);
  });

  it('is derived from the field metadata, not a hard-coded key', () => {
    // Exactly one field grosses up today; the helper must agree with the list.
    const flagged = TAX_CREDIT_FIELDS.filter(f => f.grossesUp);
    expect(flagged.map(f => f.key)).toEqual(['frankingCredits']);
    const all = Object.fromEntries(TAX_CREDIT_FIELDS.map(f => [f.key, 100])) as never;
    expect(grossUpFor(all)).toBe(100 * flagged.length);
  });
});

describe('the field list the editor renders', () => {
  it('covers every field on the record, once', () => {
    const keys = TAX_CREDIT_FIELDS.map(f => f.key).sort();
    expect(keys).toEqual(Object.keys(emptyTaxCredits()).sort());
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('explains each one', () => {
    for (const f of TAX_CREDIT_FIELDS) {
      expect(f.label.length).toBeGreaterThan(3);
      expect(f.help.length).toBeGreaterThan(20);
    }
  });

  it('warns that PAYG from your pay is not one of these', () => {
    const instalments = TAX_CREDIT_FIELDS.find(f => f.key === 'paygInstalments')!;
    expect(instalments.help).toMatch(/already counted/i);
  });
});
