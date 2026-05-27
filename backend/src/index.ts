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

// Diagnostic: verify Claude API key is reachable
app.get('/api/test-claude', async (_req, res) => {
  const key = process.env.CLAUDE_API_KEY;
  console.log('[test-claude] CLAUDE_API_KEY present:', !!key);
  console.log('[test-claude] key prefix:', key ? key.slice(0, 25) + '...' : 'MISSING');
  console.log('[test-claude] __dirname:', __dirname);
  console.log('[test-claude] .env path:', path.resolve(__dirname, '../.env'));

  if (!key) {
    res.status(500).json({ ok: false, error: 'CLAUDE_API_KEY is not set in process.env' });
    return;
  }

  try {
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    const client = new Anthropic({ apiKey: key });
    const response = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 10,
      messages: [{ role: 'user', content: 'Say "ok"' }],
    });
    const text = response.content[0].type === 'text' ? response.content[0].text : '(no text)';
    console.log('[test-claude] SUCCESS:', text);
    res.json({ ok: true, response: text, model: 'claude-haiku-4-5' });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[test-claude] FAILED:', msg);
    res.status(500).json({ ok: false, error: msg });
  }
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

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`Ledger backend running on port ${PORT}`);
  fetchAndStoreDailyRates('AUD').catch(console.error);
});

export default app;
