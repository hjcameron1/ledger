/**
 * Phase 9.1 — Ask Ledger: UNDERSTANDING the question. PURE.
 *
 * This module turns free text into an `AskIntent` — one of a CLOSED list of
 * questions Ledger's engines can actually answer, plus slots (a category, a
 * period, a named goal or loan) that are only ever filled from real data.
 *
 * The law of this phase lives here and in askAnswer.ts:
 *
 *   1. The AI never supplies a fact. It may only propose an intent NAME from
 *      `ASK_INTENTS` and slot values that already exist in the user's own
 *      vocabulary. `sanitiseIntent()` is the gate — anything it doesn't
 *      recognise is DROPPED and recorded as an `unresolved` note, never
 *      passed through and never guessed into something plausible.
 *   2. Nothing here reads the store, calls the network, or writes. The whole
 *      module is a function of (text, vocabulary, asOf).
 *   3. A question we cannot ground is answered `unknown` — an honest "I can't
 *      answer that from your data" beats a confident answer to a question the
 *      user didn't ask.
 *
 * The deterministic matcher below is not a fallback for the AI — it is the
 * DEFAULT. `matchIntent()` alone answers every example question in the phase
 * brief with no API key configured at all; the AI only widens the phrasings
 * that reach the same bounded set.
 */

import { LEDGER_CATEGORIES, explicitAlias } from './categoryTaxonomy';
import type { RepaymentFrequency } from '../types';
// Type only: `askScenario` imports this module for real, and a runtime cycle
// between the two would be a genuine hazard. The what-if reading is ATTACHED by
// `askScenario.withWhatIf` after this module has done its job.
import type { WhatIfReading } from './askScenario';

// ─── The closed question set ─────────────────────────────────────────────────

/**
 * Every question Ask Ledger can answer. Each name maps 1:1 to a branch of
 * `askDS.answerFor()` and to a variant of `AskFacts` — so adding a question
 * means adding an engine call, never loosening this list.
 */
export const ASK_INTENTS = [
  /** Total spending over a period, optionally narrowed to one category. */
  'spend-total',
  /** One category's spending over a period. "How much did I spend eating out?" */
  'spend-category',
  /** Where the money went — biggest categories over a period. */
  'spend-top',
  /** The cash-flow outlook, and what is pulling it down. */
  'forecast-outlook',
  /** Budget position for the month — caps, spent, projected. */
  'budget-status',
  /** Progress toward a savings goal, and whether it lands on time. */
  'goal-progress',
  /** What an offset account is saving in interest. */
  'loan-offset',
  /** When a loan clears and what it costs to carry. */
  'loan-payoff',
  /** Deductions on file for a financial year. */
  'tax-deductions',
  /** The financial year's tax position — income, deductions, taxable income. */
  'tax-position',
  /** Income received over a period. */
  'income-total',
  /** Net worth now. */
  'net-worth',
  /** Bills and commitments coming up. */
  'bills-upcoming',
  /** What changed recently, and why. */
  'insights-changes',
  /**
   * Insurance: what cover is held, what it costs, when it renews.
   *
   * Answered from the insurance policies and the document vault, and from
   * nothing else. An insurance question that fell through to `bills-upcoming`
   * would answer with whatever bill happened to be next — which reads exactly
   * like an answer about cover, and is not one.
   */
  'insurance-cover',
  /**
   * A hypothetical: "what happens if I pay $1,000 off my car loan?"
   *
   * The only intent whose answer runs the engines TWICE — once on the records
   * as they are, once on the records as the question describes them. Nothing is
   * written either time; see `utils/askScenario.ts`.
   */
  'what-if',
  /** Nothing in Ledger answers this. */
  'unknown',
] as const;

export type AskIntentName = (typeof ASK_INTENTS)[number];

const INTENT_SET = new Set<string>(ASK_INTENTS);

/** Is this a name Ask Ledger recognises? The only door an AI proposal enters by. */
export function isAskIntent(value: unknown): value is AskIntentName {
  return typeof value === 'string' && INTENT_SET.has(value);
}

// ─── Periods ─────────────────────────────────────────────────────────────────

export type PeriodKind =
  | 'calendar-year'
  | 'financial-year'
  | 'month'
  | 'rolling-days'
  | 'week'
  | 'all-time';

/** A resolved window. `from`/`to` are inclusive `YYYY-MM-DD`. */
export interface AskPeriod {
  kind: PeriodKind;
  from: string;
  to: string;
  /** How the answer should NAME this window, e.g. "this year", "July 2026". */
  label: string;
  /** Set for financial-year periods only, e.g. `2025-2026`. */
  fy?: string;
}

const MONTH_NAMES = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

const MONTH_LABELS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function ymd(y: number, m: number, d: number): string {
  return `${y}-${pad(m)}-${pad(d)}`;
}

/** Last day of a 1-indexed month. */
function endOfMonth(y: number, m: number): string {
  return ymd(y, m, new Date(Date.UTC(y, m, 0)).getUTCDate());
}

function addDaysISO(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1));
  t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
}

/** The Australian financial year a date falls in — `2025-2026` for 2026-05-01. */
export function fyOf(date: string): string {
  const [y, m] = date.split('-').map(Number);
  return (m ?? 1) >= 7 ? `${y}-${y + 1}` : `${y - 1}-${y}`;
}

/** The window a financial year covers. */
export function fyPeriod(fy: string, asOf: string): AskPeriod {
  const startYear = Number(fy.split('-')[0]);
  const from = ymd(startYear, 7, 1);
  const end = ymd(startYear + 1, 6, 30);
  return {
    kind: 'financial-year',
    from,
    // A year still being lived is reported only as far as today: claiming the
    // whole FY would present four unlived months as months with no spending.
    to: asOf < end ? asOf : end,
    label: asOf >= from && asOf <= end ? 'this financial year' : `FY ${fy}`,
    fy,
  };
}

/** True when the question is asking about the TAX year rather than the calendar one. */
function meansFinancialYear(text: string): boolean {
  return /\b(financial year|fin year|fy|tax year)\b/.test(text);
}

/**
 * Resolve the window a question is about.
 *
 * Returns null when the text names no period at all — the caller decides the
 * default, because "how much did I spend" and "what deductions do I have" want
 * different ones and neither should be invented here.
 */
