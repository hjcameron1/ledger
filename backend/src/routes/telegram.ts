/**
 * Telegram Bot API proxy routes — no auth required.
 * These only proxy requests to api.telegram.org and touch nothing sensitive.
 */
import { Router, Request, Response } from 'express';
import { startUserBot } from '../services/telegramService';
import { supabase } from '../utils/supabase';
import jwt from 'jsonwebtoken';
import type { JWTPayload } from '../types';

const router = Router();

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
  const { token: botToken } = req.body as { token?: string };
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
        // Start the bot so it's live immediately
        try {
          await startUserBot(userId, botToken.trim());
        } catch (botErr) {
          console.error(`[BOT VERIFY] startUserBot failed:`, botErr);
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
// Looks for the most recent message in the bot's update queue and sends a
// test reply. Safe to call whether or not polling is active.
router.post('/test', async (req: Request, res: Response) => {
  const { token: botToken } = req.body as { token?: string };
  if (!botToken?.trim()) {
    res.status(400).json({ ok: false, error: 'Bot token is required' });
    return;
  }

  // 1. Try to find a recent chat_id from update history
  let chatId: number | null = null;
  let firstName = 'there';

  try {
    const updates = await tgApi(botToken.trim(), 'getUpdates', { limit: 10, timeout: 0 }) as {
      ok: boolean;
      result?: Array<{ message?: { chat: { id: number }; from?: { first_name?: string } } }>;
      description?: string;
    };

    if (!updates.ok) {
      res.json({ ok: false, error: (updates.description as string) ?? 'Could not connect to Telegram' });
      return;
    }

    const lastWithChat = updates.result?.slice().reverse().find(u => u.message?.chat?.id);
    if (lastWithChat?.message) {
      chatId = lastWithChat.message.chat.id;
      firstName = lastWithChat.message.from?.first_name ?? 'there';
    }
  } catch {
    res.json({ ok: false, error: 'Could not reach Telegram API' });
    return;
  }

  // 2. Check DB for a stored telegram_chat_id as fallback
  if (!chatId) {
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      const jwtToken = authHeader.split(' ')[1];
      try {
        const payload = jwt.verify(jwtToken, process.env.JWT_SECRET ?? 'dev-secret') as JWTPayload;
        const { data: user } = await supabase
          .from('users')
          .select('telegram_chat_id, name')
          .eq('id', payload.userId)
          .single();
        if (user?.telegram_chat_id) {
          chatId = parseInt(user.telegram_chat_id, 10);
          firstName = user.name ?? 'there';
        }
      } catch { /* invalid JWT, no fallback */ }
    }
  }

  if (!chatId) {
    res.json({
      ok: false,
      noChat: true,
      error: 'Send your bot any message on Telegram first, then click Test Connection.',
    });
    return;
  }

  // 3. Send the test message
  try {
    const send = await tgApi(botToken.trim(), 'sendMessage', {
      chat_id:    chatId,
      text:       `✅ *Ledger bot is connected!*\n\nHi ${firstName}! Your financial assistant is live and ready to go.\n\nTry asking me:\n• "What's my net worth?"\n• "Any bills due soon?"\n• "How are my investments doing?"`,
      parse_mode: 'Markdown',
    }) as { ok: boolean; description?: string };

    if (send.ok) {
      // Store the chat_id so future messages (briefings) can reach the user
      const authHeader = req.headers.authorization;
      if (authHeader?.startsWith('Bearer ')) {
        const jwtToken = authHeader.split(' ')[1];
        try {
          const payload = jwt.verify(jwtToken, process.env.JWT_SECRET ?? 'dev-secret') as JWTPayload;
          const { error: chatIdErr } = await supabase
            .from('users')
            .update({ telegram_chat_id: String(chatId) })
            .eq('id', payload.userId);
          if (chatIdErr) {
            console.error(`[BOT TEST] Failed to save chat_id:`, chatIdErr);
          } else {
            console.log(`[BOT TEST] Saved chat_id=${chatId} for userId=${payload.userId}`);
          }
        } catch { /* silent JWT error */ }
      }
      res.json({ ok: true, chatId, message: 'Test message sent! Check your Telegram.' });
    } else {
      res.json({ ok: false, error: (send.description as string) ?? 'Failed to send message' });
    }
  } catch (err) {
    res.json({ ok: false, error: 'Could not reach Telegram API' });
  }
});

export default router;
