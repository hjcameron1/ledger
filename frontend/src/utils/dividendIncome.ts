/**
 * Phase 5.4 — DIVIDENDS AND FRANKING CREDITS (pure engine).
 *
 * A franked dividend is one payment described by two records that Ledger already
 * holds in different places, and the whole job of this module is to make sure it
 * is counted ONCE:
 *
 *   • the CASH that hit the bank — which Ledger sees as an income entry, or a
 *     transaction the user categorised as dividends;
 *   • the STATEMENT the registry sent — which carries the franked and unfranked
 *     split and the franking credit, and never appears in a bank feed at all.
 *
 * FRANKING CREDITS ARE NOT FREE MONEY, and Phase 5.2 already said so: a credit is
 * company tax paid on the shareholder's behalf, so it is added to assessable
 * income (the gross-up) AND credited against the bill. What 5.2 could not do was
 * show the working — it took one lump figure for the year with nothing behind it.
 * A statement list is that working, and it supersedes the lump figure rather than
 * being added to it.
 *
 * THE ANTI-DOUBLE-COUNT RULE IS THE ONE THE REST OF LEDGER ALREADY USES: when two
 * records describe one money event, the MORE EXPLICIT record wins and the other
 * stays visible but excluded, with a reason.
 *
 *   • statement vs manual franking total  → the statements win; the manual figure
 *     is reported as superseded, never added on top.
 *   • statement vs an income line for the same cash → the INCOME LINE wins, because
 *     it is what the bank actually paid and it is already inside assessable income.
 *     The statement then contributes only its franking credit.
 *   • statement with no income line behind it → the cash is not in assessable
 *     income anywhere, so the statement adds it. Leaving it out would understate
 *     income and overstate the refund, which is the one direction Ledger never errs.
 *
 * The match is the same conservative shape as the deduction and business-income
 * detectors: the cash must agree to the cent, the dates must be close, and there
 * must be a corroborating signal — a shared word, a matching ticker, or a
 * dividend category. It flags rather than guesses.
 *
 * FOREIGN TAX IS NOT AUSTRALIAN TAX. A dividend taxed at source overseas carries
 * `foreignTaxPaid`, which is kept apart from `withheld` all the way through: the
 * Australian figure is a PAYG credit, the foreign one is a capped, non-refundable
 * FOREIGN INCOME TAX OFFSET worked out in utils/foreignIncomeTax.ts. The gross
 * dividend is assessable either way, so a bank deposit that is net of the tax is
 * grossed back up rather than quietly costing the user the difference.
 *
 * ONE CURRENCY. A statement has no currency field and this module invents none:
 * every figure on it is taken to be in the currency the return is prepared in,
 * exactly as the label on the input says. A US statement is entered converted —
 * which is what the ATO asks for anyway — and nothing here guesses a rate, a
 * country or an exchange from a ticker.
 *
 * NOT MODELLED, and stated rather than assumed: the 45-day holding period rule
 * (with its $5,000 small-shareholder exemption) that can deny a franking credit,
 * conduit foreign income, listed investment company capital gain deductions, and
 * dividend reinvestment plans as anything other than a cash dividend followed by
 * an acquisition.
 *
 * PURE — no store, no network, no localStorage.
 */

import { financialYearOf } from './format';
import { daysBetween, descriptionSimilar } from './taxDeductions';