export function parsePeriod(text: string, asOf: string): AskPeriod | null {
  const t = text.toLowerCase();
  const [year, month] = asOf.split('-').map(Number);

  // "in the last 30 days", "over the past 6 months", "last 3 weeks"
  const rolling = t.match(/\b(?:last|past|previous)\s+(\d{1,3})\s+(day|week|month|year)s?\b/);
  if (rolling) {
    const n = Number(rolling[1]);
    const unit = rolling[2];
    const days = unit === 'day' ? n : unit === 'week' ? n * 7 : unit === 'month' ? Math.round(n * 30.4375) : n * 365;
    return {
      kind: 'rolling-days',
      from: addDaysISO(asOf, -(days - 1)),
      to: asOf,
      label: `the last ${n} ${unit}${n === 1 ? '' : 's'}`,
    };
  }

  // An explicit financial year: "FY 2024-2025", "2024/25 financial year"
  const explicitFy = t.match(/\b(20\d{2})\s*[-/]\s*(20\d{2}|\d{2})\b/);
  if (explicitFy && meansFinancialYear(t)) {
    const start = Number(explicitFy[1]);
    return fyPeriod(`${start}-${start + 1}`, asOf);
  }

  if (/\b(this|current)\s+(financial year|fin year|fy|tax year)\b/.test(t) || /^(?:.*\s)?(fy|financial year|tax year)(?:\s.*)?$/.test(t) && /\bthis\b/.test(t)) {
    return fyPeriod(fyOf(asOf), asOf);
  }
  if (/\blast\s+(financial year|fin year|fy|tax year)\b/.test(t)) {
    const start = Number(fyOf(asOf).split('-')[0]) - 1;
    return fyPeriod(`${start}-${start + 1}`, asOf);
  }

  if (/\b(this|current)\s+month\b/.test(t) || /\bmonth to date\b/.test(t)) {
    return {
      kind: 'month',
      from: ymd(year, month, 1),
      to: asOf,
      label: 'this month',
    };
  }
  if (/\blast month\b/.test(t) || /\bprevious month\b/.test(t)) {
    const m = month === 1 ? 12 : month - 1;
    const y = month === 1 ? year - 1 : year;
    return { kind: 'month', from: ymd(y, m, 1), to: endOfMonth(y, m), label: 'last month' };
  }
  if (/\b(this|current)\s+week\b/.test(t)) {
    // Week starts Monday, the same convention the review engine uses.
    const [yy, mm, dd] = asOf.split('-').map(Number);
    const dow = new Date(Date.UTC(yy, mm - 1, dd)).getUTCDay();
    const back = dow === 0 ? 6 : dow - 1;
    return { kind: 'week', from: addDaysISO(asOf, -back), to: asOf, label: 'this week' };
  }

  // "in July", "during March 2025"
  for (let i = 0; i < MONTH_NAMES.length; i++) {
    const re = new RegExp(`\\b${MONTH_NAMES[i]}\\b(?:\\s+(20\\d{2}))?`);
    const hit = t.match(re);
    if (hit) {
      const y = hit[1] ? Number(hit[1]) : (i + 1 > month ? year - 1 : year);
      const from = ymd(y, i + 1, 1);
      const end = endOfMonth(y, i + 1);
      return {
        kind: 'month',
        from,
        to: asOf < end ? asOf : end,
        label: `${MONTH_LABELS[i]} ${y}`,
      };
    }
  }

  if (/\b(this|current)\s+year\b/.test(t) || /\byear to date\b/.test(t) || /\bytd\b/.test(t)) {
    return meansFinancialYear(t)
      ? fyPeriod(fyOf(asOf), asOf)
      : { kind: 'calendar-year', from: ymd(year, 1, 1), to: asOf, label: 'this year' };
  }
  if (/\blast year\b/.test(t)) {
    return meansFinancialYear(t)
      ? fyPeriod(`${Number(fyOf(asOf).split('-')[0]) - 1}-${Number(fyOf(asOf).split('-')[0])}`, asOf)
      : {
        kind: 'calendar-year',
        from: ymd(year - 1, 1, 1),
        to: ymd(year - 1, 12, 31),
        label: `${year - 1}`,
      };
  }

  // A bare calendar year: "in 2025"
  const bareYear = t.match(/\b(20\d{2})\b/);
  if (bareYear) {
    const y = Number(bareYear[1]);
    const end = ymd(y, 12, 31);
    return {
      kind: 'calendar-year',
      from: ymd(y, 1, 1),
      to: asOf < end ? asOf : end,
      label: y === year ? 'this year' : String(y),
    };
  }

  if (/\b(ever|all time|of all time|since I started|in total)\b/.test(t)) {
    return { kind: 'all-time', from: '0001-01-01', to: asOf, label: 'all time' };
  }

  return null;
}

/** The window used when a spending question names no period. */
export function defaultSpendPeriod(asOf: string): AskPeriod {
  const [year, month] = asOf.split('-').map(Number);
  return { kind: 'month', from: ymd(year, month, 1), to: asOf, label: 'this month' };
}

// ─── The user's own vocabulary ───────────────────────────────────────────────

/** A thing in the user's data a question can name. */
export interface NamedEntity {
  id: string;
  name: string;
}

/**
 * A loan, with the cadence its repayments run on.
 *
 * A what-if question states its own cadence ("an extra $200 a month"), and the
 * loan engine wants the figure in the loan's OWN periods — so the frequency has
 * to travel with the name, or the conversion would be a guess.
 */
export interface AskLoanEntity extends NamedEntity {
  frequency?: RepaymentFrequency;
}

/**
 * Everything a question is ALLOWED to refer to, gathered from the user's own
 * (scope-filtered) data by the DS layer. A slot that isn't in here cannot be
 * filled — which is what stops "my Bali fund" resolving to a goal that doesn't
 * exist, whether a person or a model proposed it.
 */
export interface AskVocabulary {
  /** Category names in use: the canonical taxonomy plus the user's own. */
  categories: string[];
  goals: NamedEntity[];
  loans: AskLoanEntity[];
  /** Recurring income streams, by name — what a pay-rise question may point at. */
  incomes: NamedEntity[];
  properties: NamedEntity[];
  accounts: NamedEntity[];
  /** Insurance policies, by name — what an insurance question may point at. */
  policies: NamedEntity[];
  /** Financial years the tax engine can report on, newest first. */
  financialYears: string[];
}

/** An empty vocabulary — a brand-new account can still be asked questions. */
export function emptyVocabulary(): AskVocabulary {
  return {
    categories: [...LEDGER_CATEGORIES],
    goals: [], loans: [], incomes: [], properties: [], accounts: [], policies: [],
    financialYears: [],
  };
}

// ─── Category resolution ─────────────────────────────────────────────────────

/**
 * Everyday phrasings, each pointing at an ORDERED list of canonical Ledger
 * categories. "Eating out" is Dining in a ledger that has Dining and Food in a
 * ledger that doesn't — so the first candidate the USER ACTUALLY HAS wins, and
 * when they have none of them the phrase resolves to nothing at all.
 *
 * This deliberately sits beside `explicitAlias` in categoryTaxonomy rather than
 * duplicating it: that table maps provider category names, this one maps the
 * words people use in questions. Both are consulted, alias table first.
 */
const CATEGORY_PHRASES: [string, string[]][] = [
  ['eating out', ['Dining', 'Food']],
  ['eat out', ['Dining', 'Food']],
  ['ate out', ['Dining', 'Food']],
  ['dining out', ['Dining', 'Food']],
  ['going out for dinner', ['Dining', 'Food']],
  ['restaurants', ['Dining', 'Food']],
  ['takeaway', ['Dining', 'Food']],
  ['take away', ['Dining', 'Food']],
  ['takeout', ['Dining', 'Food']],
  ['uber eats', ['Dining', 'Food']],
  ['ubereats', ['Dining', 'Food']],
  ['doordash', ['Dining', 'Food']],
  ['menulog', ['Dining', 'Food']],
  ['cafes', ['Dining', 'Food']],
  ['cafe', ['Dining', 'Food']],
  ['coffee', ['Dining', 'Food']],
  ['food', ['Food', 'Dining']],
  ['supermarket', ['Groceries', 'Food']],
  ['grocery', ['Groceries', 'Food']],
  ['woolworths', ['Groceries']],
  ['coles', ['Groceries']],
  ['aldi', ['Groceries']],
  ['petrol', ['Fuel', 'Transport']],
  ['gas station', ['Fuel', 'Transport']],
  ['filling up', ['Fuel', 'Transport']],
  ['public transport', ['Transport']],
  ['commuting', ['Transport']],
  ['rideshare', ['Transport']],
  ['ride share', ['Transport']],
  ['taxis', ['Transport']],
  ['flights', ['Travel']],
  ['holidays', ['Travel']],
  ['holiday', ['Travel']],
  ['trips', ['Travel']],
  ['clothes', ['Shopping']],
  ['clothing', ['Shopping']],
  ['power bill', ['Utilities', 'Bills']],
  ['electricity', ['Utilities', 'Bills']],
  ['water bill', ['Utilities', 'Bills']],
  ['energy', ['Utilities', 'Bills']],
  ['internet', ['Telecommunications', 'Utilities', 'Bills']],
  ['mobile', ['Telecommunications', 'Bills']],
  ['phone bill', ['Telecommunications', 'Bills']],
  ['streaming', ['Entertainment']],
  ['netflix', ['Entertainment']],
  ['spotify', ['Entertainment']],
  ['movies', ['Entertainment']],
  ['going out', ['Entertainment']],
  ['gym', ['Fitness', 'Health']],
  ['exercise', ['Fitness', 'Health']],
  ['doctor', ['Health']],
  ['pharmacy', ['Health']],
  ['chemist', ['Health']],
  ['dentist', ['Health']],
  ['medical', ['Health']],
  ['premiums', ['Insurance']],
  ['computers', ['Electronics']],
  ['gadgets', ['Electronics']],
  ['my rent', ['Rent', 'Housing']],
  ['paying rent', ['Rent', 'Housing']],
];

