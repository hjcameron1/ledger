/**
 * First-run onboarding — the short path from a freshly verified account to an
 * Overview with real data on it.
 *
 *   welcome → profile (name · currency · view) → first account → done
 *
 * Nothing here is onboarding-specific infrastructure: the profile step writes
 * through the normal PUT /settings/profile, the account step is the SAME
 * AddAccountModal the Accounts page mounts and the SAME basiqDS connect/sync
 * path behind "Connect live bank". Progress persists per-account in
 * ui_preferences.onboarding, so a refresh, re-login or second device resumes
 * where the user left off. Demo sessions never come here (guarded below —
 * their fake user is minted with onboarding_complete: true anyway).
 */
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useStore } from '../store';
import { settingsApi } from '../services/api';
import { accountsDS, transactionsDS, basiqDS } from '../services/dataService';
import { loadOnboarding, patchOnboarding, WIZARD_STEPS, type WizardStep } from '../services/onboarding';
import { isDemoSession } from '../config/demo';
import { VIEW_MODES, VIEW_MODE_COPY } from '../utils/appearance';
import Button from '../components/common/Button';
import Input from '../components/common/Input';
import AddAccountModal from '../components/accounts/AddAccountModal';

const CURRENCIES = [
  { code: 'AUD', name: 'Australian Dollar' }, { code: 'USD', name: 'US Dollar' },
  { code: 'GBP', name: 'British Pound' }, { code: 'EUR', name: 'Euro' },
  { code: 'NZD', name: 'New Zealand Dollar' }, { code: 'SGD', name: 'Singapore Dollar' },
  { code: 'CAD', name: 'Canadian Dollar' }, { code: 'JPY', name: 'Japanese Yen' },
  { code: 'HKD', name: 'Hong Kong Dollar' }, { code: 'CHF', name: 'Swiss Franc' },
];

/** What Ledger is, in three lines — the welcome screen's whole pitch. */
const WELCOME_POINTS = [
  { title: 'Everything in one place', body: 'Accounts, spending, investments, super, property — one net worth.' },
  { title: 'It keeps watch for you', body: 'Bills coming up, budgets drifting, anything unusual — surfaced, not hunted for.' },
  { title: 'Ask it anything', body: 'Plain-English questions and what-ifs about your own money.' },
];

