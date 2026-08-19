/**
 * Phase 5.6 — the tax return / accountant pack (pure engine).
 *
 * ONE document for a financial year, in the order an Australian individual
 * return runs: income, PAYG withholding, deductions, the CGT / dividend /
 * rental schedules behind them, taxable income, tax, offsets, the study loan,
 * and the refund or amount owing. It is what a user hands their accountant, or
 * reads themselves before lodging.
 *
 * IT COMPUTES NO TAX. Not a bracket, not a levy, not a threshold. Every figure
 * here was already worked out by Phases 5.1–5.5 and is passed IN:
 *   • the FY position          → taxYear.buildTaxYearPosition   (5.1)
 *   • the settlement           → taxSettlement.buildTaxSettlement (5.2)
 *   • offsets, MLS, the rebate → taxOffsets.buildOffsetPosition (5.3)
 *   • capital gains, dividends → capitalGains / dividendIncome  (5.4)
 *   • the rental schedule      → rentalProperty                 (5.5)
 *   • the tax itself           → dataService.calculateTax → taxRates
 *
 * The pack takes THE VERY OBJECTS THE TAX PAGE RENDERS, not the stores they
 * came from. That is the whole reconciliation strategy: a second path to the
 * same numbers is a second path that can drift, so there isn't one. What the
 * pack does is re-present — group, order, label, and sum what it was handed.
 *
 * SUMMATION IS THE ONE THING THAT CAN GO WRONG, so it is checked rather than
 * trusted. Every section carries the engine's own total, and `checks` compares
 * that against the sum of the lines the pack is showing under it. If any check
 * fails the pack says so — `reconciles` goes false and the document leads with
 * it — because an accountant pack that quietly doesn't add up is worse than no
 * pack at all.
 *
 * PROVENANCE is first class. An accountant's first question about any figure is
 * "where did this come from", and there are exactly three honest answers:
 *   • 'derived'  — Ledger worked it out from your records (drill to them)
 *   • 'entered'  — you typed it, and Ledger took your word for it
 *   • 'rates'    — the ATO's published rates and thresholds for the year
 * Every line says which, and the CSV carries it as a column, so an asserted
 * figure can never be mistaken for an evidenced one.
 *
 * UNSUPPORTED YEARS still produce a pack. Income, withholding, deductions and
 * every schedule are the user's own records and are real whether or not Ledger
 * holds rates; only the tax sections go empty, with the reason on them, and the
 * checks that depend on rates are SKIPPED rather than failed.
 *
 * PURE — no store, no network, no localStorage, no Date.now(). `preparedOn` is
 * passed in so the same inputs always produce the same document.
 */

import { formatCurrency } from './format';
import type { TaxYearPosition } from './taxYear';
import { CAPITAL_GAIN_CATEGORY, RENT_CATEGORY, formatFY } from './taxYear';
import type { TaxSettlement, SettlementOutcome } from './taxSettlement';
import type { OffsetPosition } from './taxOffsets';
import type { RepaymentIncomeBreakdown } from './repaymentIncome';
import type { RateConfidence } from './taxRates';
import type { DeductionSource } from './taxDeductions';

// ─── Shape ───────────────────────────────────────────────────────────────────

/** Where a figure came from. The accountant's first question, answered. */
export type TaxPackProvenance =
  /** Ledger worked it out from the user's own records. Drills to them. */
  | 'derived'
  /** The user typed it. Ledger took their word for it. */
  | 'entered'
  /** The ATO's published rates and thresholds for the year. */
  | 'rates';

export type TaxPackSectionId =
  | 'income'
  | 'withholding'
  | 'deductions'
  | 'capital-gains'
  | 'dividends'
  | 'rental'
  | 'taxable-income'
  | 'tax'
  | 'offsets'
  | 'student-loan'
  | 'settlement';

/**
 * What a figure opens onto. Every line that has a source names it, so "drill
 * down" is data the exporters carry too, not a click the UI happens to wire up.
 */
export type TaxPackDrill =
  /** An income line in the FY position, by its key. */
  | { kind: 'income'; id: string }
  /** A deduction line in the merged deduction view, by its key. */
  | { kind: 'deduction'; id: string }
  /** A transaction, by id — the bottom of every drill-down. */
  | { kind: 'transaction'; id: string }
  /** A rental property, by id. */
  | { kind: 'property'; id: string }
  /** A CGT disposal, by id. */
  | { kind: 'cgt-event'; id: string }
  /** A dividend statement, by id. */
  | { kind: 'dividend'; id: string }
  /** Worked out in another section of this pack. */
  | { kind: 'section'; id: TaxPackSectionId }
  /** A figure the user typed, and the card they typed it on. */
  | { kind: 'entry'; id: string };

/**
 * How a line relates to its section's total. ONLY 'add' and 'subtract' lines
 * are summed — 'info' is context, and 'total'/'subtotal' are the answer itself,
 * so counting them would double the section.
 */
export type TaxPackLineRole = 'add' | 'subtract' | 'subtotal' | 'total' | 'info';

export interface TaxPackLine {
  key: string;
  label: string;
  /** Null on a line that is words rather than money. */
  amount: number | null;
  role: TaxPackLineRole;
  provenance: TaxPackProvenance;
  detail: string | null;
  /** When the money moved, on a line that is one event. Null on an aggregate. */
  date: string | null;
  drill: TaxPackDrill | null;
  /** The lines this one is made of. Never summed — the parent already is. */
  children: TaxPackLine[];
}

export interface TaxPackSection {
  id: TaxPackSectionId;
  title: string;
  /**
   * 'return'   — its total is part of the return's own arithmetic.
   * 'schedule' — the working behind a figure counted in a 'return' section.
   * The distinction stops a reader adding a schedule in twice.
   */
  role: 'return' | 'schedule';
  /** For a schedule: the figure it supports, in words. */
  supports: string | null;
  subtitle: string | null;
  lines: TaxPackLine[];
  /** The ENGINE's total for this section. Null when the year has no rates. */
  total: number | null;
  totalLabel: string;
  /** True when there is nothing in the year under this heading. */
  empty: boolean;
  /** Why the section is empty or unavailable, when it is. */
  note: string | null;
}

/**
 * One reconciliation: what the pack shows against what the Tax page holds.
 * `pack` is the sum of the lines the document displays; `page` is the engine's
 * own figure for the same thing. They must agree to the cent.
 */
export interface TaxPackCheck {
  key: string;
  label: string;
  pack: number | null;
  page: number | null;
  agrees: boolean;
  /** Set when the check could not run — no rates, nothing to check. */
  skipped: string | null;
}

