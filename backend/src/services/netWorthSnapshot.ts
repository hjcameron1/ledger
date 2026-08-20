import { supabase } from '../utils/supabase';
import { convertAmount } from './currencyService';
import { investmentRate, investmentValueInPreferred } from './investmentValue';

export interface NetWorthItem {
  item_type: 'bank' | 'investment' | 'super' | 'smsf' | 'credit_card' | 'loan' | 'property';
  item_id: string;
  name: string;
  value: number;   // in preferred currency
  is_debt: boolean;
}

export interface NetWorthBreakdown {
  netWorth: number;
  bankBalance: number;
  investments: number;
  creditCardDebt: number;
  super: number;
  /** Owned share of every property's value. Its mortgage is NOT netted off here —
   *  a linked loan is already subtracted once through the loans total. The one
   *  exception is a mortgage opted OUT of net worth, which `loans` skips: that one
   *  is netted here, so the debt still lands exactly once. */
  property: number;
  /** Loan balances counted as debt — the term that nets off property mortgages.
   *  Reported so the breakdown reconciles to `netWorth`. */
  loans: number;
  currency: string;
  items: NetWorthItem[];
  /** Items that EXIST but the user has switched off — a hidden account, an opted-out
   *  loan or super fund, a property excluded from net worth. They are not in `items`,
   *  and the net-worth SERIES drops their history too, so switching something off
   *  leaves no trace of it anywhere: not in the total, not in the graph, not in the
   *  movers. Deleted rows are deliberately NOT in here — an account that existed and
   *  is now gone keeps its recorded history, because what it did really happened. */
  excludedItems: { item_type: NetWorthItem['item_type']; item_id: string }[];
}

/** The bits of a loan row this file needs to decide whether it is counted. */
export interface NetWorthLoanRow {
  id: string;
  current_balance: number | string | null;
  include_in_net_worth?: boolean | null;
}

/** The bits of a property row this file needs. Loose, because the columns arrive
 *  from `select('*')` and some are absent until the property migrations run. */
export interface NetWorthPropertyRow {
  current_value?: number | string | null;
  ownership_percent?: number | string | null;
  include_in_net_worth?: boolean | null;
  held_by?: string | null;
  smsf_fund_id?: string | null;
  super_fund_id?: string | null;
  counted_in_fund_balance?: boolean | null;
  loan_id?: string | null;
}

/**
 * What one property contributes to net worth. The server's copy of the client
 * engine's `netWorthValue` (frontend/src/utils/property.ts) — kept a pure function
 * of its arguments precisely so it can be tested against the same cases, because
 * the two implementations disagreeing is the failure mode that matters here.
 *
 *   • opted out            → 0. The debt is left to the loans total: switching an
 *                            asset off is not a claim the money stopped being owed.
 *   • already in a fund    → no asset (the fund's balance carries the value), but
 *                            an uncounted mortgage is still netted: a fund balance
 *                            says what the property is WORTH, not what is owed.
 *   • otherwise            → owned share of the value…
 *   • …less the mortgage   → only when the loan is itself opted out, because then
 *                            the loans total skips it and nothing else would.
 *
 * The last rule is what makes "counted exactly once" hold for every combination of
 * the two switches: either the loans total subtracts a balance or this does.
 */
export function propertyNetWorthValue(
  pr: NetWorthPropertyRow,
  loansById: Map<string, NetWorthLoanRow>,
): number {
  if (pr.include_in_net_worth === false) return 0;

  const heldInFund =
    pr.held_by === 'smsf' &&
    (pr.smsf_fund_id != null || pr.super_fund_id != null) &&
    pr.counted_in_fund_balance !== false;

  let value = 0;
  if (!heldInFund) {
    const share = pr.ownership_percent == null ? 100 : Number(pr.ownership_percent);
    const pct = Number.isFinite(share) ? Math.min(100, Math.max(0, share)) : 100;
    value = ((Number(pr.current_value) || 0) * pct) / 100;
  }

  const loan = pr.loan_id ? loansById.get(String(pr.loan_id)) : undefined;
  // Counted loans (include_in_net_worth true, or legacy null/undefined) are
  // subtracted by the loans total, so netting them here as well would double it.
  const uncountedMortgage =
    loan && loan.include_in_net_worth === false ? Number(loan.current_balance) || 0 : 0;

  return value - uncountedMortgage;
}

/**
 * The `property` line of net worth — what every property contributes between them.
 *
 * Exported because there are three places on this server that state a net worth
 * (this file, the morning briefing and the chat bot's grounding summary) and they
 * must not each carry their own idea of what a house is worth. Before this the
 * other two simply left property out, so the briefing subtracted a mortgage while
 * never counting the house it bought.
 */
export function propertyNetWorthTotal(
  properties: NetWorthPropertyRow[] | null | undefined,
  loans: NetWorthLoanRow[] | null | undefined,
): number {
  const loansById = new Map<string, NetWorthLoanRow>((loans ?? []).map(l => [String(l.id), l]));
  const total = (properties ?? []).reduce((sum, pr) => sum + propertyNetWorthValue(pr, loansById), 0);
  return parseFloat(total.toFixed(2));
}

