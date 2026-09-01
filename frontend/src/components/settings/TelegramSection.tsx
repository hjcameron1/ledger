/**
 * Telegram — the bot, and the briefing it sends.
 *
 * Its own screen rather than a section inside Settings. Connecting a bot,
 * proving it can reach you, and deciding what it says every morning is one
 * whole job with its own failure modes, and it is what people come back to when
 * a briefing doesn't arrive — so it gets a place of its own on the More grid
 * instead of being three clicks inside preferences.
 *
 * Lifted out of Settings unchanged apart from owning its own data loading: the
 * token and the briefing settings are fetched by the screen that shows them,
 * rather than on every visit to Settings.
 */
import { useEffect, useRef, useState } from 'react';
import { useStore } from '../../store';
import { investmentsApi, API_BASE } from '../../services/api';
import Card from '../common/Card';
import Button from '../common/Button';
import Input, { Select, Toggle } from '../common/Input';
import { TIMEZONES } from '../../utils/timezones';

// ── Briefing settings types ───────────────────────────────────────────────────
interface BriefingSettings {
  enabled: boolean;
  send_time: string;
  timezone: string;
  days: string[];
  show_net_worth: boolean;
  show_bank_balances: boolean;
  show_credit_cards: boolean;
  show_investments: boolean;
  top_movers: string;
  show_super: boolean;
  show_bills: boolean;
  bills_count: number;
  include_auto_pay: boolean;
  show_goals: boolean;
  show_reminders: boolean;
  reminders_max: number;
  excluded_bank_ids: string[];
  excluded_card_ids: string[];
  excluded_goal_ids: string[];
  watched_investment_ids: string[];
  show_watchlist: boolean;
  excluded_watchlist_ids: string[];
  /** What became of the last scheduled send, written by the scheduler. */
  last_send_status?: string | null;
  last_attempt_at?: string | null;
  last_sent_date?: string | null;
}

/**
 * The last thing the scheduler did with this briefing, in a sentence.
 *
 * Three outcomes are worth calling out and each one needs a different fix, so
 * they are not collapsed into one message: Telegram refused it (something in
 * the content), nothing was running when it was due (the server was asleep), or
 * it went out. Absent until database/2026-briefing-delivery-status.sql is run.
 */
function DeliveryStatus({ briefing }: { briefing: BriefingSettings }) {
  const status = briefing.last_send_status;
  if (!status) return null;

  const failed = status.startsWith('failed');
  const missed = status.startsWith('missed');
  const when = briefing.last_attempt_at
    ? new Date(briefing.last_attempt_at).toLocaleString('en-AU', {
        day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
      })
    : null;

  const tone = failed
    ? 'text-red-600 dark:text-red-400'
    : missed
      ? 'text-amber-600 dark:text-amber-400'
      : 'text-zinc-500 dark:text-zinc-400';

  const explanation = failed
    ? 'Telegram refused the message. It will be retried at the next scheduled send.'
    : missed
      ? 'Nothing was running when it was due, so that day was skipped.'
      : null;

  return (
    <div className="mb-5 text-xs">
      <p className={tone}>
        Last scheduled send: {status}{when ? ` (checked ${when})` : ''}
      </p>
      {explanation && <p className="text-zinc-500 dark:text-zinc-400 mt-0.5">{explanation}</p>}
    </div>
  );
}

const DEFAULT_BRIEFING: BriefingSettings = {
  enabled: true,
  send_time: '08:00',
  timezone: 'Australia/Sydney',
  days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'],
  show_net_worth: true,
  show_bank_balances: true,
  show_credit_cards: true,
  show_investments: true,
  top_movers: 'top3',
  show_super: true,
  show_bills: true,
  bills_count: 5,
  include_auto_pay: true,
  show_goals: true,
  show_reminders: false,
  reminders_max: 5,
  excluded_bank_ids: [],
  excluded_card_ids: [],
  excluded_goal_ids: [],
  watched_investment_ids: [],
  show_watchlist: true,
  excluded_watchlist_ids: [],
};

