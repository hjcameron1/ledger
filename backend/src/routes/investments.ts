import { Router, Request, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { supabase } from '../utils/supabase';
import { verifyInvestmentCalculation, verifyPortfolioTotal } from '../utils/investmentVerification';
import { fetchCurrentPrice, searchTicker } from '../services/priceService';
import { convertAmount } from '../services/currencyService';
import { isMarketOpen, isHoursGated, nextMarketOpen } from '../services/marketCalendar';

const router = Router();

// ── Public routes (Yahoo Finance proxies — no auth needed) ────────────────────

router.get('/search', async (req: Request, res: Response) => {
  const { q } = req.query;
  if (!q) { res.status(400).json({ error: 'Query required' }); return; }
  const results = await searchTicker(q as string);
  res.json(results);
});

router.get('/price/:ticker', async (req: Request, res: Response) => {
  const { ticker } = req.params;
  const { market } = req.query;
  const result = await fetchCurrentPrice(ticker, (market as string) ?? 'ASX');
  if (!result) { res.status(404).json({ error: 'Price not found' }); return; }
  res.json(result);
});

// ── Authenticated routes ───────────────────────────────────────────────────────
router.use(authenticate);

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

  const verified = await Promise.all((investments ?? []).map(async (inv) => {
    const v = verifyInvestmentCalculation(inv.shares_owned, inv.current_price, inv.cost_basis);
    let displayValue = v.current_value;
    let conversionRate = 1;

    if (inv.native_currency && inv.native_currency !== preferredCurrency) {
      // Prefer the FX rate snapshotted at the last in-session refresh (frozen
      // while the market is closed). Fall back to a live rate only when no
      // snapshot exists yet, or the user changed their preferred currency since.
      if (inv.conversion_rate && inv.display_currency === preferredCurrency) {
        conversionRate = Number(inv.conversion_rate);
        displayValue = parseFloat((v.current_value * conversionRate).toFixed(2));
      } else {
        const { converted, rate } = await convertAmount(v.current_value, inv.native_currency, preferredCurrency);
        displayValue = converted;
        conversionRate = rate;
      }
    }

    return {
      ...inv,
      verification: v,
      display_value: displayValue,
      display_currency: preferredCurrency,
      conversion_rate: conversionRate,
    };
  }));

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

  if (ticker && market) {
    const priceData = await fetchCurrentPrice(ticker, market);
    if (priceData) {
      current_price = priceData.price;
      native_currency = priceData.currency;
      last_price_update = priceData.timestamp;
    }
  }

  const v = verifyInvestmentCalculation(shares_owned, current_price, cost_basis);

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
      current_price,
      current_value: v.current_value,
      currency: req.body.currency ?? 'AUD',
      native_currency,
      last_price_update,
      is_dividend_paying: req.body.is_dividend_paying ?? false,
    })
    .select()
    .single();

  if (error) { res.status(500).json({ error: error.message }); return; }
  res.status(201).json({ investment: data, verification: v });
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
  res.json(data);
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
