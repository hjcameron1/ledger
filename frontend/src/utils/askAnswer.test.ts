/**
 * Phase 9.1 — the answer, and the guard on how it is worded. Pure.
 *
 * The centre of this file is `checkPhrasing`: the structural stop on a model
 * inventing money. Ledger writes a correct sentence from the facts; a model may
 * reword it; and every number in the rewording is checked against the figures
 * the engines actually produced. A single number that isn't there loses the
 * rewrite — the user reads Ledger's own sentence instead.
 *
 * That is a code path, not a promise in a prompt, so it is tested like one.
 */

import { describe, it, expect } from 'vitest';
import {
  describeAnswer, checkPhrasing, resolvePhrasing, citedValues, numbersIn,
  splitFigures, splitGaps, ASK_LEAD_FIGURES,
  gapsForUnresolved, coverageGap, scopeGap, thinkingMessage,
  type AskAnswer, type AskFacts, type DocumentFactStatement, type DocumentSummary,
} from './askAnswer';
import type { AskIntent, AskIntentName, AskPeriod } from './askIntent';

const YEAR: AskPeriod = {
  kind: 'calendar-year', from: '2026-01-01', to: '2026-08-24', label: 'this year',
};

const DINING: AskFacts = {
  kind: 'spend-category',
  period: YEAR,
  category: 'Dining',
  total: 4238.50,
  count: 96,
  share: 18,
  totalSpend: 23_547,
  merchants: [
    { merchant: 'Uber Eats', total: 980.25, count: 31 },
    { merchant: 'Cornerstone Cafe', total: 612.40, count: 44 },
  ],
  previousTotal: 3010,
  delta: 1228.50,
  perMonth: 530.20,
};

function answerOf(facts: AskFacts, figures: AskAnswer['figures'] = []): AskAnswer {
  return {
    question: 'How much did I spend eating out this year?',
    intent: 'spend-category',
    interpretation: 'rules',
    confidence: 0.8,
    facts,
    headline: describeAnswer(facts, 'AUD'),
    figures,
    sources: [],
    gaps: [],
    period: YEAR,
    scope: 'personal',
    scopeLabel: 'My finances',
    asOf: '2026-08-24',
  };
}

// ═════════════════════════════════════════════════════════════════════════════
//  Ledger's own sentence
// ═════════════════════════════════════════════════════════════════════════════

