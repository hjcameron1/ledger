/**
 * The API, as an Express app and nothing else.
 *
 * Split out from index.ts so the same routes can be served by two very
 * different hosts: a Node process (local dev) and a Cloudflare Worker
 * (production). Neither the port nor the clock is decided here — this file
 * knows what the endpoints are, and the entry point knows what is running them.
 */
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

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
import documentsRouter from './routes/documents';
import insuranceRouter from './routes/insurance';
import { fetchCurrentPrice } from './services/priceService';
import { fetchChartQuote } from './services/yahooChart';
import { supabase } from './utils/supabase';
import { jsonBodyErrorHandler } from './utils/jsonErrorHandler';
import { configuredProviders, providerOrder, GROQ_MODEL, CLAUDE_MODEL } from './services/aiText';

export function createApp(): express.Express {
  const app = express();

  app.use(helmet({ crossOriginEmbedderPolicy: false }));
  // One or more comma-separated frontends. It was a single string, which was
  // fine while there was a single site; during a move there are two — the new
  // host and the old one — and a list lets both keep working until the old one
  // is retired.
  const origins = (process.env.FRONTEND_URL ?? 'http://localhost:5173')
    .split(',').map((o) => o.trim()).filter(Boolean);
  app.use(cors({ origin: origins, credentials: true }));
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true }));

  // A malformed request body is a client error, not a server one — turn the
  // body-parser SyntaxError into a 400 before it reaches any route.
  app.use(jsonBodyErrorHandler);

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
  // Phase 8.1 — the document vault. Files stream through here (private bucket,
  // no public URLs); visibility follows the record a document is linked to.
  app.use('/api/documents', limiter, documentsRouter);
  // Phase 8.2 — insurance policies. Same visibility law as the vault: a policy
  // follows the thing it covers, so a shared house brings its cover with it.
  app.use('/api/insurance', limiter, insuranceRouter);
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
    res.json({
      status: 'ok',
      // Which commit is actually serving, and how long this process has been up.
      // Pushing is not deploying: a failed build leaves the previous version
      // running and everything still answers 'ok', so a fix can look shipped for
      // days.
      version: (process.env.GIT_COMMIT ?? process.env.RENDER_GIT_COMMIT ?? 'dev').slice(0, 7),
      // Which host answered. Worth stating during a move, when two of them are up.
      host: process.env.HOST_LABEL ?? 'node',
      // Uptime meant something on an always-on box: a short one betrayed a restart
      // that had silently killed the per-minute briefing cron. A Worker has no
      // uptime — it is started per request — and the schedule is Cloudflare's, not
      // this process's, so the honest answer there is null.
      up_seconds: typeof process.uptime === 'function' ? Math.round(process.uptime()) : null,
      timestamp: new Date().toISOString(),
    });
  });

  // Which model providers this deployment can actually reach. Booleans and model
  // names only — never a key, never user data. Exists because "the AI button does
  // nothing" was, every time, one unset environment variable, and there was no way
  // to see that from outside the box. `order` is what a job that prefers Groq
  // (transaction suggestions) would actually try.
  app.get('/api/health/ai', (_req, res) => {
    const available = configuredProviders();
    res.json({
      groq: available.includes('groq'),
      claude: available.includes('claude'),
      order: providerOrder(['groq', 'claude'], available),
      models: { groq: GROQ_MODEL, claude: CLAUDE_MODEL },
    });
  });

  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error(err.stack);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}