function norm(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Does `phrase` appear in `text` as whole words? */
function mentions(text: string, phrase: string): boolean {
  const p = escapeRe(norm(phrase));
  if (!p) return false;
  return new RegExp(`(^|[^a-z0-9])${p}([^a-z0-9]|$)`).test(text);
}

/**
 * Find the category a question is about, in the user's OWN list.
 *
 * Order: the category's own name, then the shared alias table, then the
 * question-phrasing table above. Every path ends at a category the user has —
 * a phrase whose candidates they don't hold resolves to NOTHING rather than to
 * the nearest thing, because an answer about the wrong category is worse than
 * an answer that admits it doesn't know which one was meant.
 */
export function resolveCategory(text: string, categories: string[]): string | null {
  const t = norm(text);
  const byNorm = new Map(categories.map(c => [norm(c), c]));
  const owned = (name: string): string | null => byNorm.get(norm(name)) ?? null;

  // 1. The category's own name appears in the question. Longest name wins, so
  //    "Health insurance" beats "Health" when the user has both.
  let best: string | null = null;
  for (const c of categories) {
    if (!norm(c)) continue;
    if (mentions(t, c) && (!best || norm(c).length > norm(best).length)) best = c;
  }
  if (best) return best;

  // 2/3. A phrasing, from either table. The longest matching phrase wins.
  let hit: { category: string; length: number } | null = null;
  const consider = (phrase: string, candidates: string[]) => {
    if (!mentions(t, phrase)) return;
    for (const candidate of candidates) {
      const have = owned(candidate);
      if (!have) continue;
      if (!hit || phrase.length > hit.length) hit = { category: have, length: phrase.length };
      return;
    }
  };

  for (const [phrase, candidates] of CATEGORY_PHRASES) consider(phrase, candidates);

  // The shared alias table, applied to every 1–3 word run in the question.
  const words = t.split(/[^a-z0-9]+/).filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    for (let n = 1; n <= 3 && i + n <= words.length; n++) {
      const phrase = words.slice(i, i + n).join(' ');
      const canonical = explicitAlias(phrase);
      if (canonical) consider(phrase, [canonical]);
    }
  }

  return hit ? (hit as { category: string }).category : null;
}

// ─── Named records: goals, loans, properties ─────────────────────────────────

/**
 * Words that describe the KIND of thing rather than which one it is. Stripped
 * from both sides before matching, so "my car goal" and "Car" are the same
 * question. `deposit`, `trip`, `house` and the like are deliberately absent —
 * they are what distinguishes one goal from another.
 */
const ENTITY_NOISE = new Set([
  'my', 'me', 'our', 'the', 'a', 'an', 'this', 'that',
  'goal', 'goals', 'fund', 'funds', 'saving', 'savings', 'save',
  'target', 'targets', 'pot', 'plan', 'account', 'balance',
  'loan', 'loans', 'mortgage', 'debt',
  'property', 'properties',
]);

/** The significant words of a name — what is left once the kind words go. */
function entityTokens(name: string): string[] {
  const words = norm(name).split(/[^a-z0-9]+/).filter(Boolean);
  const kept = words.filter(w => !ENTITY_NOISE.has(w));
  // A name made entirely of kind words ("Savings", "The Fund") still has to be
  // matchable, so it keeps its own words rather than becoming nothing.
  return kept.length ? kept : words;
}

/** The comparable form of a name: significant words only, in order. */
function entityKey(name: string): string {
  return entityTokens(name).join(' ');
}

/** Edit distance, capped where it stops mattering. */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length || !b.length) return Math.max(a.length, b.length);
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(
        prev[j] + 1,
        row[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = row;
  }
  return prev[b.length];
}

/** 1 for identical, 0 for nothing in common. */
function similarity(a: string, b: string): number {
  const longest = Math.max(a.length, b.length);
  if (!longest) return 0;
  return 1 - editDistance(a, b) / longest;
}

/** Are two words the same word, allowing one typo in a word long enough to spare it? */
function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.min(a.length, b.length) < 4) return false;
  return editDistance(a, b) <= 1;
}

/** How much of the shorter name's meaning the longer one carries. */
function tokenScore(qTokens: string[], nameTokens: string[]): number {
  if (!qTokens.length || !nameTokens.length) return 0;
  const used = new Set<number>();
  let shared = 0;
  for (const q of qTokens) {
    const i = nameTokens.findIndex((n, idx) => !used.has(idx) && sameWord(q, n));
    if (i >= 0) { used.add(i); shared++; }
  }
  return shared / Math.max(qTokens.length, nameTokens.length);
}

/**
 * How sure Ledger is that a name means one of the user's records.
 *
 * Three outcomes and no fourth. `resolved` is acted on; `near` is put to the
 * user as "did you mean…"; `none` is reported as not found. There is
 * deliberately no "closest available" outcome — answering about the wrong
 * goal reads exactly like answering about the right one, so a match that
 * isn't confident must never become an answer.
 */
export type EntityMatch =
  | { kind: 'resolved'; entity: NamedEntity }
  | { kind: 'near'; candidates: NamedEntity[] }
  | { kind: 'none' };

/** Above this a fuzzy match is a typo; below it, at best a suggestion. */
const CONFIDENT = 0.85;
/** Below this the name has nothing to do with the record. */
const NEAR = 0.5;