/** A registry statement, entered from the paper. Every figure is an actual dollar. */
export interface DividendStatement {
  id: string;
  /** The holding it came from, when the user linked one. */
  investmentId: string | null;
  label: string;
  ticker: string | null;
  /** Date the dividend was paid — the date that decides the financial year. */
  paymentDate: string;
  /** The franked portion of the cash dividend. */
  frankedAmount: number;
  /** The unfranked portion of the cash dividend. */
  unfrankedAmount: number;
  /** The imputation credit shown on the statement. */
  frankingCredit: number;
  /**
   * AUSTRALIAN tax withheld — the TFN amounts a registry takes when no tax file
   * number was quoted. It is a PAYG credit: refundable, uncapped, dollar for
   * dollar against the bill.
   */
  withheld: number;
  /**
   * FOREIGN tax withheld at source, on a dividend paid by a company overseas.
   *
   * IT IS NOT THE SAME THING AS THE FIELD ABOVE, and treating it as if it were
   * is the error this field exists to end. Australian withholding is money the
   * ATO already holds; foreign withholding is money another country's revenue
   * holds, and Australia credits it only through the FOREIGN INCOME TAX OFFSET —
   * non-refundable, and capped at the Australian tax the foreign income actually
   * attracted (with a $1,000 floor). Crediting it as PAYG overstates the refund
   * by the whole amount whenever the cap or the floor would have bitten.
   */
  foreignTaxPaid: number;
  /**
   * The country whose tax was withheld, when the statement says. Optional, and
   * NEVER INFERRED — a ticker on a US exchange does not make the payer American,
   * and the offset does not need the answer to be computed. It belongs on the
   * supplementary section of the return, so an unknown one is named, not guessed.
   */
  sourceCountry: string | null;
}

/**
 * How wide the payment-date window is when matching a statement to the cash. Wider
 * than the deduction detector's three days: a registry pays on one date and the
 * money can take most of a week to clear, especially across a weekend.
 */
export const DIVIDEND_DATE_WINDOW_DAYS = 10;

/**
 * The highest company tax rate a franking credit can be struck at. A credit above
 * `franked × 30/70` cannot be right, whatever the statement says.
 */
export const MAX_FRANKING_RATE = 0.3;

