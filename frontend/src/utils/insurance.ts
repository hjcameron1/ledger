/**
 * Phase 8.2 — insurance (pure engine).
 *
 * ONE place that turns stored policy columns into the figures every surface
 * shows: what cover costs a year, when it renews, whether it has lapsed, and
 * what the premium has done since last time. The page renders it, the alerts
 * engine raises renewals from it and the insights engine reports premium
 * movement from it — so a renewal date on the Insurance page and a warning on
 * the Overview can never disagree.
 *
 * ── Two rules worth stating ──────────────────────────────────────────────────
 *
 * 1. COST IS DERIVED, NEVER STORED. A policy stores what it is billed and how
 *    often; the annual and monthly figures come from `monthlyEquivalent` — the
 *    SAME cadence arithmetic the forecast and the recurring engines use, so a
 *    fortnightly premium means the same number of dollars a year here as it does
 *    everywhere else in the app.
 *
 * 2. EXPIRY IS A DATE COMPARISON, NEVER A FLAG. A policy is expired because its
 *    renewal date has passed, not because something wrote "expired" on it —
 *    which is why cover cannot silently stay "current" in the database while
 *    having actually lapsed a month ago. The one stored flag is `active`, and it
 *    means "I still hold this policy", which is a decision only a person can
 *    make.
 *
 * ── What is deliberately NOT here ────────────────────────────────────────────
 * Premiums are not fed into the cash-flow forecast. They are paid by ordinary
 * transactions that the forecast already sees, and adding them would count the
 * same money twice — the exact double-count Phase 4.1 exists to prevent.
 *
 * Pure and dependency-injected (`asOf` is passed in), so every rule below is
 * exercised directly by insurance.test.ts.
 */

import { monthlyEquivalent } from './adaptiveForecast';
import { round2 } from './cashFlowForecast';
import type { ForecastFrequency } from './cashFlowForecast';

// ─── Vocabulary ──────────────────────────────────────────────────────────────

export type PolicyType =
  | 'home' | 'contents' | 'landlord' | 'car' | 'health' | 'life'
  | 'income_protection' | 'travel' | 'pet' | 'business' | 'other';

/** The forecast engine's cadences minus `once` — a premium that is never billed
 *  again is not a premium, it is a receipt. */
export type PremiumFrequency =
  Extract<ForecastFrequency, 'weekly' | 'fortnightly' | 'monthly' | 'quarterly' | 'annually'>;

export type PolicyLinkType =
  | 'account' | 'card' | 'loan' | 'property' | 'investment' | 'household';

/**
 * Where a policy stands today.
 *
 *   active    in force, renewal (if any) comfortably away.
 *   due-soon  in force, renewing inside the reminder window.
 *   expired   the renewal date has passed and nothing has renewed it — cover may
 *             have lapsed, which is the single most consequential thing this
 *             feature can tell anybody.
 *   inactive  the user says they no longer hold it. Kept for its history.
 */
export type PolicyStatus = 'active' | 'due-soon' | 'expired' | 'inactive';

// ─── Thresholds ──────────────────────────────────────────────────────────────

export interface InsuranceThresholds {
  /** Days before renewal that a policy starts being called "due soon". */
  renewalSoonDays: number;
  /** …and inside this many days it is imminent, which raises the alert stage. */
  renewalImminentDays: number;
}

export const DEFAULT_INSURANCE_THRESHOLDS: InsuranceThresholds = {
  renewalSoonDays: 30,
  renewalImminentDays: 7,
};

// ─── Inputs ──────────────────────────────────────────────────────────────────

/** A policy row, exactly as the API returns it. */
export interface InsurancePolicyInput {
  id: string;
  name: string;
  policy_type: PolicyType;
  insurer?: string | null;
  policy_number?: string | null;
  premium_amount?: number | null;
  premium_frequency?: PremiumFrequency | null;
  start_date?: string | null;
  renewal_date?: string | null;
  excess?: number | null;
  coverage_amount?: number | null;
  linked_type?: PolicyLinkType | null;
  linked_id?: string | null;
  document_id?: string | null;
  notes?: string | null;
  active?: boolean | null;
}

/** One price the policy has been sold at, from `insurance_premium_history`. */
export interface PremiumRecordInput {
  id: string;
  policy_id: string;
  premium_amount?: number | null;
  premium_frequency?: PremiumFrequency | null;
  effective_date: string;
  note?: string | null;
}

// ─── Outputs ─────────────────────────────────────────────────────────────────

