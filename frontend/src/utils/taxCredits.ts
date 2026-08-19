/**
 * Phase 5.2 — TAX ALREADY PAID, beyond PAYG withholding.
 *
 * The settlement engine compares a year's liability against everything already
 * paid towards it. Ledger derives the biggest term itself — PAYG withheld, which
 * payslips and income entries both carry — and cannot derive the rest:
 *
 *   • PAYG instalments  — quarterly amounts paid straight to the ATO. They leave
 *                         the bank as a transfer to a government payee, with no
 *                         marker that says "this was tax", so a bank feed cannot
 *                         tell one from any other payment.
 *   • Franking credits  — printed on a dividend statement, never on the payment.
 *                         Ledger records the CASH dividend that hit the account.
 *   • Other tax paid    — TFN amounts withheld from interest, no-ABN withholding,
 *                         a foreign income tax offset: all return-level figures.
 *
 * So they are USER-SUPPLIED, default to nothing, and are recorded PER FINANCIAL
 * YEAR because every one is an annual figure. Same shape and same rules as
 * repaymentIncome.ts: bad values read as zero, so a corrupted bucket degrades to
 * "nothing else was paid" — which understates a refund and can never invent one.
 *
 * FRANKING CREDITS ARE NOT FREE MONEY. A franking credit is company tax already
 * paid on your behalf, so the ATO adds it to your assessable income (the
 * "gross-up") and then credits it against your bill. Ledger does BOTH: the Tax
 * page adds the credit to the income the estimate is run on, and the settlement
 * counts it on the credit side. Counting only the credit would overstate every
 * refund, which is why the two halves are deliberately not separable here.
 *
 * Nothing in this module knows a rate. It answers "what has already been paid".
 */

/** The per-FY amounts the user supplies. Annual dollars, entered positive. */
export interface TaxCredits {
  /** PAYG instalments paid to the ATO during the year. */
  paygInstalments: number;
  /** Franking (imputation) credits on franked dividends received. */
  frankingCredits: number;
  /** Any other tax already paid or credited for the year. */
  otherTaxPaid: number;
}

export type TaxCreditField = keyof TaxCredits;

/**
 * Field metadata; the editor renders this list rather than hard-coding inputs,
 * so adding a credit is a data change. `grossesUp` marks the one term that also
 * has to be added to assessable income — see the note above.
 */
export const TAX_CREDIT_FIELDS: {
  key: TaxCreditField;
  label: string;
  help: string;
  grossesUp?: true;
}[] = [
  {
    key: 'paygInstalments',
    label: 'PAYG instalments paid',
    help: 'Instalments you paid the ATO during the year, usually quarterly. Not the tax withheld from your pay — that is already counted.',
  },
  {
    key: 'frankingCredits',
    label: 'Franking credits',
    help: 'Imputation credits from your dividend statements. Ledger adds these to your assessable income as well as crediting them, which is how the ATO treats them.',
    grossesUp: true,
  },
  {
    key: 'otherTaxPaid',
    label: 'Other tax paid or withheld',
    help: 'TFN amounts withheld from interest, no-ABN withholding, a foreign income tax offset — anything already paid that is not above.',
  },
];

export function emptyTaxCredits(): TaxCredits {
  return { paygInstalments: 0, frankingCredits: 0, otherTaxPaid: 0 };
}

/** A positive, finite number — anything else reads as nothing supplied. */
function amount(v: unknown): number {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
  return Number.isFinite(n) && n > 0 ? round2(n) : 0;
}

/**
 * Coerce whatever came out of storage (or a form) into the record. Unknown keys
 * are dropped and bad values read as zero.
 */
export function normaliseTaxCredits(raw: unknown): TaxCredits {
  const src = (raw ?? {}) as Record<string, unknown>;
  const out = emptyTaxCredits();
  for (const f of TAX_CREDIT_FIELDS) out[f.key] = amount(src[f.key]);
  return out;
}

/** True when the user has entered anything — keeps the UI quiet by default. */
export function hasTaxCredits(c: TaxCredits | null | undefined): boolean {
  if (!c) return false;
  return TAX_CREDIT_FIELDS.some(f => amount(c[f.key]) > 0);
}

/** Everything supplied, added up. */
export function totalTaxCredits(c: TaxCredits | null | undefined): number {
  const n = normaliseTaxCredits(c);
  return round2(TAX_CREDIT_FIELDS.reduce((s, f) => s + n[f.key], 0));
}

/**
 * The amount that must ALSO be added to assessable income before the estimate is
 * run. Today that is the franking credits and nothing else; callers ask this
 * rather than reaching for `.frankingCredits`, so a future grossed-up credit is
 * handled everywhere at once.
 */
export function grossUpFor(c: TaxCredits | null | undefined): number {
  const n = normaliseTaxCredits(c);
  return round2(
    TAX_CREDIT_FIELDS.filter(f => f.grossesUp).reduce((s, f) => s + n[f.key], 0),
  );
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