/** Income already counted for the year, as much of it as the matcher needs. */
export interface DividendIncomeCandidate {
  key: string;
  label: string;
  category: string;
  date: string;
  amount: number;
  excluded: boolean;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function amount(v: unknown): number {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
  return Number.isFinite(n) && n > 0 ? round2(n) : 0;
}

/** Categories Ledger uses for dividend income, however the user cased them. */
const DIVIDEND_CATEGORIES = new Set(['dividends', 'dividend', 'dividend income', 'distributions']);

export function isDividendCategory(category: string | null | undefined): boolean {
  return DIVIDEND_CATEGORIES.has(String(category ?? '').trim().toLowerCase());
}

export function emptyDividendStatement(): Omit<DividendStatement, 'id'> {
  return {
    investmentId: null,
    label: '',
    ticker: null,
    paymentDate: '',
    frankedAmount: 0,
    unfrankedAmount: 0,
    frankingCredit: 0,
    withheld: 0,
    foreignTaxPaid: 0,
    sourceCountry: null,
  };
}

/** Coerce whatever came out of storage or a form. Bad values read as nothing. */
export function normaliseDividendStatement(raw: unknown, id: string): DividendStatement {
  const src = (raw ?? {}) as Record<string, unknown>;
  const day = String(src.paymentDate ?? '').trim().slice(0, 10);
  return {
    id,
    investmentId: typeof src.investmentId === 'string' && src.investmentId ? src.investmentId : null,
    label: String(src.label ?? '').trim() || 'Dividend',
    ticker: typeof src.ticker === 'string' && src.ticker.trim() ? src.ticker.trim().toUpperCase() : null,
    paymentDate: /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : '',
    frankedAmount: amount(src.frankedAmount),
    unfrankedAmount: amount(src.unfrankedAmount),
    frankingCredit: amount(src.frankingCredit),
    withheld: amount(src.withheld),
    foreignTaxPaid: amount(src.foreignTaxPaid),
    sourceCountry: typeof src.sourceCountry === 'string' && src.sourceCountry.trim()
      ? src.sourceCountry.trim()
      : null,
  };
}

/**
 * The GROSS dividend — franked plus unfranked, before any credit and before any
 * tax was taken out of it. This is the assessable amount: a statement reports
 * what the company declared, and tax withheld from it does not stop it being
 * income.
 */
export function cashDividendOf(s: Pick<DividendStatement, 'frankedAmount' | 'unfrankedAmount'>): number {
  return round2(amount(s.frankedAmount) + amount(s.unfrankedAmount));
}

/**
 * What actually reached the bank: the gross dividend less any tax taken out of
 * it at source, Australian or foreign.
 *
 * The distinction matters for MATCHING, not for tax. A statement showing a $450
 * dividend with $79.41 withheld is a $370.59 deposit, and a matcher that only
 * knows the gross figure will never find it — so it declares the cash unrecorded
 * and adds it a second time on top of the deposit already sitting in income.
 */
export function netDividendOf(
  s: Pick<DividendStatement, 'frankedAmount' | 'unfrankedAmount' | 'withheld' | 'foreignTaxPaid'>,
): number {
  return round2(Math.max(0, cashDividendOf(s) - amount(s.withheld) - amount(s.foreignTaxPaid)));
}

/**
 * The largest franking credit a franked amount can carry, at the 30% company
 * rate. A base rate entity franks at 25%, which produces less — so this is a
 * ceiling, not an expectation, and a statement below it is not an error.
 */
export function maxFrankingCreditFor(frankedAmount: number): number {
  return round2(amount(frankedAmount) * (MAX_FRANKING_RATE / (1 - MAX_FRANKING_RATE)));
}

/**
 * Whether a statement and an income line describe the same payment. Cash to the
 * cent, dates within the window, plus one corroborating signal — the line is
 * categorised as dividends, its label shares a word with the holding, or it
 * names the ticker.
 */
export function isLikelySameDividend(
  statement: DividendStatement,
  line: DividendIncomeCandidate,
): boolean {
  const cash = cashDividendOf(statement);
  if (cash === 0) return false;
  // The deposit is the gross dividend when nothing was withheld from it, and the
  // net when something was. Both are accepted: which one the bank shows is not
  // something the user should have to reconcile by hand.
  const paid = round2(Math.abs(line.amount) || 0);
  const net = netDividendOf(statement);
  if (paid !== cash && paid !== net) return false;
  if (!statement.paymentDate) return false;
  if (daysBetween(statement.paymentDate, line.date) > DIVIDEND_DATE_WINDOW_DAYS) return false;
  if (isDividendCategory(line.category)) return true;
  if (statement.ticker && line.label.toUpperCase().includes(statement.ticker)) return true;
  return descriptionSimilar(statement.label, line.label);
}

// ─── The financial-year position ────────────────────────────────────────────

/** One statement, resolved against what the income summary already counts. */
export interface DividendLine {
  key: string;
  statementId: string;
  investmentId: string | null;
  label: string;
  ticker: string | null;
  date: string;
  frankedAmount: number;
  unfrankedAmount: number;
  /** Franked plus unfranked — the dividend before any tax was taken out of it. */
  cash: number;
  /** Cash less tax withheld at source — the deposit the bank actually shows. */
  netReceived: number;
  frankingCredit: number;
  /** Australian (TFN) withholding: a PAYG credit. */
  withheld: number;
  /** Foreign tax withheld at source: an OFFSET, never a PAYG credit. */
  foreignTaxPaid: number;
  sourceCountry: string | null;
  /** True when any foreign tax was withheld — this is foreign-source income. */
  foreign: boolean;
  /** Cash plus the credit — what the ATO assesses. */
  grossedUp: number;
  /** The income line already carrying this cash, when one was found. */
  matchedIncomeKey: string | null;
  matchedIncomeLabel: string | null;
  /** True when nothing else counts this cash, so the statement has to. */
  addsIncome: boolean;
  /**
   * True when the income line behind this statement is the NET deposit. The tax
   * taken out at source never reached the bank and so is not in that line, but
   * it is assessable income all the same — see `addedIncome`.
   */
  matchedNet: boolean;
  /**
   * What this line actually contributes to assessable income: the whole gross
   * dividend when nothing else counts it, the tax withheld at source when the
   * income line only carries the net deposit, and nothing when the gross is
   * already counted elsewhere.
   */
  addedIncome: number;
  /** Set when the credit exceeds what a 30%-franked dividend could carry. */
  overFrankedBy: number | null;
}

export type DividendWarningKind =
  /** Statements supersede the single franking figure typed into the credits card. */
  | 'manual-franking-superseded'
  /** A statement's cash is not in assessable income anywhere, so it was added. */
  | 'cash-not-in-income'
  /** A statement's cash was found in the income summary — counted once. */
  | 'matched-to-income'
  /** A franking credit larger than a 30% franked dividend can produce. */
  | 'over-franked'
  /** A statement with no payment date belongs to no financial year. */
  | 'undated-statement'
  /** Dividend income is recorded for the year but no statement explains it. */
  | 'income-without-statement'
  /** A matched statement carries TFN withholding that nothing is crediting. */
  | 'withholding-not-credited'
  /** Foreign tax was withheld: an offset, not a credit, and it is capped. */
  | 'foreign-tax-offset'
  /** Foreign tax with no country named — needed on the return, not for the sum. */
  | 'foreign-tax-country-unknown'
  /** A matched deposit was net of tax; the difference was added back to income. */
  | 'grossed-up-to-statement';

export interface DividendWarning {
  kind: DividendWarningKind;
  severity: 'warn' | 'info';
  message: string;
  amount?: number;
  count?: number;
}

export interface DividendPosition {
  fy: string;
  lines: DividendLine[];
  /** Totals across every statement dated in the year. */
  frankedAmount: number;
  unfrankedAmount: number;
  cashDividends: number;
  frankingCredit: number;
  /** AUSTRALIAN withholding only — the part that is a PAYG credit. */
  withheld: number;
  /**
   * Foreign tax withheld at source. NOT included in `withheld`, and never added
   * to PAYG: it is claimed as a foreign income tax offset, which is capped and
   * non-refundable. See utils/foreignIncomeTax.ts.
   */
  foreignTaxPaid: number;
  /** Gross foreign-source dividends for the year — the offset cap's base. */
  foreignIncome: number;
  /** Cash plus credits — the figure the ATO assesses across all statements. */
  grossedUpTotal: number;
  /**
   * Cash from statements that NOTHING else in the year counts. This is the only
   * amount the FY position adds; everything already in the income summary stays
   * exactly where it is.
   */
  additionalAssessableIncome: number;
  /** The manual franking figure the statements replaced, when there was one. */
  supersededManualFranking: number | null;
  /** The franking credit to use — from statements when there are any. */
  effectiveFrankingCredit: number;
  warnings: DividendWarning[];
}

/**
 * Build the year's dividend position.
 *
 * `incomeLines` is what the FY income summary already counts. Nothing here
 * changes those lines; the position only reports which of them a statement is
 * standing behind, and adds the cash that no line covers.
 */
export function buildDividendPosition(input: {
  fy: string;
  statements: DividendStatement[];
  /** Income already counted for this year, for the double-count check. */
  incomeLines?: DividendIncomeCandidate[];
  /** The single franking figure from the tax-credits card, if any. */
  manualFrankingCredit?: number;
}): DividendPosition {
  const { fy } = input;
  const statements = input.statements
    .filter(s => s.paymentDate && financialYearOf(s.paymentDate) === fy)
    .slice()
    .sort((a, b) => (a.paymentDate === b.paymentDate
      ? a.label.localeCompare(b.label)
      : a.paymentDate < b.paymentDate ? 1 : -1));

  const undated = input.statements.filter(s => !s.paymentDate).length;
  const candidates = (input.incomeLines ?? []).filter(l => !l.excluded);
  const claimed = new Set<string>();

  const lines: DividendLine[] = statements.map(s => {
    const cash = cashDividendOf(s);
    const net = netDividendOf(s);
    const credit = amount(s.frankingCredit);
    const foreignTaxPaid = amount(s.foreignTaxPaid);
    const match = candidates.find(l => !claimed.has(l.key) && isLikelySameDividend(s, l));
    if (match) claimed.add(match.key);
    // Which figure the matched line carries. It only differs when tax was taken
    // out at source, and then only the net could have reached the bank.
    const matchedNet = !!match && net < cash && round2(Math.abs(match.amount) || 0) === net;
    const ceiling = maxFrankingCreditFor(s.frankedAmount);
    const addsIncome = !match && cash > 0;
    return {
      key: `d:${s.id}`,
      statementId: s.id,
      investmentId: s.investmentId,
      label: s.label,
      ticker: s.ticker,
      date: s.paymentDate,
      frankedAmount: amount(s.frankedAmount),
      unfrankedAmount: amount(s.unfrankedAmount),
      cash,
      netReceived: net,
      frankingCredit: credit,
      withheld: amount(s.withheld),
      foreignTaxPaid,
      sourceCountry: s.sourceCountry ?? null,
      foreign: foreignTaxPaid > 0,
      grossedUp: round2(cash + credit),
      matchedIncomeKey: match?.key ?? null,
      matchedIncomeLabel: match?.label ?? null,
      addsIncome,
      matchedNet,
      // Tax withheld at source is assessable income that never reached the bank,
      // so a matched NET deposit is short by exactly that much. Adding the
      // difference is the gross-up — the same rule franking credits already
      // follow, applied to the money another revenue office is holding.
      addedIncome: addsIncome ? cash : matchedNet ? round2(cash - net) : 0,
      overFrankedBy: credit > round2(ceiling + 0.01) ? round2(credit - ceiling) : null,
    };
  });

  const sum = (pick: (l: DividendLine) => number) => round2(lines.reduce((s, l) => s + pick(l), 0));

  const frankingCredit = sum(l => l.frankingCredit);
  const additionalAssessableIncome = sum(l => l.addedIncome);
  const foreignTaxPaid = sum(l => l.foreignTaxPaid);
  // The foreign-source income the offset is measured against: the GROSS dividend
  // on every statement that had foreign tax taken out of it, whether the cash is
  // counted here or by an income line. The cap asks how much Australian tax the
  // foreign income attracted — a question about the income, not about which
  // record happens to carry it.
  const foreignIncome = round2(
    lines.filter(l => l.foreign).reduce((s, l) => s + l.cash, 0),
  );

  const manual = amount(input.manualFrankingCredit);
  const hasStatements = lines.length > 0;
  const supersededManualFranking = hasStatements && manual > 0 ? manual : null;
  const effectiveFrankingCredit = hasStatements ? frankingCredit : manual;

  // ── What the user should know ────────────────────────────────────────────
  const warnings: DividendWarning[] = [];
  if (supersededManualFranking != null) {
    warnings.push({
      kind: 'manual-franking-superseded',
      severity: supersededManualFranking === frankingCredit ? 'info' : 'warn',
      amount: supersededManualFranking,
      message:
        'Your statements replace the single franking figure entered on the tax-paid card — ' +
        'they are not added together. The figure they replaced was:',
    });
  }
  const added = lines.filter(l => l.addsIncome);
  if (added.length > 0) {
    warnings.push({
      kind: 'cash-not-in-income',
      severity: 'info',
      count: added.length,
      amount: round2(added.reduce((s, l) => s + l.addedIncome, 0)),
      message:
        `${added.length} dividend${added.length === 1 ? '' : 's'} on your statements ` +
        (added.length === 1 ? 'is' : 'are') +
        " not recorded as income anywhere else, so the cash was added to this year's income:",
    });
  }
  const matched = lines.filter(l => l.matchedIncomeKey);
  if (matched.length > 0) {
    warnings.push({
      kind: 'matched-to-income',
      severity: 'info',
      count: matched.length,
      amount: round2(matched.reduce((s, l) => s + l.cash, 0)),
      message:
        `${matched.length} statement${matched.length === 1 ? '' : 's'} matched income you already ` +
        'recorded, so only the franking credit was added on top of it:',
    });
  }
  // ── Foreign tax, said plainly, because it is the one thing here that does NOT
  //    behave like the money beside it ────────────────────────────────────────
  if (foreignTaxPaid > 0) {
    const foreignLines = lines.filter(l => l.foreign);
    warnings.push({
      kind: 'foreign-tax-offset',
      severity: 'info',
      count: foreignLines.length,
      amount: foreignTaxPaid,
      message:
        'Tax withheld overseas is not Australian withholding and is not credited against your bill ' +
        'dollar for dollar. It is claimed as a foreign income tax offset, which is capped at the ' +
        'Australian tax the foreign income attracted and is not refunded if it is worth more:',
    });
    const unnamed = foreignLines.filter(l => !l.sourceCountry);
    if (unnamed.length > 0) {
      warnings.push({
        kind: 'foreign-tax-country-unknown',
        severity: 'info',
        count: unnamed.length,
        message:
          `${unnamed.length} statement${unnamed.length === 1 ? '' : 's'} with foreign tax withheld ` +
          (unnamed.length === 1 ? 'does' : 'do') +
          ' not say which country it was paid to. The offset is the same either way, but the return ' +
          'asks for the country — add it from the statement.',
      });
    }
  }

  const grossedUp = lines.filter(l => l.matchedNet);
  if (grossedUp.length > 0) {
    warnings.push({
      kind: 'grossed-up-to-statement',
      severity: 'info',
      count: grossedUp.length,
      amount: round2(grossedUp.reduce((s, l) => s + l.addedIncome, 0)),
      message:
        `${grossedUp.length} deposit${grossedUp.length === 1 ? '' : 's'} in your income ` +
        (grossedUp.length === 1 ? 'is' : 'are') +
        ' the dividend after tax was taken out of it. The tax withheld is assessable income too, so ' +
        'the difference was added back:',
    });
  }

  const over = lines.filter(l => l.overFrankedBy != null);
  if (over.length > 0) {
    warnings.push({
      kind: 'over-franked',
      severity: 'warn',
      count: over.length,
      amount: round2(over.reduce((s, l) => s + (l.overFrankedBy ?? 0), 0)),
      message:
        `${over.length} statement${over.length === 1 ? '' : 's'} shows a franking credit larger than a ` +
        'fully franked dividend can carry at the 30% company rate. Check the figures:',
    });
  }
  if (undated > 0) {
    warnings.push({
      kind: 'undated-statement',
      severity: 'warn',
      count: undated,
      message:
        `${undated} statement${undated === 1 ? '' : 's'} ` + (undated === 1 ? 'has' : 'have') +
        ' no payment date, so ' + (undated === 1 ? 'it belongs' : 'they belong') +
        ' to no financial year and ' + (undated === 1 ? 'is' : 'are') + ' not counted anywhere.',
    });
  }
  // Dividend income with no statement behind it: the cash is taxed, but any
  // franking credit attached to it is being thrown away.
  const unexplained = candidates.filter(l => isDividendCategory(l.category) && !claimed.has(l.key));
  if (unexplained.length > 0) {
    warnings.push({
      kind: 'income-without-statement',
      severity: 'info',
      count: unexplained.length,
      amount: round2(unexplained.reduce((s, l) => s + Math.abs(l.amount), 0)),
      message:
        `${unexplained.length} dividend payment${unexplained.length === 1 ? '' : 's'} in your income ` +
        (unexplained.length === 1 ? 'has' : 'have') +
        ' no statement recorded. If any of it was franked, you are missing the credit on:',
    });
  }

  // TFN amounts withheld on a statement whose cash is already counted elsewhere
  // have nowhere to land: the income line that counts the cash carries its own
  // withholding figure, and Ledger will not overwrite it from here. Counting it
  // as well would credit the same tax twice, so it is named instead.
  const strandedWithholding = round2(
    lines.filter(l => !l.addsIncome).reduce((s, l) => s + l.withheld, 0),
  );
  if (strandedWithholding > 0) {
    warnings.push({
      kind: 'withholding-not-credited',
      severity: 'warn',
      amount: strandedWithholding,
      message:
        'Tax withheld on a statement whose cash is already recorded as income is not being credited ' +
        'twice. Put it on the income entry itself, or on the tax-paid card:',
    });
  }

  return {
    fy,
    lines,
    frankedAmount: sum(l => l.frankedAmount),
    unfrankedAmount: sum(l => l.unfrankedAmount),
    cashDividends: sum(l => l.cash),
    frankingCredit,
    withheld: sum(l => l.withheld),
    foreignTaxPaid,
    foreignIncome,
    grossedUpTotal: sum(l => l.grossedUp),
    additionalAssessableIncome,
    supersededManualFranking,
    effectiveFrankingCredit,
    warnings,
  };
}