/**
 * Compute a user's net worth in their preferred currency.
 *
 *   net worth = bank accounts + investments + super + property − credit-card debt − loans
 *
 * "super" includes both regular super_funds AND SMSF asset totals, each gated by
 * its own include_in_net_worth flag. Income is intentionally NOT a separate
 * component: pay lands in a bank account, so it's already reflected in the bank
 * balance — counting income on top would double-count it.
 *
 * "property" is the OWNED SHARE of each property's value: a property's mortgage is
 * an ordinary loan row, already subtracted by the loans term, so netting it here
 * as well would count the same debt twice. A property whose holding SMSF/super
 * fund already lists it contributes nothing here for the same reason — that fund's
 * balance is already carrying the value.
 *
 * The single exception is a mortgage the user has opted OUT of net worth. The
 * loans term skips it, so the property nets it instead and a $1m house with $800k
 * owing still moves net worth by $200k rather than by the full $1m. Exactly one of
 * the two terms ever subtracts a given balance.
 */
export async function computeNetWorth(userId: string): Promise<NetWorthBreakdown> {
  const [
    { data: user },
    { data: accounts },
    { data: investments },
    { data: creditCards },
    { data: superFunds },
    { data: smsfFunds },
    { data: smsfAssets },
    { data: loans },
    { data: properties },
  ] = await Promise.all([
    supabase.from('users').select('currency_preference').eq('id', userId).single(),
    // select('*') (not an explicit column list) so this keeps working before the
    // bank_accounts.hidden migration is applied: a missing `hidden` column would make
    // PostgREST 400 the whole query, zeroing net worth. With '*', `hidden` is simply
    // absent (⇒ undefined ⇒ treated as not-hidden) until the column exists.
    supabase.from('bank_accounts').select('*').eq('user_id', userId),
    // asset_type/conversion_rate/display_currency are here for the rate rule, not
    // for display — see investmentRate.
    supabase.from('investments').select('id, name, current_value, native_currency, asset_type, conversion_rate, display_currency').eq('user_id', userId),
    supabase.from('credit_cards').select('id, name, institution, balance_owing, currency').eq('user_id', userId),
    supabase.from('super_funds').select('id, fund_name, balance, include_in_net_worth').eq('user_id', userId),
    supabase.from('smsf_funds').select('id, name, include_in_net_worth').eq('user_id', userId),
    supabase.from('smsf_assets').select('fund_id, amount').eq('user_id', userId),
    supabase.from('loans').select('id, name, current_balance, include_in_net_worth').eq('user_id', userId),
    // select('*') for the same reason as bank_accounts above: an explicit column
    // list 400s the whole query while the property-refinement columns (held_by,
    // smsf_fund_id, counted_in_fund_balance) are still missing, and with '*' they
    // simply read as undefined. Until the Phase 4.1 migration is applied at all
    // this errors and `data` is null, which degrades to "no properties" rather
    // than zeroing the whole net worth.
    supabase.from('properties').select('*').eq('user_id', userId),
  ]);

  const pref = user?.currency_preference ?? 'AUD';
  const items: NetWorthItem[] = [];
  const excludedItems: NetWorthBreakdown['excludedItems'] = [];
  const excluded = (item_type: NetWorthItem['item_type'], item_id: unknown) =>
    excludedItems.push({ item_type, item_id: String(item_id) });

  let bankBalance = 0;
  for (const acc of accounts ?? []) {
    // Hidden accounts are excluded from net worth (mirrors the super/loan opt-out).
    if ((acc as { hidden?: boolean }).hidden === true) { excluded('bank', acc.id); continue; }
    const { converted } = await convertAmount(acc.balance, acc.currency ?? 'AUD', pref);
    bankBalance += converted;
    items.push({ item_type: 'bank', item_id: String(acc.id), name: acc.name || acc.institution || 'Bank account', value: parseFloat(converted.toFixed(2)), is_debt: false });
  }

  let investmentsTotal = 0;
  for (const inv of investments ?? []) {
    // ONE value base with the Investments page, the client's own net-worth sum and
    // the movers list: native value × the rate PINNED on the row at the last price
    // refresh. This used to convert at a LIVE rate, which meant every snapshot was
    // recorded on a different base from the figure printed on the screen — so
    // subtracting the two produced a "change today" that was partly just the two
    // methods disagreeing, and no item in the breakdown could ever account for it.
    // (Snapshots written before this change sit on the old base, so the series has
    // one small step at the changeover. A step once beats a drift forever.)
    const converted = await investmentValueInPreferred(inv, pref);
    investmentsTotal += converted;
    items.push({ item_type: 'investment', item_id: String(inv.id), name: inv.name || 'Investment', value: converted, is_debt: false });
  }

  let creditCardDebt = 0;
  for (const cc of creditCards ?? []) {
    const { converted } = await convertAmount(cc.balance_owing, cc.currency ?? 'AUD', pref);
    creditCardDebt += converted;
    items.push({ item_type: 'credit_card', item_id: String(cc.id), name: cc.name || cc.institution || 'Credit card', value: parseFloat(converted.toFixed(2)), is_debt: true });
  }

  let superTotal = 0;
  for (const sf of superFunds ?? []) {
    // Opt-out: legacy rows have include_in_net_worth null → treat as included.
    if (sf.include_in_net_worth !== false) {
      const v = Number(sf.balance) || 0;
      superTotal += v;
      items.push({ item_type: 'super', item_id: String(sf.id), name: sf.fund_name || 'Super fund', value: parseFloat(v.toFixed(2)), is_debt: false });
    } else {
      excluded('super', sf.id);
    }
  }

  // SMSF: sum each included fund's asset totals (assets are stored in AUD).
  const includedFunds = (smsfFunds ?? []).filter(f => f.include_in_net_worth);
  const includedFundIds = new Set(includedFunds.map(f => f.id as string));
  for (const f of smsfFunds ?? []) if (!includedFundIds.has(f.id as string)) excluded('smsf', f.id);
  const smsfTotalByFund = new Map<string, number>();
  for (const a of smsfAssets ?? []) {
    const fid = a.fund_id as string;
    if (includedFundIds.has(fid)) {
      const v = Number(a.amount) || 0;
      superTotal += v;
      smsfTotalByFund.set(fid, (smsfTotalByFund.get(fid) ?? 0) + v);
    }
  }
  for (const f of includedFunds) {
    const v = smsfTotalByFund.get(f.id as string);
    if (v !== undefined) items.push({ item_type: 'smsf', item_id: String(f.id), name: (f as { name?: string }).name || 'SMSF', value: parseFloat(v.toFixed(2)), is_debt: false });
  }

  // Loans: subtract each loan's current balance when opted into net worth.
  // Legacy rows have include_in_net_worth null → treat as included.
  const loansById = new Map<string, NetWorthLoanRow>(
    (loans ?? []).map(ln => [String(ln.id), ln as NetWorthLoanRow]),
  );
  let loanDebt = 0;
  for (const ln of loans ?? []) {
    if (ln.include_in_net_worth !== false) {
      const v = Number(ln.current_balance) || 0;
      loanDebt += v;
      items.push({ item_type: 'loan', item_id: String(ln.id), name: (ln as { name?: string }).name || 'Loan', value: parseFloat(v.toFixed(2)), is_debt: true });
    } else {
      excluded('loan', ln.id);
    }
  }

  // Properties: add only the share the user owns. The linked mortgage is NOT
  // subtracted here — it is one of the loans already counted above, and netting
  // it a second time would understate net worth by the whole balance. The one
  // exception, and the only debt this term ever nets, is a mortgage the user has
  // opted OUT of net worth: the loans total skipped it, so without this the house
  // would be counted as though it were owned outright. See propertyNetWorthValue.
  //
  // Nor is the value added when the SMSF (or super fund) holding the property
  // already lists it: that fund's balance went into `superTotal` above, so adding
  // the property here as well would count the same house twice. This mirrors
  // countedInFund() in the frontend engine exactly — deliberately property-local,
  // never consulting the fund's own include_in_net_worth, so the two
  // implementations can't drift apart.
  let propertyTotal = 0;
  for (const pr of properties ?? []) {
    if (pr.include_in_net_worth === false) { excluded('property', pr.id); continue; }
    const v = propertyNetWorthValue(pr as NetWorthPropertyRow, loansById);
    // An in-fund property with a counted mortgage contributes nothing at all;
    // listing a 0 would put a phantom mover in the per-item breakdown.
    if (v === 0) { excluded('property', pr.id); continue; }
    propertyTotal += v;
    // The nickname is optional, so fall back to the address the way the client
    // labels a property — the movers list must never read just "Property".
    const p = pr as { name?: string | null; address_street?: string | null; address_suburb?: string | null; address?: string | null };
    const streetLabel = [p.address_street, p.address_suburb].filter(Boolean).join(', ');
    const label = p.name || streetLabel || p.address || 'Property';
    items.push({ item_type: 'property', item_id: String(pr.id), name: label, value: parseFloat(v.toFixed(2)), is_debt: false });
  }

  const netWorth = bankBalance + investmentsTotal + superTotal + propertyTotal - creditCardDebt - loanDebt;

  return {
    netWorth: parseFloat(netWorth.toFixed(2)),
    bankBalance: parseFloat(bankBalance.toFixed(2)),
    investments: parseFloat(investmentsTotal.toFixed(2)),
    creditCardDebt: parseFloat(creditCardDebt.toFixed(2)),
    super: parseFloat(superTotal.toFixed(2)),
    property: parseFloat(propertyTotal.toFixed(2)),
    loans: parseFloat(loanDebt.toFixed(2)),
    currency: pref,
    items,
    excludedItems,
  };
}

