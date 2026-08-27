/**
 * THE FOREIGN INCOME TAX OFFSET (FITO).
 *
 * Tax another country took out of your income is not tax the ATO is holding.
 * Australia relieves the double tax by an OFFSET, and an offset behaves nothing
 * like the PAYG credit Ledger used to treat it as:
 *
 *   • PAYG withheld  → refundable. Every dollar comes back, even if the year's
 *                      whole bill was smaller than what was withheld.
 *   • FITO           → non-refundable, and CAPPED. It can only ever wipe out
 *                      Australian tax that the foreign income itself caused. Pay
 *                      35% in one country on income Australia taxes at 30% and
 *                      the last 5% is simply lost — no refund, no carry forward.
 *
 * So crediting foreign withholding as PAYG overstates the refund twice over: by
 * the excess above the cap, and by the whole amount in any year the bill was
 * already covered. This module works out what may actually be claimed.
 *
 * THE LIMIT (ITAA 1997 s 770-75), in the order the section applies it:
 *
 *   1. Up to $1,000 of foreign tax is claimable with no calculation at all. This
 *      is a floor, not a threshold: it is available to everyone, so a small
 *      amount never has to justify itself.
 *   2. Above that, the limit is the difference between the Australian tax you
 *      actually pay and the Australian tax you would have paid with the foreign
 *      income — and the deductions that relate to it — left out. That difference
 *      IS the Australian tax the foreign income attracted.
 *   3. The claim is the smaller of the foreign tax paid and that limit, and the
 *      limit is never less than $1,000.
 *
 * WHAT IS DELIBERATELY NOT INVENTED. The comparison in step 2 needs the
 * deductions that relate to the foreign income; Ledger does not know which
 * deductions those are and does not guess. Leaving them out makes the "without
 * foreign income" figure LOWER, which makes the gap — and so the limit — LARGER,
 * so the answer errs towards allowing the claim. That is the direction the
 * $1,000 floor already errs in, and it is named in `assumptions` rather than
 * being buried. Nothing here reads a country or a currency: the offset is the
 * same whoever took the tax, and a statement that does not say which country is
 * a gap in the return, not in this arithmetic.
 *
 * PURE — no store, no network, no rates of its own. The caller supplies the one
 * thing that knows the brackets: a function from taxable income to Australian
 * tax on it.
 */

/** Foreign tax up to this much is claimable without any cap calculation. */
export const FITO_NO_CALCULATION_LIMIT = 1_000;

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function amount(v: unknown): number {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
  return Number.isFinite(n) && n > 0 ? round2(n) : 0;
}

export interface ForeignTaxOffset {
  /** Foreign tax actually withheld across the year's statements. */
  foreignTaxPaid: number;
  /** Gross foreign-source income the offset is measured against. */
  foreignIncome: number;
  /**
   * The most that may be claimed. Never below the $1,000 floor once any foreign
   * tax exists at all.
   */
  limit: number;
  /** What is claimed: the smaller of the tax paid and the limit. */
  offset: number;
  /** Foreign tax that exceeds the limit. Lost — not refunded, not carried. */
  unclaimable: number;
  /**
   * True when the answer came from the $1,000 floor rather than the comparison,
   * so the UI can say "under the threshold, claimed in full" instead of showing
   * working that was never done.
   */
  underNoCalculationLimit: boolean;
  /** Australian tax with the foreign income in, and with it taken out. */
  taxWithForeignIncome: number | null;
  taxWithoutForeignIncome: number | null;
  /** Everything the figure above rests on that the user cannot see. */
  assumptions: string[];
}

/** No foreign income at all — the shape, with nothing in it. */
export function emptyForeignTaxOffset(): ForeignTaxOffset {
  return {
    foreignTaxPaid: 0,
    foreignIncome: 0,
    limit: 0,
    offset: 0,
    unclaimable: 0,
    underNoCalculationLimit: false,
    taxWithForeignIncome: null,
    taxWithoutForeignIncome: null,
    assumptions: [],
  };
}

