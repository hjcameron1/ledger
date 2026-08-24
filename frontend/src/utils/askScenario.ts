/**
 * Phase 9.3 — reading a WHAT-IF question. PURE.
 *
 * "What happens if I pay $1,000 off my car loan right now?" is a question about
 * records Ledger already holds, asked in a shape none of the other intents fit:
 * it describes a CHANGE. This module turns that sentence into a `Scenario` —
 * the same object the scenario engine has always taken — and nothing else.
 *
 * The rules that make it safe are the rules the rest of Ask Ledger runs on:
 *
 *   1. **Every figure comes from the user's own sentence.** The amounts are
 *      read out of the question by the regexes below. No model is consulted
 *      here (`vocabularyForModel` does not even offer `what-if`), so there is
 *      nothing for a model to invent.
 *   2. **A record the question names is resolved or reported — never guessed.**
 *      Loans and goals go through the same `matchEntity` gate every other
 *      intent uses, and a name that cannot be placed comes back as an
 *      `UnresolvedSlot`, with `scenario` left NULL. Ledger would rather answer
 *      "you have no loan called that" than model the wrong loan.
 *   3. **How the question was read is always said out loud.** `reading` holds
 *      one sentence per change: the cadence assumed, the conversion made, the
 *      date used. An assumption the user cannot see is an assumption they
 *      cannot correct.
 *
 * Nothing here computes money. A percentage stays a percentage until the
 * scenario engine resolves it against the user's real baselines — this module
 * only ever converts a stated cadence into another stated cadence, which is
 * arithmetic about the QUESTION, not about the ledger.
 */

import {
  findEntityInText, lookupGoal, matchEntity, matchIntent, resolveCategory,
  type AskIntent, type AskLoanEntity, type AskVocabulary, type NamedEntity, type UnresolvedSlot,
} from './askIntent';
import { monthlyEquivalent } from './adaptiveForecast';
import { addDays, round2 } from './cashFlowForecast';
import type { RepaymentFrequency } from '../types';
import type { Scenario, ScenarioChange, ScenarioFrequency } from './scenario';

/** What Ledger made of a hypothetical. */
export interface WhatIfReading {
  /** The scenario to run, or null when nothing could be read from the question. */
  scenario: Scenario | null;
  /** One line per change: exactly how the question was read. */
  reading: string[];
  /** Records the question named that Ledger could not place. */
  unresolved: UnresolvedSlot[];
  /** Why nothing was read, when nothing was. Null when a scenario came out. */
  reason: string | null;
  /** True when this is a re-run of the previous question with a new figure. */
  followUp: boolean;
}

// ─── Reading the sentence ────────────────────────────────────────────────────

function norm(s: string): string {
  return String(s ?? '').trim().toLowerCase().replace(/[’]/g, "'").replace(/\s+/g, ' ');
}