/** Compute and persist a net-worth snapshot row (total + per-item breakdown). */
/** Item-set (type:id) of the most recent snapshot, or null if none exists yet. */
async function lastSnapshotItemKeys(userId: string): Promise<Set<string> | null> {
  const { data: latest } = await supabase
    .from('net_worth_item_history')
    .select('recorded_at')
    .eq('user_id', userId)
    .order('recorded_at', { ascending: false })
    .limit(1);
  const t = latest?.[0]?.recorded_at as string | undefined;
  if (!t) return null;
  const { data: rows } = await supabase
    .from('net_worth_item_history')
    .select('item_type, item_id')
    .eq('user_id', userId)
    .eq('recorded_at', t);
  return new Set((rows ?? []).map(r => `${r.item_type}:${r.item_id}`));
}

export async function recordNetWorthSnapshot(userId: string): Promise<NetWorthBreakdown> {
  const nw = await computeNetWorth(userId);
  const recordedAt = new Date().toISOString();

  // Nothing to track yet (no accounts/investments/super/cards/loans at all). Recording
  // a 0 here seeds a 0 baseline that poisons the whole % series (every "since tracking"
  // number is then measured against 0). Skip until there is real data to snapshot.
  if (nw.items.length === 0) return nw;

  // ── OUTLIER GUARD ──────────────────────────────────────────────────────────
  // Snapshots fire fire-and-forget on EVERY account/investment/loan mutation, so a
  // bulk edit or an import that briefly leaves balances half-written can capture a
  // transient state where the total is wildly off. Those bad points poisoned the
  // adjusted % trend (e.g. a −32% dip when nothing really changed). If the freshly
  // computed total swings more than 25% away from the most recent snapshot taken in
  // the last 2 hours, treat it as a transient/corrupt read and SKIP recording — the
  // next snapshot (hourly cron, or the next settled edit) captures reality, and the
  // adjusted series already neutralises genuine add/remove jumps via its base, so
  // skipping one snapshot is harmless. Only intra-session swings are gated; slow
  // drift over hours/days is never affected.
  const { data: recent } = await supabase
    .from('net_worth_history')
    .select('total_value, recorded_at')
    .eq('user_id', userId)
    .order('recorded_at', { ascending: false })
    .limit(1);
  const last = recent?.[0];
  if (last) {
    const lastVal = Number(last.total_value);
    const ageMs = Date.now() - new Date(last.recorded_at as string).getTime();
    const withinTwoHours = ageMs >= 0 && ageMs <= 2 * 60 * 60 * 1000;
    const deviation = Math.abs(lastVal) > 1 ? Math.abs(nw.netWorth - lastVal) / Math.abs(lastVal) : 0;
    if (withinTwoHours && deviation > 0.25) {
      // A big swing is only a "corrupt read" when the SAME items are present but their
      // values are momentarily wrong (e.g. a failed FX/price read valuing a foreign
      // holding at par). If the item SET changed — an account was added or removed —
      // the jump is a REAL structural change that MUST be recorded, otherwise the new
      // item never enters item-history and the adjusted series can't neutralise it
      // (which is exactly what stranded a freshly-linked Basiq account outside the
      // structural adjustment, spiking the headline). Skip only same-set swings.
      const prevKeys = await lastSnapshotItemKeys(userId);
      const curKeys = new Set(nw.items.map(it => `${it.item_type}:${it.item_id}`));
      const sameItemSet =
        prevKeys != null &&
        prevKeys.size === curKeys.size &&
        [...curKeys].every(k => prevKeys.has(k));
      if (sameItemSet) {
        console.warn(
          `[SNAPSHOT] Skipping outlier net-worth snapshot for ${userId}: ` +
          `${lastVal.toFixed(2)} → ${nw.netWorth.toFixed(2)} (${(deviation * 100).toFixed(1)}% swing in ` +
          `${Math.round(ageMs / 60000)}min, item set unchanged) — likely a transient bad read, not recorded.`,
        );
        return nw;
      }
    }
  }
  // recorded_at is written explicitly so intraday snapshots order correctly on the
  // Daily chart. NOTE: this relies on the legacy UNIQUE(user_id, recorded_date)
  // constraint having been dropped (see migration) — with it in place only the
  // first snapshot of each day persists and the rest fail as duplicates.
  const { error: histErr } = await supabase.from('net_worth_history').insert({
    user_id: userId,
    total_value: nw.netWorth,
    recorded_at: recordedAt,
    recorded_date: recordedAt.split('T')[0],
  });
  if (histErr) console.error('[SNAPSHOT] net_worth_history insert failed:', histErr.message);
  if (nw.items.length) {
    await supabase.from('net_worth_item_history').insert(
      nw.items.map(it => ({
        user_id: userId,
        recorded_at: recordedAt,
        item_type: it.item_type,
        item_id: it.item_id,
        name: it.name,
        value: it.value,
        is_debt: it.is_debt,
      })),
    );
  }
  return nw;
}

