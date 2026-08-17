import { supabase } from '../utils/supabase';
import { convertAmount } from './currencyService';

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
   *  a linked loan is already subtracted once through the loans total. */
  property: number;
  currency: string;
  items: NetWorthItem[];
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
 * "property" is the OWNED SHARE of each property's value and nothing else: a
 * property's mortgage is an ordinary loan row, already subtracted by the loans
 * term, so netting it here as well would count the same debt twice. A property
 * whose holding SMSF/super fund already lists it contributes nothing here for the
 * same reason — that fund's balance is already carrying the value.
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
    supabase.from('investments').select('id, name, current_value, native_currency').eq('user_id', userId),
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

  let bankBalance = 0;
  for (const acc of accounts ?? []) {
    // Hidden accounts are excluded from net worth (mirrors the super/loan opt-out).
    if ((acc as { hidden?: boolean }).hidden === true) continue;
    const { converted } = await convertAmount(acc.balance, acc.currency ?? 'AUD', pref);
    bankBalance += converted;
    items.push({ item_type: 'bank', item_id: String(acc.id), name: acc.name || acc.institution || 'Bank account', value: parseFloat(converted.toFixed(2)), is_debt: false });
  }

  let investmentsTotal = 0;
  for (const inv of investments ?? []) {
    const { converted } = await convertAmount(inv.current_value, inv.native_currency ?? 'AUD', pref);
    investmentsTotal += converted;
    items.push({ item_type: 'investment', item_id: String(inv.id), name: inv.name || 'Investment', value: parseFloat(converted.toFixed(2)), is_debt: false });
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
    }
  }

  // SMSF: sum each included fund's asset totals (assets are stored in AUD).
  const includedFunds = (smsfFunds ?? []).filter(f => f.include_in_net_worth);
  const includedFundIds = new Set(includedFunds.map(f => f.id as string));
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
  let loanDebt = 0;
  for (const ln of loans ?? []) {
    if (ln.include_in_net_worth !== false) {
      const v = Number(ln.current_balance) || 0;
      loanDebt += v;
      items.push({ item_type: 'loan', item_id: String(ln.id), name: (ln as { name?: string }).name || 'Loan', value: parseFloat(v.toFixed(2)), is_debt: true });
    }
  }

  // Properties: add only the share the user owns. The linked mortgage is NOT
  // subtracted here — it is one of the loans already counted above, and netting
  // it a second time would understate net worth by the whole balance.
  //
  // Nor is the value added when the SMSF (or super fund) holding the property
  // already lists it: that fund's balance went into `superTotal` above, so adding
  // the property here as well would count the same house twice. This mirrors
  // countedInFund() in the frontend engine exactly — deliberately property-local,
  // never consulting the fund's own include_in_net_worth, so the two
  // implementations can't drift apart.
  let propertyTotal = 0;
  for (const pr of properties ?? []) {
    if (pr.include_in_net_worth === false) continue;
    const heldInFund =
      (pr as { held_by?: string }).held_by === 'smsf' &&
      ((pr as { smsf_fund_id?: string | null }).smsf_fund_id != null ||
       (pr as { super_fund_id?: string | null }).super_fund_id != null) &&
      (pr as { counted_in_fund_balance?: boolean }).counted_in_fund_balance !== false;
    if (heldInFund) continue;
    const share = pr.ownership_percent == null ? 100 : Number(pr.ownership_percent);
    const pct = Number.isFinite(share) ? Math.min(100, Math.max(0, share)) : 100;
    const v = ((Number(pr.current_value) || 0) * pct) / 100;
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
    currency: pref,
    items,
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
}

/**
 * Per-item change over a timeframe, sorted by biggest net-worth contribution.
 *   timeframe = daily | weekly | monthly | sixmonth | yearly | all
 * Baseline per item = its snapshot at/just-before the window start; if the item
 * has no snapshot before the window (added later), its earliest snapshot is used
 * so newly-added items don't masquerade as sudden gains.
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

  // Group rows per item, in ascending time order.
  const byItem = new Map<string, typeof rows>();
  for (const r of rows ?? []) {
    const key = `${r.item_type}:${r.item_id}`;
    if (!byItem.has(key)) byItem.set(key, []);
    byItem.get(key)!.push(r);
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
  type TransferLeg = { key: string; createdMs: number; inflowPref: number };
  const legs: TransferLeg[] = [];
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

  const items: ItemChange[] = [];
  for (const series of byItem.values()) {
    if (!series || series.length === 0) continue;
    const latest = series[series.length - 1];
    // Baseline = last snapshot at/before startMs, else earliest snapshot.
    let baseline = series[0];
    if (startMs) {
      for (const r of series) {
        if (new Date(r.recorded_at).getTime() <= startMs) baseline = r;
        else break;
      }
    }
    const startValue = Number(baseline.value);
    const currentValue = Number(latest.value);
    let change = currentValue - startValue;
    // Strip internal-transfer flow that landed AFTER this item's baseline snapshot
    // (transfers already in the baseline value are in both endpoints, so they net
    // out of `change` on their own). A bank item's value moves +inflow; a credit
    // card's value is balance_owing, which moves −inflow (money in pays it down).
    if (latest.item_type === 'bank' || latest.item_type === 'credit_card') {
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
    });
  }

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
      .select('id, current_value, conversion_rate, day_change_percent')
      .eq('user_id', userId);
    const invMap = new Map((liveInvs ?? []).map(i => [String(i.id), i]));
    for (const it of items) {
      if (it.item_type !== 'investment') continue;
      const inv = invMap.get(String(it.item_id));
      if (!inv) continue;
      // ONE value base, shared with the Investments page: native current_value ×
      // the rate PINNED on the row at the last price refresh (frozen while the
      // market is closed). We must NOT re-convert with a live FX rate here — doing
      // so made the Telegram briefing and this breakdown disagree with the
      // Investments page overnight/on weekends, when the live rate has drifted away
      // from the pinned one. Mirror the frontend's `conversion_rate ?? 1` exactly.
      const rate = inv.conversion_rate == null ? 1 : Number(inv.conversion_rate);
      const curPref = (Number(inv.current_value) || 0) * (Number.isFinite(rate) ? rate : 1);
      it.current_value = parseFloat(curPref.toFixed(2));

      const pct = inv.day_change_percent == null ? null : Number(inv.day_change_percent);
      if (pct == null || !Number.isFinite(pct) || pct <= -100) {
        // No market % (e.g. a dealer-priced metal) → no reliable "today" move. Show
        // zero rather than the flaky 24h snapshot diff, so every surface still agrees.
        it.start_value = parseFloat(curPref.toFixed(2));
        it.change = 0;
        it.contribution = 0;
        continue;
      }
      const dayChange = curPref - curPref / (1 + pct / 100);
      it.start_value = parseFloat((curPref - dayChange).toFixed(2));
      it.change = parseFloat(dayChange.toFixed(2));
      it.contribution = parseFloat(dayChange.toFixed(2)); // investments never debt
    }
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
 */
export function buildAdjustedSeries(rows: AdjustedInputRow[], liveItems?: AdjustedLiveItem[]): AdjustedNwSeries {
  const r2 = (n: number) => parseFloat(n.toFixed(2));
  const r4 = (n: number) => parseFloat(n.toFixed(4));

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
export async function getAdjustedNwSeries(userId: string, startMs?: number, liveItems?: NetWorthItem[]): Promise<AdjustedNwSeries> {
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
  const full = buildAdjustedSeries(rows, liveItems);
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