const ALL_DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const WEEKDAYS  = ['mon', 'tue', 'wed', 'thu', 'fri'];
const DAY_LABELS: Record<string, string> = {
  mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu',
  fri: 'Fri', sat: 'Sat', sun: 'Sun',
};

function inferDaysMode(days: string[]): 'every_day' | 'weekdays' | 'custom' {
  if (ALL_DAYS.every(d => days.includes(d))) return 'every_day';
  if (WEEKDAYS.every(d => days.includes(d)) && !['sat', 'sun'].some(d => days.includes(d))) return 'weekdays';
  return 'custom';
}

/**
 * The watchdog's last verdict on this bot.
 *
 * A one-off "Test Connection" proves the bot worked at the moment you pressed
 * it, which is exactly the guarantee that expires. The server checks every
 * fifteen minutes and this reports what it found, with the time it found it —
 * including the things a test message can't tell you, like Telegram failing to
 * deliver to our webhook, or updates piling up undelivered.
 */
function ConnectionHealth({ health }: {
  health: {
    checked: boolean; ok?: boolean; bot_username?: string | null;
    detail?: string | null; checked_at?: string;
  } | null;
}) {
  if (!health) return null;
  if (!health.checked) {
    return (
      <p className="mb-3 text-xs text-zinc-500 dark:text-zinc-400">
        The server hasn't checked this connection yet — it checks every 15 minutes, and
        the result will appear here.
      </p>
    );
  }

  const minutes = health.checked_at
    ? Math.max(0, Math.round((Date.now() - new Date(health.checked_at).getTime()) / 60000))
    : null;
  const ago = minutes === null ? '' : minutes < 1 ? 'just now'
    : minutes < 60 ? `${minutes} min ago`
    : `${Math.floor(minutes / 60)}h ago`;

  return (
    <div className={`mb-3 px-3 py-2 rounded-[8px] text-sm
      ${health.ok ? 'bg-[#22c55e]/10 text-[#22c55e]' : 'bg-[#f59e0b]/10 text-[#f59e0b]'}`}>
      <span className="font-medium">
        {health.ok ? 'Connection checked' : 'Connection needs attention'}
        {health.bot_username ? ` — ${health.bot_username}` : ''}
      </span>
      {health.detail && <span className="block mt-0.5 text-xs opacity-90">{health.detail}</span>}
      {ago && <span className="block mt-0.5 text-xs opacity-70">Checked {ago}, and every 15 minutes.</span>}
    </div>
  );
}

