import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import cron from 'node-cron';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

import authRouter from './routes/auth';
import accountsRouter from './routes/accounts';
import investmentsRouter from './routes/investments';
import investmentPlansRouter from './routes/investmentPlans';
import smsfRouter from './routes/smsf';
import payrollRouter from './routes/payroll';
import incomeRouter from './routes/income';
import overviewRouter from './routes/overview';
import settingsRouter from './routes/settings';
import uploadRouter from './routes/upload';
import basiqRouter from './routes/basiq';
import telegramRouter from './routes/telegram';
import loansRouter from './routes/loans';
import propertiesRouter from './routes/properties';
import householdsRouter from './routes/households';
import sharesRouter from './routes/shares';
import integrationRouter from './routes/integration';
import { updateAllInvestmentPrices, fetchCurrentPrice } from './services/priceService';
import { fetchChartQuote } from './services/yahooChart';
import { supabase } from './utils/supabase';
import { syncDividends } from './services/dividendService';
import { fetchAndStoreDailyRates } from './services/currencyService';
import { registerAllWebhooks, sendScheduledBriefings, sendScheduledBillReminders } from './services/telegramService';
import { scrapeAllDealers } from './services/metalScraper';
import { snapshotAllUsers } from './services/portfolioSnapshot';
import { snapshotAllNetWorth } from './services/netWorthSnapshot';
import { refreshWatchlistPrices } from './routes/investments';

const app = express();
const PORT = process.env.PORT ?? 3001;

app.use(helmet({ crossOriginEmbedderPolicy: false }));
app.use(cors({
  origin: process.env.FRONTEND_URL ?? 'http://localhost:5173',
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// General API limiter. A single app bootstrap legitimately fires ~15-20 requests
// (accounts, cards, per-card payments, PAGED transactions, investments, bills,
// goals, budgets, …), so the old 200/15min cap (~13/min) could lock an active
// user out within a couple of reloads — including out of /api/auth, since this
// was applied globally. Raised to a realistic ceiling that still curbs abuse.
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1500,
  standardHeaders: true,
  legacyHeaders: false,
});

// Dedicated, stricter limiter for auth so brute-force attempts are still curbed,
// but login/refresh is NEVER starved by a data-heavy bootstrap sharing the bucket.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  standardHeaders: true,
  legacyHeaders: false,
});

// Auth is governed ONLY by its own (stricter) bucket so a data-heavy bootstrap
// can never exhaust the budget login needs. All other API routes share the
// general limiter.
app.use('/api/auth', authLimiter, authRouter);
app.use('/api/accounts', limiter, accountsRouter);
app.use('/api/investments', limiter, investmentsRouter);
app.use('/api/investment-plans', limiter, investmentPlansRouter);
app.use('/api/smsf', limiter, smsfRouter);
app.use('/api/payroll', limiter, payrollRouter);
app.use('/api/income', limiter, incomeRouter);
app.use('/api/overview', limiter, overviewRouter);
app.use('/api/settings', limiter, settingsRouter);
app.use('/api/upload', limiter, uploadRouter);
app.use('/api/basiq', limiter, basiqRouter);
app.use('/api/telegram', limiter, telegramRouter);
app.use('/api/loans', limiter, loansRouter);
app.use('/api/properties', limiter, propertiesRouter);
app.use('/api/households', limiter, householdsRouter);
app.use('/api/shares', limiter, sharesRouter);
// Ecosystem integration API — read-only, per-app key auth (see integrationAuth).
// Consumed by PAssistant (and future apps) for a live financial summary.
app.use('/api/integration', limiter, integrationRouter);

// Price-feed health, for diagnosing quietly-dead quote sources from outside the
// box. Feed-level only — a live probe of one public symbol per source and the
// staleness of the most recent stored price. No user data of any kind.
app.get('/api/health/prices', async (_req, res) => {
  const probe = async <T>(fn: () => Promise<T>): Promise<{ ok: boolean; value?: T; error?: string }> => {
    try {
      const value = await fn();
      return value ? { ok: true, value } : { ok: false, error: 'empty result' };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message.slice(0, 300) : String(err) };
    }
  };
  const [quotePath, chartPath, staleness] = await Promise.all([
    probe(() => fetchCurrentPrice('SPY', 'NYSE')),
    probe(() => fetchChartQuote('SPY')),
    supabase.from('investments')
      .select('last_price_update')
      .not('last_price_update', 'is', null)
      .order('last_price_update', { ascending: false })
      .limit(1)
      .then(r => r.data?.[0]?.last_price_update ?? null),
  ]);
  res.json({
    now: new Date().toISOString(),
    combined_fetch: quotePath,
    chart_endpoint: chartPath,
    newest_stored_price: staleness,
    hours_stale: staleness ? parseFloat(((Date.now() - new Date(staleness).getTime()) / 3_600_000).toFixed(1)) : null,
  });
});

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Scheduled jobs
// Non-crypto holdings refresh hourly, but each holding only actually updates
// while ITS market is open (see updateAllInvestmentPrices / marketCalendar) —
// so prices and the FX snapshot freeze at each market's close and resume at its
// next session. FX rates themselves are refreshed on the same hourly tick.
const NON_CRYPTO_TYPES = ['stock', 'etf', 'precious_metal', 'managed_fund', 'private', 'other'];
cron.schedule('0 * * * *', async () => {
  console.log('[CRON] Hourly FX + market-aware price refresh...');
  await fetchAndStoreDailyRates('AUD');
  await fetchAndStoreDailyRates('USD');
  await fetchAndStoreDailyRates('EUR');
  await fetchAndStoreDailyRates('GBP');
  await updateAllInvestmentPrices(NON_CRYPTO_TYPES);
  // Record a portfolio P&L % snapshot for every holder, now that prices/FX are fresh.
  try {
    const recorded = await snapshotAllUsers();
    console.log(`[CRON] Portfolio P&L snapshot recorded for ${recorded} user(s)`);
  } catch (err) {
    console.error('[CRON] Portfolio P&L snapshot failed:', err);
  }
  try {
    await refreshWatchlistPrices();
    console.log('[CRON] Watchlist prices refreshed + alerts checked');
  } catch (err) {
    console.error('[CRON] Watchlist refresh failed:', err);
  }
  try {
    const recorded = await snapshotAllNetWorth();
    console.log(`[CRON] Net-worth snapshot recorded for ${recorded} user(s)`);
  } catch (err) {
    console.error('[CRON] Net-worth snapshot failed:', err);
  }
});

