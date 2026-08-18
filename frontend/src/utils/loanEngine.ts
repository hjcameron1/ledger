/**
 * Phase 4.2 — the mortgage / debt engine.
 *
 * Pure arithmetic over the loans the user already has. No store, no React, no
 * I/O: every projected balance, interest figure, payoff date and "what if I paid
 * more" answer the Loans tab shows is derived here, so the screen can only ever
 * say what the maths says.
 *
 * ── The one rule that shapes this file ──────────────────────────────────────
 * A MORTGAGE IS A LOAN. Phase 4.1 made a property point at a row in `loans`
 * rather than store a mortgage of its own, and this phase keeps that promise:
 * there is no mortgage record, no mortgage balance and no mortgage debt anywhere
 * in here. Everything below reads the SAME loan a property links to, which is
 * why a projection shown on a property and a projection shown on the loan can
 * never disagree — they are the same numbers.
 *
 * Three balances get confused in mortgage software, so they are kept apart:
 *
 *   • current_balance   — what is OWED. The only figure net worth ever reads,
 *                         and the only one an extra repayment or a redraw moves.
 *   • offset_balance    — cash sitting in an offset account. It reduces the
 *                         INTEREST CHARGED and nothing else. It is never
 *                         subtracted from the debt: that money is already an
 *                         asset in the user's bank account, so netting it here
 *                         as well would count it twice — once as cash, once as
 *                         a smaller mortgage.
 *   • redraw_available  — extra repayments the user could pull back out. It is
 *                         not cash and not an asset until it is redrawn, so it
 *                         never touches net worth either.
 *
 * Interest is accrued per repayment period at annual ÷ periods-per-year, the
 * ordinary amortisation convention. That is why paying fortnightly clears a loan
 * sooner than paying monthly here, exactly as it does in real life: 26 half-
 * payments a year is thirteen months of repayments, not twelve.
 */

import type {
  Loan, LoanEvent, LoanType, Property, RepaymentFrequency,
} from '../types';

const r2 = (n: number): number => parseFloat((Number.isFinite(n) ? n : 0).toFixed(2));
const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** How many repayments a year each frequency makes. */
export const PERIODS_PER_YEAR: Record<RepaymentFrequency, number> = {
  weekly: 52,
  fortnightly: 26,
  monthly: 12,
};

export const FREQUENCY_LABELS: Record<RepaymentFrequency, string> = {
  weekly: 'Weekly',
  fortnightly: 'Fortnightly',
  monthly: 'Monthly',
};

/** Loans that are indexed rather than charged interest — HECS is the AU case. */
export function isIndexed(type: LoanType): boolean {
  return type === 'hecs';
}

// ═════════════════════════════════════════════════════════════════════════════
//  Dates
// ═════════════════════════════════════════════════════════════════════════════
//
// Everything here is a YYYY-MM-DD string handled in UTC. Parsing "2026-08-17"
// with the local Date constructor shifts it a day in half the world's
// timezones, which would move a payoff date across a month boundary.

const DAY = 86_400_000;

function parseISO(date: string): Date {
  const [y, m, d] = String(date).split('-').map(Number);
  return new Date(Date.UTC(y || 1970, (m || 1) - 1, d || 1));
}

