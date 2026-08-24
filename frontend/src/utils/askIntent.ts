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
 * Everything a question is ALLOWED to refer to, gathered from the user's own
 * (scope-filtered) data by the DS layer. A slot that isn't in here cannot be
 * filled — which is what stops "my Bali fund" resolving to a goal that doesn't
 * exist, whether a person or a model proposed it.
 */
export interface AskVocabulary {
  /** Category names in use: the canonical taxonomy plus the user's own. */
  categories: string[];
  goals: NamedEntity[];
  loans: NamedEntity[];
  properties: NamedEntity[];
  accounts: NamedEntity[];
  /** Financial years the tax engine can report on, newest first. */
  financialYears: string[];
}

/** An empty vocabulary — a brand-new account can still be asked questions. */
export function emptyVocabulary(): AskVocabulary {
  return {
    categories: [...LEDGER_CATEGORIES],
    goals: [], loans: [], properties: [], accounts: [], financialYears: [],
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

/**
 * Resolve a name a model or a user typed to one of the user's records.
 * Exact (case-insensitive) first, then a containment match that must be
 * unambiguous — two candidates means we ask rather than pick.
 */
export function resolveEntity(name: string, entities: NamedEntity[]): NamedEntity | null {
  const n = norm(name);
  if (!n) return null;
  const exact = entities.find(e => norm(e.name) === n);
  if (exact) return exact;
  const partial = entities.filter(e => norm(e.name).includes(n) || n.includes(norm(e.name)));
  return partial.length === 1 ? partial[0] : null;
}

/** The record a question names, found by scanning the question for each name. */
export function findEntityInText(text: string, entities: NamedEntity[]): NamedEntity | null {
  const t = norm(text);
  let best: NamedEntity | null = null;
  for (const e of entities) {
    const n = norm(e.name);
    if (n.length < 3) continue; // too short to match on safely
    if (t.includes(n) && (!best || n.length > norm(best.name).length)) best = e;
  }
  return best;
}

// ─── The intent ──────────────────────────────────────────────────────────────

/** Why a slot the question asked for isn't filled. Surfaced, never papered over. */
export interface UnresolvedSlot {
  slot: 'category' | 'goal' | 'loan' | 'property' | 'period' | 'financial-year';
  /** What the question (or the model) asked for. */
  requested: string;
}

export interface AskIntent {
  name: AskIntentName;
  /** The question as asked, verbatim. */
  question: string;
  period: AskPeriod | null;
  /** Always one of the user's real categories, or null. */
  category: string | null;
  /** The named goal / loan / property, when the question is about one. */
  goal: NamedEntity | null;
  loan: NamedEntity | null;
  property: NamedEntity | null;
  /** A financial year the tax engine knows about. */
  fy: string | null;
  /** Slots the question reached for that don't exist in the user's data. */
  unresolved: UnresolvedSlot[];
  /** How the intent was arrived at — shown to the user, never hidden. */
  source: 'rules' | 'ai';
  /** 0–1. The rules matcher scores its own certainty; the AI's is capped by it. */
  confidence: number;
}

interface Rule {
  intent: AskIntentName;
  /** Every pattern that votes for this intent. */
  patterns: RegExp[];
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
      /\bspend\w*\b/,
    ],
  },
];


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
export function matchIntent(question: string, vocab: AskVocabulary, asOf: string): AskIntent {
  const text = norm(question);
  const period = parsePeriod(question, asOf);
  const category = resolveCategory(question, vocab.categories);
  const goal = findEntityInText(question, vocab.goals);
  const loan = findEntityInText(question, vocab.loans);
  const property = findEntityInText(question, vocab.properties);

  let winner: Rule | null = null;
  let score = 0;
  for (const rule of RULES) {
    if (!rule.patterns.some(p => p.test(text))) continue;
    if (rule.weight > score) {
      winner = rule;
      score = rule.weight;
    }
  }

  let name: AskIntentName = winner?.intent ?? 'unknown';

  // A spending question that names a category is the narrower question.
  if (name === 'spend-total' && category) name = 'spend-category';
  // "How much did I spend on my biggest categories" — the top rule already won.
  if (name === 'spend-category' && !category) name = 'spend-total';
  // "Am I on track" with no goal named is still the goals question — the answer
  // reports every goal rather than guessing which one was meant.
  if (name === 'goal-progress' && !goal && /\bforecast\b/.test(text)) name = 'forecast-outlook';

  const unresolved: UnresolvedSlot[] = [];
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

  const bonus = (category ? 1 : 0) + (goal || loan || property ? 1 : 0) + (period ? 1 : 0);
  return {
    name,
    question: question.trim(),
    period,
    category,
    goal,
    loan,
    property,
    fy,
    unresolved,
    source: 'rules',
    confidence: name === 'unknown' ? 0 : Math.min(1, (score + bonus) / 8),
  };
}

// ─── The AI gate ─────────────────────────────────────────────────────────────

/** The shape the model is asked to return. Every field is untrusted. */
export interface RawAiIntent {
  intent?: unknown;
  category?: unknown;
  goal?: unknown;
  loan?: unknown;
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

  const resolveNamed = (
    value: unknown,
    list: NamedEntity[],
    slot: UnresolvedSlot['slot'],
    current: NamedEntity | null,
  ): NamedEntity | null => {
    const s = str(value);
    if (!s) return current;
    const hit = resolveEntity(s, list);
    if (hit) return hit;
    unresolved.push({ slot, requested: s });
    return current;
  };

  const goal = resolveNamed(raw.goal, vocab.goals, 'goal', base.goal);
  const loan = resolveNamed(raw.loan, vocab.loans, 'loan', base.loan);
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

  const modelConfidence = typeof raw.confidence === 'number' && raw.confidence >= 0 && raw.confidence <= 1
    ? raw.confidence
    : 0.6;

  return {
    name: finalName,
    question: question.trim(),
    period,
    category,
    goal,
    loan,
    property,
    fy: fy ?? (finalName === 'tax-deductions' || finalName === 'tax-position' ? fyOf(asOf) : null),
    unresolved: [...base.unresolved.filter(u => u.slot !== 'category' || !category), ...unresolved],
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
  properties: string[];
  financial_years: string[];
} {
  return {
    intents: ASK_INTENTS.filter(i => i !== 'unknown'),
    categories: vocab.categories,
    goals: vocab.goals.map(g => g.name),
    loans: vocab.loans.map(l => l.name),
    properties: vocab.properties.map(p => p.name),
    financial_years: vocab.financialYears,
  };
}
