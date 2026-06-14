// Shared payroll helpers used by both the Income tab (totals / tax) and the
// Payslips tab (PayrollSection). Keeping the maths in one place means "Earned
// this year", the Tax estimate and the Payslips recap always agree.

export interface PayslipCore {
  id?: string;
  employer: string;
  employment_type: string;
  pay_frequency: 'weekly' | 'fortnightly' | 'monthly';
  payment_date: string | null;
  pay_period_start?: string | null;
  pay_period_end?: string | null;
  gross_pay: number;
  net_pay: number;
  tax_withheld: number;
  super_amount: number;
  super_rate?: number | null;
  ytd_gross?: number | null;
  ytd_tax?: number | null;
  ytd_super?: number | null;
  hourly_rate?: number | null;
}

export const PERIODS: Record<string, number> = { weekly: 52, fortnightly: 26, monthly: 12 };
export const TYPE_LABELS: Record<string, string> = {
  full_time: 'Full-time', part_time: 'Part-time', casual: 'Casual', contractor: 'Contractor',
};
// Employment types we auto-predict a recurring pay for without asking.
export const PREDICTABLE = new Set(['full_time', 'part_time']);

// ── Per-employer client-side preferences (localStorage) ──────────────────────
// These are personal confirmations / settings, not payslip data, so they live
// client-side rather than in the backend schema.
const REPEAT_KEY = 'payroll_repeat';                 // "pay is the same each period"
const CONFIRMED_KEY = 'payroll_confirmed_recurring'; // confirmed an auto-detected cycle
const RATES_KEY = 'payroll_rates';                   // weekend/penalty rate settings
const POSITION_KEY = 'payroll_position';             // job title per employer

function readMap<T>(key: string): Record<string, T> {
  try { return JSON.parse(localStorage.getItem(key) || '{}'); }
  catch { return {}; }
}
function writeMap<T>(key: string, employer: string, value: T): void {
  const all = readMap<T>(key);
  all[employer] = value;
  localStorage.setItem(key, JSON.stringify(all));
}

export const getRepeat = (employer: string): boolean => readMap<boolean>(REPEAT_KEY)[employer] ?? false;
export const setRepeat = (employer: string, v: boolean) => writeMap(REPEAT_KEY, employer, v);

export const getConfirmedRecurring = (employer: string): boolean => readMap<boolean>(CONFIRMED_KEY)[employer] ?? false;
export const setConfirmedRecurring = (employer: string, v: boolean) => writeMap(CONFIRMED_KEY, employer, v);

export interface RateSettings { weekendEnabled: boolean; weekdayRate?: number; weekendRate?: number; weekendHours?: number }
export const getRates = (employer: string): RateSettings => readMap<RateSettings>(RATES_KEY)[employer] ?? { weekendEnabled: false };
export const setRates = (employer: string, v: RateSettings) => writeMap(RATES_KEY, employer, v);

export const getPosition = (employer: string): string => readMap<string>(POSITION_KEY)[employer] ?? '';
export const setPosition = (employer: string, v: string) => writeMap(POSITION_KEY, employer, v);

// Whether the user claims the tax-free threshold from this employer. On a TFN
// declaration only ONE payer should be claimed. Defaults to true (most people
// claim it from their main job). Affects withholding, not final tax liability.
const TFT_KEY = 'payroll_tax_free_threshold';
export const getTaxFreeThreshold = (employer: string): boolean => readMap<boolean>(TFT_KEY)[employer] ?? true;
export const setTaxFreeThreshold = (employer: string, v: boolean) => writeMap(TFT_KEY, employer, v);
// How many of the given employers currently claim the tax-free threshold.
export function taxFreeThresholdClaims(employers: string[]): number {
  const map = readMap<boolean>(TFT_KEY);
  return employers.filter(e => map[e] ?? true).length;
}

// ── Dates ────────────────────────────────────────────────────────────────────
export function addFreq(dateStr: string, freq: string): string {
  const d = new Date(dateStr);
  if (freq === 'weekly') d.setDate(d.getDate() + 7);
  else if (freq === 'monthly') d.setMonth(d.getMonth() + 1);
  else d.setDate(d.getDate() + 14);
  return d.toISOString().slice(0, 10);
}

// Start of the current Australian financial year (1 July).
export function financialYearStart(ref = new Date()): Date {
  const startYear = ref.getMonth() + 1 >= 7 ? ref.getFullYear() : ref.getFullYear() - 1;
  return new Date(startYear, 6, 1);
}

// Weeks covered by a single payslip's pay period (falls back to its frequency).
const _FREQ_WEEKS: Record<string, number> = { weekly: 1, fortnightly: 2, monthly: 52 / 12 };
function _payslipWeeks(p: PayslipCore): number {
  if (p.pay_period_start && p.pay_period_end) {
    const days = (new Date(p.pay_period_end).getTime() - new Date(p.pay_period_start).getTime()) / 86_400_000;
    if (days > 0) return (days + 1) / 7;
  }
  return _FREQ_WEEKS[p.pay_frequency] ?? 2;
}

/**
 * Annualised income from payslips, mirroring the Income page's "On track to earn
 * this year" headline. `net` subtracts withheld tax so the figure is take-home
 * (what you actually budget with). Returns 0 when there are no payslips.
 */
