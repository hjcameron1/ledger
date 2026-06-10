import { Router, Request, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { supabase } from '../utils/supabase';
import { verifyInvestmentCalculation, verifyPortfolioTotal } from '../utils/investmentVerification';
import { fetchCurrentPrice, searchTicker, isMetal, fetchMetalSpotPerUnit, fetchDealerPricePerUnit } from '../services/priceService';
import { scrapeAllDealers } from '../services/metalScraper';
import { getRate, getRateOn } from '../services/currencyService';
import { isMarketOpen, isHoursGated, nextMarketOpen } from '../services/marketCalendar';
import { recordPortfolioSnapshot } from '../services/portfolioSnapshot';
import { recordNetWorthSnapshot } from '../services/netWorthSnapshot';

// Fire-and-forget net-worth snapshot after a holding is added/removed, so the
// "since you started" headline treats it as tracked-from-now (not a sudden gain/loss).
function snapshotNetWorthSoon(userId: string): void {
  recordNetWorthSnapshot(userId).catch(err => console.error('[nw] post-change snapshot failed:', err));
}

const router = Router();

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
  const valueNative = (Number(inv.shares_owned) || 0) * (Number(inv.current_price) || 0);

  // native → preferred rate. Prefer the in-session snapshot when it's a real,
  // non-placeholder rate matching the current preferred currency; else go live.
  let rate = 1;
  if (inv.native_currency && inv.native_currency !== preferredCurrency) {
    if (inv.conversion_rate && Number(inv.conversion_rate) !== 1 && inv.display_currency === preferredCurrency) {
      rate = Number(inv.conversion_rate);
    } else {
      rate = await getRate(inv.native_currency, preferredCurrency);
    }
  }
  const valuePref = parseFloat((valueNative * rate).toFixed(2));

  // cost → preferred
  const costCcy = inv.cost_basis_currency || inv.native_currency || preferredCurrency;
  const costRaw = Number(inv.cost_basis) || 0;
  let costPref: number;
  if (costCcy === preferredCurrency)        costPref = parseFloat(costRaw.toFixed(2));
  else if (costCcy === inv.native_currency) costPref = parseFloat((costRaw * rate).toFixed(2));
  else                                       costPref = parseFloat((costRaw * await getRate(costCcy, preferredCurrency)).toFixed(2));

  const profit_loss = parseFloat((valuePref - costPref).toFixed(2));
  const profit_loss_percent = costPref !== 0 ? parseFloat(((profit_loss / costPref) * 100).toFixed(4)) : 0;

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
  const { data: investments, error } = await supabase
    .from('investments')
    .select('*')
    .eq('user_id', req.user!.userId)
    .order('created_at', { ascending: false });

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
    investments: verified,
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

  const { data, error } = await supabase
    .from('investments')
    .insert({
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
    })
    .select()
    .single();

  if (error) { res.status(500).json({ error: error.message }); return; }

  // Return the holding already converted into the owner's preferred currency so
  // the optimistic record the client created is replaced with correct display
  // figures (value, cost, P&L all in preferred) instead of raw native numbers.
  const enriched = await enrichInvestment(data, preferred);
  snapshotNetWorthSoon(req.user!.userId);
  res.status(201).json({ investment: enriched, verification: enriched.verification });
});

router.put('/:id', async (req: AuthRequest, res: Response) => {
  const { shares_owned, cost_basis, current_price } = req.body;
  const updates: Record<string, unknown> = { ...req.body, updated_at: new Date().toISOString() };

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

  const { data, error } = await supabase
    .from('investments')
    .update(updates)
    .eq('id', req.params.id)
    .eq('user_id', req.user!.userId)
    .select()
    .single();

  if (error) { res.status(500).json({ error: error.message }); return; }

  res.json(await enrichInvestment(data, preferred));
});

router.delete('/:id', async (req: AuthRequest, res: Response) => {
  await supabase.from('investments').delete()
    .eq('id', req.params.id).eq('user_id', req.user!.userId);
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
  // AU individual rule: 50% discount only when held > 12 months AND it's a gain.
  const discount_eligible = held_days != null && held_days > 365 && gain > 0;

  const { data, error } = await supabase
    .from('investment_sales')
    .insert({
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
    })
    .select()
    .single();

  if (error) { res.status(500).json({ error: error.message }); return; }
  res.status(201).json({ sale: data });
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
  const { data, error } = await supabase
    .from('super_funds')
    .insert({ ...req.body, user_id: req.user!.userId })
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

export default router;