export interface ItemChange {
  item_type: string;
  item_id: string;
  name: string;
  is_debt: boolean;
  start_value: number;   // value at window start (baseline)
  current_value: number; // latest value
  change: number;        // current - start (raw value movement)
  contribution: number;  // signed effect on net worth (debt increase is negative)
  /** True when the item is no longer part of net worth — deleted, hidden, or
   *  switched off. Its current value is 0, and its going is STRUCTURAL, not a
   *  loss, so the breakdown hides it while "ignore added/removed" is on. */
  removed: boolean;
}

/** One row of per-item snapshot history (the pure change-builder's input). */
export interface ItemChangeInputRow {
  recorded_at: string;
  item_type: string;
  item_id: string;
  name: string;
  value: number;
  is_debt: boolean;
}

/** An internal-transfer leg, keyed "type:account_id", in the preferred currency. */
export interface ItemTransferLeg {
  key: string;
  createdMs: number;
  inflowPref: number;   // signed "money into the account"
}

/**
 * PURE core of the per-item breakdown — no DB, fully testable.
 *
 * The subtlety this exists for: an item stops being written to history the moment
 * it leaves net worth (a property switched off, a hidden account, a deleted loan).
 * Reading "current value" as simply its LAST recorded row then freezes it in the
 * movers list at whatever it was worth on the way out — so a property the user has
 * excluded goes on reporting a six-figure move forever, long after it stopped
 * counting for anything. An item missing from the newest snapshot is worth 0 to net
 * worth now, and if it was already gone when the window opened it neither added nor
 * subtracted anything inside it.
 */
