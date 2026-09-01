import { useEffect, useMemo, useRef, useState } from 'react';
import { PageHeader } from '../components/design-kit/UI';
import { useNavigate, useSearchParams } from 'react-router-dom';
import Layout from '../components/layout/Layout';
import { useStore } from '../store';
import { settingsApi, investmentsApi, API_BASE, type ConnectedAppLink } from '../services/api';
import { formatRelativeDate, formatDate, daysUntil } from '../utils/format';
import { bootstrapData, customCategoriesDS } from '../services/dataService';
import { useCategoryUniverse, useAllCategories, useCommittedCategories } from '../utils/categories';
import { categoryKey, sameCategory } from '../utils/categoryResolve';
import { isCanonicalCategory } from '../utils/categoryTaxonomy';
import Card from '../components/common/Card';
import Button from '../components/common/Button';
import Input, { Select, Toggle } from '../components/common/Input';
import AddCategoryField from '../components/common/AddCategoryField';
import Modal from '../components/common/Modal';
import TaxRatesSection from '../components/settings/TaxRatesSection';
import { VIEW_MODES, VIEW_MODE_COPY, type ViewMode } from '../utils/appearance';
import { TIMEZONES } from '../utils/timezones';


/**
 * A tiny drawing of what each view actually does — the chart on top, the tab bar
 * underneath. Worth the twenty lines: "technical vs peaceful" means nothing as
 * two words, and the difference is entirely visual, so the setting should show
 * it rather than describe it.
 */
function ViewSwatch({ mode }: { mode: ViewMode }) {
  const technical = mode === 'technical';
  return (
    <div className="rounded-[8px] border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 overflow-hidden">
      <svg viewBox="0 0 120 54" className="w-full block" aria-hidden="true">
        {technical ? (
          <>
            {/* gridlines + a line drawn between actual readings */}
            {[12, 22, 32].map(y => (
              <line key={y} x1="10" y1={y} x2="112" y2={y} stroke="currentColor" strokeWidth="0.5"
                strokeDasharray="2 2" className="text-zinc-300 dark:text-zinc-700" />
            ))}
            <line x1="10" y1="8" x2="10" y2="38" stroke="currentColor" strokeWidth="0.5" className="text-zinc-300 dark:text-zinc-700" />
            <polyline points="10,32 28,26 46,30 64,18 82,22 100,11 112,14" fill="none"
              stroke="currentColor" strokeWidth="1.2" className="text-brand" />
          </>
        ) : (
          <>
            {/* one soft curve, no frame at all */}
            <path d="M8 34 C 28 34, 34 20, 52 21 C 72 22, 80 12, 112 9 L112 38 L8 38 Z"
              className="text-brand/15" fill="currentColor" />
            <path d="M8 34 C 28 34, 34 20, 52 21 C 72 22, 80 12, 112 9" fill="none"
              stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" className="text-brand" />
          </>
        )}
        {/* the bar: many small squared tabs, or four rounded ones */}
        {technical
          ? Array.from({ length: 8 }, (_, i) => (
              <rect key={i} x={7 + i * 13.6} y="44" width="11" height="6" rx="1.5"
                className={i === 0 ? 'text-brand' : 'text-zinc-200 dark:text-zinc-700'} fill="currentColor" />
            ))
          : (
            <>
              <rect x="16" y="42" width="88" height="10" rx="5" className="text-zinc-100 dark:text-zinc-800" fill="currentColor" />
              {Array.from({ length: 4 }, (_, i) => (
                <rect key={i} x={19 + i * 21.5} y="44" width="18" height="6" rx="3"
                  className={i === 0 ? 'text-brand' : 'text-zinc-300 dark:text-zinc-600'} fill="currentColor" />
              ))}
            </>
          )}
      </svg>
    </div>
  );
}

/**
 * What is left in Settings.
 *
 * Households, Categories, Telegram and Plan & Billing were sections here and are
 * now destinations of their own (/households, /categories, /telegram, /billing),
 * because each is a job you go somewhere to do rather than a preference you
 * flip. The old ?section= deep links still land on them — see MOVED below.
 */
const SECTIONS = ['Profile', 'Appearance', 'Connected Apps', 'Tax Settings', 'Privacy & Security', 'Support'] as const;

/** Old ?section= values and where that job lives now. */
const MOVED: Record<string, string> = {
  households: '/households',
  categories: '/categories',
  'telegram bot': '/telegram',
  telegram: '/telegram',
  'plan & billing': '/billing',
  billing: '/billing',
};
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


export default function Settings() {
  const { user, setAuth, token, theme, setTheme, viewMode, setViewMode, logout, accounts, creditCards, investments, goals, setSelectedCategories } = useStore();
  // Deep-linkable: /settings?section=appearance opens straight at that section
  // (the scope pill and other in-app links land here). Unknown values fall
  // through to Profile exactly as before.
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [activeSection, setActiveSection] = useState<Section>(() => {
    const wanted = (searchParams.get('section') ?? '').toLowerCase();
    return SECTIONS.find(x => x.toLowerCase() === wanted) ?? 'Profile';
  });

  // A link to a section that has since become its own page goes there instead
  // of silently landing on Profile — every in-app link written before the move
  // (the household scope pill among them) still arrives where it meant to.
  const movedTo = MOVED[(searchParams.get('section') ?? '').toLowerCase()];
  useEffect(() => {
    if (movedTo) navigate(movedTo, { replace: true });
  }, [movedTo, navigate]);
  const [loading, setLoading] = useState(false);
  const [saved, setSaved] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [nwTimeframe, setNwTimeframe] = useState<'daily' | 'weekly' | 'monthly' | 'yearly' | 'all'>(
    () => (localStorage.getItem('nwTimeframe') as 'daily' | 'weekly' | 'monthly' | 'yearly' | 'all') || 'weekly',
  );


  const [profileForm, setProfileForm] = useState({
    name: user?.name ?? '',
    currency_preference: user?.currency_preference ?? 'AUD',
    timezone: user?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
  });


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

    // Profile — the name, currency and timezone this screen edits. The bot
    // token and the briefing now load on the Telegram screen that shows them.
    fetch(`${base}/api/settings/profile`, { headers })
      .then(r => (r.ok ? r.json() : null))
      .then((profile: { name?: string; currency_preference?: string; timezone?: string } | null) => {
        if (!profile) return;
        if (user) setAuth({ ...user, ...profile }, token);
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
              <h2 className="font-semibold mb-1">View</h2>
              <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-4">
                How much Ledger puts in front of you. Both views hold the whole app —
                the peaceful one keeps most of it on the More tab, and draws its charts
                as shapes rather than instruments.
              </p>
              <div className="grid grid-cols-2 gap-3 max-w-md">
                {VIEW_MODES.map(m => (
                  <button
                    key={m}
                    onClick={() => setViewMode(m)}
                    className={`rounded-[12px] border-2 p-3 text-left transition-all
                      ${viewMode === m ? 'border-brand bg-brand/5' : 'border-zinc-200 dark:border-zinc-800'}`}
                  >
                    <ViewSwatch mode={m} />
                    <span className="block text-sm font-medium mt-3">{VIEW_MODE_COPY[m].title}</span>
                    <span className="block text-[11px] text-zinc-500 dark:text-zinc-400 mt-0.5 leading-snug">
                      {VIEW_MODE_COPY[m].blurb}
                    </span>
                  </button>
                ))}
              </div>

              <h2 className="font-semibold mb-1 mt-7">Appearance</h2>
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

          {activeSection === 'Tax Settings' && <TaxRatesSection />}


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