describe("Ledger's own wording", () => {
  it('states the figure, the window and how many records it counted', () => {
    const text = describeAnswer(DINING, 'AUD');
    expect(text).toContain('4,238.50');
    expect(text).toContain('Dining');
    expect(text).toContain('this year');
    expect(text).toContain('96 transactions');
  });

  it('says so plainly when there is nothing to report', () => {
    const empty: AskFacts = { ...DINING, total: 0, count: 0, merchants: [] };
    expect(describeAnswer(empty, 'AUD')).toMatch(/no Dining spending/i);
  });

  it('answers a goal it cannot find with the miss, not with another goal', () => {
    const facts: AskFacts = {
      kind: 'goal-progress',
      asOf: '2026-08-24',
      goals: [],                        // emptied on purpose — see `unmatched`
      focus: null,
      unmatched: { requested: 'car', suggestions: [], available: ['House deposit'] },
      totalTarget: 0, totalSaved: 0, surplus: null, surplusDays: null,
    };
    const text = describeAnswer(facts, 'AUD');
    expect(text).toMatch(/no goal called "car"/i);
    expect(text).toContain('House deposit');       // listed as what they DO have…
    expect(text).not.toMatch(/saved|of the way|on track/i);   // …never answered about
  });

  it('offers the goals a near miss could have meant', () => {
    const facts: AskFacts = {
      kind: 'goal-progress',
      asOf: '2026-08-24', goals: [], focus: null,
      unmatched: { requested: 'car', suggestions: ['Car fund', 'Car upgrade'], available: ['Car fund', 'Car upgrade'] },
      totalTarget: 0, totalSaved: 0, surplus: null, surplusDays: null,
    };
    expect(describeAnswer(facts, 'AUD')).toBe(
      'Ledger has no goal called "car". Did you mean Car fund and Car upgrade?',
    );
  });

  it('does not list goals to somebody who has none', () => {
    const facts: AskFacts = {
      kind: 'goal-progress',
      asOf: '2026-08-24', goals: [], focus: null,
      unmatched: { requested: 'car', suggestions: [], available: [] },
      totalTarget: 0, totalSaved: 0, surplus: null, surplusDays: null,
    };
    expect(describeAnswer(facts, 'AUD')).toMatch(/no goal called "car".*no savings goals/i);
  });

  it('never claims a goal is on or off track when it cannot know', () => {
    const facts: AskFacts = {
      kind: 'goal-progress',
      asOf: '2026-08-24',
      goals: [{
        id: 'g1', name: 'House deposit', target: 100_000, saved: 25_000, percent: 25,
        status: 'unknown', onTrack: null, targetDate: null, projectedDate: null,
        requiredPerMonth: null, shortfall: 0,
      }],
      focus: null, unmatched: null,
      totalTarget: 100_000, totalSaved: 25_000, surplus: null, surplusDays: null,
    };
    const text = describeAnswer(facts, 'AUD');
    expect(text).toMatch(/cannot say/i);
    expect(text).not.toMatch(/you are on track/i);
  });

  it('names the broken offset link rather than reporting a saving that isn\'t happening', () => {
    const facts: AskFacts = {
      kind: 'loan-offset',
      unmatched: null,
      loans: [{
        loanId: 'l1', loanName: 'Home mortgage', balance: 500_000, offset: 0,
        effectiveBalance: 500_000, rate: 6, savingPerYear: 0, savingPerMonth: 0,
        accountName: null, linked: true, linkBroken: true,
      }],
      totalOffset: 0, totalSavingPerYear: 0, totalSavingPerMonth: 0,
    };
    expect(describeAnswer(facts, 'AUD')).toMatch(/can no longer find/i);
  });

  it('reports an unanswerable question as unanswerable', () => {
    const facts: AskFacts = { kind: 'unknown', reason: 'Ledger could not tell what that is asking.' };
    expect(describeAnswer(facts, 'AUD')).toBe('Ledger could not tell what that is asking.');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  THE GUARD
// ═════════════════════════════════════════════════════════════════════════════

describe('checking a model’s wording against the facts', () => {
  const answer = answerOf(DINING, [
    { key: 'total', label: 'Dining · this year', value: 4238.50, kind: 'money', emphasis: true },
    { key: 'count', label: 'Transactions', value: 96, kind: 'count' },
    { key: 'share', label: 'Share of all spending', value: 18, kind: 'percent' },
  ]);

  it('accepts a rewording that only restates the figures', () => {
    const prose = 'Eating out came to $4,238.50 this year across 96 transactions — about 18% of everything you spent.';
    expect(checkPhrasing(prose, answer).ok).toBe(true);
  });

  it('accepts a figure rounded to the dollar', () => {
    expect(checkPhrasing('You spent $4,239 on Dining.', answer).ok).toBe(true);
  });

  it('REJECTS an invented dollar figure', () => {
    const check = checkPhrasing('You spent $4,238.50 this year, or roughly $86 a week.', answer);
    expect(check.ok).toBe(false);
    expect(check.invented).toContain(86);
  });

  it('REJECTS an invented percentage', () => {
    // The plausible-sounding fabrication this guard exists for.
    const check = checkPhrasing('Dining is 30% of your spending.', answer);
    expect(check.ok).toBe(false);
    expect(check.invented).toContain(30);
  });

  it('REJECTS an extrapolation the engines never made', () => {
    const check = checkPhrasing('At this rate you will spend $6,500 by December.', answer);
    expect(check.ok).toBe(false);
  });

  it('REJECTS a made-up date', () => {
    const check = checkPhrasing('Most of it landed in 2024.', answer);
    expect(check.ok).toBe(false);
    expect(check.invented).toContain(2024);
  });

  it('allows a small counting word when the answer has a list that long', () => {
    // "the top 2 merchants" — there are exactly 2 merchants in the facts.
    expect(checkPhrasing('Your top 2 places were Uber Eats and Cornerstone Cafe.', answer).ok).toBe(true);
  });

  it('does not let a counting word smuggle in a money figure', () => {
    expect(checkPhrasing('That is about $9 per meal.', answer).ok).toBe(false);
  });

  it('counts every number in the facts as quotable, not just the figures', () => {
    // The per-merchant totals are in `facts` but not in `figures`.
    expect(checkPhrasing('Uber Eats alone was $980.25 over 31 orders.', answer).ok).toBe(true);
  });

  it('lets the answer quote numbers from the question itself', () => {
    const a = { ...answer, question: 'How much did I spend on dining in the last 90 days?' };
    expect(checkPhrasing('Over those 90 days you spent $4,238.50.', a).ok).toBe(true);
  });
});

describe('choosing which wording the user reads', () => {
  const answer = answerOf(DINING, [
    { key: 'total', label: 'Dining', value: 4238.50, kind: 'money', emphasis: true },
  ]);

  it('uses the model’s wording when it passes', () => {
    const result = resolvePhrasing(answer, 'Eating out cost you $4,238.50 this year.');
    expect(result.source).toBe('ai');
    expect(result.text).toContain('4,238.50');
  });

  it('falls back to Ledger’s wording when it does not', () => {
    const result = resolvePhrasing(answer, 'Eating out cost about $5,000 this year.');
    expect(result.source).toBe('ledger');
    expect(result.text).toBe(answer.headline);
    expect(result.rejected).toContain(5000);
  });

  it('falls back when the model returns nothing at all', () => {
    for (const empty of [null, undefined, '', '   ']) {
      expect(resolvePhrasing(answer, empty).source).toBe('ledger');
    }
  });

  it('falls back when the model pads with narrative', () => {
    const waffle = `${answer.headline} `.repeat(60);
    expect(resolvePhrasing(answer, waffle).source).toBe('ledger');
  });

  it('the fallback is always a correct sentence, never an error', () => {
    const result = resolvePhrasing(answer, 'Completely made up: $1.23, $4.56, 78%.');
    expect(result.text).toBe(describeAnswer(DINING, 'AUD'));
  });
});

describe('the numbers an answer is allowed to state', () => {
  it('gathers every leaf figure out of the facts', () => {
    const values = citedValues(answerOf(DINING));
    expect(values).toContain(4238.50);
    expect(values).toContain(980.25);   // a merchant total, nested two levels down
    expect(values).toContain(96);
  });

  it('reads numbers out of formatted text', () => {
    expect(numbersIn('$1,234.56 and 12% on 2026-08-24'))
      .toEqual([1234.56, 12, 2026, 8, 24]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Gaps — what Ledger doesn't know, said out loud
// ═════════════════════════════════════════════════════════════════════════════

describe('reporting what could not be resolved', () => {
  it('turns a missing goal into a plain statement', () => {
    const gaps = gapsForUnresolved([{ slot: 'goal', requested: 'Ferrari fund' }]);
    expect(gaps[0].kind).toBe('unresolved');
    expect(gaps[0].message).toContain('Ferrari fund');
  });

  it('asks "did you mean" rather than choosing for the user', () => {
    const gaps = gapsForUnresolved([
      { slot: 'goal', requested: 'car', suggestions: ['Car fund'], available: ['Car fund', 'House deposit'] },
    ]);
    expect(gaps[0].message).toBe('Ledger has no goal called "car". Did you mean Car fund?');
  });

  it('lists what the user does have when nothing is close', () => {
    const gaps = gapsForUnresolved([
      { slot: 'goal', requested: 'car', suggestions: [], available: ['House deposit'] },
    ]);
    expect(gaps[0].message).toBe('Ledger has no goal called "car". Your goal is House deposit.');
  });

  it('says an empty account is empty instead of listing nothing', () => {
    const gaps = gapsForUnresolved([{ slot: 'goal', requested: 'car', suggestions: [], available: [] }]);
    expect(gaps[0].message).toMatch(/no savings goals in Ledger yet/i);
  });

  it('does not repeat the same gap twice', () => {
    const gaps = gapsForUnresolved([
      { slot: 'loan', requested: 'Boat loan' },
      { slot: 'loan', requested: 'boat loan' },
    ]);
    expect(gaps).toHaveLength(1);
  });

  it('flags a question reaching past the loaded history', () => {
    const gap = coverageGap(YEAR, '2026-05-01');
    expect(gap?.kind).toBe('partial-history');
    expect(gap?.message).toContain('May 2026');
  });

  it('stays quiet when the history covers the whole window', () => {
    expect(coverageGap(YEAR, '2025-01-01')).toBeNull();
  });

  it('always qualifies "all time"', () => {
    const gap = coverageGap({ ...YEAR, kind: 'all-time', from: '0001-01-01' }, '2026-05-01');
    expect(gap?.kind).toBe('partial-history');
  });

  it('says which view a household answer covers', () => {
    expect(scopeGap('household', 'Ada & Bo', true)?.message).toContain('Ada & Bo');
  });

  it('tells a household member that a personal answer is only theirs', () => {
    expect(scopeGap('personal', 'Ada & Bo', true)?.message).toMatch(/your own records only/i);
  });

  it('says nothing about scope to somebody with no household', () => {
    expect(scopeGap('personal', null, false)).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Lead vs detail — the answer is 2–4 facts, everything else is one tap away
// ═════════════════════════════════════════════════════════════════════════════

describe('splitFigures', () => {
  const fig = (key: string, o: Partial<AskAnswer['figures'][number]> = {}) =>
    ({ key, label: key, value: 1, kind: 'money' as const, ...o });

  it('separates flagged detail figures from the lead', () => {
    const { lead, detail } = splitFigures([fig('a'), fig('b', { detail: true }), fig('c')]);
    expect(lead.map(f => f.key)).toEqual(['a', 'c']);
    expect(detail.map(f => f.key)).toEqual(['b']);
  });

  it('caps the lead at four whatever a builder sends, keeping the emphasis figure', () => {
    const { lead, detail } = splitFigures([
      fig('a'), fig('b'), fig('c'), fig('d'), fig('e', { emphasis: true }), fig('f'),
      fig('g', { detail: true }),
    ]);
    expect(lead).toHaveLength(ASK_LEAD_FIGURES);
    expect(lead.some(f => f.emphasis)).toBe(true);
    // Overflow is demoted, never dropped — ahead of the already-flagged detail.
    expect(detail.map(f => f.key)).toEqual(['d', 'f', 'g']);
  });

  it('leaves a small answer alone', () => {
    const { lead, detail } = splitFigures([fig('a', { emphasis: true }), fig('b')]);
    expect(lead).toHaveLength(2);
    expect(detail).toHaveLength(0);
  });
});

describe('splitGaps', () => {
  it('keeps meaning-changing gaps with the answer and demotes advisory notes', () => {
    const { lead, detail } = splitGaps([
      { kind: 'no-data', message: 'nothing recorded' },
      { kind: 'scope', message: 'personal view' },
      { kind: 'unresolved', message: 'no such goal' },
      { kind: 'incomplete-record', message: 'no target date' },
      { kind: 'partial-history', message: 'history starts later' },
      { kind: 'conflict', message: 'two records disagree' },
      { kind: 'unsupported', message: 'cannot answer' },
    ]);
    expect(lead.map(g => g.kind)).toEqual(['no-data', 'unresolved', 'partial-history', 'conflict', 'unsupported']);
    expect(detail.map(g => g.kind)).toEqual(['scope', 'incomplete-record']);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  While the answer is being worked out
// ═════════════════════════════════════════════════════════════════════════════

const intentOf = (name: AskIntentName, over: Partial<AskIntent> = {}): AskIntent => ({
  name, question: 'q', period: null, category: null, merchant: null, goal: null, loan: null,
  policy: null, document: null, property: null, fy: null, whatIf: null, unresolved: [],
  unsupported: null, source: 'rules', confidence: 1, ...over,
});

describe('what Ledger says while it is working', () => {
  it('names the document it is reading', () => {
    expect(thinkingMessage(intentOf('document-facts', {
      document: { id: 'doc-1', name: 'NRMA renewal.pdf' },
    }))).toBe('Reading what NRMA renewal.pdf says…');
    expect(thinkingMessage(intentOf('document-facts'))).toBe('Checking your documents…');
  });

  it('names the thing being looked at', () => {
    expect(thinkingMessage(intentOf('insurance-cover'))).toBe('Checking your insurance…');
    expect(thinkingMessage(intentOf('what-if'))).toBe('Running that scenario…');
    expect(thinkingMessage(intentOf('budget-status'))).toBe('Checking your budgets…');
    expect(thinkingMessage(intentOf('forecast-outlook'))).toBe('Projecting your cash flow…');
  });

  it('uses the record or category the question named', () => {
    expect(thinkingMessage(intentOf('spend-category', { category: 'Dining' })))
      .toBe('Adding up your Dining spending…');
    expect(thinkingMessage(intentOf('insurance-cover', { policy: { id: 'p1', name: 'Car' } })))
      .toBe('Checking your Car cover…');
    expect(thinkingMessage(intentOf('goal-progress', { goal: { id: 'g1', name: 'Japan trip' } })))
      .toBe('Checking Japan trip…');
  });

  it('says a follow-up hypothetical is being compared, not just run', () => {
    const followUp = intentOf('what-if', {
      whatIf: { scenario: null, reading: [], unresolved: [], reason: null, followUp: true, previous: null },
    });
    expect(thinkingMessage(followUp)).toBe('Comparing that with the last one…');
  });

  it('says something honest before the question has been read at all', () => {
    expect(thinkingMessage(null)).toBe('Reading your question…');
    expect(thinkingMessage(intentOf('unknown'))).toBe('Reading your question…');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Insurance
// ═════════════════════════════════════════════════════════════════════════════

const policy = (over: Partial<AskFacts & { kind: 'insurance-cover' }> = {}): AskFacts => ({
  kind: 'insurance-cover',
  asOf: '2026-08-24',
  focus: null,
  unmatched: null,
  policies: [{
    id: 'ip1', name: 'Car insurance', type: 'Car', insurer: 'NRMA',
    premium: 110, frequency: 'monthly', annualPremium: 1320, monthlyPremium: 110,
    renewalDate: '2027-03-03', daysToRenewal: 191, excess: 800,
    coverageAmount: null, status: 'active', premiumChange: null, hasDocument: false,
  }],
  totalAnnual: 1320,
  totalMonthly: 110,
  totalCoverage: 0,
  nextRenewal: { name: 'Car insurance', date: '2027-03-03', days: 191 },
  expired: [],
  documents: [],
  documentsOnly: false,
  documentFacts: [],
  documentFactsToConfirm: [],
  ...over,
} as AskFacts);

describe('what Ledger says about cover', () => {
  it('leads with what one policy costs and when it renews', () => {
    const text = describeAnswer(policy(), 'AUD');
    expect(text).toMatch(/Car insurance costs \$1,320.00 a year/);
    expect(text).toMatch(/\$110.00 a month/);
    expect(text).toMatch(/renews on/i);
  });

  it('says there is paperwork it has NOT read, and invents nothing from it', () => {
    const text = describeAnswer(policy({
      policies: [], totalAnnual: 0, totalMonthly: 0, nextRenewal: null,
      documents: [{ name: 'NRMA renewal.pdf', date: '2026-03-01', provider: 'NRMA' }],
      documentsOnly: true,
    }), 'AUD');
    expect(text).toMatch(/no insurance policies recorded/i);
    expect(text).toMatch(/NRMA renewal\.pdf/);
    // Unread paperwork offers to be read — it never describes itself.
    expect(text).toMatch(/have Ledger read/i);
    // Nothing about what the cover is, costs, or when it renews.
    expect(text).not.toMatch(/\$/);
    expect(text).not.toMatch(/renews on/i);
  });

  it('says nothing at all is on file when nothing is', () => {
    const text = describeAnswer(policy({
      policies: [], totalAnnual: 0, totalMonthly: 0, nextRenewal: null,
    }), 'AUD');
    expect(text).toMatch(/no insurance policies/i);
    expect(text).toMatch(/no insurance paperwork/i);
  });

  it('reports a policy it cannot place instead of pricing a different one', () => {
    const text = describeAnswer(policy({
      unmatched: { requested: 'boat insurance', suggestions: [], available: ['Car insurance'] },
      policies: [], totalAnnual: 0, totalMonthly: 0, nextRenewal: null,
    }), 'AUD');
    expect(text).toBe('Ledger has no policy called "boat insurance". Your policy is Car insurance.');
    expect(text).not.toMatch(/1,320/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Phase 8.3 — what a document says
// ═════════════════════════════════════════════════════════════════════════════

const reading = (over: Partial<DocumentFactStatement> = {}): DocumentFactStatement => ({
  field: 'renewal_date', label: 'Renews', kind: 'date',
  text: '2027-03-03', number: null, date: '2027-03-03',
  quote: 'Period of cover ends 3 March 2027', page: 1,
  confidence: 0.94, status: 'unconfirmed', source: 'model',
  usable: true, needsConfirmation: false, ...over,
});

const premium = reading({
  field: 'premium_amount', label: 'Premium', kind: 'money',
  text: '1240.50', number: 1240.5, date: null,
  quote: 'Total premium $1,240.50', confidence: 0.91,
});

const doc = (over: Partial<DocumentSummary> = {}): DocumentSummary => ({
  id: 'doc-1', name: 'NRMA renewal.pdf', type: 'insurance',
  provider: 'NRMA', date: '2026-03-01', read: 'read', readable: true, owned: true, ...over,
});

const said = (over: Partial<Extract<AskFacts, { kind: 'document-facts' }>> = {}): AskFacts => ({
  kind: 'document-facts', asOf: '2026-08-24', unmatched: null,
  document: doc(), facts: [reading(), premium], toConfirm: [],
  read: [doc()], unread: [], total: 1, ...over,
} as AskFacts);

describe('what Ledger says a document says', () => {
  it('quotes the document, and says the figures are the document\'s', () => {
    const text = describeAnswer(said(), 'AUD');
    expect(text).toMatch(/NRMA renewal\.pdf says/);
    expect(text).toMatch(/renews 3 March 2027/);
    expect(text).toMatch(/premium \$1,240\.50/);
    expect(text).toMatch(/quoted from the document itself/i);
  });

  it('says a document has not been read rather than describing it', () => {
    const text = describeAnswer(said({
      facts: [], toConfirm: [], read: [], unread: [doc({ read: 'unread' })],
      document: doc({ read: 'unread' }),
    }), 'AUD');
    expect(text).toMatch(/has not been read yet|not read/i);
    expect(text).toMatch(/Read this document/);
    // Nothing about renewal dates, premiums or cover — it has not looked.
    expect(text).not.toMatch(/\$/);
    expect(text).not.toMatch(/2027/);
  });

  it('says it read the document and found nothing, which is not the same thing', () => {
    const text = describeAnswer(said({
      facts: [], toConfirm: [], read: [], unread: [doc()],
      document: doc({ read: 'nothing-found' }),
    }), 'AUD');
    expect(text).toMatch(/read .* and found none of the details/i);
    expect(text).not.toMatch(/\$/);
  });

  it('tells a viewer a shared document waits on its owner — never to go read it', () => {
    // From the viewer's seat, "not read" and "read but unconfirmed" are the
    // same fact: nothing confirmed yet. The owner's workflow is not narrated,
    // and reading is never offered as something the viewer could do.
    for (const read of ['unread', 'read', 'nothing-found'] as const) {
      const text = describeAnswer(said({
        facts: [], toConfirm: [], read: [], unread: [],
        document: doc({ owned: false, read }),
      }), 'AUD');
      expect(text).toMatch(/shared with you/i);
      expect(text).toMatch(/confirmed by its owner/i);
      expect(text).not.toMatch(/Read this document/);
      expect(text).not.toMatch(/found none of the details/);
    }
  });

  it('will not state a reading it is unsure of — it asks for it to be confirmed', () => {
    const shaky = reading({ confidence: 0.5, usable: false, needsConfirmation: true });
    const text = describeAnswer(said({ facts: [], toConfirm: [shaky] }), 'AUD');
    expect(text).toMatch(/not sure enough/i);
    expect(text).toMatch(/confirm/i);
    // The unconfirmed value itself is never stated as fact.
    expect(text).not.toMatch(/3 March 2027/);
  });

  it('mentions what is still waiting, beside what it can state', () => {
    const shaky = reading({
      field: 'excess', label: 'Excess', kind: 'money',
      text: '750', number: 750, date: null, quote: 'Excess $750',
      confidence: 0.4, usable: false, needsConfirmation: true,
    });
    const text = describeAnswer(said({ facts: [reading()], toConfirm: [shaky] }), 'AUD');
    expect(text).toMatch(/renews 3 March 2027/);
    expect(text).toMatch(/1 reading is waiting for you to confirm/);
  });

  it('reports a document it cannot place instead of reading a different one', () => {
    const text = describeAnswer(said({
      unmatched: { requested: 'AAMI policy', suggestions: [], available: ['NRMA renewal.pdf'] },
    }), 'AUD');
    expect(text).toBe('Ledger has no document called "AAMI policy". Your document is NRMA renewal.pdf.');
  });

  it('says the vault is empty when it is', () => {
    const text = describeAnswer(said({
      document: null, facts: [], toConfirm: [], read: [], unread: [], total: 0,
    }), 'AUD');
    expect(text).toMatch(/nothing in your document vault/i);
  });

  it('names what it has read when the question named nothing', () => {
    const text = describeAnswer(said({ document: null, facts: [], toConfirm: [] }), 'AUD');
    expect(text).toMatch(/Ledger has read 1 document/);
    expect(text).toMatch(/NRMA renewal\.pdf/);
  });
});

describe('cover answered out of paperwork', () => {
  it('states what the document says, and refuses to call it a policy', () => {
    const text = describeAnswer(policy({
      policies: [], totalAnnual: 0, totalMonthly: 0, nextRenewal: null,
      documents: [{ name: 'NRMA renewal.pdf', date: '2026-03-01', provider: 'NRMA' }],
      documentsOnly: true,
      documentFacts: [{ document: 'NRMA renewal.pdf', facts: [reading(), premium] }],
    }), 'AUD');
    expect(text).toMatch(/no insurance policy recorded/i);
    expect(text).toMatch(/renews 3 March 2027/);
    expect(text).toMatch(/premium \$1,240\.50/);
    // The one thing it must never do: turn a quoted premium into cover Ledger
    // holds, or into a yearly cost it can compare with anything.
    expect(text).toMatch(/document's own words, not a policy/i);
    expect(text).not.toMatch(/a year/);
  });

  it('says what is still waiting on the user', () => {
    const shaky = reading({ field: 'excess', label: 'Excess', kind: 'money', text: '750', number: 750, date: null, quote: 'Excess $750', confidence: 0.4, usable: false, needsConfirmation: true });
    const text = describeAnswer(policy({
      policies: [], totalAnnual: 0, totalMonthly: 0, nextRenewal: null,
      documents: [{ name: 'NRMA renewal.pdf', date: null, provider: null }],
      documentsOnly: true,
      documentFacts: [{ document: 'NRMA renewal.pdf', facts: [reading()] }],
      documentFactsToConfirm: [{ document: 'NRMA renewal.pdf', facts: [shaky] }],
    }), 'AUD');
    expect(text).toMatch(/1 more reading is waiting for you to confirm/);
    expect(text).not.toMatch(/750/);
  });
});
