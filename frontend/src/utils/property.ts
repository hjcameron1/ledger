/**
 * Phase 4.1 — the property engine.
 *
 * Pure arithmetic over properties and the loans they point at. No store, no
 * React, no I/O — everything the Property page and net worth show is derived
 * here so the screen can only ever say what the maths says.
 *
 * ── The one rule that shapes this file ──────────────────────────────────────
 * A property is an ASSET. Its mortgage is an ORDINARY LOAN that already reduces
 * net worth through the loans total. So:
 *
 *   net-worth contribution of a property  =  current_value × ownership share
 *   equity of a property                  =  that value − the linked balance
 *
 * The second line is a DISPLAY figure. Subtracting the mortgage again when
 * summing net worth would count the same debt twice — which is precisely what
 * `netWorthEffect` below exists to make checkable: it re-derives the property's
 * true effect on net worth from BOTH sides (asset here, debt via loans) so a
 * test can prove the total never drifts from the sum of its parts.
 *
 * Ownership share applies to the VALUE only, never to the loan. The loan row
 * holds the balance the user actually owes, whatever slice of the house that
 * money bought — scaling it by ownership would invent a debt nobody has.
 */

import type { Property, PropertyType, Loan } from '../types';

const r2 = (n: number): number => parseFloat((Number.isFinite(n) ? n : 0).toFixed(2));

/** Human labels for each property type, in the order the picker offers them. */
export const PROPERTY_TYPE_LABELS: Record<PropertyType, string> = {
  home: 'Home',
  investment: 'Investment',
  holiday: 'Holiday home',
  land: 'Land',
  commercial: 'Commercial',
  other: 'Other',
};

export const PROPERTY_TYPES = Object.keys(PROPERTY_TYPE_LABELS) as PropertyType[];

/**
 * The share of the property the user owns, as a 0–1 fraction.
 *
 * Missing/garbage means sole ownership: a property entered before the field
 * existed, or with a blank box, is the user's own house until they say
 * otherwise. Out-of-range values are clamped rather than trusted, because a
 * typo'd 1000% would otherwise multiply their net worth by ten.
 */
export function ownershipShare(p: Pick<Property, 'ownership_percent'>): number {
  const pct = Number(p.ownership_percent);
  if (!Number.isFinite(pct)) return 1;
  return Math.min(100, Math.max(0, pct)) / 100;
}

/** The slice of the property's value that belongs to this user. */
export function ownedValue(p: Pick<Property, 'ownership_percent' | 'current_value'>): number {
  return r2((Number(p.current_value) || 0) * ownershipShare(p));
}

/** The loan backing a property, or null when it is unencumbered. */
export function linkedLoan(p: Pick<Property, 'loan_id'>, loans: Loan[]): Loan | null {
  if (!p.loan_id) return null;
  return loans.find(l => l.id === p.loan_id) ?? null;
}

/**
 * What the property adds to net worth: its owned value, and nothing else.
 * Zero when the user has opted it out (same switch loans and super carry).
 */
export function netWorthValue(p: Pick<Property, 'ownership_percent' | 'current_value' | 'include_in_net_worth'>): number {
  return p.include_in_net_worth === false ? 0 : ownedValue(p);
}

/** Owned share of every property, i.e. the `property` line of net worth. */
export function propertyNetWorthTotal(properties: Property[]): number {
  return r2(properties.reduce((sum, p) => sum + netWorthValue(p), 0));
}

/** One property, fully worked out. */
export interface PropertyRow {
  id: string;
  name: string;
  address: string | null;
  type: PropertyType;
  typeLabel: string;
  /** Full market value, regardless of who owns it. */
  value: number;
  ownershipPercent: number;
  /** The user's slice of `value`. */
  ownedValue: number;
  purchasePrice: number;
  purchaseDate: string | null;
  /** Owned value − owned share of the purchase price. Null with no price on file. */
  gain: number | null;
  gainPercent: number | null;
  loan: { id: string; name: string; balance: number } | null;
  /** The linked loan's balance in full (never scaled by ownership). 0 if unlinked. */
  debt: number;
  /** ownedValue − debt. What the user would keep if they sold and repaid. */
  equity: number;
  /** Debt as a % of owned value. Null when unlinked or the value is 0. */
  lvr: number | null;
  countsTowardNetWorth: boolean;
  /** Whether the linked loan is itself counted as debt in net worth. */
  debtCountsTowardNetWorth: boolean;
  /**
   * The property's TRUE effect on net worth once its mortgage is accounted for
   * on the loans side: netWorthValue − (debt, if that loan counts).
   *
   * This equals `equity` in the ordinary case, and is the number that makes
   * double-counting detectable: net worth may move by this and no more.
   */
  netWorthEffect: number;
}

export interface PropertyReport {
  rows: PropertyRow[];
  totals: {
    /** Full market value of everything, ignoring ownership. */
    value: number;
    /** Sum of owned values — identical to the `property` line of net worth. */
    ownedValue: number;
    /** Sum of linked loan balances. Each loan appears once: a loan can back one
     *  property, so this can never double-count a mortgage. */
    debt: number;
    equity: number;
    /** Σ netWorthEffect — the amount properties (and their mortgages) move net worth. */
    netWorthEffect: number;
    count: number;
  };
}

