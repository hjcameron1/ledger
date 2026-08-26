/**
 * Phase 5.1 — Australian tax-year position (pure engine).
 *
 * ONE function answers "where do I stand for financial year X": what income is
 * assessable, what deductions are claimable, how they split business vs personal,
 * and therefore the ESTIMATED TAXABLE INCOME that the tax calculation is run on.
 *
 * It computes no tax. `estimatedTaxableIncome` is the number handed to
 * dataService.calculateTax() — keeping "what am I taxed on" (here, auditable,
 * drillable) separate from "how much tax is that" (brackets, Medicare, HECS).
 *
 * FINANCIAL YEAR: 1 July → 30 June, labelled "YYYY-YYYY" exactly as
 * format.financialYearOf() does. Every date is bucketed by string comparison
 * against the FY bounds, so 1 July and 30 June land on the right side of the
 * boundary regardless of the machine's time zone.
 *
 * IT DOES NOT DUPLICATE ANY EXISTING SYSTEM. It composes what Ledger already has:
 *   • deductions      → taxDeductions.buildDeductionView (merge, dedup, refunds)
 *   • employment income → payroll.employerTotalsForFY (YTD-preferring payslips)
 *   • other income    → the approved `income_entries` list
 *   • business income → transactions the user tagged entity='business'
 *   • transfers/refunds → transactionCore's canonical predicates
 *
 * DOUBLE COUNTING is prevented at every seam, and always by the same rule: when
 * two records describe one money event, the more explicit record wins and the
 * other stays VISIBLE but excluded, with a reason.
 *   • payslip-derived income entries (`reference_number` = "payslip:…") give way
 *     to the payslip totals they were created from
 *   • a business-income transaction that looks like an approved income entry
 *     (same cents, within 3 days, sharing a word) gives way to the entry
 *   • deductions are deduped inside buildDeductionView (explicit link, then
 *     heuristic duplicate) before they ever reach this module
 *
 * PURE — no store, no network, no localStorage. taxYearDS (dataService) gathers
 * the inputs; the Tax page renders the result.
 */

import type { Transaction, IncomeEntry } from '../types';
import { financialYearOf } from './format';
import { isTransferTransaction, isRefundTransaction, effectiveAmount } from './transactionCore';
import { employerTotalsForFY, normalizeEmployer, type PayslipCore } from './payroll';
import type { CapitalGainsPosition } from './capitalGains';
import type { RentalPosition } from './rentalProperty';
import {
  buildDividendPosition,
  type DividendIncomeCandidate,
  type DividendPosition,
  type DividendStatement,
} from './dividendIncome';
import {
  buildDeductionView,
  daysBetween,
  descriptionSimilar,
  normaliseEntity,
  DUP_DATE_WINDOW_DAYS,
  type DeductionEntity,
  type DeductionView,
  type ManualDeduction,
} from './taxDeductions';

// ─── Financial-year boundaries (1 July → 30 June) ────────────────────────────

/** The inclusive ISO bounds of an Australian FY label ("2024-2025"). */
export function fyBounds(fy: string): { start: string; end: string } {
  const startYear = Number(String(fy).split('-')[0]);
  if (!Number.isFinite(startYear)) {
    throw new Error(`Invalid financial year: ${fy}`);
  }
  return { start: `${startYear}-07-01`, end: `${startYear + 1}-06-30` };
}

/**
 * Whether a date falls in the FY. Compared as ISO strings against the 1 July /
 * 30 June bounds — no Date parsing, so no time-zone can shift a boundary date
 * into the neighbouring year. A timestamp is truncated to its date part.
 */
export function isDateInFY(date: string | null | undefined, fy: string): boolean {
  const day = (date ?? '').trim().slice(0, 10);
  if (day.length !== 10) return false;
  const { start, end } = fyBounds(fy);
  return day >= start && day <= end;
}

/** The FY label `n` years after `fy` (negative for earlier years). */
export function shiftFY(fy: string, n: number): string {
  const startYear = Number(String(fy).split('-')[0]) + n;
  return `${startYear}-${startYear + 1}`;
}

