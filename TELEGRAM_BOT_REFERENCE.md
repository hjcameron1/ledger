# Telegram Bot — Connection & Settings (portable reference)

Extracted from Ledger. This covers **connecting a per-user bot** (verify token → store →
start polling → reply) and the **briefing/settings** plumbing. The finance-specific
briefing *content* is intentionally omitted — replace `telegramAIResponse` /
`sendMorningBriefing` body with your own app's logic.

## Architecture
- **Per-user bots.** Each user supplies their OWN bot token (from @BotFather). Tokens are
  stored on the `users` row; on boot the server starts a long-polling bot per user.
- **Library:** `node-telegram-bot-api` (polling). Plus raw `fetch` to
  `https://api.telegram.org/bot<TOKEN>/<method>` for one-off sends/verification.
- **Polling only in production.** Two processes polling the same token → Telegram 409
  Conflict. Gate `startUserBot` behind `NODE_ENV === 'production'`.
- **Scheduled messages** ("briefings") fire from a 1-minute cron that checks each user's
  configured local send-time/timezone.

```
npm i node-telegram-bot-api
```

## DB columns / tables
```sql
-- on your users table:
ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_bot_token TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_chat_id   TEXT;

-- conversation memory (optional, for AI replies):
CREATE TABLE IF NOT EXISTS telegram_conversations (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL,          -- 'user' | 'assistant'
  message    TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- scheduled-message settings (one row per user):
CREATE TABLE IF NOT EXISTS telegram_briefing_settings (
  user_id        UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  enabled        BOOLEAN DEFAULT TRUE,
  send_time      TEXT DEFAULT '08:00',          -- HH:MM local
  timezone       TEXT DEFAULT 'Australia/Sydney',
  days           TEXT[] DEFAULT ARRAY['mon','tue','wed','thu','fri','sat','sun'],
  last_sent_date DATE,                            -- once-per-day guard
  -- ...add your own content-toggle columns here...
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);
```

## Environment
- `JWT_SECRET` — used to authenticate the verify/test endpoints.
- `CRON_SECRET` — shared secret for the external uptime-ping endpoint (optional but
  recommended on free tiers that sleep).
- `NODE_ENV=production` — required on the host that should actually poll.

---

## 1) Telegram API helper + connection routes (`routes/telegram.ts`)
No app auth required on these (they only proxy to Telegram), but they read the JWT if
present to persist the token to the right user.

```ts
import { Router, Request, Response } from 'express';
import { startUserBot, ensureBriefingRowForUser } from '../services/telegramService';
import { supabase } from '../utils/supabase';
import jwt from 'jsonwebtoken';

const router = Router();

// Call any Telegram Bot API method.
async function tgApi(botToken: string, method: string, body?: Record<string, unknown>) {
  const url = `https://api.telegram.org/bot${botToken}/${method}`;
  const res = await fetch(url, body
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : { method: 'GET' });
  return res.json() as Promise<Record<string, unknown>>;
}

// ── POST /api/telegram/verify ──
// Validate a bot token via getMe; if a valid JWT is attached, store it and start polling.
router.post('/verify', async (req: Request, res: Response) => {
  const { token: botToken, timezone: browserTz } = req.body as { token?: string; timezone?: string };
  if (!botToken?.trim()) { res.status(400).json({ ok: false, error: 'Bot token is required' }); return; }

  let tgResult: Record<string, unknown>;
  try { tgResult = await tgApi(botToken.trim(), 'getMe'); }
  catch { res.json({ ok: false, error: 'Could not reach Telegram API' }); return; }
  if (!tgResult.ok) { res.json({ ok: false, error: (tgResult.description as string) ?? 'Invalid bot token' }); return; }

  const botInfo = tgResult.result as { id: number; username?: string; first_name?: string };

  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    try {
      const payload = jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET ?? 'dev-secret') as { userId: string };
      await supabase.from('users').update({ telegram_bot_token: botToken.trim() }).eq('id', payload.userId);
      await ensureBriefingRowForUser(payload.userId, browserTz);
      if (process.env.NODE_ENV === 'production') {
        try { await startUserBot(payload.userId, botToken.trim()); } catch (e) { console.error('startUserBot failed', e); }
      }
    } catch { /* invalid JWT — skip persistence (demo mode) */ }
  }
  res.json({ ok: true, id: botInfo.id, username: botInfo.username, firstName: botInfo.first_name });
});

