/**
 * Telegram Bot API proxy routes — no auth required.
 * These only proxy requests to api.telegram.org and touch nothing sensitive.
 */
import { Router, Request, Response } from 'express';
import {
  startUserBot,
  sendScheduledBriefings,
  ensureBriefingRowForUser,
  registerWebhook,
  webhookSecret,
  handleTelegramMessage,
} from '../services/telegramService';
import { supabase } from '../utils/supabase';
import jwt from 'jsonwebtoken';
import type { JWTPayload } from '../types';

const router = Router();

// ── POST /api/telegram/webhook/:userId ────────────────────────────────────────
// Telegram pushes updates here (production delivery path — replaces long-polling
// and its 409 "terminated by other getUpdates" conflicts). Validated by the
// per-user secret Telegram echoes in X-Telegram-Bot-Api-Secret-Token. We ack with
// 200 immediately and process the message out-of-band so Telegram never retries
// on a slow Claude call. Public by design (Telegram carries no JWT); the secret is
// the auth.
router.post('/webhook/:userId', async (req: Request, res: Response) => {
  const { userId } = req.params;
  const provided = req.header('x-telegram-bot-api-secret-token');
  if (!provided || provided !== webhookSecret(userId)) {
    res.status(401).json({ ok: false });
    return;
  }
  // Acknowledge first; do the (slow) Claude round-trip after responding.
  res.json({ ok: true });

  const message = (req.body as { message?: { chat?: { id: number }; text?: string } })?.message;
  if (!message) return;

  const { data: user } = await supabase
    .from('users')
    .select('telegram_bot_token')
    .eq('id', userId)
    .single();
  if (!user?.telegram_bot_token) return;

  handleTelegramMessage(userId, user.telegram_bot_token, message).catch(err =>
    console.error(`[BOT] webhook handler failed for user ${userId}:`, err),
  );
});

// ── GET/POST /api/telegram/run-briefings ──────────────────────────────────────
// External-trigger endpoint for an uptime pinger (e.g. cron-job.org). Hitting this
// every minute both WAKES the Render free-tier instance and runs the briefing
// check in the same request, so briefings fire on time even if the in-process cron
// was asleep. Protected by a shared secret (CRON_SECRET) passed as ?key= or the
// 'x-cron-key' header. Fails closed: if CRON_SECRET is unset, the endpoint is
// disabled so it can never be called anonymously.
async function handleRunBriefings(req: Request, res: Response): Promise<void> {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    res.status(503).json({ ok: false, error: 'CRON_SECRET not configured on the server.' });
    return;
  }
  const provided = (req.query.key as string | undefined) ?? req.header('x-cron-key');
  if (provided !== secret) {
    res.status(401).json({ ok: false, error: 'Unauthorized.' });
    return;
  }
  try {
    await sendScheduledBriefings();
    res.json({ ok: true });
  } catch (err) {
    console.error('[CRON HTTP] run-briefings failed:', err);
    res.status(500).json({ ok: false, error: 'Briefing run failed.' });
  }
}
router.get('/run-briefings', handleRunBriefings);
router.post('/run-briefings', handleRunBriefings);

// ─── Helper: call Telegram Bot API ──────────────────────────────────────────

async function tgApi(
  botToken: string,
  method: string,
  body?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const url = `https://api.telegram.org/bot${botToken}/${method}`;
  const res = await fetch(url, body
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : { method: 'GET' },
  );
  return res.json() as Promise<Record<string, unknown>>;
}

// ── POST /api/telegram/verify ─────────────────────────────────────────────────
// Validates a bot token by calling Telegram's getMe and saves it to DB if
// the request carries a valid JWT (real users). Falls back gracefully for demo mode.
router.post('/verify', async (req: Request, res: Response) => {
  const { token: botToken, timezone: browserTz } = req.body as { token?: string; timezone?: string };
  if (!botToken?.trim()) {
    res.status(400).json({ ok: false, error: 'Bot token is required' });
    return;
  }

  // Verify with Telegram
  let tgResult: Record<string, unknown>;
  try {
    tgResult = await tgApi(botToken.trim(), 'getMe');
  } catch (err) {
    res.json({ ok: false, error: 'Could not reach Telegram API — check your internet connection' });
    return;
  }

  if (!tgResult.ok) {
    res.json({ ok: false, error: (tgResult.description as string) ?? 'Invalid bot token' });
    return;
  }

  const botInfo = tgResult.result as { id: number; username?: string; first_name?: string };

  // Try to persist to DB — only possible for real JWT users, silent failure otherwise
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const jwtToken = authHeader.split(' ')[1];
    try {
      const payload = jwt.verify(jwtToken, process.env.JWT_SECRET ?? 'dev-secret') as JWTPayload;
      const userId = payload.userId;
      console.log(`[BOT VERIFY] Saving token for userId=${userId}`);

      const { error: saveError } = await supabase
        .from('users')
        .update({ telegram_bot_token: botToken.trim() })
        .eq('id', userId);

      if (saveError) {
        console.error(`[BOT VERIFY] Failed to save token to DB:`, saveError);
      } else {
        console.log(`[BOT VERIFY] Token saved to DB for userId=${userId}`);
      }
      // Provision a briefing-settings row using the user's real browser timezone
      // (if they don't already have one), so a new user's briefings fire at the
      // right local time and greeting instead of defaulting to Australia/Sydney.
      await ensureBriefingRowForUser(userId, browserTz);
      // Production uses webhooks (single push-based delivery — no getUpdates 409s).
      // Local dev has no public URL, so fall back to long-polling there.
      if (process.env.NODE_ENV === 'production') {
        try {
          await registerWebhook(userId, botToken.trim());
        } catch (botErr) {
          console.error(`[BOT VERIFY] registerWebhook failed:`, botErr);
        }
      } else {
        try {
          await startUserBot(userId, botToken.trim());
        } catch (botErr) {
          console.error(`[BOT VERIFY] startUserBot (local polling) failed:`, botErr);
        }
      }
    } catch (jwtErr) {
      console.warn(`[BOT VERIFY] JWT invalid — skipping DB save:`, jwtErr instanceof Error ? jwtErr.message : jwtErr);
    }
  }

  res.json({
    ok: true,
    id:         botInfo.id,
    username:   botInfo.username,
    firstName:  botInfo.first_name,
  });
});