export function buildItemChanges(
  rows: ItemChangeInputRow[],
  startMs?: number,
  legs: ItemTransferLeg[] = [],
): ItemChange[] {
  // Group rows per item, in ascending time order.
  const byItem = new Map<string, ItemChangeInputRow[]>();
  let latestMs = 0;
  for (const r of rows) {
    const key = `${r.item_type}:${r.item_id}`;
    if (!byItem.has(key)) byItem.set(key, []);
    byItem.get(key)!.push(r);
    latestMs = Math.max(latestMs, new Date(r.recorded_at).getTime());
  }

  const items: ItemChange[] = [];
  for (const series of byItem.values()) {
    if (series.length === 0) continue;
    const latest = series[series.length - 1];
    const latestItemMs = new Date(latest.recorded_at).getTime();
    // Every item of one snapshot shares its recorded_at, so an item whose last row
    // predates the newest snapshot was not in it — it has left net worth.
    const removed = latestItemMs < latestMs;

    // Baseline = last snapshot at/before startMs, else earliest snapshot.
    let baseline = series[0];
    if (startMs) {
      for (const r of series) {
        if (new Date(r.recorded_at).getTime() <= startMs) baseline = r;
        else break;
      }
    }
    // Gone before the window even opened ⇒ it was already worth nothing at the
    // start too, so it contributes 0 rather than a stale drop dated to today.
    const goneBeforeWindow = removed && startMs != null && latestItemMs <= startMs;
    const startValue = goneBeforeWindow ? 0 : Number(baseline.value);
    const currentValue = removed ? 0 : Number(latest.value);
    let change = currentValue - startValue;

    // Strip internal-transfer flow that landed AFTER this item's baseline snapshot
    // (transfers already in the baseline value are in both endpoints, so they net
    // out of `change` on their own). A bank item's value moves +inflow; a credit
    // card's value is balance_owing, which moves −inflow (money in pays it down).
    // Skipped for a removed item: its drop to 0 is structural, not spending.
    if (!removed && (latest.item_type === 'bank' || latest.item_type === 'credit_card')) {
      const baselineMs = new Date(baseline.recorded_at).getTime();
      const itemKey = `${latest.item_type}:${String(latest.item_id)}`;
      let inflow = 0;
      for (const leg of legs) {
        if (leg.key === itemKey && leg.createdMs > baselineMs) inflow += leg.inflowPref;
      }
      change -= latest.item_type === 'bank' ? inflow : -inflow;
    }

    const contribution = latest.is_debt ? -change : change;
    items.push({
      item_type: latest.item_type,
      item_id: latest.item_id,
      name: latest.name,
      is_debt: latest.is_debt,
      start_value: parseFloat(startValue.toFixed(2)),
      current_value: parseFloat(currentValue.toFixed(2)),
      change: parseFloat(change.toFixed(2)),
      contribution: parseFloat(contribution.toFixed(2)),
      removed,
    });
  }

  items.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
  return items;
}

/** A live holding, already valued in the owner's currency (see investmentValue). */
export interface DailyInvestment {
  id: string;
  /** current_value × the pinned rate — the same figure the Investments page shows. */
  valuePref: number;
  nativeCurrency: string;
  /** Price move since the previous close, or null when there is no market quote. */
  dayChangePercent: number | null;
}

/**
 * The DAILY window's investment maths — the one place "today" is defined for a
 * holding, and the reason the breakdown ADDS UP to the headline.
 *
 * Two rulers have to agree here, and they pull in different directions:
 *
 *   • A holding's own row must read exactly as the Investments page does — the
 *     PRICE move since the previous close, because a share's performance is not
 *     a currency story, and two pages disagreeing about one holding is a bug.
 *   • The rows together must sum to the headline change, which is measured off
 *     the recorded net-worth series. A popup that doesn't reconcile to the number
 *     above it is not a breakdown of anything.
 *
 * The only definition of the currency row that satisfies both at once is THE
 * REMAINDER: whatever is left of each holding's actual movement in the window
 * (live value now, minus its recorded value at the window start — the exact
 * quantity the headline is made of) once the price move is taken out. On the
 * one-value-base regime (see investmentValue) that remainder IS the exchange
 * rate's move; defining it as the remainder rather than re-deriving it from a
 * live FX quote is what makes the sum close exactly instead of approximately.
 * An earlier version asked Yahoo for the rate's own day change — a THIRD ruler,
 * measuring a different window than the series, which left the popup $185 away
 * from the headline with everything "correct". Never measure the same money two
 * ways.
 *
 * A holding with no market quote (a dealer-priced metal) can't split price from
 * rate, so its row keeps its full recorded movement and contributes nothing to
 * the currency row — the sum still closes.
 */
