import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useStore } from '../../store';
import { goalsDS, goalContributionsDS, goalReportDS } from '../../services/dataService';
import { formatCurrency, formatRelativeDate, formatDate } from '../../utils/format';
import { toGoalView, type GoalLineView, type GoalMessage, type GoalTone } from '../../utils/goalView';
import { goalLinks, type GoalSourceType } from '../../utils/savingsGoals';
import { buildGoalHistory, type HistoryContribution } from '../../utils/goalHistory';
import type { Goal } from '../../types';
import Card from '../common/Card';
import Modal from '../common/Modal';
import Button from '../common/Button';
import Input, { Select } from '../common/Input';

// ─────────────────────────────────────────────────────────────────────────────
//  Savings goals — Phase 4.3.
//
//  ONE system. Every number here comes from `goalReportDS.build()`, which runs
//  the pure engine (utils/savingsGoals.ts) over the goals, their contribution
//  ledger, live account/investment/super balances and the cash-flow forecast.
//  The component holds no arithmetic: saved / remaining / % / required-per-week
//  / required-per-month / on-track / projected date all arrive decided.
//
//  A goal is funded two ways that must not be double-counted: a LINK reads a
//  live balance, a manual CONTRIBUTION is a ledger row. A deposit into a linked
//  account is already in the balance, so the engine records it for history but
//  does not add it twice — see utils/savingsGoals.ts → isReflected.
// ─────────────────────────────────────────────────────────────────────────────

/** Re-derive the goals report on any change to the data it reads, plus on tab
 *  focus (it also depends on "today", which no store slice announces). */
function useGoalReport() {
  const goals = useStore(s => s.goals);
  const contributions = useStore(s => s.goalContributions);
  const accounts = useStore(s => s.accounts);
  const investments = useStore(s => s.investments);
  const superFunds = useStore(s => s.superFunds);
  const userId = useStore(s => s.user?.id ?? null);

  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick(n => n + 1), []);

  const report = useMemo(
    () => goalReportDS.build(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [goals, contributions, accounts, investments, superFunds, userId, tick],
  );

  const view = useMemo(() => toGoalView(report), [report]);
  return { view, refresh };
}

/** Resolve a source (account / investment / super) to a display name. Shared by
 *  the contribution and history views so a source always reads the same way. */
function useSourceName() {
  const accounts = useStore(s => s.accounts);
  const investments = useStore(s => s.investments);
  const superFunds = useStore(s => s.superFunds);
  return useCallback((type: GoalSourceType, id: string): string => {
    if (type === 'investment') return investments.find(i => i.id === id)?.name ?? 'Investment';
    if (type === 'super') return (superFunds.find(f => f.id === id) as any)?.fund_name ?? 'Super';
    return accounts.find(a => a.id === id)?.name ?? 'Account';
  }, [accounts, investments, superFunds]);
}

const SOURCE_ICON: Record<GoalSourceType, string> = { account: '🏦', investment: '📈', super: '🏛️' };

const TONE_PILL: Record<GoalTone, string> = {
  good: 'bg-[#16a34a]/10 text-[#16a34a] dark:bg-[#22c55e]/10 dark:text-[#4ade80]',
  warn: 'bg-[#d97706]/10 text-[#d97706] dark:bg-[#f59e0b]/10 dark:text-[#fbbf24]',
  bad: 'bg-[#dc2626]/10 text-[#dc2626] dark:bg-[#ef4444]/10 dark:text-[#f87171]',
  neutral: 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400',
};

const TONE_BAR: Record<GoalTone, string> = {
  good: 'bg-[#16a34a] dark:bg-[#22c55e]',
  warn: 'bg-[#d97706] dark:bg-[#f59e0b]',
  bad: 'bg-[#dc2626] dark:bg-[#ef4444]',
  neutral: 'bg-brand',
};

/** The one line of text under a goal — its STATUS, not its arithmetic. The
 *  required pace and the forecast surplus are shown separately below, so this
 *  line no longer mixes "you need $X" with "nothing is spare".
 *
 *  Null means SAY NOTHING. An `unfunded` goal is one the forecast frees up no
 *  cash for, which the forecast line directly beneath already states — and that
 *  line is guaranteed to be rendered here, because `unfunded` only arises for a
 *  dated, non-complete, non-overdue goal, which is exactly when it shows. */
function describeMessage(m: GoalMessage, currency: string): string | null {
  const money = (n: number) => formatCurrency(n, currency);
  switch (m.kind) {
    case 'complete': return m.over > 0 ? `Reached — ${money(m.over)} over target` : 'Target reached';
    case 'overdue': return `${money(m.short)} short, ${m.daysPast} day${m.daysPast === 1 ? '' : 's'} past the date`;
    case 'open': return `${money(m.remaining)} to go`;
    case 'on-track': return 'On track for your target date';
    case 'short': return `Behind by ${money(m.shortfall)}/mo`;
    case 'unfunded': return null;
    case 'unknown': return `${money(m.required)}/mo needed to finish on time`;
  }
}

/**
 * `focusGoalId` is the goal a Phase 4.4 alert sent the user here to look at —
 * ringed for a few seconds so the eye lands on it. Null the rest of the time.
 */
