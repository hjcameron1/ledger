import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Layout from '../components/layout/Layout';
import { useStore } from '../store';
import { settingsApi } from '../services/api';
import Card from '../components/common/Card';
import Button from '../components/common/Button';
import Input, { Select, Toggle } from '../components/common/Input';
import Modal from '../components/common/Modal';

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
      // 1. Verify token with Telegram (unauthenticated endpoint)
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
      setTgStatus('saved');
    } catch (err) {
      setTgStatus('error');
      setTgError('Could not connect to Telegram. Check your internet connection.');
    }
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
