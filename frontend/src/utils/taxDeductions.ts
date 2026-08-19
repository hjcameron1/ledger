/**
 * Phase 2D.4 — smarter deduction handling (pure engine).
 *
 * Ledger already has TWO deduction inputs and this module does NOT duplicate
 * either — it MERGES them into one financial-year view:
 *
 *   1. Per-transaction tax metadata (Phase 2D.1): a transaction row flagged
 *      `is_tax_deductible` with a `deduction_category`. These are real spends the
 *      user already recorded and ticked as claimable.
 *   2. The manual `tax_deductions` list (`deductionsDS`): free-form deduction
 *      entries the user types in (e.g. a WFH hours calc) that have no single
 *      backing transaction.
 *
 * buildDeductionView() folds both into one list, filtered to a financial year,
 * grouped by deduction category, with per-group and grand totals, and each line
 * carries a link back to its source transaction where one exists.
 *
 * DOUBLE-COUNT PREVENTION: a manual deduction may be LINKED to a source
 * transaction (`source_transaction_id`). When it is, that transaction is
 * represented by the manual line and is dropped from the transaction-sourced
 * lines — so the same expense is never counted twice. Editing/removing that link
 * (setDeductionLink) is what moves an expense between "counted as the transaction"
 * and "counted as the manual entry".
 *
 * REFUNDS (Phase 5.1): a confidently-matched refund (`transaction_type='refund'`
 * with `refund_of` set) reduces the claim it reverses, apportioned when only part
 * of the expense was claimed. Only refunds received in the SAME financial year
 * net off; one received later is reported as a recoupment against the year it
 * arrived in, never applied backwards to a year already filed.
 *
 * BUSINESS vs PERSONAL (Phase 5.1): every line resolves to one entity, from the
 * transaction's `entity` field or the manual record's own — unknown is always
 * personal, so nothing is silently promoted into a business return.
 *
 * This deliberately does NOT compute final tax liability — it only assembles the
 * deduction total that feeds the existing estimate. utils/taxYear.ts puts that
 * total together with the income side to produce the FY position.
 *
 * PURE — no store, no network, no localStorage. `deductionsDS` (dataService) is
 * the thin persistence wrapper around the list mutators here; the Tax page
 * renders the view.
 */

import type { Transaction } from '../types';
import { financialYearOf } from './format';

/**
 * Canonical Australian work-related deduction buckets. Single source of truth so
 * the per-transaction TaxModal and the manual-deduction form group together into
 * the same categories. Free-form under the hood — an existing value not in this
 * list is always preserved by the callers, so nothing already set is lost.
 */
export const DEDUCTION_CATEGORIES: readonly string[] = [
  'Work-related travel',
  'Vehicle & car expenses',
  'Clothing, laundry & dry-cleaning',
  'Self-education',
  'Working from home',
  'Tools, equipment & assets',
  'Phone, data & internet',
  'Union & professional fees',
  'Gifts & donations',
  'Investment & interest expenses',
  'Income protection insurance',
  'Cost of managing tax affairs',
  'Other work-related',
];

/** Label used when a deduction carries no category. */
export const UNCATEGORISED_DEDUCTION = 'Uncategorised';

/**
 * Which set of affairs a claim belongs to. Mirrors `Transaction.entity` — an
 * unset/unknown value means PERSONAL, so a claim is never silently promoted into
 * a business return.
 */
export type DeductionEntity = 'business' | 'personal';

/** Normalise a free-text entity field to the two-value domain (default personal). */
export function normaliseEntity(value?: string | null): DeductionEntity {
  return (value ?? '').trim().toLowerCase() === 'business' ? 'business' : 'personal';
}

/** A manual `tax_deductions` record (the shape persisted by deductionsDS). */
export interface ManualDeduction {
  id: string;
  name: string;
  amount: number;
  category: string;
  date: string;
  /** Optional link to the transaction this deduction represents (dedup key). */
  source_transaction_id?: string | null;
  /**
   * Business or personal. Unset means "inherit from the linked transaction, else
   * personal" — resolved in buildDeductionView, never guessed from the category.
   */
  entity?: DeductionEntity | null;
  /**
   * Transaction ids the user confirmed are NOT duplicates of this deduction.
   * Suppresses the heuristic duplicate detector for those pairs so a genuinely
   * separate same-amount/date expense is never permanently hidden ("keep both").
   */
  not_duplicate_of?: string[];
  created_at?: string;
}