export default function GoalSection({ currency, focusGoalId = null }: {
  currency: string;
  focusGoalId?: string | null;
}) {
  const { view, refresh } = useGoalReport();
  const [searchParams, setSearchParams] = useSearchParams();

  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<Goal | null>(null);
  const [toDelete, setToDelete] = useState<GoalLineView | null>(null);

  // The open modals are tracked by goal ID, not by holding the line object.
  // Recording or removing a movement rebuilds the report, and a captured line
  // would keep showing the figures from the moment the modal opened — the
  // history panel would delete a row and still report the old saved total.
  const [contributeToId, setContributeToId] = useState<string | null>(null);
  const [historyForId, setHistoryForId] = useState<string | null>(null);
  const contributeTo = contributeToId ? view.lines.find(l => l.id === contributeToId) ?? null : null;
  const historyFor = historyForId ? view.lines.find(l => l.id === historyForId) ?? null : null;

  // Deep link from Quick Add (`/?add=goal`) opens the add form, then clears the
  // param so a refresh doesn't reopen it.
  useEffect(() => {
    if (searchParams.get('add') === 'goal') {
      setEditing(null);
      setAddOpen(true);
      searchParams.delete('add');
      setSearchParams(searchParams, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  // The report depends on "today"; re-check when the tab regains focus.
  useEffect(() => {
    const onFocus = () => refresh();
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [refresh]);

  const openAdd = () => { setEditing(null); setAddOpen(true); };
  const openEdit = (id: string) => {
    const goal = goalsDS.getAll().find(g => g.id === id) ?? null;
    setEditing(goal);
    setAddOpen(true);
  };
  const confirmDelete = () => {
    if (toDelete) goalsDS.remove(toDelete.id);
    setToDelete(null);
    refresh();
  };

  // ── Nothing yet ──
  if (view.isEmpty) {
    return (
      <>
        <Card padding="none" className="p-5">
          <h2 className="text-base font-semibold mb-1">Savings goals</h2>
          <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-4">
            Set a target and a date, link it to an account or track it by hand, and Ledger works
            out what you need to put aside — and whether your forecast covers it.
          </p>
          <button
            onClick={openAdd}
            className="w-full py-3 border border-dashed border-zinc-200 dark:border-zinc-800 rounded-[12px] text-sm text-zinc-500 dark:text-zinc-400 hover:border-brand/40 hover:text-brand transition-all"
          >
            + Add your first goal
          </button>
        </Card>
        {addOpen && (
          <AddGoalModal
            isOpen={addOpen} editing={editing} currency={currency}
            onClose={() => { setAddOpen(false); setEditing(null); }}
            onSaved={refresh}
          />
        )}
      </>
    );
  }

  const { summary } = view;

  return (
    <>
      <Card padding="none" className="p-5">
        <div className="flex items-center justify-between mb-3 gap-2">
          <div className="min-w-0">
            <h2 className="text-base font-semibold">Savings goals</h2>
            <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
              {formatCurrency(summary.totalSaved, currency)} of {formatCurrency(summary.totalTarget, currency)} saved
              {summary.completeCount > 0 && ` · ${summary.completeCount} reached`}
            </p>
          </div>
          <button onClick={openAdd} className="text-xs text-brand hover:underline flex-shrink-0">
            + New goal
          </button>
        </div>

        {/* Capacity headline — only worth showing when there's tension in it. */}
        {summary.monthlyCapacity !== null && (summary.shortfallPerMonth > 0 || summary.unallocatedPerMonth > 0) && (
          <div className={`mb-4 rounded-[8px] px-3 py-2.5 text-xs ${
            summary.shortfallPerMonth > 0
              ? 'bg-[#dc2626]/5 text-[#dc2626] dark:bg-[#ef4444]/10 dark:text-[#f87171]'
              : 'bg-zinc-100 text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400'
          }`}>
            {summary.shortfallPerMonth > 0 ? (
              summary.monthlyCapacity <= 0 ? (
                // A forecast that expects to LOSE money frees up nothing — saying
                // it "frees up -$X" reads as a negative allowance rather than a
                // deficit, which is the opposite of the situation.
                <>Your goals need <b>{formatCurrency(summary.totalRequiredPerMonth, currency)}/mo</b> but your
                forecast expects to spend {formatCurrency(Math.abs(summary.monthlyCapacity), currency)} more
                than it earns each month — nothing is spare for them yet.</>
              ) : (
                <>Your goals need <b>{formatCurrency(summary.totalRequiredPerMonth, currency)}/mo</b> but your
                forecast only frees up <b>{formatCurrency(summary.monthlyCapacity, currency)}</b> — a
                gap of {formatCurrency(summary.shortfallPerMonth, currency)} a month.</>
              )
            ) : (
              <>Your forecast frees up <b>{formatCurrency(summary.monthlyCapacity, currency)}/mo</b> and
              your goals claim {formatCurrency(summary.totalRequiredPerMonth, currency)} — {formatCurrency(summary.unallocatedPerMonth, currency)} to
              spare.</>
            )}
          </div>
        )}

        <div className="space-y-4">
          {view.lines.map(line => (
            <GoalRow
              key={line.id}
              line={line}
              currency={currency}
              onContribute={() => setContributeToId(line.id)}
              onHistory={() => setHistoryForId(line.id)}
              onEdit={() => openEdit(line.id)}
              onDelete={() => setToDelete(line)}
              focused={line.id === focusGoalId}
            />
          ))}
        </div>
      </Card>

      {addOpen && (
        <AddGoalModal
          isOpen={addOpen} editing={editing} currency={currency}
          onClose={() => { setAddOpen(false); setEditing(null); }}
          onSaved={refresh}
        />
      )}

      {contributeTo && (
        <ContributionModal
          line={contributeTo} currency={currency}
          onClose={() => setContributeToId(null)}
          onSaved={refresh}
        />
      )}

      {historyFor && (
        <GoalHistoryModal
          line={historyFor} currency={currency}
          onClose={() => setHistoryForId(null)}
          onChanged={refresh}
        />
      )}

      <Modal isOpen={!!toDelete} onClose={() => setToDelete(null)} title="Delete goal?" size="sm">
        <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-2">
          Delete <span className="font-medium text-zinc-900 dark:text-white">“{toDelete?.name}”</span>? This can't be undone.
        </p>
        {toDelete && toDelete.contributionCount > 0 && (
          <p className="text-xs text-zinc-400 dark:text-[#666] mb-5">
            Its {toDelete.contributionCount} recorded contribution{toDelete.contributionCount === 1 ? '' : 's'} will
            be removed too. Any linked account keeps its balance — only the goal and its history go.
          </p>
        )}
        <div className="flex gap-3">
          <Button variant="secondary" fullWidth onClick={() => setToDelete(null)}>Cancel</Button>
          <Button variant="danger" fullWidth onClick={confirmDelete}>Delete</Button>
        </div>
      </Modal>
    </>
  );
}

// ─── One goal row ─────────────────────────────────────────────────────────────

function GoalRow({ line, currency, onContribute, onHistory, onEdit, onDelete, focused = false }: {
  line: GoalLineView;
  currency: string;
  onContribute: () => void;
  onHistory: () => void;
  onEdit: () => void;
  onDelete: () => void;
  focused?: boolean;
}) {
  const linked = line.linkedSaved > 0 || line.brokenLinks.length > 0;
  const money = (n: number) => formatCurrency(n, currency);
  const message = describeMessage(line.message, currency);

  // The forecast line: this goal's own share of the projected spare cash, kept
  // separate from the required pace above so neither reads as the other.
  const showForecast = !!line.targetDate && line.status !== 'complete' && line.status !== 'overdue';
  const forecastText = !line.capacityKnown
    ? 'No forecast yet to check affordability'
    : line.allocatedPerMonth > 0
      ? (line.shortfallPerMonth > 0
          ? `Forecast frees up ${money(line.allocatedPerMonth)}/mo for this — ${money(line.shortfallPerMonth)}/mo short`
          : `Forecast frees up ${money(line.allocatedPerMonth)}/mo for this — enough`)
      : 'Forecast has no spare cash for this yet';

  return (
    <div className={`rounded-[10px] border p-3 ${
      focused ? 'border-brand ring-2 ring-brand/60' : 'border-zinc-200 dark:border-zinc-800'
    }`}>
      <div className="flex items-start justify-between gap-3 mb-1.5">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium truncate">{line.name}</span>
            <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium flex-shrink-0 ${TONE_PILL[line.tone]}`}>
              {line.statusLabel}
            </span>
          </div>
          <span className="text-xs text-zinc-500 dark:text-zinc-400">
            {money(line.saved)} of {money(line.targetAmount)}
            {' · '}{line.displayPct}%
          </span>
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0 pt-0.5">
          <IconButton title="Edit goal" onClick={onEdit}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </IconButton>
          <IconButton title="Delete goal" danger onClick={onDelete}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </IconButton>
        </div>
      </div>

      {/* Bar with the projected-by-deadline marker */}
      <div className="relative h-2 bg-zinc-200 dark:bg-zinc-800 rounded-full overflow-hidden">
        <div className={`h-full rounded-full transition-all duration-500 ${TONE_BAR[line.tone]}`} style={{ width: `${line.bar.fillPct}%` }} />
        {line.bar.markerPct !== null && (
          <div
            className="absolute top-0 bottom-0 w-0.5 bg-zinc-500 dark:bg-zinc-300"
            style={{ left: `${line.bar.markerPct}%` }}
            title="Projected by your target date"
          />
        )}
      </div>

      {/* The status line is skipped entirely when there is nothing to say, so a
          goal with no message doesn't leave an empty row above the date. */}
      {(message !== null || line.targetDate) && (
        <div className="flex items-center justify-between mt-1.5 gap-2">
          {message !== null
            ? <span className="text-xs text-zinc-500 dark:text-zinc-400 truncate">{message}</span>
            : <span />}
          {line.targetDate && (
            <span className="text-xs text-zinc-400 dark:text-[#666] flex-shrink-0">{formatRelativeDate(line.targetDate)}</span>
          )}
        </div>
      )}

      {/* Required contributions — only while there's still a pace to keep. */}
      {line.requiredPerWeek !== null && line.requiredPerMonth !== null && (
        <p className="mt-2 text-[11px] text-zinc-500 dark:text-zinc-400">
          Needs {money(line.requiredPerWeek)}<span className="text-zinc-400 dark:text-[#666]">/wk</span>
          {' · '}{money(line.requiredPerMonth)}<span className="text-zinc-400 dark:text-[#666]">/mo</span> to finish on time
        </p>
      )}

      {/* Forecast surplus — shown on its own so "needed" and "available" never blur. */}
      {showForecast && (
        <p className={`mt-0.5 text-[11px] ${line.shortfallPerMonth > 0 && line.capacityKnown ? 'text-[#d97706] dark:text-[#f59e0b]' : 'text-zinc-500 dark:text-zinc-400'}`}>
          {forecastText}
        </p>
      )}

      {linked && (
        <p className="text-[11px] text-brand mt-1.5">
          🔗 {money(line.linkedSaved)} from linked accounts
          {line.reflectedTotal !== 0 && (
            <span className="text-zinc-400 dark:text-[#666]">
              {' · '}{money(Math.abs(line.reflectedTotal))} of logged movements already counted in those balances
            </span>
          )}
          {line.brokenLinks.length > 0 && (
            <span className="text-[#d97706] dark:text-[#f59e0b]">
              {' · '}{line.brokenLinks.length} link{line.brokenLinks.length === 1 ? '' : 's'} to a deleted asset — edit to fix
            </span>
          )}
        </p>
      )}

      {/* Prominent actions — adding or withdrawing funds is the main thing you
          do to a goal, so it gets a real button, not a hidden icon. */}
      <div className="flex gap-2 mt-3">
        <button
          onClick={onContribute}
          className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-[8px] bg-brand text-white text-sm font-medium hover:opacity-90 transition-opacity"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          Add or withdraw funds
        </button>
        <button
          onClick={onHistory}
          className="flex items-center justify-center gap-1.5 px-3 py-2 rounded-[8px] border border-zinc-200 dark:border-zinc-800 text-sm text-zinc-600 dark:text-zinc-300 hover:border-brand/40 hover:text-brand transition-colors"
          title="History"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/></svg>
          History
        </button>
      </div>
    </div>
  );
}

function IconButton({ title, onClick, danger, children }: {
  title: string; onClick: () => void; danger?: boolean; children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={title}
      className={`text-zinc-400 transition-colors ${danger ? 'hover:text-[#ef4444]' : 'hover:text-brand'}`}
    >
      {children}
    </button>
  );
}

// ─── Logging a contribution or withdrawal ─────────────────────────────────────

function ContributionModal({ line, currency, onClose, onSaved }: {
  line: GoalLineView;
  currency: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const accounts = useStore(s => s.accounts);
  const investments = useStore(s => s.investments);
  const superFunds = useStore(s => s.superFunds);
  const nameFor = useSourceName();

  const goal = useMemo(() => goalsDS.getAll().find(g => g.id === line.id), [line.id]);
  const links = goal ? goalLinks(goal) : [];
  const linkKeys = useMemo(() => new Set(links.map(l => `${l.type}:${l.id}`)), [links]);

  const today = new Date().toISOString().slice(0, 10);
  const [direction, setDirection] = useState<'in' | 'out'>('in');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(today);
  const [note, setNote] = useState('');
  const [sourceKey, setSourceKey] = useState('');   // '' = untracked cash / manual

  // The SAME sources you can fund a goal from at setup: any account, investment
  // or super fund, plus untracked cash. A source that is ALSO one of this goal's
  // links is already reflected in its balance, so the engine records it for
  // history without counting it twice — that check lives in savingsGoals.ts.
  const sourceOptions = [
    { value: '', label: '💵 Cash / manual (not a tracked account)' },
    ...accounts.map(a => ({ value: `account:${a.id}`, label: `🏦 ${a.name}` })),
    ...investments.map(i => ({ value: `investment:${i.id}`, label: `📈 ${i.name}` })),
    ...superFunds.map(f => ({ value: `super:${f.id}`, label: `🏛️ ${(f as any).fund_name ?? 'Super'}` })),
  ];

  const parsed = parseFloat(amount) || 0;
  const isLinkedSource = sourceKey !== '' && linkKeys.has(sourceKey);
  const signed = direction === 'in' ? parsed : -parsed;
  /** A movement against a source the goal is LINKED to is already inside that
   *  balance, so it changes nothing here — the honest preview is "no change",
   *  not a figure that will never appear on the card. */
  const projectedSaved = isLinkedSource ? line.saved : line.saved + signed;
  const sourceName = sourceKey
    ? nameFor(...(sourceKey.split(':') as [GoalSourceType, string]))
    : '';

  const save = () => {
    if (parsed <= 0) return;
    const [type, id] = sourceKey ? (sourceKey.split(':') as [GoalSourceType, string]) : [null, null];
    goalContributionsDS.add({
      goal_id: line.id,
      amount: direction === 'in' ? parsed : -parsed,
      date,
      source_type: type,
      source_id: id,
      note: note.trim() || null,
    });
    onSaved();
    onClose();
  };

  return (
    <Modal isOpen onClose={onClose} title={line.name} size="sm">
      <div className="space-y-4">
        <div className="flex gap-1 bg-zinc-100 dark:bg-zinc-900 rounded-lg p-1">
          {(['in', 'out'] as const).map(d => (
            <button
              key={d}
              onClick={() => setDirection(d)}
              className={`flex-1 py-2 text-sm rounded-md transition-colors ${
                direction === d
                  ? 'bg-white dark:bg-zinc-800 text-zinc-900 dark:text-white shadow-sm font-medium'
                  : 'text-zinc-500 dark:text-zinc-400'
              }`}
            >
              {d === 'in' ? 'Add money' : 'Withdraw'}
            </button>
          ))}
        </div>

        <Input
          label="Amount" type="number" step="0.01" min="0" inputMode="decimal" prefix="$"
          value={amount} onChange={e => setAmount(e.target.value)} placeholder="e.g. 200" autoFocus
        />

        <Select
          label={direction === 'in' ? 'Where did the money come from?' : 'Where did the money go?'}
          options={sourceOptions}
          value={sourceKey}
          onChange={e => setSourceKey(e.target.value)}
        />

        {isLinkedSource ? (
          <p className="text-xs text-[#d97706] dark:text-[#f59e0b] -mt-1">
            {sourceName} already funds this goal, so the goal follows its balance. This is recorded in
            your history but <b>won't change the saved figure</b> — that moves when {sourceName}'s balance
            does. To {direction === 'in' ? 'add to' : 'take off'} the goal directly, choose Cash / manual.
          </p>
        ) : sourceKey !== '' ? (
          <p className="text-xs text-zinc-400 dark:text-[#666] -mt-1">
            {sourceName} isn't linked to this goal, so the move {direction === 'in' ? 'adds to' : 'comes off'} it
            directly. Ledger records the movement — it doesn't change {sourceName}'s balance.
          </p>
        ) : (
          <p className="text-xs text-zinc-400 dark:text-[#666] -mt-1">
            Cash Ledger can't see — this {direction === 'in' ? 'adds to' : 'comes off'} the goal directly.
          </p>
        )}

        <Input label="Date" type="date" value={date} onChange={e => setDate(e.target.value)} />

        <Input
          label="Note (optional)" value={note} onChange={e => setNote(e.target.value)}
          placeholder="e.g. tax refund, moved to holiday fund"
        />

        {/* What this actually does to the goal, before you commit to it. */}
        {parsed > 0 && (
          <div className="rounded-[8px] bg-zinc-100 dark:bg-zinc-900 px-3 py-2.5 text-sm">
            {isLinkedSource ? (
              <span className="text-zinc-500 dark:text-zinc-400">
                Recorded for history. Saved stays{' '}
                <span className="font-semibold amount text-zinc-900 dark:text-white">{formatCurrency(line.saved, currency)}</span>{' '}
                until {sourceName}'s balance updates.
              </span>
            ) : (
              <span className="text-zinc-500 dark:text-zinc-400">
                Saved goes {formatCurrency(line.saved, currency)} →{' '}
                <span className={`font-semibold amount ${signed < 0 ? 'text-[#dc2626] dark:text-[#f87171]' : 'text-[#16a34a] dark:text-[#4ade80]'}`}>
                  {formatCurrency(projectedSaved, currency)}
                </span>
                {line.targetAmount > 0 && (
                  <span className="text-zinc-400 dark:text-[#666]">
                    {' · '}{formatCurrency(Math.max(0, line.targetAmount - projectedSaved), currency)} to go
                  </span>
                )}
              </span>
            )}
          </div>
        )}

        <div className="flex gap-3 pt-1">
          <Button variant="secondary" type="button" onClick={onClose}>Cancel</Button>
          <Button variant="primary" fullWidth onClick={save} disabled={parsed <= 0}>
            {direction === 'in' ? 'Add money' : 'Withdraw'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ─── Goal history ─────────────────────────────────────────────────────────────

function GoalHistoryModal({ line, currency, onClose, onChanged }: {
  line: GoalLineView;
  currency: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  // Subscribe to the ledger so a delete inside the panel re-renders it live.
  const allContributions = useStore(s => s.goalContributions);
  const nameFor = useSourceName();
  const money = (n: number) => formatCurrency(n, currency);

  const goal = useMemo(() => goalsDS.getAll().find(g => g.id === line.id), [line.id]);
  const links = useMemo(() => (goal ? goalLinks(goal) : []), [goal]);
  const isLinked = links.length > 0;

  const history = useMemo(() => {
    const rows: HistoryContribution[] = allContributions
      .filter(c => c.goal_id === line.id)
      .map(c => ({
        id: c.id,
        amount: Number(c.amount) || 0,
        date: (c.date || '').slice(0, 10),
        source: c.source_type && c.source_id ? { type: c.source_type, id: c.source_id } : null,
        note: c.note ?? null,
        createdAt: c.created_at ?? null,
      }));
    return buildGoalHistory({ contributions: rows, links, openingAmount: goal?.current_amount ?? 0, isLinked });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allContributions, line.id, links, isLinked, goal?.current_amount]);

  const remove = (id: string) => {
    goalContributionsDS.remove(id);
    onChanged();
  };

  return (
    <Modal isOpen onClose={onClose} title={`${line.name} — history`} size="md">
      <div className="space-y-4">
        {/* Summary strip */}
        <div className="grid grid-cols-3 gap-2 text-center">
          <Stat label="Saved" value={money(line.saved)} />
          <Stat label="Paid in" value={money(history.deposited)} tone="good" />
          <Stat label="Withdrawn" value={money(history.withdrawn)} tone={history.withdrawn > 0 ? 'bad' : 'neutral'} />
        </div>

        {isLinked && (
          <p className="text-[11px] text-brand -mt-1">
            🔗 {money(line.linkedSaved)} of this comes from linked accounts and updates live — the running
            balance below tracks only money you've recorded by hand.
          </p>
        )}

        {/* Progress-over-time chart — only when there's a line worth drawing. */}
        {history.series.length >= 2 && (
          <Sparkline points={history.series.map(p => p.balance)} target={line.targetAmount} />
        )}

        {/* The ledger */}
        {history.rows.length === 0 ? (
          <p className="text-sm text-zinc-500 dark:text-zinc-400 py-6 text-center">
            No movements recorded yet. Use “Add or withdraw funds” to start the history.
          </p>
        ) : (
          <div className="max-h-[46vh] overflow-y-auto -mx-1">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-white dark:bg-zinc-900">
                <tr className="text-zinc-400 dark:text-[#666] text-left">
                  <th className="font-medium py-1.5 px-1">Date</th>
                  <th className="font-medium py-1.5 px-1">Source</th>
                  <th className="font-medium py-1.5 px-1 text-right">Movement</th>
                  <th className="font-medium py-1.5 px-1 text-right">Balance</th>
                  <th className="py-1.5 px-1"></th>
                </tr>
              </thead>
              <tbody>
                {history.rows.map(r => (
                  <tr key={r.id} className="border-t border-zinc-100 dark:border-zinc-900 align-top">
                    <td className="py-2 px-1 whitespace-nowrap text-zinc-500 dark:text-zinc-400">{formatDate(r.date)}</td>
                    <td className="py-2 px-1 text-zinc-600 dark:text-zinc-300">
                      <div>
                        {r.source ? `${SOURCE_ICON[r.source.type]} ${nameFor(r.source.type, r.source.id)}` : '💵 Cash / manual'}
                      </div>
                      {r.note && <div className="text-zinc-400 dark:text-[#666] mt-0.5">{r.note}</div>}
                      {r.reflected && <div className="text-brand mt-0.5">in linked balance</div>}
                    </td>
                    <td className={`py-2 px-1 text-right whitespace-nowrap amount font-medium ${r.amount >= 0 ? 'text-[#16a34a] dark:text-[#4ade80]' : 'text-[#dc2626] dark:text-[#f87171]'}`}>
                      {r.amount >= 0 ? '+' : '−'}{formatCurrency(Math.abs(r.amount), currency)}
                    </td>
                    <td className="py-2 px-1 text-right whitespace-nowrap text-zinc-600 dark:text-zinc-300">
                      {r.runningBalance === null ? '—' : formatCurrency(r.runningBalance, currency)}
                    </td>
                    <td className="py-2 px-1 text-right">
                      <button
                        onClick={() => remove(r.id)}
                        className="text-zinc-300 dark:text-zinc-600 hover:text-[#ef4444] transition-colors"
                        title="Remove this movement"
                        aria-label="Remove this movement"
                      >
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="pt-1">
          <Button variant="secondary" fullWidth onClick={onClose}>Close</Button>
        </div>
      </div>
    </Modal>
  );
}

function Stat({ label, value, tone = 'neutral' }: { label: string; value: string; tone?: 'good' | 'bad' | 'neutral' }) {
  const color = tone === 'good' ? 'text-[#16a34a] dark:text-[#4ade80]'
    : tone === 'bad' ? 'text-[#dc2626] dark:text-[#f87171]'
    : 'text-zinc-900 dark:text-white';
  return (
    <div className="rounded-[8px] bg-zinc-100 dark:bg-zinc-900 px-2 py-2">
      <div className={`text-sm font-semibold amount ${color}`}>{value}</div>
      <div className="text-[10px] text-zinc-400 dark:text-[#666] uppercase tracking-wide">{label}</div>
    </div>
  );
}

/** A minimal progress-over-time line: recorded balance across the ledger's
 *  dates, with the target as a faint ceiling. No axes — it's a shape, not a
 *  report; the numbers live in the table below it. */
function Sparkline({ points, target }: { points: number[]; target: number }) {
  const W = 300, H = 64, PAD = 4;
  const hi = Math.max(target > 0 ? target : 0, ...points, 1);
  const lo = Math.min(0, ...points);
  const span = hi - lo || 1;
  const x = (i: number) => PAD + (i / (points.length - 1)) * (W - PAD * 2);
  const y = (v: number) => PAD + (1 - (v - lo) / span) * (H - PAD * 2);
  const path = points.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const area = `${path} L${x(points.length - 1).toFixed(1)},${(H - PAD).toFixed(1)} L${x(0).toFixed(1)},${(H - PAD).toFixed(1)} Z`;
  const targetY = target > 0 ? y(target) : null;

  return (
    <div className="rounded-[8px] border border-zinc-200 dark:border-zinc-800 px-2 pt-2 pb-1">
      {/* text-brand sits on the SVG itself: a gradient's `currentColor` resolves
          against the gradient element, which inherits from here — not from the
          class on the path that references it. */}
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-16 text-brand" preserveAspectRatio="none" role="img" aria-label="Recorded balance over time">
        <defs>
          <linearGradient id="goalspark" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="currentColor" stopOpacity="0.22" />
            <stop offset="100%" stopColor="currentColor" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {targetY !== null && (
          <line x1={PAD} y1={targetY} x2={W - PAD} y2={targetY} stroke="#a1a1aa" strokeOpacity="0.5" strokeWidth="1" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
        )}
        <path d={area} fill="url(#goalspark)" />
        <path d={path} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      </svg>
      <p className="text-[10px] text-zinc-400 dark:text-[#666] text-center">
        Recorded balance over time{target > 0 && ' · dashed line is your target'}
      </p>
    </div>
  );
}

// ─── Add / Edit goal ──────────────────────────────────────────────────────────

type SourceRow = { type: GoalSourceType; id: string; link_type: 'percent' | 'amount'; link_value: string };

function AddGoalModal({ isOpen, onClose, onSaved, editing, currency }: {
  isOpen: boolean;
  onClose: () => void;
  onSaved: () => void;
  editing?: Goal | null;
  currency: string;
}) {
  const accounts = useStore(s => s.accounts);
  const investments = useStore(s => s.investments);
  const superFunds = useStore(s => s.superFunds);

  const blank = { name: '', target_amount: '', current_amount: '0', target_date: '', include_in_briefing: true };
  const [form, setForm] = useState(blank);
  const [sources, setSources] = useState<SourceRow[]>([]);

  useEffect(() => {
    if (!isOpen) return;
    if (editing) {
      setForm({
        name: editing.name,
        target_amount: String(editing.target_amount ?? ''),
        current_amount: String(editing.current_amount ?? '0'),
        target_date: editing.target_date ?? '',
        include_in_briefing: editing.include_in_briefing !== false,
      });
      setSources(goalLinks(editing).map(s => ({
        type: s.type, id: s.id, link_type: s.link_type, link_value: String(s.link_value),
      })));
    } else {
      setForm(blank);
      setSources([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, editing]);

  const balanceOf = (s: SourceRow): number => {
    if (s.type === 'investment') {
      const inv = investments.find(i => i.id === s.id) as any;
      return inv ? (inv.display_value ?? inv.current_value ?? 0) : 0;
    }
    if (s.type === 'super') {
      const sf = superFunds.find(f => f.id === s.id) as any;
      return sf ? (sf.balance ?? 0) : 0;
    }
    const acc = accounts.find(a => a.id === s.id) as any;
    return acc ? (acc.display_balance ?? acc.balance ?? 0) : 0;
  };

  const contributionOf = (s: SourceRow): number => {
    const v = parseFloat(s.link_value) || 0;
    const bal = balanceOf(s);
    return s.link_type === 'percent' ? Math.max(0, (bal * v) / 100) : Math.min(v, bal);
  };

  const validSources = sources.filter(s => s.id);
  const totalContribution = validSources.reduce((sum, s) => sum + contributionOf(s), 0);
  const isLinked = validSources.length > 0;

  const sourceOptions = (current: SourceRow) => {
    const taken = new Set(sources.filter(s => s !== current).map(s => `${s.type}:${s.id}`));
    return [
      { value: '', label: 'Choose an account, investment or super…' },
      ...accounts
        .filter(a => !taken.has(`account:${a.id}`))
        .map(a => ({ value: `account:${a.id}`, label: `🏦 ${a.name} (${formatCurrency((a as any).display_balance ?? a.balance, currency)})` })),
      ...investments
        .filter(i => !taken.has(`investment:${i.id}`))
        .map(i => ({ value: `investment:${i.id}`, label: `📈 ${i.name} (${formatCurrency((i as any).display_value ?? (i as any).current_value ?? 0, currency)})` })),
      ...superFunds
        .filter(f => !taken.has(`super:${f.id}`))
        .map(f => ({ value: `super:${f.id}`, label: `🏛️ ${(f as any).fund_name} (${formatCurrency((f as any).balance ?? 0, currency)})` })),
    ];
  };

  const addSource = () => setSources(s => [...s, { type: 'account', id: '', link_type: 'percent', link_value: '' }]);
  const updateSource = (idx: number, patch: Partial<SourceRow>) =>
    setSources(s => s.map((row, i) => (i === idx ? { ...row, ...patch } : row)));
  const removeSource = (idx: number) => setSources(s => s.filter((_, i) => i !== idx));

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name || !form.target_amount) return;
    const common = {
      name: form.name.trim(),
      target_amount: parseFloat(form.target_amount),
      target_date: form.target_date || null,
      include_in_briefing: form.include_in_briefing,
    };
    const payload = isLinked
      ? {
          ...common,
          linked_sources: validSources.map(s => ({
            type: s.type, id: s.id, link_type: s.link_type, link_value: parseFloat(s.link_value) || 0,
          })),
          linked_account_id: null, link_type: null, link_value: null,
          // A snapshot for back-compat; the engine derives the live figure from
          // the links and ignores this.
          current_amount: totalContribution,
        }
      : {
          ...common,
          linked_sources: null, linked_account_id: null, link_type: null, link_value: null,
          current_amount: parseFloat(form.current_amount || '0'),
        };

    if (editing) goalsDS.update(editing.id, payload as Partial<Goal>);
    else goalsDS.add(payload as Parameters<typeof goalsDS.add>[0]);
    onSaved();
    onClose();
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={editing ? 'Edit goal' : 'Add goal'} size="sm">
      <form onSubmit={handleSubmit} className="space-y-4">
        <Input label="Goal name" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. House deposit" required />
        <Input label="Target amount" type="number" step="0.01" prefix="$" value={form.target_amount} onChange={e => setForm(f => ({ ...f, target_amount: e.target.value }))} required />

        <div>
          <label className="label">Linked accounts, investments & super (optional)</label>
          {sources.length === 0 && (
            <p className="text-xs text-zinc-400 dark:text-[#666] mb-2">Link one or more, or track this goal by hand below.</p>
          )}
          <div className="space-y-3">
            {sources.map((src, idx) => (
              <div key={idx} className="rounded-[8px] border border-zinc-200 dark:border-zinc-800 p-2.5 space-y-2">
                <div className="flex items-center gap-2">
                  <div className="flex-1 min-w-0">
                    <Select
                      options={sourceOptions(src)}
                      value={src.id ? `${src.type}:${src.id}` : ''}
                      onChange={e => {
                        const val = e.target.value;
                        if (!val) { updateSource(idx, { id: '' }); return; }
                        const [type, id] = val.split(':') as [GoalSourceType, string];
                        updateSource(idx, { type, id });
                      }}
                    />
                  </div>
                  <button type="button" onClick={() => removeSource(idx)} className="text-zinc-400 hover:text-[#ef4444] transition-colors flex-shrink-0" title="Remove">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                  </button>
                </div>
                {src.id && (
                  <div className="flex gap-2">
                    <div className="flex gap-1 bg-zinc-100 dark:bg-zinc-900 rounded-lg p-1 flex-shrink-0">
                      {(['percent', 'amount'] as const).map(t => (
                        <button
                          key={t}
                          type="button"
                          onClick={() => updateSource(idx, { link_type: t })}
                          className={`px-2.5 py-1.5 text-xs rounded-md transition-colors ${
                            src.link_type === t
                              ? 'bg-white dark:bg-zinc-800 text-zinc-900 dark:text-white shadow-sm font-medium'
                              : 'text-zinc-500 dark:text-zinc-400'
                          }`}
                        >
                          {t === 'percent' ? '%' : '$'}
                        </button>
                      ))}
                    </div>
                    <div className="flex-1">
                      <Input
                        type="number" step="0.01" min="0" inputMode="decimal"
                        prefix={src.link_type === 'amount' ? '$' : undefined}
                        suffix={src.link_type === 'percent' ? '%' : undefined}
                        value={src.link_value}
                        onChange={e => updateSource(idx, { link_value: e.target.value })}
                        placeholder={src.link_type === 'percent' ? 'e.g. 20' : 'e.g. 4000'}
                      />
                    </div>
                  </div>
                )}
                {src.id && (
                  <p className="text-xs text-zinc-400 dark:text-[#666]">Contributes {formatCurrency(contributionOf(src), currency)} now</p>
                )}
              </div>
            ))}
          </div>
          <button type="button" onClick={addSource} className="mt-2 text-sm text-brand hover:underline">+ Add account, investment or super</button>
        </div>

        {isLinked ? (
          <div className="rounded-[8px] bg-zinc-100 dark:bg-zinc-900 px-3 py-2.5 text-sm">
            <span className="text-zinc-500 dark:text-zinc-400">Counts toward goal now: </span>
            <span className="font-semibold amount">{formatCurrency(totalContribution, currency)}</span>
            <p className="text-xs text-zinc-400 dark:text-[#666] mt-0.5">Updates automatically as balances and values change.</p>
          </div>
        ) : (
          <Input label="Amount already saved" type="number" step="0.01" prefix="$" value={form.current_amount} onChange={e => setForm(f => ({ ...f, current_amount: e.target.value }))} />
        )}

        <Input label="Target date (optional)" type="date" value={form.target_date} onChange={e => setForm(f => ({ ...f, target_date: e.target.value }))} />

        <button
          type="button"
          onClick={() => setForm(f => ({ ...f, include_in_briefing: !f.include_in_briefing }))}
          className="w-full flex items-center justify-between rounded-[8px] border border-zinc-200 dark:border-zinc-800 px-3 py-2.5 text-left"
        >
          <div className="min-w-0 pr-3">
            <span className="text-sm font-medium">Include in daily message</span>
            <p className="text-xs text-zinc-400 dark:text-[#666]">Show this goal's progress in your daily briefing.</p>
          </div>
          <span className={`flex-shrink-0 w-10 h-6 rounded-full transition-colors relative ${form.include_in_briefing ? 'bg-brand' : 'bg-zinc-300 dark:bg-zinc-700'}`}>
            <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${form.include_in_briefing ? 'translate-x-4' : ''}`} />
          </span>
        </button>

        <div className="flex gap-3 pt-2">
          <Button variant="secondary" type="button" onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" fullWidth>{editing ? 'Save goal' : 'Add goal'}</Button>
        </div>
      </form>
    </Modal>
  );
}