/** Something an accountant would ask about before lodging. */
export interface TaxPackGap {
  key: string;
  /** 'warn' — the pack could be materially wrong until this is dealt with. */
  severity: 'warn' | 'info';
  message: string;
  section: TaxPackSectionId | null;
  amount?: number;
  count?: number;
}

export interface TaxPack {
  fy: string;
  /** 1 July and 30 June, inclusive. */
  start: string;
  end: string;
  /** The day the pack was produced, passed in so the engine stays pure. */
  preparedOn: string;
  /** Whose return it is, when Ledger knows. Never invented. */
  taxpayer: string | null;

  ratesAvailable: boolean;
  confidence: RateConfidence | null;
  rateNotes: string[];

  sections: TaxPackSection[];
  checks: TaxPackCheck[];
  /** False when ANY check that ran disagreed. The document leads with it. */
  reconciles: boolean;
  gaps: TaxPackGap[];

  /** The headline, straight from the settlement — never recomputed. */
  outcome: SettlementOutcome;
  refund: number;
  owing: number;
  /** Taxable income, from the tax calculation. */
  taxableIncome: number | null;
}

/**
 * Everything the pack needs, and every bit of it ALREADY COMPUTED. There is no
 * input here the Tax page does not already hold, which is what makes the two
 * incapable of disagreeing.
 */
export interface TaxPackInput {
  position: TaxYearPosition;
  settlement: TaxSettlement;
  /** Null for a year with no offset rules — the section says so. */
  offsets: OffsetPosition | null;
  /** The loan's income base, itemised. */
  repayment: RepaymentIncomeBreakdown;
  hasStudentLoan: boolean;
  /**
   * The user's display currency. The 5.1–5.5 engines deliberately never format
   * money — they hand the UI an `amount` and let it decide — because they run in
   * contexts that have no currency. The pack is different: it IS the document,
   * its detail lines are prose, and prose with a bare "31200.00" in it reads
   * like a bug. So the pack is told the currency once and writes real money.
   */
  currency: string;
  /** Franking credits added to assessable income, from taxCredits.grossUpFor.
   *  The rest of what the user has already paid arrives inside `settlement`. */
  grossUp: number;
  /** What the tax calculation was run on. Null when the year has no rates. */
  taxableIncome: number | null;
  preparedOn: string;
  taxpayer?: string | null;
}

// ─── Arithmetic (presentation only) ──────────────────────────────────────────

function r2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * A cent. Every engine rounds to cents, so anything inside this is the same
 * number written twice and anything outside it is a real disagreement.
 */
export const RECONCILE_TOLERANCE = 0.01;

function agrees(a: number | null, b: number | null): boolean {
  if (a == null || b == null) return a === b;
  // Rounded before comparing: a difference of exactly one cent can come out of
  // binary floating point as 0.010000000000002, and a check that called that a
  // disagreement would cry wolf on every large year.
  return r2(Math.abs(a - b)) <= RECONCILE_TOLERANCE;
}

/**
 * The sum of what a section DISPLAYS: its 'add' lines less its 'subtract'
 * lines, ignoring children (a parent already carries them) and ignoring
 * 'info'/'total'/'subtotal'. This is the pack side of every check.
 */
export function sumOfLines(lines: TaxPackLine[]): number {
  return r2(lines.reduce((s, l) => {
    if (l.amount == null) return s;
    if (l.role === 'add') return s + l.amount;
    if (l.role === 'subtract') return s - l.amount;
    return s;
  }, 0));
}

function line(l: Partial<TaxPackLine> & { key: string; label: string }): TaxPackLine {
  return {
    amount: null,
    role: 'info',
    provenance: 'derived',
    detail: null,
    date: null,
    drill: null,
    children: [],
    ...l,
  };
}

function section(s: Partial<TaxPackSection> & { id: TaxPackSectionId; title: string }): TaxPackSection {
  return {
    role: 'return',
    supports: null,
    subtitle: null,
    lines: [],
    total: null,
    totalLabel: 'Total',
    empty: false,
    note: null,
    ...s,
  };
}

/** Money for a detail string, in the user's own currency. */
function moneyIn(currency: string): (n: number) => string {
  return n => formatCurrency(r2(n), currency);
}

/** Where a deduction line came from, in provenance terms. */
function deductionProvenance(source: DeductionSource): TaxPackProvenance {
  // A manual deduction is the user's assertion; a transaction and a rental
  // heading are both Ledger reading the user's own records.
  return source === 'manual' ? 'entered' : 'derived';
}

// ─── Section 1 · Income ──────────────────────────────────────────────────────

/**
 * Assessable income, grouped exactly as the FY position groups it, plus the
 * franking gross-up — company tax already paid, which the ATO adds to income
 * and credits against the bill, so it appears on both sides or neither.
 *
 * Excluded lines are SHOWN, as info, with the reason. An amount left out of a
 * return is more alarming when it is invisible than when it is explained, and
 * the accountant is the person most likely to ask about it.
 */
function incomeSection(input: TaxPackInput): TaxPackSection {
  const { position, grossUp } = input;
  const income = position.income;
  const lines: TaxPackLine[] = [];

  for (const g of income.groups) {
    const counted = g.lines.filter(l => !l.excluded);
    const excluded = g.lines.filter(l => l.excluded);
    // A category whose every line was excluded still gets a row, at zero, so
    // the reason survives into the document.
    const drill: TaxPackDrill | null =
      g.category === RENT_CATEGORY ? { kind: 'section', id: 'rental' }
      : g.category === CAPITAL_GAIN_CATEGORY ? { kind: 'section', id: 'capital-gains' }
      : null;

    lines.push(line({
      key: `income:${g.category}`,
      label: g.category,
      amount: r2(g.total),
      role: 'add',
      provenance: 'derived',
      detail: counted.length === 1 ? '1 source' : `${counted.length} sources`,
      drill,
      children: [
        ...counted.map(l => line({
          key: l.key,
          label: l.label,
          amount: r2(l.amount),
          role: 'add',
          provenance: 'derived',
          detail: l.detail,
          date: l.date,
          drill: l.transactionId
            ? { kind: 'transaction', id: l.transactionId }
            : { kind: 'income', id: l.key },
        })),
        ...excluded.map(l => line({
          key: l.key,
          label: l.label,
          amount: r2(l.amount),
          role: 'info',
          provenance: 'derived',
          detail: `Not counted — ${EXCLUDED_INCOME_DETAIL[l.excludedReason ?? ''] ?? 'excluded'}`,
          date: l.date,
          drill: l.transactionId
            ? { kind: 'transaction', id: l.transactionId }
            : { kind: 'income', id: l.key },
        })),
      ],
    }));
  }

  const hasStatements = (income.dividends?.lines.length ?? 0) > 0;
  if (grossUp > 0) {
    lines.push(line({
      key: 'income:franking-gross-up',
      label: 'Franking credits added to income',
      amount: r2(grossUp),
      role: 'add',
      // A STATEMENT makes it derived; a single typed figure on the tax-paid card
      // does not, and a dividend position with no statements in it is only ever
      // that typed figure wearing the engine's clothes. The pack refuses to
      // blur the two — it is the difference between a number an accountant can
      // check and one they have to take on trust.
      provenance: hasStatements ? 'derived' : 'entered',
      detail: 'Company tax already paid on your behalf. Credited against the bill as well.',
      drill: hasStatements
        ? { kind: 'section', id: 'dividends' }
        : { kind: 'entry', id: 'credits.frankingCredits' },
    }));
  }

  return section({
    id: 'income',
    title: 'Income',
    role: 'return',
    subtitle: 'Every amount assessable in the year, by category.',
    lines,
    total: r2(position.assessableIncome + grossUp),
    totalLabel: 'Total assessable income',
    empty: lines.length === 0,
    note: lines.length === 0 ? 'No income recorded for this year.' : null,
  });
}