export function applyDailyMoves(
  items: ItemChange[],
  live: DailyInvestment[],
  preferred: string,
): ItemChange[] {
  const byId = new Map(live.map(l => [l.id, l]));
  const out = items.map(it => ({ ...it }));

  // Per currency: the residual (whole recorded move − price move) and the sleeve's
  // worth now, for the row's caption.
  const residual = new Map<string, number>();
  const sleeveNow = new Map<string, number>();

  for (const it of out) {
    if (it.item_type !== 'investment' || it.removed) continue;
    const inv = byId.get(String(it.item_id));
    if (!inv) continue;

    const curPref = inv.valuePref;
    // What the headline's series actually recorded for this holding at the window
    // start — buildItemChanges just set it. The whole move is measured from HERE.
    const histStart = it.start_value;
    const wholeMove = curPref - histStart;
    it.current_value = parseFloat(curPref.toFixed(2));

    const pct = inv.dayChangePercent;
    const priced = pct != null && Number.isFinite(pct) && pct > -100;
    if (!priced || inv.nativeCurrency === preferred) {
      // No price/rate split to make: the row carries its full recorded movement,
      // so nothing is lost and nothing lands in the currency row.
      it.change = parseFloat(wholeMove.toFixed(2));
      it.contribution = it.change;
      continue;
    }

    // The Investments-page "today": price move since the previous close, valued at
    // today's rate. value ∝ price ⇒ value at prev close = value / (1 + pct/100).
    const priceMove = curPref - curPref / (1 + pct / 100);
    it.start_value = parseFloat((curPref - priceMove).toFixed(2));
    it.change = parseFloat(priceMove.toFixed(2));
    it.contribution = it.change; // investments never debt

    residual.set(inv.nativeCurrency, (residual.get(inv.nativeCurrency) ?? 0) + (wholeMove - priceMove));
    sleeveNow.set(inv.nativeCurrency, (sleeveNow.get(inv.nativeCurrency) ?? 0) + curPref);
  }

  for (const [native, change] of residual) {
    if (Math.abs(change) < 0.005) continue;
    const now = sleeveNow.get(native) ?? 0;
    out.push({
      item_type: 'currency',
      item_id: `${native}-${preferred}`,
      name: `${native} → ${preferred} exchange rate`,
      is_debt: false,
      start_value: parseFloat((now - change).toFixed(2)),
      current_value: parseFloat(now.toFixed(2)),
      change: parseFloat(change.toFixed(2)),
      contribution: parseFloat(change.toFixed(2)),
      removed: false,
    });
  }

  return out;
}

/**
 * Per-item change over a timeframe, sorted by biggest net-worth contribution.
 *   timeframe = daily | weekly | monthly | sixmonth | yearly | all
 * Baseline per item = its snapshot at/just-before the window start; if the item
 * has no snapshot before the window (added later), its earliest snapshot is used
 * so newly-added items don't masquerade as sudden gains. An item that has LEFT net
 * worth is flagged `removed` and valued at 0 — see buildItemChanges.
 */
export async function getItemChanges(userId: string, timeframe: string): Promise<{ items: ItemChange[]; currency: string }> {
  const { data: user } = await supabase.from('users').select('currency_preference').eq('id', userId).single();
  const currency = user?.currency_preference ?? 'AUD';

  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;
  const windowStart: Record<string, number> = {
    daily: now - DAY,
    weekly: now - 7 * DAY,
    monthly: now - 30 * DAY,
    sixmonth: now - 182 * DAY,
    yearly: now - 365 * DAY,
  };
  const startMs = windowStart[timeframe];

  // Fetch the full per-item history by paginating. A single .limit(N) query is
  // silently capped by PostgREST's max-rows setting (1000 on Supabase), so a bare
  // .limit(20000) ordered ascending returns only the OLDEST 1000 rows — never the
  // recent snapshots — which made every item's "latest" stale and equal to its
  // baseline, i.e. a 0.00% change everywhere. Paging in 1000-row chunks reads them
  // all regardless of the cap. The 200-page guard (≈200k rows) prevents runaway.
  const rows: Array<{
    recorded_at: string; item_type: string; item_id: string;
    name: string; value: number; is_debt: boolean;
  }> = [];
  const PAGE = 1000;
  for (let page = 0; page < 200; page++) {
    const { data: chunk, error } = await supabase
      .from('net_worth_item_history')
      .select('recorded_at, item_type, item_id, name, value, is_debt')
      .eq('user_id', userId)
      .order('recorded_at', { ascending: true })
      .range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) { console.error('[ITEM CHANGES] page fetch failed:', error.message); break; }
    if (!chunk || chunk.length === 0) break;
    rows.push(...(chunk as typeof rows));
    if (chunk.length < PAGE) break;
  }

  // ── Exclude internal transfers from the movers list ─────────────────────────
  // A transfer between the user's own accounts is net-worth-neutral: it moves
  // balance OUT of one account and INTO another, so both legs would otherwise
  // surface as large opposite movers even though the total never changed. We
  // subtract each account's net transfer flow (converted to the preferred
  // currency) from its raw balance change, so genuine spend/income/market moves
  // remain but the transfer's two halves both drop out. Every transfer leg is
  // stamped is_transfer / transfer_pair_id / transaction_type='transfer' by the
  // ingestion pipeline, so this is precise. Legs are keyed by "type:account_id"
  // with their real-time created_at (when the balance actually moved).
  const { data: transferLegs } = await supabase
    .from('transactions')
    .select('account_id, account_type, amount, currency, created_at')
    .eq('user_id', userId)
    .or('is_transfer.eq.true,transfer_pair_id.not.is.null,transaction_type.eq.transfer');
  const legs: ItemTransferLeg[] = [];
  for (const t of transferLegs ?? []) {
    if (!t.account_id) continue;
    // Only bank/credit-card accounts are net-worth items driven by a moving
    // balance; a loan leg (if any) isn't a mover in this list.
    if (t.account_type !== 'bank' && t.account_type !== 'credit_card') continue;
    const { converted } = await convertAmount(Number(t.amount) || 0, t.currency ?? 'AUD', currency);
    legs.push({
      key: `${t.account_type}:${String(t.account_id)}`,
      createdMs: t.created_at ? new Date(t.created_at).getTime() : 0,
      inflowPref: converted, // signed "money into the account", preferred currency
    });
  }

  // All the per-item maths lives in the pure builder (baselines, transfer stripping
  // and the removed-item rule).
  let items = buildItemChanges(rows, startMs, legs);

  // ── Authoritative DAILY change for investments ──────────────────────────────
  // For the "daily" window, an investment's true "today's move" is the market's
  // change since the PREVIOUS CLOSE (what CommSec and the Investments page show),
  // NOT the diff between two net-worth snapshots ~24h apart. Snapshot cadence makes
  // that 24h diff unreliable (it lands mid-session, or misses part of the move), so
  // the same holding read at two different moments gives two different numbers.
  //
  // Override each investment item's daily change with Yahoo's stored
  // day_change_percent applied to its current value (in preferred currency):
  //   value ∝ price ⇒ value_at_prev_close = value / (1 + pct/100)
  //   today's change = value − value_at_prev_close
  // This is generic across every holding (driven by each row's own % move) — no
  // per-ticker special-casing — and makes the Overview breakdown and the Telegram
  // briefing (both consumers of this function) agree with the Investments page.
  if (timeframe === 'daily') {
    const { data: liveInvs } = await supabase
      .from('investments')
      .select('id, current_value, native_currency, asset_type, conversion_rate, display_currency, day_change_percent')
      .eq('user_id', userId);

    const live: DailyInvestment[] = [];
    for (const inv of liveInvs ?? []) {
      live.push({
        id: String(inv.id),
        valuePref: (Number(inv.current_value) || 0) * (await investmentRate(inv, currency)),
        nativeCurrency: inv.native_currency || currency,
        dayChangePercent: inv.day_change_percent == null ? null : Number(inv.day_change_percent),
      });
    }

    items = applyDailyMoves(items, live, currency);
  }

  items.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
  return { items, currency };
}

