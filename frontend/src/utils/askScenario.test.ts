/**
 * Phase 9.3 — reading a what-if question. Pure: no store, no network, no clock.
 *
 * Two things are being tested, and the second matters more than the first:
 *
 *   • the SENTENCE is read correctly — the amount, the cadence, the record it
 *     points at, and the conversion into the cycle the loan actually runs on;
 *   • a name Ledger cannot place NEVER becomes a scenario. A question about a
 *     loan the user doesn't have is answered as such, not modelled against
 *     whichever loan happens to be there.
 */
import { describe, it, expect } from 'vitest';
import {
  parseWhatIf, readWhatIf, reviseScenario, looksLikeFollowUp, moneyIn, percentIn, cadenceIn,
  findLoan, loanSubject, withWhatIf,
} from './askScenario';
import { matchIntent, type AskVocabulary } from './askIntent';
import type { Scenario } from './scenario';

const TODAY = '2026-08-24';

const VOCAB: AskVocabulary = {
  categories: ['Dining', 'Groceries', 'Transport', 'Health'],
  goals: [{ id: 'g1', name: 'House deposit' }, { id: 'g2', name: 'Japan trip' }],
  loans: [
    { id: 'l1', name: 'Home mortgage', frequency: 'monthly' },
    { id: 'l2', name: 'Car loan', frequency: 'fortnightly' },
  ],
  incomes: [{ id: 'i1', name: 'Acme Pty Ltd' }],
  properties: [],
  accounts: [],
  financialYears: ['2026-2027'],
};

const read = (q: string) => parseWhatIf(q, VOCAB, TODAY);
const changesOf = (q: string) => read(q).scenario?.changes ?? [];
const only = (q: string) => {
  const changes = changesOf(q);
  expect(changes).toHaveLength(1);
  return changes[0] as any;
};