/**
 * What the premium has done, measured ANNUALISED.
 *
 * Annualised deliberately: a policy that moves from $120 a month to $1,300 a
 * year is $140 a year cheaper, and comparing the two billed amounts ($120 vs
 * $1,300) would call that a tenfold rise. Only the yearly cost is comparable
 * across a cadence change, so only the yearly cost is compared.
 */
export interface PremiumChange {
  /** What it used to be billed, and how often. */
  previousAmount: number;
  previousFrequency: PremiumFrequency;
  /** What it is billed now. */
  amount: number;
  frequency: PremiumFrequency;
  previousAnnual: number;
  annual: number;
  /** annual − previousAnnual. Positive means it costs more. */
  delta: number;
  /** `delta` as a share of `previousAnnual`, %. */
  percent: number;
  /** When the new price started applying. */
  date: string;
  /** True when the billing cadence changed too — worth saying out loud, because
   *  it is the case where the billed figure and the yearly cost disagree. */
  frequencyChanged: boolean;
}

export interface InsuranceLine {
  id: string;
  name: string;
  type: PolicyType;
  insurer: string | null;
  policyNumber: string | null;
  /** What it is billed, at `frequency`. */
  premium: number;
  frequency: PremiumFrequency;
  /** The same money as a yearly and a monthly figure — the only two scales on
   *  which two policies can be compared. */
  annualPremium: number;
  monthlyPremium: number;
  renewalDate: string | null;
  /** Days from `asOf` to the renewal. Negative once it has passed; null when the
   *  policy has no renewal date at all (life cover often doesn't). */
  daysToRenewal: number | null;
  status: PolicyStatus;
  /** True when cover has run out and the user still says they hold it. */
  expired: boolean;
  excess: number | null;
  coverageAmount: number | null;
  linkedType: PolicyLinkType | null;
  linkedId: string | null;
  documentId: string | null;
  notes: string | null;
  active: boolean;
  /** The most recent premium movement, or null when there is nothing to compare. */
  premiumChange: PremiumChange | null;
}

/** One row of the "what am I covered for" summary. */
export interface InsuranceTypeTotal {
  type: PolicyType;
  count: number;
  annualPremium: number;
  coverageAmount: number;
}

export interface InsuranceReport {
  asOf: string;
  /** Every policy, soonest renewal first (see `sortLines`). */
  lines: InsuranceLine[];
  /** Cover the user still holds — `active` and `due-soon` and `expired` alike.
   *  An expired policy is still one they think they have, which is exactly why
   *  it stays on this LIST (and keeps alerting) — but it has lapsed, so the
   *  money totals below do not sell it as current cover. */
  held: InsuranceLine[];
  /** Cover that actually stands today — held, less what has lapsed. This is
   *  the list every total is summed from. */
  current: InsuranceLine[];
  /** Cover that has run out and not been renewed. */
  expired: InsuranceLine[];
  /** Policies the user has marked as no longer held. */
  inactive: InsuranceLine[];
  /** What CURRENT cover costs a year, and a month. A lapsed policy costs
   *  nothing (nobody is billing for it) and covers nothing — counting it was
   *  selling expired cover as current. Inactive policies count nothing. */
  totalAnnualPremium: number;
  totalMonthlyPremium: number;
  /** Total sum insured across current policies that state one. Not a net-worth
   *  figure and never treated as one: it is a promise, not an asset. */
  totalCoverage: number;
  byType: InsuranceTypeTotal[];
  /** The next policy due to renew, or null when none has a future date. */
  nextRenewal: InsuranceLine | null;
}

// ─── Dates ───────────────────────────────────────────────────────────────────

/** Whole days from `from` to `to` (`to` − `from`), UTC so no local-timezone
 *  drift can move a renewal across midnight. NaN-safe: null when unparseable. */
