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
import incomeRouter from './routes/income';
import overviewRouter from './routes/overview';
import settingsRouter from './routes/settings';
import uploadRouter from './routes/upload';
import basiqRouter from './routes/basiq';
import telegramRouter from './routes/telegram';
import { updateAllInvestmentPrices } from './services/priceService';
import { fetchAndStoreDailyRates } from './services/currencyService';
import { startAllUserBots, sendScheduledBriefings } from './services/telegramService';

const app = express();
const PORT = process.env.PORT ?? 3001;

app.use(helmet({ crossOriginEmbedderPolicy: false }));
app.use(cors({
  origin: process.env.FRONTEND_URL ?? 'http://localhost:5173',
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 200 });
app.use(limiter);

app.use('/api/auth', authRouter);
app.use('/api/accounts', accountsRouter);
app.use('/api/investments', investmentsRouter);
app.use('/api/income', incomeRouter);
app.use('/api/overview', overviewRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/upload', uploadRouter);
app.use('/api/basiq', basiqRouter);
app.use('/api/telegram', telegramRouter);

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Scheduled jobs
// Update investment prices 5x daily during market hours (AEST)
cron.schedule('0 10,12,14,16,20 * * 1-5', async () => {
  console.log('[CRON] Updating investment prices...');
  await updateAllInvestmentPrices();
});

// Update currency rates daily at midnight
cron.schedule('0 0 * * *', async () => {
  console.log('[CRON] Updating currency rates...');
  await fetchAndStoreDailyRates('AUD');
  await fetchAndStoreDailyRates('USD');
  await fetchAndStoreDailyRates('EUR');
  await fetchAndStoreDailyRates('GBP');
});

// Morning briefings — check every minute and send to users whose time has come
console.log('[CRON] Morning briefing scheduler registered — fires every minute (server UTC offset: ' + (new Date().getTimezoneOffset() / -60) + 'h)');
cron.schedule('* * * * *', async () => {
  await sendScheduledBriefings();
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