/** Work out every property against the loans it points at. */
export function buildPropertyReport(properties: Property[], loans: Loan[]): PropertyReport {
  const rows: PropertyRow[] = properties.map(p => {
    const loan = linkedLoan(p, loans);
    const share = ownershipShare(p);
    const owned = ownedValue(p);
    const debt = loan ? Number(loan.current_balance) || 0 : 0;
    const counts = p.include_in_net_worth !== false;
    // Legacy loans saved before the flag existed have it undefined → included,
    // matching how the net-worth engine reads them.
    const debtCounts = !!loan && loan.include_in_net_worth !== false;

    const purchasePrice = Number(p.purchase_price) || 0;
    // The gain is measured on the same footing as the value: the user's slice of
    // what it cost against the user's slice of what it's worth. Comparing an owned
    // value with a whole purchase price would read as a loss on every joint buy.
    const ownedCost = r2(purchasePrice * share);
    const gain = purchasePrice > 0 ? r2(owned - ownedCost) : null;

    return {
      id: p.id,
      name: p.name,
      address: p.address ?? null,
      type: p.property_type,
      typeLabel: PROPERTY_TYPE_LABELS[p.property_type] ?? 'Property',
      value: r2(Number(p.current_value) || 0),
      ownershipPercent: r2(share * 100),
      ownedValue: owned,
      purchasePrice: r2(purchasePrice),
      purchaseDate: p.purchase_date ?? null,
      gain,
      gainPercent: gain !== null && ownedCost > 0 ? r2((gain / ownedCost) * 100) : null,
      loan: loan ? { id: loan.id, name: loan.name, balance: r2(debt) } : null,
      debt: r2(debt),
      equity: r2(owned - debt),
      lvr: loan && owned > 0 ? r2((debt / owned) * 100) : null,
      countsTowardNetWorth: counts,
      debtCountsTowardNetWorth: debtCounts,
      netWorthEffect: r2((counts ? owned : 0) - (debtCounts ? debt : 0)),
    };
  });

  return {
    rows,
    totals: {
      value: r2(rows.reduce((s, r) => s + r.value, 0)),
      ownedValue: r2(rows.reduce((s, r) => s + r.ownedValue, 0)),
      debt: r2(rows.reduce((s, r) => s + r.debt, 0)),
      equity: r2(rows.reduce((s, r) => s + r.equity, 0)),
      netWorthEffect: r2(rows.reduce((s, r) => s + r.netWorthEffect, 0)),
      count: rows.length,
    },
  };
}

/**
 * The loans a property may link to: every loan not already backing a DIFFERENT
 * property, with mortgages first because that is what the user is looking for.
 *
 * Filtering here is what stops one balance being netted against two properties
 * from the UI; the backend refuses the same link independently, so a stale tab
 * can't get around it.
 */
export function availableLoansForProperty(
  loans: Loan[],
  properties: Property[],
  propertyId?: string | null,
): Loan[] {
  const taken = new Set(
    properties.filter(p => p.id !== propertyId && p.loan_id).map(p => p.loan_id as string),
  );
  return loans
    .filter(l => !taken.has(l.id))
    .sort((a, b) => {
      const am = a.loan_type === 'mortgage' ? 0 : 1;
      const bm = b.loan_type === 'mortgage' ? 0 : 1;
      return am !== bm ? am - bm : a.name.localeCompare(b.name);
    });
}

/** What the user typed, before it becomes a Property. */
export interface PropertyDraft {
  name: string;
  current_value: number;
  purchase_price?: number;
  ownership_percent?: number;
  loan_id?: string | null;
}

/**
 * Reasons a draft can't be saved, in the order they should be shown. Empty
 * means it's good. The link checks mirror the server's, so the user is told
 * before the write rather than by a rejected sync.
 */
export function validateProperty(
  draft: PropertyDraft,
  ctx: { loans: Loan[]; properties: Property[]; propertyId?: string | null },
): string[] {
  const errors: string[] = [];

  if (!draft.name.trim()) errors.push('Give the property a name.');
  if (!Number.isFinite(draft.current_value) || draft.current_value < 0) {
    errors.push('Current value must be zero or more.');
  }
  if (draft.purchase_price != null && (!Number.isFinite(draft.purchase_price) || draft.purchase_price < 0)) {
    errors.push('Purchase price must be zero or more.');
  }
  const pct = draft.ownership_percent;
  if (pct != null && (!Number.isFinite(pct) || pct < 0 || pct > 100)) {
    errors.push('Ownership must be between 0% and 100%.');
  }

  if (draft.loan_id) {
    const loan = ctx.loans.find(l => l.id === draft.loan_id);
    if (!loan) {
      errors.push('That loan no longer exists.');
    } else {
      const other = ctx.properties.find(p => p.id !== ctx.propertyId && p.loan_id === draft.loan_id);
      if (other) errors.push(`That loan is already linked to "${other.name}".`);
    }
  }

  return errors;
}