export default function Onboarding() {
  const {
    user, token, setAuth, viewMode, setViewMode,
    accounts, transactions, investments, setAccounts, setTransactions, setBasiqUserId,
  } = useStore();
  const navigate = useNavigate();

  const [step, setStep] = useState<WizardStep>('welcome');
  const [resumed, setResumed] = useState(false);

  // profile step
  const [name, setName] = useState(user?.name ?? '');
  const [currency, setCurrency] = useState(user?.currency_preference ?? 'AUD');
  const [currencyOpen, setCurrencyOpen] = useState(false);
  const [savingProfile, setSavingProfile] = useState(false);

  // account step
  const [manualOpen, setManualOpen] = useState(false);
  const [basiqOpen, setBasiqOpen] = useState(false);
  const [basiqMobile, setBasiqMobile] = useState('');
  const [basiqBusy, setBasiqBusy] = useState(false);
  const [basiqLinkOpened, setBasiqLinkOpened] = useState(false);
  const [basiqError, setBasiqError] = useState('');
  const [accountAdded, setAccountAdded] = useState<string>('');

  // done step
  const [finishing, setFinishing] = useState(false);

  const demo = isDemoSession(token);

  // ── Guards ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!user || !token) { navigate('/login', { replace: true }); return; }
    if (demo || user.onboarding_complete) { navigate('/', { replace: true }); }
  }, [user, token, demo, navigate]);

  // Self-heal: never trap a RETURNING user in onboarding. Judged once, from the
  // data present when the page mounted — an account added DURING the wizard
  // must not teleport the user out of it mid-flow.
  const hadDataAtMount = useRef(
    accounts.length > 0 || transactions.length > 0 || investments.length > 0,
  );
  useEffect(() => {
    if (!hadDataAtMount.current || !user || !token || demo) return;
    (async () => {
      try {
        const updated = await settingsApi.updateProfile({ onboarding_complete: true });
        setAuth({ ...user, ...updated }, token);
      } catch { /* even if the write fails, don't keep them stuck here */ }
      navigate('/', { replace: true });
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Resume from persisted progress ─────────────────────────────────────────
  useEffect(() => {
    if (demo || !user || !token) { setResumed(true); return; }
    let cancelled = false;
    loadOnboarding().then(ob => {
      if (cancelled) return;
      if (ob.step && WIZARD_STEPS.includes(ob.step) && ob.step !== 'done') setStep(ob.step);
      setResumed(true);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const goTo = (next: WizardStep) => {
    setStep(next);
    if (!demo) void patchOnboarding({ step: next });
  };

  // ── Step actions ───────────────────────────────────────────────────────────

  const saveProfile = async () => {
    setSavingProfile(true);
    try {
      const updated = await settingsApi.updateProfile({
        name: name.trim() || user?.name,
        currency_preference: currency,
      });
      if (user && token) setAuth({ ...user, ...updated }, token);
    } catch { /* offline — local choices still apply, next save carries them */ }
    setSavingProfile(false);
    goTo('account');
  };

  /** Same connect path as Accounts' "Connect live bank" — basiqDS end to end. */
  const connectBasiq = async () => {
    const mobile = basiqMobile.trim().replace(/^0/, '+61');
    if (!mobile || !/^\+\d{10,15}$/.test(mobile)) {
      setBasiqError('Please enter a valid mobile number (e.g. 0412 345 678)');
      return;
    }
    setBasiqBusy(true);
    setBasiqError('');
    try {
      const { basiqUserId: uid, authLink } = await basiqDS.connect(user?.email ?? '', mobile);
      setBasiqUserId(uid);
      window.open(authLink, '_blank', 'noopener,noreferrer');
      setBasiqLinkOpened(true);
    } catch (err) {
      setBasiqError(err instanceof Error ? err.message : 'Connection failed');
    } finally {
      setBasiqBusy(false);
    }
  };

  const syncBasiq = async () => {
    setBasiqBusy(true);
    setBasiqError('');
    try {
      const result = await basiqDS.syncAll();
      if (result.status === 'ok') {
        basiqDS.startAutoSync();
        setAccountAdded('Bank connected — your accounts and transactions are syncing.');
        goTo('done');
      } else {
        setBasiqError(result.status === 'error' ? result.text
          : 'Bank not connected yet — finish the consent page in the other tab, then try again.');
      }
    } finally {
      setBasiqBusy(false);
    }
  };

  if (!user || !token || demo) return null;

  const stepIndex = WIZARD_STEPS.indexOf(step);
  const progress = (stepIndex / (WIZARD_STEPS.length - 1)) * 100;
  const currencyLabel = CURRENCIES.find(c => c.code === currency)?.name ?? currency;

  return (
    <div className="min-h-screen bg-white dark:bg-zinc-900 flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-md">
        {/* Logo */}
        <div className="text-center mb-8">
          <h1 className="text-brand font-semibold text-2xl tracking-wide">Ledger</h1>
        </div>

        {/* Progress */}
        <div className="mb-8">
          <div className="h-1 bg-zinc-200 dark:bg-zinc-800 rounded-full overflow-hidden">
            <div
              className="h-full bg-brand rounded-full transition-all duration-500"
              style={{ width: `${progress}%` }}
            />
          </div>
          <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-2 text-right">
            Step {stepIndex + 1} of {WIZARD_STEPS.length}
          </p>
        </div>

        <div className="card p-6 min-h-[360px] flex flex-col">
          {!resumed ? (
            <div className="flex-1 flex items-center justify-center text-sm text-zinc-500 dark:text-zinc-400">
              Loading…
            </div>
          ) : (
          <>
          {step === 'welcome' && (
            <div className="flex flex-col flex-1 gap-6">
              <div className="text-center">
                <div className="w-16 h-16 rounded-full bg-brand/10 flex items-center justify-center mx-auto mb-4">
                  <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#3b7dd8" strokeWidth="1.8">
                    <line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>
                  </svg>
                </div>
                <h2 className="text-2xl font-semibold">
                  Welcome{user.name ? `, ${user.name.split(' ')[0]}` : ''}
                </h2>
                <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-1">
                  Ledger is your whole financial life, on one screen.
                </p>
              </div>
              <div className="flex-1 space-y-4">
                {WELCOME_POINTS.map(p => (
                  <div key={p.title} className="flex gap-3">
                    <span className="w-1.5 h-1.5 rounded-full bg-brand mt-2 shrink-0" />
                    <div>
                      <p className="text-sm font-medium">{p.title}</p>
                      <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">{p.body}</p>
                    </div>
                  </div>
                ))}
              </div>
              <Button variant="primary" size="lg" onClick={() => goTo('profile')} fullWidth>
                Get started
              </Button>
            </div>
          )}

          {step === 'profile' && (
            <div className="flex flex-col flex-1 gap-5">
              <div>
                <h2 className="text-xl font-semibold mb-1">Make it yours</h2>
                <p className="text-sm text-zinc-500 dark:text-zinc-400">All of this can be changed later in Settings.</p>
              </div>

              <Input
                label="Your name"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="Harry"
                autoComplete="name"
              />

              <div>
                <label className="label">Display currency</label>
                <button
                  onClick={() => setCurrencyOpen(o => !o)}
                  className="input w-full flex items-center justify-between text-left"
                >
                  <span>{currencyLabel}</span>
                  <span className="font-mono text-xs opacity-60">{currency}</span>
                </button>
                {currencyOpen && (
                  <div className="mt-1 border border-zinc-200 dark:border-zinc-800 rounded-[8px] max-h-40 overflow-y-auto">
                    {CURRENCIES.map(c => (
                      <button
                        key={c.code}
                        onClick={() => { setCurrency(c.code); setCurrencyOpen(false); }}
                        className={`w-full flex items-center justify-between px-3 py-2 text-sm transition-colors ${
                          currency === c.code
                            ? 'bg-brand/10 text-brand font-medium'
                            : 'hover:bg-zinc-100 dark:hover:bg-zinc-800'
                        }`}
                      >
                        <span>{c.name}</span>
                        <span className="font-mono text-xs opacity-60">{c.code}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div>
                <label className="label">How should Ledger feel?</label>
                <div className="grid grid-cols-2 gap-2">
                  {VIEW_MODES.map(m => (
                    <button
                      key={m}
                      onClick={() => setViewMode(m)}
                      className={`rounded-[10px] border-2 p-3 text-left transition-all ${
                        viewMode === m
                          ? 'border-brand bg-brand/5'
                          : 'border-zinc-200 dark:border-zinc-800 hover:border-brand/40'
                      }`}
                    >
                      <span className="block text-sm font-medium">{VIEW_MODE_COPY[m].title}</span>
                      <span className="block text-[11px] text-zinc-500 dark:text-zinc-400 mt-0.5 leading-snug">
                        {VIEW_MODE_COPY[m].blurb}
                      </span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex gap-3 mt-auto pt-2">
                <Button variant="secondary" onClick={() => goTo('welcome')}>Back</Button>
                <Button variant="primary" onClick={saveProfile} loading={savingProfile} fullWidth>
                  Continue
                </Button>
              </div>
            </div>
          )}

          {step === 'account' && (
            <div className="flex flex-col flex-1 gap-5">
              <div>
                <h2 className="text-xl font-semibold mb-1">Add your first account</h2>
                <p className="text-sm text-zinc-500 dark:text-zinc-400">
                  Your Overview comes alive once there's real money on it. You can always add more later.
                </p>
              </div>

              {basiqError && (
                <div className="px-3 py-2 rounded-[8px] text-xs bg-[#ef4444]/10 text-[#ef4444]">{basiqError}</div>
              )}

              {!basiqOpen ? (
                <div className="flex-1 space-y-2">
                  <button
                    className="w-full flex items-center gap-4 p-4 rounded-[12px] border border-zinc-200 dark:border-zinc-800 hover:border-brand/40 hover:bg-brand/5 transition-all text-left"
                    onClick={() => { setBasiqOpen(true); setBasiqError(''); }}
                  >
                    <div className="w-10 h-10 rounded-full bg-brand/10 flex items-center justify-center shrink-0">
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#3b7dd8" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
                        <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
                      </svg>
                    </div>
                    <div>
                      <div className="font-medium text-sm">Connect your bank</div>
                      <div className="text-xs text-zinc-500 dark:text-zinc-400">Live balances and transactions via Basiq Open Banking — read-only.</div>
                    </div>
                  </button>
                  <button
                    className="w-full flex items-center gap-4 p-4 rounded-[12px] border border-zinc-200 dark:border-zinc-800 hover:border-brand/40 hover:bg-brand/5 transition-all text-left"
                    onClick={() => setManualOpen(true)}
                  >
                    <div className="w-10 h-10 rounded-full bg-[#22c55e]/10 flex items-center justify-center shrink-0">
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="1.8">
                        <rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/>
                      </svg>
                    </div>
                    <div>
                      <div className="font-medium text-sm">Add an account manually</div>
                      <div className="text-xs text-zinc-500 dark:text-zinc-400">Type it in, or upload a statement to auto-fill.</div>
                    </div>
                  </button>
                </div>
              ) : (
                <div className="flex-1 space-y-4">
                  {!basiqLinkOpened ? (
                    <>
                      <Input
                        label="Mobile number"
                        value={basiqMobile}
                        onChange={e => setBasiqMobile(e.target.value)}
                        placeholder="0412 345 678"
                        type="tel"
                        hint="Used by Basiq to verify your identity during the bank consent flow. Australian mobiles only."
                      />
                      <div className="flex gap-3">
                        <Button variant="secondary" onClick={() => { setBasiqOpen(false); setBasiqError(''); }}>Back</Button>
                        <Button variant="primary" onClick={connectBasiq} loading={basiqBusy} fullWidth>
                          Connect bank →
                        </Button>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="px-3 py-2.5 rounded-[8px] text-xs bg-brand/10 text-brand leading-relaxed">
                        Your bank's consent page opened in a new tab. Authorise read-only access there,
                        then come back and sync.
                      </div>
                      <Button variant="primary" onClick={syncBasiq} loading={basiqBusy} fullWidth>
                        I've connected — sync my accounts
                      </Button>
                      <button
                        onClick={() => { setBasiqLinkOpened(false); setBasiqError(''); }}
                        className="w-full text-xs text-brand hover:underline"
                      >
                        Re-open the connect step
                      </button>
                    </>
                  )}
                </div>
              )}

              <div className="flex gap-3">
                {!basiqOpen && <Button variant="secondary" onClick={() => goTo('profile')}>Back</Button>}
                <Button variant="ghost" onClick={() => goTo('done')} fullWidth className="text-zinc-500 dark:text-zinc-400">
                  Skip for now
                </Button>
              </div>
            </div>
          )}

          {step === 'done' && (
            <div className="flex flex-col items-center justify-center flex-1 text-center gap-6">
              <div className="w-16 h-16 rounded-full bg-[#22c55e]/10 flex items-center justify-center">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12"/>
                </svg>
              </div>
              <div>
                <h2 className="text-2xl font-semibold mb-2">You're all set</h2>
                <p className="text-zinc-500 dark:text-zinc-400 text-sm leading-relaxed">
                  {accountAdded || 'Your Ledger is ready.'}
                  <br />
                  A short checklist on your Overview covers the optional extras — goals,
                  investments, super, insurance — whenever you want them.
                </p>
              </div>
              <Button
                variant="primary"
                size="lg"
                fullWidth
                loading={finishing}
                onClick={async () => {
                  setFinishing(true);
                  try {
                    const updated = await settingsApi.updateProfile({ onboarding_complete: true });
                    // Arm the in-app walkthrough hints + setup checklist for this
                    // account, and clear the resume point — the wizard is over.
                    await patchOnboarding({ guidance: true, step: undefined });
                    setAuth({ ...user, ...updated }, token);
                  } catch { /* still let them in — the self-heal covers the flag */ }
                  setFinishing(false);
                  navigate('/', { replace: true });
                }}
              >
                Go to your Overview
              </Button>
            </div>
          )}
          </>
          )}
        </div>
      </div>

      {/* The real add-account form — the same component Accounts mounts. */}
      <AddAccountModal
        isOpen={manualOpen}
        onClose={() => setManualOpen(false)}
        onSave={(formData, doAdd) => {
          // Same duplicate guard as the Accounts page: import into an existing
          // match rather than minting a second copy of the account.
          const dup = accounts.find(a =>
            (formData.bsb && formData.account_number && a.bsb === formData.bsb && a.account_number === formData.account_number) ||
            (a.name.toLowerCase() === formData.name.toLowerCase() && a.institution.toLowerCase() === formData.institution.toLowerCase())
          );
          doAdd(dup);
          setManualOpen(false);
          setAccounts(accountsDS.getVisible());
          setTransactions(transactionsDS.getVisible());
          setAccountAdded(`${formData.name} added — it's on your Overview now.`);
          goTo('done');
        }}
      />
    </div>
  );
}