export interface AdjustedNwPoint {
  recorded_at: string;
  value: number;    // raw net worth at the snapshot (sum of signed item values)
  base: number;     // "capital base" = sum of each active item's value when it FIRST appeared
  organic: number;  // value − base = movement since each item started being tracked
  pct: number;      // organic / base × 100 (money-weighted return, flat across add/remove)
}

export interface AdjustedNwSeries {
  points: AdjustedNwPoint[];
  baseline: number;     // base at the earliest snapshot
  currentBase: number;  // capital base of the CURRENT live item set (incl. carry) — drives the live headline
  currentValue: number; // raw net worth of the CURRENT ACTIVE live item set (no carry — used to reconcile client-only accounts)
  carryValue: number;   // frozen value of REMOVED items; add to live net worth for a seam-free organic
}

/** One row of per-item snapshot history (the pure builder's input). */
export interface AdjustedInputRow {
  recorded_at: string;
  item_type: string;
  item_id: string;
  value: number;
  is_debt: boolean;
}
/** A current live item (structurally compatible with NetWorthItem). */
export interface AdjustedLiveItem {
  item_type: string;
  item_id: string;
  value: number;
  is_debt: boolean;
}

/**
 * PURE core of the structural-adjustment series — no DB, fully testable.
 *
 * `base = Σ firstSigned` neutralises an item's CAPITAL when it's added or removed,
 * but on REMOVAL the item's accumulated gain/loss (value − firstSigned) would
 * otherwise vanish from the total and step the whole series — a removed/replaced
 * account is not a real gain. To keep add AND remove seam-free we FREEZE a removed
 * item's last value + base into a running carry (and unfreeze it if it reappears):
 *
 *   removal: activeValue −= v, activeBase −= f, carryValue += v, carryBase += f
 *            ⇒ value(=active+carry) and base unchanged ⇒ organic/pct continuous.
 *   add:     new item has firstSigned = its own value ⇒ value += v, base += v
 *            ⇒ organic unchanged.
 *
 * `excludedKeys` ("type:id") is different from either, and is the reason a house the
 * user had switched OFF still dragged the headline down by $850k: freezing preserves
 * a departed item's accumulated gain/loss forever, so anything that ever moved in
 * value went on moving the number long after it stopped counting. An item the user
 * has switched off is not a departure to be smoothed over — it is a statement that
 * it should never have counted, so its history is dropped from the series outright
 * and it leaves no trace at all. DELETED rows are not excluded keys: an account that
 * really existed and really lost money keeps that history, because it happened.
 */
