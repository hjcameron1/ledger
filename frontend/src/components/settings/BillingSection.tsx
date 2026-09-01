/**
 * Plan & Billing.
 *
 * The upgrade path is not built yet. That is stated once, plainly, and the
 * button that would start it is disabled — a live-looking button whose only
 * outcome is nothing is worse than no button, because the reader concludes the
 * payment failed rather than that it was never wired up.
 */
import { useStore } from '../../store';
import Card from '../common/Card';
import Button from '../common/Button';

const PREMIUM_FEATURES = [
  'Unlimited accounts & investments',
  'Basiq bank sync',
  'Telegram bot',
  'Tax & income tracking',
  'Document AI parsing',
  'Goals & budgeting',
  'Shared account access',
];

export default function BillingSection() {
  const { user } = useStore();
  const premium = user?.plan === 'premium';

  return (
    <Card>
      <h2 className="font-semibold mb-4">Your plan</h2>

      <div className="mb-6">
        <div className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-sm font-medium
          ${premium
            ? 'bg-brand/10 text-brand'
            : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400'}`}>
          {premium ? '★ Premium' : 'Free Plan'}
        </div>
        {premium && (
          <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-3">
            Everything below is switched on for this account.
          </p>
        )}
      </div>

      {!premium && (
        <div className="border border-brand/20 rounded-[12px] p-4 bg-brand/5">
          <h3 className="font-semibold mb-2">Upgrade to Premium</h3>
          <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-3">$29.99 AUD/month</p>
          <ul className="text-sm space-y-1 mb-4">
            {PREMIUM_FEATURES.map(f => (
              <li key={f} className="flex items-center gap-2">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="2.5">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
                {f}
              </li>
            ))}
          </ul>
          <Button variant="primary" fullWidth disabled>
            Upgrade — not available yet
          </Button>
          <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-2 text-center">
            Card payments aren't connected to this account yet, so there is nothing behind
            this button. Everything in Ledger is available to you in the meantime.
          </p>
        </div>
      )}
    </Card>
  );
}