export function matchEntity(name: string, entities: NamedEntity[]): EntityMatch {
  const q = norm(name);
  if (!q || !entities.length) return { kind: 'none' };

  const one = (list: NamedEntity[]): EntityMatch | null => {
    if (list.length === 1) return { kind: 'resolved', entity: list[0] };
    // Two records answer to the same words. Picking either would be a guess.
    if (list.length > 1) return { kind: 'near', candidates: list.slice(0, 4) };
    return null;
  };

  // 1. The name as written.
  const exact = one(entities.filter(e => norm(e.name) === q));
  if (exact) return exact;

  // 2. The same significant words: "my car goal" is the "Car" goal, "Car" is
  //    the "Car fund", and one name's words sitting inside the other's counts
  //    too. Every such record is gathered before any is chosen, so "Car" with
  //    a "Car loan" and a "Car loan 2" on file is a question, not a match.
  const qKey = entityKey(q);
  const qTokens = entityTokens(q);
  const covers = (outer: string[], inner: string[]) =>
    inner.length > 0 && inner.every(w => outer.includes(w));
  const structural = entities.filter(e => {
    const nTokens = entityTokens(e.name);
    return entityKey(e.name) === qKey || covers(nTokens, qTokens) || covers(qTokens, nTokens);
  });
  const byWords = one(structural);
  if (byWords) return byWords;

  // 4. Nothing lines up exactly. Score every record and let the score decide
  //    whether this is a typo, a suggestion, or a name the user doesn't have.
  const scored = entities
    .map(e => ({
      entity: e,
      score: Math.max(
        similarity(q, norm(e.name)),
        similarity(qKey, entityKey(e.name)),
        tokenScore(qTokens, entityTokens(e.name)),
      ),
    }))
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  if (!best || best.score < NEAR) return { kind: 'none' };

  const runnerUp = scored[1]?.score ?? 0;
  // Confident AND clearly ahead of the next candidate: two goals a typo could
  // equally have meant is a question, not a match.
  if (best.score >= CONFIDENT && best.score - runnerUp >= 0.1) {
    return { kind: 'resolved', entity: best.entity };
  }
  return { kind: 'near', candidates: scored.filter(s => s.score >= NEAR).slice(0, 3).map(s => s.entity) };
}

/**
 * Resolve a name a model or a user typed to one of the user's records.
 * Only a confident match comes back — see `matchEntity`.
 */
export function resolveEntity(name: string, entities: NamedEntity[]): NamedEntity | null {
  const m = matchEntity(name, entities);
  return m.kind === 'resolved' ? m.entity : null;
}

/**
 * The record a question names, found by scanning the question for each name.
 * Whole words only: a goal called "Car" is not named by "carnival".
 */
export function findEntityInText(text: string, entities: NamedEntity[]): NamedEntity | null {
  const t = norm(text);
  let best: NamedEntity | null = null;
  for (const e of entities) {
    const n = norm(e.name);
    if (n.length < 3) continue; // too short to match on safely
    if (mentions(t, n) && (!best || n.length > norm(best.name).length)) best = e;
  }
  return best;
}

/**
 * The words a question uses for a goal, when it names one.
 *
 * Only consulted once a verbatim scan has failed, and only ever used to say
 * WHICH name could not be placed — never to guess a goal from.
 */
