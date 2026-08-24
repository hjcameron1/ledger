/**
 * Phase 9.1 — reading the question. Pure, no store, no network.
 *
 * Two halves, and the second is the important one:
 *
 *   • the DETERMINISTIC matcher answers every question in the phase brief with
 *     no AI configured at all — that is what makes the AI optional rather than
 *     load-bearing;
 *   • the GATE (`sanitiseIntent`) refuses everything a model could get wrong:
 *     an intent outside the closed list, a category the user doesn't have, a
 *     goal that doesn't exist, dates the model computed itself.
 */

import { describe, it, expect } from 'vitest';
import {
  matchIntent, sanitiseIntent, parsePeriod, resolveCategory, resolveEntity,
  findEntityInText, matchEntity, lookupGoal, fyOf, fyPeriod, isAskIntent, vocabularyForModel,
  emptyVocabulary, defaultSpendPeriod, reviseIntent, unsupportedTopic, findPolicy,
  AI_INTENT_FLOOR,
  type AskVocabulary,
} from './askIntent';

const TODAY = '2026-08-24';           // a Monday, in FY 2026-2027

const VOCAB: AskVocabulary = {
  categories: ['Dining', 'Groceries', 'Transport', 'Utilities', 'Health', 'Rent', 'Sunday market'],
  goals: [{ id: 'g1', name: 'House deposit' }, { id: 'g2', name: 'Japan trip' }],
  loans: [
    { id: 'l1', name: 'Home mortgage', frequency: 'monthly' },
    { id: 'l2', name: 'Car loan', frequency: 'fortnightly' },
  ],
  policies: [{ id: 'ip1', name: 'Car insurance' }, { id: 'ip2', name: 'Home & contents' }],
  incomes: [{ id: 'i1', name: 'Acme salary' }],
  properties: [{ id: 'p1', name: 'Bondi apartment' }],
  accounts: [{ id: 'a1', name: 'Everyday' }],
  financialYears: ['2026-2027', '2025-2026'],
};

const read = (q: string) => matchIntent(q, VOCAB, TODAY);

// ═════════════════════════════════════════════════════════════════════════════
//  The questions the phase brief names
// ═════════════════════════════════════════════════════════════════════════════