/** Days apart a manual deduction and a transaction may be and still match. */
export const DUP_DATE_WINDOW_DAYS = 3;

export type DeductionSource = 'manual' | 'transaction' | 'rental';

/**
 * Why a line is shown but not counted.
 *
 *   duplicate          the transaction half of a manual↔transaction pair;
 *   counted-in-rental  a rental property has already claimed this payment on its
 *                      own schedule, where it is apportioned for ownership and
 *                      private use (Phase 5.5). The general view is the blunter
 *                      reading of the same money, so it steps aside.
 */
export type DeductionExclusionReason = 'duplicate' | 'counted-in-rental';

/**
 * A deduction worked out somewhere else and folded in here so there is ONE
 * deductions total (Phase 5.5 — the rental schedule).
 *
 * It carries a net amount rather than an amount and a refund, because whatever
 * produced it has already netted its own refunds and apportioned its own share:
 * re-deriving either here would be a second opinion on a settled figure.
 */
export interface ExternalDeductionLine {
  /** Unique within its source. The line's key becomes `x:<id>`. */
  id: string;
  name: string;
  category: string;
  /** What is claimed, after every reduction the producing engine applied. */
  netAmount: number;
  date: string;
  entity?: DeductionEntity;
  /** Backing transaction, when the line stands for exactly one. */
  transactionId?: string | null;
}

/** One row in the merged deduction view. */
export interface DeductionLine {
  /** Stable React key, namespaced by source so ids can't collide. */
  key: string;
  source: DeductionSource;
  /** The manual deduction id OR the transaction id. */
  id: string;
  name: string;
  /** The GROSS claim, before any refund is netted off. Always positive. */
  amount: number;
  /**
   * Money already refunded against this claim (0 when none). A refund of a
   * partial claim is apportioned — see netAmount.
   */
  refunded: number;
  /** What actually counts: amount − refunded, floored at 0. Totals use THIS. */
  netAmount: number;
  category: string;
  /** Business or personal — resolved, never null (unknown ⇒ personal). */
  entity: DeductionEntity;
  date: string;
  /** Source/linked transaction id, so the UI can link back. Null for unlinked manual. */
  transactionId: string | null;
  /** Display merchant of the backing transaction, when known. */
  merchant: string | null;
  /** True for a manual line that carries an explicit transaction link. */
  linked: boolean;
  /**
   * True when this line is one half of a HEURISTICALLY-detected duplicate pair
   * (same expense entered both manually and as a deductible transaction, without
   * an explicit link). Set on BOTH the manual and the transaction line so the UI
   * can flag them for review.
   */
  suspectedDuplicate: boolean;
  /**
   * The id of the other line in a suspected/explicit duplicate pair — the matched
   * transaction id (on a manual line) or the manual deduction id (on a tx line).
   */
  duplicateOf: string | null;
  /**
   * True when this line is excluded from every total (the transaction half of a
   * suspected duplicate). It stays VISIBLE for review — never silently deleted —
   * but does not contribute to group or grand totals.
   */
  excluded: boolean;
  /** Why, when it is. Null on a counted line. */
  excludedReason: DeductionExclusionReason | null;
}

/** A heuristically-detected duplicate: one manual deduction ↔ one transaction. */
export interface SuspectedDuplicate {
  manualId: string;
  transactionId: string;
  /** The (shared) claim amount. */
  amount: number;
  /** Manual deduction name, for the review prompt. */
  name: string;
  category: string;
  /** Transaction merchant, when known. */
  merchant: string | null;
  date: string;
}

export interface DeductionGroup {
  category: string;
  /** Net of refunds, excluding duplicate-suppressed lines. */
  total: number;
  /** The same total split by entity (business + personal === total). */
  business: number;
  personal: number;
  lines: DeductionLine[];
}