/** Human label: "2024-2025" → "2024–25". */
export function formatFY(fy: string): string {
  const [a, b] = String(fy).split('-');
  return b ? `${a}–${b.slice(2)}` : String(fy);
}

// ─── Income ──────────────────────────────────────────────────────────────────

/** Where one income line came from. */
export type IncomeSourceKind =
  | 'payslip'
  | 'entry'
  | 'transaction'
  /** The year's net capital gain, from the CGT engine (Phase 5.4). */
  | 'capital-gain'
  /** One dividend statement, from the dividend engine (Phase 5.4). */
  | 'dividend'
  /** One property's rent for the year, from the rental engine (Phase 5.5). */
  | 'rent';

/** Why an income line is shown but not counted. */
export type IncomeExclusionReason =
  | 'pending'                 // an income entry the user hasn't approved
  | 'counted-in-payslip'      // created from a payslip whose totals already count it
  | 'possible-duplicate'      // looks like the same money as an approved entry
  | 'refund'                  // money back on a purchase, not new income
  | 'transfer'                // internal movement between the user's own accounts
  | 'counted-in-income'       // a statement for cash an income line already counts
  | 'counted-in-rental'       // rent a property's own schedule already counts
  | 'future';                 // dated after today — it has not happened yet (M3)

export interface IncomeLine {
  /** Stable React key, namespaced by source so ids can't collide. */
  key: string;
  kind: IncomeSourceKind;
  /** Employer name, income entry id, or transaction id. */
  id: string;
  label: string;
  /** Income category ("Salary", "Dividends", …), not a deduction category. */
  category: string;
  date: string;
  /** Gross, always positive. */
  amount: number;
  /** PAYG withheld against this line (payslips and income entries carry it). */
  taxWithheld: number;
  entity: DeductionEntity;
  /** The backing transaction, when this line has one — for drill-down. */
  transactionId: string | null;
  excluded: boolean;
  excludedReason: IncomeExclusionReason | null;
  /** The id of the record that counts instead of this one. */
  duplicateOf: string | null;
  /** Free-text provenance shown under the line ("3 payslips", "pending", …). */
  detail: string | null;
}

export interface IncomeCategoryGroup {
  category: string;
  total: number;
  business: number;
  personal: number;
  lines: IncomeLine[];
}

