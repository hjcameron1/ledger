import { Router, Request, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { supabase } from '../utils/supabase';
import { verifyInvestmentCalculation, verifyPortfolioTotal } from '../utils/investmentVerification';
import { fetchCurrentPrice, searchTicker } from '../services/priceService';
import { convertAmount } from '../services/currencyService';

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
      const { converted, rate } = await convertAmount(v.current_value, inv.native_currency, preferredCurrency);
      displayValue = converted;
      conversionRate = rate;
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

  res.json({ investments: verified, portfolio_total: total, portfolio_verified: portfolioCheck.verified });
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