/** Plain-English reason an income line was shown but not counted. */
const EXCLUDED_INCOME_DETAIL: Record<string, string> = {
  'pending': 'a pending income entry, not yet approved',
  'counted-in-payslip': 'the payslip totals already include it',
  'possible-duplicate': 'looks like the same money as another line',
  'refund': 'a refund, not income',
  'transfer': 'a transfer between your own accounts',
  'counted-in-income': 'the cash is already counted; only the franking credit was added',
  'counted-in-rental': 'counted on the rental schedule',
};

// ─── Section 2 · PAYG withholding ────────────────────────────────────────────

/**
 * What was already withheld, and from what. A schedule rather than a return
 * section: the total is credited in the settlement, and adding it anywhere else
 * would count the same money twice.
 */
function withholdingSection(input: TaxPackInput): TaxPackSection {
  const { settlement, position } = input;
  const sources = settlement.withholdingSources;
  const withheldFrom = sources.filter(s => s.withheld > 0);

  const lines: TaxPackLine[] = [
    ...withheldFrom.map(s => line({
      key: `payg:${s.key}`,
      label: s.label,
      amount: r2(s.withheld),
      role: 'add',
      provenance: 'derived',
      detail: `${s.category} · ${s.effectiveRate.toFixed(1)}% of the income on this source`,
      date: s.date,
      drill: s.transactionId
        ? { kind: 'transaction', id: s.transactionId }
        : { kind: 'income', id: s.key },
    })),
    ...sources.filter(s => s.withheld <= 0 && s.income > 0).map(s => line({
      key: `payg:${s.key}`,
      label: s.label,
      amount: 0,
      role: 'info',
      provenance: 'derived',
      detail: 'Nothing withheld from this income',
      date: s.date,
      drill: s.transactionId
        ? { kind: 'transaction', id: s.transactionId }
        : { kind: 'income', id: s.key },
    })),
  ];

  return section({
    id: 'withholding',
    title: 'PAYG withholding',
    role: 'schedule',
    supports: 'Tax already paid, in the settlement below',
    subtitle: 'Tax already taken out before the money reached you.',
    lines,
    total: r2(position.taxWithheld),
    totalLabel: 'Total PAYG withheld',
    empty: withheldFrom.length === 0,
    note: withheldFrom.length === 0
      ? 'No tax was withheld from any income this year.'
      : null,
  });
}

// ─── Section 3 · Deductions ──────────────────────────────────────────────────

function deductionsSection(input: TaxPackInput): TaxPackSection {
  const view = input.position.deductions;
  const money = moneyIn(input.currency);
  const lines: TaxPackLine[] = view.groups.map(g => {
    const counted = g.lines.filter(l => !l.excluded);
    const excluded = g.lines.filter(l => l.excluded);
    return line({
      key: `ded:${g.category}`,
      label: g.category,
      amount: r2(g.total),
      role: 'add',
      provenance: 'derived',
      detail: counted.length === 1 ? '1 claim' : `${counted.length} claims`,
      drill: g.lines.some(l => l.source === 'rental') ? { kind: 'section', id: 'rental' } : null,
      children: [
        ...counted.map(l => line({
          key: l.key,
          label: l.name,
          amount: r2(l.netAmount),
          role: 'add',
          provenance: deductionProvenance(l.source),
          detail: l.refunded > 0
            ? `${l.entity === 'business' ? 'Business' : 'Personal'} · ${money(l.amount)} claimed less ${money(l.refunded)} refunded`
            : l.entity === 'business' ? 'Business' : 'Personal',
          date: l.date,
          drill: l.transactionId
            ? { kind: 'transaction', id: l.transactionId }
            : { kind: 'deduction', id: l.key },
        })),
        ...excluded.map(l => line({
          key: l.key,
          label: l.name,
          amount: r2(l.netAmount),
          role: 'info',
          provenance: deductionProvenance(l.source),
          detail: l.excludedReason === 'counted-in-rental'
            ? 'Not counted here — claimed on the rental schedule, at your share'
            : 'Not counted — looks like a duplicate of another claim',
          date: l.date,
          drill: l.transactionId
            ? { kind: 'transaction', id: l.transactionId }
            : { kind: 'deduction', id: l.key },
        })),
      ],
    });
  });

  return section({
    id: 'deductions',
    title: 'Deductions',
    role: 'return',
    subtitle: 'Claimable expenses for the year, net of anything refunded.',
    lines,
    total: r2(input.position.deductibleExpenses),
    totalLabel: 'Total deductions',
    empty: lines.length === 0,
    note: lines.length === 0 ? 'No deductions recorded for this year.' : null,
  });
}

// ─── Section 4 · Capital gains and losses ────────────────────────────────────

/**
 * The CGT working, in the ATO's own step order. A schedule: its net capital
 * gain is already an income line above, and this is the audit trail behind it.
 */
/** Which gains a loss was set against, in words rather than bucket keys. */
const GAIN_BUCKET_LABEL: Record<string, string> = {
  'other': 'gains with no discount',
  'discount': 'gains eligible for the discount',
  'collectable-other': 'collectable gains with no discount',
  'collectable-discount': 'collectable gains eligible for the discount',
};

