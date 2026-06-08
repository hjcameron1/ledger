import { Router, Request, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { supabase } from '../utils/supabase';
import { verifyInvestmentCalculation, verifyPortfolioTotal } from '../utils/investmentVerification';
import { fetchCurrentPrice, searchTicker, isMetal, fetchMetalSpotPerUnit } from '../services/priceService';
import { scrapeAllDealers } from '../services/metalScraper';
import { getRate } from '../services/currencyService';
import { isMarketOpen, isHoursGated, nextMarketOpen } from '../services/marketCalendar';

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
async function enrichInvestment(
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
  const { q } = req.query;
  if (!q) { res.status(400).json({ error: 'Query required' }); return; }
  const results = await searchTicker(q as string);
  res.json(results);
});

router.get('/price/:ticker', async (req: Request, res: Response) => {
  const { ticker } = req.params;
  const { market, unit } = req.query;
  // Metals quote per troy-oz; return the price for the chosen weight unit instead.
  const result = isMetal(ticker)
    ? await fetchMetalSpotPerUnit(ticker, (unit as string) ?? 'grams')
    : await fetchCurrentPrice(ticker, (market as string) ?? 'ASX');
  if (!result) { res.status(404).json({ error: 'Price not found' }); return; }
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

router.post('/', async (req: AuthRequest, res: Response) => {
  const { ticker, market, shares_owned, cost_basis, name, asset_type } = req.body;

  let current_price = req.body.current_price ?? 0;
  let native_currency = req.body.native_currency ?? 'AUD';
  let last_price_update = null;

  // Precious-metal metadata. In-depth holdings price a specific physical product
  // (form/mint premium over spot) with a manually-entered sell price; generic
  // holdings track live spot, converted to the chosen weight unit.
  const metalDetailed = !!req.body.metal_detailed;
  const metalUnit = req.body.metal_unit ?? 'grams';

  if (asset_type === 'precious_metal') {
    if (metalDetailed) {
      // Valuation follows the per-unit sell price the user recorded.
      current_price = Number(req.body.metal_sell_price) || current_price;
    } else {
      const spot = await fetchMetalSpotPerUnit(ticker, metalUnit);
      if (spot) {
        current_price = spot.price;
        native_currency = spot.currency;
        last_price_update = spot.timestamp;
      }
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
  // Currency the user entered the cost in (AUD↔native toggle). Default: native.
  const cost_basis_currency = req.body.cost_basis_currency ?? native_currency;

  const { data, error } = await supabase
    .from('investments')
    .insert({
      user_id: req.user!.userId,
      name: name ?? ticker,
      ticker,
      market,
      asset_type: asset_type ?? 'stock',
      shares_owned,
      cost_basis,
      cost_basis_currency,
      current_price,
      current_value: v.current_value,
      currency: req.body.currency ?? 'AUD',
      native_currency,
      last_price_update,
      is_dividend_paying: req.body.is_dividend_paying ?? false,
      ...(asset_type === 'precious_metal' ? {
        metal_unit: metalUnit,
        metal_form: req.body.metal_form ?? 'generic',
        metal_mint: req.body.metal_mint ?? null,
        metal_detailed: metalDetailed,
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
  const { data: u } = await supabase
    .from('users').select('currency_preference').eq('id', req.user!.userId).single();
  const enriched = await enrichInvestment(data, u?.currency_preference ?? 'AUD');
  res.status(201).json({ investment: enriched, verification: enriched.verification });
});

router.put('/:id', async (req: AuthRequest, res: Response) => {
  const { shares_owned, cost_basis, current_price } = req.body;
  const updates: Record<string, unknown> = { ...req.body, updated_at: new Date().toISOString() };

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

  const { data: u } = await supabase
    .from('users').select('currency_preference').eq('id', req.user!.userId).single();
  res.json(await enrichInvestment(data, u?.currency_preference ?? 'AUD'));
});

router.delete('/:id', async (req: AuthRequest, res: Response) => {
  await supabase.from('investments').delete()
    .eq('id', req.params.id).eq('user_id', req.user!.userId);
  res.json({ success: true });
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