// ── POST /api/telegram/test ──
// Find a recent chat_id (or the stored one), send a confirmation message, store chat_id, start polling.
router.post('/test', async (req: Request, res: Response) => {
  const { token: botToken } = req.body as { token?: string };
  if (!botToken?.trim()) { res.status(400).json({ ok: false, error: 'Bot token is required' }); return; }

  let chatId: number | null = null;
  let firstName = 'there';

  // 1. recent update history
  try {
    const updates = await tgApi(botToken.trim(), 'getUpdates', { limit: 10, timeout: 0 }) as {
      ok: boolean; result?: Array<{ message?: { chat: { id: number }; from?: { first_name?: string } } }>; description?: string;
    };
    if (!updates.ok) { res.json({ ok: false, error: updates.description ?? 'Could not connect' }); return; }
    const last = updates.result?.slice().reverse().find(u => u.message?.chat?.id);
    if (last?.message) { chatId = last.message.chat.id; firstName = last.message.from?.first_name ?? 'there'; }
  } catch { res.json({ ok: false, error: 'Could not reach Telegram API' }); return; }

  // 2. fallback to stored chat_id
  if (!chatId) {
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      try {
        const payload = jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET ?? 'dev-secret') as { userId: string };
        const { data: user } = await supabase.from('users').select('telegram_chat_id, name').eq('id', payload.userId).single();
        if (user?.telegram_chat_id) { chatId = parseInt(user.telegram_chat_id, 10); firstName = user.name ?? 'there'; }
      } catch { /* ignore */ }
    }
  }
  if (!chatId) { res.json({ ok: false, noChat: true, error: 'Send your bot any message first, then click Test.' }); return; }

  // 3. send + persist chat_id + start polling
  try {
    const send = await tgApi(botToken.trim(), 'sendMessage', {
      chat_id: chatId, parse_mode: 'Markdown',
      text: `✅ *Bot connected!*\n\nHi ${firstName}! Your assistant is live.`,
    }) as { ok: boolean; description?: string };
    if (!send.ok) { res.json({ ok: false, error: send.description ?? 'Failed to send' }); return; }

    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      try {
        const payload = jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET ?? 'dev-secret') as { userId: string };
        await supabase.from('users').update({ telegram_chat_id: String(chatId) }).eq('id', payload.userId);
        if (process.env.NODE_ENV === 'production') await startUserBot(payload.userId, botToken.trim());
      } catch { /* ignore */ }
    }
    res.json({ ok: true, chatId, message: 'Test message sent!' });
  } catch { res.json({ ok: false, error: 'Could not reach Telegram API' }); }
});

export default router;
```

---

## 2) Bot lifecycle + message handling (`services/telegramService.ts`)

```ts
import TelegramBot from 'node-telegram-bot-api';
import { supabase } from '../utils/supabase';

const activeBots = new Map<string, TelegramBot>();

// One-off send without polling (used by schedulers).
export async function tgSend(botToken: string, chatId: string | number, text: string) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
    });
    return ((await res.json()) as { ok: boolean }).ok;
  } catch { return false; }
}

// Start (or restart) a long-polling bot for one user.
export async function startUserBot(userId: string, botToken: string): Promise<void> {
  if (activeBots.has(userId)) {
    try { activeBots.get(userId)!.stopPolling(); } catch { /* ignore */ }
  }
  const bot = new TelegramBot(botToken, { polling: true });
  activeBots.set(userId, bot);

  // Classify polling errors: transient network blips auto-recover; 401 = dead token
  // (stop to end spam); 409 = another process polling the same token.
  bot.on('polling_error', (err: Error & { code?: string; response?: { statusCode?: number } }) => {
    const msg = err.message ?? String(err);
    const status = err.response?.statusCode;
    const transient = err.code === 'EFATAL' || /AggregateError|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|network/i.test(msg);
    if (status === 401 || /401|unauthorized/i.test(msg)) {
      try { bot.stopPolling(); } catch { /* ignore */ } activeBots.delete(userId);
      console.error(`[BOT] Invalid token for ${userId} (401) — stopped.`);
    } else if (status === 409 || /409|conflict/i.test(msg)) {
      console.error(`[BOT] 409 conflict for ${userId} — another instance is polling this token.`);
    } else if (transient) {
      console.warn(`[BOT] Transient network error for ${userId} (auto-retry).`);
    } else { console.error(`[BOT] Polling error for ${userId}:`, msg); }
  });

  bot.on('message', async (msg: TelegramBot.Message) => {
    const chatId = msg.chat.id;
    const text = msg.text ?? '';
    if (!text) return;
    try {
      // keep chat_id fresh so scheduled sends can reach them
      await supabase.from('users').update({ telegram_chat_id: String(chatId) }).eq('id', userId);

      // conversation memory (last 20 turns)
      const { data: history } = await supabase
        .from('telegram_conversations').select('role, message')
        .eq('user_id', userId).order('created_at', { ascending: false }).limit(20);
      const conversation = (history ?? []).reverse().map(h => ({ role: h.role, content: h.message }));

      // >>> REPLACE with your app's reply logic <<<
      let reply: string;
      try { reply = await yourAppReply(text, conversation, userId); }
      catch { reply = "Sorry, I'm having trouble right now. Please try again."; }

      await supabase.from('telegram_conversations').insert([
        { user_id: userId, role: 'user', message: text },
        { user_id: userId, role: 'assistant', message: reply },
      ]);
      await bot.sendMessage(chatId, reply);
    } catch (err) {
      console.error(`[BOT] message handler error for ${userId}:`, err);
      try { await bot.sendMessage(chatId, 'Something went wrong on my end.'); } catch { /* ignore */ }
    }
  });
}

