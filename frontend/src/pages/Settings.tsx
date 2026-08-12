import { useEffect, useRef, useState } from 'react';
import { PageHeader } from '../components/design-kit/UI';
import { useNavigate } from 'react-router-dom';
import Layout from '../components/layout/Layout';
import { useStore } from '../store';
import { settingsApi, investmentsApi, API_BASE, type ConnectedAppLink } from '../services/api';
import { formatRelativeDate, formatDate, daysUntil } from '../utils/format';
import { bootstrapData, customCategoriesDS } from '../services/dataService';
import { useCategoryUniverse, useAllCategories } from '../utils/categories';
import Card from '../components/common/Card';
import Button from '../components/common/Button';
import Input, { Select, Toggle } from '../components/common/Input';
import Modal from '../components/common/Modal';
import CategoryRules from '../components/settings/CategoryRules';

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

const SECTIONS = ['Profile', 'Appearance', 'Categories', 'Telegram Bot', 'Connected Apps', 'Tax Settings', 'Plan & Billing', 'Privacy & Security', 'Support'] as const;
type Section = typeof SECTIONS[number];

// ── Connected-apps display + health ───────────────────────────────────────────
// Friendly name/icon per ecosystem app id (as stored in integration_links.app_id).
const APP_META: Record<string, { name: string; icon: string }> = {
  passistant: { name: 'PAssistant', icon: '🤖' },
};

type HealthTone = 'green' | 'amber' | 'red' | 'neutral';
const HEALTH_BADGE: Record<HealthTone, string> = {
  green:   'bg-[#22c55e]/10 text-[#16a34a] dark:text-[#86efac]',
  amber:   'bg-[#f59e0b]/10 text-[#b45309] dark:text-[#fcd34d]',
  red:     'bg-[#ef4444]/10 text-[#dc2626] dark:text-[#fca5a5]',
  neutral: 'bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400',
};
const HEALTH_DOT: Record<HealthTone, string> = {
  green: '#22c55e', amber: '#f59e0b', red: '#ef4444', neutral: '#a1a1aa',
};

// A link is "stale" (probable problem) if it hasn't read the summary in this long.
const SYNC_STALE_DAYS = 3;

// Derive a status badge + one-line detail for a connected app, so a working link
// reads green and a broken/idle one is obvious at a glance.
function appHealth(app: ConnectedAppLink, appName: string): { tone: HealthTone; label: string; detail: string } {
  // The app severed the link from its own end — show it plainly so the user knows
  // why the connection stopped (rather than leaving them to guess from stale sync).
  if (app.status === 'disconnected') {
    const when = app.disconnected_at ? ` on ${formatDate(app.disconnected_at)}` : '';
    return { tone: 'red', label: 'Disconnected', detail: `${appName} disconnected from its end${when}. Reconnect with a new pairing code.` };
  }
  if (app.status === 'pending') {
    return { tone: 'amber', label: 'Waiting to connect', detail: `Enter the pairing code in ${appName} to finish connecting.` };
  }
  if (!app.last_seen_at) {
    return { tone: 'neutral', label: 'Connected', detail: `Awaiting first sync from ${appName}.` };
  }
  const daysAgo = -daysUntil(app.last_seen_at);
  if (daysAgo <= SYNC_STALE_DAYS) {
    return { tone: 'green', label: 'Connected', detail: `Last synced ${formatRelativeDate(app.last_seen_at)}` };
  }
  return { tone: 'amber', label: 'Not syncing', detail: `Last synced ${formatRelativeDate(app.last_seen_at)} — ${appName} may have lost access.` };
}

const CURRENCIES = [
  'AUD', 'USD', 'GBP', 'EUR', 'NZD', 'SGD', 'CAD', 'JPY', 'HKD', 'CHF',
  'CNY', 'INR', 'KRW', 'THB', 'MYR', 'PHP', 'IDR', 'BRL', 'MXN', 'ZAR',
];

