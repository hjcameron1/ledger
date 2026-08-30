/**
 * The corporate actions Ledger would not guess at, asked instead of swallowed.
 *
 * A split changes a unit count and a spin-off does not, and the price feed
 * serves both as the same two numbers with no label. Ledger applies the ones
 * that could only be an announcement — "four for one", "one for ten", "six for
 * eleven" — and refuses to invent an answer for the rest. Refusing used to mean
 * dropping the event on the server, which is right for a spin-off and silently
 * wrong for a real consolidation: the price moves by the ratio, the unit count
 * does not follow, and the holding is left at the wrong value with nothing on
 * any screen to say why.
 *
 * This is the "nothing to say why" being fixed. One card, only when there is an
 * unanswered event, on the page where the holding lives. It states what the feed
 * said, what the count would become, and what the holding is worth too much (or
 * too little) by if the answer is yes and nobody acts.
 *
 *   My share count changed  → the units move by the ratio and the parcel book
 *                             records a split, exactly as the automatic path
 *                             would have: cost untouched, acquisition dates
 *                             untouched, the CGT discount untouched.
 *   It didn't               → nothing moves. The entry is marked answered and
 *                             kept, which is what stops the question coming back.
 *
 * Either answer is final and neither is guessed. The entry is never deleted,
 * because its id is what the server matches the event against on the next check.
 */
import { useMemo, useState } from 'react';
import { useStore } from '../../store';
import { investmentsDS } from '../../services/dataService';
import { pendingQuestions, resolveOn, type CorporateActionQuestion } from '../../utils/corporateActionReview';
import Card from './Card';
import Button from './Button';

const pct = (x: number) => `${x >= 0 ? '' : '−'}${Math.abs(x * 100).toFixed(1)}%`;

const units = (n: number) =>
  Number.isInteger(n) ? n.toLocaleString() : parseFloat(n.toFixed(4)).toLocaleString();

export default function CorporateActionReview() {
  const investments = useStore(s => s.investments);
  const user = useStore(s => s.user);
  const [busy, setBusy] = useState<string | null>(null);

  const questions = useMemo(
    () => pendingQuestions(investments, user?.id ?? null),
    [investments, user?.id],
  );
  if (questions.length === 0) return null;

  const answer = (q: CorporateActionQuestion, resolved: 'applied' | 'ignored') => {
    const inv = investments.find(i => i.id === q.investmentId);
    if (!inv || busy) return;
    setBusy(q.action.id);
    try {
      const pending = resolveOn(inv, q.action.id, resolved, new Date().toISOString());
      if (resolved === 'applied') {
        // Units only. The feed re-priced this holding when the action happened,
        // so the price on the row is ALREADY the post-action one — halving it
        // again would take the holding's worth down twice for one event.
        investmentsDS.update(
          q.investmentId,
          { shares_owned: q.unitsIfApplied, pending_corporate_actions: pending },
          { parcelIntent: 'split' },
        );
      } else {
        investmentsDS.update(q.investmentId, { pending_corporate_actions: pending });
      }
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card className="mb-6 border-[#f59e0b]/40">
      <div className="flex items-start gap-2 mb-3">
        <span className="w-1.5 h-1.5 rounded-full bg-[#f59e0b] flex-shrink-0 mt-2" />
        <div>
          <p className="text-sm font-semibold">
            {questions.length === 1 ? 'A corporate action needs your answer' : `${questions.length} corporate actions need your answer`}
          </p>
          <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
            The price feed reported these but did not say whether they changed the number of
            shares. Ledger has not touched your unit count either way.
          </p>
        </div>
      </div>

      <div className="space-y-2">
        {questions.map(q => (
          <div key={q.action.id} className="rounded-[8px] border border-zinc-200 dark:border-zinc-800 px-3 py-3">
            <div className="flex items-center gap-1.5 flex-wrap mb-1">
              <span className="font-medium text-sm">{q.ticker || q.label}</span>
              {q.ticker && q.ticker !== q.label && (
                <span className="text-xs text-zinc-500 dark:text-zinc-400 truncate max-w-[180px]">{q.label}</span>
              )}
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#f59e0b]/10 text-[#f59e0b] font-medium">
                {q.terms}
              </span>
              <span className="text-xs text-zinc-500 dark:text-zinc-400">on {q.action.date}</span>
            </div>

            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              If your broker changed the count, {units(q.unitsNow)} units became{' '}
              <span className="font-medium text-[#333] dark:text-[#ccc]">{units(q.unitsIfApplied)}</span>
              {' '}— and until that is recorded this holding reads {pct(q.overstatement)}{' '}
              {q.overstatement >= 0 ? 'too high' : 'too low'}. If it was a spin-off or a
              capital return, the count did not move and nothing needs doing.
            </p>

            <div className="flex gap-2 mt-3">
              <Button
                size="sm"
                onClick={() => answer(q, 'applied')}
                loading={busy === q.action.id}
                disabled={busy !== null}
              >
                My share count changed
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => answer(q, 'ignored')}
                disabled={busy !== null}
              >
                It didn&apos;t
              </Button>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
