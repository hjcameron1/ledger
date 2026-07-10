import { supabase } from '../utils/supabase';
import { convertAmount } from './currencyService';

export interface NetWorthItem {
  item_type: 'bank' | 'investment' | 'super' | 'smsf' | 'credit_card' | 'loan';
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
  currency: string;
  items: NetWorthItem[];
}

/**
 * Compute a user's net worth in their preferred currency.
 *
 *   net worth = bank accounts + investments + super − credit-card debt
 *
 * "super" includes both regular super_funds AND SMSF asset totals, each gated by
 * its own include_in_net_worth flag. Income is intentionally NOT a separate
 * component: pay lands in a bank account, so it's already reflected in the bank
 * balance — counting income on top would double-count it.
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
  ] = await Promise.all([
    supabase.from('users').select('currency_preference').eq('id', userId).single(),
    supabase.from('bank_accounts').select('id, name, institution, balance, currency').eq('user_id', userId),
    supabase.from('investments').select('id, name, current_value, native_currency').eq('user_id', userId),
    supabase.from('credit_cards').select('id, name, institution, balance_owing, currency').eq('user_id', userId),
    supabase.from('super_funds').select('id, fund_name, balance, include_in_net_worth').eq('user_id', userId),
    supabase.from('smsf_funds').select('id, name, include_in_net_worth').eq('user_id', userId),
    supabase.from('smsf_assets').select('fund_id, amount').eq('user_id', userId),
    supabase.from('loans').select('id, name, current_balance, include_in_net_worth').eq('user_id', userId),
  ]);

  const pref = user?.currency_preference ?? 'AUD';
  const items: NetWorthItem[] = [];

  let bankBalance = 0;
  for (const acc of accounts ?? []) {
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

  const netWorth = bankBalance + investmentsTotal + superTotal - creditCardDebt - loanDebt;

  return {
    netWorth: parseFloat(netWorth.toFixed(2)),
    bankBalance: parseFloat(bankBalance.toFixed(2)),
    investments: parseFloat(investmentsTotal.toFixed(2)),
    creditCardDebt: parseFloat(creditCardDebt.toFixed(2)),
    super: parseFloat(superTotal.toFixed(2)),
    currency: pref,
    items,
  };
}

/** Compute and persist a net-worth snapshot row (total + per-item breakdown). */
export async function recordNetWorthSnapshot(userId: string): Promise<NetWorthBreakdown> {
  const nw = await computeNetWorth(userId);
  const recordedAt = new Date().toISOString();

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
      console.warn(
        `[SNAPSHOT] Skipping outlier net-worth snapshot for ${userId}: ` +
        `${lastVal.toFixed(2)} → ${nw.netWorth.toFixed(2)} (${(deviation * 100).toFixed(1)}% swing in ` +
        `${Math.round(ageMs / 60000)}min) — likely a transient mid-edit state, not recorded.`,
      );
      return nw;
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
    const change = currentValue - startValue;
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
      .select('id, current_value, native_currency, day_change_percent')
      .eq('user_id', userId);
    const invMap = new Map((liveInvs ?? []).map(i => [String(i.id), i]));
    for (const it of items) {
      if (it.item_type !== 'investment') continue;
      const inv = invMap.get(String(it.item_id));
      if (!inv || inv.day_change_percent == null) continue;
      const pct = Number(inv.day_change_percent);
      if (!Number.isFinite(pct) || pct <= -100) continue;
      const { converted: curPref } = await convertAmount(
        Number(inv.current_value) || 0, inv.native_currency ?? 'AUD', currency,
      );
      const dayChange = curPref - curPref / (1 + pct / 100);
      it.current_value = parseFloat(curPref.toFixed(2));
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
  currentBase: number;  // base at the latest snapshot (drives the live headline)
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
export async function getAdjustedNwSeries(userId: string, startMs?: number): Promise<AdjustedNwSeries> {
  // Paginate — see getItemChanges: a single .limit() is capped at 1000 rows by
  // PostgREST, which (ordered ascending) silently drops recent snapshots and
  // flattens the series. Page in 1000-row chunks to read the full history.
  const rows: Array<{
    recorded_at: string; item_type: string; item_id: string;
    value: number; is_debt: boolean;
  }> = [];
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
    rows.push(...(chunk as typeof rows));
    if (chunk.length < PAGE) break;
  }

  // First signed value per item (its "tracked-from" capital), and the active item
  // set at each snapshot timestamp.
  const firstSigned = new Map<string, number>();
  const snapItems = new Map<string, { key: string; signed: number }[]>();
  for (const r of rows ?? []) {
    const key = `${r.item_type}:${r.item_id}`;
    const signed = (r.is_debt ? -1 : 1) * Number(r.value);
    if (!firstSigned.has(key)) firstSigned.set(key, signed);
    const t = r.recorded_at as string;
    if (!snapItems.has(t)) snapItems.set(t, []);
    snapItems.get(t)!.push({ key, signed });
  }

  const stamps = Array.from(snapItems.keys()).sort();
  const allPoints: AdjustedNwPoint[] = stamps.map(t => {
    const arr = snapItems.get(t)!;
    let value = 0;
    let base = 0;
    for (const { key, signed } of arr) {
      value += signed;
      base += firstSigned.get(key) ?? 0;
    }
    const organic = value - base;
    return {
      recorded_at: t,
      value: parseFloat(value.toFixed(2)),
      base: parseFloat(base.toFixed(2)),
      organic: parseFloat(organic.toFixed(2)),
      pct: base > 0 ? parseFloat(((organic / base) * 100).toFixed(4)) : 0,
    };
  });

  const baseline = allPoints[0]?.base ?? 0;
  const currentBase = allPoints[allPoints.length - 1]?.base ?? 0;
  const points = startMs ? allPoints.filter(p => new Date(p.recorded_at).getTime() >= startMs) : allPoints;
  return { points, baseline, currentBase };
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