// ── POST /api/telegram/test ───────────────────────────────────────────────────
// Sends a "connected" test reply. Uses the stored chat_id (captured whenever the
// user messages the bot). Does NOT call getUpdates: once a webhook is active,
// getUpdates returns "409 Conflict: terminated by other getUpdates request", and
// we must never surface that raw string to the user again.
router.post('/test', async (req: Request, res: Response) => {
  const { token: botToken } = req.body as { token?: string };
  if (!botToken?.trim()) {
    res.status(400).json({ ok: false, error: 'Bot token is required' });
    return;
  }

  // Resolve the caller and their stored chat_id from the JWT.
  let userId: string | null = null;
  let chatId: number | null = null;
  let firstName = 'there';

  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    try {
      const payload = jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET ?? 'dev-secret') as JWTPayload;
      userId = payload.userId;
      const { data: user } = await supabase
        .from('users')
        .select('telegram_chat_id, name')
        .eq('id', payload.userId)
        .single();
      if (user?.telegram_chat_id) {
        chatId = parseInt(user.telegram_chat_id, 10);
        firstName = user.name ?? 'there';
      }
    } catch { /* invalid JWT — treated as no stored chat */ }
  }

  // Fallback for a bot the user just messaged but hasn't had a chat_id captured
  // yet (only reachable when no webhook is set, e.g. local dev). Swallow a 409 /
  // webhook-active error instead of showing it.
  if (!chatId) {
    try {
      const updates = await tgApi(botToken.trim(), 'getUpdates', { limit: 10, timeout: 0 }) as {
        ok: boolean;
        result?: Array<{ message?: { chat: { id: number }; from?: { first_name?: string } } }>;
      };
      const lastWithChat = updates.ok ? updates.result?.slice().reverse().find(u => u.message?.chat?.id) : undefined;
      if (lastWithChat?.message) {
        chatId = lastWithChat.message.chat.id;
        firstName = lastWithChat.message.from?.first_name ?? firstName;
      }
    } catch { /* ignore — fall through to the "message me first" prompt */ }
  }

  if (!chatId) {
    res.json({
      ok: false,
      noChat: true,
      error: 'Send your bot any message on Telegram first, then click Test Connection.',
    });
    return;
  }

  // Send the test message.
  try {
    const send = await tgApi(botToken.trim(), 'sendMessage', {
      chat_id:    chatId,
      text:       `✅ *Ledger bot is connected!*\n\nHi ${firstName}! Your financial assistant is live and ready to go.\n\nTry asking me:\n• "What's my net worth?"\n• "Any bills due soon?"\n• "How are my investments doing?"`,
      parse_mode: 'Markdown',
    }) as { ok: boolean; description?: string };

    if (!send.ok) {
      res.json({ ok: false, error: (send.description as string) ?? 'Failed to send message' });
      return;
    }

    // Persist the chat_id and (re)establish delivery.
    if (userId) {
      await supabase.from('users').update({ telegram_chat_id: String(chatId) }).eq('id', userId);
      if (process.env.NODE_ENV === 'production') {
        registerWebhook(userId, botToken.trim()).catch(botErr =>
          console.error(`[BOT TEST] registerWebhook failed:`, botErr));
      } else {
        startUserBot(userId, botToken.trim()).catch(botErr =>
          console.error(`[BOT TEST] startUserBot (local polling) failed:`, botErr));
      }
    }
    res.json({ ok: true, chatId, message: 'Test message sent! Check your Telegram.' });
  } catch (err) {
    res.json({ ok: false, error: 'Could not reach Telegram API' });
  }
});

export default router;
