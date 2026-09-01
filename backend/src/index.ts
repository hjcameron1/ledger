/**
 * Local development entry point: a Node process serving the API on a port, with
 * node-cron running the schedule inside it.
 *
 * Production does NOT come through here — Cloudflare runs `worker.ts` instead,
 * and the clock there belongs to Cloudflare rather than to any one process.
 * Both build the same Express app from `app.ts` and call the same jobs from
 * `jobs.ts`, so neither can drift from the other about what the API is or what
 * the scheduled work does.
 */
import path from 'path';
import dotenv from 'dotenv';
import cron from 'node-cron';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

import { assertRequiredEnv } from './utils/env';

assertRequiredEnv();

import { createApp } from './app';
import { configuredProviders } from './services/aiText';
import { fetchAndStoreDailyRates } from './services/currencyService';
import { registerAllWebhooks, checkTelegramConnections } from './services/telegramService';
import {
  hourlyPricesAndSnapshots, cryptoPrices, dividendSync, metalDealerScrape,
  telegramConnectionCheck, minuteDeliveries, reapUnverified,
} from './jobs';

const app = createApp();
const PORT = process.env.PORT ?? 3001;

// The same schedule production runs, expressed for node-cron. The expressions
// are duplicated in wrangler.toml because Cloudflare needs them declared there;
// if you change one, change the other.
cron.schedule('0 * * * *', hourlyPricesAndSnapshots);
cron.schedule('5 * * * *', metalDealerScrape);
cron.schedule('0 */2 * * *', cryptoPrices);
cron.schedule('0 7,19 * * *', dividendSync);
cron.schedule('*/15 * * * *', telegramConnectionCheck);
cron.schedule('* * * * *', minuteDeliveries);
cron.schedule('0 3 * * *', reapUnverified);

app.listen(PORT, () => {
  console.log(`Ledger backend running on port ${PORT}`);
  // Surface which document-parsing keys are present so PDF-path issues are
  // diagnosable from startup logs alone (no upload required). Booleans only —
  // never log key values.
  console.log(`[BOOT] AI providers configured: ${configuredProviders().join(', ') || 'NONE'} (GET /api/health/ai)`);
  fetchAndStoreDailyRates('AUD').catch(console.error);
  // Telegram updates are delivered by webhook — a single push-based path, with
  // no getUpdates 409 conflicts and no long-poll loop to die quietly. Local dev
  // has no public URL, so bots are started on demand by the verify/test
  // endpoints instead.
  if (process.env.NODE_ENV === 'production') {
    registerAllWebhooks()
      // Check the connection once the webhooks are in place, so the recorded
      // health is never older than this process.
      .then(() => checkTelegramConnections())
      .catch(err => console.error('[BOOT] registerAllWebhooks failed:', err));
  } else {
    console.log('[BOOT] Skipping webhook registration — NODE_ENV is not "production".');
  }
});

export default app;