function lossApplicationLabel(a: import('./capitalGains').LossApplication): string {
  const when = a.source === 'current-year' ? 'This year’s' : 'Carried-forward';
  const pool = a.pool === 'collectable' ? 'collectable loss' : 'loss';
  return `${when} ${pool}, against ${GAIN_BUCKET_LABEL[a.against] ?? a.against}`;
}

function capitalGainsSection(input: TaxPackInput): TaxPackSection {
  const cg = input.position.capitalGains;
  const money = moneyIn(input.currency);
  if (!cg || cg.events.length === 0) {
    return section({
      id: 'capital-gains',
      title: 'Capital gains and losses',
      role: 'schedule',
      supports: 'Net capital gain, in the income above',
      total: cg ? r2(cg.netCapitalGain) : 0,
      totalLabel: 'Net capital gain',
      empty: true,
      note: 'No disposals recorded in this year.',
    });
  }

  const pools = (p: { ordinary: number; collectable: number }) =>
    p.collectable > 0
      ? `${money(p.ordinary)} ordinary, ${money(p.collectable)} collectables`
      : null;

  const lines: TaxPackLine[] = [
    line({
      key: 'cgt:proceeds',
      label: 'Gross proceeds from disposals',
      amount: r2(cg.proceeds),
      role: 'info',
      detail: cg.events.length === 1 ? '1 disposal' : `${cg.events.length} disposals`,
    }),
    line({
      key: 'cgt:cost-base',
      label: 'Cost base of what was sold',
      amount: r2(cg.costBase),
      role: 'info',
    }),
    line({
      key: 'cgt:gross-gains',
      label: 'Capital gains before losses and the discount',
      amount: r2(cg.grossGainsTotal),
      role: 'add',
      children: cg.events.map(e => line({
        key: `cgt:event:${e.disposalId}`,
        label: e.label,
        amount: r2(e.gain),
        role: e.gain >= 0 ? 'add' : 'subtract',
        detail: `Sold ${e.saleDate} · proceeds ${money(e.netProceeds)} less cost base ${money(e.costBase)}`
          + (e.discountableGain > 0 ? ' · held 12 months, eligible for the discount' : ''),
        date: e.saleDate,
        drill: { kind: 'cgt-event', id: e.disposalId },
      })),
    }),
    line({
      key: 'cgt:losses-applied',
      label: 'Capital losses applied',
      amount: r2(cg.lossesApplied),
      role: 'subtract',
      detail: cg.lossApplications.length === 0
        ? 'No losses available to apply'
        : `${cg.lossApplications.length} application${cg.lossApplications.length === 1 ? '' : 's'}`,
      children: cg.lossApplications.map((a, i) => line({
        key: `cgt:loss:${i}`,
        label: lossApplicationLabel(a),
        amount: r2(a.amount),
        role: 'subtract',
      })),
    }),
    line({
      key: 'cgt:discount',
      label: 'CGT discount',
      amount: r2(cg.discount),
      role: 'subtract',
      provenance: 'rates',
      detail: '50% of the gains held for at least 12 months, after losses',
    }),
    line({
      key: 'cgt:brought-forward',
      label: 'Losses brought into the year',
      amount: r2(cg.broughtForward.ordinary + cg.broughtForward.collectable),
      role: 'info',
      detail: pools(cg.broughtForward),
    }),
    line({
      key: 'cgt:carried-forward',
      label: 'Losses carried to next year',
      amount: r2(cg.carriedForwardTotal),
      role: 'info',
      detail: pools(cg.carriedForward)
        ?? 'Carried forward indefinitely until a gain uses them',
    }),
  ];

  if (cg.exemptAmount > 0) {
    lines.push(line({
      key: 'cgt:exempt',
      label: 'Ignored under the $500 collectable rule',
      amount: r2(cg.exemptAmount),
      role: 'info',
      provenance: 'rates',
    }));
  }

  return section({
    id: 'capital-gains',
    title: 'Capital gains and losses',
    role: 'schedule',
    supports: 'Net capital gain, in the income above',
    subtitle: 'Gains, the losses set against them, and the discount — in the ATO’s step order.',
    lines,
    total: r2(cg.netCapitalGain),
    totalLabel: 'Net capital gain',
  });
}

// ─── Section 5 · Dividends and franking ──────────────────────────────────────

function dividendsSection(input: TaxPackInput): TaxPackSection {
  const d = input.position.income.dividends;
  const money = moneyIn(input.currency);
  if (!d || d.lines.length === 0) {
    return section({
      id: 'dividends',
      title: 'Dividends and franking credits',
      role: 'schedule',
      supports: 'Dividend income, and the franking credit in the settlement',
      total: 0,
      totalLabel: 'Grossed-up dividend income',
      empty: true,
      note: 'No dividend statements recorded for this year.',
    });
  }

  const lines: TaxPackLine[] = [
    line({
      key: 'div:franked',
      label: 'Franked amount',
      amount: r2(d.frankedAmount),
      role: 'add',
    }),
    line({
      key: 'div:unfranked',
      label: 'Unfranked amount',
      amount: r2(d.unfrankedAmount),
      role: 'add',
    }),
    line({
      key: 'div:credit',
      label: 'Franking credits',
      amount: r2(d.frankingCredit),
      role: 'add',
      detail: 'Company tax already paid. Assessable to you, and credited against the bill.',
    }),
    ...d.lines.map(l => line({
      key: `div:stmt:${l.statementId}`,
      label: l.ticker ? `${l.label} (${l.ticker})` : l.label,
      amount: r2(l.grossedUp),
      role: 'info',
      detail: `Paid ${l.date} · ${money(l.frankedAmount)} franked, `
        + `${money(l.unfrankedAmount)} unfranked, ${money(l.frankingCredit)} credit`
        + (l.matchedIncomeLabel ? ` · cash already counted as "${l.matchedIncomeLabel}"` : ''),
      date: l.date,
      drill: { kind: 'dividend', id: l.statementId },
    })),
  ];

  if (d.withheld > 0) {
    lines.push(line({
      key: 'div:withheld',
      label: 'Tax withheld from dividends',
      amount: r2(d.withheld),
      role: 'info',
      detail: 'Enter this on the tax-paid card to have it credited.',
    }));
  }
  if (d.additionalAssessableIncome > 0) {
    lines.push(line({
      key: 'div:added',
      label: 'Dividend cash added to income by these statements',
      amount: r2(d.additionalAssessableIncome),
      role: 'info',
      detail: 'The rest was already counted as bank income and was not added twice.',
      drill: { kind: 'section', id: 'income' },
    }));
  }

  return section({
    id: 'dividends',
    title: 'Dividends and franking credits',
    role: 'schedule',
    supports: 'Dividend income, and the franking credit in the settlement',
    subtitle: 'Every statement dated in the year, and what the ATO assesses from it.',
    lines,
    total: r2(d.grossedUpTotal),
    totalLabel: 'Grossed-up dividend income',
  });
}