export function daysBetween(from: string, to: string): number | null {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

// ─── The engine ──────────────────────────────────────────────────────────────

const freq = (f: PremiumFrequency | null | undefined): PremiumFrequency => f ?? 'annually';

/** The yearly cost of an amount billed at a cadence — the app's ONE piece of
 *  cadence arithmetic, borrowed rather than re-implemented. */
export function annualPremiumOf(amount: number, frequency: PremiumFrequency): number {
  return round2(monthlyEquivalent(Math.abs(amount || 0), frequency) * 12);
}

/**
 * The prices this policy has been sold at, oldest first.
 *
 * History rows are the record; the policy's own premium is the truth about
 * today. When the two disagree — a price edited on a device that never wrote a
 * history row, a row that failed to sync — the CURRENT price is appended as a
 * final entry rather than ignored. Silently trusting stale history would have
 * the app report last year's premium as this year's, which is worse than
 * reporting a change whose exact date we had to take as today.
 */
function premiumTimeline(
  policy: InsurancePolicyInput,
  history: PremiumRecordInput[],
  asOf: string,
): { amount: number; frequency: PremiumFrequency; date: string; annual: number }[] {
  const rows = history
    .filter(h => h.policy_id === policy.id)
    .map(h => ({
      amount: round2(h.premium_amount ?? 0),
      frequency: freq(h.premium_frequency),
      date: h.effective_date,
    }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.amount - b.amount);

  const current = {
    amount: round2(policy.premium_amount ?? 0),
    frequency: freq(policy.premium_frequency),
    date: asOf,
  };
  const last = rows[rows.length - 1];
  if (!last || last.amount !== current.amount || last.frequency !== current.frequency) {
    rows.push(current);
  }

  return rows.map(r => ({ ...r, annual: annualPremiumOf(r.amount, r.frequency) }));
}

/** The latest movement in the timeline, or null when the price has never moved
 *  (or has moved by nothing at all — a cadence change that costs the same is not
 *  a premium change, it is a billing change). */
function latestChange(
  timeline: ReturnType<typeof premiumTimeline>,
): PremiumChange | null {
  if (timeline.length < 2) return null;
  const now = timeline[timeline.length - 1];
  const before = timeline[timeline.length - 2];
  const delta = round2(now.annual - before.annual);
  if (delta === 0) return null;

  return {
    previousAmount: before.amount,
    previousFrequency: before.frequency,
    amount: now.amount,
    frequency: now.frequency,
    previousAnnual: before.annual,
    annual: now.annual,
    delta,
    percent: before.annual > 0 ? round2((delta / before.annual) * 100) : 100,
    date: now.date,
    frequencyChanged: now.frequency !== before.frequency,
  };
}

function statusOf(
  active: boolean, daysToRenewal: number | null, t: InsuranceThresholds,
): PolicyStatus {
  if (!active) return 'inactive';
  if (daysToRenewal == null) return 'active';
  if (daysToRenewal < 0) return 'expired';
  return daysToRenewal <= t.renewalSoonDays ? 'due-soon' : 'active';
}

/**
 * Soonest first, and what has ALREADY lapsed leads — an expired policy is more
 * urgent than one renewing next week, and both are more urgent than one with no
 * date at all. Inactive cover sinks to the bottom whatever its dates say.
 */
export function sortLines(lines: InsuranceLine[]): InsuranceLine[] {
  const rank = (l: InsuranceLine): number => {
    if (!l.active) return 3;
    if (l.expired) return 0;
    return l.daysToRenewal == null ? 2 : 1;
  };
  return [...lines].sort((a, b) => {
    const byRank = rank(a) - rank(b);
    if (byRank !== 0) return byRank;
    // Inside a rank, the sooner date first (for expired: the longest-lapsed
    // first, which is the same comparison — smaller number of days).
    const da = a.daysToRenewal ?? Number.MAX_SAFE_INTEGER;
    const db = b.daysToRenewal ?? Number.MAX_SAFE_INTEGER;
    if (da !== db) return da - db;
    return a.name.localeCompare(b.name);
  });
}

export interface BuildInsuranceParams {
  /** Today, `YYYY-MM-DD`. Injected for determinism. */
  asOf: string;
  policies: InsurancePolicyInput[];
  /** Every premium record the caller holds; each line takes only its own. */
  premiumHistory?: PremiumRecordInput[];
  thresholds?: Partial<InsuranceThresholds>;
}

export function buildInsuranceReport(params: BuildInsuranceParams): InsuranceReport {
  const t = { ...DEFAULT_INSURANCE_THRESHOLDS, ...(params.thresholds ?? {}) };
  const history = params.premiumHistory ?? [];

  const lines: InsuranceLine[] = params.policies.map(p => {
    const active = p.active !== false;
    const premium = round2(p.premium_amount ?? 0);
    const frequency = freq(p.premium_frequency);
    const daysToRenewal = p.renewal_date ? daysBetween(params.asOf, p.renewal_date) : null;
    const status = statusOf(active, daysToRenewal, t);

    return {
      id: p.id,
      name: p.name,
      type: p.policy_type ?? 'other',
      insurer: p.insurer ?? null,
      policyNumber: p.policy_number ?? null,
      premium,
      frequency,
      annualPremium: annualPremiumOf(premium, frequency),
      monthlyPremium: round2(monthlyEquivalent(premium, frequency)),
      renewalDate: p.renewal_date ?? null,
      daysToRenewal,
      status,
      expired: status === 'expired',
      excess: p.excess ?? null,
      coverageAmount: p.coverage_amount ?? null,
      linkedType: p.linked_type ?? null,
      linkedId: p.linked_id ?? null,
      documentId: p.document_id ?? null,
      notes: p.notes ?? null,
      active,
      premiumChange: latestChange(premiumTimeline(p, history, params.asOf)),
    };
  });

  const sorted = sortLines(lines);
  const held = sorted.filter(l => l.active);
  const current = held.filter(l => !l.expired);
  const expired = sorted.filter(l => l.expired);
  const inactive = sorted.filter(l => !l.active);

  const byType = new Map<PolicyType, InsuranceTypeTotal>();
  for (const line of current) {
    const row = byType.get(line.type)
      ?? { type: line.type, count: 0, annualPremium: 0, coverageAmount: 0 };
    row.count += 1;
    row.annualPremium = round2(row.annualPremium + line.annualPremium);
    row.coverageAmount = round2(row.coverageAmount + (line.coverageAmount ?? 0));
    byType.set(line.type, row);
  }

  return {
    asOf: params.asOf,
    lines: sorted,
    held,
    current,
    expired,
    inactive,
    totalAnnualPremium: round2(current.reduce((sum, l) => sum + l.annualPremium, 0)),
    totalMonthlyPremium: round2(current.reduce((sum, l) => sum + l.monthlyPremium, 0)),
    totalCoverage: round2(current.reduce((sum, l) => sum + (l.coverageAmount ?? 0), 0)),
    byType: [...byType.values()].sort((a, b) => b.annualPremium - a.annualPremium),
    // The next one due: a future (or today's) date, soonest first. Something
    // already lapsed is not "next" — it is late, and the alerts engine says so.
    nextRenewal: held.find(l => (l.daysToRenewal ?? -1) >= 0) ?? null,
  };
}

// ─── Presentation vocabulary ─────────────────────────────────────────────────
//
// Labels rather than sentences: no currency and no dates are formatted here, so
// this stays as testable as the arithmetic above.

export const POLICY_TYPES: { value: PolicyType; label: string }[] = [
  { value: 'home', label: 'Home / building' },
  { value: 'contents', label: 'Contents' },
  { value: 'landlord', label: 'Landlord' },
  { value: 'car', label: 'Car / vehicle' },
  { value: 'health', label: 'Health' },
  { value: 'life', label: 'Life' },
  { value: 'income_protection', label: 'Income protection' },
  { value: 'travel', label: 'Travel' },
  { value: 'pet', label: 'Pet' },
  { value: 'business', label: 'Business' },
  { value: 'other', label: 'Other' },
];

export function policyTypeLabel(type: string): string {
  return POLICY_TYPES.find(t => t.value === type)?.label ?? 'Other';
}

export const PREMIUM_FREQUENCIES: { value: PremiumFrequency; label: string }[] = [
  { value: 'weekly', label: 'Weekly' },
  { value: 'fortnightly', label: 'Fortnightly' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'quarterly', label: 'Quarterly' },
  { value: 'annually', label: 'Yearly' },
];

/** "a month", "a year" — the tail of "costs $X …". */
export const FREQUENCY_SUFFIX: Record<PremiumFrequency, string> = {
  weekly: 'a week',
  fortnightly: 'a fortnight',
  monthly: 'a month',
  quarterly: 'a quarter',
  annually: 'a year',
};

export const STATUS_LABEL: Record<PolicyStatus, string> = {
  active: 'Active',
  'due-soon': 'Renews soon',
  expired: 'Expired',
  inactive: 'Not held',
};

/** Kind filter + free-text search over what a person actually remembers: the
 *  name, the insurer, the policy number, the notes and the words of its type. */
export function filterPolicies(
  lines: InsuranceLine[], type: PolicyType | 'all', search: string,
): InsuranceLine[] {
  const q = search.trim().toLowerCase();
  return lines.filter(l => {
    if (type !== 'all' && l.type !== type) return false;
    if (!q) return true;
    return [l.name, l.insurer, l.policyNumber, l.notes, policyTypeLabel(l.type)]
      .some(f => (f ?? '').toLowerCase().includes(q));
  });
}