/**
 * A refund received in THIS financial year against an expense claimed in a
 * DIFFERENT one. It is never netted off the earlier year's claim (that year is
 * filed); it is surfaced so the user can declare the recoupment in the year they
 * received it.
 */
export interface RecoupedExpense {
  /** The refund transaction. */
  refundId: string;
  /** The original (deductible) transaction it reverses. */
  originalTransactionId: string;
  /** The FY the original expense was claimed in. */
  claimedFY: string;
  amount: number;
  date: string;
  merchant: string | null;
}

export interface DeductionView {
  fy: string;
  /** Grand total of every counted line, net of refunds. */
  total: number;
  lineCount: number;
  /** Sum of manual deduction lines in this FY, net of refunds (incl. linked). */
  manualTotal: number;
  /** Sum of transaction-sourced lines, net of refunds (excludes deduped ones). */
  transactionTotal: number;
  /** Sum of lines folded in from another engine — the rental schedule. */
  externalTotal: number;
  /** Deductible transactions this view stood aside from because a rental
   *  property had already claimed them. Listed so nothing vanishes silently. */
  countedInRental: string[];
  /** Total refunded against counted lines — the gap between gross and `total`. */
  refundedTotal: number;
  /** `total` split by entity. business + personal === total. */
  businessTotal: number;
  personalTotal: number;
  groups: DeductionGroup[];
  /** Transaction ids an EXPLICIT manual link represents — dropped from tx lines. */
  linkedTransactionIds: string[];
  /**
   * Heuristically-detected duplicate pairs awaiting review. The transaction half
   * is excluded from totals (counted via the manual line) but still shown flagged.
   */
  suspectedDuplicates: SuspectedDuplicate[];
  /** Refunds landing in this FY against a claim from another FY (informational). */
  recoupedFromOtherFY: RecoupedExpense[];
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function catOf(c?: string | null): string {
  const t = (c ?? '').trim();
  return t === '' ? UNCATEGORISED_DEDUCTION : t;
}

// ─── Heuristic duplicate detection ───────────────────────────────────────────

/** Whole days between two YYYY-MM-DD dates (Infinity if either is unparseable). */
export function daysBetween(a: string, b: string): number {
  const da = Date.parse(a);
  const db = Date.parse(b);
  if (Number.isNaN(da) || Number.isNaN(db)) return Infinity;
  return Math.abs(da - db) / 86_400_000;
}

/** Significant word tokens of a description (lowercased, ≥3 chars, punctuation-free). */
function tokensOf(s?: string | null): Set<string> {
  return new Set(
    (s ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, ' ')
      .split(/\s+/)
      .filter(w => w.length >= 3),
  );
}

/** True when two descriptions share at least one significant token. */
export function descriptionSimilar(a?: string | null, b?: string | null): boolean {
  const ta = tokensOf(a);
  if (ta.size === 0) return false;
  for (const w of tokensOf(b)) if (ta.has(w)) return true;
  return false;
}

/**
 * Whether a manual deduction and a deductible transaction are LIKELY the same
 * expense — the basis for excluding one from totals and flagging the pair.
 *
 * Amount must match to the cent AND the dates must be within DUP_DATE_WINDOW_DAYS
 * (both mandatory), plus at least one corroborating signal — same category OR a
 * shared word between the manual name and the transaction merchant. This uses all
 * four fields (date, amount, description/merchant, category) and stays
 * conservative so it flags for review rather than over-matching distinct spends.
 */
export function isLikelyDuplicate(m: ManualDeduction, t: Transaction): boolean {
  const amt = round2(Math.abs(m.amount) || 0);
  if (amt === 0 || amt !== round2(Math.abs(t.amount) || 0)) return false;
  if (daysBetween(m.date, t.date) > DUP_DATE_WINDOW_DAYS) return false;
  const sameCategory = catOf(m.category) === catOf(t.deduction_category);
  return sameCategory || descriptionSimilar(m.name, t.merchant);
}

// ─── Refunds against a claim ─────────────────────────────────────────────────

/**
 * Money returned against an expense, keyed by the ORIGINAL transaction it
 * reverses. Only a confidently-matched refund counts (`transaction_type` is
 * 'refund' AND `refund_of` points at the purchase) — exactly the pairing
 * transactionCore/refundMatching already establishes. An unmatched inflow is
 * never treated as a refund, so a claim is never quietly reduced on a guess.
 *
 * Partial refunds are summed, so two part-refunds of one purchase net correctly.
 */
export function refundsByOriginalTransaction(
  transactions: Transaction[],
): Map<string, { total: number; refunds: Transaction[] }> {
  const out = new Map<string, { total: number; refunds: Transaction[] }>();
  for (const t of transactions) {
    if (t.transaction_type !== 'refund') continue;
    const original = t.refund_of?.trim();
    if (!original) continue;
    const amount = Math.abs(t.display_amount ?? t.amount ?? 0);
    if (amount === 0) continue;
    const entry = out.get(original) ?? { total: 0, refunds: [] };
    entry.total = round2(entry.total + amount);
    entry.refunds.push(t);
    out.set(original, entry);
  }
  return out;
}

/**
 * How much of a refund reduces a claim, when the claim is only PART of the
 * original expense (e.g. $600 spent, $360 claimed at 60% work use). The refund
 * is apportioned at the same rate the expense was claimed at, then capped at the
 * claim itself so a deduction can never go negative.
 *
 * A whole-of-transaction claim has ratio 1, so a full refund cancels it exactly.
 */
export function apportionRefund(claim: number, originalAmount: number, refunded: number): number {
  if (refunded <= 0 || claim <= 0) return 0;
  const base = Math.abs(originalAmount) || 0;
  const ratio = base > 0 ? Math.min(1, claim / base) : 1;
  return Math.min(round2(claim), round2(refunded * ratio));
}

/** Stable ordering (date asc, then id) so matching is order-independent. */
function byDateThenId<T extends { date: string; id: string }>(a: T, b: T): number {
  if (a.date === b.date) return a.id.localeCompare(b.id);
  return a.date < b.date ? -1 : 1;
}

// ─── Financial-year selection ────────────────────────────────────────────────

/** Deductible transactions that fall in the given financial year. */
export function deductibleTransactionsForFY(transactions: Transaction[], fy: string): Transaction[] {
  return transactions.filter(t => t.is_tax_deductible === true && !!t.date && financialYearOf(t.date) === fy);
}

/** Manual deductions that fall in the given financial year (by their own date). */
export function manualDeductionsForFY(deductions: ManualDeduction[], fy: string): ManualDeduction[] {
  return deductions.filter(d => !!d.date && financialYearOf(d.date) === fy);
}

/**
 * Financial years present across deductible transactions + manual deductions,
 * newest first — the option list for the FY switcher.
 */
export function availableFinancialYears(
  transactions: Transaction[],
  manualDeductions: ManualDeduction[],
): string[] {
  const set = new Set<string>();
  for (const t of transactions) {
    if (t.is_tax_deductible === true && t.date) set.add(financialYearOf(t.date));
  }
  for (const d of manualDeductions) {
    if (d.date) set.add(financialYearOf(d.date));
  }
  return [...set].sort().reverse();
}

// ─── The merged view ─────────────────────────────────────────────────────────

/**
 * Merge manual deductions + deductible transactions into one FY view, grouped by
 * category, with totals and back-links. A manual deduction linked to a
 * transaction suppresses that transaction's own line (no double counting).
 */
export function buildDeductionView(input: {
  transactions: Transaction[];
  manualDeductions: ManualDeduction[];
  fy: string;
  /**
   * Phase 5.5 — transactions a rental property has already claimed on its own
   * schedule. Their own lines stay VISIBLE and stop counting, because the rental
   * line counting instead is the same money read more precisely (it knows the
   * ownership share and the private-use split, which a tick box cannot).
   */
  claimedByRental?: Set<string>;
  /** Phase 5.5 — the rental schedule's own deduction lines, folded in so there
   *  is one deductions total for the whole return. */
  externalLines?: ExternalDeductionLine[];
}): DeductionView {
  const { transactions, manualDeductions, fy } = input;
  const claimedByRental = input.claimedByRental ?? new Set<string>();

  const manual = manualDeductionsForFY(manualDeductions, fy);
  const deductibleTx = deductibleTransactionsForFY(transactions, fy);

  // Any transaction claimed by a manual deduction's EXPLICIT link is already
  // represented by that manual line — it must not also be counted as its own line.
  const linkedTransactionIds = new Set<string>();
  for (const d of manual) {
    const link = d.source_transaction_id?.trim();
    if (link) linkedTransactionIds.add(link);
  }

  // Heuristic pass: match an unlinked manual deduction to a look-alike transaction
  // so an unlinked same-expense pair is counted once (not $24 for a $12 spend).
  // One-to-one and order-independent: both lists are sorted, and each transaction
  // can be claimed by at most one manual deduction. The transaction half is
  // flagged + excluded from totals but kept visible for review — never deleted.
  const manualByTx = new Map<string, string>(); // txId  → manualId (suspected dup)
  const txByManual = new Map<string, string>(); // manualId → txId
  const claimedTx = new Set<string>(linkedTransactionIds);
  const stableManual = manual.slice().sort(byDateThenId);
  const stableTx = deductibleTx.slice().sort(byDateThenId);
  for (const d of stableManual) {
    if (d.source_transaction_id?.trim()) continue; // resolved via an explicit link
    const dismissed = new Set(d.not_duplicate_of ?? []);
    for (const t of stableTx) {
      if (claimedTx.has(t.id) || dismissed.has(t.id)) continue;
      if (isLikelyDuplicate(d, t)) {
        manualByTx.set(t.id, d.id);
        txByManual.set(d.id, t.id);
        claimedTx.add(t.id);
        break;
      }
    }
  }

  // Refunds. A refund only reduces the claim when the refund itself lands in the
  // SAME financial year: a later-year refund of an earlier-year claim is a
  // recoupment to declare in the year received, not a retro-edit of a filed year.
  const refundIndex = refundsByOriginalTransaction(transactions);
  const txById = new Map(transactions.map(t => [t.id, t]));
  const refundedInFY = (txId: string): number => {
    const hit = refundIndex.get(txId);
    if (!hit) return 0;
    return round2(
      hit.refunds
        .filter(r => !!r.date && financialYearOf(r.date) === fy)
        .reduce((s, r) => s + Math.abs(r.display_amount ?? r.amount ?? 0), 0),
    );
  };

  const lines: DeductionLine[] = [];

  for (const d of manual) {
    const link = d.source_transaction_id?.trim() || null;
    const dupTx = txByManual.get(d.id) ?? null;
    // A manual line stands in for its linked (or duplicate-matched) transaction,
    // so that transaction's refunds and entity flow through to this line.
    const backingId = link ?? dupTx;
    const backing = backingId ? txById.get(backingId) : undefined;
    const amount = round2(Math.abs(d.amount) || 0);
    const refunded = backingId
      ? apportionRefund(amount, Math.abs(backing?.amount ?? amount), refundedInFY(backingId))
      : 0;
    lines.push({
      key: `m:${d.id}`,
      source: 'manual',
      id: d.id,
      name: d.name?.trim() || 'Deduction',
      amount,
      refunded,
      netAmount: round2(Math.max(0, amount - refunded)),
      category: catOf(d.category),
      entity: d.entity ? normaliseEntity(d.entity) : normaliseEntity(backing?.entity),
      date: d.date,
      transactionId: backingId,
      merchant: backing?.merchant ?? null,
      linked: !!link,
      suspectedDuplicate: !!dupTx,
      duplicateOf: dupTx,
      excluded: false, // the manual line is the one that counts
      excludedReason: null,
    });
  }

  const countedInRental: string[] = [];
  for (const t of deductibleTx) {
    if (linkedTransactionIds.has(t.id)) continue; // deduped — an explicit link owns it
    const dupManualId = manualByTx.get(t.id) ?? null;
    const inRental = !dupManualId && claimedByRental.has(t.id);
    if (inRental) countedInRental.push(t.id);
    const amount = round2(Math.abs(t.amount) || 0);
    // A duplicate-suppressed line contributes nothing, and its refund is already
    // netted off the manual line that represents it — never count it twice.
    const refunded = dupManualId || inRental ? 0 : Math.min(amount, refundedInFY(t.id));
    lines.push({
      key: `t:${t.id}`,
      source: 'transaction',
      id: t.id,
      name: t.merchant?.trim() || 'Transaction',
      amount,
      refunded,
      netAmount: round2(Math.max(0, amount - refunded)),
      category: catOf(t.deduction_category),
      entity: normaliseEntity(t.entity),
      date: t.date,
      transactionId: t.id,
      merchant: t.merchant ?? null,
      linked: false,
      suspectedDuplicate: !!dupManualId,
      duplicateOf: dupManualId,
      excluded: !!dupManualId || inRental, // flagged, kept visible, not counted
      excludedReason: dupManualId ? 'duplicate' : inRental ? 'counted-in-rental' : null,
    });
  }

  // Lines another engine settled. They arrive already netted and apportioned, so
  // they are never refunded, deduped or entity-guessed here — doing any of that
  // would be a second opinion on a figure that is already final.
  for (const x of input.externalLines ?? []) {
    const net = round2(Math.max(0, x.netAmount));
    lines.push({
      key: `x:${x.id}`,
      source: 'rental',
      id: x.id,
      name: x.name,
      // Gross and net are the SAME here on purpose. Whatever the producing
      // engine took off — a refund, an ownership share, private use — it has
      // already explained on its own card, and reporting the difference as
      // `refunded` would make the year's refund total say something untrue.
      amount: net,
      refunded: 0,
      netAmount: net,
      category: catOf(x.category),
      entity: normaliseEntity(x.entity),
      date: x.date,
      transactionId: x.transactionId ?? null,
      merchant: null,
      linked: false,
      suspectedDuplicate: false,
      duplicateOf: null,
      excluded: false,
      excludedReason: null,
    });
  }

  // Group by category, newest line first within a group, biggest group first.
  const byCat = new Map<string, DeductionLine[]>();
  for (const ln of lines) {
    const arr = byCat.get(ln.category);
    if (arr) arr.push(ln);
    else byCat.set(ln.category, [ln]);
  }

  // Totals never count an `excluded` line (the transaction half of a suspected
  // duplicate) — but the line is still listed in its group for review. Every
  // total is NET of refunds, so a refunded expense stops inflating the claim.
  const sumCounted = (ls: DeductionLine[], pick: (l: DeductionLine) => boolean = () => true) =>
    round2(ls.reduce((s, l) => s + (l.excluded || !pick(l) ? 0 : l.netAmount), 0));

  const groups: DeductionGroup[] = [...byCat.entries()]
    .map(([category, ls]) => ({
      category,
      total: sumCounted(ls),
      business: sumCounted(ls, l => l.entity === 'business'),
      personal: sumCounted(ls, l => l.entity === 'personal'),
      lines: ls.slice().sort(byDateDesc),
    }))
    .sort((a, b) => b.total - a.total || a.category.localeCompare(b.category));

  const manualTotal = sumCounted(lines, l => l.source === 'manual');
  const transactionTotal = sumCounted(lines, l => l.source === 'transaction');
  const externalTotal = sumCounted(lines, l => l.source === 'rental');
  const total = round2(manualTotal + transactionTotal + externalTotal);
  const refundedTotal = round2(
    lines.reduce((s, l) => s + (l.excluded ? 0 : l.refunded), 0),
  );

  // Refunds landing in this FY against a claim made in another FY — reported,
  // never netted backwards (see the refund note above).
  const recoupedFromOtherFY: RecoupedExpense[] = [];
  for (const t of transactions) {
    if (t.transaction_type !== 'refund' || !t.date || financialYearOf(t.date) !== fy) continue;
    const originalId = t.refund_of?.trim();
    if (!originalId) continue;
    const original = txById.get(originalId);
    if (!original?.is_tax_deductible || !original.date) continue;
    const claimedFY = financialYearOf(original.date);
    if (claimedFY === fy) continue; // same-year refunds are netted off above
    recoupedFromOtherFY.push({
      refundId: t.id,
      originalTransactionId: originalId,
      claimedFY,
      amount: round2(Math.abs(t.display_amount ?? t.amount ?? 0)),
      date: t.date,
      merchant: t.merchant ?? original.merchant ?? null,
    });
  }

  const suspectedDuplicates: SuspectedDuplicate[] = [...txByManual.entries()].map(
    ([manualId, transactionId]) => {
      const d = manual.find(x => x.id === manualId)!;
      const t = deductibleTx.find(x => x.id === transactionId);
      return {
        manualId,
        transactionId,
        amount: round2(Math.abs(d.amount) || 0),
        name: d.name?.trim() || 'Deduction',
        category: catOf(d.category),
        merchant: t?.merchant ?? null,
        date: d.date,
      };
    },
  );

  return {
    fy,
    total,
    lineCount: lines.length,
    manualTotal,
    transactionTotal,
    externalTotal,
    countedInRental,
    refundedTotal,
    businessTotal: sumCounted(lines, l => l.entity === 'business'),
    personalTotal: sumCounted(lines, l => l.entity === 'personal'),
    groups,
    linkedTransactionIds: [...linkedTransactionIds],
    suspectedDuplicates,
    recoupedFromOtherFY,
  };
}

function byDateDesc(a: DeductionLine, b: DeductionLine): number {
  if (a.date === b.date) return a.name.localeCompare(b.name);
  return a.date < b.date ? 1 : -1;
}

// ─── Pure list mutators (deductionsDS persists these) ────────────────────────

export interface NewManualDeduction {
  name: string;
  amount: number;
  category: string;
  date: string;
  source_transaction_id?: string | null;
  /** Omit to inherit from the linked transaction (else personal). */
  entity?: DeductionEntity | null;
}

/** Append a manual deduction, returning a new list (id/created_at injected). */
export function addManualDeduction(
  list: ManualDeduction[],
  data: NewManualDeduction,
  meta: { id: string; now: string },
): ManualDeduction[] {
  const record: ManualDeduction = {
    id: meta.id,
    name: data.name,
    amount: data.amount,
    category: data.category,
    date: data.date,
    source_transaction_id: data.source_transaction_id?.trim() || null,
    entity: data.entity ?? null,
    created_at: meta.now,
  };
  return [...list, record];
}

/** Patch a manual deduction by id, returning a new list. Unknown id → unchanged. */
export function updateManualDeduction(
  list: ManualDeduction[],
  id: string,
  patch: Partial<NewManualDeduction>,
): ManualDeduction[] {
  return list.map(d => {
    if (d.id !== id) return d;
    const next: ManualDeduction = { ...d, ...patch };
    if ('source_transaction_id' in patch) {
      next.source_transaction_id = patch.source_transaction_id?.trim() || null;
    }
    return next;
  });
}

/** Remove a manual deduction by id, returning a new list. */
export function removeManualDeduction(list: ManualDeduction[], id: string): ManualDeduction[] {
  return list.filter(d => d.id !== id);
}

/**
 * Set or clear the transaction link on a manual deduction (pass null to remove
 * the link). This is the edit that toggles double-count protection on/off.
 */
export function setDeductionLink(
  list: ManualDeduction[],
  id: string,
  transactionId: string | null,
): ManualDeduction[] {
  return list.map(d =>
    d.id === id ? { ...d, source_transaction_id: transactionId?.trim() || null } : d,
  );
}

/**
 * Record that a manual deduction is NOT a duplicate of a transaction ("keep
 * both") — suppresses the heuristic detector for that one pair so both keep
 * counting. Idempotent; unknown id → unchanged. The inverse of confirming a link.
 */
export function dismissDuplicate(
  list: ManualDeduction[],
  id: string,
  transactionId: string,
): ManualDeduction[] {
  const txId = transactionId.trim();
  if (!txId) return list;
  return list.map(d => {
    if (d.id !== id) return d;
    const existing = d.not_duplicate_of ?? [];
    if (existing.includes(txId)) return d;
    return { ...d, not_duplicate_of: [...existing, txId] };
  });
}