// ─── Section 6 · Rental schedules ────────────────────────────────────────────

/** One rental property, as the return's own rental schedule reads. */
function rentalPropertyLine(
  p: import('./rentalProperty').RentalPropertyResult,
  money: (n: number) => string,
): TaxPackLine {
  const children: TaxPackLine[] = [
    line({
      key: `rent:${p.id}:income`,
      label: 'Rent received',
      amount: r2(p.grossRent),
      role: 'add',
      detail: p.rentPayments.length === 1
        ? '1 payment'
        : `${p.rentPayments.length} payments`,
      children: p.rentPayments.map(pay => line({
        key: `rent:${p.id}:pay:${pay.id}`,
        label: `${pay.date} · ${pay.merchant}`,
        amount: r2(pay.amount),
        role: 'add',
        detail: pay.via,
        date: pay.date,
        drill: { kind: 'transaction', id: pay.id },
      })),
    }),
  ];
  if (p.otherIncome > 0) {
    children.push(line({
      key: `rent:${p.id}:other-income`,
      label: 'Other rental income',
      amount: r2(p.otherIncome),
      role: 'add',
      provenance: 'entered',
      detail: 'A bond retained, an insurance payout — money the bank feed never saw',
    }));
  }
  for (const d of p.deductions) {
    children.push(line({
      key: `rent:${p.id}:${d.key}`,
      label: d.label,
      amount: r2(d.claimed),
      role: 'subtract',
      provenance: d.kind === 'interest' && p.interest.basis === 'statement' ? 'entered'
        : d.payments.length === 0 ? 'entered' : 'derived',
      detail: d.detail ?? (d.apportioned
        ? `${money(d.net)} paid, claimed at your share`
        : d.count === 1 ? '1 payment' : `${d.count} payments`),
      children: d.payments.map(pay => line({
        key: `rent:${p.id}:${d.key}:${pay.id}`,
        label: `${pay.date} · ${pay.merchant}`,
        amount: r2(pay.amount),
        role: pay.flow === 'refund' ? 'add' : 'subtract',
        detail: pay.flow === 'refund' ? `Refund · ${pay.via}` : pay.via,
        date: pay.date,
        drill: { kind: 'transaction', id: pay.id },
      })),
    }));
  }
  if (p.interest.gross > 0 && p.interest.principalNotDeductible > 0) {
    children.push(line({
      key: `rent:${p.id}:principal`,
      label: 'Loan principal — not deductible',
      amount: r2(p.interest.principalNotDeductible),
      role: 'info',
      detail: `Repayments of ${money(p.interest.repayments)} less `
        + `${money(p.interest.gross)} of interest. Reported so the split can be checked.`,
    }));
  }

  return line({
    key: `rent:${p.id}`,
    label: p.label,
    amount: r2(p.netRent),
    role: 'add',
    detail: `${money(p.income)} received less ${money(p.totalDeductions)} deductible`
      + (p.netRent < 0 ? ' — a net rental loss' : ''),
    drill: { kind: 'property', id: p.id },
    children,
  });
}

function rentalSection(input: TaxPackInput): TaxPackSection {
  const r = input.position.income.rental;
  const money = moneyIn(input.currency);
  if (!r || r.properties.length === 0) {
    return section({
      id: 'rental',
      title: 'Rental properties',
      role: 'schedule',
      supports: 'Rent in the income above, and the property expenses in the deductions',
      total: 0,
      totalLabel: 'Net rental income',
      empty: true,
      note: 'No rental properties recorded for this year.',
    });
  }

  const inSchedule = r.properties.filter(p => p.inSchedule);
  const lines: TaxPackLine[] = [
    ...inSchedule.map(p => rentalPropertyLine(p, money)),
    ...r.properties.filter(p => !p.inSchedule).map(p => line({
      key: `rent:${p.id}`,
      label: p.label,
      amount: 0,
      role: 'info',
      detail: `Not in the schedule — ${EXCLUDED_PROPERTY_DETAIL[p.excludedReason ?? ''] ?? 'excluded'}`,
      drill: { kind: 'property', id: p.id },
    })),
  ];

  return section({
    id: 'rental',
    title: 'Rental properties',
    role: 'schedule',
    supports: 'Rent in the income above, and the property expenses in the deductions',
    subtitle: 'Rent as it was RECEIVED, and every expense under its ATO heading.',
    lines,
    total: r2(r.netRent),
    totalLabel: r.netRent < 0 ? 'Net rental loss' : 'Net rental income',
    empty: inSchedule.length === 0,
    note: inSchedule.length === 0
      ? 'No property was in the rental schedule this year.'
      : null,
  });
}

const EXCLUDED_PROPERTY_DETAIL: Record<string, string> = {
  'owner-occupied': 'your home, so nothing here is assessable or deductible',
  'not-available-for-rent': 'not rented or genuinely available for rent this year',
  'held-in-fund': 'held in a super fund, which lodges its own return',
  'no-activity': 'no rent and no expenses recorded in this year',
};

// ─── Section 7 · Taxable income ──────────────────────────────────────────────

/**
 * The one subtraction the whole return turns on, written out. Everything in it
 * comes from the two sections above; nothing new is worked out here.
 */
function taxableIncomeSection(input: TaxPackInput): TaxPackSection {
  const { position, grossUp } = input;
  const assessable = r2(position.assessableIncome + grossUp);
  const deductions = r2(position.deductibleExpenses);
  const lines: TaxPackLine[] = [
    line({
      key: 'ti:assessable',
      label: 'Total assessable income',
      amount: assessable,
      role: 'add',
      drill: { kind: 'section', id: 'income' },
    }),
    line({
      key: 'ti:deductions',
      label: 'Less total deductions',
      amount: deductions,
      role: 'subtract',
      drill: { kind: 'section', id: 'deductions' },
    }),
  ];
  if (deductions > assessable) {
    lines.push(line({
      key: 'ti:floored',
      label: 'Taxable income cannot go below nil',
      amount: r2(deductions - assessable),
      role: 'info',
      provenance: 'rates',
      detail: 'Deductions exceed income by this much. The excess is not a refund; '
        + 'a loss may be able to be carried forward — ask your accountant.',
    }));
  }
  return section({
    id: 'taxable-income',
    title: 'Taxable income',
    role: 'return',
    lines,
    total: input.taxableIncome,
    totalLabel: 'Taxable income',
  });
}