// ═════════════════════════════════════════════════════════════════════════════
//  Reading figures out of a sentence
// ═════════════════════════════════════════════════════════════════════════════
describe('the figures in a question', () => {
  it('reads money however it is written', () => {
    expect(moneyIn('pay $1,000 off the car')).toBe(1_000);
    expect(moneyIn('put 5k in the offset')).toBe(5_000);
    expect(moneyIn('$1.5k a month')).toBe(1_500);
    expect(moneyIn('spend 250 dollars less')).toBe(250);
    expect(moneyIn('a 40000 car')).toBe(40_000);
  });

  it('does not read a duration, a year or a percentage as money', () => {
    expect(moneyIn('over 3 years')).toBeNull();
    expect(moneyIn('what did I spend in 2026')).toBeNull();
    expect(moneyIn('10% more')).toBeNull();
    expect(moneyIn('in 6 months')).toBeNull();
  });

  it('reads a percentage', () => {
    expect(percentIn('a 10% pay rise')).toBe(10);
    expect(percentIn('15 per cent less')).toBe(15);
    expect(percentIn('$300 a month')).toBeNull();
  });

  it('reads the cadence the question states', () => {
    expect(cadenceIn('$200 a month')).toBe('monthly');
    expect(cadenceIn('$100 every fortnight')).toBe('fortnightly');
    expect(cadenceIn('$50 weekly')).toBe('weekly');
    expect(cadenceIn('$1,200 a year')).toBe('annually');
    expect(cadenceIn('right now')).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  The question in the brief
// ═════════════════════════════════════════════════════════════════════════════
describe('"What happens if I pay $1,000 off my car loan right now?"', () => {
  const Q = 'What happens if I pay $1,000 off my car loan right now?';

  it('is one payment, off that loan, today', () => {
    const change = only(Q);
    expect(change.kind).toBe('lump-sum');
    expect(change.loanId).toBe('l2');
    expect(change.amount).toBe(1_000);
  });

  it('says how it was read', () => {
    expect(read(Q).reading[0]).toMatch(/1,000 paid off Car loan today/i);
  });

  it('is not confused for a recurring payment', () => {
    expect(only('what if I pay $500 off the Home mortgage?').kind).toBe('lump-sum');
  });
});

describe('an ongoing extra repayment', () => {
  it('is read as a rate when the question gives one', () => {
    const change = only('what if I pay an extra $200 a month off my car loan?');
    expect(change.kind).toBe('extra-repayment');
    expect(change.loanId).toBe('l2');
  });

  it('converts the stated cadence into the loan\'s own cycle', () => {
    // $200 a month against a fortnightly loan is not $200 a fortnight.
    const change = only('what if I pay an extra $200 a month off my car loan?');
    expect(change.amountPerPeriod).toBeCloseTo(91.99, 1);
  });

  it('leaves a monthly loan alone', () => {
    const change = only('what if I pay an extra $300 a month off my home mortgage?');
    expect(change.amountPerPeriod).toBe(300);
  });

  it('says which cycle it converted to', () => {
    expect(read('what if I pay an extra $200 a month off my car loan?').reading[0])
      .toMatch(/each fortnight/i);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  The other six shapes
// ═════════════════════════════════════════════════════════════════════════════
describe('the changes a question can describe', () => {
  it('a percentage pay rise', () => {
    const change = only('what if I get a 10% pay rise?');
    expect(change).toMatchObject({ kind: 'income', mode: 'percent', value: 10, incomeId: null });
  });

  it('a pay cut goes the other way', () => {
    expect(only('what if I take a 20% pay cut?').value).toBe(-20);
  });

  it('a salary figure is a year\'s money unless the question says otherwise', () => {
    const change = only('what if I got a $12,000 pay rise?');
    expect(change).toMatchObject({ kind: 'income', mode: 'amount', value: 1_000 });
    expect(read('what if I got a $12,000 pay rise?').reading[0]).toMatch(/a year/i);
  });

  it('a pay rise on one named stream', () => {
    expect(only('what if Acme Pty Ltd gave me a 5% pay rise?').incomeId).toBe('i1');
  });

  it('spending less in a category', () => {
    const change = only('what if I spend $200 less on dining each month?');
    expect(change).toMatchObject({ kind: 'spending', category: 'Dining', mode: 'amount', value: -200 });
  });

  it('spending less as a percentage', () => {
    expect(only('what if I spend 15% less on groceries?'))
      .toMatchObject({ kind: 'spending', category: 'Groceries', mode: 'percent', value: -15 });
  });

  it('spending more, with no category, is everyday spending', () => {
    expect(only('what if I spend $150 a month more?'))
      .toMatchObject({ kind: 'spending', category: null, value: 150 });
  });

  it('a one-off purchase', () => {
    const change = only('what if I buy a car for $40,000?');
    expect(change).toMatchObject({ kind: 'one-off', amount: 40_000, date: '2026-08-25' });
    expect(change.name).toMatch(/car/i);
  });

  it('a new recurring commitment', () => {
    const change = only('what if I get a gym membership for $80 a month?');
    expect(change).toMatchObject({ kind: 'recurring-expense', amount: 80, frequency: 'monthly' });
  });

  it('money into an offset', () => {
    expect(only('what if I put $20,000 into my home mortgage offset?'))
      .toMatchObject({ kind: 'offset', loanId: 'l1', delta: 20_000 });
  });

  it('money back out of an offset', () => {
    expect(only('what if I take $5,000 out of my home mortgage offset?').delta).toBe(-5_000);
  });

  it('money toward a named goal', () => {
    expect(only('what if I save $500 a month toward my Japan trip?'))
      .toMatchObject({ kind: 'savings-contribution', goalId: 'g2', monthlyAmount: 500 });
  });

  it('a windfall comes in rather than going out', () => {
    expect(only('what if I get a $10,000 bonus?'))
      .toMatchObject({ kind: 'one-off', amount: -10_000 });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Several changes at once
// ═════════════════════════════════════════════════════════════════════════════
describe('more than one change in a question', () => {
  it('reads each clause as its own change', () => {
    const changes = changesOf('what if I pay $500 off my car loan and get a 10% pay rise?');
    expect(changes.map(c => c.kind)).toEqual(['lump-sum', 'income']);
  });

  it('does not split a figure at its comma', () => {
    expect(only('what if I pay $1,500 off my car loan?').amount).toBe(1_500);
  });

  it('reads the whole sentence when splitting it found nothing', () => {
    // "and" inside the subject, not between two changes.
    expect(changesOf('what if I buy a table and chairs for $2,000?')).toHaveLength(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  What it refuses to model
// ═════════════════════════════════════════════════════════════════════════════
describe('a record Ledger cannot place', () => {
  it('never becomes a scenario about a different loan', () => {
    const result = read('what if I pay $1,000 off my boat loan?');
    expect(result.scenario).toBeNull();
    expect(result.unresolved[0]).toMatchObject({ slot: 'loan', requested: 'boat loan' });
    expect(result.unresolved[0].available).toEqual(['Home mortgage', 'Car loan']);
  });

  it('never becomes a scenario about a different goal', () => {
    const result = read('what if I save $300 a month toward my car goal?');
    expect(result.scenario).toBeNull();
    expect(result.unresolved[0]).toMatchObject({ slot: 'goal', requested: 'car' });
  });

  it('asks which offset when the question does not say and there are several loans', () => {
    const result = read('what if I put $20,000 in my offset?');
    expect(result.scenario).toBeNull();
    expect(result.reason).toMatch(/which loan/i);
  });

  it('asks what the saving is for rather than guessing', () => {
    const result = read('what if I save $500 a month?');
    expect(result.scenario).toBeNull();
    expect(result.reason).toMatch(/name a goal/i);
  });

  it('says plainly when there is no change in the question at all', () => {
    const result = read('what if I lose my job?');
    expect(result.scenario).toBeNull();
    expect(result.reason).toMatch(/could not tell what to change/i);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Follow-ups
// ═════════════════════════════════════════════════════════════════════════════
describe('"What about $2,000?"', () => {
  const previous = (): Scenario =>
    parseWhatIf('what happens if I pay $1,000 off my car loan?', VOCAB, TODAY).scenario!;

  it('is recognised as a follow-up', () => {
    expect(looksLikeFollowUp('What about $2,000?')).toBe(true);
    expect(looksLikeFollowUp('$2,000?')).toBe(true);
    expect(looksLikeFollowUp('and what about $500')).toBe(true);
    expect(looksLikeFollowUp('how much did I spend on dining?')).toBe(false);
  });

  it('re-runs the same change with the new figure', () => {
    const result = reviseScenario('What about $2,000?', previous(), VOCAB, TODAY)!;
    expect(result.followUp).toBe(true);
    expect(result.scenario!.changes).toHaveLength(1);
    expect(result.scenario!.changes[0]).toMatchObject({ kind: 'lump-sum', loanId: 'l2', amount: 2_000 });
  });

  it('keeps the direction of the change it is revising', () => {
    const cut = parseWhatIf('what if I take a 20% pay cut?', VOCAB, TODAY).scenario!;
    const revised = reviseScenario('what about 30%?', cut, VOCAB, TODAY)!;
    expect((revised.scenario!.changes[0] as any).value).toBe(-30);
  });

  it('can point the same money at another loan', () => {
    const result = reviseScenario('what about the home mortgage?', previous(), VOCAB, TODAY)!;
    expect(result.scenario!.changes[0]).toMatchObject({ kind: 'lump-sum', loanId: 'l1', amount: 1_000 });
  });

  it('refuses to guess which figure was meant when the last question had two', () => {
    const two = parseWhatIf(
      'what if I pay $500 off my car loan and get a 10% pay rise?', VOCAB, TODAY,
    ).scenario!;
    expect(reviseScenario('what about $2,000?', two, VOCAB, TODAY)).toBeNull();
  });

  it('reads as a fresh question when there is nothing to follow up', () => {
    const result = readWhatIf('what about $2,000?', VOCAB, TODAY, null);
    expect(result.scenario).toBeNull();
    expect(result.followUp).toBe(false);
  });

  it('a new question is still a new question, previous scenario or not', () => {
    const result = readWhatIf('what if I get a 10% pay rise?', VOCAB, TODAY, previous());
    expect(result.followUp).toBe(false);
    expect(result.scenario!.changes[0].kind).toBe('income');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Naming a loan
// ═════════════════════════════════════════════════════════════════════════════
describe('which loan a question means', () => {
  it('finds a loan named in the question', () => {
    expect(findLoan('pay $500 off my Car loan', VOCAB.loans).entity?.id).toBe('l2');
  });

  it('takes "my mortgage" as the one loan there is', () => {
    expect(loanSubject('pay $500 off my mortgage')).toBe('mortgage');
    expect(findLoan('pay $500 off my mortgage', [VOCAB.loans[0]]).entity?.id).toBe('l1');
  });

  it('asks which one when the words name no loan in particular', () => {
    const hit = findLoan('pay $500 off my loan', VOCAB.loans);
    expect(hit.entity).toBeNull();
    expect(hit.suggestions).toEqual(['Home mortgage', 'Car loan']);
  });

  it('reports one it cannot place instead of choosing', () => {
    const hit = findLoan('pay $500 off my boat loan', VOCAB.loans);
    expect(hit.entity).toBeNull();
    expect(hit.requested).toBe('boat loan');
  });

  it('does not match a loan whose name merely appears inside a word', () => {
    expect(findLoan('what if I buy a carport for $5,000', VOCAB.loans).entity).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  A question that only sounds hypothetical
// ═════════════════════════════════════════════════════════════════════════════
describe('attaching the reading to an intent', () => {
  const attach = (q: string) => withWhatIf(matchIntent(q, VOCAB, TODAY), VOCAB, TODAY);

  it('answers an ordinary question ordinarily when there is no change in it', () => {
    const intent = attach('Should I pay off my mortgage?');
    expect(intent.name).toBe('loan-payoff');
  });

  it('keeps the hypothetical when there IS a change in it', () => {
    const intent = attach('Should I put $10,000 in my Home mortgage offset?');
    expect(intent.name).toBe('what-if');
    expect(intent.whatIf!.scenario!.changes[0].kind).toBe('offset');
  });

  it('stays a hypothetical when the question named something Ledger cannot find', () => {
    const intent = attach('What if I pay $1,000 off my boat loan?');
    expect(intent.name).toBe('what-if');
    expect(intent.unresolved.some(u => u.slot === 'loan')).toBe(true);
  });

  it('stays a hypothetical when the question is ambiguous rather than ordinary', () => {
    const intent = attach('What if I save $500 a month?');
    expect(intent.name).toBe('what-if');
    expect(intent.whatIf!.reason).toMatch(/name a goal/i);
  });
});
