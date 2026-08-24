/**
 * Phase 9.1 — Ask Ledger.
 *
 * A question box over the engines that were already here. The page holds no
 * arithmetic and no rules: `askDS.answer` interprets the question and computes
 * the answer from the same builders the other screens read, and everything
 * below is presentation.
 *
 * Three things this screen deliberately always shows, because they are what
 * make an AI answer trustworthy rather than merely fluent:
 *
 *   THE FIGURES   The numbers themselves, labelled, beside the sentence — not
 *                 buried inside it.
 *   THE SOURCES   What was counted, and a link to go and look at it. Every
 *                 answer is checkable in two clicks.
 *   THE GAPS      What Ledger doesn't know: no budget set, history that doesn't
 *                 reach back that far, an offset linked to a deleted account, a
 *                 category you don't have. Never filled in with a guess.
 *
 * The prose comes from Ledger by default. When the model rewords it, the
 * rewrite is checked number-by-number against the figures above
 * (`utils/askAnswer.checkPhrasing`) and thrown away if it states anything
 * Ledger didn't compute — so the badge under the answer always tells the truth
 * about who wrote it.
 *
 * Read-only. This screen has no writes at all: asking cannot change a record.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Layout from '../components/layout/Layout';
import { PageHeader } from '../components/design-kit/UI';
import Card from '../components/common/Card';
import Button from '../components/common/Button';
import { useStore } from '../store';
import { useScopeKey } from '../hooks/useScopeKey';
import { askDS } from '../services/dataService';
import { formatCurrency, formatDate } from '../utils/format';
import type { AskAnswer, AskFigure, AskGap, AskSource } from '../utils/askAnswer';

// ── Small pieces ─────────────────────────────────────────────────────────────

const GAP_STYLE: Record<AskGap['kind'], { label: string; badge: string }> = {
  'no-data': { label: 'Nothing recorded', badge: 'bg-zinc-500/15 text-zinc-500' },
  'partial-history': { label: 'Partial history', badge: 'bg-[#f59e0b]/15 text-[#d97706]' },
  unresolved: { label: 'Not found', badge: 'bg-[#f59e0b]/15 text-[#d97706]' },
  'incomplete-record': { label: 'Worth knowing', badge: 'bg-brand/15 text-brand' },
  conflict: { label: 'Needs a look', badge: 'bg-[#ef4444]/15 text-[#ef4444]' },
  unsupported: { label: "Can't answer", badge: 'bg-zinc-500/15 text-zinc-500' },
  scope: { label: 'Scope', badge: 'bg-zinc-500/15 text-zinc-500' },
};

const SOURCE_LABEL: Record<AskSource['kind'], string> = {
  transactions: 'Transactions',
  budget: 'Budgets',
  goal: 'Goals',
  loan: 'Loans',
  forecast: 'Forecast',
  tax: 'Tax',
  bill: 'Bills',
  account: 'Accounts',
  insight: 'Insights',
  property: 'Property',
  income: 'Income',
  'net-worth': 'Net worth',
};

/** Format one figure. The ENGINE owns the number; this owns how it reads. */
function figureText(f: AskFigure, currency: string): string {
  if (typeof f.value === 'string') {
    return f.kind === 'date' ? formatDate(f.value) : f.value;
  }
  switch (f.kind) {
    case 'money': return formatCurrency(f.value, currency);
    case 'percent': return `${Math.round(f.value)}%`;
    case 'months': return `${f.value} month${f.value === 1 ? '' : 's'}`;
    default: return String(f.value);
  }
}

const TONE_CLASS = {
  good: 'text-[#22c55e]',
  bad: 'text-[#ef4444]',
  neutral: 'text-zinc-900 dark:text-zinc-100',
} as const;

function FigureTile({ figure, currency }: { figure: AskFigure; currency: string }) {
  const tone = TONE_CLASS[figure.tone ?? 'neutral'];
  return (
    <div
      className={`rounded-xl border p-3 ${
        figure.emphasis
          ? 'border-brand bg-brand/5 sm:col-span-2'
          : 'border-zinc-200 dark:border-zinc-800'
      }`}
    >
      <div className="text-xs text-zinc-500 dark:text-zinc-400">{figure.label}</div>
      <div className={`${figure.emphasis ? 'text-2xl' : 'text-lg'} font-bold mt-0.5 ${tone}`}>
        {figureText(figure, currency)}
      </div>
      {figure.note && (
        <div className="text-[11px] text-zinc-400 dark:text-zinc-500 mt-0.5">{figure.note}</div>
      )}
    </div>
  );
}

