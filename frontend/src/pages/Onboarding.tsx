import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useStore } from '../store';
import { settingsApi } from '../services/api';
import Button from '../components/common/Button';
import { Toggle } from '../components/common/Input';

const CURRENCIES = [
  { code: 'AUD', name: 'Australian Dollar' }, { code: 'USD', name: 'US Dollar' },
  { code: 'GBP', name: 'British Pound' }, { code: 'EUR', name: 'Euro' },
  { code: 'NZD', name: 'New Zealand Dollar' }, { code: 'SGD', name: 'Singapore Dollar' },
  { code: 'CAD', name: 'Canadian Dollar' }, { code: 'JPY', name: 'Japanese Yen' },
  { code: 'HKD', name: 'Hong Kong Dollar' }, { code: 'CHF', name: 'Swiss Franc' },
];

const steps = ['welcome', 'currency', 'theme', 'account', 'done'] as const;
type Step = typeof steps[number];

export default function Onboarding() {
  const [step, setStep] = useState<Step>('welcome');
  const [currency, setCurrency] = useState('AUD');
  const [currencySearch, setCurrencySearch] = useState('');
  const [theme, setThemeLocal] = useState<'light' | 'dark'>('light');
  const { setTheme, user, setAuth, token } = useStore();
  const navigate = useNavigate();

  const stepIndex = steps.indexOf(step);
  const progress = ((stepIndex) / (steps.length - 1)) * 100;

  const filteredCurrencies = CURRENCIES.filter(c =>
    c.code.toLowerCase().includes(currencySearch.toLowerCase()) ||
    c.name.toLowerCase().includes(currencySearch.toLowerCase())
  );

  const handleFinish = async () => {
    try {
      const updated = await settingsApi.updateProfile({
        currency_preference: currency,
        theme,
        onboarding_complete: true,
      });
      if (user && token) {
        setAuth({ ...user, ...updated }, token);
      }
      setTheme(theme);
    } catch { /* continue */ }
    navigate('/');
  };

  const next = () => {
    const idx = steps.indexOf(step);
    if (idx < steps.length - 1) setStep(steps[idx + 1]);
  };

  const back = () => {
    const idx = steps.indexOf(step);
    if (idx > 0) setStep(steps[idx - 1]);
  };

  return (
    <div className="min-h-screen bg-white dark:bg-[#0f0f0f] flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-md">
        {/* Logo */}
        <div className="text-center mb-8">
          <h1 className="text-[#3b7dd8] font-semibold text-2xl tracking-wide">Ledger</h1>
        </div>

        {/* Progress */}
        <div className="mb-8">
          <div className="h-1 bg-[#e5e5e5] dark:bg-[#2a2a2a] rounded-full overflow-hidden">
            <div
              className="h-full bg-[#3b7dd8] rounded-full transition-all duration-500"
              style={{ width: `${progress}%` }}
            />
          </div>
          <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0] mt-2 text-right">
            Step {stepIndex + 1} of {steps.length}
          </p>
        </div>

        <div className="card p-6 min-h-[320px] flex flex-col">
          {step === 'welcome' && (
            <div className="flex flex-col items-center justify-center flex-1 text-center gap-6">
              <div className="w-16 h-16 rounded-full bg-[#3b7dd8]/10 flex items-center justify-center">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#3b7dd8" strokeWidth="1.8">
                  <line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>
                </svg>
              </div>
              <div>
                <h2 className="text-2xl font-semibold mb-2">
                  Welcome{user?.name ? `, ${user.name.split(' ')[0]}` : ''}
                </h2>
                <p className="text-[#6b6b6b] dark:text-[#a0a0a0] text-sm leading-relaxed">
                  Let's set up your Ledger. It only takes a minute.
                </p>
              </div>
              <Button variant="primary" size="lg" onClick={next} fullWidth>
                Get started
              </Button>
            </div>
          )}

          {step === 'currency' && (
            <div className="flex flex-col flex-1 gap-4">
              <div>
                <h2 className="text-xl font-semibold mb-1">Display currency</h2>
                <p className="text-sm text-[#6b6b6b] dark:text-[#a0a0a0]">All amounts will be shown in this currency.</p>
              </div>
              <input
                className="input"
                placeholder="Search currencies..."
                value={currencySearch}
                onChange={e => setCurrencySearch(e.target.value)}
              />
              <div className="flex-1 overflow-y-auto space-y-1 max-h-48">
                {filteredCurrencies.map(c => (
                  <button
                    key={c.code}
                    onClick={() => setCurrency(c.code)}
                    className={`w-full flex items-center justify-between px-3 py-2.5 rounded-[8px] text-sm transition-colors
                      ${currency === c.code
                        ? 'bg-[#3b7dd8]/10 text-[#3b7dd8] font-medium'
                        : 'hover:bg-[#f5f5f5] dark:hover:bg-[#2a2a2a]'
                      }`}
                  >
                    <span>{c.name}</span>
                    <span className="font-mono text-xs opacity-60">{c.code}</span>
                  </button>
                ))}
              </div>
              <div className="flex gap-3 pt-2">
                <Button variant="secondary" onClick={back}>Back</Button>
                <Button variant="primary" onClick={next} fullWidth>Continue</Button>
              </div>
            </div>
          )}

          {step === 'theme' && (
            <div className="flex flex-col flex-1 gap-6">
              <div>
                <h2 className="text-xl font-semibold mb-1">Choose your theme</h2>
                <p className="text-sm text-[#6b6b6b] dark:text-[#a0a0a0]">You can change this anytime in Settings.</p>
              </div>
              <div className="grid grid-cols-2 gap-3 flex-1">
                {(['light', 'dark'] as const).map(t => (
                  <button
                    key={t}
                    onClick={() => setThemeLocal(t)}
                    className={`rounded-[12px] border-2 p-4 flex flex-col items-center gap-3 transition-all
                      ${theme === t
                        ? 'border-[#3b7dd8] bg-[#3b7dd8]/5'
                        : 'border-[#e5e5e5] dark:border-[#2a2a2a] hover:border-[#3b7dd8]/40'
                      }`}
                  >
                    <div className={`w-16 h-10 rounded-[6px] border ${t === 'light' ? 'bg-white border-[#e5e5e5]' : 'bg-[#1a1a1a] border-[#2a2a2a]'} flex items-end pb-1.5 px-2 gap-1`}>
                      <div className={`h-1.5 rounded-full flex-1 ${t === 'light' ? 'bg-[#e5e5e5]' : 'bg-[#2a2a2a]'}`}/>
                      <div className={`h-1.5 rounded-full w-1/2 ${t === 'light' ? 'bg-[#3b7dd8]/40' : 'bg-[#3b7dd8]/60'}`}/>
                    </div>
                    <span className="text-sm font-medium capitalize">{t}</span>
                  </button>
                ))}
              </div>
              <div className="flex gap-3">
                <Button variant="secondary" onClick={back}>Back</Button>
                <Button variant="primary" onClick={() => { setTheme(theme); next(); }} fullWidth>Continue</Button>
              </div>
            </div>
          )}

          {step === 'account' && (
            <div className="flex flex-col flex-1 gap-6">
              <div>
                <h2 className="text-xl font-semibold mb-1">Add your first account</h2>
                <p className="text-sm text-[#6b6b6b] dark:text-[#a0a0a0]">You can always add more later.</p>
              </div>
              <div className="flex-1 space-y-2">
                <button
                  className="w-full flex items-center gap-4 p-4 rounded-[12px] border border-[#e5e5e5] dark:border-[#2a2a2a] hover:border-[#3b7dd8]/40 hover:bg-[#3b7dd8]/5 transition-all text-left"
                  onClick={() => { next(); }}
                >
                  <div className="w-10 h-10 rounded-full bg-[#3b7dd8]/10 flex items-center justify-center">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#3b7dd8" strokeWidth="1.8">
                      <rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/>
                    </svg>
                  </div>
                  <div>
                    <div className="font-medium text-sm">Bank Account</div>
                    <div className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">Manual entry or upload a statement</div>
                  </div>
                </button>
                <button
                  className="w-full flex items-center gap-4 p-4 rounded-[12px] border border-[#e5e5e5] dark:border-[#2a2a2a] hover:border-[#3b7dd8]/40 hover:bg-[#3b7dd8]/5 transition-all text-left"
                  onClick={() => { next(); }}
                >
                  <div className="w-10 h-10 rounded-full bg-[#22c55e]/10 flex items-center justify-center">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="1.8">
                      <polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/>
                    </svg>
                  </div>
                  <div>
                    <div className="font-medium text-sm">Investment</div>
                    <div className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">Add a stock, ETF, crypto or other asset</div>
                  </div>
                </button>
              </div>
              <div className="flex gap-3">
                <Button variant="secondary" onClick={back}>Back</Button>
                <Button variant="ghost" onClick={next} className="text-[#6b6b6b] dark:text-[#a0a0a0]">Skip for now</Button>
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
                <p className="text-[#6b6b6b] dark:text-[#a0a0a0] text-sm">
                  Your Ledger is ready. Let's see your overview.
                </p>
              </div>
              <Button variant="primary" size="lg" onClick={handleFinish} fullWidth>
                Go to Overview
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
