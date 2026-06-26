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
import { updateAllInvestmentPrices } from './services/priceService';
import { syncDividends } from './services/dividendService';
import { fetchAndStoreDailyRates } from './services/currencyService';
import { startAllUserBots, sendScheduledBriefings, sendScheduledBillReminders } from './services/telegramService';
import { scrapeAllDealers } from './services/metalScraper';
import { snapshotAllUsers } from './services/portfolioSnapshot';
import { snapshotAllNetWorth } from './services/netWorthSnapshot';

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
  // Only start long-polling bots in production (Render).
  // Running polling locally alongside Render causes ETELEGRAM 409 Conflict.
  if (process.env.NODE_ENV === 'production') {
    startAllUserBots().catch(err => console.error('[BOOT] startAllUserBots failed:', err));
  } else {
    console.log('[BOOT] Skipping bot polling — NODE_ENV is not "production". Set NODE_ENV=production on Render to enable.');
  }
});

export default app;
