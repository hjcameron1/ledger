/**
 * Phase 8.3 — the laws that stand between a model reading a PDF and a figure
 * the user acts on.
 *
 * Everything worth pinning here is a way this feature could quietly invent
 * something:
 *
 *   • A VALUE MUST BE IN ITS QUOTE — the premium Ledger reports is a number
 *     that appears in the words it quotes back, or it is discarded;
 *   • A FIELD MUST BELONG TO THE DOCUMENT — a statement cannot yield an
 *     excess, and an unknown field name is never stored "just in case";
 *   • A VALUE MUST PARSE AS WHAT IT IS — "sometime in March" is not a date,
 *     and is refused rather than coerced into one;
 *   • MISSING IS MISSING — a field the document does not mention produces no
 *     row at all, and nothing downstream can fill it in;
 *   • CONFIDENCE DECIDES USE, NOT STORAGE — a shaky reading is kept, shown and
 *     flagged, and cannot be answered from until somebody confirms it.
 */
import { describe, it, expect } from 'vitest';
import {
  sanitiseExtraction, quoteSupports, parseMoney, parseRate, parseDateValue,
  factIsUsable, factNeedsConfirmation, isExtractableType, isExtractableMime,
  FACT_FIELDS, FACT_TRUST_FLOOR, factLabel,
} from './documentFacts';

const facts = (type: string, fields: unknown[]) => sanitiseExtraction(type, { fields });

describe('parsing', () => {
  it('reads money however it is written', () => {
    expect(parseMoney('$1,240.50')).toBe(1240.5);
    expect(parseMoney('AUD 980')).toBe(980);
    expect(parseMoney('1240')).toBe(1240);
    expect(parseMoney('no idea')).toBeNull();
  });

  it('reads a rate as a percentage, and refuses a fraction', () => {
    expect(parseRate('5.89% p.a.')).toBe(5.89);
    // Taken as written: 0.0589 stays 0.0589. Multiplying it by 100 because it
    // "looks like a fraction" is the guess this module exists not to make —
    // and the quote check is what catches it if the page really said 5.89%.
    expect(parseRate('0.0589')).toBe(0.0589);
    expect(parseRate('189%')).toBeNull();
  });

  it('reads the date spellings paperwork uses, Australian order', () => {
    expect(parseDateValue('2027-03-03')).toBe('2027-03-03');
    expect(parseDateValue('03/04/2027')).toBe('2027-04-03');
    expect(parseDateValue('3 March 2027')).toBe('2027-03-03');
    expect(parseDateValue('March 3, 2027')).toBe('2027-03-03');
    expect(parseDateValue('31 February 2027')).toBeNull();
    expect(parseDateValue('sometime in March')).toBeNull();
  });
});

describe('a value has to be in the words it came from', () => {
  it('accepts a figure the quote contains, however it is punctuated', () => {
    expect(quoteSupports('money', '$1,240.50', 1240.5, null, 'Total premium: $1,240.50 (incl. GST)')).toBe(true);
    expect(quoteSupports('money', '1240', 1240, null, 'Annual premium $1,240')).toBe(true);
  });

  it('refuses a figure the quote does not contain', () => {
    expect(quoteSupports('money', '$1,240', 1240, null, 'Annual premium $1,420')).toBe(false);
  });

  it('needs the day, the month and the year for a date', () => {
    expect(quoteSupports('date', '2027-03-03', null, '2027-03-03', 'Expiry date: 3 March 2027')).toBe(true);
    expect(quoteSupports('date', '2027-03-03', null, '2027-03-03', 'Expiry date: 03/03/2027')).toBe(true);
    // The year alone is not the date — this is how a renewal ends up a year out.
    expect(quoteSupports('date', '2027-03-03', null, '2027-03-03', 'Policy year 2027')).toBe(false);
  });

  it('needs the text to appear in the sentence quoted', () => {
    expect(quoteSupports('text', 'NRMA Insurance', null, null, 'Insurer: NRMA Insurance Ltd')).toBe(true);
    expect(quoteSupports('text', 'Allianz', null, null, 'Insurer: NRMA Insurance Ltd')).toBe(false);
  });

  it('refuses anything with no quote at all', () => {
    expect(quoteSupports('money', '$1,240', 1240, null, '   ')).toBe(false);
  });
});

