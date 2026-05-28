import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Layout from '../components/layout/Layout';
import { useStore } from '../store';
import { settingsApi } from '../services/api';
import Card from '../components/common/Card';
import Button from '../components/common/Button';
import Input, { Select, Toggle } from '../components/common/Input';
import Modal from '../components/common/Modal';

// ── Briefing settings types ───────────────────────────────────────────────────
interface BriefingSettings {
  enabled: boolean;
  send_time: string;
  days: string[];
  show_net_worth: boolean;
  show_bank_balances: boolean;
  show_credit_cards: boolean;
  show_investments: boolean;
  top_movers: string;
  show_super: boolean;
  show_bills: boolean;
  bills_count: number;
  show_goals: boolean;
  show_reminders: boolean;
  reminders_max: number;
}

const DEFAULT_BRIEFING: BriefingSettings = {
  enabled: true,
  send_time: '08:00',
  days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'],
  show_net_worth: true,
  show_bank_balances: true,
  show_credit_cards: true,
  show_investments: true,
  top_movers: 'top3',
  show_super: true,
  show_bills: true,
  bills_count: 5,
  show_goals: true,
  show_reminders: false,
  reminders_max: 3,
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

const SECTIONS = ['Profile', 'Appearance', 'Notifications', 'Tax Settings', 'Plan & Billing', 'Privacy & Security', 'Support'] as const;
type Section = typeof SECTIONS[number];

const CURRENCIES = [
  'AUD', 'USD', 'GBP', 'EUR', 'NZD', 'SGD', 'CAD', 'JPY', 'HKD', 'CHF',
  'CNY', 'INR', 'KRW', 'THB', 'MYR', 'PHP', 'IDR', 'BRL', 'MXN', 'ZAR',
];

export default function Settings() {
  const { user, setAuth, token, theme, setTheme, logout } = useStore();
  const [activeSection, setActiveSection] = useState<Section>('Profile');
  const [loading, setLoading] = useState(false);
  const [saved, setSaved] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const navigate = useNavigate();

  const [profileForm, setProfileForm] = useState({
    name: user?.name ?? '',
    currency_preference: user?.currency_preference ?? 'AUD',
  });

  // ── Telegram state ────────────────────────────────────────────────────────
  const [tgToken,     setTgToken]     = useState(user?.telegram_bot_token ?? '');
  const [tgStatus,    setTgStatus]    = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [tgBotName,   setTgBotName]   = useState(user?.telegram_bot_token ? '…' : '');
  const [tgError,     setTgError]     = useState('');
  const [testStatus,  setTestStatus]  = useState<'idle' | 'loading' | 'sent' | 'noChat' | 'error'>('idle');
  const [testMsg,     setTestMsg]     = useState('');

  // ── Briefing state ────────────────────────────────────────────────────────
  const [briefing,       setBriefing]       = useState<BriefingSettings>(DEFAULT_BRIEFING);
  const [daysMode,       setDaysMode]       = useState<'every_day' | 'weekdays' | 'custom'>('every_day');
  // If token was previously saved, kick off a silent getMe to restore the bot name
  useEffect(() => {
    if (user?.telegram_bot_token && !tgBotName.replace('…', '')) return;
    if (user?.telegram_bot_token) {
      fetch('/api/telegram/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: user.telegram_bot_token }),
      }).then(r => r.json()).then((d: { ok: boolean; username?: string }) => {
        if (d.ok && d.username) setTgBotName('@' + d.username);
      }).catch(() => {});
    }
  }, []); // eslint-disable-line

  useEffect(() => {
    if (user) {
      setProfileForm({ name: user.name, currency_preference: user.currency_preference });
    }
  }, [user]);

  // Load profile (telegram token) + briefing settings on mount.
  // Re-runs when `token` changes so we catch the Zustand persist rehydration
  // window where token is initially null then becomes the real JWT.
  // A `loaded` ref prevents double-fetching if token changes for other reasons.
  const dataLoaded = useRef(false);
  useEffect(() => {
    if (!token || dataLoaded.current) return;
    dataLoaded.current = true;
    const base = import.meta.env.VITE_API_URL ?? '';
    const headers = { Authorization: `Bearer ${token}` };

    // Profile — picks up telegram_bot_token from DB
    fetch(`${base}/api/settings/profile`, { headers })
      .then(r => (r.ok ? r.json() : null))
      .then((profile: { telegram_bot_token?: string; name?: string; currency_preference?: string } | null) => {
        if (!profile) return;
        if (profile.telegram_bot_token) setTgToken(profile.telegram_bot_token);
        if (user) setAuth({ ...user, ...profile }, token);
      })
      .catch(() => {});

    // Briefing settings — always loaded on mount so they're ready when the
    // user opens the Notifications tab (or if they refresh on that tab)
    fetch(`${base}/api/settings/briefing`, { headers })
      .then(r => (r.ok ? r.json() : null))
      .then((data: BriefingSettings | null) => {
        if (data) {
          setBriefing(data);
          setDaysMode(inferDaysMode(data.days));
        }
      })
      .catch(() => {});
  }, [token]); // re-run once token is available after Zustand rehydrates

  const saveProfile = async () => {
    setLoading(true);
    try {
      const updated = await settingsApi.updateProfile(profileForm);
      if (user && token) setAuth({ ...user, ...updated }, token);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally { setLoading(false); }
  };

  const saveTheme = async (t: 'light' | 'dark') => {
    setTheme(t);
    await settingsApi.updateProfile({ theme: t }).catch(() => {});
  };

  const handleDeleteAccount = async () => {
    if (deleteConfirmText !== 'DELETE') return;
    await settingsApi.deleteAccount('DELETE');
    logout();
    navigate('/login');
  };

  const handleExport = async () => {
    const data = await settingsApi.exportData();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ledger-export-${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // ── Telegram handlers ────────────────────────────────────────────────────
  const saveTelegramToken = async () => {
    if (!tgToken.trim()) return;
    setTgStatus('saving');
    setTgError('');
    setTgBotName('');
    try {
      // 1. Verify token with Telegram
      const res = await fetch('/api/telegram/verify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ token: tgToken.trim() }),
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

      // 3. Save briefing settings in the same flow using the same token
      if (token) {
        const base = import.meta.env.VITE_API_URL ?? '';
        await fetch(`${base}/api/settings/briefing`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(briefing),
        }).catch(() => {}); // Non-fatal: token save succeeded even if briefing fails
      }

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

  const testTelegramConnection = async () => {
    if (!tgToken.trim()) return;
    setTestStatus('loading');
    setTestMsg('');
    try {
      const res = await fetch('/api/telegram/test', {
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
    <Layout>
      <h1 className="text-2xl font-semibold mb-6">Settings</h1>

      <div className="flex flex-col lg:flex-row gap-6">
        {/* Sidebar nav */}
        <div className="lg:w-48 flex-shrink-0">
          <nav className="flex flex-row lg:flex-col gap-1 overflow-x-auto lg:overflow-visible">
            {SECTIONS.map(section => (
              <button
                key={section}
                onClick={() => setActiveSection(section)}
                className={`px-3 py-2 rounded-[8px] text-sm font-medium text-left whitespace-nowrap transition-colors
                  ${activeSection === section
                    ? 'bg-[#3b7dd8]/10 text-[#3b7dd8]'
                    : 'text-[#6b6b6b] dark:text-[#a0a0a0] hover:text-[#0f0f0f] dark:hover:text-[#f5f5f5] hover:bg-[#f5f5f5] dark:hover:bg-[#1a1a1a]'
                  }`}
              >
                {section}
              </button>
            ))}
          </nav>
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          {activeSection === 'Profile' && (
            <Card>
              <h2 className="font-semibold mb-4">Profile</h2>
              <div className="space-y-4 max-w-sm">
                <Input label="Full name" value={profileForm.name} onChange={e => setProfileForm(f => ({ ...f, name: e.target.value }))} />
                <div>
                  <label className="label">Email</label>
                  <p className="text-sm text-[#6b6b6b] dark:text-[#a0a0a0]">{user?.email}</p>
                </div>
                <Select
                  label="Display currency"
                  value={profileForm.currency_preference}
                  onChange={e => setProfileForm(f => ({ ...f, currency_preference: e.target.value }))}
                  options={CURRENCIES.map(c => ({ value: c, label: c }))}
                />
                <Button variant="primary" onClick={saveProfile} loading={loading}>
                  {saved ? '✓ Saved' : 'Save changes'}
                </Button>
              </div>
            </Card>
          )}

          {activeSection === 'Appearance' && (
            <Card>
              <h2 className="font-semibold mb-4">Appearance</h2>
              <div className="grid grid-cols-2 gap-3 max-w-xs">
                {(['light', 'dark'] as const).map(t => (
                  <button
                    key={t}
                    onClick={() => saveTheme(t)}
                    className={`rounded-[12px] border-2 p-4 flex flex-col items-center gap-3 transition-all
                      ${theme === t ? 'border-[#3b7dd8] bg-[#3b7dd8]/5' : 'border-[#e5e5e5] dark:border-[#2a2a2a]'}`}
                  >
                    <div className={`w-16 h-10 rounded-[6px] border ${t === 'light' ? 'bg-white border-[#e5e5e5]' : 'bg-[#1a1a1a] border-[#2a2a2a]'}`}/>
                    <span className="text-sm font-medium capitalize">{t}</span>
                  </button>
                ))}
              </div>
            </Card>
          )}

          {activeSection === 'Notifications' && (
            <>
            <Card>
              <h2 className="font-semibold mb-1">Telegram Bot</h2>
              <p className="text-sm text-[#6b6b6b] dark:text-[#a0a0a0] mb-4">
                Create a bot via{' '}
                <a href="https://t.me/botfather" target="_blank" rel="noreferrer" className="text-[#3b7dd8] hover:underline">
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
                <div className="mt-5 pt-5 border-t border-[#e5e5e5] dark:border-[#2a2a2a]">
                  <h3 className="font-medium mb-1 text-sm">Test Connection</h3>
                  <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0] mb-3">
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

              <div className="mt-6 pt-5 border-t border-[#e5e5e5] dark:border-[#2a2a2a]">
                <h3 className="font-medium mb-2 text-sm">How to set up</h3>
                <ol className="text-sm text-[#6b6b6b] dark:text-[#a0a0a0] space-y-1.5 list-decimal list-inside">
                  <li>Open Telegram and search for <strong className="text-[#0f0f0f] dark:text-[#f5f5f5]">@BotFather</strong></li>
                  <li>Send <code className="bg-[#f5f5f5] dark:bg-[#252525] px-1 rounded text-xs">/newbot</code> and follow the prompts to name your bot</li>
                  <li>Copy the API token BotFather gives you and paste it above</li>
                  <li>Click <strong className="text-[#0f0f0f] dark:text-[#f5f5f5]">Save & Verify Token</strong></li>
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
              <p className="text-sm text-[#6b6b6b] dark:text-[#a0a0a0] mb-5">
                Receive a personalised daily summary via your Telegram bot. Requires a connected bot above.
              </p>

              {/* Time + Days */}
              <div className="space-y-5">
                {/* Time picker */}
                <div>
                  <label className="label">Send time <span className="text-[#6b6b6b] dark:text-[#a0a0a0] font-normal text-xs">(Australia/Sydney)</span></label>
                  <input
                    type="time"
                    value={briefing.send_time}
                    onChange={e => updateBriefing('send_time', e.target.value)}
                    className="input w-36"
                  />
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
                          className="accent-[#3b7dd8]"
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
                              ? 'bg-[#3b7dd8] border-[#3b7dd8] text-white'
                              : 'bg-transparent border-[#e5e5e5] dark:border-[#2a2a2a] text-[#6b6b6b] dark:text-[#a0a0a0] hover:border-[#3b7dd8] hover:text-[#3b7dd8]'
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
              <div className="mt-6 pt-5 border-t border-[#e5e5e5] dark:border-[#2a2a2a]">
                <h3 className="font-medium text-sm mb-3">Content</h3>
                <div className="space-y-3">

                  {/* Net worth */}
                  <div className="flex items-center justify-between">
                    <span className="text-sm">💰 Net worth summary</span>
                    <Toggle checked={briefing.show_net_worth} onChange={v => updateBriefing('show_net_worth', v)} size="sm" />
                  </div>

                  {/* Bank balances */}
                  <div className="flex items-center justify-between">
                    <span className="text-sm">🏦 Bank account balances</span>
                    <Toggle checked={briefing.show_bank_balances} onChange={v => updateBriefing('show_bank_balances', v)} size="sm" />
                  </div>

                  {/* Credit cards */}
                  <div className="flex items-center justify-between">
                    <span className="text-sm">💳 Credit card debt</span>
                    <Toggle checked={briefing.show_credit_cards} onChange={v => updateBriefing('show_credit_cards', v)} size="sm" />
                  </div>

                  {/* Investments */}
                  <div className="flex items-center justify-between">
                    <span className="text-sm">📈 Investment portfolio</span>
                    <Toggle checked={briefing.show_investments} onChange={v => updateBriefing('show_investments', v)} size="sm" />
                  </div>

                  {/* Top movers — only when investments is on */}
                  {briefing.show_investments && (
                    <div className="ml-6 flex items-center gap-3">
                      <span className="text-sm text-[#6b6b6b] dark:text-[#a0a0a0]">Top movers</span>
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
                          <span className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">Show</span>
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

                  {/* Goals */}
                  <div className="flex items-center justify-between">
                    <span className="text-sm">🎯 Goals progress</span>
                    <Toggle checked={briefing.show_goals} onChange={v => updateBriefing('show_goals', v)} size="sm" />
                  </div>

                  {/* Custom reminders */}
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <span className="text-sm">🔔 Custom reminders</span>
                      {briefing.show_reminders && (
                        <div className="flex items-center gap-1.5">
                          <span className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">Max</span>
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

              {/* Note: briefing settings are saved alongside the bot token */}
              <p className="mt-5 text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">
                💡 These settings are saved automatically when you click{' '}
                <strong className="text-[#0f0f0f] dark:text-[#f5f5f5]">Save &amp; Verify Token</strong>{' '}
                in the Telegram Bot section above.
              </p>
            </Card>
            </>
          )}

          {activeSection === 'Tax Settings' && (
            <Card>
              <h2 className="font-semibold mb-4">Tax Settings</h2>
              <div className="space-y-4 max-w-sm">
                <Toggle
                  label="HECS/HELP student loan repayment"
                  checked={false}
                  onChange={() => {}}
                />
                <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">
                  Tax brackets are maintained by Ledger and updated each financial year.
                  Contact support if you need custom brackets.
                </p>
              </div>
            </Card>
          )}

          {activeSection === 'Plan & Billing' && (
            <Card>
              <h2 className="font-semibold mb-4">Plan & Billing</h2>
              <div className="mb-6">
                <div className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-sm font-medium
                  ${user?.plan === 'premium' ? 'bg-[#3b7dd8]/10 text-[#3b7dd8]' : 'bg-[#f5f5f5] dark:bg-[#2a2a2a] text-[#6b6b6b] dark:text-[#a0a0a0]'}`}>
                  {user?.plan === 'premium' ? '★ Premium' : 'Free Plan'}
                </div>
              </div>
              {user?.plan !== 'premium' && (
                <div className="border border-[#3b7dd8]/20 rounded-[12px] p-4 bg-[#3b7dd8]/5">
                  <h3 className="font-semibold mb-2">Upgrade to Premium</h3>
                  <p className="text-sm text-[#6b6b6b] dark:text-[#a0a0a0] mb-3">$29.99 AUD/month</p>
                  <ul className="text-sm space-y-1 mb-4">
                    {['Unlimited accounts & investments', 'Basiq bank sync', 'Telegram bot', 'Tax & income tracking', 'Document AI parsing', 'Goals & budgeting', 'Shared account access'].map(f => (
                      <li key={f} className="flex items-center gap-2">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                        {f}
                      </li>
                    ))}
                  </ul>
                  <Button variant="primary" fullWidth>Upgrade — $29.99/month</Button>
                  <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0] mt-2 text-center">Stripe integration coming soon</p>
                </div>
              )}
            </Card>
          )}

          {activeSection === 'Privacy & Security' && (
            <Card>
              <h2 className="font-semibold mb-4">Privacy & Security</h2>
              <div className="space-y-4">
                <div>
                  <Button variant="secondary" onClick={handleExport}>
                    Export all my data (JSON)
                  </Button>
                  <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0] mt-1">Download a copy of all your Ledger data.</p>
                </div>
                <div className="pt-4 border-t border-[#e5e5e5] dark:border-[#2a2a2a]">
                  <h3 className="font-medium text-[#ef4444] mb-2">Danger Zone</h3>
                  <Button variant="danger" onClick={() => setDeleteOpen(true)}>Delete Account</Button>
                  <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0] mt-1">Permanently deletes your account and all data. Cannot be undone.</p>
                </div>
              </div>
            </Card>
          )}

          {activeSection === 'Support' && (
            <Card>
              <h2 className="font-semibold mb-4">Support</h2>
              <div className="space-y-3">
                {user?.plan === 'premium' ? (
                  <a
                    href={`mailto:support@ledger.app?subject=Support Request — ${user.email}`}
                    className="btn-primary inline-flex items-center gap-2"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
                    Email Support
                  </a>
                ) : (
                  <p className="text-sm text-[#6b6b6b] dark:text-[#a0a0a0]">Priority email support is available on the Premium plan.</p>
                )}
              </div>
            </Card>
          )}
        </div>
      </div>

      {/* Delete Account Modal */}
      <Modal isOpen={deleteOpen} onClose={() => setDeleteOpen(false)} title="Delete Account" size="sm">
        <p className="text-sm text-[#6b6b6b] dark:text-[#a0a0a0] mb-4">
          This will permanently delete your account and all data. This cannot be undone.
        </p>
        <p className="text-sm font-medium mb-2">Type <strong>DELETE</strong> to confirm:</p>
        <Input
          value={deleteConfirmText}
          onChange={e => setDeleteConfirmText(e.target.value)}
          placeholder="DELETE"
        />
        <div className="flex gap-3 mt-4">
          <Button variant="secondary" onClick={() => setDeleteOpen(false)} fullWidth>Cancel</Button>
          <Button
            variant="danger"
            disabled={deleteConfirmText !== 'DELETE'}
            onClick={handleDeleteAccount}
            fullWidth
          >
            Delete Forever
          </Button>
        </div>
      </Modal>
    </Layout>
  );
}