export interface IncomeSummary {
  /** Assessable income: every counted line. */
  total: number;
  business: number;
  personal: number;
  /** PAYG already withheld across counted lines. */
  taxWithheld: number;
  /** Employment income (payslips) — the part with withholding behind it. */
  employment: number;
  groups: IncomeCategoryGroup[];
  lines: IncomeLine[];
  /** Lines shown but not counted, with their reason. */
  excluded: IncomeLine[];
  /** The dividend reconciliation, when statements were supplied (Phase 5.4). */
  dividends: DividendPosition | null;
  /** The rental schedule, when properties were supplied (Phase 5.5). Its gross
   *  rent is already among the lines above; this is the working behind it. */
  rental: RentalPosition | null;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Fallback category label for income with none recorded. */
export const UNCATEGORISED_INCOME = 'Other income';

/** The income category the year's net capital gain is grouped under. */
export const CAPITAL_GAIN_CATEGORY = 'Net capital gain';

/** The income category rent is grouped under, and the deduction category prefix
 *  every rental expense heading is filed against. */
export const RENT_CATEGORY = 'Rent';

function incomeCategoryOf(c?: string | null): string {
  const t = (c ?? '').trim();
  return t === '' ? UNCATEGORISED_INCOME : t;
}

/** True when an income entry was created from a payslip (see Income page). */
export function isPayslipLinkedEntry(e: Pick<IncomeEntry, 'reference_number'>): boolean {
  return /^payslip:/.test(e.reference_number || '');
}

/**
 * A transaction the user has explicitly tagged as BUSINESS income. Bank inflows
 * are never treated as income on the strength of their sign alone — Ledger's
 * income lives in `income_entries` and payslips — so only a row the user marked
 * `transaction_type='income'` AND `entity='business'` is picked up here. That is
 * the one case the other two sources cannot express: money earned by a business
 * that lands straight in the bank.
 */
export function isBusinessIncomeTransaction(t: Transaction): boolean {
  return (
    t.transaction_type === 'income' &&
    normaliseEntity(t.entity) === 'business' &&
    effectiveAmount(t) > 0
  );
}

/**
 * Whether a business-income transaction and an approved income entry look like
 * the same receipt. Same rule as the deduction duplicate detector: identical to
 * the cent, within DUP_DATE_WINDOW_DAYS, plus a corroborating signal (a shared
 * word between the entry's source and the transaction's merchant, or the same
 * category). Conservative by design — it flags for review rather than guessing.
 */
export function isLikelyDuplicateIncome(entry: IncomeEntry, t: Transaction): boolean {
  const amt = round2(Math.abs(entry.display_amount ?? entry.amount) || 0);
  if (amt === 0 || amt !== round2(Math.abs(effectiveAmount(t)))) return false;
  if (daysBetween(entry.date, t.date) > DUP_DATE_WINDOW_DAYS) return false;
  const sameCategory =
    incomeCategoryOf(entry.category).toLowerCase() === incomeCategoryOf(t.category).toLowerCase();
  return sameCategory || descriptionSimilar(entry.source, t.merchant);
}

function byDateDescThenLabel(a: IncomeLine, b: IncomeLine): number {
  if (a.date === b.date) return a.label.localeCompare(b.label);
  return a.date < b.date ? 1 : -1;
}

/**
 * Assemble every income line for one financial year, from all three sources,
 * with the double-count rules applied. Excluded lines are kept in the result so
 * the UI can explain what it left out and why.
 */
export function buildIncomeSummary(input: {
  fy: string;
  incomeEntries: IncomeEntry[];
  payslips: PayslipCore[];
  transactions: Transaction[];
  /** Ids of transactions that are internal transfers (from transactionCore). */
  excludeIds?: Set<string>;
  /** Phase 5.4 — the year's CGT position, already computed. */
  capitalGains?: CapitalGainsPosition | null;
  /** Phase 5.4 — dividend statements, reconciled against the lines above. */
  dividendStatements?: DividendStatement[];
  /** The single franking figure from the tax-paid card, for the supersede check. */
  manualFrankingCredit?: number;
  /** Phase 5.5 — the year's rental schedule, already computed. */
  rental?: RentalPosition | null;
  /** The day the position stops (M3). Lines dated after it have not happened. */
  asOf?: string;
}): IncomeSummary {
  const { fy, incomeEntries, payslips, transactions } = input;
  const opts = { excludeIds: input.excludeIds };
  const asOfDay = (input.asOf ?? '').trim().slice(0, 10);
  const isFuture = (date: string | null | undefined): boolean =>
    !!asOfDay && ((date ?? '').trim().slice(0, 10) > asOfDay);
  const lines: IncomeLine[] = [];

  // 1. Employment income — one line per employer, from the payslips in this FY.
  const employers = employerTotalsForFY(payslips, fy);
  for (const e of employers) {
    lines.push({
      key: `p:${e.employer}`,
      kind: 'payslip',
      id: e.employer,
      label: e.employer,
      category: 'Salary',
      date: e.latestDate ?? fyBounds(fy).end,
      amount: round2(e.gross),
      taxWithheld: round2(e.taxWithheld),
      entity: 'personal',
      transactionId: null,
      excluded: false,
      excludedReason: null,
      duplicateOf: null,
      detail: e.usedYtd
        ? `Year-to-date from ${e.payslipCount} payslip${e.payslipCount === 1 ? '' : 's'}`
        : `${e.payslipCount} payslip${e.payslipCount === 1 ? '' : 's'}`,
    });
  }
  const hasPayslipIncome = employers.length > 0;

  // 2. Income entries dated in this FY. Approved entries are the assessable ones;
  //    pending entries are listed but not counted (the user hasn't confirmed
  //    them). An entry created FROM a payslip is already inside the payslip total
  //    above, so it steps aside — unless no payslip survived to carry it.
  const entriesInFY = incomeEntries.filter(e => isDateInFY(e.date, fy));
  const countedEntries: IncomeEntry[] = [];
  for (const e of entriesInFY) {
    const amount = round2(Math.abs(e.display_amount ?? e.amount) || 0);
    const fromPayslip = isPayslipLinkedEntry(e);
    const pending = e.status !== 'approved';
    const supersededByPayslip = fromPayslip && hasPayslipIncome;
    const excludedReason: IncomeExclusionReason | null = supersededByPayslip
      ? 'counted-in-payslip'
      : pending
        ? 'pending'
        : isFuture(e.date)
          ? 'future'
          : null;
    if (!excludedReason) countedEntries.push(e);
    lines.push({
      key: `e:${e.id}`,
      kind: 'entry',
      id: e.id,
      label: e.source || 'Income',
      category: incomeCategoryOf(e.category),
      date: e.date,
      amount,
      taxWithheld: excludedReason ? 0 : round2(Math.abs(e.tax_withheld ?? 0)),
      // Income entries carry no entity field, so they are personal income. A
      // business receipt is recorded as a business-tagged transaction (below).
      entity: 'personal',
      transactionId: null,
      excluded: !!excludedReason,
      excludedReason,
      duplicateOf: supersededByPayslip
        ? (employers.find(x => normalizeEmployer(x.employer) === normalizeEmployer(e.source))?.employer ?? null)
        : null,
      detail: supersededByPayslip
        ? 'Already counted in payslip totals'
        : pending
          ? 'Pending — approve to include'
          : null,
    });
  }

  // 3. Business income the user tagged on a transaction. Transfers and refunds
  //    are never income; a receipt that also exists as an approved income entry
  //    is flagged and the transaction steps aside so it counts once.
  const businessTx = transactions
    .filter(t => isDateInFY(t.date, fy) && isBusinessIncomeTransaction(t))
    .sort((a, b) => (a.date === b.date ? a.id.localeCompare(b.id) : a.date < b.date ? -1 : 1));
  const claimedEntries = new Set<string>();
  for (const t of businessTx) {
    const amount = round2(Math.abs(effectiveAmount(t)));
    let excludedReason: IncomeExclusionReason | null = null;
    let duplicateOf: string | null = null;
    if (isTransferTransaction(t, opts)) {
      excludedReason = 'transfer';
    } else if (isRefundTransaction(t)) {
      excludedReason = 'refund';
    } else if (isFuture(t.date)) {
      excludedReason = 'future';
    } else {
      const dup = countedEntries.find(
        e => !claimedEntries.has(e.id) && isLikelyDuplicateIncome(e, t),
      );
      if (dup) {
        claimedEntries.add(dup.id);
        excludedReason = 'possible-duplicate';
        duplicateOf = dup.id;
      }
    }
    lines.push({
      key: `t:${t.id}`,
      kind: 'transaction',
      id: t.id,
      label: t.merchant?.trim() || 'Business income',
      category: incomeCategoryOf(t.category),
      date: t.date,
      amount,
      taxWithheld: 0,
      entity: 'business',
      transactionId: t.id,
      excluded: !!excludedReason,
      excludedReason,
      duplicateOf,
      detail: excludedReason === 'possible-duplicate'
        ? 'Looks like an income entry you already recorded'
        : 'Tagged as business income',
    });
  }

  // 4. RENT (Phase 5.5). One line per property, because that is how the return
  //    carries it — item 21 is a schedule per property, not a list of payments.
  //    The payments behind it drill down on the rental card.
  //
  //    Rent reaches Ledger as an ordinary bank credit, so the SAME money can
  //    already be in this list twice over: as a business-tagged income
  //    transaction, or as an approved income entry the user typed. The rental
  //    schedule is the more explicit record for rent — it knows the property,
  //    the ownership share and the private-use split, and it is where the ATO
  //    wants the figure — so those step aside VISIBLY and it counts instead.
  const rental = input.rental ?? null;
  if (rental) {
    const claimedTx = new Set(rental.claimedTransactionIds);
    for (const l of lines) {
      if (l.excluded || !l.transactionId || !claimedTx.has(l.transactionId)) continue;
      l.excluded = true;
      l.excludedReason = 'counted-in-rental';
      l.detail = 'Already counted on your rental schedule';
      l.taxWithheld = 0;
    }

    // An income ENTRY carries no transaction id, so the same conservative
    // duplicate test the rest of this file uses decides it: identical to the
    // cent, within DUP_DATE_WINDOW_DAYS, and corroborated by the word "rent" or
    // the property's own name. Each entry can be claimed by one payment only.
    const claimedEntries = new Set<string>();
    for (const p of rental.properties) {
      if (!p.inSchedule) continue;
      for (const pay of p.rentPayments) {
        const hit = lines.find(l =>
          l.kind === 'entry' && !l.excluded && !claimedEntries.has(l.key)
          && round2(l.amount) === round2(pay.amount)
          && daysBetween(l.date, pay.date) <= DUP_DATE_WINDOW_DAYS
          && (/\brent\b/i.test(`${l.category} ${l.label}`) || descriptionSimilar(l.label, p.label)));
        if (!hit) continue;
        claimedEntries.add(hit.key);
        hit.excluded = true;
        hit.excludedReason = 'counted-in-rental';
        hit.detail = `Already counted as rent on ${p.label}`;
        hit.taxWithheld = 0;
      }
    }

    for (const p of rental.properties) {
      if (!p.inSchedule || p.income === 0) continue;
      lines.push({
        key: `rp:${p.id}`,
        kind: 'rent',
        id: p.id,
        label: p.label,
        category: RENT_CATEGORY,
        date: fyBounds(fy).end,
        amount: p.income,
        taxWithheld: 0,
        entity: 'personal',
        transactionId: null,
        excluded: false,
        excludedReason: null,
        duplicateOf: null,
        detail: p.vacantMonths > 0
          ? `Rent received — ${p.vacantMonths} of ${p.monthsOwned} months brought nothing in`
          : 'Rent received this year',
      });
    }
  }

  // 5. Dividend statements (Phase 5.4). The statement is the more explicit record
  //    for the FRANKING CREDIT, but the income line is the more explicit record
  //    for the CASH — it is what the bank actually paid. So a statement that
  //    matches a line above steps aside and contributes only its credit, and one
  //    that matches nothing adds its cash, because otherwise that dividend is
  //    taxed nowhere at all.
  const dividends = (input.dividendStatements && input.dividendStatements.length > 0)
    || (input.manualFrankingCredit ?? 0) > 0
    ? buildDividendPosition({
        fy,
        statements: input.dividendStatements ?? [],
        incomeLines: lines
          .filter(l => !l.excluded)
          .map((l): DividendIncomeCandidate => ({
            key: l.key,
            label: l.label,
            category: l.category,
            date: l.date,
            amount: l.amount,
            excluded: false,
          })),
        manualFrankingCredit: input.manualFrankingCredit,
      })
    : null;

  for (const d of dividends?.lines ?? []) {
    lines.push({
      key: d.key,
      kind: 'dividend',
      id: d.statementId,
      label: d.label,
      category: 'Dividends',
      date: d.date,
      amount: d.cash,
      taxWithheld: d.addsIncome ? d.withheld : 0,
      entity: 'personal',
      transactionId: null,
      excluded: !d.addsIncome,
      excludedReason: d.addsIncome ? null : 'counted-in-income',
      duplicateOf: d.matchedIncomeKey,
      detail: d.addsIncome
        ? 'Dividend statement — not recorded as income anywhere else'
        : `Already counted as ${d.matchedIncomeLabel ?? 'income'}`,
    });
  }

  // 6. The year's NET capital gain (Phase 5.4) — one line, because that is how
  //    the return carries it: label A at question 18, after losses and after the
  //    discount. The disposals behind it drill down on their own card, where the
  //    working can actually be shown.
  const cg = input.capitalGains ?? null;
  if (cg && cg.netCapitalGain > 0) {
    lines.push({
      key: 'cg:net',
      kind: 'capital-gain',
      id: cg.fy,
      label: 'Net capital gain',
      category: CAPITAL_GAIN_CATEGORY,
      date: fyBounds(fy).end,
      amount: cg.netCapitalGain,
      taxWithheld: 0,
      entity: 'personal',
      transactionId: null,
      excluded: false,
      excludedReason: null,
      duplicateOf: null,
      detail: cg.events.length === 1
        ? '1 disposal, after losses and the CGT discount'
        : `${cg.events.length} disposals, after losses and the CGT discount`,
    });
  }

  // Totals — an excluded line contributes nothing, anywhere.
  const sum = (ls: IncomeLine[], pick: (l: IncomeLine) => boolean = () => true) =>
    round2(ls.reduce((s, l) => s + (l.excluded || !pick(l) ? 0 : l.amount), 0));

  const byCat = new Map<string, IncomeLine[]>();
  for (const l of lines) {
    const arr = byCat.get(l.category);
    if (arr) arr.push(l);
    else byCat.set(l.category, [l]);
  }
  const groups: IncomeCategoryGroup[] = [...byCat.entries()]
    .map(([category, ls]) => ({
      category,
      total: sum(ls),
      business: sum(ls, l => l.entity === 'business'),
      personal: sum(ls, l => l.entity === 'personal'),
      lines: ls.slice().sort(byDateDescThenLabel),
    }))
    .sort((a, b) => b.total - a.total || a.category.localeCompare(b.category));

  return {
    total: sum(lines),
    business: sum(lines, l => l.entity === 'business'),
    personal: sum(lines, l => l.entity === 'personal'),
    taxWithheld: round2(lines.reduce((s, l) => s + (l.excluded ? 0 : l.taxWithheld), 0)),
    employment: sum(lines, l => l.kind === 'payslip'),
    groups,
    lines: lines.slice().sort(byDateDescThenLabel),
    excluded: lines.filter(l => l.excluded).sort(byDateDescThenLabel),
    dividends,
    rental,
  };
}

// ─── The FY position ─────────────────────────────────────────────────────────

/** Something the user should look at before treating the position as final. */
export interface TaxYearNote {
  kind: 'duplicate' | 'pending-income' | 'recouped' | 'no-income' | 'uncategorised'
    | 'capital-loss' | 'rental-loss';
  /**
   * Plain text, deliberately free of dollar figures — the engine doesn't know the
   * user's display currency. A money amount belongs in `amount`, for the UI to
   * format.
   */
  message: string;
  /** How many records the note is about. */
  count: number;
  /** The sum at stake, when the note has one. */
  amount?: number;
}

export interface DeductionCategorySummary {
  category: string;
  total: number;
  business: number;
  personal: number;
  lineCount: number;
  /** Share of total deductions, 0–100. */
  share: number;
}

export interface TaxYearPosition {
  fy: string;
  /** 1 July, inclusive. */
  start: string;
  /** 30 June, inclusive. */
  end: string;
  income: IncomeSummary;
  /**
   * Phase 5.4 — the year's CGT working, when disposals were supplied. Its
   * `netCapitalGain` is already inside `income` as a line; this is the audit
   * trail behind that one number.
   */
  capitalGains: CapitalGainsPosition | null;
  /**
   * Phase 5.5 — the year's rental schedule, when properties were supplied. Its
   * gross rent is already an income line and its deductions are already inside
   * `deductions`; this is the per-property working behind both.
   */
  rental: RentalPosition | null;
  /** The full merged deduction view — the drill-down source for every line. */
  deductions: DeductionView;
  /** Deduction categories, largest first, with their entity split. */
  deductionCategories: DeductionCategorySummary[];
  /** Assessable income for the year (income.total). */
  assessableIncome: number;
  /** Claimable deductions for the year, net of refunds (deductions.total). */
  deductibleExpenses: number;
  /**
   * ESTIMATED TAXABLE INCOME — assessable income less deductions, floored at 0.
   * This is the figure the tax calculation takes; no tax is computed here.
   */
  estimatedTaxableIncome: number;
  /** PAYG already withheld this year (payslips + income entries). */
  taxWithheld: number;
  business: { income: number; deductions: number; net: number };
  personal: { income: number; deductions: number; net: number };
  notes: TaxYearNote[];
}

/**
 * Build the whole position for one financial year. Every input is optional-safe:
 * an empty year returns a zeroed position rather than throwing, so the page can
 * render before payslips have loaded.
 */
export function buildTaxYearPosition(input: {
  fy: string;
  transactions: Transaction[];
  manualDeductions: ManualDeduction[];
  incomeEntries: IncomeEntry[];
  payslips: PayslipCore[];
  excludeIds?: Set<string>;
  /** Phase 5.4 — the year's CGT position, already rolled forward. */
  capitalGains?: CapitalGainsPosition | null;
  /** Phase 5.4 — dividend statements to reconcile against the income lines. */
  dividendStatements?: DividendStatement[];
  /** The franking figure on the tax-paid card, so statements can supersede it. */
  manualFrankingCredit?: number;
  /** Phase 5.5 — the year's rental schedule, already computed. */
  rental?: RentalPosition | null;
  /**
   * The day the position is read (M3). The position STOPS here: a future-dated
   * transaction, entry or deduction is listed flagged and counted nothing —
   * money not yet spent is not yet claimable, and money not yet received is not
   * yet income. Omitted, nothing is clamped (a settled past year).
   */
  asOf?: string;
}): TaxYearPosition {
  const { fy, transactions, manualDeductions, incomeEntries, payslips } = input;
  const { start, end } = fyBounds(fy);
  const capitalGains = input.capitalGains ?? null;
  const rental = input.rental ?? null;

  const income = buildIncomeSummary({
    fy,
    incomeEntries,
    payslips,
    transactions,
    excludeIds: input.excludeIds,
    capitalGains,
    dividendStatements: input.dividendStatements,
    manualFrankingCredit: input.manualFrankingCredit,
    rental,
    asOf: input.asOf,
  });

  // Phase 5.5 — the rental schedule's expenses are folded into the ONE deduction
  // view rather than kept beside it, so `deductions.total` is still the whole
  // claim and nothing downstream (the estimate, the settlement, the entity
  // split) needs to know rent exists. The payments it has already claimed are
  // suppressed here, so a strata levy the user also ticked "tax deductible" is
  // counted once — at the rental line's rate, not the tick box's.
  const deductions = buildDeductionView({
    transactions,
    manualDeductions,
    fy,
    asOf: input.asOf,
    claimedByRental: new Set(rental?.claimedTransactionIds ?? []),
    externalLines: (rental?.properties ?? [])
      .filter(p => p.inSchedule)
      .flatMap(p => p.deductions
        .filter(line => line.claimed > 0)
        .map(line => ({
          id: line.key,
          name: `${line.label} — ${p.label}`,
          category: `${RENT_CATEGORY}: ${line.label}`,
          netAmount: line.claimed,
          date: end,
          entity: 'personal' as const,
          transactionId: null,
        }))),
  });

  const deductionCategories: DeductionCategorySummary[] = deductions.groups.map(g => ({
    category: g.category,
    total: g.total,
    business: g.business,
    personal: g.personal,
    lineCount: g.lines.filter(l => !l.excluded).length,
    share: deductions.total > 0 ? round2((g.total / deductions.total) * 100) : 0,
  }));

  const assessableIncome = income.total;
  const deductibleExpenses = deductions.total;
  const estimatedTaxableIncome = round2(Math.max(0, assessableIncome - deductibleExpenses));

  const notes: TaxYearNote[] = [];
  if (deductions.suspectedDuplicates.length > 0) {
    notes.push({
      kind: 'duplicate',
      count: deductions.suspectedDuplicates.length,
      message:
        `${deductions.suspectedDuplicates.length} deduction${deductions.suspectedDuplicates.length === 1 ? '' : 's'} ` +
        'may have been entered twice — each is counted once until you review it.',
    });
  }
  const duplicateIncome = income.excluded.filter(l => l.excludedReason === 'possible-duplicate');
  if (duplicateIncome.length > 0) {
    notes.push({
      kind: 'duplicate',
      count: duplicateIncome.length,
      message:
        `${duplicateIncome.length} business income transaction${duplicateIncome.length === 1 ? '' : 's'} ` +
        'looks like income you already recorded — counted once.',
    });
  }
  const pendingIncome = income.excluded.filter(l => l.excludedReason === 'pending');
  if (pendingIncome.length > 0) {
    notes.push({
      kind: 'pending-income',
      count: pendingIncome.length,
      amount: round2(pendingIncome.reduce((s, l) => s + l.amount, 0)),
      message: pendingIncome.length === 1
        ? 'A pending income entry is not in this estimate — approve it to include it.'
        : `${pendingIncome.length} pending income entries are not in this estimate — approve them to include them.`,
    });
  }
  if (deductions.recoupedFromOtherFY.length > 0) {
    notes.push({
      kind: 'recouped',
      count: deductions.recoupedFromOtherFY.length,
      amount: round2(deductions.recoupedFromOtherFY.reduce((s, r) => s + r.amount, 0)),
      message:
        (deductions.recoupedFromOtherFY.length === 1
          ? 'A refund received this year reverses an expense claimed in an earlier year.'
          : `${deductions.recoupedFromOtherFY.length} refunds received this year reverse expenses claimed in earlier years.`) +
        ' Earlier years are left untouched — this may need declaring in this one.',
    });
  }
  if (assessableIncome === 0 && deductibleExpenses > 0) {
    notes.push({
      kind: 'no-income',
      count: 0,
      message:
        'No income recorded for this year, so deductions have nothing to reduce. ' +
        'Add payslips or income entries for a complete position.',
    });
  }
  if (capitalGains && capitalGains.netCapitalGain === 0 && capitalGains.carriedForwardTotal > 0) {
    notes.push({
      kind: 'capital-loss',
      count: capitalGains.events.length,
      amount: capitalGains.carriedForwardTotal,
      message:
        'This year made a net capital loss. It cannot reduce your other income, so nothing was ' +
        'added here — it carries forward against future capital gains:',
    });
  }
  if (rental && rental.netRentalLoss > 0) {
    notes.push({
      kind: 'rental-loss',
      count: rental.properties.filter(p => p.inSchedule).length,
      amount: rental.netRentalLoss,
      message:
        'Your properties cost more than they earned this year. A net rental loss DOES reduce your other ' +
        'income, so it is already in this estimate — but it is added back for study loan repayments, ' +
        'the Medicare levy surcharge and the seniors offset:',
    });
  }
  const uncategorised = deductionCategories.find(c => c.category === 'Uncategorised');
  if (uncategorised && uncategorised.total > 0) {
    notes.push({
      kind: 'uncategorised',
      count: uncategorised.lineCount,
      message:
        `${uncategorised.lineCount} deduction${uncategorised.lineCount === 1 ? '' : 's'} ` +
        'has no category — assign one so the claim lands in the right place.',
    });
  }

  return {
    fy,
    start,
    end,
    income,
    capitalGains,
    rental,
    deductions,
    deductionCategories,
    assessableIncome,
    deductibleExpenses,
    estimatedTaxableIncome,
    taxWithheld: income.taxWithheld,
    business: {
      income: income.business,
      deductions: deductions.businessTotal,
      net: round2(income.business - deductions.businessTotal),
    },
    personal: {
      income: income.personal,
      deductions: deductions.personalTotal,
      net: round2(income.personal - deductions.personalTotal),
    },
    notes,
  };
}

/**
 * Every financial year that has anything in it — income, a payslip, a deductible
 * transaction or a manual deduction — newest first. The FY switcher's options.
 */
export function availableTaxYears(input: {
  transactions: Transaction[];
  manualDeductions: ManualDeduction[];
  incomeEntries: IncomeEntry[];
  payslips: PayslipCore[];
  /** Phase 5.4 — sale dates and dividend payment dates, so a year with nothing
   *  but investment activity in it still appears in the switcher. */
  extraDates?: (string | null | undefined)[];
}): string[] {
  const set = new Set<string>();
  const add = (date?: string | null) => {
    const day = (date ?? '').trim().slice(0, 10);
    if (day.length === 10) set.add(financialYearOf(day));
  };
  for (const t of input.transactions) {
    if (t.is_tax_deductible === true || isBusinessIncomeTransaction(t)) add(t.date);
  }
  for (const d of input.manualDeductions) add(d.date);
  for (const e of input.incomeEntries) add(e.date);
  for (const p of input.payslips) add(p.payment_date ?? p.pay_period_end);
  for (const d of input.extraDates ?? []) add(d);
  return [...set].sort().reverse();
}