describe('sanitising what a model proposes', () => {
  it('keeps a well-quoted fact, with its provenance intact', () => {
    const { facts: kept, discarded } = facts('insurance', [
      { field: 'renewal_date', value: '3 March 2027', quote: 'Period of cover ends 3 March 2027', page: 1, confidence: 0.93 },
    ]);
    expect(discarded).toEqual([]);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({
      field: 'renewal_date',
      kind: 'date',
      valueDate: '2027-03-03',
      valueText: '2027-03-03',
      quote: 'Period of cover ends 3 March 2027',
      page: 1,
      confidence: 0.93,
    });
  });

  it('discards a figure that is not in its quote — with the reason', () => {
    const { facts: kept, discarded } = facts('insurance', [
      { field: 'premium_amount', value: '$1,240', quote: 'Your total premium is $1,420.00', confidence: 0.99 },
    ]);
    expect(kept).toEqual([]);
    expect(discarded).toEqual([{ field: 'premium_amount', reason: 'the quoted words do not contain that value' }]);
  });

  it('discards a field this kind of document does not have', () => {
    const { facts: kept, discarded } = facts('statement', [
      { field: 'excess', value: '$750', quote: 'Excess $750', confidence: 0.9 },
      { field: 'closing_balance', value: '$2,310.55', quote: 'Closing balance $2,310.55', confidence: 0.9 },
    ]);
    expect(kept.map(f => f.field)).toEqual(['closing_balance']);
    expect(discarded[0].reason).toMatch(/not a field/);
  });

  it('discards an invented field name outright', () => {
    const { facts: kept } = facts('loan', [
      { field: 'lender_mood', value: 'optimistic', quote: 'optimistic', confidence: 1 },
    ]);
    expect(kept).toEqual([]);
  });

  it('refuses a value that is not what its field is, rather than coercing it', () => {
    const { facts: kept, discarded } = facts('insurance', [
      { field: 'renewal_date', value: 'sometime next March', quote: 'renews sometime next March', confidence: 0.9 },
      { field: 'excess', value: 'standard', quote: 'A standard excess applies', confidence: 0.9 },
    ]);
    expect(kept).toEqual([]);
    expect(discarded.map(d => d.reason)).toEqual([
      '"sometime next March" is not a date',
      '"standard" is not an amount',
    ]);
  });

  it('drops a proposal with nothing quoted — the whole point of the quote', () => {
    const { facts: kept, discarded } = facts('insurance', [
      { field: 'coverage_amount', value: '$650,000', confidence: 0.95 },
    ]);
    expect(kept).toEqual([]);
    expect(discarded).toEqual([{ field: 'coverage_amount', reason: 'nothing quoted from the document' }]);
  });

  it('leaves a field the document never mentioned absent — never inferred', () => {
    const { facts: kept } = facts('insurance', [
      { field: 'insurer', value: 'NRMA Insurance', quote: 'Insurer: NRMA Insurance', confidence: 0.97 },
    ]);
    expect(kept.map(f => f.field)).toEqual(['insurer']);
    // Nine fields are on offer; one was on the page. The other eight are not
    // "unknown values" — they do not exist.
    expect(kept).toHaveLength(1);
  });

  it('refuses to pick between two readings of the same field', () => {
    const { facts: kept, discarded } = facts('insurance', [
      { field: 'excess', value: '$750', quote: 'Excess: $750', confidence: 0.9 },
      { field: 'excess', value: '$1,000', quote: 'Excess: $1,000', confidence: 0.95 },
    ]);
    expect(kept).toHaveLength(1);
    expect(kept[0].valueNumber).toBe(750);
    expect(discarded).toEqual([{ field: 'excess', reason: 'read twice, with two answers' }]);
  });

  it('treats a missing confidence as low, not as certainty', () => {
    const { facts: kept } = facts('insurance', [
      { field: 'insurer', value: 'NRMA', quote: 'Insurer: NRMA' },
    ]);
    expect(kept[0].confidence).toBeLessThan(FACT_TRUST_FLOOR);
    expect(factNeedsConfirmation({ ...kept[0], status: 'unconfirmed' })).toBe(true);
  });

  it('will not read a kind of document it does not understand', () => {
    const { facts: kept, discarded } = facts('receipt', [
      { field: 'insurer', value: 'NRMA', quote: 'NRMA', confidence: 1 },
    ]);
    expect(kept).toEqual([]);
    expect(discarded[0].field).toBe('*');
    expect(isExtractableType('receipt')).toBe(false);
    expect(isExtractableType('insurance')).toBe(true);
  });

  it('survives a model that returns nonsense instead of a list', () => {
    expect(sanitiseExtraction('insurance', null).facts).toEqual([]);
    expect(sanitiseExtraction('insurance', { fields: 'the policy renews in March' }).facts).toEqual([]);
    expect(sanitiseExtraction('insurance', [42, null, 'x']).facts).toEqual([]);
  });
});

describe('confidence decides what may be answered from', () => {
  const shaky = { confidence: 0.5, status: 'unconfirmed' };
  const sure = { confidence: 0.92, status: 'unconfirmed' };

  it('answers from a confident reading, and flags a shaky one', () => {
    expect(factIsUsable(sure)).toBe(true);
    expect(factNeedsConfirmation(sure)).toBe(false);
    expect(factIsUsable(shaky)).toBe(false);
    expect(factNeedsConfirmation(shaky)).toBe(true);
  });

  it('answers from a shaky reading once a person has confirmed it', () => {
    expect(factIsUsable({ ...shaky, status: 'confirmed' })).toBe(true);
    expect(factNeedsConfirmation({ ...shaky, status: 'confirmed' })).toBe(false);
  });

  it('never answers from a reading the user rejected, however sure the model was', () => {
    expect(factIsUsable({ confidence: 1, status: 'rejected' })).toBe(false);
  });
});

describe('the field catalogue', () => {
  it('offers the fields the worked example needs', () => {
    const insurance = FACT_FIELDS.insurance.map(f => f.field);
    expect(insurance).toEqual(expect.arrayContaining([
      'renewal_date', 'premium_amount', 'excess', 'coverage_amount',
    ]));
  });

  it('only reads files it can actually read', () => {
    expect(isExtractableMime('application/pdf')).toBe(true);
    expect(isExtractableMime('image/png')).toBe(true);
    expect(isExtractableMime('application/vnd.ms-excel')).toBe(false);
  });

  it('names a field the way a person would say it', () => {
    expect(factLabel('insurance', 'renewal_date')).toBe('Renews');
    expect(factLabel('statement', 'closing_balance')).toBe('Closing balance');
  });
});