// ─── Section 8 · Tax on that income ──────────────────────────────────────────

function taxSection(input: TaxPackInput): TaxPackSection {
  const s = input.settlement;
  if (!s.ratesAvailable) {
    return section({
      id: 'tax',
      title: 'Tax on your taxable income',
      role: 'return',
      total: null,
      totalLabel: 'Total tax and levies',
      empty: true,
      note: `Ledger holds no rates for FY ${formatFY(input.position.fy)}, so no tax is estimated. `
        + 'Everything above is still your own year, unchanged.',
    });
  }
  return section({
    id: 'tax',
    title: 'Tax on your taxable income',
    role: 'return',
    subtitle: 'Income tax, the Medicare levy and anything charged alongside them.',
    lines: s.liability.components.map(c => line({
      key: `tax:${c.key}`,
      label: c.label,
      amount: c.amount,
      role: 'add',
      provenance: 'rates',
      detail: c.detail,
      drill: c.key === 'study-loan' ? { kind: 'section', id: 'student-loan' } : null,
    })),
    total: s.liability.total,
    totalLabel: 'Total tax and levies',
  });
}

// ─── Section 9 · Offsets ─────────────────────────────────────────────────────

function offsetsSection(input: TaxPackInput): TaxPackSection {
  const s = input.settlement;
  const o = input.offsets;
  const money = moneyIn(input.currency);
  if (!s.ratesAvailable || !o) {
    return section({
      id: 'offsets',
      title: 'Tax offsets',
      role: 'return',
      total: s.ratesAvailable ? 0 : null,
      totalLabel: 'Offsets applied',
      empty: true,
      note: s.ratesAvailable
        ? `Ledger holds no offset rules for FY ${formatFY(input.position.fy)}.`
        : 'Not estimated — no rates for this year.',
    });
  }

  const lines: TaxPackLine[] = s.offsets.components.map(c => line({
    key: `off:${c.key}`,
    label: c.label,
    amount: c.amount,
    role: 'add',
    provenance: 'rates',
    detail: c.detail,
  }));

  if (o.unusedOffsets > 0) {
    lines.push(line({
      key: 'off:unused',
      label: 'Entitlement with nothing to offset',
      amount: r2(o.unusedOffsets),
      role: 'info',
      provenance: 'rates',
      detail: 'These offsets are non-refundable, so relief beyond the income tax is simply lost.',
    }));
  }
  if (o.surcharge) {
    lines.push(line({
      key: 'off:surcharge-basis',
      label: `Medicare levy surcharge — ${o.surcharge.tierLabel}`,
      amount: r2(o.surcharge.amount),
      role: 'info',
      provenance: 'rates',
      detail: `Tested on ${money(o.surcharge.testedIncome)} `
        + `${o.surcharge.familyThresholds ? 'family' : 'single'} income for surcharge purposes, `
        + `against a ${money(o.surcharge.threshold)} threshold`
        + (o.surcharge.exemptReason === 'not-answered'
          // Silence is not cover. Saying "covered all year" here would answer a
          // question the user never did, on the one input that can add a
          // four-figure amount to the bill.
          ? ' · hospital cover not answered, so no surcharge is included — a full '
            + `year without it would add ${money(o.surcharge.fullYearAmount)}`
          : o.surcharge.daysWithoutCover > 0
            ? ` · ${o.surcharge.daysWithoutCover} of ${o.surcharge.daysInYear} days without hospital cover`
            : ' · covered all year'),
    }));
  }
  if (o.health && o.health.premiums > 0) {
    lines.push(line({
      key: 'off:health',
      label: 'Private health rebate',
      amount: r2(Math.abs(o.health.adjustment)),
      role: 'info',
      provenance: 'rates',
      detail: `${money(o.health.entitled)} entitled on ${money(o.health.premiums)} of premiums, `
        + `${money(o.health.received)} already received — `
        + (o.health.adjustment > 0 ? 'the excess is added to the bill'
          : o.health.adjustment < 0 ? 'the shortfall comes back as a refundable offset'
          : 'exactly right, nothing to adjust'),
    }));
  }

  return section({
    id: 'offsets',
    title: 'Tax offsets',
    role: 'return',
    subtitle: 'Non-refundable relief, capped at the income tax it is set against.',
    lines,
    total: s.offsets.total,
    totalLabel: 'Offsets applied',
    empty: s.offsets.components.length === 0,
    note: s.offsets.components.length === 0 ? 'No offsets applied this year.' : null,
  });
}

// ─── Section 10 · Study and training loan ────────────────────────────────────

function studentLoanSection(input: TaxPackInput): TaxPackSection {
  const { repayment, hasStudentLoan, settlement } = input;
  const repaymentAmount = settlement.liability.components
    .find(c => c.key === 'study-loan')?.amount ?? 0;

  if (!hasStudentLoan) {
    return section({
      id: 'student-loan',
      title: 'Study and training loan',
      role: 'schedule',
      supports: 'The loan repayment in the tax above',
      total: 0,
      totalLabel: 'Repayment income',
      empty: true,
      note: 'No study or training loan recorded.',
    });
  }

  const lines: TaxPackLine[] = repayment.components.map(c => line({
    key: `help:${c.key}`,
    label: c.label,
    amount: r2(Math.abs(c.amount)),
    role: c.amount < 0 ? 'subtract' : 'add',
    provenance: c.key === 'taxableIncome' ? 'derived' : 'entered',
    detail: c.key === 'taxableIncome'
      ? 'The base a repayment is built from'
      : c.amount < 0
        ? 'Inside taxable income, but excluded from repayment income'
        : 'Not inside taxable income, but counted for a repayment',
    drill: c.key === 'taxableIncome'
      ? { kind: 'section', id: 'taxable-income' }
      : { kind: 'entry', id: `repaymentIncome.${c.key}` },
  }));

  lines.push(line({
    key: 'help:repayment',
    label: 'Compulsory repayment for the year',
    amount: settlement.ratesAvailable ? r2(repaymentAmount) : null,
    role: 'info',
    provenance: 'rates',
    detail: settlement.ratesAvailable
      ? (repaymentAmount > 0
        ? 'Charged with your tax, and already in the total tax above'
        : 'Repayment income is below this year’s first repayment threshold')
      : 'Not estimated — no rates for this year',
    drill: { kind: 'section', id: 'tax' },
  }));

  return section({
    id: 'student-loan',
    title: 'Study and training loan',
    role: 'schedule',
    supports: 'The loan repayment in the tax above',
    subtitle: 'A repayment is assessed on repayment income, not taxable income.',
    lines,
    total: r2(repayment.total),
    totalLabel: 'Repayment income',
  });
}