export default function TelegramSection() {
  const { user, setAuth, token, accounts, creditCards, investments, goals } = useStore();

  // ── Connection health, as the server last found it ────────────────────────
  // Not a badge: a verdict with an age on it. The server re-asks Telegram every
  // fifteen minutes (getMe + getWebhookInfo) and repairs a webhook that has
  // wandered, so this line answers "is it connected NOW" rather than "was it
  // connected the day I set it up".
  const [health, setHealth] = useState<{
    checked: boolean; ok?: boolean; bot_username?: string | null; has_chat?: boolean;
    webhook_ok?: boolean; detail?: string | null; checked_at?: string;
  } | null>(null);

  // ── Telegram state ────────────────────────────────────────────────────────
  const [tgToken,     setTgToken]     = useState(user?.telegram_bot_token ?? '');
  const [tgStatus,    setTgStatus]    = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [tgBotName,   setTgBotName]   = useState(user?.telegram_bot_token ? '…' : '');
  const [tgError,     setTgError]     = useState('');
  const [testStatus,  setTestStatus]  = useState<'idle' | 'loading' | 'sent' | 'noChat' | 'error'>('idle');
  const [testMsg,     setTestMsg]     = useState('');

  const [briefing,            setBriefing]            = useState<BriefingSettings>(DEFAULT_BRIEFING);
  // Watchlist stocks — fetched here so the briefing panel can offer per-stock toggles.
  const [watchlist, setWatchlist] = useState<{ id: string; ticker: string; name: string }[]>([]);
  useEffect(() => {
    investmentsApi.getWatchlist()
      .then(d => setWatchlist((d.watchlist ?? []).map((w: { id: string; ticker: string; name: string }) => ({ id: String(w.id), ticker: w.ticker, name: w.name }))))
      .catch(() => {});
  }, []);
  const [daysMode,            setDaysMode]            = useState<'every_day' | 'weekdays' | 'custom'>('every_day');
  const [briefingSaveStatus,  setBriefingSaveStatus]  = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  // If token was previously saved, kick off a silent getMe to restore the bot name
  useEffect(() => {
    if (user?.telegram_bot_token && !tgBotName.replace('…', '')) return;
    if (user?.telegram_bot_token) {
      fetch(`${API_BASE}/api/telegram/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: user.telegram_bot_token }),
      }).then(r => r.json()).then((d: { ok: boolean; username?: string }) => {
        if (d.ok && d.username) setTgBotName('@' + d.username);
      }).catch(() => {});
    }
  }, []); // eslint-disable-line

  // The token and the briefing settings, loaded by the screen that shows them.
  // `token` is watched because Zustand rehydrates it a tick after mount, and a
  // ref stops the pair being fetched twice when it changes for another reason.
  const dataLoaded = useRef(false);
  useEffect(() => {
    if (!token || dataLoaded.current) return;
    dataLoaded.current = true;
    const headers = { Authorization: `Bearer ${token}` };

    fetch(`${API_BASE}/api/settings/profile`, { headers })
      .then(r => (r.ok ? r.json() : null))
      .then((profile: { telegram_bot_token?: string } | null) => {
        if (profile?.telegram_bot_token) setTgToken(profile.telegram_bot_token);
      })
      .catch(() => {});

    fetch(`${API_BASE}/api/settings/briefing`, { headers })
      .then(r => (r.ok ? r.json() : null))
      .then((data: Partial<BriefingSettings> | null) => {
        if (data) {
          // Merge over defaults so new array fields are present even if the
          // server row predates them (migration not yet run / legacy row).
          setBriefing({ ...DEFAULT_BRIEFING, ...data });
          setDaysMode(inferDaysMode(data.days ?? DEFAULT_BRIEFING.days));
        }
      })
      .catch(() => {});

    fetch(`${API_BASE}/api/telegram/health`, { headers })
      .then(r => (r.ok ? r.json() : null))
      .then(setHealth)
      .catch(() => {});
  }, [token]);

  // ── Telegram handlers ────────────────────────────────────────────────────
  const saveTelegramToken = async () => {
    if (!tgToken.trim()) return;
    setTgStatus('saving');
    setTgError('');
    setTgBotName('');
    try {
      // 1. Verify token with Telegram
      const res = await fetch(`${API_BASE}/api/telegram/verify`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          token: tgToken.trim(),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }),
      });
      const data = await res.json() as { ok: boolean; username?: string; firstName?: string; error?: string };

      if (!data.ok) {
        setTgStatus('error');
        setTgError(data.error ?? 'Invalid bot token. Double-check it from @BotFather.');
        return;
      }

      // 2. Persist locally in Zustand store (so it survives a page refresh)
      if (user) {
        setAuth({ ...user, telegram_bot_token: tgToken.trim() }, token ?? '');
      }

      setTgBotName('@' + data.username);
      setTgStatus('saved');
    } catch (err) {
      setTgStatus('error');
      setTgError('Could not connect to Telegram. Check your internet connection.');
    }
  };

  // ── Briefing helpers ─────────────────────────────────────────────────────
  const updateBriefing = <K extends keyof BriefingSettings>(key: K, value: BriefingSettings[K]) => {
    setBriefing(b => ({ ...b, [key]: value }));
  };

  const handleDaysModeChange = (mode: 'every_day' | 'weekdays' | 'custom') => {
    setDaysMode(mode);
    if (mode === 'every_day') {
      setBriefing(b => ({ ...b, days: [...ALL_DAYS] }));
    } else if (mode === 'weekdays') {
      setBriefing(b => ({ ...b, days: [...WEEKDAYS] }));
    }
    // 'custom' keeps existing days so user can adjust checkboxes
  };

  const toggleDay = (day: string) => {
    setBriefing(b => {
      const next = b.days.includes(day) ? b.days.filter(d => d !== day) : [...b.days, day];
      return { ...b, days: next };
    });
  };

  // Which expandable per-item sections are open (UI-only, not persisted).
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const toggleExpanded = (key: string) => setExpanded(e => ({ ...e, [key]: !e[key] }));

  // Add/remove an id in one of the array fields. For exclusion lists, "included"
  // means the id is ABSENT; for the watch list, "on" means the id is PRESENT.
  type ArrayKey = 'excluded_bank_ids' | 'excluded_card_ids' | 'excluded_goal_ids' | 'watched_investment_ids' | 'excluded_watchlist_ids';
  const toggleInArray = (key: ArrayKey, id: string) => {
    setBriefing(b => {
      const list = b[key] ?? [];
      const next = list.includes(id) ? list.filter(x => x !== id) : [...list, id];
      return { ...b, [key]: next };
    });
  };

  // A small chevron button that expands a per-item list under a section heading.
  const expander = (key: string) => (
    <button
      type="button"
      onClick={() => toggleExpanded(key)}
      className="text-zinc-500 dark:text-zinc-400 hover:text-brand transition-transform text-xs"
      style={{ transform: expanded[key] ? 'rotate(90deg)' : 'none' }}
      aria-label="Expand"
    >
      ▶
    </button>
  );

  // Render the indented per-item toggle list when a section is expanded.
  // `isOn(id)` decides each item's toggle state; `onToggle(id)` flips it.
  const itemDropdown = (
    key: string,
    items: { id: string; label: string }[],
    isOn: (id: string) => boolean,
    onToggle: (id: string) => void,
    emptyText: string,
  ) => expanded[key] && (
    <div className="ml-6 mt-1.5 space-y-1.5 border-l border-zinc-200 dark:border-zinc-800 pl-3">
      {items.length === 0
        ? <p className="text-xs text-zinc-500 dark:text-zinc-400 py-1">{emptyText}</p>
        : items.map(it => (
            <div key={it.id} className="flex items-center justify-between">
              <span className="text-sm text-zinc-500 dark:text-zinc-400">{it.label}</span>
              <Toggle checked={isOn(it.id)} onChange={() => onToggle(it.id)} size="sm" />
            </div>
          ))}
    </div>
  );

  const saveBriefingSettings = async () => {
    if (!token) return;
    setBriefingSaveStatus('saving');
    try {
      const base = import.meta.env.VITE_API_URL ?? '';
      const res = await fetch(`${base}/api/settings/briefing`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(briefing),
      });
      if (!res.ok) throw new Error('Save failed');
      setBriefingSaveStatus('saved');
      setTimeout(() => setBriefingSaveStatus('idle'), 2500);
    } catch {
      setBriefingSaveStatus('error');
      setTimeout(() => setBriefingSaveStatus('idle'), 3000);
    }
  };

  const testTelegramConnection = async () => {
    if (!tgToken.trim()) return;
    setTestStatus('loading');
    setTestMsg('');
    try {
      const res = await fetch(`${API_BASE}/api/telegram/test`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ token: tgToken.trim() }),
      });
      const data = await res.json() as {
        ok: boolean;
        noChat?: boolean;
        message?: string;
        error?: string;
      };

      if (data.ok) {
        setTestStatus('sent');
        setTestMsg(data.message ?? 'Test message sent! Check your Telegram.');
      } else if (data.noChat) {
        setTestStatus('noChat');
        setTestMsg(data.error ?? 'Send your bot a message on Telegram first.');
      } else {
        setTestStatus('error');
        setTestMsg(data.error ?? 'Test failed.');
      }
    } catch {
      setTestStatus('error');
      setTestMsg('Could not reach server.');
    }
  };

  return (
    <>
    <Card>
      <h2 className="font-semibold mb-1">Telegram Bot</h2>
      <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-4">
        Create a bot via{' '}
        <a href="https://t.me/botfather" target="_blank" rel="noreferrer" className="text-brand hover:underline">
          @BotFather
        </a>{' '}
        on Telegram, then paste the API token below. Your bot will send you daily briefings and answer questions about your finances.
      </p>

      {/* Connected badge */}
      {tgStatus === 'saved' && tgBotName && (
        <div className="flex items-center gap-2 mb-4 px-3 py-2.5 rounded-[8px] bg-[#22c55e]/10 text-[#22c55e] text-sm font-medium">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>
          Connected! Your bot {tgBotName} is ready.
        </div>
      )}
      {/* Previously connected (from store) */}
      {tgStatus === 'idle' && tgBotName && tgBotName !== '…' && (
        <div className="flex items-center gap-2 mb-4 px-3 py-2.5 rounded-[8px] bg-[#22c55e]/10 text-[#22c55e] text-sm font-medium">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>
          Connected — {tgBotName}
        </div>
      )}

      <div className="space-y-3 max-w-sm">
        <Input
          label="Bot API Token"
          value={tgToken}
          onChange={e => { setTgToken(e.target.value); setTgStatus('idle'); setTgError(''); }}
          placeholder="1234567890:ABCdefGHIjklMNOpqrsTUVwxyz"
          type="password"
          hint={tgStatus === 'idle' && user?.telegram_bot_token ? 'Token saved — update to change it' : ''}
        />

        {/* Error banner */}
        {tgStatus === 'error' && tgError && (
          <div className="px-3 py-2.5 rounded-[8px] bg-[#ef4444]/10 text-[#ef4444] text-sm">
            {tgError}
          </div>
        )}

        <Button
          variant="primary"
          onClick={saveTelegramToken}
          loading={tgStatus === 'saving'}
          disabled={!tgToken.trim() || tgStatus === 'saving'}
        >
          {tgStatus === 'saved' ? '✓ Token Verified & Saved' : tgStatus === 'saving' ? 'Verifying…' : 'Save & Verify Token'}
        </Button>
      </div>

      {/* Test Connection — shown once token is saved/verified */}
      {(tgStatus === 'saved' || (tgStatus === 'idle' && user?.telegram_bot_token)) && (
        <div className="mt-5 pt-5 border-t border-zinc-200 dark:border-zinc-800">
          <ConnectionHealth health={health} />

          <h3 className="font-medium mb-1 text-sm">Test Connection</h3>
          <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-3">
            Send your bot any message on Telegram to activate it, then click below to receive a test message.
          </p>

          {/* Test result banners */}
          {testStatus === 'sent' && (
            <div className="mb-3 px-3 py-2 rounded-[8px] bg-[#22c55e]/10 text-[#22c55e] text-sm">
              ✅ {testMsg}
            </div>
          )}
          {testStatus === 'noChat' && (
            <div className="mb-3 px-3 py-2 rounded-[8px] bg-[#f59e0b]/10 text-[#f59e0b] text-sm">
              💬 {testMsg}
            </div>
          )}
          {testStatus === 'error' && (
            <div className="mb-3 px-3 py-2 rounded-[8px] bg-[#ef4444]/10 text-[#ef4444] text-sm">
              {testMsg}
            </div>
          )}

          <Button
            variant="secondary"
            size="sm"
            onClick={testTelegramConnection}
            loading={testStatus === 'loading'}
            disabled={testStatus === 'loading'}
          >
            {testStatus === 'loading' ? 'Sending…' : '📨 Send Test Message'}
          </Button>
        </div>
      )}

      <div className="mt-6 pt-5 border-t border-zinc-200 dark:border-zinc-800">
        <h3 className="font-medium mb-2 text-sm">How to set up</h3>
        <ol className="text-sm text-zinc-500 dark:text-zinc-400 space-y-1.5 list-decimal list-inside">
          <li>Open Telegram and search for <strong className="text-zinc-900 dark:text-zinc-100">@BotFather</strong></li>
          <li>Send <code className="bg-zinc-100 dark:bg-zinc-800 px-1 rounded text-xs">/newbot</code> and follow the prompts to name your bot</li>
          <li>Copy the API token BotFather gives you and paste it above</li>
          <li>Click <strong className="text-zinc-900 dark:text-zinc-100">Save & Verify Token</strong></li>
          <li>Find your bot on Telegram, send it any message, then use Test Connection</li>
        </ol>
      </div>
    </Card>

    {/* ── Morning Briefing ─────────────────────────────────────── */}
    <Card className="mt-4">
      <div className="flex items-center justify-between mb-1">
        <h2 className="font-semibold">Morning Briefing</h2>
        <Toggle
          checked={briefing.enabled}
          onChange={v => updateBriefing('enabled', v)}
          size="md"
        />
      </div>
      <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-5">
        Receive a personalised daily summary via your Telegram bot. Requires a connected bot above.
      </p>

      {/* What actually happened last time. A briefing that stops
          arriving used to look exactly like one that was never due —
          the schedule above describes an intention, and this describes
          the outcome. */}
      <DeliveryStatus briefing={briefing} />

      {/* Time + Days */}
      <div className="space-y-5">
        {/* Time picker */}
        <div>
          <label className="label">Send time <span className="text-zinc-500 dark:text-zinc-400 font-normal text-xs">({briefing.timezone})</span></label>
          <input
            type="time"
            value={briefing.send_time}
            onChange={e => updateBriefing('send_time', e.target.value)}
            className="input w-36"
          />
        </div>

        {/* Timezone — independent of profile, defaults to it. DST-aware via
            IANA zones (e.g. Brisbane vs Sydney handle daylight saving). */}
        <div>
          <Select
            label="Timezone"
            value={briefing.timezone}
            onChange={e => updateBriefing('timezone', e.target.value)}
            options={TIMEZONES.map(tz => ({ value: tz, label: tz }))}
            className="w-72"
          />
          <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">
            Daylight saving is handled automatically — e.g. Australia/Brisbane stays put while Australia/Sydney shifts.
          </p>
        </div>

        {/* Days selector */}
        <div>
          <label className="label">Days</label>
          <div className="flex flex-col gap-2">
            {(['every_day', 'weekdays', 'custom'] as const).map(mode => (
              <label key={mode} className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="daysMode"
                  checked={daysMode === mode}
                  onChange={() => handleDaysModeChange(mode)}
                  className="accent-brand"
                />
                <span className="text-sm">
                  {mode === 'every_day' ? 'Every day' : mode === 'weekdays' ? 'Weekdays only' : 'Custom'}
                </span>
              </label>
            ))}
          </div>

          {daysMode === 'custom' && (
            <div className="flex flex-wrap gap-2 mt-3">
              {ALL_DAYS.map(day => (
                <button
                  key={day}
                  type="button"
                  onClick={() => toggleDay(day)}
                  className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors
                    ${briefing.days.includes(day)
                      ? 'bg-brand border-brand text-white'
                      : 'bg-transparent border-zinc-200 dark:border-zinc-800 text-zinc-500 dark:text-zinc-400 hover:border-brand hover:text-brand'
                    }`}
                >
                  {DAY_LABELS[day]}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Content toggles */}
      <div className="mt-6 pt-5 border-t border-zinc-200 dark:border-zinc-800">
        <h3 className="font-medium text-sm mb-3">Content</h3>
        <div className="space-y-3">

          {/* Net worth */}
          <div className="flex items-center justify-between">
            <span className="text-sm">💰 Net worth summary</span>
            <Toggle checked={briefing.show_net_worth} onChange={v => updateBriefing('show_net_worth', v)} size="sm" />
          </div>

          {/* Bank balances */}
          <div>
            <div className="flex items-center justify-between">
              <span className="text-sm flex items-center gap-2">
                {briefing.show_bank_balances && expander('bank')}
                🏦 Bank account balances
              </span>
              <Toggle checked={briefing.show_bank_balances} onChange={v => updateBriefing('show_bank_balances', v)} size="sm" />
            </div>
            {briefing.show_bank_balances && itemDropdown(
              'bank',
              accounts.map(a => ({ id: String(a.id), label: a.name })),
              id => !briefing.excluded_bank_ids.includes(id),
              id => toggleInArray('excluded_bank_ids', id),
              'No bank accounts yet.',
            )}
          </div>

          {/* Credit cards */}
          <div>
            <div className="flex items-center justify-between">
              <span className="text-sm flex items-center gap-2">
                {briefing.show_credit_cards && expander('card')}
                💳 Credit card debt
              </span>
              <Toggle checked={briefing.show_credit_cards} onChange={v => updateBriefing('show_credit_cards', v)} size="sm" />
            </div>
            {briefing.show_credit_cards && itemDropdown(
              'card',
              creditCards.map(c => ({ id: String(c.id), label: c.name })),
              id => !briefing.excluded_card_ids.includes(id),
              id => toggleInArray('excluded_card_ids', id),
              'No credit cards yet.',
            )}
          </div>

          {/* Investments */}
          <div className="flex items-center justify-between">
            <span className="text-sm">📈 Investment portfolio</span>
            <Toggle checked={briefing.show_investments} onChange={v => updateBriefing('show_investments', v)} size="sm" />
          </div>

          {/* Top movers — only when investments is on */}
          {briefing.show_investments && (
            <div className="ml-6 flex items-center gap-3">
              <span className="text-sm text-zinc-500 dark:text-zinc-400">Top movers</span>
              <Select
                value={briefing.top_movers}
                onChange={e => updateBriefing('top_movers', e.target.value)}
                options={[
                  { value: 'top3',       label: 'Top 3' },
                  { value: 'top5',       label: 'Top 5' },
                  { value: 'best_worst', label: 'Best & Worst only' },
                  { value: 'none',       label: "Don't show" },
                ]}
                className="w-44 text-sm py-1"
              />
            </div>
          )}

          {/* Watch specific holdings — composes with top movers (or replace
              movers entirely by setting top movers to "Don't show"). */}
          {briefing.show_investments && (
            <div className="ml-6">
              <div className="flex items-center gap-2">
                {expander('watch')}
                <span className="text-sm text-zinc-500 dark:text-zinc-400">
                  👀 Watch specific holdings
                  {briefing.watched_investment_ids.length > 0 && ` (${briefing.watched_investment_ids.length})`}
                </span>
              </div>
              {itemDropdown(
                'watch',
                investments.map(i => ({ id: String(i.id), label: i.ticker ? `${i.name} (${i.ticker})` : i.name })),
                id => briefing.watched_investment_ids.includes(id),
                id => toggleInArray('watched_investment_ids', id),
                'No holdings yet.',
              )}
            </div>
          )}

          {/* Watchlist */}
          <div>
            <div className="flex items-center justify-between">
              <span className="text-sm flex items-center gap-2">
                {briefing.show_watchlist && expander('watchlist')}
                🔍 Stock watchlist
              </span>
              <Toggle checked={briefing.show_watchlist} onChange={v => updateBriefing('show_watchlist', v)} size="sm" />
            </div>
            {briefing.show_watchlist && itemDropdown(
              'watchlist',
              watchlist.map(w => ({ id: w.id, label: w.ticker ? `${w.name} (${w.ticker})` : w.name })),
              id => !briefing.excluded_watchlist_ids.includes(id),
              id => toggleInArray('excluded_watchlist_ids', id),
              'No stocks on your watchlist yet.',
            )}
          </div>

          {/* Super */}
          <div className="flex items-center justify-between">
            <span className="text-sm">🏛 Superannuation balance</span>
            <Toggle checked={briefing.show_super} onChange={v => updateBriefing('show_super', v)} size="sm" />
          </div>

          {/* Bills */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className="text-sm">📋 Upcoming bills</span>
              {briefing.show_bills && (
                <div className="flex items-center gap-1.5">
                  <span className="text-xs text-zinc-500 dark:text-zinc-400">Show</span>
                  <input
                    type="number"
                    min={1}
                    max={10}
                    value={briefing.bills_count}
                    onChange={e => updateBriefing('bills_count', Math.max(1, Math.min(10, Number(e.target.value))))}
                    className="input w-14 text-sm py-1 text-center"
                  />
                </div>
              )}
            </div>
            <Toggle checked={briefing.show_bills} onChange={v => updateBriefing('show_bills', v)} size="sm" />
          </div>

          {/* Include auto-payments */}
          {briefing.show_bills && (
            <div className="flex items-center justify-between pl-6">
              <span className="text-sm text-zinc-500 dark:text-zinc-400">⚡ Include auto-payments</span>
              <Toggle checked={briefing.include_auto_pay} onChange={v => updateBriefing('include_auto_pay', v)} size="sm" />
            </div>
          )}

          {/* Goals */}
          <div>
            <div className="flex items-center justify-between">
              <span className="text-sm flex items-center gap-2">
                {briefing.show_goals && expander('goals')}
                🎯 Goals progress
              </span>
              <Toggle checked={briefing.show_goals} onChange={v => updateBriefing('show_goals', v)} size="sm" />
            </div>
            {briefing.show_goals && itemDropdown(
              'goals',
              goals.map(g => ({ id: String(g.id), label: g.name })),
              id => !briefing.excluded_goal_ids.includes(id),
              id => toggleInArray('excluded_goal_ids', id),
              'No goals yet.',
            )}
          </div>

          {/* Custom reminders */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className="text-sm">🔔 Reminders</span>
              {briefing.show_reminders && (
                <div className="flex items-center gap-1.5">
                  <span className="text-xs text-zinc-500 dark:text-zinc-400">Max</span>
                  <input
                    type="number"
                    min={1}
                    max={10}
                    value={briefing.reminders_max}
                    onChange={e => updateBriefing('reminders_max', Math.max(1, Math.min(10, Number(e.target.value))))}
                    className="input w-14 text-sm py-1 text-center"
                  />
                </div>
              )}
            </div>
            <Toggle checked={briefing.show_reminders} onChange={v => updateBriefing('show_reminders', v)} size="sm" />
          </div>
        </div>
      </div>

      {/* Save briefing preferences — independent of the bot token */}
      <div className="mt-5 pt-5 border-t border-zinc-200 dark:border-zinc-800 flex items-center gap-3">
        <Button
          variant="primary"
          onClick={saveBriefingSettings}
          loading={briefingSaveStatus === 'saving'}
          disabled={briefingSaveStatus === 'saving'}
        >
          {briefingSaveStatus === 'saved'
            ? '✓ Preferences Saved'
            : briefingSaveStatus === 'saving'
            ? 'Saving…'
            : 'Save Preferences'}
        </Button>
        {briefingSaveStatus === 'error' && (
          <span className="text-sm text-[#ef4444]">Save failed — try again.</span>
        )}
      </div>
    </Card>
    </>
  );
}