/** Money, as a number a sentence can carry without a currency symbol. */
function money(n: number): string {
  return Math.abs(round2(n)).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

const MULTIPLIER: Record<string, number> = { k: 1000, m: 1000000 };

/**
 * The amount of money a clause states, or null.
 *
 * A `$` (or a "dollars", or a "k") makes a figure money beyond doubt. A bare
 * number only counts at three digits or more, and never when it is a duration
 * or a year — "in 2026" and "over 3 years" are not amounts, and reading either
 * as one would answer a question nobody asked.
 */
export function moneyIn(text: string): number | null {
  const t = norm(text).replace(/,(?=\d{3}\b)/g, '');

  const scaled = (raw: string, suffix?: string): number => {
    const n = Number(raw);
    if (!Number.isFinite(n)) return NaN;
    return n * (suffix ? MULTIPLIER[suffix] ?? 1 : 1);
  };

  const dollars = t.match(/\$\s*(\d+(?:\.\d+)?)\s*(k|m)?/);
  if (dollars) {
    const n = scaled(dollars[1], dollars[2]);
    if (Number.isFinite(n)) return n;
  }

  const suffixed = t.match(/\b(\d+(?:\.\d+)?)\s*(k|m)\b/);
  if (suffixed) {
    const n = scaled(suffixed[1], suffixed[2]);
    if (Number.isFinite(n)) return n;
  }

  const spelled = t.match(/\b(\d+(?:\.\d+)?)\s*(?:dollars|bucks)\b/);
  if (spelled) return Number(spelled[1]);

  const bare = /(?<![$\d.])\b(\d{3,}(?:\.\d+)?)\b(?!\s*(?:%|per ?cent|percent|years?|months?|weeks?|days?|k\b|m\b))/g;
  let m: RegExpExecArray | null;
  while ((m = bare.exec(t)) !== null) {
    const before = t.slice(0, m.index);
    // A year is a window, not an amount.
    if (/\b(?:in|since|during|before|after|by|fy|from)\s+$/.test(before)) continue;
    const n = Number(m[1]);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/** The percentage a clause states, signed by its own minus only. */
export function percentIn(text: string): number | null {
  const m = norm(text).match(/(\d+(?:\.\d+)?)\s*(?:%|per ?cent|percent)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

const CADENCES: [RegExp, ScenarioFrequency][] = [
  [/\b(?:fortnightly|biweekly|bi-weekly|every (?:two|2) weeks|a fortnight|per fortnight|each fortnight|every fortnight)\b/, 'fortnightly'],
  [/\b(?:weekly|a week|per week|each week|every week|p\/w)\b/, 'weekly'],
  [/\b(?:quarterly|a quarter|per quarter|each quarter|every quarter)\b/, 'quarterly'],
  [/\b(?:yearly|annually|annual|a year|per year|each year|every year|per annum|p\.?a\.?)\b/, 'annually'],
  [/\b(?:monthly|a month|per month|each month|every month|p\/m|pm\b)\b/, 'monthly'],
];

/** The cadence a clause states, or null when it states none. */
export function cadenceIn(text: string): ScenarioFrequency | null {
  const t = norm(text);
  for (const [re, freq] of CADENCES) if (re.test(t)) return freq;
  return null;
}

/** How a cadence reads as an adjective — "a new fortnightly commitment". */
const CADENCE_WORD: Record<ScenarioFrequency, string> = {
  once: 'one-off',
  weekly: 'weekly',
  fortnightly: 'fortnightly',
  monthly: 'monthly',
  quarterly: 'quarterly',
  annually: 'yearly',
};

const PERIOD_WORD: Record<ScenarioFrequency, string> = {
  once: 'payment',
  weekly: 'week',
  fortnightly: 'fortnight',
  monthly: 'month',
  quarterly: 'quarter',
  annually: 'year',
};

/** How many of a cadence make a month — the only conversion this module does. */
function toMonthly(amount: number, cadence: ScenarioFrequency | null): number {
  if (!cadence || cadence === 'once') return amount;
  return round2(monthlyEquivalent(amount, cadence));
}

const LESS = /\b(?:less|lower|down|cut|cutting|reduce|reducing|reduced|drop|dropping|dropped|save|saving|slash\w*|trim\w*|stop|quit)\b/;
const MORE = /\b(?:more|extra|additional|higher|up|increase|increasing|increased|rise|rises|raise|raised|another|add|adding)\b/;

/** +1 for more, −1 for less, null when the clause does not say. */
function directionIn(text: string): 1 | -1 | null {
  const t = norm(text);
  const less = LESS.test(t);
  const more = MORE.test(t);
  if (less && !more) return -1;
  if (more && !less) return 1;
  return null;
}

// ─── Naming the record the question is about ─────────────────────────────────

const LOAN_WORD = /\b(?:loans?|mortgages?|debts?|hecs|help debt)\b/;

interface Hit<T> {
  entity: T | null;
  requested: string | null;
  suggestions: string[];
}

/** Trim the words that describe a payment rather than name a record. */
function tidyName(raw: string): string | null {
  const s = norm(raw)
    .replace(/\b(?:right now|now|today|straight away|instead|as well|too)\b.*$/, '')
    .replace(/[?.!,]+$/, '')
    .trim();
  return s.length >= 2 ? s : null;
}

/**
 * The goal a "save $300 a month toward my car goal" question names.
 *
 * `goalSubject` reads a question shaped like "how is my X goal going", and a
 * what-if sentence puts a cadence in front of the same words. Trimming back to
 * what follows the preposition is only ever used to SAY what could not be
 * placed — never to place it.
 */
function tidyGoalRequest(raw: string): string {
  const m = norm(raw).match(/\b(?:towards?|into|for|at)\s+(.+)$/);
  const s = (m ? m[1] : raw).replace(/^(?:my|our|the|a|an)\s+/, '').trim();
  return s || raw;
}

/** Words that say what KIND of thing a loan is, never which one. */
const LOAN_KIND_WORDS = new Set([
  'my', 'our', 'the', 'a', 'an', 'loan', 'loans', 'mortgage', 'mortgages',
  'debt', 'debts', 'repayment', 'repayments', 'offset', 'account', 'balance',
]);

/** The words a clause uses for a loan, when it names one indirectly. */
export function loanSubject(text: string): string | null {
  const t = norm(text);
  const patterns = [
    /\b(?:my|the|our)\s+([a-z][a-z '-]{0,24}?\b(?:loans?|mortgages?|debts?))\b/,
    /\b(?:off|onto|towards?|into|against|on)\s+(?:my|the|our)\s+([a-z][a-z '-]{1,24}?)(?=\s+(?:right|now|today|instead|each|every|per|a|this|and)\b|[?.,]|$)/,
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (!m) continue;
    const name = tidyName(m[1]);
    if (name) return name;
  }
  return null;
}

/**
 * Which loan a clause is about.
 *
 * The same three outcomes every named record in Ask Ledger has: resolved, or
 * reported with what it might have meant, or reported as absent. Being the only
 * loan on file earns nothing — a question about "the car loan" from somebody
 * whose one loan is a mortgage is a question about a loan they do not have.
 */
export function findLoan(text: string, loans: AskLoanEntity[]): Hit<AskLoanEntity> {
  const byId = (e: NamedEntity | null) => (e ? loans.find(l => l.id === e.id) ?? null : null);

  const verbatim = byId(findEntityInText(text, loans));
  if (verbatim) return { entity: verbatim, requested: null, suggestions: [] };

  const subject = loanSubject(text);
  if (!subject) return { entity: null, requested: null, suggestions: [] };

  // "my loan", "the mortgage" — kind words with nothing distinguishing in them.
  // With one loan on file that is not a guess; with two it is, so Ledger asks.
  if (subject.split(' ').every(w => LOAN_KIND_WORDS.has(w))) {
    if (loans.length === 1) return { entity: loans[0], requested: null, suggestions: [] };
    return { entity: null, requested: subject, suggestions: loans.map(l => l.name) };
  }

  const match = matchEntity(subject, loans);
  if (match.kind === 'resolved') return { entity: byId(match.entity), requested: null, suggestions: [] };
  if (match.kind === 'near') {
    return { entity: null, requested: subject, suggestions: match.candidates.map(c => c.name) };
  }
  return { entity: null, requested: subject, suggestions: [] };
}

/** The words a clause uses for a purchase or a commitment. */
function subjectAfter(text: string, verbs: string): string | null {
  const t = norm(text);
  const re = new RegExp(
    `\\b(?:${verbs})\\s+(?:a|an|the|some|another|new|my|myself a)?\\s*([a-z][a-z0-9' -]{1,30}?)`
    + `(?=\\s+(?:for|at|costing|worth|which|that|every|each|per|a month|a week|instead)\\b|[?.,$]|\\s*$)`,
  );
  const m = t.match(re);
  if (!m) return null;
  const name = tidyName(m[1]);
  if (!name) return null;
  // A bare figure or filler names nothing.
  if (/^(?:it|that|this|one|thing|things|stuff|more|less|\d+)$/.test(name)) return null;
  return name;
}

/** Sentence case, so a change reads as a label rather than as typing. */
function titled(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ─── One clause → one change ────────────────────────────────────────────────

interface Ctx {
  vocab: AskVocabulary;
  asOf: string;
  reading: string[];
  unresolved: UnresolvedSlot[];
  /** A better explanation than the generic one, when a clause earns one. */
  reason: string | null;
}

function unresolve(ctx: Ctx, slot: UnresolvedSlot['slot'], hit: { requested: string | null; suggestions: string[] }, available: string[]) {
  if (!hit.requested) return;
  if (ctx.unresolved.some(u => u.slot === slot && u.requested === hit.requested)) return;
  ctx.unresolved.push({ slot, requested: hit.requested, suggestions: hit.suggestions, available });
}

const PAY_DOWN = /\b(?:pay|paying|paid|put|putting|throw|throwing|chuck|chip|knock|clear|repay|repaying|overpay|dump)\b/;
const OFFSET_WORD = /\boffset\b/;
const INCOME_WORD = /\b(?:pay ?ris\w*|payris\w*|raise|salary|wage|wages|income|earn|earning|earnings|paid more|paid less|pay cut|promotion|bonus pay)\b/;
const SPEND_WORD = /\b(?:spend|spending|spent)\b/;
const BUY_WORD = /\b(?:buy|buying|bought|purchase|purchasing|get|getting|order|book)\b/;
const WINDFALL_WORD = /\b(?:bonus|windfall|inheritance|tax refund|refund|gift|lump sum in|come into)\b/;
const COMMIT_WORD = /\b(?:subscription|membership|gym|plan|payment|bill|expense|rent|insurance|repayments?|childcare|lease)\b/;
const SAVE_WORD = /\b(?:save|saving|savings|put|contribute|contributing|add|adding|toward|towards)\b/;

/**
 * Read one clause as one change.
 *
 * Order is deliberate: the most specific reading wins. A clause that names a
 * loan and a payment is about that loan, never about "a purchase of $1,000".
 */
function readClause(clause: string, ctx: Ctx, index: number): ScenarioChange | null {
  const t = norm(clause);
  const id = `whatif-${index + 1}`;
  const amount = moneyIn(t);
  const percent = percentIn(t);
  const cadence = cadenceIn(t);
  const direction = directionIn(t);

  const loanHit = LOAN_WORD.test(t) || PAY_DOWN.test(t) || OFFSET_WORD.test(t)
    ? findLoan(t, ctx.vocab.loans)
    : { entity: null, requested: null, suggestions: [] } as Hit<AskLoanEntity>;
  const loanNames = ctx.vocab.loans.map(l => l.name);

  // ── An offset ──
  if (OFFSET_WORD.test(t) && (amount != null)) {
    if (!loanHit.entity) {
      // One loan with an offset is not "the offset" by default — but a question
      // that names no loan at all, with only one loan on file, is unambiguous.
      const only = ctx.vocab.loans.length === 1 && !loanHit.requested ? ctx.vocab.loans[0] : null;
      if (!only) {
        unresolve(ctx, 'loan', loanHit, loanNames);
        if (!loanHit.requested) {
          ctx.reason = loanNames.length
            ? `Which loan's offset? Ledger has ${loanNames.join(', ')}.`
            : 'Ledger has no loans, so there is no offset to change.';
        }
        return null;
      }
      loanHit.entity = only;
    }
    const takingOut = /\b(?:out of|take out|taking out|took out|withdraw\w*|pull\w*|back out|empty)\b/.test(t)
      || direction === -1;
    const delta = (takingOut ? -1 : 1) * amount;
    ctx.reading.push(`Read as ${takingOut ? 'taking' : 'putting'} ${money(delta)} ${takingOut ? 'out of' : 'into'} the offset against ${loanHit.entity.name}.`);
    return { id, kind: 'offset', label: clause.trim(), loanId: loanHit.entity.id, delta: round2(delta) };
  }

  // ── Money at a loan ──
  if (amount != null && (loanHit.entity || loanHit.requested) && (PAY_DOWN.test(t) || LOAN_WORD.test(t))) {
    if (!loanHit.entity) {
      unresolve(ctx, 'loan', loanHit, loanNames);
      return null;
    }
    const loan = loanHit.entity;
    if (cadence || direction === 1) {
      // Stated as a rate: an ongoing extra repayment.
      const monthly = toMonthly(amount, cadence ?? 'monthly');
      const loanFreq: RepaymentFrequency = loan.frequency ?? 'monthly';
      const perPeriod = round2(monthly / monthlyEquivalent(1, loanFreq));
      ctx.reading.push(
        `Read as an extra ${money(monthly)} a month off ${loan.name}`
        + (loanFreq === 'monthly'
          ? '.'
          : ` — ${money(perPeriod)} each ${PERIOD_WORD[loanFreq]}, the cycle its repayments already run on.`)
        + (cadence ? '' : ' Ledger read the amount as monthly, because the question did not say.'),
      );
      return { id, kind: 'extra-repayment', label: clause.trim(), loanId: loan.id, amountPerPeriod: perPeriod };
    }
    ctx.reading.push(`Read as ${money(amount)} paid off ${loan.name} today, in one payment.`);
    return { id, kind: 'lump-sum', label: clause.trim(), loanId: loan.id, amount: round2(amount) };
  }

  // ── Income ──
  if (INCOME_WORD.test(t) && (percent != null || amount != null)) {
    const stream = findEntityInText(t, ctx.vocab.incomes);
    const down = direction === -1 || /\bpay cut\b/.test(t);
    const sign = down ? -1 : 1;
    const which = stream ? stream.name : 'every recurring income';
    if (percent != null) {
      ctx.reading.push(`Read as a ${percent}% ${down ? 'cut to' : 'rise on'} ${which}, from today.`);
      return {
        id, kind: 'income', label: clause.trim(),
        incomeId: stream?.id ?? null, mode: 'percent', value: round2(sign * percent), startDate: null,
      };
    }
    // A salary figure is a YEARLY figure unless the question gives a cadence —
    // "a $10,000 pay rise" is a year's money, not a month's.
    const monthly = cadence ? toMonthly(amount!, cadence) : round2(amount! / 12);
    ctx.reading.push(cadence
      ? `Read as ${money(monthly)} a month ${down ? 'less' : 'more'} from ${which}.`
      : `Read as ${money(amount!)} a year ${down ? 'less' : 'more'} from ${which} — ${money(monthly)} a month, before tax.`);
    return {
      id, kind: 'income', label: clause.trim(),
      incomeId: stream?.id ?? null, mode: 'amount', value: round2(sign * monthly), startDate: null,
    };
  }

  // ── A savings goal ──
  const goalHit = lookupGoal(clause, ctx.vocab.goals);
  const goalRequested = goalHit.requested ? tidyGoalRequest(goalHit.requested) : null;
  if (amount != null && (goalHit.entity || goalRequested) && SAVE_WORD.test(t)) {
    if (!goalHit.entity) {
      unresolve(ctx, 'goal', { requested: goalRequested, suggestions: goalHit.suggestions.map(g => g.name) },
        ctx.vocab.goals.map(g => g.name));
      return null;
    }
    const monthly = toMonthly(amount, cadence ?? 'monthly');
    ctx.reading.push(`Read as ${money(monthly)} a month put toward ${goalHit.entity.name}`
      + (cadence ? '.' : ', because the question did not say how often.'));
    return { id, kind: 'savings-contribution', label: clause.trim(), goalId: goalHit.entity.id, monthlyAmount: round2(monthly) };
  }

  // Saving with no goal named is two different questions — money moved to a
  // goal, and money not spent — and they do different things to the cash
  // projection. Ledger asks rather than picking one.
  if (amount != null && !goalHit.entity && !goalRequested
    && /\b(?:save|saving|put aside|set aside)\b/.test(t) && !SPEND_WORD.test(t)) {
    ctx.reason = ctx.vocab.goals.length
      ? `Saving toward what? Name a goal — ${ctx.vocab.goals.map(g => g.name).join(', ')} — or ask what happens if you spend that much less.`
      : 'Ask what happens if you spend that much less each month, or add a savings goal to save toward.';
    return null;
  }

  // ── Spending more or less ──
  const category = resolveCategory(clause, ctx.vocab.categories);
  if (SPEND_WORD.test(t) && direction != null && (percent != null || amount != null)) {
    const where = category ?? null;
    const label = where ?? 'everyday spending';
    if (percent != null) {
      ctx.reading.push(`Read as ${percent}% ${direction === -1 ? 'less' : 'more'} on ${label} every month.`);
      return { id, kind: 'spending', label: clause.trim(), category: where, mode: 'percent', value: round2(direction * percent) };
    }
    const monthly = toMonthly(amount!, cadence ?? 'monthly');
    ctx.reading.push(`Read as ${money(monthly)} a month ${direction === -1 ? 'less' : 'more'} on ${label}`
      + (cadence ? '.' : ', because the question did not say how often.'));
    return { id, kind: 'spending', label: clause.trim(), category: where, mode: 'amount', value: round2(direction * monthly) };
  }

  // ── Money coming in, once ──
  if (amount != null && WINDFALL_WORD.test(t) && !cadence) {
    const name = subjectAfter(t, 'get|getting|got|receive|receiving|come into') ?? 'Windfall';
    ctx.reading.push(`Read as ${money(amount)} arriving once, tomorrow.`);
    return {
      id, kind: 'one-off', label: clause.trim(), name: titled(name),
      amount: round2(-amount), date: addDays(ctx.asOf, 1), category: null,
    };
  }

  // ── A new commitment ──
  if (amount != null && (cadence && cadence !== 'once') && (COMMIT_WORD.test(t) || BUY_WORD.test(t) || /\bnew\b/.test(t))) {
    const name = subjectAfter(t, 'buy|buying|bought|get|getting|add|adding|start|starting|sign up for|take out|rent|lease')
      ?? 'New expense';
    ctx.reading.push(`Read as a new ${CADENCE_WORD[cadence]} commitment of ${money(amount)}, starting today.`);
    return {
      id, kind: 'recurring-expense', label: clause.trim(), name: titled(name),
      amount: round2(amount), frequency: cadence, category, startDate: null,
    };
  }

  // ── One purchase ──
  if (amount != null && (BUY_WORD.test(t) || SPEND_WORD.test(t) || /\bcost\w*\b/.test(t))) {
    const name = subjectAfter(t, 'buy|buying|bought|purchase|purchasing|get|getting|order|book|spend|spent|on')
      ?? 'One-off purchase';
    ctx.reading.push(`Read as a one-off ${money(amount)} going out tomorrow${category ? `, against ${category}` : ''}.`);
    return {
      id, kind: 'one-off', label: clause.trim(), name: titled(name),
      amount: round2(amount), date: addDays(ctx.asOf, 1), category,
    };
  }

  return null;
}

// ─── The whole question ─────────────────────────────────────────────────────

/** Split on the joins people actually use. Never on a comma — "$1,000" has one. */
function clausesOf(question: string): string[] {
  return question
    .split(/\s+and\s+(?:also\s+)?|\s*;\s*|\s+plus\s+|\s+as well as\s+/i)
    .map(c => c.trim())
    .filter(Boolean);
}

/**
 * What Ledger says when a question reads as a hypothetical but describes no
 * change it can model. Exported because it is also the SIGNAL: a reading that
 * failed this generically is one worth answering as an ordinary question.
 */
export const CANNOT_READ =
  'Ledger could not tell what to change. Name an amount and what it applies to — '
  + 'a loan, a goal, your income, a category, or a purchase — and it will run the numbers both ways.';

/**
 * Read a hypothetical question as a scenario.
 *
 * Several changes in one question are supported by reading each clause on its
 * own: "what if I pay $500 off the car loan and save $300 a month" is two
 * changes in one scenario, which is exactly what the engine takes.
 */
export function parseWhatIf(question: string, vocab: AskVocabulary, asOf: string): WhatIfReading {
  const ctx: Ctx = { vocab, asOf, reading: [], unresolved: [], reason: null };
  const clauses = clausesOf(question);

  const changes: ScenarioChange[] = [];
  clauses.forEach((clause, i) => {
    const change = readClause(clause, ctx, i);
    if (change) changes.push(change);
  });

  // A split that found nothing may have cut a sentence in half. Read it whole
  // before giving up — but only then, so a two-change question stays two.
  if (changes.length === 0 && clauses.length > 1) {
    const whole = readClause(question, ctx, 0);
    if (whole) changes.push(whole);
  }

  if (changes.length === 0) {
    return {
      scenario: null,
      reading: ctx.reading,
      unresolved: ctx.unresolved,
      // A name Ledger could not place is its own explanation, and a better one.
      reason: ctx.unresolved.length ? null : (ctx.reason ?? CANNOT_READ),
      followUp: false,
    };
  }

  return {
    scenario: { id: 'ask', name: question.trim(), changes },
    reading: ctx.reading,
    unresolved: ctx.unresolved,
    reason: null,
    followUp: false,
  };
}

// ─── Follow-ups ─────────────────────────────────────────────────────────────

const FOLLOW_UP = [
  /^\s*(?:and\s+)?(?:what|how)\s+about\b/i,
  /^\s*and\s+(?:if\s+)?\$?\s*\d/i,
  /^\s*\$?\s*\d[\d,]*(?:\.\d+)?\s*(?:k|m|%)?\s*[?.]?\s*$/,
  /\binstead\b/i,
];

/** Is this question a change to the last one rather than a new one? */
export function looksLikeFollowUp(question: string): boolean {
  const t = question.trim();
  return FOLLOW_UP.some(re => re.test(t));
}

/**
 * The previous scenario, with one figure swapped.
 *
 * Only ever applied to a scenario with a SINGLE change: "what about $2,000?"
 * after a question with two changes in it names no figure in particular, and
 * picking one would be a guess. Ledger reads it as a new question instead.
 */
export function reviseScenario(
  question: string,
  previous: Scenario,
  vocab: AskVocabulary,
  asOf: string,
): WhatIfReading | null {
  const active = previous.changes.filter(c => c.enabled !== false);
  if (active.length !== 1) return null;
  const change = active[0];

  const t = norm(question);
  const amount = moneyIn(t);
  const percent = percentIn(t);
  const cadence = cadenceIn(t);
  const reading: string[] = [];

  // "What about the mortgage?" — the same money, a different record.
  if (amount == null && percent == null) {
    if (change.kind === 'extra-repayment' || change.kind === 'lump-sum' || change.kind === 'offset') {
      const hit = findLoan(t, vocab.loans);
      if (!hit.entity) return null;
      if (hit.entity.id === (change as { loanId: string }).loanId) return null;
      reading.push(`Read as the same question, against ${hit.entity.name} instead.`);
      return {
        scenario: { id: 'ask', name: question.trim(), changes: [{ ...change, loanId: hit.entity.id }] },
        reading, unresolved: [], reason: null, followUp: true,
      };
    }
    if (change.kind === 'savings-contribution') {
      const hit = lookupGoal(question, vocab.goals);
      if (!hit.entity || hit.entity.id === change.goalId) return null;
      reading.push(`Read as the same question, against ${hit.entity.name} instead.`);
      return {
        scenario: { id: 'ask', name: question.trim(), changes: [{ ...change, goalId: hit.entity.id }] },
        reading, unresolved: [], reason: null, followUp: true,
      };
    }
    return null;
  }

  const sign = (n: number): number => (n < 0 ? -1 : 1);
  let revised: ScenarioChange;

  switch (change.kind) {
    case 'lump-sum': {
      if (amount == null) return null;
      revised = { ...change, amount: round2(amount) };
      reading.push(`Read as ${money(amount)} instead, paid off the same loan today.`);
      break;
    }
    case 'extra-repayment': {
      if (amount == null) return null;
      const loan = vocab.loans.find(l => l.id === change.loanId);
      const loanFreq: RepaymentFrequency = loan?.frequency ?? 'monthly';
      const monthly = toMonthly(amount, cadence ?? 'monthly');
      const perPeriod = round2(monthly / monthlyEquivalent(1, loanFreq));
      revised = { ...change, amountPerPeriod: perPeriod };
      reading.push(`Read as ${money(monthly)} a month instead, on the same loan.`);
      break;
    }
    case 'offset': {
      if (amount == null) return null;
      revised = { ...change, delta: round2(sign(change.delta) * amount) };
      reading.push(`Read as ${money(amount)} instead, ${change.delta < 0 ? 'out of' : 'into'} the same offset.`);
      break;
    }
    case 'savings-contribution': {
      if (amount == null) return null;
      const monthly = toMonthly(amount, cadence ?? 'monthly');
      revised = { ...change, monthlyAmount: round2(monthly) };
      reading.push(`Read as ${money(monthly)} a month instead, toward the same goal.`);
      break;
    }
    case 'one-off': {
      if (amount == null) return null;
      revised = { ...change, amount: round2(sign(change.amount) * amount) };
      reading.push(`Read as ${money(amount)} instead, on the same day.`);
      break;
    }
    case 'recurring-expense': {
      if (amount == null) return null;
      const frequency = cadence && cadence !== 'once' ? cadence : change.frequency;
      revised = { ...change, amount: round2(amount), frequency };
      reading.push(`Read as ${money(amount)} ${frequency === 'annually' ? 'a year' : `a ${PERIOD_WORD[frequency]}`} instead, for the same commitment.`);
      break;
    }
    case 'income':
    case 'spending': {
      const dir = sign(change.value);
      if (percent != null) {
        revised = { ...change, mode: 'percent', value: round2(dir * percent) };
        reading.push(`Read as ${percent}% instead, the same way round.`);
        break;
      }
      if (amount == null) return null;
      const monthly = change.kind === 'income' && !cadence
        ? round2(amount / 12)
        : toMonthly(amount, cadence ?? 'monthly');
      revised = { ...change, mode: 'amount', value: round2(dir * monthly) };
      reading.push(change.kind === 'income' && !cadence
        ? `Read as ${money(amount)} a year instead — ${money(monthly)} a month.`
        : `Read as ${money(monthly)} a month instead.`);
      break;
    }
  }

  return {
    scenario: { id: 'ask', name: question.trim(), changes: [revised] },
    reading, unresolved: [], reason: null, followUp: true,
  };
}

/**
 * Read a what-if question, taking the previous scenario into account.
 *
 * A follow-up is only ever a re-run of what came before with one figure
 * changed. When it cannot be read that way it is read as a fresh question,
 * which is what makes "what about $2,000?" cheap and "what if I also buy a
 * car?" still work.
 */
export function readWhatIf(
  question: string,
  vocab: AskVocabulary,
  asOf: string,
  previous?: Scenario | null,
): WhatIfReading {
  if (previous && looksLikeFollowUp(question)) {
    const revised = reviseScenario(question, previous, vocab, asOf);
    if (revised) return revised;
  }
  return parseWhatIf(question, vocab, asOf);
}

/**
 * Attach the reading to an intent. The composition point, kept HERE so that
 * `askIntent` never imports this module at runtime.
 */
export function withWhatIf(
  intent: AskIntent,
  vocab: AskVocabulary,
  asOf: string,
  previous?: Scenario | null,
): AskIntent {
  if (intent.name !== 'what-if') return intent;
  const whatIf = readWhatIf(intent.question, vocab, asOf, previous);

  // A question that merely SOUNDS hypothetical — "should I pay off my
  // mortgage?" — describes no change, names no record Ledger could not find,
  // and has no ambiguity worth putting back to the user. It is an ordinary
  // question, and answering it as one beats answering "I could not tell what
  // to change".
  if (!whatIf.scenario && whatIf.reason === CANNOT_READ) {
    const ordinary = matchIntent(intent.question, vocab, asOf, ['what-if']);
    if (ordinary.name !== 'unknown') return { ...ordinary, whatIf };
  }

  return {
    ...intent,
    whatIf,
    // A record the scenario could not place is a gap like any other, and is
    // reported by the same machinery every other intent uses.
    unresolved: [...intent.unresolved, ...whatIf.unresolved],
  };
}