function toISO(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Today as YYYY-MM-DD. Every engine entry point takes this as an argument so
 *  the maths stays testable; this is only the default. */
export function todayISO(): string {
  return toISO(new Date());
}

/**
 * Advance a date by `n` repayment periods.
 *
 * Monthly steps CLAMP to the end of the month — the 31st plus one month is the
 * 28th of February, not the 3rd of March. Left unclamped, a loan due on the 31st
 * would drift forward a few days every short month and its payoff date would be
 * wrong by weeks over thirty years.
 */
export function addPeriods(date: string, frequency: RepaymentFrequency, n: number): string {
  if (n === 0) return date;
  const d = parseISO(date);
  if (frequency === 'weekly') return toISO(new Date(d.getTime() + n * 7 * DAY));
  if (frequency === 'fortnightly') return toISO(new Date(d.getTime() + n * 14 * DAY));

  const day = d.getUTCDate();
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return toISO(target);
}

/** Whole months from one date to another, rounded down. Negative when `to` is
 *  in the past — a contracted term that has already expired reads as overdue,
 *  not as time remaining. */
export function monthsBetween(from: string, to: string): number {
  const a = parseISO(from);
  const b = parseISO(to);
  let months = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
  if (b.getUTCDate() < a.getUTCDate()) months -= 1;
  return months;
}

/** "23 yrs 4 mos" / "8 mos" / "—". What a remaining term reads as in a card. */
export function formatTerm(months: number | null | undefined): string {
  if (months == null || !Number.isFinite(months) || months < 0) return '—';
  const whole = Math.round(months);
  if (whole === 0) return 'Paid off';
  const y = Math.floor(whole / 12);
  const m = whole % 12;
  const parts: string[] = [];
  if (y > 0) parts.push(`${y} yr${y === 1 ? '' : 's'}`);
  if (m > 0) parts.push(`${m} mo${m === 1 ? '' : 's'}`);
  return parts.join(' ');
}

// ═════════════════════════════════════════════════════════════════════════════
//  Interest rates (including variable ones)
// ═════════════════════════════════════════════════════════════════════════════

/** A rate that applies from a date onwards. */
export interface RateStep {
  /** YYYY-MM-DD the rate starts applying. */
  from: string;
  /** Annual rate, as a percentage. */
  rate: number;
}

/**
 * The rate in force on a date: the latest step that has started, else the base
 * rate. A variable loan is just a base rate plus the steps the user knows about
 * — a scheduled fixed-rate expiry, or a rate change they have been told is
 * coming — so one function serves fixed, variable and "what if rates rise".
 */
export function rateAt(base: number, steps: RateStep[], date: string): number {
  let rate = num(base);
  for (const step of [...steps].sort((a, b) => a.from.localeCompare(b.from))) {
    if (step.from <= date) rate = num(step.rate);
  }
  return rate;
}

/**
 * The rate steps a loan carries: its fixed-rate expiry, plus any rate change the
 * user has recorded.
 *
 * A rate change dated in the PAST is history — the loan's own `interest_rate` is
 * expected to already reflect it — but it is included anyway and simply loses to
 * any later step, so a mis-ordered pair can't resurrect an old rate.
 */
export function loanRateSteps(
  loan: Pick<Loan, 'rate_type' | 'fixed_until' | 'revert_rate' | 'interest_rate'>,
  events: LoanEvent[] = [],
): RateStep[] {
  const steps: RateStep[] = [];
  if (loan.rate_type === 'fixed' && loan.fixed_until && loan.revert_rate != null) {
    steps.push({ from: loan.fixed_until, rate: num(loan.revert_rate) });
  }
  for (const e of events) {
    if (e.kind === 'rate_change' && e.rate != null && e.date) {
      steps.push({ from: e.date, rate: num(e.rate) });
    }
  }
  return steps.sort((a, b) => a.from.localeCompare(b.from));
}

// ═════════════════════════════════════════════════════════════════════════════
//  Projection
// ═════════════════════════════════════════════════════════════════════════════

export interface LoanProjectionInput {
  /** What is owed at the start of the projection. */
  balance: number;
  /** Annual rate (%) in force now. Rate changes arrive via `rateSteps`. */
  annualRate: number;
  frequency: RepaymentFrequency;
  /** The contractual repayment per period. */
  repayment: number;
  /** Voluntary amount paid on top of every repayment. */
  extraPerPeriod?: number;
  /** Cash offsetting the balance. Held CONSTANT across the projection — see the
   *  note on `LoanProjection.offsetBalance`. */
  offsetBalance?: number;
  /** Date of the first projected repayment (YYYY-MM-DD). */
  startDate: string;
  /** Interest-only until this date; principal is untouched before it. */
  interestOnlyUntil?: string | null;
  /** Repayment once interest-only ends. Defaults to `repayment`; the report
   *  recalculates it over the remaining contracted term, as a lender would. */
  repaymentAfterInterestOnly?: number | null;
  /** Scheduled rate changes — see loanRateSteps. */
  rateSteps?: RateStep[];
  /** Safety cap. Defaults to 60 years of periods. */
  maxPeriods?: number;
}

/** One repayment, fully worked out. */
export interface LoanPeriod {
  /** 1-based period number. */
  n: number;
  date: string;
  openingBalance: number;
  /** Annual rate (%) charged for this period. */
  rate: number;
  interest: number;
  principal: number;
  /** interest + principal — what actually leaves the user's pocket. */
  payment: number;
  closingBalance: number;
  interestOnly: boolean;
}

export interface LoanProjection {
  periods: LoanPeriod[];
  /** When the balance reaches zero, or null if it never does within the cap. */
  payoffDate: string | null;
  periodsToPayoff: number | null;
  /** Payoff expressed in months, so weekly/fortnightly/monthly loans compare. */
  monthsToPayoff: number | null;
  totalInterest: number;
  /** Every dollar paid — interest and principal, contractual and extra. */
  totalPaid: number;
  /** Balance left when the projection stopped. 0 for a loan that pays off. */
  finalBalance: number;
  /** True when the repayment doesn't cover the interest, so the debt only grows. */
  neverPaysOff: boolean;
  /** How far short each period falls when neverPaysOff. 0 otherwise. */
  shortfall: number;
  /** True when the cap was hit with a balance still owing. */
  truncated: boolean;
  /** The offset assumed throughout — see below. */
  offsetBalance: number;
}

/** The projection without its period-by-period rows, for comparing scenarios. */
export interface LoanProjectionSummary {
  payoffDate: string | null;
  periodsToPayoff: number | null;
  monthsToPayoff: number | null;
  totalInterest: number;
  totalPaid: number;
  neverPaysOff: boolean;
  shortfall: number;
  truncated: boolean;
}

export function summarise(p: LoanProjection): LoanProjectionSummary {
  return {
    payoffDate: p.payoffDate,
    periodsToPayoff: p.periodsToPayoff,
    monthsToPayoff: p.monthsToPayoff,
    totalInterest: p.totalInterest,
    totalPaid: p.totalPaid,
    neverPaysOff: p.neverPaysOff,
    shortfall: p.shortfall,
    truncated: p.truncated,
  };
}

/**
 * Amortise a loan to zero (or to the cap).
 *
 * Interest each period is charged on `balance − offset`, never below zero: an
 * offset larger than the debt makes the loan interest-free, it does not pay the
 * user. The offset is assumed CONSTANT — projecting a growing offset would mean
 * guessing at the user's future savings, and understating the interest they will
 * actually pay is the more dangerous error of the two.
 *
 * The last repayment is trimmed to whatever is left plus that period's interest,
 * so a loan never overshoots into a negative balance and `totalPaid` is the real
 * amount handed over.
 */
export function projectLoan(input: LoanProjectionInput): LoanProjection {
  const ppy = PERIODS_PER_YEAR[input.frequency] ?? 12;
  const offset = Math.max(0, num(input.offsetBalance));
  const extra = Math.max(0, num(input.extraPerPeriod));
  const steps = input.rateSteps ?? [];
  const maxPeriods = input.maxPeriods ?? ppy * 60;
  const repayment = Math.max(0, num(input.repayment));
  const afterIO = input.repaymentAfterInterestOnly != null
    ? Math.max(0, num(input.repaymentAfterInterestOnly))
    : repayment;

  let balance = r2(Math.max(0, num(input.balance)));
  const empty: LoanProjection = {
    periods: [], payoffDate: null, periodsToPayoff: null, monthsToPayoff: null,
    totalInterest: 0, totalPaid: 0, finalBalance: balance,
    neverPaysOff: false, shortfall: 0, truncated: false, offsetBalance: r2(offset),
  };

  // Nothing owed, or nothing being paid: there is no schedule to build. A zero
  // repayment on a live balance is "never pays off" rather than an empty answer,
  // because that is the fact the user needs to see.
  if (balance <= 0) return { ...empty, finalBalance: 0, payoffDate: null, periodsToPayoff: 0, monthsToPayoff: 0 };
  if (repayment <= 0 && extra <= 0) {
    const charged = Math.max(0, balance - offset);
    const interest = r2(charged * (rateAt(input.annualRate, steps, input.startDate) / 100 / ppy));
    return { ...empty, neverPaysOff: true, shortfall: interest };
  }

  const periods: LoanPeriod[] = [];
  let date = input.startDate;
  let totalInterest = 0;
  let totalPaid = 0;
  let neverPaysOff = false;
  let shortfall = 0;
  let n = 0;

  while (balance > 0 && n < maxPeriods) {
    n += 1;
    const rate = rateAt(input.annualRate, steps, date);
    const charged = Math.max(0, balance - offset);
    const interest = r2(charged * (rate / 100 / ppy));

    const io = !!input.interestOnlyUntil && date < input.interestOnlyUntil;
    // During interest-only the contractual payment IS the interest, so nothing
    // comes off the principal — anything extra still does, which is the whole
    // point of paying extra during an interest-only period.
    const contractual = io ? interest : (input.interestOnlyUntil ? afterIO : repayment);
    const wanted = contractual + extra;
    const payoffPayment = r2(balance + interest);
    const payment = Math.min(wanted, payoffPayment);
    const principal = r2(payment - interest);

    // The repayment doesn't even cover the interest: the balance grows every
    // period and no payoff date exists. Reported rather than looped over.
    if (principal <= 0 && !io) {
      neverPaysOff = true;
      shortfall = r2(interest - payment);
      break;
    }

    const closing = r2(Math.max(0, balance - principal));
    periods.push({
      n, date, openingBalance: balance, rate, interest,
      principal, payment: r2(payment), closingBalance: closing, interestOnly: io,
    });
    totalInterest = r2(totalInterest + interest);
    totalPaid = r2(totalPaid + payment);
    balance = closing;
    date = addPeriods(date, input.frequency, 1);
  }

  const paidOff = balance <= 0 && !neverPaysOff;
  const last = periods[periods.length - 1];
  return {
    periods,
    payoffDate: paidOff && last ? last.date : null,
    periodsToPayoff: paidOff ? periods.length : null,
    monthsToPayoff: paidOff ? r2((periods.length / ppy) * 12) : null,
    totalInterest,
    totalPaid,
    finalBalance: r2(balance),
    neverPaysOff,
    shortfall,
    truncated: !paidOff && !neverPaysOff,
    offsetBalance: r2(offset),
  };
}

/**
 * The repayment that clears `balance` over `termMonths` at a fixed rate — the
 * standard annuity formula. Used to recalculate a repayment when an
 * interest-only period ends, which is what a lender does at that point.
 */
export function requiredRepayment(
  balance: number,
  annualRate: number,
  frequency: RepaymentFrequency,
  termMonths: number,
): number {
  const ppy = PERIODS_PER_YEAR[frequency] ?? 12;
  const b = Math.max(0, num(balance));
  const months = Math.max(0, num(termMonths));
  const n = Math.round((months / 12) * ppy);
  if (b <= 0 || n <= 0) return 0;

  const i = num(annualRate) / 100 / ppy;
  const exact = i <= 0 ? b / n : (b * i) / (1 - Math.pow(1 + i, -n));
  // Rounded UP to the cent, as a lender does. Rounding down would leave a few
  // dollars outstanding after the final scheduled repayment, so a loan
  // calculated for a 20-year term would quietly need a 241st payment.
  return Math.ceil(exact * 100) / 100;
}

// ═════════════════════════════════════════════════════════════════════════════
//  Repayment impact ("what if I paid more?")
// ═════════════════════════════════════════════════════════════════════════════

/** A change to test against the current schedule. Anything omitted is unchanged. */
export interface RepaymentChange {
  /** Extra paid every period, on top of whatever is already being paid extra. */
  extraPerPeriod?: number;
  /** A one-off payment made today, before the first projected repayment. */
  lumpSum?: number;
  /** A different contractual repayment. */
  repayment?: number;
  /** A different offset balance. */
  offsetBalance?: number;
  /** A different rate — a rate-rise stress test. */
  annualRate?: number;
}

export interface RepaymentImpact {
  baseline: LoanProjectionSummary;
  scenario: LoanProjectionSummary;
  /**
   * True when BOTH sides actually pay off, which is the only case where the
   * totals below mean anything.
   *
   * A projection that stops early — because the repayment no longer covers the
   * interest, or because it ran past the cap — has only counted the interest up
   * to the point it gave up, so subtracting one total from the other would report
   * a rate rise as a saving. Callers must say "this no longer covers the
   * interest" rather than show a number when this is false.
   */
  comparable: boolean;
  /** Interest avoided. Negative when the change costs more (e.g. a rate rise). */
  interestSaved: number;
  /** Repayments removed from the schedule, null when either side never pays off. */
  periodsSaved: number | null;
  monthsSaved: number | null;
  /** What the per-period outlay becomes under the scenario. */
  periodPayment: number;
  /** Change in the per-period outlay: positive means paying more each period. */
  periodPaymentDelta: number;
}

/**
 * Compare a change against the loan as it stands.
 *
 * Both sides are projected with the same engine, so the difference is only ever
 * the change being tested — which is what makes "you'd save $X and Y years"
 * defensible rather than a rule of thumb.
 */
export function repaymentImpact(input: LoanProjectionInput, change: RepaymentChange): RepaymentImpact {
  const baseline = projectLoan(input);

  const lump = Math.max(0, num(change.lumpSum));
  const scenarioInput: LoanProjectionInput = {
    ...input,
    balance: Math.max(0, num(input.balance) - lump),
    repayment: change.repayment != null ? change.repayment : input.repayment,
    extraPerPeriod: num(input.extraPerPeriod) + Math.max(0, num(change.extraPerPeriod)),
    offsetBalance: change.offsetBalance != null ? change.offsetBalance : input.offsetBalance,
    annualRate: change.annualRate != null ? change.annualRate : input.annualRate,
    // A rate override replaces the whole rate story, otherwise a scheduled
    // fixed-rate expiry would silently undo the stress test two years in.
    rateSteps: change.annualRate != null ? [] : input.rateSteps,
  };
  const scenario = projectLoan(scenarioInput);

  const bothPayOff = baseline.periodsToPayoff != null && scenario.periodsToPayoff != null;
  const periodPayment = r2(
    (change.repayment != null ? num(change.repayment) : num(input.repayment))
    + num(input.extraPerPeriod) + Math.max(0, num(change.extraPerPeriod)),
  );

  return {
    baseline: summarise(baseline),
    scenario: summarise(scenario),
    comparable: bothPayOff,
    interestSaved: r2(baseline.totalInterest - scenario.totalInterest),
    periodsSaved: bothPayOff ? baseline.periodsToPayoff! - scenario.periodsToPayoff! : null,
    monthsSaved: bothPayOff ? r2(baseline.monthsToPayoff! - scenario.monthsToPayoff!) : null,
    periodPayment,
    periodPaymentDelta: r2(periodPayment - (num(input.repayment) + num(input.extraPerPeriod))),
  };
}

// ═════════════════════════════════════════════════════════════════════════════
//  Money moving on and off the loan
// ═════════════════════════════════════════════════════════════════════════════

/** The two figures every movement below rewrites, and nothing else. */
export interface LoanBalances {
  current_balance: number;
  redraw_available: number;
}

/** What is actually available to redraw — never more than was paid ahead. */
export function redrawLimit(loan: Pick<Loan, 'redraw_available'>): number {
  return r2(Math.max(0, num(loan.redraw_available)));
}

/**
 * Pay extra off the loan.
 *
 * The debt falls by the amount paid AND the same amount becomes redrawable,
 * because that is exactly what it is: money the user has handed over early and
 * may take back. It is not counted as an asset anywhere — only the reduced
 * balance reaches net worth — so recording it here can't inflate anything.
 */
export function applyExtraRepayment(
  loan: Pick<Loan, 'current_balance' | 'redraw_available'>,
  amount: number,
): LoanBalances {
  const paid = Math.max(0, num(amount));
  const balance = Math.max(0, num(loan.current_balance));
  // Never pay more than is owed: the surplus isn't redrawable, it was never
  // borrowed. Capping keeps the balance at zero instead of negative.
  const applied = Math.min(paid, balance);
  return {
    current_balance: r2(balance - applied),
    redraw_available: r2(redrawLimit(loan) + applied),
  };
}

/**
 * Take money back out of the loan.
 *
 * The debt rises by the amount redrawn and the available redraw falls by the
 * same amount — a redraw is re-borrowing, not income. Capped at what is
 * available so the loan can't be talked into lending more than was paid ahead.
 */
export function applyRedraw(
  loan: Pick<Loan, 'current_balance' | 'redraw_available'>,
  amount: number,
): LoanBalances {
  const wanted = Math.max(0, num(amount));
  const available = redrawLimit(loan);
  const taken = Math.min(wanted, available);
  return {
    current_balance: r2(Math.max(0, num(loan.current_balance)) + taken),
    redraw_available: r2(available - taken),
  };
}

/** What a scheduled repayment does, split into its two halves. */
export interface RepaymentSplit extends LoanBalances {
  interest: number;
  principal: number;
  /** The amount actually applied — capped at balance + interest. */
  applied: number;
  /** Anything paid above the contractual repayment, which becomes redrawable. */
  surplus: number;
  /** True when the payment met the contractual repayment in full. A PARTIAL
   *  payment leaves the schedule where it is: the period is still owed. */
  meetsSchedule: boolean;
}

/**
 * Apply a repayment of `amount` to the loan.
 *
 * Interest for the period is charged first (on the balance net of any offset),
 * and only what is left comes off the debt — the split a lender applies. A
 * PARTIAL repayment therefore reduces the balance by less, and doesn't advance
 * the schedule; an OVERPAYMENT clears the contractual amount and the rest
 * behaves exactly like an extra repayment, redraw included.
 *
 * An indexed debt (HECS) has no rate, so interest is zero and the whole payment
 * comes off the balance — which is also how a loan with no rate on file behaves,
 * matching what the app did before this engine existed.
 */
export function applyRepayment(
  loan: Pick<Loan,
    'current_balance' | 'redraw_available' | 'interest_rate' | 'repayment_frequency'
    | 'offset_balance' | 'minimum_repayment' | 'loan_type'>,
  amount: number,
): RepaymentSplit {
  const balance = Math.max(0, num(loan.current_balance));
  const ppy = PERIODS_PER_YEAR[loan.repayment_frequency] ?? 12;
  const rate = isIndexed(loan.loan_type) ? 0 : num(loan.interest_rate);
  const charged = Math.max(0, balance - Math.max(0, num(loan.offset_balance)));
  const interest = r2(charged * (rate / 100 / ppy));

  const paid = Math.max(0, num(amount));
  const applied = r2(Math.min(paid, balance + interest));
  const principal = r2(Math.max(0, applied - interest));
  const scheduled = Math.max(0, num(loan.minimum_repayment));
  const surplus = scheduled > 0 ? r2(Math.max(0, applied - scheduled)) : 0;

  return {
    interest,
    principal,
    applied,
    surplus,
    meetsSchedule: scheduled === 0 || applied + 0.005 >= scheduled,
    current_balance: r2(Math.max(0, balance - principal)),
    // Paying ahead builds redraw; paying the scheduled amount does not.
    redraw_available: r2(redrawLimit(loan) + surplus),
  };
}

// ═════════════════════════════════════════════════════════════════════════════
//  The report
// ═════════════════════════════════════════════════════════════════════════════

/** The projection inputs a loan implies, ready for projectLoan. */
export function projectionInputForLoan(
  loan: Loan,
  events: LoanEvent[] = [],
  today: string = todayISO(),
): LoanProjectionInput {
  const frequency = loan.repayment_frequency ?? 'monthly';
  const rate = isIndexed(loan.loan_type) ? 0 : num(loan.interest_rate);
  // The next repayment is the natural start. A loan with no due date on file (or
  // one that has drifted into the past) starts today rather than projecting a
  // schedule that already happened.
  const startDate = loan.next_due_date && loan.next_due_date > today ? loan.next_due_date : today;

  // When interest-only ends the lender recalculates the repayment over whatever
  // term is left, so the projection does the same. Without a term on file the
  // existing repayment carries on, which understates the future payment — the
  // report flags that by exposing repaymentAfterInterestOnly.
  const io = loan.interest_only_until && loan.interest_only_until > today ? loan.interest_only_until : null;
  const remainingMonths = contractedRemainingMonths(loan, today);
  const afterIO = io && remainingMonths != null
    ? requiredRepayment(
      num(loan.current_balance),
      rateAt(rate, loanRateSteps(loan, events), io),
      frequency,
      Math.max(1, remainingMonths - Math.max(0, monthsBetween(today, io))),
    )
    : null;

  return {
    balance: num(loan.current_balance),
    annualRate: rate,
    frequency,
    repayment: num(loan.minimum_repayment),
    extraPerPeriod: num(loan.extra_repayment),
    offsetBalance: num(loan.offset_balance),
    startDate,
    interestOnlyUntil: io,
    repaymentAfterInterestOnly: afterIO,
    rateSteps: loanRateSteps(loan, events),
  };
}

/**
 * Months left on the CONTRACT, as opposed to the projection.
 *
 * `end_date` is what the user agreed to; `term_months` from `start_date` is the
 * fallback when only the term was entered. Null when neither is known — a loan
 * with no term is projected from its repayments alone.
 */
export function contractedRemainingMonths(
  loan: Pick<Loan, 'end_date' | 'term_months' | 'start_date'>,
  today: string = todayISO(),
): number | null {
  if (loan.end_date) return monthsBetween(today, loan.end_date);
  if (loan.term_months && loan.start_date) {
    return monthsBetween(today, addPeriods(loan.start_date, 'monthly', Math.round(num(loan.term_months))));
  }
  return null;
}

/** A cash account that can sit against a loan as an offset. */
export interface OffsetAccount {
  id: string;
  balance: number;
}

/**
 * The offset actually in force: the linked account's balance when the loan
 * points at one, else the figure the user typed.
 *
 * Linking is the honest option — an offset only works while the money is really
 * there, so reading the live balance means the interest figure moves when the
 * account does. A link that can't be resolved (account deleted, or the list
 * wasn't supplied) falls back to the typed amount rather than silently
 * pretending the offset is zero and overstating the interest.
 */
export function offsetBalanceFor(
  loan: Pick<Loan, 'offset_balance' | 'offset_account_id'>,
  accounts: OffsetAccount[] = [],
): number {
  if (loan.offset_account_id) {
    const acct = accounts.find(a => a.id === loan.offset_account_id);
    if (acct) return r2(Math.max(0, num(acct.balance)));
  }
  return r2(Math.max(0, num(loan.offset_balance)));
}

/** One loan, fully worked out. */
export interface LoanRow {
  id: string;
  name: string;
  type: LoanType;
  lender: string | null;
  /** What is owed — the only figure net worth reads. */
  balance: number;
  originalAmount: number;
  /** % of the original amount repaid. 0 when nothing was borrowed. */
  repaidPercent: number;
  /** Cash offsetting the balance. Never subtracted from the debt. */
  offsetBalance: number;
  /** balance − offset: what interest is actually charged on. */
  effectiveBalance: number;
  /** Extra repayments the user could take back. Not an asset. */
  redrawAvailable: number;
  /** Annual rate in force now (0 for an indexed debt). */
  rate: number;
  rateType: 'variable' | 'fixed';
  /** When a fixed rate expires and what it reverts to, if known. */
  fixedUntil: string | null;
  revertRate: number | null;
  /** Rate changes still in the future, soonest first. */
  upcomingRateChanges: RateStep[];
  frequency: RepaymentFrequency;
  repayment: number;
  extraRepayment: number;
  /** repayment + extra — what actually leaves the account each period. */
  periodOutlay: number;
  nextDueDate: string | null;
  interestOnly: boolean;
  interestOnlyUntil: string | null;
  /** The recalculated repayment once interest-only ends, when it can be worked
   *  out. Null when the loan is P&I or has no term on file. */
  repaymentAfterInterestOnly: number | null;
  /** Interest charged in the coming period at today's rate and balance. */
  interestThisPeriod: number;
  /** The same, annualised — the headline "this loan costs $X a year". */
  interestPerYear: number;
  /** Interest avoided each year by the offset, at today's balance. */
  offsetSavingPerYear: number;
  projection: LoanProjectionSummary;
  /** Months to payoff from the projection, rounded. */
  monthsToPayoff: number | null;
  payoffDate: string | null;
  /** Months left on the contract (end date / term), which may differ from the
   *  projection when the user pays more or less than the schedule. */
  contractedRemainingMonths: number | null;
  /** Months the projection beats the contract by. Positive = ahead of schedule. */
  monthsAheadOfContract: number | null;
  countsTowardNetWorth: boolean;
  /** The property this mortgage backs — the SAME loan, never a second debt. */
  property: { id: string; name: string } | null;
  /** Every recorded movement, newest first. */
  events: LoanEvent[];
}

export interface LoanReport {
  rows: LoanRow[];
  totals: {
    /** Every balance, whether or not it counts toward net worth. */
    balance: number;
    /** The part of `balance` net worth actually subtracts. */
    netWorthDebt: number;
    offsetBalance: number;
    effectiveBalance: number;
    redrawAvailable: number;
    /** Interest across every loan for the coming year, at today's balances. */
    interestPerYear: number;
    /** Every period outlay normalised to a month, so one figure compares. */
    monthlyOutlay: number;
    /** The latest payoff date across all loans — when the user is debt-free. */
    debtFreeDate: string | null;
    count: number;
  };
}

/** Convert a per-period amount to a monthly one. */
export function perMonth(amount: number, frequency: RepaymentFrequency): number {
  return r2((num(amount) * (PERIODS_PER_YEAR[frequency] ?? 12)) / 12);
}

/**
 * Work out every loan, the properties they back and the movements recorded
 * against them.
 *
 * `properties` is read ONLY to name the property a mortgage belongs to. Nothing
 * about the property changes a single figure here — the loan owns the debt, the
 * property owns the asset, and that separation is what stops a mortgage being
 * counted twice.
 */
export function buildLoanReport(
  loans: Loan[],
  events: LoanEvent[] = [],
  properties: Property[] = [],
  opts: { today?: string; offsetAccounts?: OffsetAccount[] } = {},
): LoanReport {
  const today = opts.today ?? todayISO();

  const rows: LoanRow[] = loans.map(loan => {
    const mine = events
      .filter(e => e.loan_id === loan.id)
      .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
    const frequency = loan.repayment_frequency ?? 'monthly';
    const ppy = PERIODS_PER_YEAR[frequency] ?? 12;
    const balance = r2(Math.max(0, num(loan.current_balance)));
    const offset = offsetBalanceFor(loan, opts.offsetAccounts);
    const effective = r2(Math.max(0, balance - offset));
    const steps = loanRateSteps(loan, mine);
    const rate = isIndexed(loan.loan_type) ? 0 : rateAt(num(loan.interest_rate), steps, today);

    // Projected against the offset actually in force, which may be a linked
    // account's live balance rather than the number stored on the loan.
    const input = projectionInputForLoan({ ...loan, offset_balance: offset }, mine, today);
    const projection = projectLoan(input);
    const original = r2(Math.max(0, num(loan.original_amount)));
    const contracted = contractedRemainingMonths(loan, today);

    const interestThisPeriod = r2(effective * (rate / 100 / ppy));
    // What the offset is worth: the interest on the same balance without it,
    // minus the interest with it. Zero when there is no offset or no rate.
    const offsetSaving = r2((balance * (rate / 100)) - (effective * (rate / 100)));

    const property = properties.find(p => p.loan_id === loan.id) ?? null;

    return {
      id: loan.id,
      name: loan.name,
      type: loan.loan_type,
      lender: loan.lender ?? null,
      balance,
      originalAmount: original,
      repaidPercent: original > 0 ? r2(Math.min(100, Math.max(0, ((original - balance) / original) * 100))) : 0,
      offsetBalance: offset,
      effectiveBalance: effective,
      redrawAvailable: redrawLimit(loan),
      rate,
      rateType: loan.rate_type === 'fixed' ? 'fixed' : 'variable',
      fixedUntil: loan.fixed_until ?? null,
      revertRate: loan.revert_rate != null ? num(loan.revert_rate) : null,
      upcomingRateChanges: steps.filter(s => s.from > today),
      frequency,
      repayment: r2(num(loan.minimum_repayment)),
      extraRepayment: r2(num(loan.extra_repayment)),
      periodOutlay: r2(num(loan.minimum_repayment) + num(loan.extra_repayment)),
      nextDueDate: loan.next_due_date ?? null,
      interestOnly: !!input.interestOnlyUntil,
      interestOnlyUntil: input.interestOnlyUntil ?? null,
      repaymentAfterInterestOnly: input.repaymentAfterInterestOnly ?? null,
      interestThisPeriod,
      interestPerYear: r2(interestThisPeriod * ppy),
      offsetSavingPerYear: offsetSaving,
      projection: summarise(projection),
      monthsToPayoff: projection.monthsToPayoff != null ? Math.round(projection.monthsToPayoff) : null,
      payoffDate: projection.payoffDate,
      contractedRemainingMonths: contracted,
      monthsAheadOfContract:
        contracted != null && projection.monthsToPayoff != null
          ? r2(contracted - projection.monthsToPayoff)
          : null,
      countsTowardNetWorth: loan.include_in_net_worth !== false,
      property: property ? { id: property.id, name: propertyName(property) } : null,
      events: mine,
    };
  });

  const payoffDates = rows.map(r => r.payoffDate).filter((d): d is string => !!d);
  const anyOpenEnded = rows.some(r => r.balance > 0 && !r.payoffDate);

  return {
    rows,
    totals: {
      balance: r2(rows.reduce((s, r) => s + r.balance, 0)),
      netWorthDebt: r2(rows.reduce((s, r) => s + (r.countsTowardNetWorth ? r.balance : 0), 0)),
      offsetBalance: r2(rows.reduce((s, r) => s + r.offsetBalance, 0)),
      effectiveBalance: r2(rows.reduce((s, r) => s + r.effectiveBalance, 0)),
      redrawAvailable: r2(rows.reduce((s, r) => s + r.redrawAvailable, 0)),
      interestPerYear: r2(rows.reduce((s, r) => s + r.interestPerYear, 0)),
      monthlyOutlay: r2(rows.reduce((s, r) => s + perMonth(r.periodOutlay, r.frequency), 0)),
      // Debt-free means EVERY loan is cleared, so one loan that never pays off
      // (or has no schedule) leaves the whole answer unknown rather than
      // reporting the date the others happen to finish.
      debtFreeDate: anyOpenEnded || payoffDates.length === 0
        ? null
        : payoffDates.sort((a, b) => a.localeCompare(b))[payoffDates.length - 1],
      count: rows.length,
    },
  };
}

/** A property's display name without importing the property engine's whole
 *  surface — nickname first, then the short address. */
function propertyName(p: Property): string {
  const nickname = (p.name ?? '').trim();
  if (nickname) return nickname;
  const street = [(p.address_unit ?? '').trim(), (p.address_street ?? '').trim()].filter(Boolean).join('/');
  const short = [street, (p.address_suburb ?? '').trim()].filter(Boolean).join(', ');
  return short || (p.address ?? '').trim() || 'Property';
}

// ═════════════════════════════════════════════════════════════════════════════
//  Validation
// ═════════════════════════════════════════════════════════════════════════════

/** What the user typed into a movement, before it becomes a LoanEvent. */
export interface LoanMovementDraft {
  kind: LoanEvent['kind'];
  amount?: number;
  rate?: number | null;
  date?: string | null;
}

/**
 * Reasons a movement can't be recorded, in the order they should be shown.
 * Empty means it's good.
 *
 * The redraw cap is the important one: redrawing more than was paid ahead would
 * invent borrowing capacity the lender never granted, and the balance would then
 * carry debt that doesn't exist.
 */
export function validateMovement(
  draft: LoanMovementDraft,
  loan: Pick<Loan, 'current_balance' | 'redraw_available'>,
): string[] {
  const errors: string[] = [];
  if (!draft.date) errors.push('A date is required.');

  if (draft.kind === 'rate_change') {
    const rate = draft.rate;
    if (rate == null || !Number.isFinite(Number(rate)) || Number(rate) < 0) {
      errors.push('Enter the new interest rate.');
    }
    return errors;
  }

  const amount = num(draft.amount);
  if (!Number.isFinite(amount) || amount <= 0) errors.push('Amount must be more than zero.');

  if (draft.kind === 'redraw' && amount > redrawLimit(loan) + 0.005) {
    errors.push(`Only ${redrawLimit(loan).toFixed(2)} is available to redraw.`);
  }
  if ((draft.kind === 'extra_repayment' || draft.kind === 'repayment')
    && amount > Math.max(0, num(loan.current_balance)) + 0.005
    && draft.kind === 'extra_repayment') {
    errors.push("That's more than the balance owing.");
  }

  return errors;
}