// ── The answer ───────────────────────────────────────────────────────────────

function AnswerCard({
  answer, prose, proseSource, rejected, phrasing, currency,
}: {
  answer: AskAnswer;
  prose: string;
  proseSource: 'ledger' | 'ai';
  rejected?: number[];
  phrasing: boolean;
  currency: string;
}) {
  const navigate = useNavigate();
  const headline = answer.figures.find(f => f.emphasis);
  const rest = answer.figures.filter(f => !f.emphasis);

  return (
    <div className="space-y-4">
      <Card padding="lg">
        <div className="text-sm text-zinc-500 dark:text-zinc-400">{answer.question}</div>
        <p className="mt-2 text-[15px] leading-relaxed text-zinc-900 dark:text-zinc-100">
          {prose}
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] text-zinc-400 dark:text-zinc-500">
          <span className="px-1.5 py-0.5 rounded bg-zinc-500/10">
            {proseSource === 'ai' ? 'Worded by Claude, figures by Ledger' : 'Written by Ledger'}
          </span>
          <span className="px-1.5 py-0.5 rounded bg-zinc-500/10">
            {answer.interpretation === 'ai' ? 'Question read by Claude' : 'Question read by Ledger'}
          </span>
          <span className="px-1.5 py-0.5 rounded bg-zinc-500/10">{answer.scopeLabel}</span>
          {phrasing && <span>Rewording…</span>}
        </div>
        {/* Shown, never swallowed: a rejected rewrite is the guard working, and
            the user is entitled to know the model tried to state a figure that
            isn't in their data. */}
        {rejected && rejected.length > 0 && (
          <div className="mt-2 text-[11px] text-[#d97706]">
            A reworded version was discarded because it stated {rejected.length === 1 ? 'a figure' : 'figures'} Ledger
            never computed. You are reading Ledger's own wording.
          </div>
        )}
      </Card>

      {(headline || rest.length > 0) && (
        <Card>
          <div className="text-xs font-semibold text-zinc-500 dark:text-zinc-400 mb-3">
            The figures
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {headline && <FigureTile figure={headline} currency={currency} />}
            {rest.map(f => <FigureTile key={f.key} figure={f} currency={currency} />)}
          </div>
        </Card>
      )}

      {answer.gaps.length > 0 && (
        <Card>
          <div className="text-xs font-semibold text-zinc-500 dark:text-zinc-400 mb-3">
            What Ledger doesn't know
          </div>
          <div className="space-y-2">
            {answer.gaps.map((gap, i) => {
              const style = GAP_STYLE[gap.kind];
              return (
                <div key={`${gap.kind}:${i}`} className="flex items-start gap-2">
                  <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded shrink-0 mt-0.5 ${style.badge}`}>
                    {style.label}
                  </span>
                  <div className="text-sm text-zinc-600 dark:text-zinc-300">
                    {gap.message}
                    {gap.to && (
                      <button
                        type="button"
                        onClick={() => navigate(gap.to!)}
                        className="ml-1.5 text-brand hover:underline"
                      >
                        Open
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {answer.sources.length > 0 && (
        <Card>
          <div className="text-xs font-semibold text-zinc-500 dark:text-zinc-400 mb-3">
            Where this comes from
          </div>
          <div className="space-y-2">
            {answer.sources.map((s, i) => (
              <div key={`${s.kind}:${i}`} className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm text-zinc-900 dark:text-zinc-100">
                    <span className="text-xs text-zinc-400 dark:text-zinc-500 mr-1.5">
                      {SOURCE_LABEL[s.kind]}
                    </span>
                    {s.label}
                  </div>
                  {s.detail && (
                    <div className="text-[11px] text-zinc-400 dark:text-zinc-500 mt-0.5">{s.detail}</div>
                  )}
                </div>
                {s.to && (
                  <button
                    type="button"
                    onClick={() => navigate(s.to!)}
                    className="text-xs text-brand hover:underline shrink-0"
                  >
                    Open →
                  </button>
                )}
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

interface AskState {
  answer: AskAnswer;
  prose: string;
  proseSource: 'ledger' | 'ai';
  rejected?: number[];
}

export default function Ask() {
  const user = useStore(s => s.user);
  const currency = user?.currency_preference ?? 'AUD';
  const scopeKey = useScopeKey();

  // Subscribed so a question asked after a sync reads the new rows. Ask Ledger
  // computes from the store on demand, so these are what make it live.
  const transactions = useStore(s => s.transactions);
  const goals = useStore(s => s.goals);
  const loans = useStore(s => s.loans);
  const budgets = useStore(s => s.budgets);

  const [question, setQuestion] = useState('');
  const [state, setState] = useState<AskState | null>(null);
  const [asking, setAsking] = useState(false);
  const [phrasing, setPhrasing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  /** Guards against a slow AI response landing on a newer question's answer. */
  const askId = useRef(0);

  const suggestions = useMemo(
    () => askDS.suggestions(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scopeKey, transactions, goals, loans, budgets],
  );

  useEffect(() => { inputRef.current?.focus(); }, []);

  const ask = async (text: string) => {
    const q = text.trim();
    if (!q || asking) return;
    const id = ++askId.current;

    setAsking(true);
    setPhrasing(false);
    setQuestion(q);

    try {
      // 1. Ledger answers FIRST, from its own engines, with its own wording.
      //    This is the answer — everything after it is presentation.
      const rulesIntent = askDS.interpret(q);
      let answer = askDS.answerFor(rulesIntent);
      if (id !== askId.current) return;
      setState({ answer, prose: answer.headline, proseSource: 'ledger' });
      setAsking(false);

      // 2. Ask the model how it reads the question, and rebuild from the
      //    engines on its reading. When it agrees with the rules the answer is
      //    identical — the rebuild is what lets the badge say honestly that the
      //    model read the question rather than implying it was never consulted.
      //    A failed or absent call changes nothing: `interpretWithAI` returns
      //    the rules match, whose source is still 'rules'.
      const aiIntent = await askDS.interpretWithAI(q);
      if (id !== askId.current) return;
      if (aiIntent.source === 'ai') {
        answer = askDS.answerFor(aiIntent);
        setState({ answer, prose: answer.headline, proseSource: 'ledger' });
      }

      // 3. Only now, with every figure already computed, is the model allowed
      //    near the wording — and only through the number check.
      setPhrasing(true);
      const phrased = await askDS.phrase(answer);
      if (id !== askId.current) return;
      setState({
        answer,
        prose: phrased.text,
        proseSource: phrased.source,
        rejected: phrased.rejected,
      });
    } catch (err) {
      console.error('[ask] failed:', err);
      if (id === askId.current) {
        setState({
          answer: askDS.answer(q),
          prose: askDS.answer(q).headline,
          proseSource: 'ledger',
        });
      }
    } finally {
      if (id === askId.current) {
        setAsking(false);
        setPhrasing(false);
      }
    }
  };

  return (
    <Layout>
      <PageHeader
        title="Ask Ledger"
        subtitle="Questions about your own money, answered from your own records."
      />

      <Card padding="lg" className="mb-4">
        <form
          onSubmit={(e) => { e.preventDefault(); void ask(question); }}
          className="flex flex-col sm:flex-row gap-2"
        >
          <input
            ref={inputRef}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="How much did I spend eating out this year?"
            className="flex-1 px-3 py-2.5 rounded-[10px] border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 focus:outline-none focus:border-brand"
          />
          <Button type="submit" disabled={asking || !question.trim()}>
            {asking ? 'Working…' : 'Ask'}
          </Button>
        </form>

        {suggestions.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {suggestions.map(s => (
              <button
                key={s}
                type="button"
                onClick={() => void ask(s)}
                className="text-xs px-2.5 py-1 rounded-full border border-zinc-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-300 hover:border-brand hover:text-brand transition-colors"
              >
                {s}
              </button>
            ))}
          </div>
        )}

        <p className="mt-3 text-[11px] text-zinc-400 dark:text-zinc-500">
          Ask Ledger reads your records and changes nothing. Every figure is computed by
          Ledger's own engines — the same ones behind the Forecast, Budget, Loans and Tax
          screens — so an answer here always agrees with the page it links to.
        </p>
      </Card>

      {state && (
        <AnswerCard
          answer={state.answer}
          prose={state.prose}
          proseSource={state.proseSource}
          rejected={state.rejected}
          phrasing={phrasing}
          currency={currency}
        />
      )}
    </Layout>
  );
}