export function onTrackAnnualFromPayslips(payslips: PayslipCore[], net = false): number {
  if (payslips.length === 0) return 0;
  const { earnedThisYear, taxWithheld, usedYtd } = payrollTotals(payslips);
  const base = net ? Math.max(0, earnedThisYear - taxWithheld) : earnedThisYear;
  const weeksCovered = payslips.reduce((s, p) => s + _payslipWeeks(p), 0);
  const latestPayDate = payslips.map(p => p.payment_date).filter(Boolean).sort().pop();
  const asOf = latestPayDate ? new Date(latestPayDate) : new Date();
  const weeksElapsed = Math.max(1, (asOf.getTime() - financialYearStart().getTime()) / (7 * 86_400_000));
  if (usedYtd) return (base / weeksElapsed) * 52;
  return weeksCovered > 0 ? (base / weeksCovered) * 52 : 0;
}

// ── Synthetic "repeat" pays ──────────────────────────────────────────────────
// When the user says "my pay is the same each period" (repeat on) and hasn't
// uploaded the latest payslips, project the latest real payslip forward from its
// payment date up to today (within this FY). Each projected period is a synthetic
// "no payslip provided" entry that still counts toward totals.
export interface SyntheticPay { payment_date: string; synthetic: true }

export function syntheticPaysFor(latest: PayslipCore | undefined): SyntheticPay[] {
  if (!latest?.payment_date) return [];
  const out: SyntheticPay[] = [];
  const fyEnd = new Date(financialYearStart().getFullYear() + 1, 5, 30); // 30 June next year
  const todayStr = new Date().toISOString().slice(0, 10);
  let cursor = addFreq(latest.payment_date, latest.pay_frequency);
  let guard = 0;
  while (cursor <= todayStr && new Date(cursor) <= fyEnd && guard < 60) {
    out.push({ payment_date: cursor, synthetic: true });
    cursor = addFreq(cursor, latest.pay_frequency);
    guard++;
  }
  return out;
}

// ── Per-employer aggregate ───────────────────────────────────────────────────
export interface EmployerStats {
  employer: string;
  latest: PayslipCore | undefined;
  real: PayslipCore[];            // real payslips, newest first
  synthetic: SyntheticPay[];      // projected "repeat" periods (newest first)
  gross: number;                  // earned this FY
  tax: number;                    // tax withheld this FY
  superAmt: number;               // super this FY
  usedYtd: boolean;
  repeat: boolean;
}

export function employerStats(employer: string, slips: PayslipCore[]): EmployerStats {
  const real = [...slips].sort((a, b) => ((b.payment_date ?? '') < (a.payment_date ?? '') ? -1 : 1));
  const latest = real[0];
  const repeat = getRepeat(employer);

  let gross = 0, tax = 0, superAmt = 0, usedYtd = false;
  if (latest?.ytd_gross != null && Number(latest.ytd_gross) > 0) {
    gross = Number(latest.ytd_gross);
    tax = Number(latest.ytd_tax ?? 0);
    superAmt = Number(latest.ytd_super ?? 0);
    usedYtd = true;
  } else {
    gross = real.reduce((s, p) => s + Number(p.gross_pay || 0), 0);
    tax = real.reduce((s, p) => s + Number(p.tax_withheld || 0), 0);
    superAmt = real.reduce((s, p) => s + Number(p.super_amount || 0), 0);
  }

  const synthetic = repeat ? syntheticPaysFor(latest) : [];
  if (latest && synthetic.length) {
    gross += synthetic.length * Number(latest.gross_pay || 0);
    tax += synthetic.length * Number(latest.tax_withheld || 0);
    superAmt += synthetic.length * Number(latest.super_amount || 0);
  }

  return { employer, latest, real, synthetic: synthetic.reverse(), gross, tax, superAmt, usedYtd, repeat };
}

export interface PayrollTotals {
  earnedThisYear: number;
  taxWithheld: number;
  superTotal: number;
  usedYtd: boolean;
  byEmployer: EmployerStats[];
}

export function payrollTotals(payslips: PayslipCore[]): PayrollTotals {
  const groups = new Map<string, PayslipCore[]>();
  for (const p of payslips) {
    const arr = groups.get(p.employer) ?? [];
    arr.push(p);
    groups.set(p.employer, arr);
  }
  const byEmployer = Array.from(groups.entries()).map(([emp, arr]) => employerStats(emp, arr));
  return {
    earnedThisYear: byEmployer.reduce((s, e) => s + e.gross, 0),
    taxWithheld: byEmployer.reduce((s, e) => s + e.tax, 0),
    superTotal: byEmployer.reduce((s, e) => s + e.superAmt, 0),
    usedYtd: byEmployer.some(e => e.usedYtd),
    byEmployer,
  };
}

// Next predicted pay date for an employer, accounting for any synthetic periods
// already projected (predict after the last known/projected pay).
export function nextPredictedPay(stats: EmployerStats): { date: string; amount: number } | null {
  const { latest, real, synthetic } = stats;
  if (!latest?.payment_date) return null;
  const lastDate = synthetic.length ? synthetic[synthetic.length - 1].payment_date : latest.payment_date;
  // Alternating cycle: two most recent real nets differ by > $1 → alternate.
  const alternating = real.length >= 2 && Math.abs(real[0].net_pay - real[1].net_pay) > 1;
  const amount = alternating ? real[1].net_pay : latest.net_pay;
  return { date: addFreq(lastDate, latest.pay_frequency), amount };
}