// Boot: start every connected user's bot.
export async function startAllUserBots(): Promise<void> {
  const { data: users } = await supabase
    .from('users').select('id, telegram_bot_token').not('telegram_bot_token', 'is', null);
  for (const u of users ?? []) {
    if (u.telegram_bot_token) {
      try { await startUserBot(u.id, u.telegram_bot_token); }
      catch (e) { console.error(`[BOOT] start bot failed for ${u.id}`, e); }
    }
  }
}

// Provision a default settings row for a newly connected user (respects existing).
const DEFAULT_SETTINGS = {
  enabled: true, send_time: '08:00', timezone: 'Australia/Sydney',
  days: ['mon','tue','wed','thu','fri','sat','sun'],
};
export async function ensureBriefingRowForUser(userId: string, timezone?: string): Promise<void> {
  const { data: existing } = await supabase
    .from('telegram_briefing_settings').select('user_id').eq('user_id', userId).maybeSingle();
  if (existing) return;
  let tz = DEFAULT_SETTINGS.timezone;
  if (timezone) { try { new Intl.DateTimeFormat('en-AU', { timeZone: timezone }); tz = timezone; } catch { /* invalid */ } }
  await supabase.from('telegram_briefing_settings').insert({ user_id: userId, ...DEFAULT_SETTINGS, timezone: tz });
}
```

---

## 3) Scheduled sender — timezone-aware, once-per-day (`services/telegramService.ts`)

```ts
// Called every minute by cron. Fires on the FIRST tick at/after each user's local
// send_time, within a catch-up window, once per calendar day (last_sent_date guard).
export async function sendScheduledBriefings(): Promise<void> {
  const now = new Date();
  const { data: all } = await supabase
    .from('telegram_briefing_settings').select('*').eq('enabled', true);
  if (!all?.length) return;

  for (const s of all) {
    try {
      const tz = (s.timezone as string) ?? 'Australia/Sydney';

      // current local HH:MM (handles the '24'→'00' midnight quirk)
      const tp = new Intl.DateTimeFormat('en-AU', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(now);
      const hh = (tp.find(p => p.type === 'hour')?.value ?? '00'); 
      const currentTime = `${hh === '24' ? '00' : hh}:${tp.find(p => p.type === 'minute')?.value ?? '00'}`;

      // current local weekday prefix
      const wd = new Intl.DateTimeFormat('en-AU', { timeZone: tz, weekday: 'long' }).format(now).toLowerCase();
      const DAY: Record<string,string> = { monday:'mon',tuesday:'tue',wednesday:'wed',thursday:'thu',friday:'fri',saturday:'sat',sunday:'sun' };
      const currentDay = DAY[wd] ?? wd.slice(0,3);

      // local calendar date (once-per-day guard)
      const dp = new Intl.DateTimeFormat('en-AU', { timeZone: tz, year:'numeric', month:'2-digit', day:'2-digit' }).formatToParts(now);
      const todayDate = `${dp.find(p=>p.type==='year')?.value}-${dp.find(p=>p.type==='month')?.value}-${dp.find(p=>p.type==='day')?.value}`;

      if (!(s.days as string[]).includes(currentDay)) continue;
      if (s.last_sent_date === todayDate) continue;
      // fire on first tick at/after send_time (HH:MM strings sort lexicographically)
      if (currentTime < (s.send_time as string)) continue;

      // >>> build + send your message here <<<
      const { data: u } = await supabase.from('users').select('telegram_bot_token, telegram_chat_id').eq('id', s.user_id).single();
      if (u?.telegram_bot_token && u?.telegram_chat_id) {
        await tgSend(u.telegram_bot_token, u.telegram_chat_id, await yourAppBriefing(s.user_id));
      }
      await supabase.from('telegram_briefing_settings').update({ last_sent_date: todayDate }).eq('user_id', s.user_id);
    } catch (err) { console.error('[BRIEFING] per-user failure:', err); }
  }
}
```

---

## 4) Settings REST routes (`routes/settings.ts`, behind your normal auth middleware)

```ts
// Save a user's bot token (alternative to /telegram/verify).
router.put('/telegram', async (req, res) => {
  await supabase.from('users').update({ telegram_bot_token: req.body.telegram_bot_token }).eq('id', req.user.userId);
  res.json({ success: true });
});

// Read briefing settings (returns defaults if no row yet).
router.get('/briefing', async (req, res) => {
  const { data, error } = await supabase.from('telegram_briefing_settings').select('*').eq('user_id', req.user.userId).single();
  if (error && error.code !== 'PGRST116') console.error(error);  // PGRST116 = no row, expected
  res.json(data ?? DEFAULT_BRIEFING);
});

// Update briefing settings (whitelist fields; reset last_sent_date if send_time moved later today).
router.put('/briefing', async (req, res) => {
  const userId = req.user.userId;
  const { data: existing } = await supabase.from('telegram_briefing_settings')
    .select('send_time, last_sent_date, timezone').eq('user_id', userId).single();

  const allowed = ['enabled','send_time','timezone','days', /* ...your content toggles... */];
  const settings: Record<string, unknown> = { user_id: userId, updated_at: new Date().toISOString() };
  for (const k of allowed) if (req.body[k] !== undefined) settings[k] = req.body[k];

  const newTime = req.body.send_time as string | undefined;
  if (newTime && existing?.send_time && newTime !== existing.send_time && existing.last_sent_date) {
    const tz = req.body.timezone ?? existing.timezone ?? 'Australia/Sydney';
    const tp = new Intl.DateTimeFormat('en-AU', { timeZone: tz, hour:'2-digit', minute:'2-digit', hour12:false }).formatToParts(new Date());
    const hh = tp.find(p=>p.type==='hour')?.value ?? '00';
    const cur = `${hh==='24'?'00':hh}:${tp.find(p=>p.type==='minute')?.value ?? '00'}`;
    if (newTime > cur) settings.last_sent_date = null;   // allow it to fire again today
  }

  const { data, error } = await supabase.from('telegram_briefing_settings')
    .upsert(settings, { onConflict: 'user_id' }).select().single();
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json(data);
});
```

---

## 5) Wiring (`index.ts`)

```ts
import cron from 'node-cron';
import telegramRouter from './routes/telegram';
import { startAllUserBots, sendScheduledBriefings } from './services/telegramService';

app.use('/api/telegram', telegramRouter);          // verify/test (no app auth)
// settings routes mounted under your authenticated router, e.g. app.use('/api/settings', authedRouter)

// every-minute scheduler
cron.schedule('* * * * *', async () => {
  try { await sendScheduledBriefings(); } catch (e) { console.error(e); }
});

app.listen(PORT, () => {
  if (process.env.NODE_ENV === 'production') {
    startAllUserBots().catch(e => console.error('[BOOT] startAllUserBots failed:', e));
  } else {
    console.log('[BOOT] Skipping bot polling — set NODE_ENV=production to enable.');
  }
});
```

### Optional: external uptime ping (free-tier hosts that sleep)
Expose `GET/POST /api/telegram/run-briefings?key=<CRON_SECRET>` that calls
`sendScheduledBriefings()`. Point cron-job.org at it every minute — it both wakes the
instance and runs the check, so scheduled sends fire even if the in-process cron slept.
Fail closed: if `CRON_SECRET` is unset, return 503 so it can't be called anonymously.

## Frontend connect flow (UX)
1. User pastes their bot token (from @BotFather) → `POST /api/telegram/verify` (with JWT).
   Show the returned bot `username`.
2. Tell them to open `t.me/<username>` and send any message.
3. User clicks **Test Connection** → `POST /api/telegram/test`. On success the chat_id is
   stored and the bot is polling — they're connected.
4. Briefing settings screen reads `GET /api/settings/briefing`, saves via `PUT`.

## Gotchas
- **One poller per token.** Never run polling in two places (local + prod) → 409. Gate on `NODE_ENV`.
- **HH:MM string comparison** works for time-of-day because zero-padded times sort lexicographically.
- **Always use `Intl.DateTimeFormat` with `timeZone`** for local time — avoid `new Date(x.toLocaleString())`.
- **Markdown parse_mode**: escape user-supplied text or you'll hit "can't parse entities" 400s.
- Store `telegram_chat_id` on every inbound message so scheduled sends always have a target.