// Crypto trades 24/7 — refresh every 2 hours (not market-gated).
cron.schedule('0 */2 * * *', async () => {
  console.log('[CRON] Updating crypto prices...');
  await updateAllInvestmentPrices(['crypto']);
});

// Dividend check — twice daily. For every dividend-paying holding, look up
// dividends paid this financial year (Yahoo) and create PENDING income entries
// for any newly-seen ones, so the user confirms before they count. Deduped by
// reference_number, so running twice a day is safe/idempotent.
cron.schedule('0 7,19 * * *', async () => {
  console.log('[CRON] Dividend sync (all users)...');
  try {
    const { created, checked } = await syncDividends();
    console.log(`[CRON] Dividend sync done — ${created} new pending entr${created === 1 ? 'y' : 'ies'} across ${checked} holding(s)`);
  } catch (err) {
    console.error('[CRON] Dividend sync failed:', err);
  }
});

// Precious-metal dealer price scrape — hourly, in lockstep with the stock/ETF/FX
// refresh above so dealer buy/buyback prices stay as fresh as everything else.
// Crawls each supported Australian bullion dealer's catalogue and upserts
// authentic per-product buy + buyback prices into metal_products, powering the
// in-depth metal holding form. Scraping is fail-soft per dealer, so a broken site
// never aborts the run.
cron.schedule('0 * * * *', async () => {
  console.log('[CRON] Metal dealer price scrape...');
  try {
    const results = await scrapeAllDealers();
    for (const r of results) {
      console.log(`[CRON] ${r.dealer}: ${r.upserted} products${r.error ? ` (error: ${r.error})` : ''}`);
    }
  } catch (err) {
    console.error('[CRON] Metal dealer scrape failed:', err);
  }
});

// Keepalive self-ping. Render's free tier spins the web service down after ~15
// min of no inbound HTTP traffic, which would silently kill the in-process price
// crons during the US session (≈ Sat pre-dawn AEST, when nobody is using the
// app) — so prices froze at the previous close. Pinging our own public URL every
// 10 min counts as inbound traffic and keeps the instance awake so the hourly
// refresh always fires. Render injects RENDER_EXTERNAL_URL automatically; if it's
// absent (e.g. local dev) the keepalive is simply skipped.
const SELF_URL = process.env.RENDER_EXTERNAL_URL;
if (SELF_URL) {
  console.log('[CRON] Keepalive self-ping registered (every 10 min)');
  cron.schedule('*/10 * * * *', async () => {
    try {
      await fetch(`${SELF_URL}/api/health`);
    } catch (err) {
      console.error('[CRON] Keepalive ping failed:', err);
    }
  });
} else {
  console.log('[CRON] Keepalive self-ping skipped — RENDER_EXTERNAL_URL not set');
}

// Morning briefings — check every minute and send to users whose time has come
console.log('[CRON] Morning briefing scheduler registered — fires every minute (server UTC offset: ' + (new Date().getTimezoneOffset() / -60) + 'h)');
cron.schedule('* * * * *', async () => {
  try { await sendScheduledBriefings(); }
  catch (err) { console.error('[CRON] sendScheduledBriefings failed:', err); }
  try { await sendScheduledBillReminders(); }
  catch (err) { console.error('[CRON] sendScheduledBillReminders failed:', err); }
});

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`Ledger backend running on port ${PORT}`);
  // Surface which document-parsing keys are present so PDF-path issues are
  // diagnosable from startup logs alone (no upload required). Booleans only —
  // never log key values.
  console.log(`[BOOT] Document parsing keys — GROQ_API_KEY: ${!!process.env.GROQ_API_KEY}, CLAUDE_API_KEY: ${!!process.env.CLAUDE_API_KEY}`);
  fetchAndStoreDailyRates('AUD').catch(console.error);
  // Production delivers Telegram updates via webhooks (single push-based path —
  // no getUpdates 409 "terminated by other getUpdates" conflicts, and nothing to
  // silently die like a long-poll loop). Local dev has no public URL, so bots are
  // started on demand via the verify/test endpoints (long-polling) instead.
  if (process.env.NODE_ENV === 'production') {
    registerAllWebhooks().catch(err => console.error('[BOOT] registerAllWebhooks failed:', err));
  } else {
    console.log('[BOOT] Skipping webhook registration — NODE_ENV is not "production".');
  }
});

export default app;
