/**
 * Phase 9.1 — Ask Ledger.
 *
 * A question box over the engines that were already here. The page holds no
 * arithmetic and no rules: `askDS.answer` interprets the question and computes
 * the answer from the same builders the other screens read, and everything
 * below is presentation.
 *
 * The answer LEADS with the few facts that decide the question — a short plain
 * sentence and at most four figures — because an answer nobody can take in is
 * not an answer. Nothing is dropped to get there: the full breakdown, how a
 * hypothetical was read, the advisory notes and every source live under "See
 * calculation", one tap away, so the answer stays checkable in two clicks.
 * Gaps that change what the answer MEANS — nothing recorded, a name that
 * matched nothing, history that doesn't reach — stay with the answer itself;
 * hiding those would make the headline a lie.
 *
 * The prose comes from Ledger by default. When the model rewords it, the
 * rewrite is checked number-by-number against the figures above
 * (`utils/askAnswer.checkPhrasing`) and thrown away if it states anything
 * Ledger didn't compute. That check is invisible on purpose: whether Ledger or
 * a model chose the words changes nothing about whether the answer is right,
 * so the page shows the answer and not the machinery behind it.
 *
 * Phase 9.3 folded WHAT-IF questions in here too. "What happens if I pay $1,000
 * off my car loan?" is answered the same way as everything else — by the
 * engines, from the user's own records — except that they run twice: once as
 * things are, once as the question describes them. Asking still writes nothing.
 * The only write on this screen is the Apply panel below an answered
 * hypothetical: per change, described before it happens, and confirmed twice.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Layout from '../components/layout/Layout';
import PageHint from '../components/onboarding/PageHint';
import { PageHeader } from '../components/design-kit/UI';
import Card from '../components/common/Card';
import Button from '../components/common/Button';
import { useStore } from '../store';
import { useScopeKey } from '../hooks/useScopeKey';
import { askDS } from '../services/dataService';
import { formatCurrency, formatDate } from '../utils/format';
import { splitFigures, splitGaps, thinkingMessage } from '../utils/askAnswer';
import type { AskIntent } from '../utils/askIntent';
import type { AskAnswer, AskFigure, AskGap, AskSource } from '../utils/askAnswer';
import { SCENARIO_KIND_LABELS, type Scenario, type ScenarioChange } from '../utils/scenario';

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
  insurance: 'Insurance',
  document: 'Documents',
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

// ── A hypothetical ───────────────────────────────────────────────────────────

/** How Ledger read the question, in full. An unseen assumption is uncorrectable. */
function ReadingCard({ lines }: { lines: string[] }) {
  if (lines.length === 0) return null;
  return (
    <Card>
      <div className="text-xs font-semibold text-zinc-500 dark:text-zinc-400 mb-2">
        How Ledger read this
      </div>
      <ul className="space-y-1.5">
        {lines.map((line, i) => (
          <li key={i} className="text-sm text-zinc-600 dark:text-zinc-300 flex gap-2">
            <span className="text-zinc-300 dark:text-zinc-600">·</span>
            <span>{line}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/**
 * Turning the answer into records.
 *
 * Three rules, all visible on the panel itself: only changes Ledger can
 * honestly write are offered; every one says what it would write BEFORE it is
 * written; and the button has to be pressed twice. Changes with no record to
 * write are listed too, with the reason — a decision to spend less is a
 * decision, and saying so beats inventing a transaction for it.
 */
function ApplyCard({
  answer, scenario, onApplied,
}: {
  answer: AskAnswer;
  scenario: Scenario;
  onApplied: () => void;
}) {
  const facts = answer.facts;
  const applicability = facts.kind === 'what-if' ? facts.applicability : [];
  const canApply = applicability.filter(a => a.canApply);
  const blocked = applicability.filter(a => !a.canApply);

  const [selected, setSelected] = useState<Set<string>>(() => new Set(canApply.map(a => a.changeId)));
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<{
    applied: { changeId: string; description: string }[];
    skipped: { changeId: string; reason: string }[];
  } | null>(null);

  const labelOf = (changeId: string): string => {
    const change: ScenarioChange | undefined = scenario.changes.find(c => c.id === changeId);
    if (!change) return 'this change';
    return (change.label ?? '').trim() || SCENARIO_KIND_LABELS[change.kind];
  };

  if (canApply.length === 0 && blocked.length === 0) return null;

  if (result) {
    return (
      <Card>
        <div className="text-xs font-semibold text-zinc-500 dark:text-zinc-400 mb-2">
          Written to Ledger
        </div>
        {result.applied.length === 0 && (
          <div className="text-sm text-zinc-600 dark:text-zinc-300">Nothing was written.</div>
        )}
        <ul className="space-y-1.5">
          {result.applied.map(a => (
            <li key={a.changeId} className="text-sm text-zinc-900 dark:text-zinc-100">
              <span className="text-[#22c55e] mr-1.5">✓</span>{a.description}
            </li>
          ))}
          {result.skipped.map(sk => (
            <li key={sk.changeId} className="text-sm text-zinc-500 dark:text-zinc-400">
              <span className="mr-1.5">–</span>{sk.reason}
            </li>
          ))}
        </ul>
        <p className="mt-3 text-[11px] text-zinc-400 dark:text-zinc-500">
          These are real records now, so asking the same question again will show no change.
        </p>
      </Card>
    );
  }

  return (
    <Card>
      <div className="text-xs font-semibold text-zinc-500 dark:text-zinc-400 mb-1">
        Make it real
      </div>
      <p className="text-[11px] text-zinc-400 dark:text-zinc-500 mb-3">
        Nothing above has been saved. Tick what you want written and Ledger will create or
        edit exactly these records — nothing else.
      </p>

      <div className="space-y-2">
        {canApply.map(a => (
          <label key={a.changeId} className="flex items-start gap-2.5 cursor-pointer">
            <input
              type="checkbox"
              checked={selected.has(a.changeId)}
              onChange={() => {
                setConfirming(false);
                setSelected(prev => {
                  const next = new Set(prev);
                  if (next.has(a.changeId)) next.delete(a.changeId);
                  else next.add(a.changeId);
                  return next;
                });
              }}
              className="mt-1 accent-[var(--brand)]"
            />
            <span className="min-w-0">
              <span className="block text-sm text-zinc-900 dark:text-zinc-100">{a.description}</span>
              <span className="block text-[11px] text-zinc-400 dark:text-zinc-500">
                From “{labelOf(a.changeId)}”
              </span>
            </span>
          </label>
        ))}
      </div>

      {blocked.length > 0 && (
        <div className="mt-3 space-y-1.5">
          {blocked.map(a => (
            <div key={a.changeId} className="text-[12px] text-zinc-500 dark:text-zinc-400">
              <span className="mr-1.5">Not saved:</span>{a.description}
            </div>
          ))}
        </div>
      )}

      {canApply.length > 0 && (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {!confirming ? (
            <Button
              variant="secondary"
              disabled={selected.size === 0}
              onClick={() => setConfirming(true)}
            >
              Apply to Ledger
            </Button>
          ) : (
            <>
              <Button
                onClick={() => {
                  setResult(askDS.applyWhatIf(answer, [...selected]));
                  setConfirming(false);
                  onApplied();
                }}
              >
                Yes — write {selected.size === 1 ? 'this change' : `these ${selected.size} changes`}
              </Button>
              <Button variant="secondary" onClick={() => setConfirming(false)}>Cancel</Button>
              <span className="text-[11px] text-zinc-400 dark:text-zinc-500">
                This edits your real records.
              </span>
            </>
          )}
        </div>
      )}
    </Card>
  );
}

// ── The answer ───────────────────────────────────────────────────────────────

function GapRow({ gap }: { gap: AskGap }) {
  const navigate = useNavigate();
  const style = GAP_STYLE[gap.kind];
  return (
    <div className="flex items-start gap-2">
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
}

function AnswerCard({
  answer, prose, currency, onApplied,
}: {
  answer: AskAnswer;
  prose: string;
  currency: string;
  onApplied: () => void;
}) {
  const navigate = useNavigate();
  const [showDetail, setShowDetail] = useState(false);
  const figures = splitFigures(answer.figures);
  const gaps = splitGaps(answer.gaps);
  const whatIf = answer.facts.kind === 'what-if' ? answer.facts : null;

  const hasDetail = figures.detail.length > 0
    || gaps.detail.length > 0
    || answer.sources.length > 0
    || (whatIf?.reading.length ?? 0) > 0;

  return (
    <div className="space-y-4">
      <Card padding="lg">
        <div className="text-sm text-zinc-500 dark:text-zinc-400">{answer.question}</div>
        <p className="mt-2 text-[15px] leading-relaxed text-zinc-900 dark:text-zinc-100">
          {prose}
        </p>

        {figures.lead.length > 0 && (
          <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-2">
            {figures.lead.map(f => <FigureTile key={f.key} figure={f} currency={currency} />)}
          </div>
        )}

        {gaps.lead.length > 0 && (
          <div className="mt-4 space-y-2">
            {gaps.lead.map((gap, i) => <GapRow key={`${gap.kind}:${i}`} gap={gap} />)}
          </div>
        )}

        {hasDetail && (
          <button
            type="button"
            onClick={() => setShowDetail(v => !v)}
            className="mt-4 text-xs text-brand hover:underline"
          >
            {showDetail ? 'Hide calculation' : 'See calculation'}
          </button>
        )}
      </Card>

      {whatIf?.comparison && (
        <ApplyCard
          answer={answer}
          scenario={whatIf.comparison.scenario}
          onApplied={onApplied}
        />
      )}

      {whatIf?.comparison && (
        <p className="text-[11px] text-zinc-400 dark:text-zinc-500 px-1">
          Ask a follow-up — “what about $2,000?”, “and last month?” — and Ledger re-runs
          the same question with the new figure.
        </p>
      )}

      {showDetail && (
        <>
          {figures.detail.length > 0 && (
            <Card>
              <div className="text-xs font-semibold text-zinc-500 dark:text-zinc-400 mb-3">
                The full figures
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {figures.detail.map(f => <FigureTile key={f.key} figure={f} currency={currency} />)}
              </div>
            </Card>
          )}

          {whatIf && <ReadingCard lines={whatIf.reading} />}

          {gaps.detail.length > 0 && (
            <Card>
              <div className="text-xs font-semibold text-zinc-500 dark:text-zinc-400 mb-3">
                Worth knowing
              </div>
              <div className="space-y-2">
                {gaps.detail.map((gap, i) => <GapRow key={`${gap.kind}:${i}`} gap={gap} />)}
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
        </>
      )}
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

interface AskState {
  answer: AskAnswer;
  prose: string;
}

/**
 * How long Ledger's own answer waits for the model to read the question.
 *
 * Short: this is the gap between "here is the answer" and "here is a
 * DIFFERENT answer", which is the thing worth avoiding. Past it, the answer
 * goes up regardless and is rebuilt if the model turns out to read the
 * question differently — a slow model can delay an answer by a moment, never
 * withhold one.
 */
const ASK_SETTLE_MS = 1500;

/** The line that stands in for the answer while the answer is being worked out. */
function ThinkingCard({ message }: { message: string }) {
  return (
    <Card>
      <div className="flex items-center gap-3 py-1">
        <span
          aria-hidden
          className="h-4 w-4 rounded-full border-2 border-brand border-t-transparent animate-spin shrink-0"
        />
        <span className="text-sm text-zinc-500 dark:text-zinc-400">{message}</span>
      </div>
    </Card>
  );
}

/** The scenario a follow-up refers back to. Null until a hypothetical is asked. */
function scenarioOf(answer: AskAnswer | null | undefined): Scenario | null {
  if (!answer || answer.facts.kind !== 'what-if') return null;
  return answer.facts.comparison?.scenario ?? null;
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
  /** What Ledger is doing right now — shown INSTEAD of the previous answer. */
  const [thinking, setThinking] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  /** Guards against a slow AI response landing on a newer question's answer. */
  const askId = useRef(0);
  /** The last hypothetical asked — what a follow-up figure applies to. */
  const lastScenario = useRef<Scenario | null>(null);
  /** The last question as interpreted — what "what about groceries?" revises. */
  const lastIntent = useRef<AskIntent | null>(null);

  const suggestions = useMemo(
    () => askDS.suggestions(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scopeKey, transactions, goals, loans, budgets],
  );

  useEffect(() => { inputRef.current?.focus(); }, []);

  // The document vault, fetched once when the page opens. Documents are the
  // one thing a question can name that does not live in the store, and reading
  // a question is synchronous — so a vault that arrived after the user typed
  // would mean "what does my NRMA policy say?" failing to find a file that is
  // sitting right there. Failure is silent and harmless: every question that
  // is not about paperwork answers exactly as before.
  useEffect(() => { void askDS.warm(); }, [scopeKey]);

  const ask = async (text: string) => {
    const q = text.trim();
    if (!q || asking) return;
    const id = ++askId.current;

    setAsking(true);
    setQuestion(q);

    // What a follow-up refers back to. Held in refs rather than passed
    // through state so a follow-up asked while the previous answer is still
    // being reworded still refers to the right question.
    const previous = lastScenario.current;
    const previousIntent = lastIntent.current;

    // 0. The previous answer comes OFF the screen now, replaced by a line that
    //    names what is being looked at. Leaving it up reads as an answer to
    //    the question just typed — the worst kind of wrong, because nothing
    //    about a stale answer looks stale. The reading is synchronous, so the
    //    wait can say something true from its first frame.
    let rulesIntent: AskIntent | null = null;
    try {
      rulesIntent = askDS.interpret(q, { previous, previousIntent });
    } catch (err) {
      console.error('[ask] could not read the question:', err);
    }
    setState(null);
    setThinking(thinkingMessage(rulesIntent));

    try {
      // 1. Ledger answers FIRST, from its own engines, with its own wording.
      //    This is the answer — everything after it is presentation.
      const intent = rulesIntent ?? askDS.interpret(q, { previous, previousIntent });
      await askDS.prepare(intent);
      if (id !== askId.current) return;
      let answer = askDS.answerFor(intent);

      // 2. Ask the model how it reads the question, and rebuild from the
      //    engines on its reading. When it agrees with the rules the answer is
      //    identical. A failed or absent call changes nothing: `interpretWithAI`
      //    returns the rules match.
      //
      //    BOTH AI steps — the reading and the rewording — happen inside the
      //    grace period, before anything is on screen. Past it Ledger's own
      //    answer goes up in Ledger's own words, and that is the answer: a
      //    late reply is logged and thrown away. An answer that changes after
      //    the user has begun reading it is worse than one the model never
      //    touched, because nothing about the first one looked provisional.
      const deadline = Date.now() + ASK_SETTLE_MS;
      const left = () => Math.max(0, deadline - Date.now());
      const inTime = <T,>(work: Promise<T>): Promise<{ ready: true; value: T } | { ready: false }> =>
        Promise.race([
          work.then(value => ({ ready: true as const, value })),
          new Promise<{ ready: false }>(resolve => {
            window.setTimeout(() => resolve({ ready: false }), left());
          }),
        ]);

      const reading = await inTime(
        askDS.interpretWithAI(q, { previous, previousIntent }).then(r => r, () => null),
      );
      if (id !== askId.current) return;

      // What a follow-up will revise: the reading the answer was built on,
      // whichever of the two it turned out to be.
      lastIntent.current = intent;
      const aiIntent = reading.ready ? reading.value : null;
      if (aiIntent && aiIntent.source === 'ai') {
        await askDS.prepare(aiIntent);
        if (id !== askId.current) return;
        answer = askDS.answerFor(aiIntent);
        lastIntent.current = aiIntent;
      } else if (!reading.ready) {
        console.info('[ask] the model was still reading the question — answered from the rules');
      }

      // 3. Only now, with every figure already computed, is the model allowed
      //    near the wording — through the number check, and only with whatever
      //    is left of the grace period.
      let prose = answer.headline;
      if (left() > 0) {
        const reworded = await inTime(askDS.phrase(answer).then(r => r, () => null));
        if (id !== askId.current) return;
        if (reworded.ready && reworded.value) {
          // A rejected rewrite needs no announcement: what the user reads is
          // Ledger's own sentence, which was already correct. The guard is
          // logged rather than displayed — it is a fact about the model, not
          // the answer.
          if (reworded.value.rejected?.length) {
            console.warn('[ask] reworded answer discarded — figures not in the data:', reworded.value.rejected);
          }
          prose = reworded.value.text;
        } else if (!reworded.ready) {
          console.info('[ask] rewording arrived after the answer was due — Ledger\'s own wording stands');
        }
      }

      // 4. The answer goes up, and it is final.
      lastScenario.current = scenarioOf(answer) ?? previous;
      if (id !== askId.current) return;
      setThinking(null);
      setState({ answer, prose });
      setAsking(false);
    } catch (err) {
      console.error('[ask] failed:', err);
      if (id === askId.current) {
        const fallbackIntent = askDS.interpret(q, { previous, previousIntent });
        const fallback = askDS.answerFor(fallbackIntent);
        lastScenario.current = scenarioOf(fallback) ?? previous;
        lastIntent.current = fallbackIntent;
        setThinking(null);
        setState({ answer: fallback, prose: fallback.headline });
      }
    } finally {
      if (id === askId.current) {
        setAsking(false);
        setThinking(null);
      }
    }
  };

  return (
    <Layout>
      <PageHeader
        title="Ask Ledger"
        subtitle="Questions about your own money — including what would happen if something changed."
      />

      <PageHint hint="ask" />

      <Card padding="lg" className="mb-4">
        <form
          onSubmit={(e) => { e.preventDefault(); void ask(question); }}
          className="flex flex-col sm:flex-row gap-2"
        >
          <input
            ref={inputRef}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="What happens if I pay $1,000 off my car loan?"
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
          Asking changes nothing. Every figure is computed by Ledger's own engines — the same
          ones behind the Forecast, Budget, Loans and Tax screens — so an answer here always
          agrees with the page it links to. Ask what would happen if something changed
          (“what if I pay $1,000 off my car loan?”) and those engines simply run twice: once
          on your records as they are, once as the question describes them. Nothing is saved
          unless you say so, change by change.
        </p>
      </Card>

      {thinking && <ThinkingCard message={thinking} />}

      {!thinking && state && (
        <AnswerCard
          // Keyed by the question so a fresh answer starts collapsed again.
          key={state.answer.question}
          answer={state.answer}
          prose={state.prose}
          currency={currency}
          // Applying wrote real records, so the answer above is now history.
          // Re-asking the question is the honest way to show what changed.
          onApplied={() => { lastScenario.current = null; }}
        />
      )}
    </Layout>
  );
}
