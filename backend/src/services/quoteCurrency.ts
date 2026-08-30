/**
 * QUOTE CURRENCIES THAT ARE NOT THE CURRENCY.
 *
 * A price feed does not always quote a security in the currency it settles in.
 * London is the one that matters here: Yahoo returns BP.L at 514.5 with the
 * currency string `GBp` — five hundred and fourteen and a half PENCE, £5.145 a
 * share. Not every London line does it (`VUSA.L` comes back as plain `GBP`), so
 * the exchange cannot decide it; only the currency string on the quote can.
 *
 * `GBp` is not an ISO 4217 code and nothing downstream knows what to do with it:
 *
 *   • Yahoo's FX endpoint resolves `GBpAUD=X` straight to `GBPAUD=X` and answers
 *     with the POUND rate, so a pence price got converted as if it were pounds —
 *     a UK holding was carried at ONE HUNDRED TIMES its worth, in the Investments
 *     total, in net worth, in the recorded history and in every sale the Sell
 *     dialog prefilled from it.
 *   • Frankfurter has no `GBp` at all, so the sanity-check rate that would have
 *     caught it never existed.
 *   • `String(from).toUpperCase()` on the /fxrate route turns `GBp` into `GBP`,
 *     which destroys the only evidence that the number was in pence.
 *
 * So the minor unit is folded into its major one HERE, at the boundary where the
 * quote arrives, and nothing further in is ever shown a currency that isn't ISO.
 * The rate layer knows the same table, because rows written before this existed
 * still carry `GBp` and a pence price, and they must read correctly without a
 * migration: asked for GBp→AUD it answers the pound rate divided by a hundred,
 * which values a pence price correctly.
 *
 * MATCHING IS CASE-SENSITIVE, deliberately. `GBp` is pence and `GBP` is pounds;
 * a case-insensitive table would value every British holding at a hundredth.
 */

interface MinorUnit {
  /** The ISO 4217 code the minor unit belongs to. */
  iso: string;
  /** How many minor units make one of the major. */
  per: number;
}

/**
 * Every non-ISO quote currency a feed in this app can return, with the ISO code
 * it is a fraction of. The variants are all real: Yahoo says `GBp`, some feeds
 * say `GBX`; Johannesburg quotes in cents (`ZAc`/`ZAX`) and Tel Aviv in agorot
 * (`ILA`). No entry may ever be the plain ISO code itself.
 */
const MINOR_UNITS: Record<string, MinorUnit> = {
  GBp: { iso: 'GBP', per: 100 },
  GBX: { iso: 'GBP', per: 100 },
  GBx: { iso: 'GBP', per: 100 },
  ZAc: { iso: 'ZAR', per: 100 },
  ZAX: { iso: 'ZAR', per: 100 },
  ILA: { iso: 'ILS', per: 100 },
  ILa: { iso: 'ILS', per: 100 },
};

/**
 * The ISO currency a quote code belongs to, and how many of it make one unit.
 * An ordinary code is its own answer with a divisor of 1, so callers can apply
 * this unconditionally.
 */
export function majorUnitOf(code: string | null | undefined): { currency: string; per: number } {
  const raw = String(code ?? '').trim();
  const minor = MINOR_UNITS[raw];
  if (minor) return { currency: minor.iso, per: minor.per };
  return { currency: raw.toUpperCase(), per: 1 };
}

/** Whether a code is a minor unit rather than a currency in its own right. */
export function isMinorUnit(code: string | null | undefined): boolean {
  return majorUnitOf(code).per !== 1;
}

/**
 * A quote restated in the currency it settles in: 514.5 GBp becomes 5.145 GBP.
 * Anything already ISO comes back untouched, including its exact number, so this
 * is safe to run over every quote the app takes in.
 *
 * The price keeps full precision — it is divided, never rounded. Rounding a
 * pence price to whole pounds would lose two decimal places of a real quote.
 */
export function normaliseQuote(
  price: number,
  currency: string | null | undefined,
): { price: number; currency: string } {
  const { currency: iso, per } = majorUnitOf(currency);
  return { price: per === 1 ? price : price / per, currency: iso };
}
