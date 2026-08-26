/**
 * A one-line contextual walkthrough prompt shown at the top of a page the
 * first time a NEW user lands on it. Armed only when first-run onboarding
 * finished (`onboarding.guidance` in ui_preferences) — pre-existing users and
 * demo sessions never see one. Dismissing persists to the account, so a hint
 * read on the phone stays read on the laptop.
 */
import { useEffect, useState } from 'react';
import { loadOnboarding, dismissHint, type HintKey } from '../../services/onboarding';

const HINT_COPY: Record<HintKey, { title: string; body: string }> = {
  overview: {
    title: 'This is your Overview',
    body: 'Net worth up top, then bills, budgets and anything needing your attention. Tap Customise to choose which cards you see.',
  },
  transactions: {
    title: 'Your transactions land here',
    body: 'Each one is auto-categorised — tap a transaction to fix its category, and Ledger learns the correction for next time.',
  },
  forecast: {
    title: 'Where your balance is heading',
    body: 'Forecast projects your bank cash 30–90 days ahead from your bills, income and spending patterns.',
  },
  ask: {
    title: 'Ask anything about your money',
    body: 'Plain-English questions and what-ifs — "can I afford a $400 flight?", "what if rent goes up $50?".',
  },
};

export default function PageHint({ hint }: { hint: HintKey }) {
  const [show, setShow] = useState(false);

  useEffect(() => {
    let cancelled = false;
    loadOnboarding().then(ob => {
      if (cancelled) return;
      setShow(ob.guidance === true && !(ob.dismissedHints ?? []).includes(hint));
    });
    return () => { cancelled = true; };
  }, [hint]);

  if (!show) return null;
  const copy = HINT_COPY[hint];

  return (
    <div className="mb-4 flex items-start gap-3 px-4 py-3 rounded-[12px] bg-brand/[0.07] border border-brand/20">
      <div className="w-7 h-7 rounded-full bg-brand/15 flex items-center justify-center shrink-0 mt-0.5">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#3b7dd8" strokeWidth="2" strokeLinecap="round">
          <circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>
        </svg>
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium">{copy.title}</p>
        <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5 leading-relaxed">{copy.body}</p>
      </div>
      <button
        onClick={() => { setShow(false); void dismissHint(hint); }}
        className="text-xs font-medium text-brand hover:underline shrink-0 mt-0.5"
      >
        Got it
      </button>
    </div>
  );
}