// ─── Section 11 · Refund or amount owing ─────────────────────────────────────

/**
 * "Less X", with X reading as it would mid-sentence. Only the first character
 * is lowered, and only when the first word is not an acronym — otherwise "PAYG
 * withheld" becomes "payg withheld".
 */
function lessOf(label: string): string {
  const first = label.split(' ')[0];
  const acronym = first.length > 1 && first === first.toUpperCase();
  return `Less ${acronym ? label : label.charAt(0).toLowerCase() + label.slice(1)}`;
}

function settlementSection(input: TaxPackInput): TaxPackSection {
  const s = input.settlement;
  const hasStatements = (input.position.income.dividends?.lines.length ?? 0) > 0;
  if (!s.ratesAvailable) {
    return section({
      id: 'settlement',
      title: 'Estimated refund or amount owing',
      role: 'return',
      total: null,
      totalLabel: 'Estimated position',
      empty: true,
      note: `No rates are held for FY ${formatFY(input.position.fy)}, so the outcome cannot be estimated. `
        + 'Your income, deductions and schedules above are unaffected.',
    });
  }

  const lines: TaxPackLine[] = [
    line({
      key: 'net:liability',
      label: 'Total tax and levies',
      amount: s.liability.total,
      role: 'add',
      provenance: 'rates',
      drill: { kind: 'section', id: 'tax' },
    }),
    line({
      key: 'net:offsets',
      label: 'Less offsets applied',
      amount: s.offsets.total,
      role: 'subtract',
      provenance: 'rates',
      drill: { kind: 'section', id: 'offsets' },
    }),
    line({
      key: 'net:net-liability',
      label: 'Tax for the year',
      amount: s.netLiability,
      role: 'subtotal',
      provenance: 'rates',
      detail: s.effectiveTaxRate != null
        ? `${s.effectiveTaxRate.toFixed(1)}% of your taxable income`
        : null,
    }),
    ...s.credits.components.map(c => line({
      key: `net:${c.key}`,
      label: lessOf(c.label),
      amount: c.amount,
      role: 'subtract',
      // The franking credit is only "entered" when a typed figure is all there
      // is. With statements behind it, it is as derived as the withholding —
      // and it is the same number the income section grossed up.
      provenance: c.key === 'payg-withheld' || (c.key === 'frankingCredits' && hasStatements)
        ? 'derived'
        : 'entered',
      detail: c.detail,
      drill: c.key === 'payg-withheld'
        ? { kind: 'section', id: 'withholding' }
        : c.key === 'frankingCredits' && hasStatements
          ? { kind: 'section', id: 'dividends' }
          : { kind: 'entry', id: `credits.${c.key}` },
    })),
  ];

  return section({
    id: 'settlement',
    title: 'Estimated refund or amount owing',
    role: 'return',
    subtitle: 'What the year costs, against what has already been paid.',
    lines,
    total: s.net,
    // SIGNED, exactly as the settlement engine holds it — positive is owing,
    // negative a refund — because the reconciliation has to run on the engine's
    // own number. The headline the reader sees leads with `outcome`/`refund`/
    // `owing` instead, which are already the right way up.
    totalLabel: 'Amount owing (a negative figure is a refund)',
  });
}

// ─── Reconciliation ──────────────────────────────────────────────────────────

/**
 * Does the document add up to what the Tax page holds?
 *
 * Each check takes the sum of the lines THIS PACK DISPLAYS under a section and
 * compares it with the engine's own figure for the same thing. The pack cannot
 * disagree with the Tax page about where a number came from — they are the same
 * object — so the only thing that can go wrong is the re-presentation, and this
 * is what catches it.
 *
 * A check that cannot run is SKIPPED with a reason, never quietly passed. An
 * unsupported year skips four checks; it does not fail them.
 */
function buildChecks(input: TaxPackInput, sections: TaxPackSection[]): TaxPackCheck[] {
  const by = (id: TaxPackSectionId) => sections.find(s => s.id === id)!;
  const { position, settlement, repayment, grossUp } = input;
  const rates = settlement.ratesAvailable;
  const cg = position.capitalGains;
  const div = position.income.dividends;
  const rent = position.income.rental;

  const check = (
    key: string,
    label: string,
    pack: number | null,
    page: number | null,
    skipped: string | null = null,
  ): TaxPackCheck => ({
    key,
    label,
    pack: skipped ? null : pack,
    page: skipped ? null : page,
    agrees: skipped ? true : agrees(pack, page),
    skipped,
  });

  return [
    check('income', 'Income adds to assessable income',
      sumOfLines(by('income').lines),
      r2(position.assessableIncome + grossUp)),

    check('withholding', 'PAYG lines add to the withholding total',
      sumOfLines(by('withholding').lines),
      r2(position.taxWithheld)),

    check('deductions', 'Deduction categories add to the deduction total',
      sumOfLines(by('deductions').lines),
      r2(position.deductibleExpenses)),

    check('capital-gains', 'The CGT steps add to the net capital gain',
      sumOfLines(by('capital-gains').lines),
      cg ? r2(cg.netCapitalGain) : 0,
      !cg || cg.events.length === 0 ? 'No disposals this year' : null),

    check('dividends', 'Dividend amounts add to the grossed-up total',
      sumOfLines(by('dividends').lines),
      div ? r2(div.grossedUpTotal) : 0,
      !div || div.lines.length === 0 ? 'No dividend statements this year' : null),

    check('rental', 'The properties add to the net rental result',
      sumOfLines(by('rental').lines),
      rent ? r2(rent.netRent) : 0,
      !rent || rent.properties.every(p => !p.inSchedule) ? 'No property in the schedule' : null),

    // The floor is the ATO's, not the pack's: deductions bigger than income give
    // a taxable income of nil, so the comparison has to be made after it.
    check('taxable-income', 'Income less deductions is the taxable income',
      Math.max(0, sumOfLines(by('taxable-income').lines)),
      input.taxableIncome),

    check('tax', 'The tax components add to the total tax',
      sumOfLines(by('tax').lines),
      settlement.liability.total,
      rates ? null : 'No rates held for this year'),

    check('offsets', 'The offset lines add to the offsets applied',
      sumOfLines(by('offsets').lines),
      settlement.offsets.total,
      rates ? null : 'No rates held for this year'),

    check('student-loan', 'The repayment-income parts add to repayment income',
      Math.max(0, sumOfLines(by('student-loan').lines)),
      r2(repayment.total),
      input.hasStudentLoan ? null : 'No study or training loan'),

    check('settlement', 'Tax less offsets less credits is the final position',
      sumOfLines(by('settlement').lines),
      settlement.net,
      rates ? null : 'No rates held for this year'),
  ];
}

