import { Router, Request, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { supabase } from '../utils/supabase';
import { beginIdempotentCreate, recoverIdempotentRace } from '../utils/idempotentCreate';
import { verifyInvestmentCalculation, verifyPortfolioTotal } from '../utils/investmentVerification';
import { fetchCurrentPrice, searchTicker, isMetal, fetchMetalSpotPerUnit, fetchDealerPricePerUnit, refreshStaleHoldings } from '../services/priceService';
import { scrapeAllDealers } from '../services/metalScraper';
import { getRate, getRateOn } from '../services/currencyService';
import { isMarketOpen, isHoursGated, nextMarketOpen } from '../services/marketCalendar';
import { recordPortfolioSnapshot, purgeInvestmentFromHistory } from '../services/portfolioSnapshot';
import { recordNetWorthSnapshot } from '../services/netWorthSnapshot';
import { investmentRate, investmentValueInPreferred, investmentValueNative } from '../services/investmentValue';
import {
  loadScope, scopedQuery, refuseWrite, refuseDelete, revokeGrantsFor,
  applyHouseholdShare, attachHouseholds, attachHouseholdsToOne,
} from '../services/householdScope';
import { divertMemberEdit, divertMemberDelete } from '../services/householdChangeRequests';

// Fire-and-forget net-worth snapshot after a holding is added/removed, so the
// "since you started" headline treats it as tracked-from-now (not a sudden gain/loss).
function snapshotNetWorthSoon(userId: string): void {
  recordNetWorthSnapshot(userId).catch(err => console.error('[nw] post-change snapshot failed:', err));
}

const router = Router();

/** The `:id` route param — tiny helper so guards above the destructure read clean. */
const id_of = (req: AuthRequest): string => req.params.id as string;

/**
 * ATO 12-month test for the CGT discount, by anniversary: the disposal must fall
 * strictly AFTER the first anniversary of acquisition (both end days excluded).
 * Feb 29 anniversaries clamp to Feb 28 in a non-leap year. Mirrors the client
 * CGT engine's `ownedTwelveMonths` so the stored flag and the assessed return
 * can never disagree.
 */
function heldOverTwelveMonths(acquired: string | null, disposed: string): boolean {
  const from = String(acquired ?? '').slice(0, 10);
  const to = String(disposed ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return false;
  const y = Number(from.slice(0, 4)) + 1;
  const m = Number(from.slice(5, 7));
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const d = Math.min(Number(from.slice(8, 10)), daysInMonth);
  const anniversary = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return to > anniversary;
}

/**
 * Enrich a raw investment row with display figures in the owner's preferred
 * currency. Crucially, profit/loss is computed in the PREFERRED currency from
 * value-in-preferred minus cost-in-preferred — never by mixing a native-currency
 * value with a differently-denominated cost (the old bug that turned gains into
 * losses for USD holdings).
 *
 * cost_basis_currency tells us what the stored cost is denominated in:
 *   • preferred  → cost stays fixed (true historical AUD cost; no FX drift)
 *   • native     → cost is converted with the same rate as value (currency exposure)
 *   • unset      → treated as native (legacy rows)
 */
export async function enrichInvestment(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  inv: any,
  preferredCurrency: string,
) {
  // Cash is a plain balance held in a brokerage/settlement account, not a priced
  // security: current_price stores the balance, shares_owned is 1, and there's no
  // gain/loss (cost tracks value so P&L is always 0).
  const isCash = inv.asset_type === 'cash';
  const valueNative = investmentValueNative(inv);

  // native → preferred. ONE rule and ONE sum, shared with the net-worth snapshot,
  // the Overview breakdown and the Telegram briefing, so the page and the
  // recorded history cannot value the same holding differently — see
  // services/investmentValue.
  const rate = await investmentRate(inv, preferredCurrency);
  const valuePref = await investmentValueInPreferred(inv, preferredCurrency);

  // cost → preferred. For cash, cost equals value so profit/loss is exactly 0.
  // New rows store cost LOCKED in the preferred currency (see the POST handler),
  // so the first branch is the whole story for them. A legacy row whose cost is
  // still denominated in another currency converts at the rate ON ITS
  // ACQUISITION DATE — what was actually paid — never at today's rate, which
  // would silently revalue history and erase the FX component of P&L (F9).
  // getRateOn falls back to the current rate when no date was recorded.
  let costPref: number;
  if (isCash) {
    costPref = valuePref;
  } else {
    const costCcy = inv.cost_basis_currency || inv.native_currency || preferredCurrency;
    const costRaw = Number(inv.cost_basis) || 0;
    if (costCcy === preferredCurrency) {
      costPref = parseFloat(costRaw.toFixed(2));
    } else {
      const acqRate = await getRateOn(costCcy, preferredCurrency, inv.acquired_date ?? '');
      costPref = parseFloat((costRaw * acqRate).toFixed(2));
    }
  }

  const profit_loss = isCash ? 0 : parseFloat((valuePref - costPref).toFixed(2));
  const profit_loss_percent = (isCash || costPref === 0) ? 0 : parseFloat(((profit_loss / costPref) * 100).toFixed(4));

  return {
    ...inv,
    verification: { current_value: valueNative, profit_loss, profit_loss_percent, is_verified: true },
    display_value: valuePref,
    display_cost: costPref,
    display_currency: preferredCurrency,
    conversion_rate: rate,
  };
}

// ── Public routes (Yahoo Finance proxies — no auth needed) ────────────────────

router.get('/search', async (req: Request, res: Response) => {
  const { q, market } = req.query;
  if (!q) { res.status(400).json({ error: 'Query required' }); return; }
  const results = await searchTicker(q as string, market ? String(market) : undefined);
  res.json(results);
});

router.get('/price/:ticker', async (req: Request, res: Response) => {
  const { ticker } = req.params;
  const { market, unit, currency } = req.query;
  // Metals quote per troy-oz; return the price for the chosen weight unit instead.
  const result = isMetal(ticker)
    ? await fetchMetalSpotPerUnit(ticker, (unit as string) ?? 'grams')
    : await fetchCurrentPrice(ticker, (market as string) ?? 'ASX');
  if (!result) { res.status(404).json({ error: 'Price not found' }); return; }
  // Optionally convert into the caller's preferred currency (metals quote in USD,
  // but the user wants spot shown in their own currency, e.g. AUD).
  const want = currency ? String(currency).toUpperCase() : null;
  if (want && result.currency && want !== result.currency) {
    const rate = await getRate(result.currency, want);
    res.json({ price: parseFloat((result.price * rate).toFixed(4)), currency: want, timestamp: result.timestamp });
    return;
  }
  res.json(result);
});

// Scraped dealer products for the in-depth metal form. Filter by metal/form/dealer.
// Public (no auth) — it's reference price data, not user-specific.
router.get('/metal-products', async (req: Request, res: Response) => {
  const { metal, form, dealer } = req.query;
  let q = supabase
    .from('metal_products')
    .select('id, dealer, metal, form, weight_grams, unit_label, product_name, url, buy_price, sell_price, spot_value, currency, in_stock, scraped_at')
    .order('weight_grams', { ascending: true });
  if (metal)  q = q.eq('metal', metal as string);
  if (form)   q = q.eq('form', form as string);
  if (dealer) q = q.eq('dealer', dealer as string);
  const { data, error } = await q;
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json({ products: data ?? [] });
});

// FX rate lookup — lets the Add/Edit form convert between a holding's native
// currency and the user's preferred currency (for the AUD↔native input toggle
// and the cost↔profit/loss auto-calc) without shipping FX logic to the client.
router.get('/fxrate', async (req: Request, res: Response) => {
  const { from, to } = req.query;
  if (!from || !to) { res.status(400).json({ error: 'from and to required' }); return; }
  const rate = await getRate(String(from).toUpperCase(), String(to).toUpperCase());
  res.json({ from, to, rate });
});

// ── Authenticated routes ───────────────────────────────────────────────────────
router.use(authenticate);

// On-demand dealer price refresh (same work the daily cron does). Useful for
// seeding the catalogue immediately after deploy rather than waiting for the cron.
router.post('/metal-products/refresh', async (_req: AuthRequest, res: Response) => {
  try {
    const results = await scrapeAllDealers();
    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.get('/', async (req: AuthRequest, res: Response) => {
  // Freshen any stale prices before reading, so the value returned never depends
  // on whether the hours-gated cron happened to run while the free-tier server was
  // awake (it sleeps through the entire US session — see refreshStaleHoldings).
  // Bounded by a 15-min staleness threshold, so back-to-back loads stay fast.
  await refreshStaleHoldings(req.user!.userId).catch((err) =>
    console.error('[investments] refreshStaleHoldings failed:', err),
  );

  // Own holdings plus any shared with a household the user is in, or granted to
  // them directly — the same visibility rule every other shareable table uses.
  // Totals stay honest because the client scopes them by ownership/household at
  // read time; nothing here adds a shared holding to anybody's net worth.
  const scope = await loadScope(req.user!.userId);
  const { data: investments, error } = await scopedQuery(
    supabase.from('investments').select('*'), scope, 'investments',
  ).order('created_at', { ascending: false });

  if (error) { res.status(500).json({ error: error.message }); return; }

  const { data: user } = await supabase
    .from('users').select('currency_preference').eq('id', req.user!.userId).single();
  const preferredCurrency = user?.currency_preference ?? 'AUD';

  const verified = await Promise.all(
    (investments ?? []).map((inv) => enrichInvestment(inv, preferredCurrency)),
  );

  const total = verified.reduce((s, i) => s + i.display_value, 0);
  const portfolioCheck = verifyPortfolioTotal(verified.map(i => ({ current_value: i.display_value })), total);

  // Soonest moment any holding's price will next refresh: for a closed exchange
  // that's its next open; for anything currently refreshing it's the next hourly
  // cron tick. Used by the UI's "updating in …" disclaimer.
  const now = new Date();
  const nextHourTick = new Date(now);
  nextHourTick.setMinutes(0, 0, 0);
  nextHourTick.setHours(now.getHours() + 1);
  const candidates: number[] = [];
  for (const inv of verified) {
    if (!inv.ticker) continue;
    if (isHoursGated(inv.market) && isMarketOpen(inv.market) === false) {
      const open = nextMarketOpen(inv.market, now);
      if (open) candidates.push(open.getTime());
    } else {
      candidates.push(nextHourTick.getTime());
    }
  }
  const next_update = candidates.length ? new Date(Math.min(...candidates)).toISOString() : null;

  res.json({
    investments: await attachHouseholds('investment', verified),
    portfolio_total: total,
    portfolio_verified: portfolioCheck.verified,
    next_update,
  });
});

// Portfolio P&L % history for the trend chart. Forward-only: rows accumulate
// from the hourly cron and from the on-demand snapshot below.
//   ?timeframe = daily | weekly | monthly | yearly | all   (default: all)
//   daily   → intraday (hourly) rows from the last 24h
//   others  → one point per day (latest of each day) within the window
router.get('/pl-history', async (req: AuthRequest, res: Response) => {
  const userId = req.user!.userId;
  const timeframe = String(req.query.timeframe ?? 'all');

  // On-demand snapshot so a point appears as soon as the page is viewed —
  // throttled to once per hour to avoid spamming the table.
  try {
    const { data: latest } = await supabase
      .from('portfolio_pl_history')
      .select('recorded_at')
      .eq('user_id', userId)
      .order('recorded_at', { ascending: false })
      .limit(1);
    const lastAt = latest?.[0]?.recorded_at ? new Date(latest[0].recorded_at).getTime() : 0;
    if (Date.now() - lastAt > 55 * 60 * 1000) {
      await recordPortfolioSnapshot(userId);
    }
  } catch (err) {
    console.error('Portfolio snapshot (on-demand) failed:', err);
  }

  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;
  const windowStart: Record<string, number> = {
    daily: now - DAY,
    weekly: now - 7 * DAY,
    monthly: now - 30 * DAY,
    yearly: now - 365 * DAY,
  };
  const startMs = windowStart[timeframe];

  let query = supabase
    .from('portfolio_pl_history')
    .select('recorded_at, pl_percent, pl_value, total_value, total_cost')
    .eq('user_id', userId)
    .order('recorded_at', { ascending: true });
  if (startMs) query = query.gte('recorded_at', new Date(startMs).toISOString());

  const { data, error } = await query.limit(2000);
  if (error) { res.status(500).json({ error: error.message }); return; }

  let points = data ?? [];

  // For non-daily views, down-sample to one point per calendar day (the last
  // reading of each day) so the line isn't 24× denser than it needs to be.
  if (timeframe !== 'daily') {
    const byDay = new Map<string, typeof points[number]>();
    for (const p of points) {
      const day = new Date(p.recorded_at).toISOString().split('T')[0];
      byDay.set(day, p); // ascending order → last write wins = latest of the day
    }
    points = Array.from(byDay.values());
  }

  res.json({ timeframe, points });
});

router.post('/', async (req: AuthRequest, res: Response) => {
  const { ticker, market, shares_owned, cost_basis, name, asset_type } = req.body;

  let current_price = req.body.current_price ?? 0;
  let native_currency = req.body.native_currency ?? 'AUD';
  let last_price_update = null;

  // Precious-metal metadata. Both generic and in-depth holdings are VALUED at the
  // live metal spot price (converted to the chosen weight unit) — a holding's worth
  // is its metal content. In-depth holdings additionally record the specific product
  // (form/mint) and the buy price/premium the user paid, kept separately as cost.
  const metalDetailed = !!req.body.metal_detailed;
  const metalUnit = req.body.metal_unit ?? 'grams';
  const metalProductId = req.body.metal_product_id ?? null;

  if (asset_type === 'precious_metal') {
    // A holding linked to a specific dealer product is valued from THAT product's
    // scraped buyback (native AUD) so Ledger matches the dealer's site; generic
    // metals (no product picked) value at the live spot price.
    const priced = metalProductId
      ? (await fetchDealerPricePerUnit(metalProductId, metalUnit))
          ?? (await fetchMetalSpotPerUnit(ticker, metalUnit))
      : await fetchMetalSpotPerUnit(ticker, metalUnit);
    if (priced) {
      current_price = priced.price;
      native_currency = priced.currency;
      last_price_update = priced.timestamp;
    }
  } else if (ticker && market) {
    const priceData = await fetchCurrentPrice(ticker, market);
    if (priceData) {
      current_price = priceData.price;
      native_currency = priceData.currency;
      last_price_update = priceData.timestamp;
    }
  }

  const v = verifyInvestmentCalculation(shares_owned, current_price, cost_basis);

  // Cost basis is LOCKED in the owner's preferred currency at add time and never
  // re-converted afterwards — what you paid is a fixed amount that must not drift
  // as FX moves. Convert the entered cost (in whatever currency the user typed)
  // into preferred ONCE here, then store it with cost_basis_currency = preferred.
  const { data: prefUser } = await supabase
    .from('users').select('currency_preference').eq('id', req.user!.userId).single();
  const preferred = prefUser?.currency_preference ?? 'AUD';
  // Purchase date (optional). When the cost is in a foreign currency we convert it
  // at the FX rate that applied ON that date, so the locked AUD cost matches what
  // the user actually paid — not today's rate. Falls back to today's rate if no
  // date is given. This is what makes imported/foreign portfolios accurate.
  const acquiredDate: string | null = req.body.acquired_date ?? req.body.purchase_date ?? null;
  const enteredCostCcy = req.body.cost_basis_currency ?? native_currency;
  const lockedCost = enteredCostCcy === preferred
    ? Number(cost_basis) || 0
    : parseFloat(((Number(cost_basis) || 0) * await getRateOn(enteredCostCcy, preferred, acquiredDate ?? '')).toFixed(2));

  // Snapshot the native→preferred FX rate at add time so the holding's value is
  // converted correctly immediately (don't wait for the next price cron). Without
  // this, USD/foreign holdings default to rate 1 and display ~unconverted.
  const conversion_rate = native_currency !== preferred
    ? await getRate(native_currency, preferred)
    : 1;

  const invFields: Record<string, unknown> = {
    user_id: req.user!.userId,
    name: name ?? ticker,
    ticker,
    market,
    asset_type: asset_type ?? 'stock',
    shares_owned,
    cost_basis: lockedCost,
    cost_basis_currency: preferred,
    current_price,
    current_value: v.current_value,
    currency: req.body.currency ?? 'AUD',
    native_currency,
    conversion_rate,
    display_currency: preferred,
    acquired_date: acquiredDate,
    last_price_update,
    is_dividend_paying: req.body.is_dividend_paying ?? false,
    // Flexible metadata for collectible/non-market types (bond, art, wine, jewellery).
    details: req.body.details ?? null,
    ...(asset_type === 'precious_metal' ? {
      metal_unit: metalUnit,
      metal_form: req.body.metal_form ?? 'generic',
      metal_mint: req.body.metal_mint ?? null,
      metal_detailed: metalDetailed,
      metal_product_id: metalProductId,
      metal_buy_price: req.body.metal_buy_price != null ? Number(req.body.metal_buy_price) || null : null,
      metal_sell_price: req.body.metal_sell_price != null ? Number(req.body.metal_sell_price) || null : null,
    } : {}),
  };

  // A replay must answer in the SAME shape as a fresh create, enriched the same way.
  const replay = await beginIdempotentCreate('investments', req.user!.userId, req.body, invFields);
  if (replay) {
    const enrichedReplay = await enrichInvestment(replay, preferred);
    res.status(200).json({ investment: enrichedReplay, verification: enrichedReplay.verification });
    return;
  }

  const { data, error } = await supabase
    .from('investments')
    .insert(invFields)
    .select()
    .single();

  if (error) {
    const raced = await recoverIdempotentRace('investments', req.user!.userId, req.body, error);
    if (raced) {
      const enrichedRaced = await enrichInvestment(raced, preferred);
      res.status(200).json({ investment: enrichedRaced, verification: enrichedRaced.verification });
      return;
    }
    res.status(500).json({ error: error.message }); return;
  }

  // Return the holding already converted into the owner's preferred currency so
  // the optimistic record the client created is replaced with correct display
  // figures (value, cost, P&L all in preferred) instead of raw native numbers.
  const enriched = await enrichInvestment(data, preferred);
  snapshotNetWorthSoon(req.user!.userId);
  res.status(201).json({ investment: enriched, verification: enriched.verification });
});

router.put('/:id', async (req: AuthRequest, res: Response) => {
  const scope = await loadScope(req.user!.userId);
  const refusal = await refuseWrite('investments', id_of(req), scope);
  if (refusal) { res.status(refusal.status).json({ error: refusal.error }); return; }

  // Sharing writes NO column on the row. Which households the holding sits in
  // lives in `record_households` and is reconciled from the request's
  // `household_ids` — so a share can never move a valuation as a side effect.
  const shareRefusal = await applyHouseholdShare('investments', id_of(req), scope, req.body);
  if (shareRefusal) { res.status(shareRefusal.status).json({ error: shareRefusal.error }); return; }

  const { shares_owned, cost_basis, current_price } = req.body;
  const updates: Record<string, unknown> = { ...req.body, updated_at: new Date().toISOString() };
  delete updates.household_ids;   // join-table state, not a column
  delete updates.household_id;    // legacy column, no longer written
  delete updates.household_overlay_resolutions; // reshare choice, not a column
  delete updates.user_id;         // ownership never moves through an update
  delete updates.verification;    // client-derived display shape
  delete updates.display_value; delete updates.display_cost; delete updates.display_currency;

  const { data: u } = await supabase
    .from('users').select('currency_preference').eq('id', req.user!.userId).single();
  const preferred = u?.currency_preference ?? 'AUD';

  // Re-lock cost basis in preferred currency on edit too: convert the entered cost
  // once and store it with cost_basis_currency = preferred so it never re-converts.
  if (cost_basis !== undefined) {
    const enteredCcy = req.body.cost_basis_currency ?? req.body.native_currency ?? preferred;
    const acqDate: string | null = req.body.acquired_date ?? req.body.purchase_date ?? null;
    updates.cost_basis = enteredCcy === preferred
      ? Number(cost_basis) || 0
      : parseFloat(((Number(cost_basis) || 0) * await getRateOn(enteredCcy, preferred, acqDate ?? '')).toFixed(2));
    updates.cost_basis_currency = preferred;
  }

  if (shares_owned !== undefined && current_price !== undefined && cost_basis !== undefined) {
    const v = verifyInvestmentCalculation(shares_owned, current_price, cost_basis);
    updates.current_value = v.current_value;
  }

  // A household member's edit never lands on the owner's row: it becomes a
  // change request whose patch the household view shows, and the owner is asked.
  // (Diverted AFTER the cost-basis conversion above, so the household overlay
  // holds the same values a real write would have stored.)
  const diverted = await divertMemberEdit('investments', id_of(req), scope, updates);
  if (diverted) {
    res.json(await attachHouseholdsToOne('investment', await enrichInvestment(diverted, preferred)));
    return;
  }

  // Ownership/permission was already settled by refuseWrite: a direct
  // edit-granted person may correct a shared holding, so the row is matched by id.
  const { data, error } = await supabase
    .from('investments')
    .update(updates)
    .eq('id', req.params.id)
    .select()
    .single();

  if (error) { res.status(500).json({ error: error.message }); return; }

  res.json(await attachHouseholdsToOne('investment', await enrichInvestment(data, preferred)));
});

router.delete('/:id', async (req: AuthRequest, res: Response) => {
  const scope = await loadScope(req.user!.userId);
  // A household member's delete takes the holding out of the HOUSEHOLD only,
  // and asks its owner whether to delete it from their portfolio as well.
  if (await divertMemberDelete('investments', req.params.id, scope)) {
    res.json({ success: true, diverted: true });
    return;
  }
  const refusal = await refuseDelete('investments', req.params.id, scope);
  if (refusal) { res.status(refusal.status).json({ error: refusal.error }); return; }
  await revokeGrantsFor('investments', req.params.id);
  await supabase.from('investments').delete()
    .eq('id', req.params.id).eq('user_id', req.user!.userId);
  // A real delete scrubs the holding out of the P&L history line. A sale (?sold=1)
  // is genuine history and stays on the chart — skip the purge in that case.
  const sold = req.query.sold === '1' || req.query.sold === 'true';
  if (!sold) {
    purgeInvestmentFromHistory(req.user!.userId, req.params.id)
      .catch(err => console.error('[pl] purge investment from history failed:', err));
  }
  snapshotNetWorthSoon(req.user!.userId);
  res.json({ success: true });
});

// ── Realised sales / disposals (CGT) ─────────────────────────────────────────
// List the user's recorded disposals (newest first). The FY CGT summary is computed
// client-side from these rows.
router.get('/sales', async (req: AuthRequest, res: Response) => {
  const { data, error } = await supabase
    .from('investment_sales')
    .select('*')
    .eq('user_id', req.user!.userId)
    .order('sale_date', { ascending: false });
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json({ sales: data ?? [] });
});

// Record one disposal (partial or full). The holding itself is reduced/removed via
// the normal investment.update / investment.delete path; this only logs the sale and
// (re)computes the gain + 12-month discount eligibility server-side for integrity.
router.post('/sales', async (req: AuthRequest, res: Response) => {
  const b = req.body ?? {};
  const quantity = Number(b.quantity) || 0;
  const proceeds = Number(b.proceeds) || 0;
  const fees = Number(b.fees) || 0;
  const cost_basis = Number(b.cost_basis) || 0;
  const sale_date: string = b.sale_date || new Date().toISOString().slice(0, 10);
  const acquired_date: string | null = b.acquired_date || null;
  const gain = Number((proceeds - fees - cost_basis).toFixed(2));

  let held_days: number | null = null;
  if (acquired_date) {
    held_days = Math.round((new Date(sale_date).getTime() - new Date(acquired_date).getTime()) / 86_400_000);
  }
  // AU individual rule: 50% discount only when the disposal falls strictly AFTER
  // the first anniversary of acquisition, AND it's a gain. Anniversaries, not a
  // day count (F7): across a leap day, exactly-twelve-months is 366 days — which
  // a `> 365` test wrongly discounted. Matches the client CGT engine's
  // `ownedTwelveMonths`. held_days stays a plain day count for display.
  const discount_eligible = gain > 0 && heldOverTwelveMonths(acquired_date, sale_date);

  const saleFields: Record<string, unknown> = {
    user_id: req.user!.userId,
    investment_id: b.investment_id ?? null,
    name: b.name ?? 'Unknown',
    ticker: b.ticker ?? null,
    asset_type: b.asset_type ?? null,
    market: b.market ?? null,
    quantity,
    proceeds,
    fees,
    cost_basis,
    acquired_date,
    sale_date,
    gain,
    held_days,
    discount_eligible,
    currency: b.currency ?? 'AUD',
    // The asset's own currency, not the row's. Foreign CASH is disposed of under
    // the forex rules rather than as a capital gain, and once a fully sold
    // holding is deleted this row is the only thing left that could say so.
    native_currency: b.native_currency ?? null,
  };
  const replay = await beginIdempotentCreate('investment_sales', req.user!.userId, req.body, saleFields);
  if (replay) { res.status(200).json({ sale: replay }); return; }

  let { data, error } = await supabase
    .from('investment_sales')
    .insert(saleFields)
    .select()
    .single();
  // A disposal is not worth losing over an audit column: if native_currency
  // isn't there yet, record the sale without it.
  if (isUnknownColumn(error)) {
    ({ data, error } = await supabase
      .from('investment_sales')
      .insert(without(saleFields, ['native_currency']))
      .select()
      .single());
  }

  if (error) {
    const raced = await recoverIdempotentRace('investment_sales', req.user!.userId, req.body, error);
    if (raced) { res.status(200).json({ sale: raced }); return; }
    res.status(500).json({ error: error.message }); return;
  }
  res.status(201).json({ sale: data });
});

// Remove a disposal recorded by mistake. The holding is NOT restored — reducing or
// removing it went through the normal investment routes and is a separate decision.
router.delete('/sales/:id', async (req: AuthRequest, res: Response) => {
  const { error } = await supabase
    .from('investment_sales')
    .delete()
    .eq('id', req.params.id)
    .eq('user_id', req.user!.userId);
  if (error) { res.status(500).json({ error: error.message }); return; }
  // The allocations belonged to this disposal and to nothing else.
  await supabase.from('cgt_disposal_allocations').delete()
    .eq('sale_id', req.params.id).eq('user_id', req.user!.userId)
    .then(({ error: e }) => { if (e && !isMissingTable(e)) console.error('[cgt] allocation cleanup failed:', e); });
  res.json({ success: true });
});

// ── The parcel book (Phase 5.7) ──────────────────────────────────────────────
//
// The acquisition record that costs a disposal: parcels, the splits that
// re-express them in today's units, and what each sale ACTUALLY consumed. It
// lived in the browser until now, which meant a second device costed every sale
// from the holding's average instead of from the units it came out of.
//
// Ids are minted by the CLIENT and every write is an upsert on that id, so a
// replayed sync converges rather than inserting a twin, and the local book can
// be adopted here exactly once without duplicating itself.

/**
 * "The migration hasn't been run yet" as opposed to "the write was wrong".
 * PostgREST reports an unknown table as PGRST205 (schema cache) and Postgres as
 * 42P01. Until `database/2026-cgt-parcels.sql` is applied the routes answer
 * `available: false` instead of 500ing, and the client keeps its local book —
 * the first bootstrap after the migration adopts it.
 */
function isMissingTable(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  const code = String(error.code ?? '');
  if (code === '42P01' || code === 'PGRST205' || code === 'PGRST204') return true;
  return /does not exist|schema cache/i.test(String(error.message ?? ''));
}

/**
 * "That column isn't there yet" as opposed to "the write was wrong". A deploy can
 * land before its migration does, and when it does the columns added by
 * `database/2026-cgt-audit-and-forex.sql` are the only thing wrong with the row:
 * dropping them and writing the rest keeps the figures — which is all the user
 * ever sees — and loses only the audit stamp, which the next write restores.
 */
function isUnknownColumn(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  // 42703 = undefined_column (Postgres); PGRST204 = column not in schema cache.
  const code = String(error.code ?? '');
  if (code === '42703' || code === 'PGRST204') return true;
  return /column .* does not exist|could not find the .* column/i.test(String(error.message ?? ''));
}

function without<T extends Record<string, unknown>>(row: T, keys: readonly string[]): T {
  const out = { ...row };
  for (const key of keys) delete out[key];
  return out;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const asUuid = (v: unknown): string | null => (UUID_RE.test(String(v ?? '')) ? String(v) : null);
const asDay = (v: unknown): string | null => {
  const s = String(v ?? '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
};
const asNum = (v: unknown, fallback = 0): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

// Everything the parcel book knows, in one round trip — it is read once per app
// load and the three lists are meaningless apart from each other.
router.get('/cgt', async (req: AuthRequest, res: Response) => {
  const userId = req.user!.userId;
  const [parcels, splits, allocations, settings] = await Promise.all([
    supabase.from('cgt_parcels').select('*').eq('user_id', userId),
    supabase.from('cgt_splits').select('*').eq('user_id', userId),
    supabase.from('cgt_disposal_allocations').select('*').eq('user_id', userId),
    supabase.from('cgt_settings').select('*').eq('user_id', userId).maybeSingle(),
  ]);

  // One missing table means the migration hasn't run — say so plainly rather
  // than returning empty lists, which the client would read as "you have no
  // parcels" and act on by dropping the ones it holds.
  if ([parcels.error, splits.error, allocations.error, settings.error].some(isMissingTable)) {
    res.json({ available: false, parcels: [], splits: [], allocations: [], opening: null });
    return;
  }
  const failure = [parcels.error, splits.error, allocations.error].find(Boolean);
  if (failure) { res.status(500).json({ error: failure.message }); return; }

  const s = settings.data;
  res.json({
    available: true,
    parcels: parcels.data ?? [],
    splits: splits.data ?? [],
    allocations: allocations.data ?? [],
    opening: s?.opening_fy
      ? {
          fy: s.opening_fy,
          ordinary: Number(s.opening_ordinary) || 0,
          collectable: Number(s.opening_collectable) || 0,
        }
      : null,
  });
});

/** Upsert one parcel under the id the client minted for it. */
router.post('/cgt/parcels', async (req: AuthRequest, res: Response) => {
  const b = req.body ?? {};
  const id = asUuid(b.id);
  // A bad id can never be made good by retrying — refuse it (400) instead of
  // failing (500), which the sync queue would park and replay five times.
  if (!id) { res.status(400).json({ error: 'A parcel needs a uuid id minted by the client.' }); return; }
  const quantity = asNum(b.quantity);
  if (!(quantity > 0)) { res.status(400).json({ error: 'A parcel needs a quantity greater than zero.' }); return; }

  const row = {
    id,
    user_id: req.user!.userId,
    investment_id: asUuid(b.investment_id),
    label: String(b.label ?? '').trim() || 'Holding',
    ticker: b.ticker ? String(b.ticker).trim().toUpperCase() : null,
    asset_type: b.asset_type ?? null,
    quantity,
    cost_base: Math.max(0, asNum(b.cost_base)),
    acquired_date: asDay(b.acquired_date),
    origin: b.origin === 'holding' ? 'holding' : 'user',
    recorded_at: b.recorded_at ? String(b.recorded_at) : null,
  };
  const { data, error } = await supabase.from('cgt_parcels').upsert(row).select().single();
  if (isMissingTable(error)) { res.status(404).json({ error: 'cgt_parcels is not migrated yet' }); return; }
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.status(201).json({ parcel: data });
});

router.delete('/cgt/parcels/:id', async (req: AuthRequest, res: Response) => {
  const { error } = await supabase.from('cgt_parcels').delete()
    .eq('id', req.params.id).eq('user_id', req.user!.userId);
  if (isMissingTable(error)) { res.status(404).json({ error: 'cgt_parcels is not migrated yet' }); return; }
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json({ success: true });
});

/** Everything recorded against one holding, for a genuine delete of it. */
router.delete('/cgt/holdings/:investmentId', async (req: AuthRequest, res: Response) => {
  const userId = req.user!.userId;
  const invId = req.params.investmentId;
  const [p, s] = await Promise.all([
    supabase.from('cgt_parcels').delete().eq('investment_id', invId).eq('user_id', userId),
    supabase.from('cgt_splits').delete().eq('investment_id', invId).eq('user_id', userId),
  ]);
  if (isMissingTable(p.error) || isMissingTable(s.error)) { res.status(404).json({ error: 'cgt tables are not migrated yet' }); return; }
  const failure = [p.error, s.error].find(Boolean);
  if (failure) { res.status(500).json({ error: failure.message }); return; }
  res.json({ success: true });
});

router.post('/cgt/splits', async (req: AuthRequest, res: Response) => {
  const b = req.body ?? {};
  const id = asUuid(b.id);
  if (!id) { res.status(400).json({ error: 'A split needs a uuid id minted by the client.' }); return; }
  const ratio = asNum(b.ratio);
  // A ratio of 1 moves nothing and a non-positive one is not a split at all.
  if (!(ratio > 0) || ratio === 1) { res.status(400).json({ error: 'A split needs a positive ratio other than 1.' }); return; }

  const row = {
    id,
    user_id: req.user!.userId,
    investment_id: asUuid(b.investment_id),
    label: String(b.label ?? '').trim() || 'Holding',
    ticker: b.ticker ? String(b.ticker).trim().toUpperCase() : null,
    ratio,
    recorded_at: b.recorded_at ? String(b.recorded_at) : null,
  };
  const { data, error } = await supabase.from('cgt_splits').upsert(row).select().single();
  if (isMissingTable(error)) { res.status(404).json({ error: 'cgt_splits is not migrated yet' }); return; }
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.status(201).json({ split: data });
});

router.delete('/cgt/splits/:id', async (req: AuthRequest, res: Response) => {
  const { error } = await supabase.from('cgt_splits').delete()
    .eq('id', req.params.id).eq('user_id', req.user!.userId);
  if (isMissingTable(error)) { res.status(404).json({ error: 'cgt_splits is not migrated yet' }); return; }
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json({ success: true });
});

/**
 * What one disposal consumed. Written as a SET — the whole allocation for a sale
 * is replaced at once — because the slices only mean anything together: half of
 * an old allocation beside half of a new one is a cost base nobody paid.
 */
router.put('/cgt/allocations/:saleId', async (req: AuthRequest, res: Response) => {
  const userId = req.user!.userId;
  const saleId = asUuid(req.params.saleId);
  if (!saleId) { res.status(400).json({ error: 'A disposal allocation needs the sale\'s uuid.' }); return; }

  const rows = (Array.isArray(req.body?.allocations) ? req.body.allocations : [])
    .map((a: Record<string, unknown>) => ({
      id: asUuid(a.id),
      user_id: userId,
      sale_id: saleId,
      // TEXT, not uuid: a holding with no written-down parcels is costed from a
      // placeholder derived from the holding, whose id is 'derived:<uuid>'.
      parcel_id: a.parcel_id != null ? String(a.parcel_id) : null,
      quantity: asNum(a.quantity),
      cost_base: Math.max(0, asNum(a.cost_base)),
      acquired_date: asDay(a.acquired_date),
      source: ['parcel', 'recorded', 'unmatched'].includes(String(a.source)) ? String(a.source) : 'parcel',
      recorded_at: a.recorded_at != null ? String(a.recorded_at) : null,
      // The audit trail: when this slice was frozen, and whether it was frozen
      // by the sale that created it or by the one-time backfill that settled
      // disposals recorded before Ledger settled them at all.
      settled_at: a.settled_at != null ? String(a.settled_at) : null,
      settled_by: String(a.settled_by) === 'backfill' ? 'backfill' : 'sale',
    }))
    .filter((r: { id: string | null }) => r.id !== null);

  const cleared = await supabase.from('cgt_disposal_allocations').delete()
    .eq('sale_id', saleId).eq('user_id', userId);
  if (isMissingTable(cleared.error)) { res.status(404).json({ error: 'cgt_disposal_allocations is not migrated yet' }); return; }
  if (cleared.error) { res.status(500).json({ error: cleared.error.message }); return; }

  if (rows.length === 0) { res.json({ allocations: [] }); return; }
  let { data, error } = await supabase.from('cgt_disposal_allocations').insert(rows).select();
  // The slices were deleted a moment ago. If the audit columns aren't migrated
  // yet, writing the slices without the stamp is the only acceptable outcome —
  // failing here would leave the disposal with no cost base at all.
  if (isUnknownColumn(error)) {
    ({ data, error } = await supabase
      .from('cgt_disposal_allocations')
      .insert(rows.map((r: Record<string, unknown>) => without(r, ['settled_at', 'settled_by'])))
      .select());
  }
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json({ allocations: data ?? [] });
});

/** The unapplied losses brought in from the last lodged return. */
router.put('/cgt/opening', async (req: AuthRequest, res: Response) => {
  const b = req.body ?? {};
  const fy = /^\d{4}-\d{4}$/.test(String(b.fy ?? '')) ? String(b.fy) : null;
  const row = {
    user_id: req.user!.userId,
    opening_fy: fy,
    opening_ordinary: fy ? Math.max(0, asNum(b.ordinary)) : 0,
    opening_collectable: fy ? Math.max(0, asNum(b.collectable)) : 0,
  };
  const { data, error } = await supabase.from('cgt_settings').upsert(row).select().single();
  if (isMissingTable(error)) { res.status(404).json({ error: 'cgt_settings is not migrated yet' }); return; }
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json({ settings: data });
});

// Super funds
router.get('/super', async (req: AuthRequest, res: Response) => {
  const { data, error } = await supabase
    .from('super_funds')
    .select('*')
    .eq('user_id', req.user!.userId);

  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json(data);
});

router.post('/super', async (req: AuthRequest, res: Response) => {
  const superFields: Record<string, unknown> = { ...req.body, user_id: req.user!.userId };
  const replay = await beginIdempotentCreate('super_funds', req.user!.userId, req.body, superFields);
  if (replay) { res.status(200).json(replay); return; }

  const { data, error } = await supabase
    .from('super_funds')
    .insert(superFields)
    .select()
    .single();

  if (error) { res.status(500).json({ error: error.message }); return; }
  snapshotNetWorthSoon(req.user!.userId);
  res.status(201).json(data);
});

router.put('/super/:id', async (req: AuthRequest, res: Response) => {
  const { data, error } = await supabase
    .from('super_funds')
    .update({ ...req.body, updated_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .eq('user_id', req.user!.userId)
    .select()
    .single();

  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json(data);
});

// F3: super deletion is durable. Without this endpoint the client's local removal
// was undone by the next bootstrap — the fund resurrected and net worth silently
// jumped back up by the whole balance.
router.delete('/super/:id', async (req: AuthRequest, res: Response) => {
  const { error } = await supabase
    .from('super_funds')
    .delete()
    .eq('id', req.params.id)
    .eq('user_id', req.user!.userId);
  if (error) { res.status(500).json({ error: error.message }); return; }
  snapshotNetWorthSoon(req.user!.userId);
  res.json({ success: true });
});

// ── Stock Watchlist ──────────────────────────────────────────────────────────

router.get('/watchlist', async (req: AuthRequest, res: Response) => {
  const { data, error } = await supabase
    .from('stock_watchlist')
    .select('*')
    .eq('user_id', req.user!.userId)
    .order('created_at', { ascending: false });
  if (error) { res.status(500).json({ error: error.message }); return; }

  const { data: user } = await supabase
    .from('users').select('currency_preference').eq('id', req.user!.userId).single();
  const preferred = user?.currency_preference ?? 'AUD';

  // Enrich each item with (a) its price/target converted into the user's preferred
  // currency for the "(A$…)" line under foreign prices, and (b) the last time it
  // actually reached its target, read from the price-history table.
  const enriched = await Promise.all((data ?? []).map(async (item) => {
    const native = item.native_currency ?? 'AUD';
    const rate = native !== preferred ? await getRate(native, preferred) : 1;
    const converted_price = item.current_price != null
      ? parseFloat((Number(item.current_price) * rate).toFixed(2)) : null;
    const converted_target = item.target_price != null
      ? parseFloat((Number(item.target_price) * rate).toFixed(2)) : null;

    let last_hit_at: string | null = null;
    if (item.target_price != null) {
      let hq = supabase
        .from('stock_watchlist_history')
        .select('recorded_at')
        .eq('watchlist_id', item.id)
        .order('recorded_at', { ascending: false })
        .limit(1);
      hq = item.alert_direction === 'below'
        ? hq.lte('price', Number(item.target_price))
        : hq.gte('price', Number(item.target_price));
      const { data: h } = await hq;
      last_hit_at = h?.[0]?.recorded_at ?? null;
    }

    return { ...item, preferred_currency: preferred, converted_price, converted_target, last_hit_at };
  }));

  res.json({ watchlist: enriched });
});

router.post('/watchlist', async (req: AuthRequest, res: Response) => {
  const b = req.body ?? {};
  const ticker = String(b.ticker ?? '').toUpperCase();
  if (!ticker) { res.status(400).json({ error: 'ticker required' }); return; }

  const market = b.market ?? 'ASX';
  let current_price: number | null = null;
  let native_currency = b.native_currency ?? 'AUD';
  let last_price_update: string | null = null;

  const priceData = await fetchCurrentPrice(ticker, market);
  if (priceData) {
    current_price = priceData.price;
    native_currency = priceData.currency;
    last_price_update = priceData.timestamp;
  }

  const { data, error } = await supabase
    .from('stock_watchlist')
    .insert({
      user_id: req.user!.userId,
      ticker,
      name: b.name ?? ticker,
      market,
      native_currency,
      current_price,
      last_price_update,
      alert_enabled: b.alert_enabled ?? false,
      target_price: b.target_price ?? null,
      alert_direction: b.alert_direction ?? null,
    })
    .select()
    .single();

  if (error) { res.status(500).json({ error: error.message }); return; }

  // Seed the price-history so the "last hit target" lookup has a starting point.
  if (current_price != null) {
    await supabase.from('stock_watchlist_history').insert({
      watchlist_id: data.id,
      user_id: req.user!.userId,
      price: current_price,
      currency: native_currency,
      recorded_at: last_price_update ?? new Date().toISOString(),
    });
  }

  res.status(201).json(data);
});

router.put('/watchlist/:id', async (req: AuthRequest, res: Response) => {
  const allowed = ['name', 'alert_enabled', 'target_price', 'alert_direction', 'alerted'];
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }
  if (updates.alert_enabled === true) updates.alerted = false;

  const { data, error } = await supabase
    .from('stock_watchlist')
    .update(updates)
    .eq('id', req.params.id)
    .eq('user_id', req.user!.userId)
    .select()
    .single();
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json(data);
});

router.delete('/watchlist/:id', async (req: AuthRequest, res: Response) => {
  await supabase.from('stock_watchlist').delete()
    .eq('id', req.params.id).eq('user_id', req.user!.userId);
  res.json({ success: true });
});

// Refresh all watchlist prices for all users + check alerts. Called from the hourly cron.
export async function refreshWatchlistPrices(): Promise<void> {
  const { data: items } = await supabase.from('stock_watchlist').select('*');
  if (!items?.length) return;

  for (const item of items) {
    try {
      const priceData = await fetchCurrentPrice(item.ticker, item.market);
      if (!priceData) continue;

      await supabase.from('stock_watchlist')
        .update({
          current_price: priceData.price,
          native_currency: priceData.currency,
          last_price_update: priceData.timestamp,
          updated_at: new Date().toISOString(),
        })
        .eq('id', item.id);

      // Log a price-history point so we can later show when a stock last hit its target.
      await supabase.from('stock_watchlist_history').insert({
        watchlist_id: item.id,
        user_id: item.user_id,
        price: priceData.price,
        currency: priceData.currency,
        recorded_at: priceData.timestamp,
      });

      // Check price alert
      if (item.alert_enabled && !item.alerted && item.target_price != null) {
        const hit = item.alert_direction === 'above'
          ? priceData.price >= Number(item.target_price)
          : priceData.price <= Number(item.target_price);

        if (hit) {
          await supabase.from('stock_watchlist')
            .update({ alerted: true })
            .eq('id', item.id);

          // Send Telegram alert
          const { data: user } = await supabase
            .from('users')
            .select('telegram_bot_token, telegram_chat_id, currency_preference')
            .eq('id', item.user_id)
            .single();

          if (user?.telegram_bot_token && user?.telegram_chat_id) {
            const dir = item.alert_direction === 'above' ? '📈 above' : '📉 below';
            const msg = `🔔 *Price Alert*\n\n*${item.name}* (${item.ticker}) hit ${dir} your target of $${Number(item.target_price).toFixed(2)}.\n\nCurrent price: *$${priceData.price.toFixed(2)}* ${priceData.currency}`;
            const { default: TelegramBot } = await import('node-telegram-bot-api');
            void fetch(`https://api.telegram.org/bot${user.telegram_bot_token}/sendMessage`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ chat_id: user.telegram_chat_id, text: msg, parse_mode: 'Markdown' }),
            }).catch(() => {});
          }
        }
      }
    } catch (err) {
      console.error(`[WATCHLIST] Price refresh failed for ${item.ticker}:`, err);
    }
  }
}

export default router;