/**
 * Work out the year's foreign income tax offset.
 *
 * `taxOn` is Australian tax on a given taxable income — income tax and the
 * Medicare levy together, because the section compares total Australian tax, not
 * the income tax component. Pass null when the year has no rates and the offset
 * falls back to the $1,000 floor, which is the only thing that can be said
 * without brackets.
 */
export function buildForeignTaxOffset(input: {
  foreignTaxPaid: number;
  foreignIncome: number;
  taxableIncome: number;
  taxOn: ((taxableIncome: number) => number) | null;
}): ForeignTaxOffset {
  const foreignTaxPaid = amount(input.foreignTaxPaid);
  const foreignIncome = amount(input.foreignIncome);
  if (foreignTaxPaid === 0) return { ...emptyForeignTaxOffset(), foreignIncome };

  const assumptions: string[] = [];

  // Step 1 — the $1,000 no-calculation limit. Available to everyone, so it is
  // checked first and settles most years outright.
  if (foreignTaxPaid <= FITO_NO_CALCULATION_LIMIT) {
    return {
      foreignTaxPaid,
      foreignIncome,
      limit: FITO_NO_CALCULATION_LIMIT,
      offset: foreignTaxPaid,
      unclaimable: 0,
      underNoCalculationLimit: true,
      taxWithForeignIncome: null,
      taxWithoutForeignIncome: null,
      assumptions: [
        `Foreign tax of ${foreignTaxPaid.toFixed(2)} is within the $1,000 the ATO allows to be `
        + 'claimed without working out a limit, so it is claimed in full.',
      ],
    };
  }

  const taxableIncome = Math.max(0, round2(input.taxableIncome));

  // Step 2 — the comparison. Without rates there is nothing to compare, so the
  // floor is all that survives.
  if (!input.taxOn) {
    return {
      foreignTaxPaid,
      foreignIncome,
      limit: FITO_NO_CALCULATION_LIMIT,
      offset: Math.min(foreignTaxPaid, FITO_NO_CALCULATION_LIMIT),
      unclaimable: round2(Math.max(0, foreignTaxPaid - FITO_NO_CALCULATION_LIMIT)),
      underNoCalculationLimit: false,
      taxWithForeignIncome: null,
      taxWithoutForeignIncome: null,
      assumptions: [
        'Ledger holds no tax rates for this year, so the offset limit could not be worked out. '
        + 'Only the $1,000 every taxpayer may claim without a calculation is shown.',
      ],
    };
  }

  const taxWithForeignIncome = round2(Math.max(0, input.taxOn(taxableIncome)));
  const taxWithoutForeignIncome = round2(
    Math.max(0, input.taxOn(Math.max(0, round2(taxableIncome - foreignIncome)))),
  );
  const attributable = round2(Math.max(0, taxWithForeignIncome - taxWithoutForeignIncome));
  const limit = Math.max(FITO_NO_CALCULATION_LIMIT, attributable);
  const offset = round2(Math.min(foreignTaxPaid, limit));

  assumptions.push(
    'The limit is the Australian tax on your income with the foreign income in it, less the tax on '
    + 'the same income with it taken out — the tax the foreign income actually attracted.',
  );
  assumptions.push(
    'Deductions that relate to the foreign income are not taken out alongside it, because Ledger '
    + 'does not know which of your deductions those are. That makes the limit larger than it would '
    + 'otherwise be, so the claim shown here is the most you could be entitled to, not the least.',
  );
  if (foreignIncome === 0) {
    assumptions.push(
      'No foreign income was recorded against the foreign tax, so the comparison had nothing to '
      + 'take out and only the $1,000 floor applies.',
    );
  }

  return {
    foreignTaxPaid,
    foreignIncome,
    limit: round2(limit),
    offset,
    unclaimable: round2(Math.max(0, foreignTaxPaid - offset)),
    underNoCalculationLimit: false,
    taxWithForeignIncome,
    taxWithoutForeignIncome,
    assumptions,
  };
}