describe('the five questions Ask Ledger must answer', () => {
  it('"How much did I spend eating out this year?" → a category, a year', () => {
    const intent = read('How much did I spend eating out this year?');
    expect(intent.name).toBe('spend-category');
    expect(intent.category).toBe('Dining');
    expect(intent.period?.from).toBe('2026-01-01');
    expect(intent.period?.to).toBe(TODAY);
    expect(intent.unresolved).toEqual([]);
  });

  it('"Why is my forecast dropping?" → the forecast', () => {
    expect(read('Why is my forecast dropping?').name).toBe('forecast-outlook');
  });

  it('"How much interest is my offset saving?" → the offset, not spending', () => {
    const intent = read('How much interest is my offset saving?');
    expect(intent.name).toBe('loan-offset');
  });

  it('"What deductions do I have?" → deductions, defaulted to this financial year', () => {
    const intent = read('What deductions do I have?');
    expect(intent.name).toBe('tax-deductions');
    expect(intent.fy).toBe('2026-2027');
  });

  it('"Am I on track for my goal?" → goals', () => {
    expect(read('Am I on track for my goal?').name).toBe('goal-progress');
  });

  it('names the goal when the question does', () => {
    const intent = read('Am I on track for the Japan trip?');
    expect(intent.name).toBe('goal-progress');
    expect(intent.goal?.id).toBe('g2');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Which question is being asked
// ═════════════════════════════════════════════════════════════════════════════

describe('reading the shape of a question', () => {
  it.each([
    ['How much did I spend last month?', 'spend-total'],
    ['Where is my money going?', 'spend-top'],
    ['What am I spending the most on?', 'spend-top'],
    ['How am I tracking against my budget?', 'budget-status'],
    ['When will my mortgage be paid off?', 'loan-payoff'],
    ['What is my net worth?', 'net-worth'],
    ['What bills are due?', 'bills-upcoming'],
    ['How much have I earned this year?', 'income-total'],
    ['What is my taxable income?', 'tax-position'],
    ['What changed in my spending?', 'insights-changes'],
    ['Will I run out of money?', 'forecast-outlook'],
  ])('%s → %s', (question, expected) => {
    expect(read(question).name).toBe(expected);
  });

  it('a specific question beats a generic one that also matches', () => {
    // "how much" + "interest" + "offset" — the offset rule must win over spend.
    expect(read('How much interest is my offset saving me?').name).toBe('loan-offset');
    // "spend" appears, but the question is about the budget.
    expect(read('Am I over budget on my spending?').name).toBe('budget-status');
  });

  it('a spending question with no category stays the broad question', () => {
    const intent = read('How much did I spend this month?');
    expect(intent.name).toBe('spend-total');
    expect(intent.category).toBeNull();
    expect(intent.unresolved).toEqual([]);
  });

  it('gives up rather than guessing', () => {
    const intent = read('What is the capital of France?');
    expect(intent.name).toBe('unknown');
    expect(intent.confidence).toBe(0);
  });

  it('is more confident about a question with resolved slots', () => {
    const vague = read('How much did I spend?');
    const specific = read('How much did I spend on Groceries last month?');
    expect(specific.confidence).toBeGreaterThan(vague.confidence);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Periods
// ═════════════════════════════════════════════════════════════════════════════

describe('working out the window', () => {
  it('this year is the calendar year to date', () => {
    expect(parsePeriod('this year', TODAY)).toMatchObject({
      kind: 'calendar-year', from: '2026-01-01', to: TODAY, label: 'this year',
    });
  });

  it('last year is the whole previous calendar year', () => {
    expect(parsePeriod('last year', TODAY)).toMatchObject({
      from: '2025-01-01', to: '2025-12-31',
    });
  });

  it('"this financial year" is the FY, not the calendar year', () => {
    expect(parsePeriod('this financial year', TODAY)).toMatchObject({
      kind: 'financial-year', from: '2026-07-01', fy: '2026-2027',
    });
  });

  it('a financial year still being lived stops at today, not at 30 June', () => {
    // Four unlived months reported as months with no spending would be a lie.
    expect(fyPeriod('2026-2027', TODAY).to).toBe(TODAY);
    expect(fyPeriod('2025-2026', TODAY).to).toBe('2026-06-30');
  });

  it('this month runs from the 1st to today', () => {
    expect(parsePeriod('this month', TODAY)).toMatchObject({ from: '2026-08-01', to: TODAY });
  });

  it('last month is the whole month', () => {
    expect(parsePeriod('last month', TODAY)).toMatchObject({ from: '2026-07-01', to: '2026-07-31' });
  });

  it('rolls back over a year boundary', () => {
    expect(parsePeriod('last month', '2026-01-15')).toMatchObject({
      from: '2025-12-01', to: '2025-12-31',
    });
  });

  it('handles rolling windows', () => {
    expect(parsePeriod('in the last 30 days', TODAY)).toMatchObject({
      kind: 'rolling-days', from: '2026-07-26', to: TODAY,
    });
    expect(parsePeriod('over the past 3 months', TODAY)?.kind).toBe('rolling-days');
  });

  it('this week starts on Monday', () => {
    expect(parsePeriod('this week', TODAY)).toMatchObject({ from: '2026-08-24', to: TODAY });
    expect(parsePeriod('this week', '2026-08-26')).toMatchObject({ from: '2026-08-24' });
  });

  it('a named month picks the most recent one that has happened', () => {
    expect(parsePeriod('in July', TODAY)).toMatchObject({ from: '2026-07-01', to: '2026-07-31' });
    // December hasn't happened yet in August 2026, so it means last December.
    expect(parsePeriod('in December', TODAY)).toMatchObject({ from: '2025-12-01' });
  });

  it('a month still being lived stops at today', () => {
    expect(parsePeriod('in August', TODAY)).toMatchObject({ from: '2026-08-01', to: TODAY });
  });

  it('names no period when the question names none', () => {
    expect(parsePeriod('how much did I spend on groceries', TODAY)).toBeNull();
  });

  it('defaults a period-less spending question to this month', () => {
    expect(defaultSpendPeriod(TODAY)).toMatchObject({ from: '2026-08-01', to: TODAY });
  });

  it('knows which financial year a date is in', () => {
    expect(fyOf('2026-08-24')).toBe('2026-2027');
    expect(fyOf('2026-06-30')).toBe('2025-2026');
    expect(fyOf('2026-07-01')).toBe('2026-2027');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Categories — only ever the user's own
// ═════════════════════════════════════════════════════════════════════════════

describe('resolving a category', () => {
  it('finds a category by its own name', () => {
    expect(resolveCategory('how much on Groceries', VOCAB.categories)).toBe('Groceries');
  });

  it('finds one by an everyday phrasing', () => {
    expect(resolveCategory('eating out', VOCAB.categories)).toBe('Dining');
    expect(resolveCategory('how much on petrol', ['Fuel', 'Transport'])).toBe('Fuel');
    expect(resolveCategory('my power bill', ['Utilities'])).toBe('Utilities');
  });

  it('prefers the category the user actually has', () => {
    // "eating out" is Dining for a ledger with Dining…
    expect(resolveCategory('eating out', ['Dining', 'Food'])).toBe('Dining');
    // …and Food for one without it.
    expect(resolveCategory('eating out', ['Food', 'Groceries'])).toBe('Food');
  });

  it('resolves to NOTHING when the user has none of the candidates', () => {
    // The whole point: never answer about the nearest available category.
    expect(resolveCategory('eating out', ['Transport', 'Utilities'])).toBeNull();
  });

  it('finds a user\'s own custom category', () => {
    expect(resolveCategory('what did the Sunday market cost me', VOCAB.categories))
      .toBe('Sunday market');
  });

  it('does not fire on a word that merely contains a category name', () => {
    expect(resolveCategory('am I being healthy', ['Health'])).toBeNull();
  });

  it('prefers the longer, more specific category name', () => {
    expect(resolveCategory('my health insurance', ['Health', 'Health insurance']))
      .toBe('Health insurance');
  });
});

describe('resolving a named record', () => {
  it('matches exactly, case-insensitively', () => {
    expect(resolveEntity('house deposit', VOCAB.goals)?.id).toBe('g1');
  });

  it('matches an unambiguous partial', () => {
    expect(resolveEntity('Japan', VOCAB.goals)?.id).toBe('g2');
  });

  it('refuses an ambiguous partial rather than picking one', () => {
    const two = [{ id: 'x', name: 'Car loan' }, { id: 'y', name: 'Car loan 2' }];
    expect(resolveEntity('Car', two)).toBeNull();
  });

  it('finds a record named inside a longer question', () => {
    expect(findEntityInText('when does my Home mortgage clear?', VOCAB.loans)?.id).toBe('l1');
  });

  it('finds nothing when the question names nothing', () => {
    expect(findEntityInText('when will I be debt free?', VOCAB.loans)).toBeNull();
  });

  it('does not fire on a word that merely contains a record name', () => {
    const goals = [{ id: 'g', name: 'Car' }];
    expect(findEntityInText('how is my carnival budget going?', goals)).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  NAMING A GOAL THAT ISN'T THERE
//
//  The rule this section exists for: a goal Ledger cannot confidently place is
//  never answered with a different goal. Not the nearest one, not the first
//  one, and — the case that reads most like a correct answer — not the only
//  one. Every outcome below is either the right goal or an admission.
// ═════════════════════════════════════════════════════════════════════════════

describe('matching a name to a goal', () => {
  const ONE = [{ id: 'g1', name: 'House deposit' }];
  const MANY = [
    { id: 'g1', name: 'House deposit' },
    { id: 'g2', name: 'Car fund' },
    { id: 'g3', name: 'Car upgrade' },
  ];

  it('resolves the name as written', () => {
    const m = matchEntity('house deposit', ONE);
    expect(m.kind).toBe('resolved');
    expect(m.kind === 'resolved' && m.entity.id).toBe('g1');
  });

  it('resolves through the kind words — "my car goal" is the Car fund', () => {
    const m = matchEntity('car goal', [{ id: 'g2', name: 'Car fund' }]);
    expect(m.kind).toBe('resolved');
  });

  it('resolves a typo', () => {
    const m = matchEntity('House Depsit', ONE);
    expect(m.kind).toBe('resolved');
    expect(m.kind === 'resolved' && m.entity.id).toBe('g1');
  });

  it('REFUSES to answer "car" with the only goal there is', () => {
    expect(matchEntity('car goal', ONE)).toEqual({ kind: 'none' });
    expect(matchEntity('car', ONE)).toEqual({ kind: 'none' });
  });

  it('offers a choice rather than picking between two similar goals', () => {
    const m = matchEntity('car goal', MANY);
    expect(m.kind).toBe('near');
    expect(m.kind === 'near' && m.candidates.map(c => c.name).sort())
      .toEqual(['Car fund', 'Car upgrade']);
  });

  it('resolves a typo whose distinguishing word is intact', () => {
    // "fnd" is a slip; "car" is not, and it is what tells the two apart.
    const m = matchEntity('car fnd', [{ id: 'a', name: 'Car fund' }, { id: 'b', name: 'Cat fund' }]);
    expect(m.kind === 'resolved' && m.entity.id).toBe('a');
  });

  it('does not resolve a typo that two goals could equally have meant', () => {
    // "caz" is one letter from both. Choosing either would be a coin toss.
    const m = matchEntity('caz fund', [{ id: 'a', name: 'Car fund' }, { id: 'b', name: 'Cat fund' }]);
    expect(m.kind).toBe('near');
    expect(m.kind === 'near' && m.candidates).toHaveLength(2);
  });

  it('never matches a name with nothing in common', () => {
    expect(matchEntity('Ferrari', MANY)).toEqual({ kind: 'none' });
    expect(matchEntity('yacht', ONE)).toEqual({ kind: 'none' });
  });

  it('matches nothing at all in an account with no goals', () => {
    expect(matchEntity('House deposit', [])).toEqual({ kind: 'none' });
  });

  it('refuses two goals that answer to the same name', () => {
    const dupes = [{ id: 'a', name: 'Car' }, { id: 'b', name: 'Car' }];
    expect(matchEntity('car', dupes).kind).toBe('near');
  });
});

describe('reading the goal a question names', () => {
  const ONE = [{ id: 'g1', name: 'House deposit' }];
  const MANY = [
    { id: 'g1', name: 'House deposit' },
    { id: 'g2', name: 'Car fund' },
    { id: 'g3', name: 'Car upgrade' },
  ];

  it('picks the goal out of the question', () => {
    expect(lookupGoal('am I on track for my House deposit?', ONE).entity?.id).toBe('g1');
  });

  it('reads "my car goal" as a name it could not place', () => {
    const hit = lookupGoal('am I on track for my car goal?', ONE);
    expect(hit.entity).toBeNull();
    expect(hit.requested).toBe('car');
    expect(hit.suggestions).toEqual([]);
  });

  it('suggests the goals a near miss could have meant', () => {
    const hit = lookupGoal('am I on track for my car goal?', MANY);
    expect(hit.entity).toBeNull();
    expect(hit.suggestions.map(g => g.name)).toEqual(['Car fund', 'Car upgrade']);
  });

  it('names nothing when the question names no particular goal', () => {
    for (const q of ['am I on track?', 'am I on track for my goals?', 'how are my goals going?']) {
      const hit = lookupGoal(q, MANY);
      expect(hit.entity).toBeNull();
      expect(hit.requested).toBeNull();
    }
  });
});

describe('a question about a goal that does not exist', () => {
  const oneGoal: AskVocabulary = { ...VOCAB, goals: [{ id: 'g1', name: 'House deposit' }] };

  it('is still read as a goals question', () => {
    expect(matchIntent('am I on track for my car goal?', oneGoal, TODAY).name).toBe('goal-progress');
    expect(matchIntent('how is my car fund going?', oneGoal, TODAY).name).toBe('goal-progress');
  });

  it('leaves the goal slot EMPTY rather than filling it with the only goal', () => {
    const intent = matchIntent('am I on track for my car goal?', oneGoal, TODAY);
    expect(intent.goal).toBeNull();
  });

  it('records the name, and what the user does have', () => {
    const intent = matchIntent('am I on track for my car goal?', oneGoal, TODAY);
    const slot = intent.unresolved.find(u => u.slot === 'goal');
    expect(slot?.requested).toBe('car');
    expect(slot?.available).toEqual(['House deposit']);
    expect(slot?.suggestions).toEqual([]);
  });

  it('records what it might have meant when the goals are similar', () => {
    const similar: AskVocabulary = {
      ...VOCAB,
      goals: [{ id: 'g1', name: 'Car fund' }, { id: 'g2', name: 'Car upgrade' }],
    };
    const slot = matchIntent('am I on track for my car goal?', similar, TODAY)
      .unresolved.find(u => u.slot === 'goal');
    expect(slot?.suggestions).toEqual(['Car fund', 'Car upgrade']);
  });

  it('says nothing is unresolved when the goal is simply named', () => {
    const intent = matchIntent('am I on track for my House deposit?', oneGoal, TODAY);
    expect(intent.goal?.id).toBe('g1');
    expect(intent.unresolved).toEqual([]);
  });

  it('forgives a typo instead of reporting a goal that does exist as missing', () => {
    const intent = matchIntent('am I on track for my house depost goal?', oneGoal, TODAY);
    expect(intent.goal?.id).toBe('g1');
    expect(intent.unresolved).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  THE GATE — everything a model proposes is checked
// ═════════════════════════════════════════════════════════════════════════════

describe('the AI gate', () => {
  const gate = (raw: unknown, q = 'how much did I spend eating out this year?') =>
    sanitiseIntent(raw as never, q, VOCAB, TODAY);

  it('accepts a well-formed proposal', () => {
    const intent = gate({ intent: 'spend-category', category: 'Dining', period: 'this year', confidence: 0.9 });
    expect(intent.name).toBe('spend-category');
    expect(intent.category).toBe('Dining');
    expect(intent.source).toBe('ai');
    expect(intent.period?.from).toBe('2026-01-01');
  });

  it('refuses an intent outside the closed list', () => {
    // Not "the nearest one" — the rules match stands instead.
    const intent = gate({ intent: 'transfer-money-to-my-account', category: 'Dining' });
    expect(intent.name).toBe('spend-category');
    expect(intent.source).toBe('rules');
  });

  it('refuses a category the user does not have, and says so', () => {
    const intent = gate({ intent: 'spend-category', category: 'Yacht maintenance' });
    expect(intent.unresolved).toContainEqual({ slot: 'category', requested: 'Yacht maintenance' });
    // It did not silently answer about some other category.
    expect(intent.category).not.toBe('Yacht maintenance');
  });

  it('refuses a goal that does not exist', () => {
    const intent = gate({ intent: 'goal-progress', goal: 'Ferrari fund' }, 'am I on track?');
    expect(intent.goal).toBeNull();
    expect(intent.unresolved).toContainEqual(expect.objectContaining({ slot: 'goal', requested: 'Ferrari fund' }));
  });

  it('refuses a loan that does not exist', () => {
    const intent = gate({ intent: 'loan-offset', loan: 'Boat loan' }, 'what is my offset saving?');
    expect(intent.loan).toBeNull();
    expect(intent.unresolved).toContainEqual(expect.objectContaining({ slot: 'loan', requested: 'Boat loan' }));
  });

  it('dates the period itself rather than trusting the model', () => {
    // A model handing over dates is a model computing — the phrase is re-parsed.
    const intent = gate({ intent: 'spend-total', period: 'last month' }, 'what did I spend?');
    expect(intent.period).toMatchObject({ from: '2026-07-01', to: '2026-07-31' });
  });

  it('ignores a period phrase it cannot parse, keeping the rules match', () => {
    const intent = sanitiseIntent(
      { intent: 'spend-total', period: 'around the time of the eclipse' } as never,
      'what did I spend this month?', VOCAB, TODAY,
    );
    expect(intent.period).toMatchObject({ from: '2026-08-01' });
  });

  it('an unknown proposal never overrules a rules match that worked', () => {
    const intent = gate({ intent: 'unknown' });
    expect(intent.name).toBe('spend-category');
    expect(intent.source).toBe('rules');
  });

  it('null, garbage and the wrong shape all fall back cleanly', () => {
    for (const raw of [null, undefined, 'a string', 42, [], { nope: true }]) {
      const intent = gate(raw);
      expect(intent.name).toBe('spend-category');
      expect(intent.source).toBe('rules');
    }
  });

  it('keeps a slot the rules found when the model leaves it empty', () => {
    const intent = gate({ intent: 'spend-category' });
    expect(intent.category).toBe('Dining');   // the rules found it
  });

  it('caps the confidence a model may claim', () => {
    const intent = gate({ intent: 'spend-category', category: 'Dining', confidence: 1 });
    expect(intent.confidence).toBeLessThanOrEqual(1);
    const disagreeing = gate({ intent: 'net-worth', confidence: 1 });
    expect(disagreeing.confidence).toBeLessThanOrEqual(0.9);
  });

  it('accepts a financial year the tax engine knows about, refuses one it does not', () => {
    expect(gate({ intent: 'tax-deductions', financial_year: '2025-2026' }).fy).toBe('2025-2026');
    const bad = gate({ intent: 'tax-deductions', financial_year: 'last decade' });
    expect(bad.unresolved).toContainEqual({ slot: 'financial-year', requested: 'last decade' });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  What the model is allowed to see
// ═════════════════════════════════════════════════════════════════════════════

describe('what is sent to the model', () => {
  it('is names only — no amounts, ids, dates or balances', () => {
    const sent = vocabularyForModel(VOCAB);
    const json = JSON.stringify(sent);
    expect(json).not.toContain('g1');            // no record ids
    expect(json).not.toMatch(/\$|balance|amount/i);
    expect(sent.goals).toEqual(['House deposit', 'Japan trip']);
    expect(sent.categories).toContain('Dining');
  });

  it('never offers "unknown" as something to choose', () => {
    expect(vocabularyForModel(VOCAB).intents).not.toContain('unknown');
  });

  it('every offered intent is one the gate will accept back', () => {
    for (const name of vocabularyForModel(VOCAB).intents) {
      expect(isAskIntent(name)).toBe(true);
    }
  });
});

describe('an empty ledger', () => {
  it('still reads a question without throwing', () => {
    const intent = matchIntent('how much did I spend this month?', emptyVocabulary(), TODAY);
    expect(intent.name).toBe('spend-total');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Follow-ups — the same question with one slot swapped
// ═════════════════════════════════════════════════════════════════════════════

describe('reviseIntent', () => {
  const previous = read('How much did I spend on Dining this year?');

  it('"what about Groceries?" swaps the category and keeps the period', () => {
    const revised = reviseIntent('What about Groceries?', previous, VOCAB, TODAY);
    expect(revised?.name).toBe('spend-category');
    expect(revised?.category).toBe('Groceries');
    expect(revised?.period?.from).toBe('2026-01-01');
    expect(revised?.source).toBe('follow-up');
  });

  it('"and last month?" swaps the period and keeps the category', () => {
    const revised = reviseIntent('and last month?', previous, VOCAB, TODAY);
    expect(revised?.name).toBe('spend-category');
    expect(revised?.category).toBe('Dining');
    expect(revised?.period?.from).toBe('2026-07-01');
    expect(revised?.period?.to).toBe('2026-07-31');
  });

  it('a bare fragment with no opener still reads as a follow-up', () => {
    const revised = reviseIntent('Groceries?', previous, VOCAB, TODAY);
    expect(revised?.category).toBe('Groceries');
  });

  it('a full sentence is a new question, not a revision', () => {
    expect(reviseIntent('I wonder how much groceries normally cost a family', previous, VOCAB, TODAY)).toBeNull();
  });

  it('re-points a goal question at the other goal', () => {
    const goals = read('Am I on track for my House deposit?');
    const revised = reviseIntent('what about the Japan trip?', goals, VOCAB, TODAY);
    expect(revised?.name).toBe('goal-progress');
    expect(revised?.goal?.name).toBe('Japan trip');
  });

  it('re-points a loan question at the other loan', () => {
    const loans = read('When will my Home mortgage be paid off?');
    expect(loans.name).toBe('loan-payoff');
    const revised = reviseIntent('what about the Car loan?', loans, VOCAB, TODAY);
    expect(revised?.name).toBe('loan-payoff');
    expect(revised?.loan?.name).toBe('Car loan');
  });

  it('swaps the financial year on a tax question, and only a year', () => {
    const tax = read('What deductions do I have?');
    const revised = reviseIntent('what about last financial year?', tax, VOCAB, TODAY);
    expect(revised?.fy).toBe('2025-2026');
    // A month means nothing to a tax question — no revision, not a guess.
    expect(reviseIntent('what about last month?', tax, VOCAB, TODAY)).toBeNull();
  });

  it('never revises an unknown or a what-if', () => {
    const unknown = read('Tell me a joke');
    expect(unknown.name).toBe('unknown');
    expect(reviseIntent('what about Groceries?', unknown, VOCAB, TODAY)).toBeNull();
    const whatIf = read('What if I pay $1,000 off my Car loan?');
    expect(whatIf.name).toBe('what-if');
    expect(reviseIntent('what about Groceries?', whatIf, VOCAB, TODAY)).toBeNull();
  });

  it('a slot the previous question cannot carry is no revision', () => {
    // A goal name after a spending question answers nothing — null, not a swap.
    expect(reviseIntent('what about the Japan trip?', previous, VOCAB, TODAY)).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Confident routing: a question Ledger cannot place is not answered as one
//  it can
// ═════════════════════════════════════════════════════════════════════════════

describe('a question nothing matches', () => {
  it('does not become a spending question just because it says "spend"', () => {
    // The word alone says almost nothing, and answering this from the ledger's
    // own spending would answer a question nobody asked.
    expect(read('How much should I spend on a wedding?').name).toBe('unknown');
    expect(read('What is a reasonable amount to spend on rent in Sydney?').name).not.toBe('spend-total');
  });

  it('still reads a loose word when the question names something real', () => {
    expect(read('My Dining spend this month').name).toBe('spend-category');
    expect(read('Spending in July').name).toBe('spend-total');
  });

  it('names the topic when it recognises one it cannot do', () => {
    const advice = read('Should I buy Telstra shares?');
    expect(advice.name).toBe('unknown');
    expect(advice.unsupported).toMatch(/cannot advise/i);

    const market = read('What is bitcoin doing today?');
    expect(market.name).toBe('unknown');
    expect(market.unsupported).toMatch(/only knows your own records/i);

    expect(unsupportedTopic('which health fund is the cheapest?')).toMatch(/compare products/i);
  });

  it('leaves `unsupported` null on a question it CAN answer', () => {
    expect(read('Should I pay off my Car loan?').unsupported).toBeNull();
    expect(read('How much did I spend on Dining this year?').unsupported).toBeNull();
  });
});

describe('insurance is answered from insurance', () => {
  it('routes an insurance question to insurance-cover, never to bills', () => {
    for (const q of [
      'What insurance do I have?',
      'How much is my car insurance costing me?',
      'When does my home policy renew?',
      'What are my premiums?',
      'Am I covered for flood?',
    ]) {
      expect(read(q).name).toBe('insurance-cover');
    }
  });

  it('places a policy by name, and reports one it cannot place', () => {
    expect(read('How much is my Car insurance?').policy?.id).toBe('ip1');

    const missed = read('How much is my boat insurance?');
    expect(missed.name).toBe('insurance-cover');
    expect(missed.policy).toBeNull();
    expect(missed.unresolved).toEqual([
      expect.objectContaining({ slot: 'policy', requested: 'boat insurance' }),
    ]);
  });

  it('reads "my insurance" as the whole question, not as a policy it lacks', () => {
    const all = read('What is my insurance costing me?');
    expect(all.policy).toBeNull();
    expect(all.unresolved).toEqual([]);
    expect(findPolicy('what is my insurance costing me?', VOCAB.policies).requested).toBeNull();
  });

  it('re-points an insurance question at another policy on a follow-up', () => {
    const first = read('How much is my Car insurance?');
    const revised = reviseIntent('what about Home & contents?', first, VOCAB, TODAY);
    expect(revised?.name).toBe('insurance-cover');
    expect(revised?.policy?.id).toBe('ip2');
  });
});

describe('a loan a question names but Ledger cannot place', () => {
  it('is reported rather than answered about every loan', () => {
    const missed = read('When will my boat loan be paid off?');
    expect(missed.name).toBe('loan-payoff');
    expect(missed.loan).toBeNull();
    expect(missed.unresolved).toEqual([
      expect.objectContaining({ slot: 'loan', requested: 'boat loan' }),
    ]);
  });

  it('places one it can', () => {
    expect(read('When will my Car loan be paid off?').loan?.id).toBe('l2');
  });
});

describe('the AI gate holds a hesitant proposal back', () => {
  it('will not place a question the rules could not when it is guessing', () => {
    const base = read('How much should I spend on a wedding?');
    expect(base.name).toBe('unknown');
    const guessed = sanitiseIntent(
      { intent: 'spend-total', confidence: AI_INTENT_FLOOR - 0.1 },
      'How much should I spend on a wedding?', VOCAB, TODAY, base,
    );
    expect(guessed.name).toBe('unknown');
  });

  it('accepts the same proposal when the model is confident', () => {
    const base = read('How much should I spend on a wedding?');
    const sure = sanitiseIntent(
      { intent: 'spend-total', confidence: 0.9 },
      'What did the money go on?', VOCAB, TODAY, base,
    );
    expect(sure.name).toBe('spend-total');
  });

  it('places a policy the model names, and reports one it invents', () => {
    const base = read('Tell me about my cover');
    const placed = sanitiseIntent(
      { intent: 'insurance-cover', policy: 'Car insurance', confidence: 0.9 },
      'Tell me about my cover', VOCAB, TODAY, base,
    );
    expect(placed.policy?.id).toBe('ip1');

    const invented = sanitiseIntent(
      { intent: 'insurance-cover', policy: 'Yacht cover', confidence: 0.9 },
      'Tell me about my cover', VOCAB, TODAY, base,
    );
    expect(invented.policy).toBeNull();
    expect(invented.unresolved).toEqual([
      expect.objectContaining({ slot: 'policy', requested: 'Yacht cover' }),
    ]);
  });
});