// Full IANA timezone list from the runtime when available, with a curated
// fallback for older browsers. Drives the Profile → Timezone dropdown.
const TIMEZONES: string[] = (() => {
  try {
    const v = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
    if (v) return v('timeZone');
  } catch { /* fall through */ }
  return [
    'Australia/Sydney', 'Australia/Melbourne', 'Australia/Brisbane', 'Australia/Adelaide',
    'Australia/Perth', 'Pacific/Auckland', 'Asia/Singapore', 'Asia/Hong_Kong', 'Asia/Tokyo',
    'Asia/Kolkata', 'Asia/Dubai', 'Europe/London', 'Europe/Paris', 'Europe/Berlin',
    'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
    'America/Sao_Paulo', 'UTC',
  ];
})();

export default function Settings() {
  const { user, setAuth, token, theme, setTheme, logout, accounts, creditCards, investments, goals, setSelectedCategories } = useStore();
  const [activeSection, setActiveSection] = useState<Section>('Profile');
  const [loading, setLoading] = useState(false);
  const [saved, setSaved] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [nwTimeframe, setNwTimeframe] = useState<'daily' | 'weekly' | 'monthly' | 'yearly' | 'all'>(
    () => (localStorage.getItem('nwTimeframe') as 'daily' | 'weekly' | 'monthly' | 'yearly' | 'all') || 'weekly',
  );
  const navigate = useNavigate();

  // ── Categories ────────────────────────────────────────────────────────────
  // The full menu of choosable categories (built-ins + anything the user made),
  // and what's currently active app-wide.
  const categoryUniverse = useCategoryUniverse();
  const activeCategories = useAllCategories();

  const [newCat, setNewCat] = useState('');
  // Working draft of the selection — nothing is committed until "Save" is pressed.
  const [catDraft, setCatDraft] = useState<string[] | null>(null);
  const [catSaved, setCatSaved] = useState(false);

  // Seed the draft from whatever is currently active, once the data is loaded.
  useEffect(() => {
    if (catDraft === null && categoryUniverse.length > 0) setCatDraft(activeCategories);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [categoryUniverse.length]);

  const catInDraft = (name: string) =>
    (catDraft ?? []).some(c => c.toLowerCase() === name.toLowerCase());

  const toggleCat = (name: string) => {
    setCatDraft(prev => {
      const arr = prev ?? [];
      return arr.some(c => c.toLowerCase() === name.toLowerCase())
        ? arr.filter(c => c.toLowerCase() !== name.toLowerCase())
        : [...arr, name];
    });
  };

  // Add a brand-new category: create it (so it exists + syncs) and pre-select it.
  const addCategory = () => {
    const name = newCat.trim();
    if (!name) return;
    customCategoriesDS.add(name);   // de-dupes + syncs to the server
    setCatDraft(prev => {
      const arr = prev ?? [];
      return arr.some(c => c.toLowerCase() === name.toLowerCase()) ? arr : [...arr, name];
    });
    setNewCat('');
  };

  // Full ui_preferences blob, kept so we merge (never clobber) other prefs.
  const uiPrefsRef = useRef<Record<string, unknown>>({});
  useEffect(() => {
    settingsApi.getProfile()
      .then((p: { ui_preferences?: Record<string, unknown> }) => {
        const prefs = p?.ui_preferences ?? {};
        uiPrefsRef.current = prefs;
        // Server is authoritative for the saved selection on load.
        if (Array.isArray(prefs.selected_categories)) {
          setSelectedCategories((prefs.selected_categories as unknown[]).map(String));
        }
      })
      .catch(() => { /* best-effort; local persisted copy still applies */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Dirty = the draft differs from what's active right now.
  const catDirty = catDraft !== null && (
    catDraft.length !== activeCategories.length ||
    [...catDraft].map(c => c.toLowerCase()).sort().join('|') !==
      [...activeCategories].map(c => c.toLowerCase()).sort().join('|')
  );

  const saveCategories = () => {
    const chosen = catDraft ?? [];
    setSelectedCategories(chosen);
    const merged = { ...uiPrefsRef.current, selected_categories: chosen };
    uiPrefsRef.current = merged;
    settingsApi.updateProfile({ ui_preferences: merged }).catch(() => { /* local copy persists */ });
    setCatSaved(true);
    setTimeout(() => setCatSaved(false), 2000);
  };

  const [profileForm, setProfileForm] = useState({
    name: user?.name ?? '',
    currency_preference: user?.currency_preference ?? 'AUD',
    timezone: user?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
  });

  // ── Telegram state ────────────────────────────────────────────────────────
  const [tgToken,     setTgToken]     = useState(user?.telegram_bot_token ?? '');
  const [tgStatus,    setTgStatus]    = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [tgBotName,   setTgBotName]   = useState(user?.telegram_bot_token ? '…' : '');
  const [tgError,     setTgError]     = useState('');
  const [testStatus,  setTestStatus]  = useState<'idle' | 'loading' | 'sent' | 'noChat' | 'error'>('idle');
  const [testMsg,     setTestMsg]     = useState('');

  // ── Briefing state ────────────────────────────────────────────────────────
  const [pairCode,   setPairCode]   = useState('');
  const [pairStatus, setPairStatus] = useState<'idle' | 'loading' | 'error'>('idle');
  // Connected apps (ecosystem links) + their sync health.
  const [connectedApps, setConnectedApps] = useState<ConnectedAppLink[] | null>(null);
  const [appsLoading,   setAppsLoading]   = useState(false);
  const [disconnectId,  setDisconnectId]  = useState<string | null>(null); // in-flight revoke
  const [confirmDisconnect, setConfirmDisconnect] = useState<ConnectedAppLink | null>(null);

  const loadConnectedApps = async () => {
    setAppsLoading(true);
    try {
      const { links } = await settingsApi.getConnectedApps();
      setConnectedApps(links);
    } catch {
      setConnectedApps([]); // treat a load failure as "none" — the section still renders
    } finally {
      setAppsLoading(false);
    }
  };

  // Load the connected-apps list whenever that section is opened.
  useEffect(() => {
    if (activeSection === 'Connected Apps') loadConnectedApps();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSection]);

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

  useEffect(() => {
    if (user) {
      setProfileForm({
        name: user.name,
        currency_preference: user.currency_preference,
        timezone: user.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
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
      .then((profile: { telegram_bot_token?: string; name?: string; currency_preference?: string; timezone?: string } | null) => {
        if (!profile) return;
        if (profile.telegram_bot_token) setTgToken(profile.telegram_bot_token);
        if (user) setAuth({ ...user, ...profile }, token);
      })
      .catch(() => {});

    // Briefing settings — always loaded on mount so they're ready when the
    // user opens the Telegram Bot tab (or if they refresh on that tab)
    fetch(`${base}/api/settings/briefing`, { headers })
      .then(r => (r.ok ? r.json() : null))
      .then((data: Partial<BriefingSettings> | null) => {
        if (data) {
          // Merge over defaults so new array fields are present even if the server
          // row predates them (migration not yet run / legacy row).
          setBriefing({ ...DEFAULT_BRIEFING, ...data });
          setDaysMode(inferDaysMode(data.days ?? DEFAULT_BRIEFING.days));
        }
      })
      .catch(() => {});
  }, [token]); // re-run once token is available after Zustand rehydrates

  const saveProfile = async () => {
    setLoading(true);
    try {
      const currencyChanged =
        profileForm.currency_preference !== (user?.currency_preference ?? 'AUD');
      const updated = await settingsApi.updateProfile(profileForm);
      if (user && token) setAuth({ ...user, ...updated }, token);
      // A currency switch changes how the backend enriches every monetary value
      // (display_* fields + native→preferred conversion_rate). The cached rows in
      // the store were enriched at the OLD currency, so we must refetch everything
      // to avoid mixing currencies (e.g. value-in-USD minus cost-in-AUD).
      if (currencyChanged) await bootstrapData();
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally { setLoading(false); }
  };

  const saveTheme = async (t: 'light' | 'dark' | 'system') => {
    setTheme(t);
    // Best-effort cross-device sync. 'system' requires the users.theme CHECK
    // constraint to include it (database/2026-theme-system.sql); until that
    // migration runs the write is harmlessly ignored and the choice still holds
    // locally via the persisted store.
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
    <Layout>
      <PageHeader title="Settings" />

      <div className="flex flex-col lg:flex-row gap-6">
        {/* Sidebar nav */}
        <div className="lg:w-48 flex-shrink-0 flex flex-col gap-2">
          <nav className="flex flex-row lg:flex-col gap-1 overflow-x-auto lg:overflow-visible">
            {SECTIONS.map(section => (
              <button
                key={section}
                onClick={() => setActiveSection(section)}
                className={`px-3 py-2 rounded-[8px] text-sm font-medium text-left whitespace-nowrap transition-colors
                  ${activeSection === section
                    ? 'bg-brand/10 text-brand'
                    : 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-100 dark:hover:bg-zinc-900'
                  }`}
              >
                {section}
              </button>
            ))}
          </nav>

          {/* Sign out — desktop only (hidden on mobile horizontal scroll nav) */}
          <div className="hidden lg:block border-t border-zinc-200 dark:border-zinc-800 pt-2 mt-1">
            <button
              onClick={() => { logout(); navigate('/login'); }}
              className="w-full flex items-center gap-2 px-3 py-2 rounded-[8px] text-sm font-medium text-[#ef4444] hover:bg-[#ef4444]/10 transition-colors text-left"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
                <polyline points="16 17 21 12 16 7"/>
                <line x1="21" y1="12" x2="9" y2="12"/>
              </svg>
              Sign out
            </button>
          </div>
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
                  <p className="text-sm text-zinc-500 dark:text-zinc-400">{user?.email}</p>
                </div>
                <Select
                  label="Display currency"
                  value={profileForm.currency_preference}
                  onChange={e => setProfileForm(f => ({ ...f, currency_preference: e.target.value }))}
                  options={CURRENCIES.map(c => ({ value: c, label: c }))}
                />
                <Select
                  label="Timezone"
                  value={profileForm.timezone}
                  onChange={e => setProfileForm(f => ({ ...f, timezone: e.target.value }))}
                  options={TIMEZONES.map(tz => ({ value: tz, label: tz.replace(/_/g, ' ') }))}
                />
                <p className="text-xs text-zinc-500 dark:text-zinc-400 -mt-2">
                  Controls all dates, times and your Telegram briefing schedule.
                </p>
                <Button variant="primary" onClick={saveProfile} loading={loading}>
                  {saved ? '✓ Saved' : 'Save changes'}
                </Button>
              </div>
            </Card>
          )}

          {activeSection === 'Appearance' && (
            <Card>
              <h2 className="font-semibold mb-1">Appearance</h2>
              <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-4">
                Choose a look, or match your device automatically.
              </p>
              <div className="grid grid-cols-3 gap-3 max-w-sm">
                {(['light', 'dark', 'system'] as const).map(t => (
                  <button
                    key={t}
                    onClick={() => saveTheme(t)}
                    className={`rounded-[12px] border-2 p-4 flex flex-col items-center gap-3 transition-all
                      ${theme === t ? 'border-brand bg-brand/5' : 'border-zinc-200 dark:border-zinc-800'}`}
                  >
                    {t === 'light' && <div className="w-16 h-10 rounded-[6px] border bg-white border-zinc-200" />}
                    {t === 'dark' && <div className="w-16 h-10 rounded-[6px] border bg-zinc-900 border-zinc-800" />}
                    {t === 'system' && (
                      // Split swatch: light on the left, dark on the right.
                      <div className="w-16 h-10 rounded-[6px] border border-zinc-200 dark:border-zinc-800 overflow-hidden flex">
                        <div className="w-1/2 h-full bg-white" />
                        <div className="w-1/2 h-full bg-zinc-900" />
                      </div>
                    )}
                    <span className="text-sm font-medium capitalize">{t}</span>
                  </button>
                ))}
              </div>

              <h3 className="font-medium text-sm mt-6 mb-1">Net worth graph</h3>
              <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-3">
                Default timeframe shown on the Overview net-worth chart.
              </p>
              <div className="flex flex-wrap gap-2 max-w-md">
                {([
                  { key: 'daily', label: 'Daily' },
                  { key: 'weekly', label: 'Weekly' },
                  { key: 'monthly', label: 'Monthly' },
                  { key: 'yearly', label: 'Yearly' },
                  { key: 'all', label: 'All time' },
                ] as const).map(tf => (
                  <button
                    key={tf.key}
                    onClick={() => { setNwTimeframe(tf.key); localStorage.setItem('nwTimeframe', tf.key); }}
                    className={`px-3 py-1.5 rounded-[8px] text-sm border-2 transition-all
                      ${nwTimeframe === tf.key
                        ? 'border-brand bg-brand/5 text-brand font-medium'
                        : 'border-zinc-200 dark:border-zinc-800 text-zinc-500 dark:text-zinc-400'}`}
                  >
                    {tf.label}
                  </button>
                ))}
              </div>
            </Card>
          )}

          {activeSection === 'Categories' && (
            <div className="space-y-6">
            <Card>
              <h2 className="font-semibold mb-1">Categories</h2>
              <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-4">
                Tap the categories you want. Only the highlighted ones show up when you categorise a
                transaction or build a budget. Add your own below, then press Save.
              </p>

              {/* Add a category */}
              <div className="flex items-end gap-2 max-w-md mb-5">
                <div className="flex-1">
                  <Input
                    label="Add a category"
                    value={newCat}
                    onChange={e => setNewCat(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') addCategory(); }}
                    placeholder="e.g. Eating out, Pets, Coffee"
                  />
                </div>
                <Button onClick={addCategory} disabled={!newCat.trim()}>Add</Button>
              </div>

              {/* The one menu: tap to select / deselect */}
              <div className="flex flex-wrap gap-2">
                {categoryUniverse.map(c => {
                  const on = catInDraft(c);
                  return (
                    <button
                      key={c}
                      onClick={() => toggleCat(c)}
                      aria-pressed={on}
                      className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm border transition-colors
                        ${on
                          ? 'bg-brand/10 border-brand/40 text-brand font-medium'
                          : 'bg-transparent border-zinc-200 dark:border-zinc-800 text-zinc-400 dark:text-zinc-500'}`}
                    >
                      <span className={`inline-flex items-center justify-center w-3.5 h-3.5 rounded-full text-[9px] ${
                        on ? 'bg-brand text-white' : 'border border-zinc-300 dark:border-zinc-700'
                      }`}>{on ? '✓' : ''}</span>
                      {c}
                    </button>
                  );
                })}
              </div>

              {/* Save */}
              <div className="flex items-center gap-3 mt-6">
                <Button variant="primary" onClick={saveCategories} disabled={!catDirty && !catSaved}>
                  {catSaved ? '✓ Saved' : 'Save'}
                </Button>
                <span className="text-xs text-zinc-500 dark:text-zinc-400">
                  {(catDraft ?? []).length} selected
                  {catDirty && <span className="text-[#f59e0b]"> · unsaved changes</span>}
                </span>
              </div>

              <p className="text-[11px] text-zinc-400 dark:text-zinc-500 mt-4">
                Un-selecting a category doesn't change transactions already filed under it — it just
                stops it appearing when you pick a category.
              </p>
            </Card>

            <CategoryRules currency={user?.currency_preference ?? 'AUD'} />
            </div>
          )}

          {activeSection === 'Telegram Bot' && (
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
          )}

          {activeSection === 'Connected Apps' && (
            <Card>
              <h2 className="font-semibold mb-1">Connected Apps</h2>
              <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-4">
                Link Ledger to another app in your ecosystem (like PAssistant) so your live
                financial summary shows up there. Ledger only ever shares a read-only summary
                outward — nothing connects back into Ledger, and Ledger stays the owner of all your data.
              </p>

              {/* ── Current connections + sync health ── */}
              <div className="mb-6">
                {appsLoading && connectedApps === null ? (
                  <p className="text-sm text-zinc-500 dark:text-zinc-400">Checking connections…</p>
                ) : (connectedApps ?? []).length === 0 ? (
                  <div className="px-4 py-4 rounded-[8px] border border-dashed border-zinc-200 dark:border-zinc-800 text-sm text-zinc-500 dark:text-zinc-400 max-w-md">
                    No apps connected yet. Generate a pairing code below to connect one.
                  </div>
                ) : (
                  <div className="space-y-2 max-w-md">
                    {(connectedApps ?? []).map(app => {
                      const meta = APP_META[app.app_id ?? ''] ?? { name: app.app_id || 'App', icon: '🔗' };
                      const h = appHealth(app, meta.name);
                      return (
                        <div key={app.id} className="flex items-start justify-between gap-3 px-4 py-3 rounded-[8px] border border-zinc-200 dark:border-zinc-800">
                          <div className="flex items-start gap-3 min-w-0">
                            <span className="text-xl leading-none mt-0.5">{meta.icon}</span>
                            <div className="min-w-0">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="text-sm font-medium">{meta.name}</span>
                                <span className={`inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full ${HEALTH_BADGE[h.tone]}`}>
                                  <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: HEALTH_DOT[h.tone] }} />
                                  {h.label}
                                </span>
                              </div>
                              <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">{h.detail}</p>
                              {app.status === 'active' && app.redeemed_at && (
                                <p className="text-[11px] text-zinc-400 dark:text-[#666] mt-0.5">Connected {formatDate(app.redeemed_at)}</p>
                              )}
                            </div>
                          </div>
                          {app.status === 'active' && (
                            <button
                              onClick={() => setConfirmDisconnect(app)}
                              disabled={disconnectId === app.id}
                              className="text-xs text-[#ef4444] hover:underline flex-shrink-0 disabled:opacity-50"
                            >
                              {disconnectId === app.id ? 'Disconnecting…' : 'Disconnect'}
                            </button>
                          )}
                          {app.status === 'disconnected' && (
                            <button
                              onClick={async () => {
                                setDisconnectId(app.id);
                                try { await settingsApi.disconnectApp(app.id); await loadConnectedApps(); }
                                catch { /* leave the row; the user can retry */ }
                                finally { setDisconnectId(null); }
                              }}
                              disabled={disconnectId === app.id}
                              className="text-xs text-zinc-500 dark:text-zinc-400 hover:underline flex-shrink-0 disabled:opacity-50"
                            >
                              {disconnectId === app.id ? 'Dismissing…' : 'Dismiss'}
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-3">
                To link a new app, generate a pairing code in Ledger and enter it in that app.
              </p>

              {pairCode ? (
                <div className="mb-4 px-4 py-4 rounded-[8px] bg-brand/10 max-w-sm">
                  <div className="text-xs text-zinc-500 dark:text-zinc-400 mb-1">Your pairing code</div>
                  <div className="text-2xl font-bold tracking-widest text-brand select-all">{pairCode}</div>
                  <div className="text-xs text-zinc-500 dark:text-zinc-400 mt-2">
                    Single use · doesn't expire
                  </div>
                </div>
              ) : null}

              {pairStatus === 'error' && (
                <div className="mb-4 px-3 py-2.5 rounded-[8px] bg-[#ef4444]/10 text-[#ef4444] text-sm max-w-sm">
                  Could not generate a code — try again.
                </div>
              )}

              <Button
                variant="primary"
                loading={pairStatus === 'loading'}
                onClick={async () => {
                  setPairStatus('loading');
                  try {
                    const { code } = await settingsApi.generatePairingCode();
                    setPairCode(code); setPairStatus('idle');
                    loadConnectedApps(); // surface the new "waiting to connect" entry
                  } catch { setPairStatus('error'); }
                }}
              >
                {pairCode ? 'Generate new code' : 'Generate pairing code'}
              </Button>

              {/* Disconnect confirmation */}
              <Modal
                isOpen={!!confirmDisconnect}
                onClose={() => setConfirmDisconnect(null)}
                title={`Disconnect ${APP_META[confirmDisconnect?.app_id ?? '']?.name ?? confirmDisconnect?.app_id ?? 'app'}?`}
                size="sm"
              >
                <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-4">
                  This app will immediately lose access to your Ledger summary. You can reconnect
                  any time with a new pairing code.
                </p>
                <div className="flex gap-3">
                  <Button variant="secondary" onClick={() => setConfirmDisconnect(null)}>Cancel</Button>
                  <Button
                    variant="danger"
                    fullWidth
                    loading={!!confirmDisconnect && disconnectId === confirmDisconnect.id}
                    onClick={async () => {
                      const target = confirmDisconnect;
                      if (!target) return;
                      setDisconnectId(target.id);
                      setConfirmDisconnect(null);
                      try {
                        await settingsApi.disconnectApp(target.id);
                        await loadConnectedApps();
                      } catch { /* leave the list as-is; the user can retry */ }
                      finally { setDisconnectId(null); }
                    }}
                  >
                    Disconnect
                  </Button>
                </div>
              </Modal>
            </Card>
          )}

          {activeSection === 'Tax Settings' && (
            <Card>
              <h2 className="font-semibold mb-4">Tax Settings</h2>
              <div className="space-y-4 max-w-sm">
                <p className="text-xs text-zinc-500 dark:text-zinc-400">
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
                  ${user?.plan === 'premium' ? 'bg-brand/10 text-brand' : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400'}`}>
                  {user?.plan === 'premium' ? '★ Premium' : 'Free Plan'}
                </div>
              </div>
              {user?.plan !== 'premium' && (
                <div className="border border-brand/20 rounded-[12px] p-4 bg-brand/5">
                  <h3 className="font-semibold mb-2">Upgrade to Premium</h3>
                  <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-3">$29.99 AUD/month</p>
                  <ul className="text-sm space-y-1 mb-4">
                    {['Unlimited accounts & investments', 'Basiq bank sync', 'Telegram bot', 'Tax & income tracking', 'Document AI parsing', 'Goals & budgeting', 'Shared account access'].map(f => (
                      <li key={f} className="flex items-center gap-2">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                        {f}
                      </li>
                    ))}
                  </ul>
                  <Button variant="primary" fullWidth>Upgrade — $29.99/month</Button>
                  <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-2 text-center">Stripe integration coming soon</p>
                </div>
              )}
            </Card>
          )}

          {activeSection === 'Privacy & Security' && (
            <Card>
              <h2 className="font-semibold mb-4">Privacy & Security</h2>
              <div className="space-y-4">
                {/* Sign out — shown here for mobile where the sidebar button is hidden */}
                <div className="lg:hidden">
                  <button
                    onClick={() => { logout(); navigate('/login'); }}
                    className="flex items-center gap-2 px-4 py-2 rounded-[8px] border border-zinc-200 dark:border-zinc-800 text-sm font-medium text-[#ef4444] hover:bg-[#ef4444]/10 transition-colors"
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
                      <polyline points="16 17 21 12 16 7"/>
                      <line x1="21" y1="12" x2="9" y2="12"/>
                    </svg>
                    Sign out
                  </button>
                  <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">You'll be taken to the login page.</p>
                </div>

                <div>
                  <Button variant="secondary" onClick={handleExport}>
                    Export all my data (JSON)
                  </Button>
                  <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">Download a copy of all your Ledger data.</p>
                </div>
                <div className="pt-4 border-t border-zinc-200 dark:border-zinc-800">
                  <h3 className="font-medium text-[#ef4444] mb-2">Danger Zone</h3>
                  <Button variant="danger" onClick={() => setDeleteOpen(true)}>Delete Account</Button>
                  <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">Permanently deletes your account and all data. Cannot be undone.</p>
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
                  <p className="text-sm text-zinc-500 dark:text-zinc-400">Priority email support is available on the Premium plan.</p>
                )}
              </div>
            </Card>
          )}
        </div>
      </div>

      {/* Delete Account Modal */}
      <Modal isOpen={deleteOpen} onClose={() => setDeleteOpen(false)} title="Delete Account" size="sm">
        <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-4">
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