// ─── What an accountant would ask about ──────────────────────────────────────

/** How seriously to take each of the FY position's own notes. */
const NOTE_SEVERITY: Record<string, 'warn' | 'info'> = {
  'duplicate': 'warn',
  'pending-income': 'warn',
  'uncategorised': 'warn',
  'recouped': 'info',
  'no-income': 'info',
  'capital-loss': 'info',
  'rental-loss': 'info',
};

const NOTE_SECTION: Record<string, TaxPackSectionId> = {
  'duplicate': 'deductions',
  'pending-income': 'income',
  'uncategorised': 'deductions',
  'recouped': 'deductions',
  'no-income': 'income',
  'capital-loss': 'capital-gains',
  'rental-loss': 'rental',
};

/** Every 'entered' figure in the pack — the ones with no record behind them. */
function countEnteredFigures(sections: TaxPackSection[]): number {
  let n = 0;
  const walk = (ls: TaxPackLine[]) => {
    for (const l of ls) {
      if (l.provenance === 'entered' && l.amount != null && l.amount !== 0) n += 1;
      walk(l.children);
    }
  };
  for (const s of sections) walk(s.lines);
  return n;
}

/**
 * The cover letter: everything still open, gathered from the engines that
 * already know about it. Nothing here is discovered by the pack — it is the
 * five engines' own warnings, plus the position's notes, in one list, deduped,
 * worst first.
 */
function buildGaps(input: TaxPackInput, sections: TaxPackSection[]): TaxPackGap[] {
  const { position, settlement, offsets } = input;
  const gaps: TaxPackGap[] = [];
  const push = (g: TaxPackGap) => gaps.push(g);

  for (const w of settlement.warnings) {
    push({ key: `settlement:${w.kind}`, severity: w.severity, message: w.message,
      section: 'settlement', amount: w.amount, count: w.count });
  }
  for (const w of offsets?.warnings ?? []) {
    push({ key: `offsets:${w.kind}`, severity: w.severity, message: w.message,
      section: 'offsets', amount: w.amount, count: w.count });
  }
  for (const w of position.capitalGains?.warnings ?? []) {
    push({ key: `cgt:${w.kind}`, severity: w.severity, message: w.message,
      section: 'capital-gains', amount: w.amount, count: w.count });
  }
  for (const w of position.income.dividends?.warnings ?? []) {
    push({ key: `div:${w.kind}`, severity: w.severity, message: w.message,
      section: 'dividends', amount: w.amount, count: w.count });
  }
  for (const w of position.income.rental?.warnings ?? []) {
    push({ key: `rental:${w.kind}:${w.propertyId ?? 'all'}`, severity: w.severity,
      message: w.message, section: 'rental', amount: w.amount });
  }
  for (const n of position.notes) {
    push({ key: `note:${n.kind}`, severity: NOTE_SEVERITY[n.kind] ?? 'info', message: n.message,
      section: NOTE_SECTION[n.kind] ?? null, amount: n.amount, count: n.count });
  }

  // Nothing at all recorded is worth saying plainly, because an empty pack looks
  // the same as a pack for a year with nothing in it.
  if (position.assessableIncome === 0 && position.deductibleExpenses === 0) {
    push({
      key: 'empty-year',
      severity: 'warn',
      section: null,
      message: 'No income and no deductions are recorded for this year, so there is nothing to lodge from. '
        + 'Check the financial year selected, and that the year\'s transactions are loaded.',
    });
  }

  const entered = countEnteredFigures(sections);
  if (entered > 0) {
    push({
      key: 'entered-figures',
      severity: 'info',
      section: null,
      count: entered,
      message: 'Some figures in this pack were entered by hand rather than derived from your records. '
        + 'They are marked "entered" throughout, and your accountant will want the statement behind each one.',
    });
  }

  // Deduped twice over, because two engines can reach the same conclusion about
  // the same year and saying it twice makes the list look longer than the
  // problem is. By MESSAGE, for the identical sentence; and by KIND, because a
  // downstream engine often re-raises an upstream one's warning in its own
  // words — the settlement restates the position's pending-income note, for
  // instance. First wins, which is the engine closest to the outcome.
  const seenMessage = new Set<string>();
  const seenKind = new Set<string>();
  return gaps
    .filter(g => {
      const kind = g.key.slice(g.key.indexOf(':') + 1);
      if (seenMessage.has(g.message) || seenKind.has(kind)) return false;
      seenMessage.add(g.message);
      seenKind.add(kind);
      return true;
    })
    .sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'warn' ? -1 : 1));
}

// ─── The pack ────────────────────────────────────────────────────────────────

/**
 * Assemble the year into one document. Pure: the same inputs always produce the
 * same pack, `preparedOn` included.
 */
export function buildTaxPack(input: TaxPackInput): TaxPack {
  const { position, settlement } = input;

  const sections: TaxPackSection[] = [
    incomeSection(input),
    withholdingSection(input),
    deductionsSection(input),
    capitalGainsSection(input),
    dividendsSection(input),
    rentalSection(input),
    taxableIncomeSection(input),
    taxSection(input),
    offsetsSection(input),
    studentLoanSection(input),
    settlementSection(input),
  ];

  const checks = buildChecks(input, sections);

  return {
    fy: position.fy,
    start: position.start,
    end: position.end,
    preparedOn: input.preparedOn,
    taxpayer: input.taxpayer?.trim() || null,
    ratesAvailable: settlement.ratesAvailable,
    confidence: settlement.confidence,
    rateNotes: settlement.notes,
    sections,
    checks,
    reconciles: checks.every(c => c.agrees),
    gaps: buildGaps(input, sections),
    outcome: settlement.outcome,
    refund: settlement.refund,
    owing: settlement.owing,
    taxableIncome: input.taxableIncome,
  };
}

/** The section with this id, or undefined. Convenience for callers and tests. */
export function packSection(pack: TaxPack, id: TaxPackSectionId): TaxPackSection | undefined {
  return pack.sections.find(s => s.id === id);
}

/** Every line in the pack, parents before children, flattened with its depth. */
export function flattenPackLines(
  section: TaxPackSection,
): { line: TaxPackLine; depth: number }[] {
  const out: { line: TaxPackLine; depth: number }[] = [];
  const walk = (ls: TaxPackLine[], depth: number) => {
    for (const l of ls) {
      out.push({ line: l, depth });
      walk(l.children, depth + 1);
    }
  };
  walk(section.lines, 0);
  return out;
}
