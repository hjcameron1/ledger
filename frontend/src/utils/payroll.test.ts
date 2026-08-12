import { describe, it, expect } from 'vitest';
import {
  onTrackAnnualFromPayslips,
  onTrackAnnualFromStats,
  type PayslipCore,
  type EmployerStats,
} from './payroll';

// Build pay dates inside the REAL current Australian FY so inCurrentFinancialYear
// (which uses the wall clock) keeps the fixtures, whenever the suite runs.
const now = new Date();
const fyStartYear = now.getMonth() + 1 >= 7 ? now.getFullYear() : now.getFullYear() - 1;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const dayAfterFYStart = (n: number) => iso(new Date(fyStartYear, 6, 1 + n));

/** A fortnightly payslip with an explicit 14-day period (→ exactly 2 weeks). */
function fortnight(
  employer: string,
  opts: { gross: number; tax?: number; startOffset: number; ytd_gross?: number | null },
): PayslipCore {
  return {
    employer,
    employment_type: 'full_time',
    pay_frequency: 'fortnightly',
    pay_period_start: dayAfterFYStart(opts.startOffset),
    pay_period_end: dayAfterFYStart(opts.startOffset + 13),
    payment_date: dayAfterFYStart(opts.startOffset + 13),
    gross_pay: opts.gross,
    net_pay: opts.gross - (opts.tax ?? 0),
    tax_withheld: opts.tax ?? 0,
    super_amount: 0,
    ytd_gross: opts.ytd_gross ?? null,
  };
}

describe('onTrackAnnualFromPayslips — total pay / weeks covered × 52', () => {
  it('two fortnightly payslips (4 weeks) annualise to gross×13', () => {
    const slips = [
      fortnight('ACME', { gross: 2000, tax: 400, startOffset: 0 }),
      fortnight('ACME', { gross: 2000, tax: 400, startOffset: 14 }),
    ];
    // 4000 over 4 weeks → 1000/wk → 52,000/yr.
    expect(onTrackAnnualFromPayslips(slips)).toBe(52000);
    // Net: (4000-800)/4 × 52 = 41,600.
    expect(onTrackAnnualFromPayslips(slips, true)).toBe(41600);
  });

  it('a large YTD figure never inflates the rate (the 1-July-straddle bug)', () => {
    // One fortnight of $2000, but its YTD column reads $20k. The old code divided
    // YTD by the few calendar weeks since 1 July and blew the estimate up; the
    // rate must come from the payslip itself: 2000/2 × 52 = 52,000.
    const slips = [fortnight('ACME', { gross: 2000, startOffset: 0, ytd_gross: 20000 })];
    expect(onTrackAnnualFromPayslips(slips)).toBe(52000);
  });

  it('is immune to the same payslip being uploaded twice', () => {
    const one = fortnight('ACME', { gross: 2000, startOffset: 0 });
    // Numerator and denominator both double → same rate, not double.
    expect(onTrackAnnualFromPayslips([one, { ...one }])).toBe(52000);
  });

  it('two concurrent employers are additive, not averaged', () => {
    const slips = [
      fortnight('JobA', { gross: 1000, startOffset: 0 }),
      fortnight('JobB', { gross: 1000, startOffset: 0 }),
    ];
    // Each job 26,000 → combined 52,000.
    expect(onTrackAnnualFromPayslips(slips)).toBe(52000);
  });

  it('returns 0 when there are no current-FY payslips', () => {
    expect(onTrackAnnualFromPayslips([])).toBe(0);
  });
});

describe('onTrackAnnualFromStats — annualises real pay only, ignoring projections', () => {
  const base: EmployerStats = {
    employer: 'ACME',
    latest: undefined,
    real: [],
    synthetic: [],
    gross: 999_999,   // pretend a synthetic "repeat" projection has inflated this
    tax: 123_456,
    superAmt: 0,
    realGrossSum: 2000,
    realTaxSum: 400,
    realWeeks: 2,
    usedYtd: false,
    repeat: true,
  };

  it('uses realGrossSum/realWeeks, never the projection-inflated gross', () => {
    expect(onTrackAnnualFromStats([base])).toBe(52000);
    expect(onTrackAnnualFromStats([base], true)).toBe(41600); // (2000-400)/2 × 52
  });

  it('skips an employer with no measurable weeks (avoids divide-by-zero)', () => {
    expect(onTrackAnnualFromStats([{ ...base, realWeeks: 0 }])).toBe(0);
  });
});