export function goalSubject(text: string): string | null {
  const t = norm(text);
  const patterns: RegExp[] = [
    // "my car goal", "the Japan fund"
    /\b(?:my|our|the|a)\s+([a-z0-9 &'-]{2,40}?)\s+(?:goals?|funds?)\b/,
    // "the goal called Car", "a goal named Bali"
    /\bgoals?\s+(?:called|named)\s+"?([a-z0-9 &'’-]{2,40}?)"?\s*[?.!]?\s*$/,
    // "saving up for a car", "on track for my Japan trip"
    /\b(?:saving up for|saving for|on track (?:for|to hit|to reach)|towards?)\s+(?:my|our|the|a)\s+([a-z0-9 &'-]{2,40})/,
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (!m) continue;
    const subject = tidySubject(m[1]);
    if (subject) return subject;
  }
  return null;
}

/** Trim a captured phrase back to the words that name something. */
function tidySubject(raw: string): string | null {
  let s = raw
    .replace(/\b(in|during|over|since|by|before|until)\b.*$/, '')
    .replace(/[?.!,]+$/, '')
    .trim();
  const words = s.split(/\s+/).filter(Boolean);
  while (words.length && ENTITY_NOISE.has(words[0])) words.shift();
  while (words.length && ENTITY_NOISE.has(words[words.length - 1])) words.pop();
  s = words.join(' ');
  if (!s || s.length < 2) return null;
  // A bare pronoun or filler names nothing.
  if (/^(it|that|this|them|those|one|things|stuff|everything|anything)$/.test(s)) return null;
  return s;
}

/**
 * What a question means by the goal it names.
 *
 * `entity` is filled ONLY on a confident match. Everything else comes back as
 * `requested` plus what it might have meant, so the answer can say "you have
 * no goal called that" — and never quietly answer about a different goal, or
 * about the only goal there happens to be.
 */
export interface EntityLookup {
  entity: NamedEntity | null;
  requested: string | null;
  suggestions: NamedEntity[];
}

export function lookupGoal(text: string, goals: NamedEntity[]): EntityLookup {
  const verbatim = findEntityInText(text, goals);
  if (verbatim) return { entity: verbatim, requested: null, suggestions: [] };

  const requested = goalSubject(text);
  if (!requested) return { entity: null, requested: null, suggestions: [] };

  const match = matchEntity(requested, goals);
  if (match.kind === 'resolved') return { entity: match.entity, requested: null, suggestions: [] };
  if (match.kind === 'near') return { entity: null, requested, suggestions: match.candidates };
  return { entity: null, requested, suggestions: [] };
}

// ─── Loans and policies, named the same careful way ──────────────────────────
//
// `findLoan` and `findPolicy` live HERE rather than beside the code that first
// needed them, because a name is placed the same way whoever is asking: a
// hypothetical about "the car loan" and a question about "the car loan" must
// agree about whether that loan exists. `askScenario` re-exports them.

/** A lookup whose suggestions are plain names — what a gap message quotes. */
export interface NameLookup<T extends NamedEntity> {
  entity: T | null;
  requested: string | null;
  suggestions: string[];
}

/** Trim the words that describe a payment rather than name a record. */
export function tidyRecordName(raw: string): string | null {
  const s = norm(raw)
    .replace(/\b(?:right now|now|today|straight away|instead|as well|too)\b.*$/, '')
    .replace(/[?.!,]+$/, '')
    .trim();
  return s.length >= 2 ? s : null;
}

/** Words that say what KIND of thing a loan is, never which one. */
const LOAN_KIND_WORDS = new Set([
  'my', 'our', 'the', 'a', 'an', 'loan', 'loans', 'mortgage', 'mortgages',
  'debt', 'debts', 'repayment', 'repayments', 'offset', 'account', 'balance',
]);

/** The words a question uses for a loan, when it names one indirectly. */
export function loanSubject(text: string): string | null {
  const t = norm(text);
  const patterns = [
    /\b(?:my|the|our)\s+([a-z][a-z '-]{0,24}?\b(?:loans?|mortgages?|debts?))\b/,
    /\b(?:off|onto|towards?|into|against|on)\s+(?:my|the|our)\s+([a-z][a-z '-]{1,24}?)(?=\s+(?:right|now|today|instead|each|every|per|a|this|and)\b|[?.,]|$)/,
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (!m) continue;
    const name = tidyRecordName(m[1]);
    if (name) return name;
  }
  return null;
}

/**
 * Which loan a question or clause is about.
 *
 * The same three outcomes every named record in Ask Ledger has: resolved, or
 * reported with what it might have meant, or reported as absent. Being the only
 * loan on file earns nothing — a question about "the car loan" from somebody
 * whose one loan is a mortgage is a question about a loan they do not have.
 */
export function findLoan<T extends NamedEntity>(text: string, loans: T[]): NameLookup<T> {
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

/** Words that say a question is about insurance, never which policy. */
const POLICY_KIND_WORDS = new Set([
  'my', 'our', 'the', 'a', 'an', 'insurance', 'insurances', 'policy', 'policies',
  'cover', 'coverage', 'premium', 'premiums', 'insurer', 'insurers',
]);

/** The words an insurance question uses for the cover it means. */
export function policySubject(text: string): string | null {
  const t = norm(text);
  const patterns = [
    // "my car insurance", "the health cover", "our landlord policy"
    /\b(?:my|the|our)\s+([a-z][a-z0-9 '-]{0,30}?\b(?:insurance|cover|coverage|policy|policies|premiums?))\b/,
    // "the policy called Comprehensive", "insurance for the Brisbane unit"
    /\b(?:polic(?:y|ies)|insurance)\s+(?:called|named|for|on)\s+"?((?:my|our|the)\s+)?([a-z0-9 &'’-]{2,40}?)"?\s*[?.!]?\s*$/,
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (!m) continue;
    const name = tidyRecordName(m[m.length - 1]);
    if (name) return name;
  }
  return null;
}

/**
 * Which policy an insurance question is about.
 *
 * Reads exactly like `findLoan`, for the same reason: "how much is my car
 * insurance?" from somebody who only insures their house must say so, not
 * answer about the house.
 */
export function findPolicy<T extends NamedEntity>(text: string, policies: T[]): NameLookup<T> {
  const byId = (e: NamedEntity | null) => (e ? policies.find(p => p.id === e.id) ?? null : null);

  const verbatim = byId(findEntityInText(text, policies));
  if (verbatim) return { entity: verbatim, requested: null, suggestions: [] };

  const subject = policySubject(text);
  if (!subject) return { entity: null, requested: null, suggestions: [] };

  // "my insurance", "our policies" — the whole question, not one policy. The
  // answer covers everything held, which is what was asked.
  if (subject.split(' ').every(w => POLICY_KIND_WORDS.has(w))) {
    return { entity: null, requested: null, suggestions: [] };
  }

  const match = matchEntity(subject, policies);
  if (match.kind === 'resolved') return { entity: byId(match.entity), requested: null, suggestions: [] };
  if (match.kind === 'near') {
    return { entity: null, requested: subject, suggestions: match.candidates.map(c => c.name) };
  }
  return { entity: null, requested: subject, suggestions: [] };
}

// ─── The intent ──────────────────────────────────────────────────────────────

/** Why a slot the question asked for isn't filled. Surfaced, never papered over. */
export interface UnresolvedSlot {
  slot: 'category' | 'goal' | 'loan' | 'property' | 'policy' | 'period' | 'financial-year';
  /** What the question (or the model) asked for. */
  requested: string;
  /**
   * Records it might have meant, when Ledger is not sure enough to pick one.
   * Put to the user as "did you mean…" — never resolved on their behalf.
   */
  suggestions?: string[];
  /** Everything the user does have in that slot, for an answer that lists them. */
  available?: string[];
}

export interface AskIntent {
  name: AskIntentName;
  /** The question as asked, verbatim. */
  question: string;
  period: AskPeriod | null;
  /** Always one of the user's real categories, or null. */
  category: string | null;
  /** The named goal / loan / policy / property, when the question is about one. */
  goal: NamedEntity | null;
  loan: NamedEntity | null;
  policy: NamedEntity | null;
  property: NamedEntity | null;
  /** A financial year the tax engine knows about. */
  fy: string | null;
  /**
   * A what-if question's scenario, once `askScenario.withWhatIf` has read it.
   * Null on every other intent, and null here until it is attached.
   */
  whatIf: WhatIfReading | null;
  /** Slots the question reached for that don't exist in the user's data. */
  unresolved: UnresolvedSlot[];
  /**
   * What Ledger recognised the question to be ABOUT, when it is about
   * something Ledger cannot answer.
   *
   * Only ever set alongside `unknown`, and only to say so out loud: "Ledger
   * can't answer that yet" is an answer, and a far better one than the nearest
   * question it happens to have an engine for.
   */
  unsupported: string | null;
  /** How the intent was arrived at — shown to the user, never hidden. */
  source: 'rules' | 'ai' | 'follow-up';
  /** 0–1. The rules matcher scores its own certainty; the AI's is capped by it. */
  confidence: number;
}

interface Rule {
  intent: AskIntentName;
  /** Every pattern that votes for this intent. */
  patterns: RegExp[];
  /**
   * Patterns that vote for this intent ONLY when the question also names
   * something real — a category, a period, a goal, a loan, a policy.
   *
   * "How much did I spend on Dining in July" and "how much should I spend on a
   * wedding" both contain the word "spend"; only one of them is a question
   * about this ledger. A loose pattern with nothing grounding it is not a
   * match at all, and the question comes back `unknown` rather than being
   * answered as something adjacent to what was asked.
   */
  loose?: RegExp[];
  /** Added to the score when a pattern hits. Higher = more specific question. */
  weight: number;
}

/**
 * The matcher's whole vocabulary. Ordered by specificity, not by importance:
 * "how much interest is my offset saving" must beat the generic "how much"
 * spending rule, so the offset rule scores higher.
 */
const RULES: Rule[] = [
  {
    // Above everything: "what if I put $20,000 in my offset" is a hypothetical
    // about an offset, not a question about the offset as it stands today.
    intent: 'what-if',
    weight: 8,
    patterns: [
      /\bwhat (?:if|happens if|would happen if|happened if)\b/,
      /\bif i (?:pay|paid|put|buy|bought|purchase|save|saved|spend|spent|get|got|take|took|add|start|stop|cut|drop|dropped|increase|reduce|move|switch|refinance|earn|earned|lose|lost)\b/,
      // A follow-up only counts as one when it carries a new figure: "what
      // about last month?" is a different window, not a different scenario.
      /\bwhat about\b[^?]*\d/,
      /\bhow (?:much|many months?) (?:sooner|faster|earlier|quicker)\b/,
      /\b(?:would|will) i (?:save|be better off)\b/,
      /\bimpact of\b/,
      /\bshould i (?:pay|put)\b/,
    ],
  },
  {
    intent: 'loan-offset',
    weight: 6,
    patterns: [
      /\boffset\b.*\b(sav\w*|worth|benefit|help\w*|doing)\b/,
      /\b(sav\w*|worth|benefit)\b.*\boffset\b/,
      /\bhow much (interest|money)\b.*\boffset\b/,
      /\boffset\b.*\binterest\b/,
    ],
  },
  {
    intent: 'loan-payoff',
    weight: 5,
    patterns: [
      /\b(when|how long)\b.*\b(pay(ing)? off|paid off|debt[- ]free|clear)\b/,
      /\b(mortgage|loan|debt)\b.*\b(paid off|payoff|pay off|finish\w*|end)\b/,
      /\b(pay(ing)? off|paid off|payoff|clear\w*)\b.*\b(mortgage|loan|debt)\b/,
      /\bhow much (interest|does).*\b(loan|mortgage)\b/,
      /\binterest\b.*\b(loan|mortgage)\b.*\b(year|cost)\b/,
    ],
  },
  {
    intent: 'tax-deductions',
    weight: 6,
    patterns: [
      /\bdeduction/,
      /\b(deductible|write[- ]?off|claim\w*)\b/,
      /\bwhat can i claim\b/,
    ],
  },
  {
    intent: 'tax-position',
    weight: 5,
    patterns: [
      /\b(taxable income|tax position|tax bill|owe.*tax|tax.*owe|tax refund|how much tax)\b/,
      /\bwhere am i (at|up to)\b.*\btax\b/,
    ],
  },
  {
    intent: 'goal-progress',
    weight: 6,
    patterns: [
      /\b(on track|on target)\b/,
      /\b(goal|goals|saving up|savings target)\b.*\b(progress|track|how|when|close|far)\b/,
      /\b(how (close|far)|will i (make|hit|reach))\b.*\b(goal|target|deposit|fund)\b/,
      /\bgoals?\b\s*\??$/,
    ],
  },
  {
    intent: 'forecast-outlook',
    weight: 6,
    patterns: [
      /\bforecast\b/,
      /\bcash ?flow\b/,
      /\b(will i|am i going to)\b.*\b(run out|short|negative|overdrawn)\b/,
      /\b(what|how much).*\b(left|balance)\b.*\b(end of|next month|30 days|60 days|90 days)\b/,
      /\bproject\w*\b.*\bbalance\b/,
    ],
  },
  {
    intent: 'budget-status',
    weight: 5,
    patterns: [
      /\bbudget/,
      /\b(over|under|within)\b.*\b(cap|limit)\b/,
      /\bhow am i (going|tracking|doing)\b.*\b(month|spending)\b/,
    ],
  },
  {
    intent: 'insights-changes',
    weight: 5,
    patterns: [
      /\bwhat (changed|has changed|is different)\b/,
      /\bwhy (is|are|did|has|have)\b.*\b(up|down|higher|lower|more|less|increas\w*|drop\w*|fall\w*|ris\w*)\b/,
      /\b(anything|what) (i should|to) (know|watch)\b/,
    ],
  },
  {
    intent: 'net-worth',
    weight: 5,
    patterns: [
      /\bnet worth\b/,
      /\bhow much (am i worth|do i have in total)\b/,
      /\bwhat('?s| is) my (position|total)\b/,
    ],
  },
  {
    // Above bills on purpose: a policy IS a bill, and answering "what's my car
    // insurance costing?" out of the bill list would report whatever bill is
    // next. Insurance is answered from the policies, or not at all.
    intent: 'insurance-cover',
    weight: 6,
    patterns: [
      /\binsur\w*\b/,
      /\b(polic(?:y|ies)|premiums?)\b/,
      /\b(?:am i|are we) covered\b/,
      /\bexcess\b.*\b(claim|cover)\b/,
    ],
  },
  {
    intent: 'bills-upcoming',
    weight: 5,
    patterns: [
      /\b(bills?|payments?|commitments?)\b.*\b(due|coming|upcoming|next|owe)\b/,
      /\bwhat('?s| is)\b.*\bdue\b/,
      /\bwhat do i owe\b/,
    ],
  },
  {
    intent: 'income-total',
    weight: 5,
    patterns: [
      /\bhow much (did|have) i (earn|earned|made|make|been paid)\b/,
      /\b(my )?income\b.*\b(this|last|year|month|total|so far)\b/,
      /\bhow much came in\b/,
    ],
  },
  {
    intent: 'spend-top',
    weight: 4,
    patterns: [
      /\b(where|what)\b.*\b(money (went|going|goes)|spending most|biggest)\b/,
      /\b(top|biggest|largest)\b.*\b(categor|expense|spend)/,
      /\bwhat am i spending (the )?most on\b/,
    ],
  },
  {
    intent: 'spend-total',
    weight: 3,
    patterns: [
      /\bhow much (did|have) i (spend|spent)\b/,
      /\bwhat (did|have) i spend\b/,
      /\bmy spending\b/,
    ],
    // The bare word on its own says almost nothing: "how much should I spend
    // on a wedding?" is not a question about this ledger's spending.
    loose: [/\bspend\w*\b/],
  },
];


/**
 * Questions Ledger recognises and cannot answer.
 *
 * Only ever consulted once no rule has matched, so this can never take a
 * question away from an engine that could have answered it. What it buys is
 * the difference between "Ledger could not tell what that question is asking"
 * and "Ledger tracks what you have, not what you should do" — the second tells
 * the user something true about the tool.
 */
const UNSUPPORTED: { pattern: RegExp; reason: string }[] = [
  {
    pattern: /\b(?:should i|shall i|is it worth|worth it to|do you think i should)\b.*\b(?:buy|sell|switch|invest|choose|get|take out|refinance|move to|go with)\b/,
    reason: 'Ledger can tell you what your own records say, but it cannot advise you on a decision like that.',
  },
  {
    pattern: /\b(?:which|what|who)\b.*\b(?:is (?:the )?(?:best|cheapest|better)|should i (?:choose|pick|use|go with)|do you recommend)\b/,
    reason: 'Ledger can price what you already have, but it cannot compare products or recommend one.',
  },
  {
    pattern: /\b(?:stock market|share price|market(?:s)? (?:today|doing)|crypto(?:currency)?|bitcoin|ethereum|exchange rate|interest rates? (?:will|are going|forecast|outlook))\b/,
    reason: 'Ledger only knows your own records — it has nothing on market prices, rates or forecasts beyond what you have entered.',
  },
  {
    pattern: /\b(?:tax|legal|financial|investment) advice\b/,
    reason: 'Ledger reports what your records show. It is not advice, and it cannot give any.',
  },
];

/** The reason a recognised-but-unanswerable question can't be answered. */
export function unsupportedTopic(text: string): string | null {
  for (const { pattern, reason } of UNSUPPORTED) {
    if (pattern.test(text)) return reason;
  }
  return null;
}

/**
 * The thing a spending question says it is about, when it names one.
 *
 * Only used to report that Ledger could NOT place it — never to guess a
 * category from it. Period words are excluded, because "how much did I spend
 * in July" names a window, not a subject.
 */
function spendSubject(text: string): string | null {
  const m = text.match(/\bspend(?:ing)?\s+(?:on|for)\s+([a-z0-9 &'-]{2,40})/)
    ?? text.match(/\bspent\s+(?:on|for)\s+([a-z0-9 &'-]{2,40})/);
  if (!m) return null;
  const subject = m[1]
    .replace(/\b(this|last|next|current|past|previous)\s+(year|month|week|day|financial year|fy|tax year)\b.*$/, '')
    .replace(/\b(in|during|over|since|between)\b.*$/, '')
    .replace(/\b(so far|to date|ytd|ever|in total|all time)\b.*$/, '')
    .trim();
  if (!subject) return null;
  // A bare period word is a window, not a subject.
  if (/^(this|last|it|that|things|stuff|everything)$/.test(subject)) return null;
  return subject;
}

/**
 * Read a question and decide what it is asking.
 *
 * Deterministic, and the DEFAULT path — Ask Ledger answers with no AI at all.
 * The score is the winning rule's weight plus a small bonus for a resolved
 * slot, normalised: a question that names both a shape and a real category is
 * more certainly understood than one that only matched "spend".
 */
/** A question that is nothing but a figure — "$2,000?" — is a follow-up. */
const BARE_FIGURE = /^\$?\s*\d[\d,]*(?:\.\d+)?\s*(?:k|m|%)?\s*[?.]?$/;

export function matchIntent(
  question: string,
  vocab: AskVocabulary,
  asOf: string,
  /** Intents to leave out of the running. Used to ask "what would this question
   *  be, if it weren't a hypothetical?" when the hypothetical cannot be read. */
  skip: AskIntentName[] = [],
): AskIntent {
  const text = norm(question);
  const period = parsePeriod(question, asOf);
  const category = resolveCategory(question, vocab.categories);
  const goalHit = lookupGoal(question, vocab.goals);
  const goal = goalHit.entity;
  const loanHit = findLoan(question, vocab.loans);
  const loan = loanHit.entity;
  const policyHit = findPolicy(question, vocab.policies);
  const property = findEntityInText(question, vocab.properties);

  // What a LOOSE pattern needs before it counts: something in the question
  // that exists in this ledger. Without one, a loose word is just a word.
  const grounded = !!(category || goal || loan || policyHit.entity || property || period);

  let winner: Rule | null = null;
  let score = 0;
  for (const rule of RULES) {
    if (skip.includes(rule.intent)) continue;
    const hit = rule.patterns.some(p => p.test(text))
      || (grounded && (rule.loose ?? []).some(p => p.test(text)));
    if (!hit) continue;
    if (rule.weight > score) {
      winner = rule;
      score = rule.weight;
    }
  }

  let name: AskIntentName = winner?.intent ?? 'unknown';
  if (name === 'unknown' && !skip.includes('what-if') && BARE_FIGURE.test(text)) {
    name = 'what-if';
    score = 3; // understood as a follow-up, which needs a previous question
  }

  // A spending question that names a category is the narrower question.
  if (name === 'spend-total' && category) name = 'spend-category';
  // "How much did I spend on my biggest categories" — the top rule already won.
  if (name === 'spend-category' && !category) name = 'spend-total';
  // "Am I on track" with no goal named is still the goals question — the answer
  // reports every goal rather than guessing which one was meant.
  if (name === 'goal-progress' && !goal && /\bforecast\b/.test(text)) name = 'forecast-outlook';
  // A question no rule matched, that names a goal (or something shaped like
  // one), is a goals question. Routing it here is what lets the answer say the
  // goal doesn't exist instead of shrugging at the whole question.
  if (name === 'unknown' && (goal || goalHit.requested)) name = 'goal-progress';

  const unresolved: UnresolvedSlot[] = [];
  // The question named a GOAL Ledger could not confidently place. This is
  // recorded rather than shrugged off, because a goals question with no goal
  // resolved otherwise answers about every goal — which, to somebody with one
  // goal, is indistinguishable from answering about the one they didn't ask
  // about. The answer is built from this slot, not from the goal list.
  if (goalHit.requested && !goal) {
    unresolved.push({
      slot: 'goal',
      requested: goalHit.requested,
      suggestions: goalHit.suggestions.map(g => g.name),
      available: vocab.goals.map(g => g.name),
    });
  }

  // The question named a LOAN Ledger could not place. Recorded for exactly the
  // reason a goal is: a loan question with no loan resolved otherwise answers
  // about every loan, which to somebody with one loan is indistinguishable
  // from an answer about the loan they did not ask about.
  if (loanHit.requested && !loan && (name === 'loan-payoff' || name === 'loan-offset')) {
    unresolved.push({
      slot: 'loan',
      requested: loanHit.requested,
      suggestions: loanHit.suggestions,
      available: vocab.loans.map(l => l.name),
    });
  }

  // The same for a named policy on an insurance question.
  if (policyHit.requested && !policyHit.entity && name === 'insurance-cover') {
    unresolved.push({
      slot: 'policy',
      requested: policyHit.requested,
      suggestions: policyHit.suggestions,
      available: vocab.policies.map(p => p.name),
    });
  }

  // The question named a spending subject we couldn't place ("how much did I
  // spend ON YACHT MAINTENANCE"). Answering about all spending is the right
  // fallback, but doing it SILENTLY would read as an answer to the narrower
  // question that was actually asked.
  if (name === 'spend-total' && !category) {
    const subject = spendSubject(text);
    if (subject) unresolved.push({ slot: 'category', requested: subject });
  }

  const fy = period?.fy
    ?? (name === 'tax-deductions' || name === 'tax-position' ? fyOf(asOf) : null);

  const bonus = (category ? 1 : 0) + (goal || loan || policyHit.entity || property ? 1 : 0) + (period ? 1 : 0);
  return {
    name,
    question: question.trim(),
    period,
    category,
    goal,
    loan,
    policy: policyHit.entity,
    property,
    fy,
    whatIf: null,
    unresolved,
    // Only ever asked about a question nothing matched — so a question Ledger
    // CAN answer is never talked out of its answer by this.
    unsupported: name === 'unknown' ? unsupportedTopic(text) : null,
    source: 'rules',
    confidence: name === 'unknown' ? 0 : Math.min(1, (score + bonus) / 8),
  };
}

// ─── Follow-ups ──────────────────────────────────────────────────────────────

/** The openers that mark a question as pointing back at the one before. */
const FOLLOW_UP_LEAD = /^(?:and|what about|how about|same (?:for|in|with)|now(?: for)?)\s+/i;

/**
 * Read a short follow-up against the previous question.
 *
 * "What about groceries?" after a spending question is the same question with
 * the category swapped; "and last month?" is the same question with the period
 * swapped. Only otherwise-unreadable questions reach here — anything the
 * matcher understood on its own has already won — and only ONE thing is ever
 * swapped per rule below, so a full new sentence is never mistaken for a
 * revision. Returns null when nothing in the follow-up names a slot the
 * previous question carries.
 *
 * (A follow-up to a HYPOTHETICAL — "what about $2,000?" — is not handled here:
 * `askScenario.reviseScenario` owns that, because it revises the scenario, not
 * the intent.)
 */
export function reviseIntent(
  question: string,
  previous: AskIntent,
  vocab: AskVocabulary,
  asOf: string,
): AskIntent | null {
  if (previous.name === 'unknown' || previous.name === 'what-if') return null;

  const trimmed = question.trim().replace(/[?.!\s]+$/, '');
  if (!trimmed) return null;
  const stripped = trimmed.replace(FOLLOW_UP_LEAD, '').trim();
  const marked = stripped !== trimmed;
  // Unmarked text only counts as a follow-up when it is a bare fragment — a
  // couple of words naming one thing. Anything longer is a new question.
  if (!marked && stripped.split(/\s+/).length > 4) return null;
  if (!stripped) return null;

  const period = parsePeriod(stripped, asOf);
  const category = resolveCategory(stripped, vocab.categories);
  const goal = findEntityInText(stripped, vocab.goals);
  const loan = findEntityInText(stripped, vocab.loans);
  const policy = findEntityInText(stripped, vocab.policies);

  const base: AskIntent = {
    ...previous,
    question: question.trim(),
    whatIf: null,
    unresolved: [],
    unsupported: null,
    source: 'follow-up',
    confidence: 0.6,
  };

  // A named goal or loan re-points the matching question at the new record.
  if (goal && previous.name === 'goal-progress') {
    return { ...base, goal };
  }
  if (loan && (previous.name === 'loan-offset' || previous.name === 'loan-payoff')) {
    return { ...base, loan };
  }
  if (policy && previous.name === 'insurance-cover') {
    return { ...base, policy };
  }

  // A named category narrows (or re-points) a spending question.
  const spendFamily = previous.name === 'spend-total' || previous.name === 'spend-top' || previous.name === 'spend-category';
  if (category && spendFamily) {
    return {
      ...base,
      name: 'spend-category',
      category,
      period: period ?? previous.period,
    };
  }

  // A new period re-runs the same question over it.
  if (period) {
    if (spendFamily || previous.name === 'income-total') {
      return { ...base, period };
    }
    if ((previous.name === 'tax-deductions' || previous.name === 'tax-position') && period.fy) {
      return { ...base, period, fy: period.fy };
    }
  }

  return null;
}

// ─── The AI gate ─────────────────────────────────────────────────────────────

/** The shape the model is asked to return. Every field is untrusted. */
export interface RawAiIntent {
  intent?: unknown;
  category?: unknown;
  goal?: unknown;
  loan?: unknown;
  policy?: unknown;
  property?: unknown;
  period?: unknown;
  financial_year?: unknown;
  confidence?: unknown;
}

/**
 * Turn an untrusted model proposal into an intent Ledger will act on.
 *
 * THE GATE. Everything the model says is checked against the closed intent list
 * and the user's own vocabulary:
 *   • an unknown intent name → `unknown`, not a near neighbour;
 *   • a category, goal, loan or property that doesn't exist → dropped into
 *     `unresolved`, so the answer can say "you have no such category" instead
 *     of quietly answering about something else;
 *   • a period is re-parsed HERE from the model's phrase, so dates are computed
 *     by this module and never taken from the model;
 *   • a financial year the tax engine doesn't cover → dropped.
 *
 * `fallback` is the rules match for the same question. It supplies any slot the
 * model left empty, so the AI can only ever add understanding, never remove it.
 */
/**
 * How sure a model must be before its proposal is allowed to place a question
 * the rules could not. Below this, "Ledger cannot answer that yet" is the
 * honest answer and the one the user gets.
 */
export const AI_INTENT_FLOOR = 0.5;

export function sanitiseIntent(
  raw: RawAiIntent | null | undefined,
  question: string,
  vocab: AskVocabulary,
  asOf: string,
  fallback?: AskIntent,
): AskIntent {
  const base = fallback ?? matchIntent(question, vocab, asOf);
  if (!raw || typeof raw !== 'object') return base;

  const name: AskIntentName = isAskIntent(raw.intent) ? raw.intent : 'unknown';
  // A model that can't place the question doesn't get to overrule a rules match
  // that could — it only speaks when it knows something the rules didn't.
  if (name === 'unknown') return base;

  const modelConfidence = typeof raw.confidence === 'number' && raw.confidence >= 0 && raw.confidence <= 1
    ? raw.confidence
    : 0.6;
  // The rules could not place this question, and the model is not sure either.
  // Two guesses do not add up to an understanding: a hesitant proposal is left
  // where it belongs, and the user is told Ledger cannot answer it yet.
  if (base.name === 'unknown' && modelConfidence < AI_INTENT_FLOOR) return base;
  // Hypotheticals are not the model's to decide, in either direction. Ledger
  // read a scenario out of the user's own words, with its own figures; a model
  // cannot talk it out of that, and — since it is never offered `what-if` and
  // could not supply the amounts anyway — cannot talk it into one either.
  if (base.name === 'what-if' && base.whatIf?.scenario) return base;
  if (name === 'what-if') return base;

  const unresolved: UnresolvedSlot[] = [];

  const str = (v: unknown): string | null => {
    const s = typeof v === 'string' ? v.trim() : '';
    return s ? s : null;
  };

  let category = base.category;
  const rawCategory = str(raw.category);
  if (rawCategory) {
    const hit = resolveCategory(rawCategory, vocab.categories)
      ?? (vocab.categories.find(c => norm(c) === norm(rawCategory)) ?? null);
    if (hit) category = hit;
    else unresolved.push({ slot: 'category', requested: rawCategory });
  }

  // A name the model returns is put through the same matcher a typed one is:
  // confident or nothing. A near miss becomes a "did you mean", so the model
  // proposing "car goal" to somebody who only has "House deposit" produces a
  // question — never an answer about the house deposit.
  const resolveNamed = (
    value: unknown,
    list: NamedEntity[],
    slot: UnresolvedSlot['slot'],
    current: NamedEntity | null,
  ): NamedEntity | null => {
    const s = str(value);
    if (!s) return current;
    const hit = matchEntity(s, list);
    if (hit.kind === 'resolved') return hit.entity;
    // The rules already found a real name written in the question. A model
    // naming something else on top of that is dropped rather than reported —
    // the user asked about the record they named.
    if (current) return current;
    // The rules already reported this slot as unplaceable, in the user's own
    // words. Those are the words to quote back, not the model's rewording.
    if (base.unresolved.some(u => u.slot === slot)) return current;
    unresolved.push({
      slot,
      requested: s,
      suggestions: hit.kind === 'near' ? hit.candidates.map(c => c.name) : [],
      available: list.map(e => e.name),
    });
    return current;
  };

  const goal = resolveNamed(raw.goal, vocab.goals, 'goal', base.goal);
  const loan = resolveNamed(raw.loan, vocab.loans, 'loan', base.loan);
  const policy = resolveNamed(raw.policy, vocab.policies, 'policy', base.policy);
  const property = resolveNamed(raw.property, vocab.properties, 'property', base.property);

  // The model may only NAME a period; this module dates it.
  let period = base.period;
  const rawPeriod = str(raw.period);
  if (rawPeriod) period = parsePeriod(rawPeriod, asOf) ?? base.period;

  let fy = period?.fy ?? base.fy;
  const rawFy = str(raw.financial_year);
  if (rawFy) {
    if (vocab.financialYears.includes(rawFy)) fy = rawFy;
    else if (/^20\d{2}-20\d{2}$/.test(rawFy)) fy = rawFy; // well-formed, engine will report it empty
    else unresolved.push({ slot: 'financial-year', requested: rawFy });
  }

  // The narrowing the rules matcher applies, applied to the model's answer too.
  let finalName = name;
  if (finalName === 'spend-total' && category) finalName = 'spend-category';
  if (finalName === 'spend-category' && !category) {
    finalName = 'spend-total';
    if (!unresolved.some(u => u.slot === 'category')) {
      unresolved.push({ slot: 'category', requested: rawCategory ?? question });
    }
  }

  const filled = (slot: UnresolvedSlot['slot']): boolean =>
    (slot === 'category' && !!category)
    || (slot === 'goal' && !!goal)
    || (slot === 'loan' && !!loan)
    || (slot === 'policy' && !!policy)
    || (slot === 'property' && !!property);

  return {
    name: finalName,
    question: question.trim(),
    period,
    category,
    goal,
    loan,
    policy,
    property,
    fy: fy ?? (finalName === 'tax-deductions' || finalName === 'tax-position' ? fyOf(asOf) : null),
    // Carried, never proposed: a scenario is read from the user's OWN words by
    // `askScenario`, so a model cannot introduce one — or change its figures.
    whatIf: base.whatIf,
    // A slot the model managed to fill retires whatever the rules could not place.
    unresolved: [...base.unresolved.filter(u => !filled(u.slot)), ...unresolved],
    // The model placed the question, so whatever Ledger could not place about
    // it no longer stands.
    unsupported: null,
    source: 'ai',
    // Never more certain than the rules would be about a question they matched.
    confidence: Math.min(modelConfidence, base.name === finalName ? 1 : 0.9),
  };
}

/** The compact vocabulary sent to the model — names only, no figures ever. */
export function vocabularyForModel(vocab: AskVocabulary): {
  intents: string[];
  categories: string[];
  goals: string[];
  loans: string[];
  policies: string[];
  properties: string[];
  financial_years: string[];
} {
  return {
    // `what-if` is deliberately absent: a hypothetical's figures come from the
    // user's own sentence, read by `askScenario`, and the model is never shown
    // a figure. Offering it would invite a proposal Ledger would only discard.
    intents: ASK_INTENTS.filter(i => i !== 'unknown' && i !== 'what-if'),
    categories: vocab.categories,
    goals: vocab.goals.map(g => g.name),
    loans: vocab.loans.map(l => l.name),
    policies: vocab.policies.map(p => p.name),
    properties: vocab.properties.map(p => p.name),
    financial_years: vocab.financialYears,
  };
}