export function buildAdjustedSeries(
  rows: AdjustedInputRow[],
  liveItems?: AdjustedLiveItem[],
  excludedKeys?: Iterable<string>,
): AdjustedNwSeries {
  const r2 = (n: number) => parseFloat(n.toFixed(2));
  const r4 = (n: number) => parseFloat(n.toFixed(4));

  const skip = new Set(excludedKeys ?? []);
  if (skip.size) rows = rows.filter(r => !skip.has(`${r.item_type}:${r.item_id}`));

  // First signed value per item (its "tracked-from" capital) + the active item set
  // at each snapshot timestamp, in chronological order.
  const firstSigned = new Map<string, number>();
  const snapItems = new Map<string, { key: string; signed: number }[]>();
  for (const row of rows) {
    const key = `${row.item_type}:${row.item_id}`;
    const signed = (row.is_debt ? -1 : 1) * Number(row.value);
    if (!firstSigned.has(key)) firstSigned.set(key, signed);
    if (!snapItems.has(row.recorded_at)) snapItems.set(row.recorded_at, []);
    snapItems.get(row.recorded_at)!.push({ key, signed });
  }

  const stamps = Array.from(snapItems.keys()).sort();
  let carryBase = 0;
  let carryValue = 0;
  const frozen = new Map<string, { base: number; value: number }>();
  let prev: Map<string, number> | null = null; // active key → last signed value

  const points: AdjustedNwPoint[] = stamps.map(t => {
    const arr = snapItems.get(t)!;
    const active = new Map<string, number>();
    let activeValue = 0;
    let activeBase = 0;
    for (const { key, signed } of arr) {
      active.set(key, signed);
      activeValue += signed;
      activeBase += firstSigned.get(key) ?? 0;
    }
    // A frozen item that reappears is live again → unfreeze it.
    for (const key of active.keys()) {
      const f = frozen.get(key);
      if (f) { carryBase -= f.base; carryValue -= f.value; frozen.delete(key); }
    }
    // An item active last snapshot but gone now → freeze at its last value.
    if (prev) {
      for (const [key, lastSigned] of prev) {
        if (!active.has(key) && !frozen.has(key)) {
          const b = firstSigned.get(key) ?? 0;
          frozen.set(key, { base: b, value: lastSigned });
          carryBase += b;
          carryValue += lastSigned;
        }
      }
    }
    const value = activeValue + carryValue;
    const base = activeBase + carryBase;
    const organic = value - base;
    prev = active;
    return {
      recorded_at: t,
      value: r2(value),
      base: r2(base),
      organic: r2(organic),
      pct: base > 0 ? r4((organic / base) * 100) : 0,
    };
  });

  const baseline = points[0]?.base ?? 0;

  // Live reconcile: base/value of the CURRENT live item set. Snapshots are throttled
  // (~hourly), so right after a hide/unhide/add/remove the newest snapshot lags the
  // live item set — recompute from the live items so the headline is seam-free NOW.
  // Each item's base is its first-ever tracked value (firstSigned) or, for one never
  // snapshotted, its own live value (a brand-new account contributes 0 organic).
  let currentBase = points[points.length - 1]?.base ?? 0;
  let currentActiveValue = (points[points.length - 1]?.value ?? 0) - carryValue;
  if (liveItems) {
    let liveBase = 0;
    let liveVal = 0;
    for (const it of liveItems) {
      const key = `${it.item_type}:${it.item_id}`;
      const signed = (it.is_debt ? -1 : 1) * Number(it.value);
      liveVal += signed;
      liveBase += firstSigned.has(key) ? firstSigned.get(key)! : signed;
    }
    currentActiveValue = liveVal;
    currentBase = liveBase + carryBase; // effective base incl. frozen removed items
  }

  return {
    points,
    baseline,
    currentBase: r2(currentBase),
    currentValue: r2(currentActiveValue),
    carryValue: r2(carryValue),
  };
}

/**
 * Structural-adjustment-aware net-worth series, derived from per-item history.
 *
 * The raw net-worth series jumps whenever a user ADDS or REMOVES an item (a newly
 * tracked account is not newly *earned* money). This series neutralises that: each
 * item contributes only its movement since it first appeared, so adding/removing an
 * item never moves the headline % or $ — only genuine gains/losses do.
 *
 *   base(T)    = Σ signed(firstValue) over items active at snapshot T
 *   organic(T) = value(T) − base(T)      (real movement)
 *   pct(T)     = organic(T) / base(T)     (money-weighted return)
 *
 * Note: a manual balance EDIT still reads as organic movement — item history can't
 * tell a correction from a real change, and excluding edits would zero-out net-worth
 * growth for manual-only trackers. Only adds/removes are structurally neutralised.
 */
export async function getAdjustedNwSeries(
  userId: string,
  startMs?: number,
  liveItems?: NetWorthItem[],
  excludedKeys?: Iterable<string>,
): Promise<AdjustedNwSeries> {
  // Paginate — see getItemChanges: a single .limit() is capped at 1000 rows by
  // PostgREST, which (ordered ascending) silently drops recent snapshots and
  // flattens the series. Page in 1000-row chunks to read the full history.
  const rows: AdjustedInputRow[] = [];
  const PAGE = 1000;
  for (let page = 0; page < 200; page++) {
    const { data: chunk, error } = await supabase
      .from('net_worth_item_history')
      .select('recorded_at, item_type, item_id, value, is_debt')
      .eq('user_id', userId)
      .order('recorded_at', { ascending: true })
      .range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) { console.error('[ADJ NW] page fetch failed:', error.message); break; }
    if (!chunk || chunk.length === 0) break;
    rows.push(...(chunk as AdjustedInputRow[]));
    if (chunk.length < PAGE) break;
  }

  // All the maths lives in the pure builder (structural add/remove neutralisation +
  // removed-item carry). Build the full series, then window it for the response.
  const full = buildAdjustedSeries(rows, liveItems, excludedKeys);
  const points = startMs
    ? full.points.filter(p => new Date(p.recorded_at).getTime() >= startMs)
    : full.points;
  return { ...full, points };
}

/** Snapshot every user that has any financial data. Called from the hourly cron. */
export async function snapshotAllNetWorth(): Promise<number> {
  const { data: users } = await supabase.from('users').select('id');
  let recorded = 0;
  for (const u of users ?? []) {
    try {
      await recordNetWorthSnapshot(u.id as string);
      recorded++;
    } catch (err) {
      console.error('[CRON] Net-worth snapshot failed for user:', err);
    }
  }
  return recorded;
}
