import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useStore } from '../../store';
import { goalsDS, goalContributionsDS, goalReportDS } from '../../services/dataService';
import { formatCurrency, formatRelativeDate } from '../../utils/format';
import { toGoalView, type GoalLineView, type GoalMessage, type GoalTone } from '../../utils/goalView';
import { goalLinks, type GoalSourceType } from '../../utils/savingsGoals';
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

/** The one line of text under a goal, formatted with the user's currency. */
function describeMessage(m: GoalMessage, currency: string): string {
  const money = (n: number) => formatCurrency(n, currency, true);
  switch (m.kind) {
    case 'complete': return m.over > 0 ? `Reached — ${money(m.over)} over target` : 'Target reached';
    case 'overdue': return `${money(m.short)} short, ${m.daysPast} day${m.daysPast === 1 ? '' : 's'} past the date`;
    case 'open': return `${money(m.remaining)} to go`;
    case 'on-track': return `On track — ${money(m.perMonth)}/mo gets you there`;
    case 'short': return `Needs ${money(m.required)}/mo — only ${money(m.allocated)} is spare`;
    case 'unfunded': return `Needs ${money(m.required)}/mo — nothing spare right now`;
    case 'unknown': return `Needs ${money(m.required)}/mo to finish on time`;
  }
}

export default function GoalSection({ currency }: { currency: string }) {
  const { view, refresh } = useGoalReport();
  const [searchParams, setSearchParams] = useSearchParams();

  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<Goal | null>(null);
  const [contributeTo, setContributeTo] = useState<GoalLineView | null>(null);
  const [toDelete, setToDelete] = useState<GoalLineView | null>(null);

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
              {formatCurrency(summary.totalSaved, currency, true)} of {formatCurrency(summary.totalTarget, currency, true)} saved
              {summary.completeCount > 0 && ` · ${summary.completeCount} reached`}
            </p>
          </div>
          <button onClick={openAdd} className="text-xs text-brand hover:underline flex-shrink-0">
            + Add goal
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
              <>Your goals need <b>{formatCurrency(summary.totalRequiredPerMonth, currency, true)}/mo</b> but your
              forecast only frees up <b>{formatCurrency(summary.monthlyCapacity, currency, true)}</b> — a
              gap of {formatCurrency(summary.shortfallPerMonth, currency, true)} a month.</>
            ) : (
              <>Your forecast frees up <b>{formatCurrency(summary.monthlyCapacity, currency, true)}/mo</b> and
              your goals claim {formatCurrency(summary.totalRequiredPerMonth, currency, true)} — {formatCurrency(summary.unallocatedPerMonth, currency, true)} to
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
              onContribute={() => setContributeTo(line)}
              onEdit={() => openEdit(line.id)}
              onDelete={() => setToDelete(line)}
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
          onClose={() => setContributeTo(null)}
          onSaved={refresh}
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

function GoalRow({ line, currency, onContribute, onEdit, onDelete }: {
  line: GoalLineView;
  currency: string;
  onContribute: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const linked = line.linkedSaved > 0 || line.brokenLinks.length > 0;

  return (
    <div className="rounded-[10px] border border-zinc-200 dark:border-zinc-800 p-3">
      <div className="flex items-start justify-between gap-3 mb-1.5">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium truncate">{line.name}</span>
            <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium flex-shrink-0 ${TONE_PILL[line.tone]}`}>
              {line.statusLabel}
            </span>
          </div>
          <span className="text-xs text-zinc-500 dark:text-zinc-400">
            {formatCurrency(line.saved, currency, true)} of {formatCurrency(line.targetAmount, currency, true)}
            {' · '}{Math.round(line.progressPct)}%
          </span>
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0 pt-0.5">
          <IconButton title="Log contribution" onClick={onContribute}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          </IconButton>
          <IconButton title="Edit" onClick={onEdit}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </IconButton>
          <IconButton title="Delete" danger onClick={onDelete}>
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

      <div className="flex items-center justify-between mt-1.5 gap-2">
        <span className="text-xs text-zinc-500 dark:text-zinc-400 truncate">{describeMessage(line.message, currency)}</span>
        {line.targetDate && (
          <span className="text-xs text-zinc-400 dark:text-[#666] flex-shrink-0">{formatRelativeDate(line.targetDate)}</span>
        )}
      </div>

      {/* Required contributions — only while there's still a pace to keep. */}
      {line.requiredPerWeek !== null && line.requiredPerMonth !== null && (
        <div className="flex gap-4 mt-2 text-[11px] text-zinc-500 dark:text-zinc-400">
          <span>{formatCurrency(line.requiredPerWeek, currency, true)}<span className="text-zinc-400 dark:text-[#666]">/wk</span></span>
          <span>{formatCurrency(line.requiredPerMonth, currency, true)}<span className="text-zinc-400 dark:text-[#666]">/mo</span> to finish on time</span>
        </div>
      )}

      {linked && (
        <p className="text-[11px] text-brand mt-1.5">
          🔗 {formatCurrency(line.linkedSaved, currency, true)} from linked accounts
          {line.reflectedTotal !== 0 && (
            <span className="text-zinc-400 dark:text-[#666]">
              {' · '}{formatCurrency(Math.abs(line.reflectedTotal), currency, true)} of logged movements already counted in those balances
            </span>
          )}
          {line.brokenLinks.length > 0 && (
            <span className="text-[#d97706] dark:text-[#f59e0b]">
              {' · '}{line.brokenLinks.length} link{line.brokenLinks.length === 1 ? '' : 's'} to a deleted asset — edit to fix
            </span>
          )}
        </p>
      )}
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

  const goal = useMemo(() => goalsDS.getAll().find(g => g.id === line.id), [line.id]);
  const links = goal ? goalLinks(goal) : [];

  const today = new Date().toISOString().slice(0, 10);
  const [direction, setDirection] = useState<'in' | 'out'>('in');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(today);
  const [sourceKey, setSourceKey] = useState('');   // '' = untracked cash

  const nameFor = (type: GoalSourceType, id: string): string => {
    if (type === 'investment') return investments.find(i => i.id === id)?.name ?? 'Investment';
    if (type === 'super') return (superFunds.find(f => f.id === id) as any)?.fund_name ?? 'Super';
    return accounts.find(a => a.id === id)?.name ?? 'Account';
  };

  // A source can be a linked asset (whose balance already reflects the move) or
  // untracked cash. Offer the goal's own links plus "cash I moved myself".
  const sourceOptions = [
    { value: '', label: '💵 Cash / elsewhere (not a linked account)' },
    ...links.map(l => ({ value: `${l.type}:${l.id}`, label: `🔗 ${nameFor(l.type, l.id)}` })),
  ];

  const parsed = parseFloat(amount) || 0;
  const linkedSource = sourceKey !== '';

  const save = () => {
    if (parsed <= 0) return;
    const [type, id] = sourceKey ? (sourceKey.split(':') as [GoalSourceType, string]) : [null, null];
    goalContributionsDS.add({
      goal_id: line.id,
      amount: direction === 'in' ? parsed : -parsed,
      date,
      source_type: type,
      source_id: id,
      note: null,
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
          label="Where did the money move?"
          options={sourceOptions}
          value={sourceKey}
          onChange={e => setSourceKey(e.target.value)}
        />

        {linkedSource ? (
          <p className="text-xs text-zinc-400 dark:text-[#666] -mt-1">
            This account's balance already moves on its own, so this is recorded for your history
            and not counted twice.
          </p>
        ) : (
          <p className="text-xs text-zinc-400 dark:text-[#666] -mt-1">
            Cash Ledger can't see — this {direction === 'in' ? 'adds to' : 'comes off'} the goal directly.
          </p>
        )}

        <Input label="Date" type="date" value={date} onChange={e => setDate(e.target.value)} />

        {parsed > 0 && (
          <div className="rounded-[8px] bg-zinc-100 dark:bg-zinc-900 px-3 py-2.5 text-sm">
            <span className="text-zinc-500 dark:text-zinc-400">
              {linkedSource ? 'Recorded (already in the linked balance): ' : direction === 'in' ? 'Added to goal: ' : 'Taken off goal: '}
            </span>
            <span className="font-semibold amount">{formatCurrency(direction === 'in' ? parsed : -parsed, currency)}</span>
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
        .map(a => ({ value: `account:${a.id}`, label: `🏦 ${a.name} (${formatCurrency((a as any).display_balance ?? a.balance, currency, true)})` })),
      ...investments
        .filter(i => !taken.has(`investment:${i.id}`))
        .map(i => ({ value: `investment:${i.id}`, label: `📈 ${i.name} (${formatCurrency((i as any).display_value ?? (i as any).current_value ?? 0, currency, true)})` })),
      ...superFunds
        .filter(f => !taken.has(`super:${f.id}`))
        .map(f => ({ value: `super:${f.id}`, label: `🏛️ ${(f as any).fund_name} (${formatCurrency((f as any).balance ?? 0, currency, true)})` })),
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
                  <p className="text-xs text-zinc-400 dark:text-[#666]">Contributes {formatCurrency(contributionOf(src), currency, true)} now</p>
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
